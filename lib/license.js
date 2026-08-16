// Signed license tokens: base64url(json payload) + "." + HMAC-SHA256 signature.
// No database needed — the payload just carries the Stripe customer id, and
// entitlement is always re-checked live against Stripe (see api/entitlement.js).
const crypto = require('crypto');

function secret() {
  const s = process.env.LICENSE_SECRET;
  if (!s) throw new Error('LICENSE_SECRET env var is not set');
  return s;
}

function sign(customerId) {
  const payload = Buffer.from(JSON.stringify({ c: customerId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.c || null;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
