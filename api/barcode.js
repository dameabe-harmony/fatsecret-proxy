import crypto from 'crypto';
import fetch from 'node-fetch'; // remove if using Node 18+ with global fetch

const KEY = process.env.FATSECRET_KEY;
const SECRET = process.env.FATSECRET_SECRET;
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

/**
 * RFC 3986 OAuth encoding (CRITICAL)
 */
function oauthEncode(str) {
    return encodeURIComponent(str)
        .replace(/[!*'()]/g, c =>
            '%' + c.charCodeAt(0).toString(16).toUpperCase()
        );
}

/**
 * Build normalized parameter string
 */
function buildParameterString(params) {
    const encoded = Object.entries(params)
        .map(([k, v]) => [oauthEncode(k), oauthEncode(v)])
        .sort((a, b) => {
            if (a[0] === b[0]) return a[1].localeCompare(b[1]);
            return a[0].localeCompare(b[0]);
        });

    return encoded.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Build OAuth signature
 */
function buildSignature(method, url, paramString) {
    const baseString =
        `${method.toUpperCase()}&${oauthEncode(url)}&${oauthEncode(paramString)}`;

    const signingKey = `${oauthEncode(SECRET)}&`;

    return crypto
        .createHmac('sha1', signingKey)
        .update(baseString)
        .digest('base64');
}

/**
 * Generic FatSecret API caller
 */
async function callFatSecret(methodName, extraParams = {}) {
    const oauthParams = {
        oauth_consumer_key: KEY,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0'
    };

    const allParams = {
        method: methodName,
        format: 'json',
        ...extraParams,
        ...oauthParams
    };

    const paramString = buildParameterString(allParams);
    const signature = buildSignature('GET', API_URL, paramString);

    const finalUrl =
        `${API_URL}?${paramString}&oauth_signature=${oauthEncode(signature)}`;

    const response = await fetch(finalUrl, { method: 'GET' });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`FatSecret error: ${text}`);
    }

    return JSON.parse(text);
}

/**
 * Next.js API Route Handler
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'GET only' });

    const { code } = req.query;
    if (!code)
        return res.status(400).json({ error: 'Missing ?code=' });

    try {
        // STEP 1 — Find food_id by barcode
        const barcodeResult = await callFatSecret(
            'food.find_id_for_barcode',
            { barcode: code }
        );

        if (!barcodeResult?.food_id) {
            return res.status(404).json({
                error: 'Barcode not found',
                barcode: code,
                raw: barcodeResult
            });
        }

        const foodId =
            barcodeResult.food_id.value || barcodeResult.food_id;

        // STEP 2 — Fetch full food details
        const foodResult = await callFatSecret(
            'food.get.v4',
            { food_id: foodId.toString() }
        );

        return res.json({
            success: true,
            barcode: code,
            food_name: foodResult?.food?.food_name,
            data: foodResult
        });

    } catch (err) {
        return res.status(500).json({
            error: 'Server error',
            message: err.message
        });
    }
}
