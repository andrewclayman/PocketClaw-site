// One-time setup: creates the Stripe Product, the $5/mo recurring Price, and an
// intro coupon (first 3 months discounted to $1). Prints the IDs to drop into your
// Vercel env vars (STRIPE_PRICE_ID, STRIPE_INTRO_COUPON_ID). Safe to re-run — it
// checks for an existing product by name before creating a duplicate.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_xxx node setup-stripe.js
//
// Adjust FULL_PRICE_USD / INTRO_PRICE_USD / INTRO_MONTHS below before running if you
// want different numbers — these are just this session's best-guess defaults.

const Stripe = require('stripe');

const FULL_PRICE_USD = 5.00;
const INTRO_PRICE_USD = 1.00;
const INTRO_MONTHS = 3;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('Set STRIPE_SECRET_KEY first.'); process.exit(1); }
  const stripe = Stripe(key);

  const products = await stripe.products.list({ limit: 100 });
  let product = products.data.find(p => p.name === 'Xanadu Okapi');
  if (!product) {
    product = await stripe.products.create({
      name: 'Xanadu Okapi',
      description: 'Voice-first AI that runs your phone.',
    });
    console.log('Created product:', product.id);
  } else {
    console.log('Using existing product:', product.id);
  }

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(FULL_PRICE_USD * 100),
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log('Created price:', price.id, `($${FULL_PRICE_USD}/mo)`);

  const discountPercent = Math.round((1 - INTRO_PRICE_USD / FULL_PRICE_USD) * 100);
  const coupon = await stripe.coupons.create({
    percent_off: discountPercent,
    duration: 'repeating',
    duration_in_months: INTRO_MONTHS,
    name: `Intro price ($${INTRO_PRICE_USD}/mo for ${INTRO_MONTHS} months)`,
  });
  console.log('Created coupon:', coupon.id, `(${discountPercent}% off for ${INTRO_MONTHS} months)`);

  console.log('\n--- Add these to your Vercel project env vars ---');
  console.log('STRIPE_PRICE_ID=' + price.id);
  console.log('STRIPE_INTRO_COUPON_ID=' + coupon.id);
}

main().catch(e => { console.error(e); process.exit(1); });
