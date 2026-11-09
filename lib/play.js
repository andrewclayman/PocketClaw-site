// Google Play Developer API: what Google says about a purchase made in the Play app. Used for
// call packs (lib/calls.js) and Xanadu Plus (lib/plus.js). Needs GOOGLE_PLAY_SERVICE_ACCOUNT, the
// JSON key of a service account Play Console has given access to the app's financial data.
const crypto = require('crypto');

const PACKAGE = 'com.pocketclaw';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;

let accessToken = null; // { value, expires }

/** OAuth access token for the Play Developer API, from the service account in the env. */
async function playAccessToken() {
  if (accessToken && accessToken.expires > Date.now() + 60_000) return accessToken.value;
  const sa = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Google token: ${data.error_description || data.error || resp.status}`);
  accessToken = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return accessToken.value;
}

async function get(path) {
  const resp = await fetch(API + path, { headers: { Authorization: `Bearer ${await playAccessToken()}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(`Play: ${data.error?.message || resp.status}`), { status: resp.status });
  return data;
}

/** Google's record of a one-time purchase (purchases.products.get). */
const playPurchase = (productId, purchaseToken) =>
  get(`/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`);

/** Google's record of a subscription (purchases.subscriptionsv2.get). */
const playSubscription = (purchaseToken) =>
  get(`/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);

module.exports = { PACKAGE, playPurchase, playSubscription };
