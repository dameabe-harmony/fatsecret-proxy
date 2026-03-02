/**
 * /api/subscription — Stripe Subscription Management
 *
 * POST /api/subscription?action=create-checkout
 *   Body: { userId, email, period: 'monthly'|'annual', promoCode? }
 *   Returns: { url: 'https://checkout.stripe.com/...' }
 *
 * POST /api/subscription?action=create-portal
 *   Body: { stripeCustomerId }
 *   Returns: { url: 'https://billing.stripe.com/...' }
 *
 * POST /api/subscription?action=webhook
 *   Stripe webhook events (checkout.completed, subscription updated/deleted)
 *
 * Env vars (Vercel):
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRICE_MONTHLY    (price ID for $7.99/mo)
 *   STRIPE_PRICE_ANNUAL     (price ID for $87.89/yr)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (NOT the anon key — service role for backend writes)
 *   NEXT_PUBLIC_APP_URL     (e.g., https://harmoniousfood.harmonytec.net)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://harmoniousfood.harmonytec.net';

const PRICES = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
};

// ── Helpers ──────────────────────────────────────────────────

/** Read raw body as Buffer (for webhook signature verification) */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse JSON body manually.
 * Because bodyParser is disabled (needed for webhook raw body),
 * we must parse JSON ourselves for non-webhook actions.
 */
async function parseJsonBody(req) {
  // If Vercel already parsed it (shouldn't happen with bodyParser: false, but safe fallback)
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return req.body;
  }

  const raw = await getRawBody(req);
  const text = raw.toString('utf8');

  if (!text || text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse request body:', e.message);
    return {};
  }
}

/** Update user profile in Supabase via service role */
async function updateProfile(userId, updates) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Supabase update failed:', response.status, text);
    throw new Error(`Supabase update failed: ${response.status}`);
  }
}

/** Find profile by Stripe customer ID */
async function findProfileByStripeCustomer(stripeCustomerId) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${stripeCustomerId}&select=id,email,tier`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!response.ok) return null;
  const data = await response.json();
  return data.length > 0 ? data[0] : null;
}

/** Find profile by user ID */
async function findProfileById(userId) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email,tier,stripe_customer_id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!response.ok) return null;
  const data = await response.json();
  return data.length > 0 ? data[0] : null;
}

// ── Main Handler ─────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const action = req.query?.action;

  try {
    // ===========================================================
    // CREATE CHECKOUT SESSION
    // ===========================================================
    if (action === 'create-checkout') {
      const body = await parseJsonBody(req);
      const { userId, email, period, promoCode } = body;

      console.log('create-checkout received:', { userId: !!userId, email: !!email, period, promoCode: !!promoCode });

      if (!userId || !email) {
        return res.status(400).json({ error: 'Missing userId or email' });
      }

      if (!period || !PRICES[period]) {
        return res.status(400).json({
          error: 'Invalid period. Use "monthly" or "annual"',
          received: period,
          available: Object.keys(PRICES),
        });
      }

      const priceId = PRICES[period];
      if (!priceId) {
        return res.status(500).json({
          error: `Stripe price ID not configured for "${period}". Set STRIPE_PRICE_${period.toUpperCase()} in Vercel env vars.`,
        });
      }

      // Check if user already has a Stripe customer
      const profile = await findProfileById(userId);
      let customerId = profile?.stripe_customer_id;

      if (!customerId) {
        // Create Stripe customer
        const customer = await stripe.customers.create({
          email,
          metadata: { supabase_user_id: userId },
        });
        customerId = customer.id;

        // Save to profile
        await updateProfile(userId, { stripe_customer_id: customerId });
        console.log(`Created Stripe customer ${customerId} for user ${userId}`);
      }

      // Build checkout session config
      const sessionConfig = {
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `${APP_URL}?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}?subscription=canceled`,
        subscription_data: {
          trial_period_days: 4,
          metadata: {
            supabase_user_id: userId,
            period,
          },
        },
        metadata: {
          supabase_user_id: userId,
          period,
        },
      };

      // Add promo code if provided
      if (promoCode && promoCode.trim().length > 0) {
        try {
          const promoCodes = await stripe.promotionCodes.list({
            code: promoCode.trim(),
            active: true,
            limit: 1,
          });
          if (promoCodes.data.length > 0) {
            // Valid promo code found — apply it directly
            sessionConfig.discounts = [{ promotion_code: promoCodes.data[0].id }];
            console.log(`Applied promo code: ${promoCode}`);
          } else {
            // Code not found — let user enter manually on Stripe checkout
            sessionConfig.allow_promotion_codes = true;
            console.log(`Promo code "${promoCode}" not found, allowing manual entry`);
          }
        } catch (promoErr) {
          console.log('Promo code lookup failed, allowing manual entry:', promoErr.message);
          sessionConfig.allow_promotion_codes = true;
        }
      } else {
        // No code provided — allow manual entry
        sessionConfig.allow_promotion_codes = true;
      }

      // Create checkout session
      const session = await stripe.checkout.sessions.create(sessionConfig);
      console.log(`Checkout session created: ${session.id}`);

      return res.status(200).json({ url: session.url, sessionId: session.id });
    }

    // ===========================================================
    // CREATE CUSTOMER PORTAL (manage/cancel subscription)
    // ===========================================================
    if (action === 'create-portal') {
      const body = await parseJsonBody(req);
      const { stripeCustomerId } = body;

      if (!stripeCustomerId) {
        return res.status(400).json({ error: 'Missing stripeCustomerId' });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${APP_URL}?from=portal`,
      });

      return res.status(200).json({ url: session.url });
    }

    // ===========================================================
    // STRIPE WEBHOOK (uses raw body — do NOT parse as JSON)
    // ===========================================================
    if (action === 'webhook') {
      const sig = req.headers['stripe-signature'];
      const rawBody = await getRawBody(req);

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
      }

      console.log(`Stripe webhook: ${event.type}`);

      // --- CHECKOUT COMPLETED ---
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (userId && subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const period = subscription.metadata?.period || 'monthly';

          await updateProfile(userId, {
            tier: 'pro',
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: 'active',
            subscription_period: period,
            subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          });

          console.log(`✓ User ${userId} upgraded to Pro (${period})`);
        }
      }

      // --- SUBSCRIPTION UPDATED ---
      if (event.type === 'customer.subscription.updated') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const profile = await findProfileByStripeCustomer(customerId);

        if (profile) {
          const isActive = ['active', 'trialing'].includes(subscription.status);
          await updateProfile(profile.id, {
            tier: isActive ? 'pro' : 'free',
            subscription_status: subscription.status,
            subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          });

          console.log(`✓ Subscription updated for ${profile.email}: ${subscription.status}`);
        }
      }

      // --- SUBSCRIPTION DELETED ---
      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const profile = await findProfileByStripeCustomer(customerId);

        if (profile) {
          await updateProfile(profile.id, {
            tier: 'free',
            subscription_status: 'canceled',
            stripe_subscription_id: null,
            subscription_period: null,
            subscription_current_period_end: null,
            updated_at: new Date().toISOString(),
          });

          console.log(`✓ Subscription canceled for ${profile.email} — downgraded to free`);
        }
      }

      // --- PAYMENT FAILED ---
      if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const profile = await findProfileByStripeCustomer(customerId);

        if (profile) {
          await updateProfile(profile.id, {
            subscription_status: 'past_due',
            updated_at: new Date().toISOString(),
          });

          console.log(`⚠️ Payment failed for ${profile.email}`);
        }
      }

      return res.status(200).json({ received: true });
    }

    // ===========================================================
    // UNKNOWN ACTION
    // ===========================================================
    return res.status(400).json({
      error: 'Invalid action',
      validActions: ['create-checkout', 'create-portal', 'webhook'],
    });

  } catch (err) {
    console.error('Subscription error:', err);
    return res.status(500).json({
      error: 'Server error',
      message: err.message,
    });
  }
};

// Disable Vercel's automatic body parsing so webhook can access raw body
// for Stripe signature verification. Non-webhook actions parse JSON manually.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
