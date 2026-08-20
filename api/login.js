// GET /api/login?email=... — subscription login: looks up the Stripe customer by the
// email used at checkout, verifies an active subscription, and mints the same signed
// license token the success page shows. Lets subscribers unlock the app with just their
// email (and recover a lost key).
const Stripe = require('stripe');
const { sign } = require('../lib/license');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'enter the email you subscribed with' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const customers = await stripe.customers.list({ email, limit: 5 });
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
      if (subs.data.length > 0) {
        return res.status(200).json({ token: sign(customer.id) });
      }
    }
    return res.status(404).json({ error: 'no active subscription found for that email' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
