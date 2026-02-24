/**
 * FatSecret Barcode Lookup - OAuth 1.0a (correct implementation)
 */

const crypto = require('crypto');

const CONSUMER_KEY = process.env.FATSECRET_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.FATSECRET_CONSUMER_SECRET;
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error('CRITICAL: FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET environment variables must be set in Vercel dashboard');
}

/**
 * RFC 3986 percent-encoding (required by OAuth 1.0a)
 * encodeURIComponent doesn't encode !'()* so we fix those manually
 */
function percentEncode(str) {
    return encodeURIComponent(str)
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\*/g, '%2A');
}

function generateNonce() {
    return crypto.randomBytes(16).toString('hex');
}

function buildSignature(method, url, params) {
    // Sort params alphabetically and encode
    const paramString = Object.keys(params)
        .sort()
        .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join('&');

    // Build signature base string
    const baseString = [
        method.toUpperCase(),
        percentEncode(url),
        percentEncode(paramString)
    ].join('&');

    // Sign with HMAC-SHA1 (key is consumer_secret&token_secret, token_secret is empty)
    const signingKey = `${percentEncode(CONSUMER_SECRET)}&`;

    const signature = crypto
        .createHmac('sha1', signingKey)
        .update(baseString)
        .digest('base64');

    return signature;
}

async function callFatSecret(methodName, extraParams = {}) {
    const params = {
        ...extraParams,
        method: methodName,
        format: 'json',
        oauth_consumer_key: CONSUMER_KEY,
        oauth_nonce: generateNonce(),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0'
    };

    // Generate signature
    const signature = buildSignature('POST', API_URL, params);

    // Add signature to params
    params.oauth_signature = signature;

    // Build POST body
    const body = Object.keys(params)
        .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join('&');

    console.log('Calling FatSecret:', methodName);

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
    });

    const text = await response.text();
    console.log('Status:', response.status);
    console.log('Response:', text.substring(0, 500));

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Invalid JSON: ' + text);
    }
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing ?code=' });

    try {
        console.log('=== Barcode:', code);

        // Step 1: Get food_id from barcode
        const barcodeResult = await callFatSecret('food.find_id_for_barcode', { barcode: code });

        if (barcodeResult.error) {
            return res.status(404).json({
                error: 'Barcode not found',
                barcode: code,
                details: barcodeResult.error
            });
        }

        const foodId = barcodeResult?.food_id?.value || barcodeResult?.food_id;

        if (!foodId) {
            return res.status(404).json({
                error: 'No food_id',
                barcode: code,
                raw: barcodeResult
            });
        }

        console.log('Food ID:', foodId);

        // Step 2: Get full nutrition data
        const foodResult = await callFatSecret('food.get.v4', { food_id: foodId.toString() });

        if (foodResult.error) {
            return res.status(500).json({
                error: 'Food fetch failed',
                details: foodResult.error
            });
        }

        console.log('Success:', foodResult?.food?.food_name);

        return res.json({
            success: true,
            barcode: code,
            data: foodResult
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            error: 'Server error',
            message: err.message
        });
    }
}
