// GET /api/ai-stats?key=AI_ADMIN_KEY — how the free built-in AI is being used: chat
// registrations, what they did, who came back, starter cards, daily actives and spend, and
// Xanadu Plus subscribers.
// Counts only; nothing about what anyone asked.
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
    // A "registration" is an install that reached the chat screen once (the app calls
    // /api/ai-start there). Play Console is the source of truth for installs.
    const createdDay = `strftime('%Y-%m-%d', i.created_at / 1000, 'unixepoch')`;
    const [month, regs, hist, daily, active, newByDay, opens, cards, plusNow, plusSubs] = await ai.execute(
      ['SELECT usd, plus_usd, calls, tasks FROM ai_spend WHERE month = ?', [T(ai.month(now))]],
      [`SELECT COUNT(*) AS allTime,
          SUM(CASE WHEN i.created_at > ? THEN 1 ELSE 0 END) AS last24h,
          SUM(CASE WHEN i.created_at > ? THEN 1 ELSE 0 END) AS last7d,
          SUM(CASE WHEN i.created_at > ? THEN 1 ELSE 0 END) AS last14d,
          SUM(CASE WHEN i.tasks_used > 0 AND i.starter_used = 0 THEN 1 ELSE 0 END) AS ownAsksOnly,
          SUM(CASE WHEN i.tasks_used = 0 AND i.starter_used > 0 THEN 1 ELSE 0 END) AS cardsOnly,
          SUM(CASE WHEN i.tasks_used > 0 AND i.starter_used > 0 THEN 1 ELSE 0 END) AS both,
          SUM(CASE WHEN i.tasks_used = 0 AND i.starter_used = 0 THEN 1 ELSE 0 END) AS didNothing,
          SUM(CASE WHEN i.tasks_used >= ? THEN 1 ELSE 0 END) AS usedAllFree,
          SUM(i.starter_used) AS cardsSent,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM ai_opens o WHERE o.id = i.id AND o.day > ${createdDay})
            THEN 1 ELSE 0 END) AS openedOnALaterDay,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM ai_active a WHERE a.id = i.id AND a.day > ${createdDay})
            THEN 1 ELSE 0 END) AS usedAiOnALaterDay
        FROM ai_installs i`,
        [I(now - 86_400_000), I(now - 7 * 86_400_000), I(now - 14 * 86_400_000), I(ai.CONFIG.freeTasks)]],
      ['SELECT tasks_used AS tasks, COUNT(*) AS registrations FROM ai_installs GROUP BY tasks_used ORDER BY tasks_used', []],
      ['SELECT day, tasks, calls, ROUND(usd, 4) AS usd FROM ai_daily WHERE day >= ? ORDER BY day', [T(since)]],
      ['SELECT day, COUNT(*) AS n FROM ai_active WHERE day >= ? GROUP BY day', [T(since)]],
      // Not "GROUP BY day": ai_installs has its own day column (last active day), which SQLite
      // groups by instead of the alias, and the per-day counts then overwrote each other.
      [`SELECT ${createdDay} AS created_day, COUNT(*) AS n FROM ai_installs i WHERE i.created_at > ? GROUP BY 1`,
        [I(now - 14 * 86_400_000)]],
      ['SELECT day, COUNT(*) AS n FROM ai_opens WHERE day >= ? GROUP BY day', [T(since)]],
      ['SELECT day, card, n FROM ai_cards WHERE day >= ? ORDER BY day, card', [T(since)]],
      [`SELECT COUNT(*) AS subscribers, SUM(CASE WHEN plus_month = ? THEN plus_tasks ELSE 0 END) AS tasksThisMonth
        FROM ai_installs WHERE plus_until > ?`, [T(ai.month(now)), I(now)]],
      [`SELECT COUNT(*) AS everSubscribed,
          SUM(CASE WHEN state = 'SUBSCRIPTION_STATE_CANCELED' AND until > ? THEN 1 ELSE 0 END) AS cancelledStillPaid
        FROM plus_subs`, [I(now)]]
    );
    const byDay = {};
    const slot = (d) => (byDay[d] ||= { day: d, newRegistrations: 0, opened: 0, usedAi: 0, tasks: 0, aiRequests: 0, usd: 0, cards: {} });
    for (const r of newByDay) slot(r.created_day).newRegistrations = Number(r.n);
    for (const r of opens) slot(r.day).opened = Number(r.n);
    for (const r of active) slot(r.day).usedAi = Number(r.n);
    for (const r of daily) Object.assign(slot(r.day), { tasks: Number(r.tasks), aiRequests: Number(r.calls), usd: Number(r.usd) });
    const cardTotals = {};
    for (const r of cards) {
      slot(r.day).cards[r.card] = Number(r.n);
      cardTotals[r.card] = (cardTotals[r.card] || 0) + Number(r.n);
    }
    const m = month[0] || { usd: 0, plus_usd: 0, calls: 0, tasks: 0 };
    const usd = (v) => Number(Number(v || 0).toFixed(4));
    const num = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, Number(v || 0)]));
    const reg = Object.fromEntries(Object.entries(regs[0] || {}).map(([k, v]) => [k, Number(v || 0)]));
    res.status(200).json({
      notes: {
        registrations: 'Installs that reached the chat screen at least once. Play Console counts installs.',
        engagement: 'ownAsksOnly + cardsOnly + both + didNothing = allTime registrations. cardsSent counts card uses, not people.',
        returns: 'openedOnALaterDay needs app opens, recorded from the 0.2.3 server update on; earlier registrations only count from then.',
        cardsLast14Days: 'Starter cards sent, as daily totals per card (app 0.2.3+). Not linked to anyone.',
        month: 'aiRequests are requests to the AI, not phone calls; phone calls are under calls. capUsd applies to freeSpendUsd only.',
        plus: 'subscribers: installs with paid Plus time now. cancelledStillPaid: turned off renewal, paid time not over yet.',
      },
      month: {
        spendUsd: usd(m.usd), freeSpendUsd: usd(m.usd - (m.plus_usd || 0)), plusSpendUsd: usd(m.plus_usd),
        capUsd: ai.CONFIG.monthlyCapUsd, aiRequests: Number(m.calls), tasks: Number(m.tasks),
      },
      plus: { ...num(plusNow[0]), ...num(plusSubs[0]), tasksPerMonth: ai.CONFIG.plusTasksPerMonth, callsPerMonth: calls.CONFIG.plusCallsPerMonth },
      registrations: { allTime: reg.allTime, last24h: reg.last24h, last7d: reg.last7d, last14d: reg.last14d },
      engagement: {
        ownAsksOnly: reg.ownAsksOnly, cardsOnly: reg.cardsOnly, both: reg.both, didNothing: reg.didNothing,
        usedAllFree: reg.usedAllFree, cardsSent: reg.cardsSent,
      },
      returns: { openedOnALaterDay: reg.openedOnALaterDay, usedAiOnALaterDay: reg.usedAiOnALaterDay },
      cardsLast14Days: cardTotals,
      tasksUsedPerRegistration: hist.map((r) => ({ tasks: Number(r.tasks), registrations: Number(r.registrations) })),
      last14Days: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      config: { freeTasks: ai.CONFIG.freeTasks, freeDays: ai.CONFIG.freeDays, starterTasks: ai.CONFIG.starterTasks, fast: ai.CONFIG.fastModel, capable: ai.CONFIG.capableModel },
      calls: await callStats(now),
    });
  } catch (e) {
    console.error('ai-stats failed', e);
    res.status(500).json({ error: e.message });
  }
};
