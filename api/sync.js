// /api/sync.js
// 김기준영어학원 채점 시스템 — 클라우드 동기화 엔드포인트
// Upstash Redis 사용. Vercel Marketplace에서 설치 후 환경 변수 자동 주입됨.

import { Redis } from '@upstash/redis';

// Vercel KV(이전 이름) / Upstash 양쪽 환경 변수 모두 지원
const redis = new Redis({
  url:   process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL_SECONDS = 365 * 24 * 60 * 60; // 1년 (재사용시 자동 연장)

export default async function handler(req, res) {
  // CORS — 같은 도메인이면 사실 불필요하지만 안전하게
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok:false, error:'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { action, code, kind, name, data } = body;

    // ── createCode: 새 학원 코드 발급 ────────────────────
    if (action === 'createCode') {
      // 충돌 방지를 위해 최대 5회 시도
      for (let i = 0; i < 5; i++) {
        const newCode = generateCode();
        const key = `academy:${newCode}`;
        const exists = await redis.exists(key);
        if (!exists) {
          await redis.hset(key, {
            meta: JSON.stringify({
              createdAt: new Date().toISOString(),
              lastUsed:  new Date().toISOString(),
            })
          });
          await redis.expire(key, TTL_SECONDS);
          return res.status(200).json({ ok:true, code:newCode });
        }
      }
      return res.status(500).json({ ok:false, error:'failed to generate code' });
    }

    // ── 코드 검증 ────────────────────────────────────────
    if (!code || typeof code !== 'string' || !/^KKJ-[A-Z0-9]{6,8}$/i.test(code)) {
      return res.status(400).json({ ok:false, error:'invalid code format' });
    }
    const key = `academy:${code.toUpperCase()}`;

    // ── rotateCode: 보안 재발급 (옛 코드 무효, 데이터 보존) ─
    if (action === 'rotateCode') {
      const exists = await redis.exists(key);
      if (!exists) return res.status(404).json({ ok:false, error:'code not found' });

      // 새 코드 생성 (충돌 방지)
      let newCode = null;
      for (let i = 0; i < 5; i++) {
        const candidate = generateCode();
        const candidateKey = `academy:${candidate}`;
        const cExists = await redis.exists(candidateKey);
        if (!cExists) { newCode = candidate; break; }
      }
      if (!newCode) return res.status(500).json({ ok:false, error:'failed to generate code' });

      const newKey = `academy:${newCode}`;
      // 원자적 키 이름 변경 — 모든 데이터 보존됨
      await redis.rename(key, newKey);

      // meta에 재발급 시각 기록 + TTL 갱신
      const meta = await redis.hget(newKey, 'meta');
      const m = parseJson(meta) || {};
      m.rotatedAt = new Date().toISOString();
      m.lastUsed  = new Date().toISOString();
      await redis.hset(newKey, { meta: JSON.stringify(m) });
      await redis.expire(newKey, TTL_SECONDS);

      return res.status(200).json({ ok:true, code:newCode, oldCode: code.toUpperCase() });
    }

    // ── ping: 코드 유효성만 확인 ─────────────────────────
    if (action === 'ping') {
      const meta = await redis.hget(key, 'meta');
      if (!meta) return res.status(404).json({ ok:false, error:'code not found' });
      // lastUsed 갱신 + TTL 연장
      const m = parseJson(meta);
      m.lastUsed = new Date().toISOString();
      await redis.hset(key, { meta: JSON.stringify(m) });
      await redis.expire(key, TTL_SECONDS);
      return res.status(200).json({ ok:true });
    }

    // ── put: 항목 저장 ───────────────────────────────────
    if (action === 'put') {
      if (!kind || !name || !data) return res.status(400).json({ ok:false, error:'missing fields' });
      if (!['vocab', 'akeys'].includes(kind)) return res.status(400).json({ ok:false, error:'invalid kind' });
      if (typeof name !== 'string' || name.length > 100) return res.status(400).json({ ok:false, error:'invalid name' });

      // meta 존재 확인 (코드가 발급된 적 없으면 거부)
      const meta = await redis.hget(key, 'meta');
      if (!meta) return res.status(404).json({ ok:false, error:'code not found' });

      const field = `${kind}:${name}`;
      const payload = JSON.stringify(data);
      if (payload.length > 500_000) return res.status(413).json({ ok:false, error:'data too large' });

      await redis.hset(key, { [field]: payload });
      // meta lastUsed 갱신
      const m = parseJson(meta);
      m.lastUsed = new Date().toISOString();
      await redis.hset(key, { meta: JSON.stringify(m) });
      await redis.expire(key, TTL_SECONDS);

      return res.status(200).json({ ok:true });
    }

    // ── delete: 항목 삭제 ────────────────────────────────
    if (action === 'delete') {
      if (!kind || !name) return res.status(400).json({ ok:false, error:'missing fields' });
      if (!['vocab', 'akeys'].includes(kind)) return res.status(400).json({ ok:false, error:'invalid kind' });
      const field = `${kind}:${name}`;
      await redis.hdel(key, field);
      return res.status(200).json({ ok:true });
    }

    // ── getAll: 학원 코드의 모든 항목 불러오기 ──────────
    if (action === 'getAll') {
      const all = await redis.hgetall(key);
      if (!all || Object.keys(all).length === 0) {
        return res.status(404).json({ ok:false, error:'code not found' });
      }
      const vocab = {};
      const akeys = {};
      let meta = null;
      for (const [field, value] of Object.entries(all)) {
        const v = parseJson(value);
        if (field === 'meta') {
          meta = v;
        } else if (field.startsWith('vocab:')) {
          vocab[field.slice(6)] = v;
        } else if (field.startsWith('akeys:')) {
          akeys[field.slice(6)] = v;
        }
      }
      // lastUsed 갱신 + TTL 연장
      if (meta) {
        meta.lastUsed = new Date().toISOString();
        await redis.hset(key, { meta: JSON.stringify(meta) });
        await redis.expire(key, TTL_SECONDS);
      }
      return res.status(200).json({ ok:true, vocab, akeys, meta });
    }

    return res.status(400).json({ ok:false, error:'unknown action' });

  } catch (err) {
    console.error('[sync] error:', err);
    return res.status(500).json({ ok:false, error: err?.message || 'server error' });
  }
}

// ── 헬퍼: 보기 좋은 학원 코드 생성 (혼동 문자 제외) ─
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O/1/I 제외
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `KKJ-${suffix}`;
}

// ── 헬퍼: Upstash 응답이 string/object 둘 다 올 수 있어 안전 처리 ─
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}
