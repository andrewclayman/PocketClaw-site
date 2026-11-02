// POST /api/ai-start — the app's handshake for the free built-in AI.
// Body: { token?, appVersion? }. With a valid install token it just reports that install's
// free allowance; without one it registers a new install and returns its token. New installs
// are capped per IP per day so one person can't reset the allowance by clearing app data.
const crypto = require('crypto');
const ai = require('../lib/ai');
const { T, I } = ai;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST only' } });
  try {
    await ai.ensureSchema();
    const now = Date.now();
    const body = req.body || {};
    const appVersion = String(body.appVersion || '').slice(0, 32);
    const spend = await ai.monthSpend(now);

    const existing = ai.verifyInstall(body.token);
    if (existing) {
      const rows = await ai.query('SELECT * FROM ai_installs WHERE id = ?', [T(existing)]);
      if (rows.length) return res.status(200).json({ token: body.token, ...ai.status(rows[0], spend, now) });
      // A valid token whose row is gone (wiped table): fall through and issue a fresh one.
    }

    const ipHash = ai.ipHash(req);
    const recent = await ai.query(
      'SELECT COUNT(*) AS n FROM ai_installs WHERE ip_hash = ? AND created_at > ?',
      [T(ipHash), I(now - 86_400_000)]
    );
    if (Number(recent[0]?.n || 0) >= ai.CONFIG.registrationsPerIpPerDay) {
      return res.status(429).json({ error: { code: 'too_many_installs', message: 'Too many new installs from this network today. Try again tomorrow.' } });
    }

    const id = crypto.randomUUID();
    await ai.execute([
      'INSERT INTO ai_installs (id, created_at, ip_hash, app_version) VALUES (?, ?, ?, ?)',
      [T(id), I(now), T(ipHash), T(appVersion)],
    ]);
    const row = { tasks_used: 0, first_task_at: null };
    return res.status(200).json({ token: ai.signInstall(id), ...ai.status(row, spend, now) });
  } catch (e) {
    console.error('ai-start failed', e);
    return res.status(500).json({ error: { code: 'server_error', message: 'Could not start the free AI. Try again in a minute.' } });
  }
};
