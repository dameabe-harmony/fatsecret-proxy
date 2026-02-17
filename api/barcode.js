const crypto = require('crypto');

const KEY = '87accb3608ca43c595b2868e06a26080';
const SECRET = 'fdd9a0e31d1d49599d5300d49b7bdd22';
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

function makeOAuthSignature(method, url, params, secret) {
    // Sort parameters alphabetically and build query string
    const sorted = Object.keys(params).sort().map(k => 
        encodeURIComponent(k) + '=' + encodeURIComponent(params[k])
    ).join('&');
    
    // Build signature base string - METHOD&URL&PARAMS
    const base = method + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(sorted);
    
    // Sign with HMAC-SHA1 using secret& (note the ampersand)
    const signingKey = encodeURIComponent(secret) + '&';
    const hmac = crypto.createHmac('sha1', signingKey);
    hmac.update(base);
    
    return hmac.digest('base64');
}

async function callFatSecret(methodName, extraParams = {}) {
    const params = {
        method: methodName,
        format: 'json',
        oauth_consumer_key: KEY,
        oauth_nonce: Math.random().toString(36).substring(2, 15),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0',
        ...extraParams
    };
    
    // Generate signature
    const signature = makeOAuthSignature('POST', API_URL, params, SECRET);
    params.oauth_signature = signature;
    
    // Build POST body as form-urlencoded
    const body = Object.keys(params).map(k => 
        encodeURIComponent(k) + '=' + encodeURIComponent(params[k])
    ).join('&');
    
    console.log('Calling FatSecret:', methodName);
    
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
    });
    
    const text = await response.text();
    console.log('Response status:', response.status);
    console.log('Response text:', text.substring(0, 500));
    
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Invalid JSON: ' + text);
    }
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing ?code=' });
    
    try {
        console.log('=== Barcode lookup:', code);
        
        // Step 1: barcode -> food_id
        const barcodeResult = await callFatSecret('food.find_id_for_barcode', { barcode: code });
        
        if (barcodeResult.error) {
            console.error('Barcode error:', barcodeResult.error);
            return res.status(404).json({
                error: 'Barcode lookup failed',
                barcode: code,
                details: barcodeResult.error
            });
        }
        
        const foodId = barcodeResult?.food_id?.value || barcodeResult?.food_id;
        
        if (!foodId) {
            return res.status(404).json({
                error: 'No food_id found',
                barcode: code,
                raw: barcodeResult
            });
        }
        
        console.log('Found food_id:', foodId);
        
        // Step 2: food_id -> full data
        const foodResult = await callFatSecret('food.get.v4', { food_id: foodId.toString() });
        
        if (foodResult.error) {
            return res.status(500).json({
                error: 'Food fetch failed',
                details: foodResult.error
            });
        }
        
        console.log('Success! Food:', foodResult?.food?.food_name);
        
        return res.json({
            success: true,
            barcode: code,
            data: foodResult
        });
        
    } catch (err) {
        console.error('Handler error:', err);
        return res.status(500).json({
            error: 'Server error',
            message: err.message
        });
    }
}
