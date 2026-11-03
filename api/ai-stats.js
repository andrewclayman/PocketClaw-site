// GET /api/ai-stats?key=AI_ADMIN_KEY — how the free built-in AI is being used: installs,
// tasks, daily actives and spend. Counts only; nothing about what anyone asked.
const ai = require('../lib/ai');
const calls = require('../lib/calls');
const { T, I } = ai;

/** Xanadu Calls: the month's calls and cost, how calls ended, packs sold. */
async function callStats(now) {
  await calls.ensureSchema();
  const [month, outcomes, accounts, packs] = await ai.execute(
    ['SELECT usd, free_usd, calls, attempts FROM call_spend WHERE month = ?', [T(ai.month(now))]],
    [`SELECT source, outcome, COUNT(*) AS n, SUM(charged) AS charged, ROUND(SUM(usd), 4) AS usd,
        ROUND(AVG(seconds)) AS avgSeconds
      FROM call_tickets WHERE created_at > ? GROUP BY source, outcome ORDER BY n DESC`, [I(now - 30 * 86_400_000)]],
    [`SELECT COUNT(*) AS accounts, SUM(CASE WHEN calls > 0 THEN 1 ELSE 0 END) AS madeACall,
        SUM(credits) AS unusedCredits FROM call_accounts`, []],
    ['SELECT product_id AS product, COUNT(*) AS n, SUM(calls) AS calls FROM call_purchases GROUP BY product_id', []]
  );
  const m = month[0] || { usd: 0, free_usd: 0, calls: 0, attempts: 0 };
  const charged = Number(m.calls);
  return {
    month: {
      spendUsd: Number(Number(m.usd).toFixed(4)), freeSpendUsd: Number(Number(m.free_usd).toFixed(4)),
      freeCapUsd: calls.CONFIG.freeMonthlyCapUsd, calls: charged, attempts: Number(m.attempts),
      usdPerCall: charged ? Number((Number(m.usd) / charged).toFixed(4)) : null,
    },
    last30DaysByOutcome: outcomes.map((r) => ({
      source: r.source, outcome: r.outcome || '(not reported)', n: Number(r.n), charged: Number(r.charged || 0),
      usd: Number(r.usd || 0), avgSeconds: r.avgSeconds == null ? null : Number(r.avgSeconds),
    })),
    accounts: Object.fromEntries(Object.entries(accounts[0] || {}).map(([k, v]) => [k, Number(v || 0)])),
    packsSold: packs.map((r) => ({ product: r.product, n: Number(r.n), calls: Number(r.calls) })),
    config: { free: calls.CONFIG.freeCalls, licencePerMonth: calls.CONFIG.licenceCallsPerMonth, perDay: calls.CONFIG.perDay, products: calls.PRODUCTS },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.AI_ADMIN_KEY;
  if (!key || req.query.key !== key) return res.status(404).json({ error: 'not found' });
  try {
    await ai.ensureSchema();
    const now = Date.now();
    const since = ai.day(now - 13 * 86_400_000);
    const [month, installs, hist, daily, active, newByDay] = await ai.execute(
      ['SELECT usd, calls, tasks FROM ai_spend WHERE month = ?', [T(ai.month(now))]],
      [`SELECT COUNT(*) AS total,
          SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS last24h,
          SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS last7d,
          SUM(CASE WHEN tasks_used > 0 THEN 1 ELSE 0 END) AS triedATask,
          SUM(CASE WHEN tasks_used >= ? THEN 1 ELSE 0 END) AS usedAllFree,
          SUM(starter_used) AS starterTasks
        FROM ai_installs`, [I(now - 86_400_000), I(now - 7 * 86_400_000), I(ai.CONFIG.freeTasks)]],
      ['SELECT tasks_used AS tasks, COUNT(*) AS installs FROM ai_installs GROUP BY tasks_used ORDER BY tasks_used', []],
      ['SELECT day, tasks, calls, ROUND(usd, 4) AS usd FROM ai_daily WHERE day >= ? ORDER BY day', [T(since)]],
      ['SELECT day, COUNT(*) AS n FROM ai_active WHERE day >= ? GROUP BY day', [T(since)]],
      [`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
        FROM ai_installs WHERE created_at > ? GROUP BY day`, [I(now - 14 * 86_400_000)]]
    );
    const byDay = {};
    const slot = (d) => (byDay[d] ||= { day: d, newInstalls: 0, activeInstalls: 0, tasks: 0, calls: 0, usd: 0 });
    for (const r of newByDay) slot(r.day).newInstalls = Number(r.n);
    for (const r of active) slot(r.day).activeInstalls = Number(r.n);
    for (const r of daily) Object.assign(slot(r.day), { tasks: Number(r.tasks), calls: Number(r.calls), usd: Number(r.usd) });
    const m = month[0] || { usd: 0, calls: 0, tasks: 0 };
    res.status(200).json({
      month: { spendUsd: Number(Number(m.usd).toFixed(4)), capUsd: ai.CONFIG.monthlyCapUsd, calls: Number(m.calls), tasks: Number(m.tasks) },
      installs: Object.fromEntries(Object.entries(installs[0] || {}).map(([k, v]) => [k, Number(v || 0)])),
      tasksUsedPerInstall: hist.map((r) => ({ tasks: Number(r.tasks), installs: Number(r.installs) })),
      last14Days: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      config: { freeTasks: ai.CONFIG.freeTasks, freeDays: ai.CONFIG.freeDays, starterTasks: ai.CONFIG.starterTasks, fast: ai.CONFIG.fastModel, capable: ai.CONFIG.capableModel },
      calls: await callStats(now),
    });
  } catch (e) {
    console.error('ai-stats failed', e);
    res.status(500).json({ error: e.message });
  }
};
