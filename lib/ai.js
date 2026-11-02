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
  freeTasks: num('AI_FREE_TASKS', 10),
  freeDays: num('AI_FREE_DAYS', 7),
  monthlyCapUsd: num('AI_MONTHLY_CAP_USD', 38), // about £30
  fastModel: process.env.AI_FAST_MODEL || 'gpt-5.4-mini',
  capableModel: process.env.AI_CAPABLE_MODEL || 'gpt-5.5',
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
];

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await execute(...SCHEMA.map((sql) => [sql, []]));
  schemaEnsured = true;
}

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

async function monthSpend(now = Date.now()) {
  const rows = await query('SELECT usd FROM ai_spend WHERE month = ?', [T(month(now))]);
  return rows.length ? Number(rows[0].usd) : 0;
}

/** What the app shows: tasks left, when the free week ends, and whether the tier is paused. */
function status(row, spend, now = Date.now()) {
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
    paused: spend >= CONFIG.monthlyCapUsd,
  };
}

module.exports = {
  CONFIG, PRICES, costUsd, resolveModel, signInstall, verifyInstall, bearer, ipHash,
  ensureSchema, monthSpend, status, month, day, execute, query, T, I,
};
