/**
 * FatSecret Barcode Lookup - Using EXACT working pattern from Nathan M (Google Groups)
 * Source: https://groups.google.com/g/fatsecret-platform-api/c/1dYqsEaZPqE
 */

const crypto = require('crypto');

// SECURITY: Load credentials from environment variables (set in Vercel dashboard)
const KEY = process.env.FATSECRET_CONSUMER_KEY;
const SECRET = process.env.FATSECRET_CONSUMER_SECRET;
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

// Validate that credentials are set
if (!KEY || !SECRET) {
    throw new Error('CRITICAL: FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET environment variables must be set in Vercel dashboard');
}

function buildRequestParameterString(inputParameters) {
    let params = '';
    Object.entries(inputParameters)
        .sort()
        .forEach((cur) => (params += `&${encodeURIComponent(cur[0])}=${encodeURIComponent(cur[1])}`));
    params = params.substring(1); // Remove leading &
    return params;
}

function buildSignature(httpMethod, url, paramString) {
    const method = encodeURIComponent(httpMethod);
    const encodedUrl = encodeURIComponent(url);
    const params = encodeURIComponent(paramString);
    
    // CRITICAL: Note the & after SECRET
    const signature = crypto
        .createHmac('sha1', `${SECRET}&`)
        .update(`${method}&${encodedUrl}&${params}`)
        .digest()
        .toString('base64');
    
    return encodeURIComponent(signature);
}

async function callFatSecret(methodName, extraParams = {}) {
    const inputParameters = {
        ...extraParams,
        method: methodName,
        format: 'json',
        oauth_consumer_key: KEY,
        oauth_nonce: Math.random().toString(36).substring(2, 15),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0'
    };
    
    const paramString = buildRequestParameterString(inputParameters);
    const signature = buildSignature('POST', API_URL, paramString);
    
    console.log('Calling FatSecret:', methodName);
    
    const response = await fetch(`${API_URL}?${paramString}&oauth_signature=${signature}`, {
        method: 'POST'
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
        
        // Step 1: Get food_id
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
        
        // Step 2: Get full data
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
