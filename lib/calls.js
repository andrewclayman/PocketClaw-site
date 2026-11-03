// Xanadu Calls allowance: who may have the AI place a phone call, and how many. The calls
// server (calls-server/ in the app repo, on Fly) only dials with a ticket signed here, so every
// call is counted against someone, and it reports back how each call went and what it cost.
//
// Who: a Play install (its free-AI install token, lib/ai.js) gets CALLS_FREE calls plus any it
// buys on Google Play; a website licence (lib/license.js) gets CALLS_LICENCE_PER_MONTH a month.
// What is stored: per account, counters and dollar costs; per call, its outcome and cost.
// Never the number called or anything said on the call.
const crypto = require('crypto');
const Stripe = require('stripe');
const ai = require('./ai');
const license = require('./license');
const { execute, query, T, I } = ai;

// Like lib/ai.js's num(), but 0 is a real setting here (CALLS_FREE=0 turns free calls off).
const num = (name, dflt) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? v : dflt;
};

const CONFIG = {
  freeCalls: num('CALLS_FREE', 1),
  licenceCallsPerMonth: num('CALLS_LICENCE_PER_MONTH', 30),
  // Attempts per account per day, paid or not: a runaway agent loop or a harasser stops here.
  perDay: num('CALLS_PER_DAY', 10),
  // Free calls from one network per day, so clearing app data for new installs doesn't farm them.
  freePerIpPerDay: num('CALLS_FREE_PER_IP_DAY', 3),
  // What free calls may cost in a month across everyone; bought calls aren't limited by it.
  freeMonthlyCapUsd: num('CALLS_FREE_MONTHLY_CAP_USD', 20),
  maxSeconds: num('CALLS_MAX_SECONDS', 300),
  ticketTtlMs: 120_000,
};

/** Play product id -> calls it adds. Prices live in Play Console, not here. */
const PRODUCTS = Object.fromEntries(
  (process.env.CALLS_PRODUCTS || 'calls_5:5,calls_20:20').split(',').map((p) => p.trim().split(':'))
    .filter(([id, n]) => id && Number(n) > 0).map(([id, n]) => [id, Number(n)])
);

const PACKAGE = 'com.pocketclaw';

// ---- Tickets and reports -----------------------------------------------------------------
// The calls server holds the same CALLS_TICKET_SECRET. Separate derived keys, so a ticket can
// never pass as a report or the other way round.
function key(purpose) {
  const s = process.env.CALLS_TICKET_SECRET;
  if (!s) throw new Error('CALLS_TICKET_SECRET env var is not set');
  return crypto.createHash('sha256').update(`xanadu-calls-${purpose}:${s}`).digest();
}

function signTicket(fields) {
  const payload = Buffer.from(JSON.stringify(fields)).toString('base64url');
  const sig = crypto.createHmac('sha256', key('ticket')).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** The fields a report signs, in a fixed order (the JSON body itself isn't byte-stable). */
function reportString(r) {
  return [r.nonce, r.charged ? 1 : 0, Math.round(Number(r.seconds) || 0), Number(r.usd || 0).toFixed(6), r.outcome || ''].join('|');
}

function verifyReport(r) {
  if (!r || typeof r.sig !== 'string' || typeof r.nonce !== 'string') return false;
  const expected = crypto.createHmac('sha256', key('report')).update(reportString(r)).digest('base64url');
  const a = Buffer.from(r.sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Opaque id for the account, given to Play as obfuscatedAccountId on a purchase so a
 *  purchase token can only ever be credited to the account that bought it. */
function accountRef(subject) {
  return crypto.createHash('sha256').update('xanadu-calls-account:' + subject).digest('hex').slice(0, 64);
}

// ---- Who is asking -----------------------------------------------------------------------
/**
 * The account behind the bearer token: { subject, kind: 'install' | 'licence' }, or
 * { error: [status, code, message] }. A licence is checked live against Stripe, like
 * /api/entitlement, so a cancelled subscription stops calls at once.
 */
async function identify(req) {
  const who = subjectOf(ai.bearer(req));
  if (!who) return { error: [401, 'invalid_token', 'invalid_token: Not signed in for calls.'] };
  if (who.kind === 'licence') {
    if (process.env.CALLS_ENABLED === 'false') return { error: [503, 'calls_off', 'calls_off: Calls are switched off for now.'] };
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const subs = await stripe.subscriptions.list({ customer: who.subject.slice(2), status: 'active', limit: 1 });
    if (!subs.data.length) return { error: [402, 'licence_inactive', 'licence_inactive: This licence is not active.'] };
  }
  return who;
}

/** The account a token names, without checking it's still paid for. */
function subjectOf(token) {
  const install = ai.verifyInstall(token);
  if (install) return { subject: 'i:' + install, kind: 'install' };
  const customer = license.verify(token);
  return customer ? { subject: 'c:' + customer, kind: 'licence' } : null;
}

// ---- Storage -----------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_accounts (
    subject    TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    free_used  INTEGER NOT NULL DEFAULT 0,
    credits    INTEGER NOT NULL DEFAULT 0,
    month      TEXT NOT NULL DEFAULT '',
    month_used INTEGER NOT NULL DEFAULT 0,
    day        TEXT NOT NULL DEFAULT '',
    day_used   INTEGER NOT NULL DEFAULT 0,
    calls      INTEGER NOT NULL DEFAULT 0,
    seconds    INTEGER NOT NULL DEFAULT 0,
    usd        REAL NOT NULL DEFAULT 0,
    blocked    INTEGER NOT NULL DEFAULT 0
  )`,
  // One row per ticket: which allowance it took from (to give back if the call never
  // happened) and, once the calls server reports, how it went.
  `CREATE TABLE IF NOT EXISTS call_tickets (
    nonce       TEXT PRIMARY KEY,
    subject     TEXT NOT NULL,
    source      TEXT NOT NULL,
    ip_hash     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    reported_at INTEGER,
    charged     INTEGER,
    outcome     TEXT,
    seconds     INTEGER,
    usd         REAL
  )`,
  `CREATE INDEX IF NOT EXISTS call_tickets_ip ON call_tickets(ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS call_purchases (
    purchase_token TEXT PRIMARY KEY,
    subject        TEXT NOT NULL,
    product_id     TEXT NOT NULL,
    calls          INTEGER NOT NULL,
    order_id       TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_spend (
    month    TEXT PRIMARY KEY,
    usd      REAL NOT NULL DEFAULT 0,
    free_usd REAL NOT NULL DEFAULT 0,
    calls    INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
];

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await execute(...SCHEMA.map((sql) => [sql, []]));
  schemaEnsured = true;
}

/** The account's row, created on first use. */
async function account(subject, now = Date.now()) {
  const [, rows] = await execute(
    ['INSERT OR IGNORE INTO call_accounts (subject, created_at) VALUES (?, ?)', [T(subject), I(now)]],
    ['SELECT * FROM call_accounts WHERE subject = ?', [T(subject)]]
  );
  return rows[0];
}

/** What the app shows: calls left and where they come from. */
function status(row, kind, now = Date.now()) {
  const freeLeft = kind === 'install' ? Math.max(0, CONFIG.freeCalls - Number(row.free_used || 0)) : 0;
  const monthUsed = row.month === ai.month(now) ? Number(row.month_used || 0) : 0;
  const licenceLeft = kind === 'licence' ? Math.max(0, CONFIG.licenceCallsPerMonth - monthUsed) : 0;
  const credits = Number(row.credits || 0);
  return {
    callsLeft: freeLeft + licenceLeft + credits,
    freeLeft, licenceLeft, credits,
    canBuy: kind === 'install',
    products: kind === 'install' ? Object.entries(PRODUCTS).map(([id, calls]) => ({ id, calls })) : [],
    account: accountRef(row.subject),
  };
}

// ---- Google Play purchase check ----------------------------------------------------------
let playToken = null; // { value, expires }

/** OAuth access token for the Play Developer API, from the service account in the env. */
async function playAccessToken() {
  if (playToken && playToken.expires > Date.now() + 60_000) return playToken.value;
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
  playToken = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return playToken.value;
}

/** Google's record of a one-time purchase (purchases.products.get). */
async function playPurchase(productId, purchaseToken) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}` +
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${await playAccessToken()}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(`Play: ${data.error?.message || resp.status}`), { status: resp.status });
  return data;
}

module.exports = {
  CONFIG, PRODUCTS, signTicket, verifyReport, reportString, accountRef, identify, subjectOf, ensureSchema,
  account, status, playPurchase,
};
