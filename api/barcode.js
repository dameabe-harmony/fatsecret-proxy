/**
 * FatSecret Barcode Lookup - OAuth 2.0
 */

const API_URL = 'https://platform.fatsecret.com/rest/server.api';
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';

const CLIENT_ID = process.env.FATSECRET_CONSUMER_KEY;
const CLIENT_SECRET = process.env.FATSECRET_CONSUMER_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CRITICAL: FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET environment variables must be set in Vercel dashboard');
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    // Return cached token if still valid (with 60s buffer)
    if (cachedToken && Date.now() < tokenExpiry - 60000) {
        return cachedToken;
    }

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials&scope=basic'
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token request failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    return cachedToken;
}

async function callFatSecret(methodName, params = {}) {
    const token = await getAccessToken();

    const queryParams = new URLSearchParams({
        method: methodName,
        format: 'json',
        ...params
    });

    const response = await fetch(`${API_URL}?${queryParams.toString()}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    const text = await response.text();
    console.log('FatSecret', methodName, 'status:', response.status);

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
