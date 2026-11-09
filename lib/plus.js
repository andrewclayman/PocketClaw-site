// Xanadu Plus: the monthly subscription sold on Google Play (PLUS_PRODUCTS, plus_monthly). While an
// install has it, it gets a month's tasks (lib/ai.js, PLUS_TASKS_PER_MONTH) and calls (lib/calls.js,
// PLUS_CALLS_PER_MONTH) instead of the free allowance, and the free tier's spending cap doesn't
// apply to it.
//
// A subscription belongs to whichever install last showed us its purchase token. Only the Google
// account that bought it can see the token, so a reinstall or a new phone on that account brings
// Plus along, and the install it came from loses it.
//
// Renewals aren't pushed to us. The app shows us its token every time it starts, and an install
// whose paid time has run out is checked with Google again before it's treated as lapsed.
const ai = require('./ai');
const play = require('./play');
const { execute, query, T, I } = ai;

const PRODUCTS = (process.env.PLUS_PRODUCTS || 'plus_monthly').split(',').map((p) => p.trim()).filter(Boolean);

// How often a lapsed install's subscription may be checked with Google again.
const RECHECK_MS = 10 * 60_000;

// States in which the time up to expiryTime is paid for. CANCELED only means it won't renew.
const PAID = new Set([
  'SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED',
]);

/** The Plus line of Google's subscription record: { productId, state, until, orderId }. [until] is
 *  when the paid time ends (ms), or 0 if there's none (expired, on hold, paused, pending). */
function entitlement(sub) {
  const item = (sub.lineItems || []).find((li) => PRODUCTS.includes(li.productId));
  const state = String(sub.subscriptionState || '');
  const expiry = item ? Date.parse(item.expiryTime) || 0 : 0;
  return { productId: item?.productId || '', state, until: PAID.has(state) ? expiry : 0, orderId: sub.latestOrderId || '' };
}

/** Sets an install's plus_until from the subscriptions it holds. */
const refreshInstall = (id) => [
  'UPDATE ai_installs SET plus_until = COALESCE((SELECT MAX(until) FROM plus_subs WHERE install_id = ?), 0) WHERE id = ?',
  [T(id), T(id)],
];

/**
 * Checks [purchaseToken] with Google and puts the subscription on install [id] (taking it off
 * any other install). Returns entitlement(); productId is '' if the token isn't for Plus.
 * Throws with .status for a token Google doesn't know (400/404/410).
 */
async function link(id, purchaseToken, now = Date.now()) {
  const sub = await play.playSubscription(purchaseToken);
  const e = entitlement(sub);
  if (!e.productId) return e;
  const prev = (await query('SELECT install_id FROM plus_subs WHERE purchase_token = ?', [T(purchaseToken)]))[0];
  const statements = [
    [`INSERT INTO plus_subs (purchase_token, install_id, product_id, state, until, order_id, created_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(purchase_token) DO UPDATE SET install_id = excluded.install_id, state = excluded.state,
        until = excluded.until, order_id = excluded.order_id, checked_at = excluded.checked_at`,
      [T(purchaseToken), T(id), T(e.productId), T(e.state), I(e.until), T(e.orderId), I(now), I(now)]],
  ];
  // A resubscription replaces the old purchase, which no longer counts.
  if (sub.linkedPurchaseToken) {
    statements.push(['UPDATE plus_subs SET until = 0 WHERE purchase_token = ?', [T(sub.linkedPurchaseToken)]]);
  }
  statements.push(refreshInstall(id));
  if (prev && prev.install_id !== id) statements.push(refreshInstall(prev.install_id));
  await execute(...statements);
  return e;
}

/**
 * Whether the install in [row] (needs id and plus_until) has Plus now. If its paid time has
 * just run out, asks Google first, in case it renewed; updates row.plus_until.
 */
async function current(row, now = Date.now()) {
  const until = Number(row.plus_until || 0);
  if (until > now) return true;
  if (until === 0 || !process.env.GOOGLE_PLAY_SERVICE_ACCOUNT) return false;
  try {
    const subs = await query(
      'SELECT purchase_token FROM plus_subs WHERE install_id = ? AND checked_at < ?',
      [T(row.id), I(now - RECHECK_MS)]
    );
    for (const s of subs) {
      try {
        await link(row.id, s.purchase_token, now);
      } catch (e) {
        if (![400, 404, 410].includes(e.status)) throw e;
        // Google no longer knows the token: it gives nothing.
        await execute(
          ['UPDATE plus_subs SET until = 0, checked_at = ? WHERE purchase_token = ?', [I(now), T(s.purchase_token)]],
          refreshInstall(row.id)
        );
      }
    }
    const fresh = (await query('SELECT plus_until FROM ai_installs WHERE id = ?', [T(row.id)]))[0];
    row.plus_until = Number(fresh?.plus_until || 0);
  } catch (e) {
    // Google unreachable: treat as lapsed for now, and try again on a later request.
    console.error('plus: recheck failed', e);
  }
  return Number(row.plus_until || 0) > now;
}

module.exports = { PRODUCTS, entitlement, link, current };
