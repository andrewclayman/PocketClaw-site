// Shared pieces of the free built-in AI ("Xanadu free"): install tokens, the Turso tables that
// count each install's free tasks and the month's spend, and what each model costs.
//
// What is stored per install: a random id, when it was created, a salted hash of the IP it
// registered from (to stop one person minting endless free installs), task/call counts and
// the dollar cost of its calls. Never anything the user said — requests stream through
// to OpenAI and are not kept.
const crypto = require('crypto');
const { execute, query, T, I } = require('./turso');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const CONFIG = {
  freeTasks: num('AI_FREE_TASKS', 20),
  freeDays: num('AI_FREE_DAYS', 14),
  // Tasks started from the app's starter cards (one per card) don't touch the allowance.
  starterTasks: num('AI_STARTER_TASKS', 7),
  monthlyCapUsd: num('AI_MONTHLY_CAP_USD', 38), // about £30, free use only: Plus doesn't count
  // Tasks a month with Xanadu Plus (lib/plus.js), in place of the free allowance.
  plusTasksPerMonth: num('PLUS_TASKS_PER_MONTH', 100),
  fastModel: process.env.AI_FAST_MODEL || 'gpt-5.4-mini',
  capableModel: process.env.AI_CAPABLE_MODEL || 'gpt-5.5',
  // Once a task has cost this much, the rest of it runs on the fast model. A picky search
  // (check a dozen restaurant sites, menus and photos) ran to $1-1.50 on the capable model.
  taskCapableUsd: num('AI_TASK_CAPABLE_USD', 0.25),
  // Runs /api/search, the fallback when the app's own web search is turned away.
  searchModel: process.env.AI_SEARCH_MODEL || 'gpt-5.4-mini',
  // A task is one user message plus the tool calls it sets off; these bound the tail of it.
  maxCallsPerTask: num('AI_MAX_CALLS_PER_TASK', 40),
  taskIdleMs: num('AI_TASK_IDLE_MIN', 15) * 60_000,
  maxCallsPerDay: num('AI_MAX_CALLS_PER_DAY', 200),
  registrationsPerIpPerDay: num('AI_REGISTRATIONS_PER_IP_DAY', 5),
  maxOutputTokens: num('AI_MAX_OUTPUT_TOKENS', 4096),
};

// USD per million tokens: [input, cached input, output]. Unknown models are priced as the
// most expensive one so the monthly cap errs on the safe side.
const PRICES = {
  'gpt-5.5': [5.0, 0.5, 20.0],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-4o-mini': [0.15, 0.075, 0.6],
};

function costUsd(model, usage) {
  const [pin, pcached, pout] = PRICES[model] || PRICES['gpt-5.5'];
  const prompt = usage.prompt_tokens || 0;
  const cached = Math.min(prompt, usage.prompt_tokens_details?.cached_tokens || 0);
  const out = usage.completion_tokens || 0;
  return ((prompt - cached) * pin + cached * pcached + out * pout) / 1e6;
}

/** The app asks for a tier, never a concrete model, so models can change without a release. */
function resolveModel(requested) {
  return requested === 'xanadu-capable' ? CONFIG.capableModel : CONFIG.fastModel;
}

// ---- Install tokens --------------------------------------------------------------------
// Same shape as license tokens (lib/license.js) but signed with a key derived for this purpose
// only, so an install token can never pass as a paid licence or the other way round.
function tokenKey() {
  const s = process.env.LICENSE_SECRET;
  if (!s) throw new Error('LICENSE_SECRET env var is not set');
  return crypto.createHash('sha256').update('xanadu-free-ai:' + s).digest();
}

function signInstall(id) {
  const payload = Buffer.from(JSON.stringify({ i: id, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyInstall(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).i || null;
  } catch {
    return null;
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function ipHash(req) {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return crypto.createHash('sha256').update('ip:' + ip + ':' + (process.env.LICENSE_SECRET || '')).digest('hex').slice(0, 24);
}

// ---- Storage ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ai_installs (
    id            TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    ip_hash       TEXT NOT NULL DEFAULT '',
    app_version   TEXT NOT NULL DEFAULT '',
    tasks_used    INTEGER NOT NULL DEFAULT 0,
    first_task_at INTEGER,
    last_call_at  INTEGER,
    task_calls    INTEGER NOT NULL DEFAULT 0,
    day           TEXT NOT NULL DEFAULT '',
    day_calls     INTEGER NOT NULL DEFAULT 0,
    spend_usd     REAL NOT NULL DEFAULT 0,
    blocked       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS ai_installs_ip ON ai_installs(ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS ai_spend (
    month TEXT PRIMARY KEY,
    usd   REAL NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    tasks INTEGER NOT NULL DEFAULT 0
  )`,
  // Daily totals and which installs were active on which day, for /api/ai-stats.
  `CREATE TABLE IF NOT EXISTS ai_daily (
    day   TEXT PRIMARY KEY,
    usd   REAL NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    tasks INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ai_active (
    day TEXT NOT NULL,
    id  TEXT NOT NULL,
    PRIMARY KEY (day, id)
  )`,
  // Days an install reached the chat screen (the app calls /api/ai-start there), used or not:
  // tells "opened and left" from "never came back".
  `CREATE TABLE IF NOT EXISTS ai_opens (
    day TEXT NOT NULL,
    id  TEXT NOT NULL,
    PRIMARY KEY (day, id)
  )`,
  // Starter cards sent, as daily totals per card. Deliberately not tied to an install.
  `CREATE TABLE IF NOT EXISTS ai_cards (
    day  TEXT NOT NULL,
    card TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, card)
  )`,
  // Xanadu Plus subscriptions (lib/plus.js): which install each is on and when its paid time ends.
  `CREATE TABLE IF NOT EXISTS plus_subs (
    purchase_token TEXT PRIMARY KEY,
    install_id     TEXT NOT NULL,
    product_id     TEXT NOT NULL,
    state          TEXT NOT NULL,
    until          INTEGER NOT NULL,
    order_id       TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    checked_at     INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS plus_subs_install ON plus_subs(install_id)`,
];

// Columns added after the table first shipped; ALTER fails harmlessly once they exist.
const MIGRATIONS = [
  'ALTER TABLE ai_installs ADD COLUMN starter_used INTEGER NOT NULL DEFAULT 0',
  // What the current task has cost so far (reset when a task starts), for CONFIG.taskCapableUsd.
  'ALTER TABLE ai_installs ADD COLUMN task_usd REAL NOT NULL DEFAULT 0',
  // Xanadu Plus: when its paid time ends (ms, 0 = never had it), and its tasks this month.
  'ALTER TABLE ai_installs ADD COLUMN plus_until INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE ai_installs ADD COLUMN plus_month TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE ai_installs ADD COLUMN plus_tasks INTEGER NOT NULL DEFAULT 0',
  // The part of the month's spend that was Plus, which the free tier's cap leaves out.
  'ALTER TABLE ai_spend ADD COLUMN plus_usd REAL NOT NULL DEFAULT 0',
];

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await execute(...SCHEMA.map((sql) => [sql, []]));
  for (const sql of MIGRATIONS) {
    try { await execute([sql, []]); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  schemaEnsured = true;
}

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** What free use has cost this month, for CONFIG.monthlyCapUsd. */
async function monthSpend(now = Date.now()) {
  const rows = await query('SELECT usd, plus_usd FROM ai_spend WHERE month = ?', [T(month(now))]);
  return rows.length ? Number(rows[0].usd) - Number(rows[0].plus_usd || 0) : 0;
}

/** Plus tasks [row] has used this month. */
const plusTasksUsed = (row, now = Date.now()) => (row.plus_month === month(now) ? Number(row.plus_tasks || 0) : 0);

/**
 * What the app shows: tasks left, when the free period ends, and whether the free tier is
 * paused. With Plus ([plus], from lib/plus.js current()), the month's Plus tasks instead.
 */
function status(row, spend, now = Date.now(), plus = false) {
  const startersLeft = Math.max(0, CONFIG.starterTasks - Number(row.starter_used || 0));
  if (plus) {
    const used = plusTasksUsed(row, now);
    return {
      tasksLimit: CONFIG.plusTasksPerMonth,
      tasksUsed: used,
      tasksLeft: Math.max(0, CONFIG.plusTasksPerMonth - used),
      trialEndsAt: null,
      expired: false,
      startersLeft,
      paused: false,
      plus: true,
      plusUntil: Number(row.plus_until),
    };
  }
  const used = Number(row.tasks_used || 0);
  const first = row.first_task_at == null ? null : Number(row.first_task_at);
  const endsAt = first == null ? null : first + CONFIG.freeDays * 86_400_000;
  const expired = endsAt != null && now > endsAt;
  return {
    tasksLimit: CONFIG.freeTasks,
    tasksUsed: used,
    tasksLeft: expired ? 0 : Math.max(0, CONFIG.freeTasks - used),
    trialEndsAt: endsAt,
    expired,
    startersLeft,
    paused: spend >= CONFIG.monthlyCapUsd,
    plus: false,
    plusUntil: null,
  };
}

module.exports = {
  CONFIG, PRICES, costUsd, resolveModel, signInstall, verifyInstall, bearer, ipHash,
  ensureSchema, monthSpend, plusTasksUsed, status, month, day, execute, query, T, I,
};
