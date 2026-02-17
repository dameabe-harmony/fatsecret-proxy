/**
 * FatSecret Barcode Lookup Serverless Function
 * 
 * This function proxies barcode lookups to FatSecret API to avoid CORS issues.
 * 
 * Usage: GET /api/barcode?code=0029000076501
 * Returns: Product nutrition data in JSON format
 */

const crypto = require('crypto');

// FatSecret API configuration
const API_BASE_URL = 'https://platform.fatsecret.com/rest/server.api';

/**
 * Generate OAuth 1.0 signature for FatSecret API
 */
function generateOAuthSignature(method, url, params, consumerSecret) {
    // Sort parameters alphabetically
    const sortedParams = Object.keys(params)
        .sort()
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        .join('&');
    
    // Create signature base string
    const signatureBaseString = [
        method.toUpperCase(),
        encodeURIComponent(url),
        encodeURIComponent(sortedParams)
    ].join('&');
    
    // Generate HMAC-SHA1 signature
    const signingKey = `${encodeURIComponent(consumerSecret)}&`; // Note: OAuth 1.0 token secret is empty for 2-legged auth
    const signature = crypto
        .createHmac('sha1', signingKey)
        .update(signatureBaseString)
        .digest('base64');
    
    return signature;
}

/**
 * Main serverless function handler
 */
export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Only allow GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // Get barcode from query parameters
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).json({ 
            error: 'Missing barcode parameter',
            usage: 'GET /api/barcode?code=BARCODE_NUMBER'
        });
    }
    
    // Credentials from environment variables
    const consumerKey = process.env.FATSECRET_CONSUMER_KEY || '87accb3608ca43c595b2868e06a26080';
    const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET || 'fdd9a0e31d1d49599d5300d49b7bdd22';
    
    
    try {
        // Step 1: Get food_id from barcode
        const barcodeParams = {
            method: 'food.find_id_for_barcode',
            barcode: code,
            format: 'json',
            oauth_consumer_key: consumerKey,
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
            oauth_nonce: Math.random().toString(36).substring(2),
            oauth_version: '1.0'
        };
        
        // Generate OAuth signature for barcode lookup
        const barcodeSignature = generateOAuthSignature('POST', API_BASE_URL, barcodeParams, consumerSecret);
        barcodeParams.oauth_signature = barcodeSignature;
        
        // Make request to FatSecret API (barcode lookup)
        const barcodeUrl = new URL(API_BASE_URL);
        Object.keys(barcodeParams).forEach(key => {
            barcodeUrl.searchParams.append(key, barcodeParams[key]);
        });
        
        console.log(`Looking up barcode: ${code}`);
        const barcodeResponse = await fetch(barcodeUrl.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!barcodeResponse.ok) {
            const errorText = await barcodeResponse.text();
            console.error('FatSecret barcode lookup error:', errorText);
            return res.status(404).json({ 
                error: 'Product not found',
                barcode: code,
                message: 'This barcode is not in the FatSecret database'
            });
        }
        
        const barcodeData = await barcodeResponse.json();
        
        // Extract food_id from response
        const foodId = barcodeData.food_id?.value || barcodeData.food_id;
        
        if (!foodId) {
            console.log('No food_id found for barcode:', code);
            return res.status(404).json({ 
                error: 'Product not found',
                barcode: code,
                message: 'This barcode is not in the FatSecret database'
            });
        }
        
        console.log(`Found food_id: ${foodId}`);
        
        // Step 2: Get full nutrition data using food_id
        const foodParams = {
            method: 'food.get.v4',
            food_id: foodId.toString(),
            format: 'json',
            oauth_consumer_key: consumerKey,
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
            oauth_nonce: Math.random().toString(36).substring(2),
            oauth_version: '1.0'
        };
        
        // Generate OAuth signature for food data
        const foodSignature = generateOAuthSignature('POST', API_BASE_URL, foodParams, consumerSecret);
        foodParams.oauth_signature = foodSignature;
        
        // Make request to FatSecret API (food data)
        const foodUrl = new URL(API_BASE_URL);
        Object.keys(foodParams).forEach(key => {
            foodUrl.searchParams.append(key, foodParams[key]);
        });
        
        const foodResponse = await fetch(foodUrl.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!foodResponse.ok) {
            const errorText = await foodResponse.text();
            console.error('FatSecret food data error:', errorText);
            return res.status(500).json({ 
                error: 'Failed to fetch nutrition data',
                food_id: foodId
            });
        }
        
        const foodData = await foodResponse.json();
        
        console.log(`Successfully fetched data for: ${foodData.food?.food_name || 'Unknown'}`);
        
        // Return the nutrition data
        return res.status(200).json({
            success: true,
            barcode: code,
            data: foodData
        });
        
    } catch (error) {
        console.error('Serverless function error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
        });
    }
}
