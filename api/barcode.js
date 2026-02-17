/**
 * Vercel Serverless Function: /api/barcode
 * Usage:
 *   https://YOUR-DOMAIN.vercel.app/api/barcode?code=0123456789012
 *
 * Required Environment Variables in Vercel:
 *   FATSECRET_KEY
 *   FATSECRET_SECRET
 */

const crypto = require("crypto");

const API_URL = "https://platform.fatsecret.com/rest/server.api";

function oauthEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
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
  const baseString =
    `${httpMethod.toUpperCase()}&${oauthEncode(url)}&${oauthEncode(paramString)}`;

  const signingKey = `${oauthEncode(secret)}&`;

  return crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

async function callFatSecret(methodName, extraParams = {}) {
  const KEY = process.env.FATSECRET_KEY;
  const SECRET = process.env.FATSECRET_SECRET;

  if (!KEY || !SECRET) {
    throw new Error("Missing FATSECRET_KEY or FATSECRET_SECRET in Vercel Environment Variables");
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

  const finalUrl =
    `${API_URL}?${paramString}&oauth_signature=${oauthEncode(signature)}`;

  const response = await fetch(finalUrl, { method: "GET" });
  const text = await response.text();

  // FatSecret often returns JSON even on errors; but sometimes it returns plain text.
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`FatSecret returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }

  return json;
}

module.exports = async (req, res) => {
  // Basic CORS (optional)
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

  const code = req.query && req.query.code;

  if (!code) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Missing ?code=" }));
  }

  try {
    // Step 1: find food_id for barcode
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

    // Step 2: fetch full food record
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
