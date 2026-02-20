// /api/stripe-webhook.js
// Vercel Serverless Function (Node.js)
// Receives Stripe webhook events and verifies signature using STRIPE_WEBHOOK_SECRET

const Stripe = require("stripe");

// Read raw request body (Stripe signature verification requires raw bytes)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  // Stripe will POST webhooks
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecretKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY env var" });
  if (!webhookSecret) return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET env var" });

  const stripe = new Stripe(stripeSecretKey);

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: "Could not read request body", details: String(err) });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).json({ error: "Missing Stripe-Signature header" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    // If this fails, Stripe will keep retrying
    return res.status(400).json({ error: "Webhook signature verification failed", details: String(err.message || err) });
  }

  // ✅ At this point the webhook is verified and real.
  // For now we just ACK and log the event type.
  // (Next step is: store/update Pro status in your own system.)
  console.log("✅ Stripe webhook received:", event.type);

  // It’s OK to ACK immediately; do any heavier work async later if needed.
  return res.status(200).json({ received: true, type: event.type });
};
