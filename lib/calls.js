// Xanadu Calls allowance: who may have the AI place a phone call, and how many. The calls
// server (calls-server/ in the app repo, on Fly) only dials with a ticket signed here, so every
// call is counted against someone, and it reports back how each call went and what it cost.
//
// Who: a Play install (its free-AI install token, lib/ai.js) gets CALLS_FREE calls, PLUS_CALLS_PER_MONTH
// a month while it has Xanadu Plus (lib/plus.js), and any it buys on Google Play; a website licence
// (lib/license.js) gets CALLS_LICENCE_PER_MONTH a month.
// What is stored: per account, counters and dollar costs; per call, its outcome and cost.
// Never the number called or anything said on the call.
const crypto = require('crypto');
const Stripe = require('stripe');
const ai = require('./ai');
const license = require('./license');
const play = require('./play');
const plus = require('./plus');
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
  plusCallsPerMonth: num('PLUS_CALLS_PER_MONTH', 10),
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
 * The account behind the bearer token: { subject, kind: 'install' | 'licence', plus }, or
 * { error: [status, code, message] }. A licence is checked live against Stripe, like
 * /api/entitlement, so a cancelled subscription stops calls at once.
 */
async function identify(req) {
  const who = subjectOf(ai.bearer(req));
  if (!who) return { error: [401, 'invalid_token', 'invalid_token: Not signed in for calls.'] };
  if (who.kind === 'install') {
    const row = (await query('SELECT id, plus_until FROM ai_installs WHERE id = ?', [T(who.subject.slice(2))]))[0];
    who.plus = row ? await plus.current(row) : false;
  }
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

/** The month's calls for [who] (a licence or Plus), or 0 if it has none. */
const monthlyCalls = (who) =>
  who.kind === 'licence' ? CONFIG.licenceCallsPerMonth : who.plus ? CONFIG.plusCallsPerMonth : 0;

/** What the app shows: calls left and where they come from. [who] is { kind, plus }. */
function status(row, who, now = Date.now()) {
  const { kind } = who;
  const freeLeft = kind === 'install' ? Math.max(0, CONFIG.freeCalls - Number(row.free_used || 0)) : 0;
  const monthUsed = row.month === ai.month(now) ? Number(row.month_used || 0) : 0;
  const monthLeft = Math.max(0, monthlyCalls(who) - monthUsed);
  const licenceLeft = kind === 'licence' ? monthLeft : 0;
  const plusLeft = kind === 'install' ? monthLeft : 0;
  const credits = Number(row.credits || 0);
  return {
    callsLeft: freeLeft + monthLeft + credits,
    freeLeft, licenceLeft, plusLeft, credits, plus: !!who.plus,
    canBuy: kind === 'install',
    products: kind === 'install' ? Object.entries(PRODUCTS).map(([id, calls]) => ({ id, calls })) : [],
    // What Plus gives, for the app to describe it before anyone subscribes.
    ...(kind === 'install' ? { plusTasksPerMonth: ai.CONFIG.plusTasksPerMonth, plusCallsPerMonth: CONFIG.plusCallsPerMonth } : {}),
    account: accountRef(row.subject),
  };
}

module.exports = {
  CONFIG, PRODUCTS, signTicket, verifyReport, reportString, accountRef, identify, subjectOf, ensureSchema,
  account, status, monthlyCalls, playPurchase: play.playPurchase,
};
