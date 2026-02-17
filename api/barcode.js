/**
 * FatSecret Barcode Lookup - Fixed OAuth signature
 */

const crypto = require('crypto');

const API_URL = 'https://platform.fatsecret.com/rest/server.api';
const KEY = process.env.FATSECRET_CONSUMER_KEY || '87accb3608ca43c595b2868e06a26080';
const SECRET = process.env.FATSECRET_CONSUMER_SECRET || 'fdd9a0e31d1d49599d5300d49b7bdd22';

function makeSignature(method, url, params, secret) {
    // Sort params alphabetically
    const sorted = Object.keys(params).sort().map(k => {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');

    // Build signature base string
    const base = method + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(sorted);
    
    // HMAC-SHA1 with secret& (note the ampersand)
    const key = encodeURIComponent(secret) + '&';
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(base);
    
    return hmac.digest('base64');
}

async function callFatSecret(methodName, extraParams = {}) {
    const params = {
        method: methodName,
        format: 'json',
        oauth_consumer_key: KEY,
        oauth_nonce: Math.random().toString(36).substr(2),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0',
        ...extraParams
    };

    // Generate signature
    const signature = makeSignature('POST', API_URL, params, SECRET);
    params.oauth_signature = signature;

    // Build request body
    const body = Object.keys(params).map(k => 
        encodeURIComponent(k) + '=' + encodeURIComponent(params[k])
    ).join('&');

    console.log('Calling:', methodName);

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
    });

    const text = await response.text();
    
    try {
        const json = JSON.parse(text);
        if (json.error) {
            console.error('FatSecret error:', json.error);
        }
        return json;
    } catch (e) {
        console.error('Parse error:', text);
        throw new Error('Bad response: ' + text.substring(0, 100));
    }
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing ?code=' });

    try {
        console.log('Barcode lookup:', code);
        
        // Step 1: barcode → food_id
        const lookup = await callFatSecret('food.find_id_for_barcode', { barcode: code });
        
        const foodId = lookup?.food_id?.value || lookup?.food_id;
        
        if (!foodId || lookup.error) {
            return res.status(404).json({
                error: 'Not found',
                barcode: code,
                details: lookup
            });
        }

        console.log('Found food_id:', foodId);

        // Step 2: food_id → full data
        const food = await callFatSecret('food.get.v4', { food_id: foodId.toString() });

        if (food.error) {
            return res.status(500).json({ error: 'Food fetch failed', details: food });
        }

        return res.json({
            success: true,
            barcode: code,
            data: food
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
