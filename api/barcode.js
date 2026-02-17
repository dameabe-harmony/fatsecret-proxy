/**
 * FatSecret Barcode Lookup - Using oauth-1.0a library
 */

const OAuth = require('oauth-1.0a');
const crypto = require('crypto');

const KEY = process.env.FATSECRET_CONSUMER_KEY || '87accb3608ca43c595b2868e06a26080';
const SECRET = process.env.FATSECRET_CONSUMER_SECRET || 'fdd9a0e31d1d49599d5300d49b7bdd22';

const oauth = OAuth({
    consumer: { key: KEY, secret: SECRET },
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
    }
});

async function callFatSecret(method, params = {}) {
    const url = 'https://platform.fatsecret.com/rest/server.api';
    
    const requestData = {
        url: url,
        method: 'POST',
        data: { method, format: 'json', ...params }
    };

    const authHeader = oauth.toHeader(oauth.authorize(requestData));
    
    const body = new URLSearchParams(requestData.data).toString();

    console.log('Calling FatSecret:', method);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            ...authHeader,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
    });

    const text = await response.text();
    console.log('Response:', text.substring(0, 300));

    return JSON.parse(text);
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing ?code=' });

    try {
        console.log('Looking up barcode:', code);
        
        const lookup = await callFatSecret('food.find_id_for_barcode', { barcode: code });
        
        if (lookup.error) {
            return res.status(404).json({ error: 'Not found', barcode: code, details: lookup });
        }

        const foodId = lookup?.food_id?.value || lookup?.food_id;
        if (!foodId) {
            return res.status(404).json({ error: 'No food_id', barcode: code, raw: lookup });
        }

        console.log('Found food_id:', foodId);

        const food = await callFatSecret('food.get.v4', { food_id: foodId.toString() });

        if (food.error) {
            return res.status(500).json({ error: 'Failed to fetch food', details: food });
        }

        return res.json({ success: true, barcode: code, data: food });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
