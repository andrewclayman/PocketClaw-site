// POST /api/calls?op=... — the Xanadu Calls allowance (see lib/calls.js).
//   status    app, Bearer token: calls left, and the packs on sale
//   ticket    app, Bearer token: takes one call and returns a one-use signed ticket for the calls server
//   report    calls server, signed: how a ticketed call went; gives the call back if it never happened
//   purchase  app (Play), Bearer install token + { productId, purchaseToken }: credits a pack, once
//   grant     admin, ?key=AI_ADMIN_KEY + { subject | token, calls }: adds (or removes) calls
// One function for all of them: the Vercel plan caps how many functions a deployment can have.
const crypto = require('crypto');
const ai = require('../lib/ai');
const calls = require('../lib/calls');
const { T, I } = ai;
const R = (v) => ['real', v];

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ error: { code, type: code, message }, ...extra });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'POST only');
  const op = req.query.op;
  try {
    await calls.ensureSchema();
    if (op === 'report') return await report(req, res);
    if (op === 'grant') return await grant(req, res);
    const who = await calls.identify(req);
    if (who.error) return fail(res, ...who.error);
    if (op === 'status') {
      const row = await calls.account(who.subject);
      return res.status(200).json(calls.status(row, who.kind));
    }
    if (op === 'ticket') return await ticket(req, res, who);
    if (op === 'purchase') return await purchase(req, res, who);
    return fail(res, 404, 'not_found', 'Unknown op');
  } catch (e) {
    console.error(`calls ${op} failed`, e);
    return fail(res, 500, 'server_error', 'Calls are unavailable right now. Try again in a minute.');
  }
};

async function ticket(req, res, who) {
  const now = Date.now();
  const today = ai.day(now), month = ai.month(now);
  const row = await calls.account(who.subject, now);
  if (Number(row.blocked)) return fail(res, 403, 'blocked', 'blocked: Calls are blocked for this account.');
  const dayUsed = row.day === today ? Number(row.day_used) : 0;
  if (dayUsed >= calls.CONFIG.perDay) {
    return fail(res, 429, 'daily_limit', 'daily_limit: That is the most calls for one day. Try again tomorrow.');
  }

  // Take one call from the first allowance that has one: free, then the licence's month, then bought.
  const ipHash = ai.ipHash(req);
  let source = null;
  if (who.kind === 'install' && Number(row.free_used) < calls.CONFIG.freeCalls) {
    const [spend, fromIp] = await ai.execute(
      ['SELECT free_usd FROM call_spend WHERE month = ?', [T(month)]],
      // Calls given back (never answered, refused) don't count against the network.
      [`SELECT COUNT(*) AS n FROM call_tickets
        WHERE ip_hash = ? AND source = 'free' AND created_at > ? AND (charged IS NULL OR charged = 1)`,
        [T(ipHash), I(now - 86_400_000)]]
    );
    const freeOk = Number(spend[0]?.free_usd || 0) < calls.CONFIG.freeMonthlyCapUsd
      && Number(fromIp[0]?.n || 0) < calls.CONFIG.freePerIpPerDay;
    if (freeOk) {
      const [took] = await ai.execute([
        'UPDATE call_accounts SET free_used = free_used + 1 WHERE subject = ? AND free_used < ? RETURNING free_used',
        [T(who.subject), I(calls.CONFIG.freeCalls)],
      ]);
      if (took.length) source = 'free';
    }
  }
  if (!source && who.kind === 'licence') {
    // A new month starts the count again.
    const [took] = await ai.execute([
      `UPDATE call_accounts SET month_used = CASE WHEN month = ? THEN month_used + 1 ELSE 1 END, month = ?
       WHERE subject = ? AND (month <> ? OR month_used < ?) RETURNING month_used`,
      [T(month), T(month), T(who.subject), T(month), I(calls.CONFIG.licenceCallsPerMonth)],
    ]);
    if (took.length) source = 'licence';
  }
  if (!source) {
    const [took] = await ai.execute([
      'UPDATE call_accounts SET credits = credits - 1 WHERE subject = ? AND credits > 0 RETURNING credits',
      [T(who.subject)],
    ]);
    if (took.length) source = 'credit';
  }
  if (!source) {
    const message = who.kind === 'install'
      ? 'no_calls: There are no calls left on this phone. More calls can be bought in the app.'
      : "no_calls: This month's calls are used up. They renew at the start of next month.";
    return fail(res, 402, 'no_calls', message, calls.status(row, who.kind, now));
  }

  const nonce = crypto.randomBytes(16).toString('base64url');
  const signed = calls.signTicket({
    s: who.subject, n: nonce, e: now + calls.CONFIG.ticketTtlMs, m: calls.CONFIG.maxSeconds,
    // Joke calls with a delayed reveal are for licensed (website) users only.
    x: who.kind === 'licence',
  });
  const [, , , fresh] = await ai.execute(
    ['INSERT INTO call_tickets (nonce, subject, source, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [T(nonce), T(who.subject), T(source), T(ipHash), I(now)]],
    ['UPDATE call_accounts SET day_used = CASE WHEN day = ? THEN day_used + 1 ELSE 1 END, day = ? WHERE subject = ?',
      [T(today), T(today), T(who.subject)]],
    ['INSERT INTO call_spend (month, attempts) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET attempts = attempts + 1',
      [T(month)]],
    ['SELECT * FROM call_accounts WHERE subject = ?', [T(who.subject)]]
  );
  return res.status(200).json({ ticket: signed, source, ...calls.status(fresh[0], who.kind, now) });
}

async function report(req, res) {
  const r = req.body || {};
  if (!calls.verifyReport(r)) return fail(res, 401, 'bad_signature', 'bad signature');
  const t = (await ai.query('SELECT * FROM call_tickets WHERE nonce = ?', [T(r.nonce)]))[0];
  if (!t) return fail(res, 404, 'unknown_ticket', 'unknown ticket');
  const usd = Math.max(0, Number(r.usd) || 0);
  const seconds = Math.max(0, Math.round(Number(r.seconds) || 0));
  const charged = r.charged ? 1 : 0;
  // Claimed once: a retried report must not count the call or give it back twice.
  const [claimed] = await ai.execute([
    `UPDATE call_tickets SET reported_at = ?, charged = ?, outcome = ?, seconds = ?, usd = ?
     WHERE nonce = ? AND reported_at IS NULL RETURNING nonce`,
    [I(Date.now()), I(charged), T(String(r.outcome || '').slice(0, 40)), I(seconds), R(usd), T(r.nonce)],
  ]);
  if (!claimed.length) return res.status(200).json({ ok: true, duplicate: true });

  const month = ai.month(Number(t.created_at));
  const statements = [
    [`INSERT INTO call_spend (month, usd, free_usd, calls) VALUES (?, ?, ?, ?)
      ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, free_usd = free_usd + excluded.free_usd,
        calls = calls + excluded.calls`,
      [T(month), R(usd), R(t.source === 'free' ? usd : 0), I(charged)]],
    ['UPDATE call_accounts SET usd = usd + ?, seconds = seconds + ?, calls = calls + ? WHERE subject = ?',
      [R(usd), I(seconds), I(charged), T(t.subject)]],
  ];
  if (!charged) {
    // Nobody answered, the line was busy, or the call was refused before dialling: give it back.
    statements.push({
      free: ['UPDATE call_accounts SET free_used = MAX(0, free_used - 1) WHERE subject = ?', [T(t.subject)]],
      credit: ['UPDATE call_accounts SET credits = credits + 1 WHERE subject = ?', [T(t.subject)]],
      licence: ['UPDATE call_accounts SET month_used = MAX(0, month_used - 1) WHERE subject = ? AND month = ?',
        [T(t.subject), T(month)]],
    }[t.source]);
  }
  await ai.execute(...statements.filter(Boolean));
  return res.status(200).json({ ok: true });
}

async function purchase(req, res, who) {
  if (who.kind !== 'install') return fail(res, 400, 'not_play', 'Purchases are for the Play version.');
  if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT) {
    return fail(res, 503, 'not_configured', 'not_configured: Purchases are not set up on the server yet.');
  }
  const { productId, purchaseToken } = req.body || {};
  const n = calls.PRODUCTS[productId];
  if (!n || typeof purchaseToken !== 'string' || !purchaseToken) {
    return fail(res, 400, 'bad_request', 'Unknown product or missing purchase token.');
  }
  const now = Date.now();
  const row = await calls.account(who.subject, now);
  const done = (await ai.query('SELECT subject FROM call_purchases WHERE purchase_token = ?', [T(purchaseToken)]))[0];
  if (done) {
    // Already credited (the app retries until it has consumed the purchase); nothing more to add.
    if (done.subject !== who.subject) return fail(res, 409, 'other_account', 'This purchase belongs to another install.');
    return res.status(200).json({ ok: true, credited: 0, ...calls.status(row, who.kind, now) });
  }

  let p;
  try {
    p = await calls.playPurchase(productId, purchaseToken);
  } catch (e) {
    if ([400, 404, 410].includes(e.status)) return fail(res, 400, 'invalid_purchase', 'Google Play does not recognise this purchase.');
    throw e;
  }
  // purchaseState: 0 purchased, 1 cancelled, 2 pending (e.g. a cash payment not made yet).
  if (p.purchaseState === 2) return fail(res, 409, 'pending', 'pending: The payment has not gone through yet.');
  if (p.purchaseState !== 0) return fail(res, 400, 'invalid_purchase', 'This purchase was cancelled.');
  if (p.obfuscatedExternalAccountId && p.obfuscatedExternalAccountId !== calls.accountRef(who.subject)) {
    return fail(res, 409, 'other_account', 'This purchase belongs to another install.');
  }
  const [inserted] = await ai.execute([
    `INSERT OR IGNORE INTO call_purchases (purchase_token, subject, product_id, calls, order_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING purchase_token`,
    [T(purchaseToken), T(who.subject), T(productId), I(n), T(p.orderId || ''), I(now)],
  ]);
  const [, fresh] = await ai.execute(
    ['UPDATE call_accounts SET credits = credits + ? WHERE subject = ?', [I(inserted.length ? n : 0), T(who.subject)]],
    ['SELECT * FROM call_accounts WHERE subject = ?', [T(who.subject)]]
  );
  return res.status(200).json({ ok: true, credited: inserted.length ? n : 0, ...calls.status(fresh[0], who.kind, now) });
}

async function grant(req, res) {
  const adminKey = process.env.AI_ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) return fail(res, 404, 'not_found', 'not found');
  const body = req.body || {};
  const who = body.subject
    ? { subject: String(body.subject), kind: String(body.subject).startsWith('c:') ? 'licence' : 'install' }
    : calls.subjectOf(body.token);
  const n = Math.trunc(Number(body.calls));
  if (!who || !Number.isFinite(n) || n === 0) return fail(res, 400, 'bad_request', 'Need subject or token, and calls');
  await calls.account(who.subject);
  const [, fresh] = await ai.execute(
    ['UPDATE call_accounts SET credits = MAX(0, credits + ?) WHERE subject = ?', [I(n), T(who.subject)]],
    ['SELECT * FROM call_accounts WHERE subject = ?', [T(who.subject)]]
  );
  return res.status(200).json({ subject: who.subject, ...calls.status(fresh[0], who.kind) });
}
