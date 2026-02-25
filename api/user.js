/**
 * /api/user — User Profile & Data Management
 *
 * GET  /api/user?action=profile          (requires auth header)
 * POST /api/user?action=scan             Body: { barcode, productName, brand, imageUrl, isOrganic, isNonGMO, category }
 * GET  /api/user?action=history&page=1   (pro only)
 * POST /api/user?action=favorite         Body: { barcode, productName, brand, imageUrl, category, notes }
 * DELETE /api/user?action=favorite&barcode=XXX
 * GET  /api/user?action=favorites
 *
 * Env vars (Vercel):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/** Verify JWT and extract user ID */
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '');

  // Verify token with Supabase
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) return null;

  const user = await response.json();
  return user?.id ? user : null;
}

/** Supabase REST helper */
async function supabaseQuery(endpoint, options = {}) {
  const { method = 'GET', body, headers: extraHeaders = {} } = options;

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, fetchOptions);
  
  if (method === 'DELETE' || (response.status === 204)) {
    return { success: true };
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

/** Call a Supabase RPC function */
async function supabaseRpc(fnName, params) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

/** ---------------------------
 *  Main Handler
 *  --------------------------- */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Authenticate
  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const action = req.query?.action;

  try {
    // ===========================================================
    // GET PROFILE
    // ===========================================================
    if (action === 'profile' && req.method === 'GET') {
      const profile = await supabaseRpc('get_user_profile', { p_user_id: user.id });

      if (profile?.error) {
        return res.status(404).json({ error: profile.error });
      }

      return res.status(200).json({ success: true, profile });
    }

    // ===========================================================
    // RECORD SCAN (increment counter + save history for pro)
    // ===========================================================
    if (action === 'scan' && req.method === 'POST') {
      const { barcode, productName, brand, imageUrl, isOrganic, isNonGMO, category } = req.body || {};

      if (!barcode) {
        return res.status(400).json({ error: 'Missing barcode' });
      }

      // Check/increment scan counter
      const scanResult = await supabaseRpc('increment_scan_count', { p_user_id: user.id });

      if (!scanResult?.allowed) {
        return res.status(429).json({
          error: 'Scan limit reached',
          ...scanResult,
        });
      }

      // Save to history (for all users — pro users can VIEW it, free users just track count)
      if (productName) {
        await supabaseQuery('scan_history', {
          method: 'POST',
          body: {
            user_id: user.id,
            barcode,
            product_name: productName,
            brand: brand || null,
            image_url: imageUrl || null,
            is_organic: isOrganic || false,
            is_non_gmo: isNonGMO || false,
            category: category || null,
          },
          headers: { 'Prefer': 'return=minimal' },
        });
      }

      return res.status(200).json({
        success: true,
        ...scanResult,
      });
    }

    // ===========================================================
    // GET SCAN HISTORY (pro only)
    // ===========================================================
    if (action === 'history' && req.method === 'GET') {
      // Check tier
      const profile = await supabaseRpc('get_user_profile', { p_user_id: user.id });
      if (profile?.tier !== 'pro') {
        return res.status(403).json({
          error: 'Pro subscription required',
          message: 'Scan history is a Pro feature. Upgrade to access your scan history.',
        });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = 20;
      const offset = (page - 1) * limit;

      const history = await supabaseQuery(
        `scan_history?user_id=eq.${user.id}&order=scanned_at.desc&limit=${limit}&offset=${offset}`,
        { headers: { 'Prefer': 'count=exact' } }
      );

      return res.status(200).json({
        success: true,
        page,
        limit,
        scans: Array.isArray(history) ? history : [],
      });
    }

    // ===========================================================
    // ADD FAVORITE (pro only)
    // ===========================================================
    if (action === 'favorite' && req.method === 'POST') {
      const profile = await supabaseRpc('get_user_profile', { p_user_id: user.id });
      if (profile?.tier !== 'pro') {
        return res.status(403).json({
          error: 'Pro subscription required',
          message: 'Favorites is a Pro feature.',
        });
      }

      const { barcode, productName, brand, imageUrl, category, notes } = req.body || {};

      if (!barcode || !productName) {
        return res.status(400).json({ error: 'Missing barcode or productName' });
      }

      await supabaseQuery('favorites', {
        method: 'POST',
        body: {
          user_id: user.id,
          barcode,
          product_name: productName,
          brand: brand || null,
          image_url: imageUrl || null,
          category: category || null,
          notes: notes || null,
        },
        headers: { 'Prefer': 'return=minimal, resolution=merge-duplicates' },
      });

      return res.status(200).json({ success: true, message: 'Added to favorites' });
    }

    // ===========================================================
    // DELETE FAVORITE
    // ===========================================================
    if (action === 'favorite' && req.method === 'DELETE') {
      const barcode = req.query.barcode;
      if (!barcode) {
        return res.status(400).json({ error: 'Missing ?barcode= parameter' });
      }

      await supabaseQuery(
        `favorites?user_id=eq.${user.id}&barcode=eq.${barcode}`,
        { method: 'DELETE' }
      );

      return res.status(200).json({ success: true, message: 'Removed from favorites' });
    }

    // ===========================================================
    // GET ALL FAVORITES (pro only)
    // ===========================================================
    if (action === 'favorites' && req.method === 'GET') {
      const profile = await supabaseRpc('get_user_profile', { p_user_id: user.id });
      if (profile?.tier !== 'pro') {
        return res.status(403).json({
          error: 'Pro subscription required',
          message: 'Favorites is a Pro feature.',
        });
      }

      const favorites = await supabaseQuery(
        `favorites?user_id=eq.${user.id}&order=created_at.desc`
      );

      return res.status(200).json({
        success: true,
        count: Array.isArray(favorites) ? favorites.length : 0,
        favorites: Array.isArray(favorites) ? favorites : [],
      });
    }

    // ===========================================================
    // UNKNOWN ACTION
    // ===========================================================
    return res.status(400).json({
      error: 'Invalid action',
      validActions: ['profile', 'scan', 'history', 'favorite', 'favorites'],
    });

  } catch (err) {
    console.error('User API error:', err);
    return res.status(500).json({
      error: 'Server error',
      message: err.message,
    });
  }
};
