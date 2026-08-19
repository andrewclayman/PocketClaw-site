// ONE-COMMAND GO-LIVE: flips the whole funnel from Stripe test mode to real payments.
//
// What it does, with your LIVE Stripe secret key:
//   1. Creates (or reuses) the live "Xanadu" product, a $5/mo price, and the $1 intro coupon.
//   2. Points the live site (pocketclaw-site on Vercel) at those live values, storing the
//      secret key as a *sensitive* env var.
//   3. Redeploys so it's live immediately.
//
// You must be logged into the Vercel CLI (you already are — it's been deploying the site).
//
// Run it from this folder (backend/). PowerShell:
//     $env:STRIPE_SECRET_KEY="sk_live_xxxxx"; node go-live.js
// Git Bash:
//     STRIPE_SECRET_KEY=sk_live_xxxxx node go-live.js
//
// Get your live key at https://dashboard.stripe.com/apikeys (toggle OFF "test mode" first,
// then reveal the "Secret key" — it starts sk_live_). Your Stripe account must be activated
// for live payments (business details filled in) or Stripe blocks live charges.

const Stripe = require('stripe');
const { execFileSync } = require('child_process');

const PROJECT = 'pocketclaw-site';
const FULL_PRICE_USD = 5.00;
const INTRO_PRICE_USD = 1.00;
const INTRO_MONTHS = 3;

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function vercel(args, input) {
  return execFileSync(NPX, ['--yes', 'vercel', ...args], {
    input: input || '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
}
function setEnv(key, value, sensitive) {
  // remove any existing value on production, then add fresh. Ignore "not found" on remove.
  try { vercel(['env', 'rm', key, 'production', '--yes']); } catch (_) {}
  const args = ['env', 'add', key, 'production'];
  if (sensitive) args.push('--sensitive');
  vercel(args, value + '\n');
  console.log(`  set ${key}${sensitive ? ' (sensitive)' : ''}`);
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('Set STRIPE_SECRET_KEY first (your sk_live_ key).'); process.exit(1); }
  if (!key.startsWith('sk_live_') && !key.startsWith('rk_live_')) {
    console.error(`That key starts "${key.slice(0, 8)}" — go-live needs a LIVE key (sk_live_...). Aborting so you don't ship test mode.`);
    process.exit(1);
  }
  const stripe = Stripe(key);

  console.log('Creating live Stripe product/price/coupon…');
  const products = await stripe.products.list({ limit: 100 });
  let product = products.data.find(p => p.name === 'Xanadu');
  if (!product) {
    product = await stripe.products.create({ name: 'Xanadu', description: 'The AI that runs your phone.' });
    console.log('  created product', product.id);
  } else {
    console.log('  using existing product', product.id);
  }

  const price = await stripe.prices.create({
    product: product.id, unit_amount: Math.round(FULL_PRICE_USD * 100),
    currency: 'usd', recurring: { interval: 'month' },
  });
  console.log('  created price', price.id, `($${FULL_PRICE_USD}/mo)`);

  const pct = Math.round((1 - INTRO_PRICE_USD / FULL_PRICE_USD) * 100);
  const coupon = await stripe.coupons.create({
    percent_off: pct, duration: 'repeating', duration_in_months: INTRO_MONTHS,
    name: `Intro ($${INTRO_PRICE_USD}/mo for ${INTRO_MONTHS} months)`,
  });
  console.log('  created coupon', coupon.id, `(${pct}% off × ${INTRO_MONTHS}mo)`);

  console.log('Pointing the live site at these…');
  setEnv('STRIPE_SECRET_KEY', key, true);
  setEnv('STRIPE_PRICE_ID', price.id, false);
  setEnv('STRIPE_INTRO_COUPON_ID', coupon.id, false);

  console.log('Redeploying…');
  vercel(['deploy', '--prod', '--yes']);
  console.log('\n✅ Live. xanadulynx.com now takes real payments. Do one real $1 purchase to confirm, then cancel it in the Stripe dashboard if you like.');
}
main().catch(e => { console.error(e); process.exit(1); });
