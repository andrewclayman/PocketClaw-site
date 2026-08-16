// GET /api/session-license?session_id=... — called by success.html right after Stripe
// redirects back from a completed checkout. Mints the license token the user pastes
// into the app. No webhook needed: this reads the session directly from Stripe.
const Stripe = require('stripe');
const { sign } = require('../lib/license');

module.exports = async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'missing session_id' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'payment not completed yet' });
    }

    const token = sign(session.customer);
    res.status(200).json({ token, email: session.customer_details?.email || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
