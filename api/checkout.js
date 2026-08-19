// GET /api/checkout — starts a Stripe Checkout session for the Xanadu
// subscription (intro coupon applied automatically) and redirects to it.
const Stripe = require('stripe');

module.exports = async (req, res) => {
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const site = process.env.SITE_URL || 'https://xanadulynx.com';

    const params = {
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/#pricing`,
      allow_promotion_codes: true,
    };
    if (process.env.STRIPE_INTRO_COUPON_ID) {
      params.discounts = [{ coupon: process.env.STRIPE_INTRO_COUPON_ID }];
      delete params.allow_promotion_codes; // Stripe disallows combining discounts with promo codes
    }

    const session = await stripe.checkout.sessions.create(params);
    res.writeHead(303, { Location: session.url });
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
