// POST /api/ai — OpenAI-compatible chat completions for the app's free built-in AI.
// Authorization: Bearer <install token from /api/ai-start>.
//
// A "task" is a request whose last message is the user's: that is the start of one turn of
// the app's agent loop. The tool-call follow-ups inside the turn (last message = tool results)
// ride on that task, bounded in number and idle time. The model is picked here, from the
// tier the app asks for, and the month's spend is capped across all installs.
const ai = require('../lib/ai');
const { T, I } = ai;

const UPSTREAM = 'https://api.openai.com/v1/chat/completions';
// Only these fields reach OpenAI; anything else the client sends is dropped.
const PASSTHROUGH = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream'];

const fail = (res, status, code, message) => res.status(status).json({ error: { code, type: code, message } });

// The code leads each message so the app can recognise it inside "API error 402: {...}".
const MESSAGES = {
  free_tasks_used: 'free_tasks_used: You have used all of your free tasks.',
  free_trial_ended: 'free_trial_ended: Your free week has ended.',
  free_tier_paused: 'free_tier_paused: The free AI has reached its limit for this month.',
  busy: 'upstream_unavailable: The AI is busy right now. Try again in a moment.',
};

// Characters of text in the messages, for the rough cost estimate; picture data is left out,
// since base64 would make the estimate hundreds of times too big (low-detail pictures are cheap).
function textLength(messages) {
  return JSON.stringify(messages, (k, v) => (k === 'url' && typeof v === 'string' && v.startsWith('data:') ? '' : v)).length;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'POST only');
  const id = ai.verifyInstall(ai.bearer(req));
  if (!id) return fail(res, 401, 'invalid_token', 'invalid_token: This install is not registered for the free AI.');
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return fail(res, 400, 'bad_request', 'messages is required');
  if (!process.env.OPENAI_API_KEY) return fail(res, 503, 'not_configured', 'The free AI is not configured on the server.');

  const now = Date.now();
  const today = ai.day(now);
  // A task starts when the person sends something: the request ends on a user message. The one
  // exception is the pictures a tool fetched mid-task (look_at_images), which the app sends as a
  // user message right after the tool results, since tool messages can only carry text.
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  const toolPictures = prev?.role === 'tool' && Array.isArray(last?.content)
    && last.content.some((p) => p?.type === 'image_url');
  const isNewTask = last?.role === 'user' && !toolPictures;
  const isStarter = req.headers['x-xanadu-starter'] === '1';
  let charged = null; // 'task' or 'starter': what this request took, to give back if it fails
  let taskUsd = 0; // what this task has cost before this request

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
    if (spend >= ai.CONFIG.monthlyCapUsd) return fail(res, 503, 'free_tier_paused', MESSAGES.free_tier_paused);

    const dayCalls = row.day === today ? Number(row.day_calls) : 0;
    if (dayCalls >= ai.CONFIG.maxCallsPerDay) {
      return fail(res, 429, 'daily_limit', 'daily_limit: Too many requests today. Try again tomorrow.');
    }

    if (isNewTask && isStarter && Number(row.starter_used || 0) < ai.CONFIG.starterTasks) {
      // A starter card: free, and it doesn't start the free-period clock either.
      const [took] = await ai.execute([
        `UPDATE ai_installs SET starter_used = starter_used + 1, last_call_at = ?, task_calls = 1, task_usd = 0,
           day = ?, day_calls = ?
         WHERE id = ? AND starter_used < ? RETURNING starter_used`,
        [I(now), T(today), I(dayCalls + 1), T(id), I(ai.CONFIG.starterTasks)],
      ]);
      if (took.length) charged = 'starter';
    }
    if (charged) {
      // taken as a starter above
    } else if (isNewTask) {
      const st = ai.status(row, spend, now);
      if (st.expired) return fail(res, 402, 'free_trial_ended', MESSAGES.free_trial_ended);
      if (st.tasksLeft <= 0) return fail(res, 402, 'free_tasks_used', MESSAGES.free_tasks_used);
      // Conditional on the count so two simultaneous requests can't both take the last task.
      const [took] = await ai.execute([
        `UPDATE ai_installs SET tasks_used = tasks_used + 1, first_task_at = COALESCE(first_task_at, ?),
           last_call_at = ?, task_calls = 1, task_usd = 0, day = ?, day_calls = ?
         WHERE id = ? AND tasks_used < ? RETURNING tasks_used`,
        [I(now), I(now), T(today), I(dayCalls + 1), T(id), I(ai.CONFIG.freeTasks)],
      ]);
      if (!took.length) return fail(res, 402, 'free_tasks_used', MESSAGES.free_tasks_used);
      charged = 'task';
    } else {
      const idle = row.last_call_at == null || now - Number(row.last_call_at) > ai.CONFIG.taskIdleMs;
      if (idle) return fail(res, 409, 'task_expired', 'task_expired: That task timed out. Send your message again.');
      if (Number(row.task_calls) >= ai.CONFIG.maxCallsPerTask) {
        return fail(res, 429, 'task_too_long', 'task_too_long: This task took too many steps, so it was stopped.');
      }
      await ai.execute([
        'UPDATE ai_installs SET task_calls = task_calls + 1, last_call_at = ?, day = ?, day_calls = ? WHERE id = ?',
        [I(now), T(today), I(dayCalls + 1), T(id)],
      ]);
      taskUsd = Number(row.task_usd || 0);
    }
  } catch (e) {
    console.error('ai: bookkeeping failed', e);
    return fail(res, 500, 'server_error', 'The free AI hit a server problem. Try again in a minute.');
  }

  // A task that has already cost its share carries on with the fast model rather than stopping.
  let model = ai.resolveModel(body.model);
  if (model === ai.CONFIG.capableModel && taskUsd >= ai.CONFIG.taskCapableUsd) model = ai.CONFIG.fastModel;
  const upstreamBody = { model, max_completion_tokens: ai.CONFIG.maxOutputTokens };
  for (const k of PASSTHROUGH) if (body[k] !== undefined) upstreamBody[k] = body[k];
  const stream = upstreamBody.stream === true;
  if (stream) upstreamBody.stream_options = { include_usage: true };

  // Stop paying for a reply nobody is waiting for: the app's stop button closes the socket.
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  let usage = null;
  let upstreamOk = false;
  try {
    const up = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
      signal: abort.signal,
    });
    if (!up.ok) {
      const text = await up.text();
      console.error('ai: upstream', up.status, text.slice(0, 500));
      // A malformed request is worth passing on; anything else (our key, OpenAI's capacity)
      // is not the user's problem to diagnose.
      if (up.status === 400) {
        let msg = 'The AI rejected the request.';
        try { msg = JSON.parse(text).error?.message || msg; } catch {}
        fail(res, 400, 'bad_request', msg);
      } else {
        fail(res, 502, 'upstream_unavailable', MESSAGES.busy);
      }
    } else if (stream) {
      upstreamOk = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        // Watch the stream for the closing usage chunk that stream_options asked for.
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
          } catch {}
        }
      }
    } else {
      upstreamOk = true;
      const j = await up.json();
      usage = j.usage || null;
      res.status(200).json(j);
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('ai: proxy failed', e);
    if (!res.headersSent) fail(res, 502, 'upstream_unavailable', MESSAGES.busy);
  }

  try {
    // The user got nothing for this task, so it doesn't count against them.
    if (!upstreamOk && charged) {
      const col = charged === 'starter' ? 'starter_used' : 'tasks_used';
      await ai.execute([`UPDATE ai_installs SET ${col} = MAX(0, ${col} - 1) WHERE id = ?`, [T(id)]]);
    }
    // An aborted stream never reports usage; charge a rough estimate rather than nothing.
    const cost = usage ? ai.costUsd(model, usage)
      : upstreamOk ? ai.costUsd(model, { prompt_tokens: Math.ceil(textLength(messages) / 3.5), completion_tokens: 1000 })
      : 0;
    const counted = charged && upstreamOk ? 1 : 0;
    await ai.execute(
      ['UPDATE ai_installs SET spend_usd = spend_usd + ?, task_usd = task_usd + ? WHERE id = ?', [['real', cost], ['real', cost], T(id)]],
      [`INSERT INTO ai_spend (month, usd, calls, tasks) VALUES (?, ?, 1, ?)
        ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1, tasks = tasks + excluded.tasks`,
        [T(ai.month(now)), ['real', cost], I(counted)]],
      [`INSERT INTO ai_daily (day, usd, calls, tasks) VALUES (?, ?, 1, ?)
        ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1, tasks = tasks + excluded.tasks`,
        [T(today), ['real', cost], I(counted)]],
      ['INSERT OR IGNORE INTO ai_active (day, id) VALUES (?, ?)', [T(today), T(id)]]
    );
  } catch (e) {
    console.error('ai: spend bookkeeping failed', e);
  }
  if (!res.writableEnded) res.end();
};
