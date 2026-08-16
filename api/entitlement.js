// GET /api/entitlement?token=... — called by the app on every launch. Verifies the
// signed token, then asks Stripe live whether that customer has an active subscription.
// No local database: cancel in Stripe and the very next check returns active:false.
const Stripe = require('stripe');
const { verify } = require('../lib/license');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const customerId = verify(req.query.token);
    if (!customerId) return res.status(200).json({ active: false, reason: 'invalid token' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    const active = subs.data.length > 0;
    // Feature flags ride along with entitlement. Flip CALLS_ENABLED=false in the
    // Vercel env to switch Okapi Calls off for everyone with no app update; later,
    // tier-gate by checking which Stripe price the subscription is on.
    const features = { calls: active && process.env.CALLS_ENABLED !== 'false' };
    res.status(200).json({ active, features });
  } catch (e) {
    res.status(200).json({ active: false, reason: e.message });
  }
};
