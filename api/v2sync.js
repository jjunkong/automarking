// /api/v2sync.js
// KKJ 채점 v2 전용 동기화 엔드포인트
// 기존 /api/sync.js 는 건드리지 않습니다 (별도 키 네임스페이스 kkjv2:)

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';

const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';

// Upstash REST: POST 본문에 ["GET","key"] 같은 명령 배열
async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`KV ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (_) { return { result: null }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'KV 환경변수가 없습니다. Vercel → Settings → Environment Variables 에서 KV_REST_API_URL / KV_REST_API_TOKEN 을 확인하세요.',
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'bad json' });
  }

  const { action, code, data } = body;

  if (!code || !/^[A-Za-z0-9_-]{3,40}$/.test(code)) {
    return res.status(400).json({ ok: false, error: '학원 코드가 올바르지 않습니다' });
  }

  const key = `kkjv2:${code}`;

  try {
    if (action === 'pull') {
      const r = await kv(['GET', key]);
      const raw = r && r.result;
      let parsed = null;
      if (raw) {
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      }
      return res.status(200).json({ ok: true, data: parsed });
    }

    if (action === 'push') {
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ ok: false, error: 'no data' });
      }
      const payload = JSON.stringify({ ...data, updatedAt: Date.now() });
      // Upstash 값 크기 안전선
      if (payload.length > 8 * 1024 * 1024) {
        return res.status(413).json({
          ok: false,
          error: `데이터가 너무 큽니다 (${Math.round(payload.length / 1024)}KB). 오래된 채점 기록을 정리해 주세요.`,
        });
      }
      await kv(['SET', key, payload]);
      return res.status(200).json({
        ok: true,
        updatedAt: Date.now(),
        bytes: payload.length,
      });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
