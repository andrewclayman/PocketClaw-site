# Xanadu Okapi — site + licensing backend

Static marketing site (`index.html`, `success.html`, `assets/`) plus three tiny
serverless functions (`api/`). No database — Stripe is the source of truth for
who's paid; entitlement is checked live against Stripe on every app launch.

## Deploy

```
cd backend
npm install -g vercel   # if not already installed
vercel login
vercel                  # first deploy, follow prompts, link/create project
vercel --prod
```

## One-time Stripe setup

1. Create a Stripe account (or use an existing one) at stripe.com.
2. Get the secret key from Stripe Dashboard → Developers → API keys.
3. Run the setup script to create the product/price/intro-coupon:
   ```
   STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe.js
   ```
   It prints `STRIPE_PRICE_ID` and `STRIPE_INTRO_COUPON_ID` — copy both.
4. In the Vercel project (Settings → Environment Variables), set everything from
   `.env.example`: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_INTRO_COUPON_ID`,
   `LICENSE_SECRET` (generate your own, see `.env.example`), `SITE_URL`.
5. Redeploy (`vercel --prod`) so the functions pick up the new env vars.

**Start in Stripe test mode** (`sk_test_...` key) and run a full checkout with
Stripe's test card `4242 4242 4242 4242` to confirm the whole loop — pay →
land on success.html → get a license token → paste in the app → unlocks —
before ever switching to a live key. Switching to `sk_live_...` starts charging
real cards; that's the one step in this whole flow I'd want a human eyeball on
before it happens, not something to run through unattended.

## If the domain isn't `xanaduokapi.com` yet

Two places hardcode that domain and need updating to match whatever you
actually deploy to (a custom domain, or the default `*.vercel.app` one):
- `SITE_URL` env var above
- `LICENSE_API_BASE` in `app/src/main/java/com/pocketclaw/license/LicenseGate.kt`
  in the Android project — after changing it, rebuild the release APK
  (`.\gradlew.bat assembleRelease`) and re-copy it into `backend/assets/xanadu-okapi.apk`.
