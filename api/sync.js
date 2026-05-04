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

      // 명시적 복사 + 삭제 (rename 의존하지 않음 — 더 견고)
      const allData = await redis.hgetall(key);
      if (allData && Object.keys(allData).length > 0) {
        // 모든 필드를 새 키에 복사
        const fieldsToSet = {};
        for (const [field, value] of Object.entries(allData)) {
          // value가 이미 직렬화된 문자열이면 그대로, 객체면 직렬화
          fieldsToSet[field] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        // meta 갱신
        const m = parseJson(allData.meta) || {};
        m.rotatedAt = new Date().toISOString();
        m.lastUsed  = new Date().toISOString();
        fieldsToSet.meta = JSON.stringify(m);

        await redis.hset(newKey, fieldsToSet);
        await redis.expire(newKey, TTL_SECONDS);
      }

      // 옛 키 명시적 삭제 — CRITICAL
      await redis.del(key);

      return res.status(200).json({ ok:true, code:newCode, oldCode: code.toUpperCase() });
    }

    // ── invalidate: 특정 코드를 영구 삭제 (다른 옛 코드 정리용) ─
    if (action === 'invalidate') {
      const exists = await redis.exists(key);
      if (!exists) return res.status(404).json({ ok:false, error:'code not found' });
      await redis.del(key);
      return res.status(200).json({ ok:true, deleted: code.toUpperCase() });
    }

    // ── setApiKey: 학원 코드에 API 키 저장 (PC에서만 사용) ─
    if (action === 'setApiKey') {
      const { apiKey } = body;
      if (typeof apiKey !== 'string') return res.status(400).json({ ok:false, error:'apiKey required' });
      // 빈 문자열이면 삭제
      const exists = await redis.exists(key);
      if (!exists) return res.status(404).json({ ok:false, error:'code not found' });
      if (!apiKey) {
        await redis.hdel(key, 'apiKey');
      } else {
        if (apiKey.length > 500) return res.status(413).json({ ok:false, error:'apiKey too long' });
        await redis.hset(key, { apiKey: apiKey });
      }
      await redis.expire(key, TTL_SECONDS);
      return res.status(200).json({ ok:true });
    }

    // ── getApiKey: 학원 코드의 API 키 조회 (조교 폰에서 사용) ─
    if (action === 'getApiKey') {
      const apiKey = await redis.hget(key, 'apiKey');
      if (apiKey == null) return res.status(404).json({ ok:false, error:'no api key set' });
      return res.status(200).json({ ok:true, apiKey: apiKey });
    }

    // ── addRecord: 채점 기록 추가 ──────────────────────────
    if (action === 'addRecord') {
      const { record } = body;
      if (!record || typeof record !== 'object') {
        return res.status(400).json({ ok:false, error:'record required' });
      }
      const exists = await redis.exists(key);
      if (!exists) return res.status(404).json({ ok:false, error:'code not found' });

      // 고유 ID 보장
      const recId = record.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const recordWithId = { ...record, id: recId };
      const field = `record:${recId}`;
      const payload = JSON.stringify(recordWithId);
      if (payload.length > 100_000) return res.status(413).json({ ok:false, error:'record too large' });

      await redis.hset(key, { [field]: payload });
      await redis.expire(key, TTL_SECONDS);
      return res.status(200).json({ ok:true, id: recId });
    }

    // ── listRecords: 채점 기록 목록 조회 ───────────────────
    if (action === 'listRecords') {
      const { since, limit } = body; // since: ISO date string (선택), limit: 개수 (선택, 기본 500)
      const all = await redis.hgetall(key);
      if (!all || Object.keys(all).length === 0) {
        return res.status(404).json({ ok:false, error:'code not found' });
      }
      const records = [];
      for (const [field, value] of Object.entries(all)) {
        if (!field.startsWith('record:')) continue;
        const r = parseJson(value);
        if (!r) continue;
        if (since) {
          // since 필터링 (record.savedAt 또는 record.id를 기준으로)
          const rTime = r.savedAt || (r.id && /^\d+/.test(r.id) ? parseInt(r.id) : 0);
          if (rTime && new Date(rTime) < new Date(since)) continue;
        }
        records.push(r);
      }
      // 최신순 정렬
      records.sort((a, b) => {
        const aT = a.savedAt || a.id || 0;
        const bT = b.savedAt || b.id || 0;
        return new Date(bT) - new Date(aT);
      });
      const max = Math.min(limit || 500, 1000);
      return res.status(200).json({ ok:true, records: records.slice(0, max), total: records.length });
    }

    // ── deleteRecord: 개별 채점 기록 삭제 ──────────────────
    if (action === 'deleteRecord') {
      const { recordId } = body;
      if (!recordId) return res.status(400).json({ ok:false, error:'recordId required' });
      const field = `record:${recordId}`;
      await redis.hdel(key, field);
      return res.status(200).json({ ok:true });
    }

    // ── clearRecords: 모든 채점 기록 삭제 (원장 전용) ──────
    if (action === 'clearRecords') {
      const all = await redis.hgetall(key);
      if (!all) return res.status(404).json({ ok:false, error:'code not found' });
      const recordFields = Object.keys(all).filter(f => f.startsWith('record:'));
      if (recordFields.length > 0) {
        await redis.hdel(key, ...recordFields);
      }
      return res.status(200).json({ ok:true, deleted: recordFields.length });
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
      let hasApiKey = false;
      for (const [field, value] of Object.entries(all)) {
        if (field === 'apiKey') {
          // ⚠️ 보안: apiKey 값은 응답에 포함하지 않음. 존재 여부만 알림.
          hasApiKey = !!value;
          continue;
        }
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
      return res.status(200).json({ ok:true, vocab, akeys, meta, hasApiKey });
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
