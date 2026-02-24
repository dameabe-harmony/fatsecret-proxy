/**
 * /api/barcode?code=XXXXXXXXXXXX
 * /api/barcode?debug=1  (temporary - shows credential diagnostics)
 *
 * Env vars (Vercel Project Settings → Environment Variables):
 *   FATSECRET_CONSUMER_KEY
 *   FATSECRET_CONSUMER_SECRET
 */

const crypto = require("crypto");

const API_URL = "https://platform.fatsecret.com/rest/server.api";

const CACHE_S_MAXAGE_SECONDS = 60 * 60 * 24 * 7;
const CACHE_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60 * 24 * 14;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 300;

const rateBuckets = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return (
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count);
  const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
  return {
    allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS,
    remaining,
    resetSeconds,
    limit: RATE_LIMIT_MAX_REQUESTS,
  };
}

function cleanupRateBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (now >= bucket.resetAt + RATE_LIMIT_WINDOW_MS) {
      rateBuckets.delete(ip);
    }
  }
}

/** ---------------------------
 *  OAuth helpers (verified against FatSecret docs)
 *  --------------------------- */
function oauthEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildParameterString(params) {
  const encoded = Object.entries(params)
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)])
    .sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1]);
      return a[0].localeCompare(b[0]);
    });

  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

function buildSignature(httpMethod, url, paramString, secret) {
  const baseString = `${httpMethod.toUpperCase()}&${oauthEncode(url)}&${oauthEncode(paramString)}`;
  const signingKey = `${oauthEncode(secret)}&`;

  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

async function callFatSecret(methodName, extraParams = {}) {
  const KEY = process.env.FATSECRET_CONSUMER_KEY;
  const SECRET = process.env.FATSECRET_CONSUMER_SECRET;

  if (!KEY || !SECRET) {
    throw new Error("Missing FATSECRET_CONSUMER_KEY or FATSECRET_CONSUMER_SECRET in Vercel Environment Variables");
  }

  const oauthParams = {
    oauth_consumer_key: KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };

  const allParams = {
    method: methodName,
    format: "json",
    ...extraParams,
    ...oauthParams,
  };

  const paramString = buildParameterString(allParams);
  const signature = buildSignature("GET", API_URL, paramString, SECRET);

  const finalUrl = `${API_URL}?${paramString}&oauth_signature=${oauthEncode(signature)}`;

  const response = await fetch(finalUrl, { method: "GET" });
  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FatSecret returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }

  return json;
}

/** ---------------------------
 *  Handler
 *  --------------------------- */
module.exports = async (req, res) => {
  cleanupRateBuckets();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "GET only" }));
  }

  // TEMPORARY DIAGNOSTIC - remove after debugging
  if (req.query && req.query.debug === "1") {
    const KEY = process.env.FATSECRET_CONSUMER_KEY || "";
    const SECRET = process.env.FATSECRET_CONSUMER_SECRET || "";
    
    // Show just enough to verify without exposing full credentials
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      diagnostic: true,
      key_length: KEY.length,
      key_first4: KEY.substring(0, 4),
      key_last4: KEY.substring(KEY.length - 4),
      key_has_whitespace: KEY !== KEY.trim(),
      key_has_newline: KEY.includes("\n") || KEY.includes("\r"),
      secret_length: SECRET.length,
      secret_first4: SECRET.substring(0, 4),
      secret_last4: SECRET.substring(SECRET.length - 4),
      secret_has_whitespace: SECRET !== SECRET.trim(),
      secret_has_newline: SECRET.includes("\n") || SECRET.includes("\r"),
      env_var_names: Object.keys(process.env).filter(k => k.includes("FATSECRET")),
    }));
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);

  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-Reset", String(rl.resetSeconds));

  if (!rl.allowed) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        error: "Too many requests",
        message: `Rate limit exceeded. Try again in ~${rl.resetSeconds}s.`,
      })
    );
  }

  const code = req.query && req.query.code;
  if (!code) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Missing ?code=" }));
  }

  try {
    res.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_S_MAXAGE_SECONDS}, stale-while-revalidate=${CACHE_STALE_WHILE_REVALIDATE_SECONDS}`
    );

    const barcodeResult = await callFatSecret("food.find_id_for_barcode", {
      barcode: code,
    });

    if (barcodeResult && barcodeResult.error) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          error: "Barcode not found",
          barcode: code,
          details: barcodeResult.error,
        })
      );
    }

    const foodId =
      (barcodeResult && barcodeResult.food_id && barcodeResult.food_id.value) ||
      (barcodeResult && barcodeResult.food_id);

    if (!foodId) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          error: "No food_id returned",
          barcode: code,
          raw: barcodeResult,
        })
      );
    }

    const foodResult = await callFatSecret("food.get.v4", {
      food_id: String(foodId),
    });

    if (foodResult && foodResult.error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          error: "Food fetch failed",
          details: foodResult.error,
        })
      );
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        success: true,
        barcode: code,
        food_name: foodResult && foodResult.food && foodResult.food.food_name,
        data: foodResult,
      })
    );
  } catch (err) {
    console.error("Server Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        error: "Server error",
        message: err && err.message ? err.message : String(err),
      })
    );
  }
};
