// POST /api/search — web search for the app's free built-in AI, used when the app's own search
// (DuckDuckGo's plain HTML page) turns it away with a bot check, which it does after a burst of
// searches from one address. Authorization: Bearer <install token from /api/ai-start>.
// Body: { query }. Returns { text } — a numbered list of real pages with URLs.
//
// Only works inside a running task (a recent /api/ai call), so it can't be used as a free search
// service on its own, and its cost counts toward the task, the install and the monthly cap.
const ai = require('../lib/ai');
const { T, I } = ai;

const UPSTREAM = 'https://api.openai.com/v1/responses';
// OpenAI's web search tool call fee, on top of the tokens.
const SEARCH_CALL_USD = 0.01;

const fail = (res, status, code, message) => res.status(status).json({ error: { code, type: code, message } });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'POST only');
  const id = ai.verifyInstall(ai.bearer(req));
  if (!id) return fail(res, 401, 'invalid_token', 'invalid_token: This install is not registered for the free AI.');
  const query = String((req.body || {}).query || '').trim().slice(0, 300);
  if (!query) return fail(res, 400, 'bad_request', 'query is required');
  if (!process.env.OPENAI_API_KEY) return fail(res, 503, 'not_configured', 'The free AI is not configured on the server.');

  const now = Date.now();
  const today = ai.day(now);
  try {
    await ai.ensureSchema();
    const [rows, spendRows] = await ai.execute(
      ['SELECT * FROM ai_installs WHERE id = ?', [T(id)]],
      ['SELECT usd FROM ai_spend WHERE month = ?', [T(ai.month(now))]]
    );
    const row = rows[0];
    if (!row) return fail(res, 401, 'invalid_token', 'invalid_token: This install is not registered for the free AI.');
    if (Number(row.blocked)) return fail(res, 403, 'blocked', 'This install has been blocked.');
    const spend = spendRows.length ? Number(spendRows[0].usd) : 0;
    if (spend >= ai.CONFIG.monthlyCapUsd) return fail(res, 503, 'free_tier_paused', 'free_tier_paused: The free AI has reached its limit for this month.');
    if (row.last_call_at == null || now - Number(row.last_call_at) > ai.CONFIG.taskIdleMs) {
      return fail(res, 409, 'no_task', 'Search only works during a task.');
    }
    const dayCalls = row.day === today ? Number(row.day_calls) : 0;
    if (dayCalls >= ai.CONFIG.maxCallsPerDay) {
      return fail(res, 429, 'daily_limit', 'daily_limit: Too many requests today. Try again tomorrow.');
    }
    await ai.execute(['UPDATE ai_installs SET day = ?, day_calls = ? WHERE id = ?', [T(today), I(dayCalls + 1), T(id)]]);
  } catch (e) {
    console.error('search: bookkeeping failed', e);
    return fail(res, 500, 'server_error', 'Search hit a server problem.');
  }

  const model = ai.CONFIG.searchModel;
  let usage = null;
  let calls = 0;
  try {
    const up = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search' }],
        reasoning: { effort: 'low' },
        max_output_tokens: 1500,
        input: `Web search for: ${query}\n` +
          'List the 8 most useful pages you found, numbered: title, URL, then one line on what the page ' +
          'says that is relevant. Real pages only, with their full URLs.',
      }),
    });
    if (!up.ok) {
      console.error('search: upstream', up.status, (await up.text()).slice(0, 500));
      return fail(res, 502, 'upstream_unavailable', 'Search is unavailable right now.');
    }
    const j = await up.json();
    usage = j.usage || null;
    let text = '';
    for (const o of j.output || []) {
      if (o.type === 'web_search_call') calls++;
      if (o.type === 'message') for (const c of o.content || []) if (c.type === 'output_text') text += c.text;
    }
    // Citations carry a tracking parameter that isn't part of the page's address.
    text = text.replace(/[?&]utm_source=openai/g, '');
    res.status(200).json({ text });
  } catch (e) {
    console.error('search: failed', e);
    if (!res.headersSent) fail(res, 502, 'upstream_unavailable', 'Search is unavailable right now.');
  }

  try {
    const cost = (usage ? ai.costUsd(model, {
      prompt_tokens: usage.input_tokens,
      prompt_tokens_details: usage.input_tokens_details,
      completion_tokens: usage.output_tokens,
    }) : 0) + calls * SEARCH_CALL_USD;
    await ai.execute(
      ['UPDATE ai_installs SET spend_usd = spend_usd + ?, task_usd = task_usd + ? WHERE id = ?', [['real', cost], ['real', cost], T(id)]],
      [`INSERT INTO ai_spend (month, usd, calls, tasks) VALUES (?, ?, 1, 0)
        ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
        [T(ai.month(now)), ['real', cost]]],
      [`INSERT INTO ai_daily (day, usd, calls, tasks) VALUES (?, ?, 1, 0)
        ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
        [T(today), ['real', cost]]]
    );
  } catch (e) {
    console.error('search: spend bookkeeping failed', e);
  }
};
