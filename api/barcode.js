/**
 * FatSecret Barcode Lookup Serverless Function
 * Corrected OAuth 1.0 implementation using POST with body params
 */

const crypto = require('crypto');

const API_BASE_URL = 'https://platform.fatsecret.com/rest/server.api';
const CONSUMER_KEY = process.env.FATSECRET_CONSUMER_KEY || '87accb3608ca43c595b2868e06a26080';
const CONSUMER_SECRET = process.env.FATSECRET_CONSUMER_SECRET || 'fdd9a0e31d1d49599d5300d49b7bdd22';

function generateOAuthSignature(method, url, params, secret) {
    const sortedParams = Object.keys(params)
        .sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');

    const base = [
        method.toUpperCase(),
        encodeURIComponent(url),
        encodeURIComponent(sortedParams)
    ].join('&');

    const signingKey = `${encodeURIComponent(secret)}&`;
    return crypto.createHmac('sha1', signingKey).update(base).digest('base64');
}

function buildSignedParams(params) {
    const oauthParams = {
        ...params,
        format: 'json',
        oauth_consumer_key: CONSUMER_KEY,
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_nonce: crypto.randomBytes(8).toString('hex'),
        oauth_version: '1.0'
    };

    const signature = generateOAuthSignature('POST', API_BASE_URL, oauthParams, CONSUMER_SECRET);
    oauthParams.oauth_signature = signature;
    return oauthParams;
}

async function fatSecretPost(params) {
    const signed = buildSignedParams(params);
    const body = new URLSearchParams(signed).toString();

    console.log('Calling FatSecret method:', params.method);

    const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
    });

    const text = await response.text();
    console.log('FatSecret raw response:', text.substring(0, 500));

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Invalid response from FatSecret: ' + text.substring(0, 200));
    }
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing ?code= parameter' });

    try {
        // Step 1: Look up food_id from barcode
        console.log(`Looking up barcode: ${code}`);
        const barcodeData = await fatSecretPost({
            method: 'food.find_id_for_barcode',
            barcode: code
        });

        console.log('Barcode lookup result:', JSON.stringify(barcodeData));

        const foodId = barcodeData?.food_id?.value
            || barcodeData?.food_id
            || null;

        if (!foodId) {
            return res.status(404).json({
                error: 'Product not found',
                barcode: code,
                message: 'Barcode not in FatSecret database',
                raw_response: barcodeData
            });
        }

        console.log(`Found food_id: ${foodId}`);

        // Step 2: Get full nutrition data
        const foodData = await fatSecretPost({
            method: 'food.get.v4',
            food_id: foodId.toString()
        });

        console.log(`Fetched food: ${foodData?.food?.food_name}`);

        return res.status(200).json({
            success: true,
            barcode: code,
            food_id: foodId,
            data: foodData
        });

    } catch (error) {
        console.error('Handler error:', error.message);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
}
