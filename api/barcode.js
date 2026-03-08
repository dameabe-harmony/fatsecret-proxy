/**
 * /api/barcode?code=XXXXXXXXXXXX
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

/* OAuth helpers */

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

  const response = await fetch(finalUrl);
  const text = await response.text();

  return JSON.parse(text);
}

/* Handler */

module.exports = async (req, res) => {

  cleanupRateBuckets();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end();
  }

  const code = req.query && req.query.code;

  if (!code) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Missing ?code=" }));
  }

  try {

    const barcodeResult = await callFatSecret("food.find_id_for_barcode", {
      barcode: code,
      region: "US"
    });

    const foodId =
      barcodeResult?.food_id?.value ||
      barcodeResult?.food_id;

    /* FIX: stop if FatSecret returns 0 */

    if (!foodId || foodId === 0 || foodId === "0") {

      res.statusCode = 404;

      return res.end(
        JSON.stringify({
          error: "Barcode not found",
          barcode: code,
          details: barcodeResult
        })
      );

    }

    const foodResult = await callFatSecret("food.get", {
      food_id: String(foodId)
    });

    res.statusCode = 200;

    return res.end(
      JSON.stringify({
        success: true,
        barcode: code,
        food_name: foodResult?.food?.food_name,
        data: foodResult
      })
    );

  } catch (err) {

    res.statusCode = 500;

    return res.end(
      JSON.stringify({
        error: "Server error",
        message: err.message
      })
    );

  }

};
