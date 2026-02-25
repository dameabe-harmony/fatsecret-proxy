/**
 * /api/kroger  — Kroger API Proxy (Vercel Serverless Function)
 *
 * Endpoints:
 *   /api/kroger?action=locations&lat=XX&lng=YY&radius=25
 *   /api/kroger?action=products&term=organic+milk&locationId=XXXXX&limit=10
 *   /api/kroger?action=health  (check credentials & token)
 *   /api/kroger?action=debug   (full diagnostic — DELETE BEFORE PRODUCTION)
 *
 * Env vars (Vercel Project Settings → Environment Variables):
 *   KROGER_CLIENT_ID
 *   KROGER_CLIENT_SECRET
 *
 * Kroger Public API Docs:
 *   - Auth: https://developer.kroger.com/api-products/api/authorization-endpoints-public
 *   - Locations: https://developer.kroger.com/api-products/api/location-api-public
 *   - Products: https://developer.kroger.com/api-products/api/product-api-public
 */

const KROGER_AUTH_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const KROGER_API_BASE = "https://api.kroger.com/v1";

// Token cache (in-memory, survives across warm invocations)
let cachedToken = null;
let tokenExpiresAt = 0;

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 200;
const rateBuckets = new Map();

// Response cache (in-memory, short-lived)
const responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Kroger-family banner mapping
const KROGER_BANNERS = {
  'KROGER': 'Kroger',
  'RALPHS': "Ralphs",
  'FRED MEYER': 'Fred Meyer',
  'HARRIS TEETER': 'Harris Teeter',
  "SMITH'S": "Smith's",
  'SMITHS': "Smith's",
  'KING SOOPERS': 'King Soopers',
  "FRY'S": "Fry's",
  'FRYS': "Fry's",
  'QFC': 'QFC',
  'PAY LESS': 'Pay Less',
  'PAY-LESS': 'Pay Less',
  "MARIANO'S": "Mariano's",
  'MARIANOS': "Mariano's",
  "PICK 'N SAVE": "Pick 'n Save",
  'PICK N SAVE': "Pick 'n Save",
  'METRO MARKET': 'Metro Market',
  "DILLON'S": "Dillon's",
  'DILLONS': "Dillon's",
  "BAKER'S": "Baker's",
  'BAKERS': "Baker's",
  'GERBES': 'Gerbes',
  'JAY C': 'Jay C',
  "OWEN'S": "Owen's",
  'OWENS': "Owen's",
  'CITY MARKET': 'City Market',
  'FOOD 4 LESS': 'Food 4 Less',
  'FOODS CO': 'Foods Co',
  'RULER': 'Ruler Foods',
  'COPPS': 'Copps',
  'ROUNDYS': "Roundy's",
};

/** ---------------------------
 *  Helpers
 *  --------------------------- */
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.headers["x-real-ip"] || req.connection?.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count);
  const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
  return { allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS, remaining, resetSeconds, limit: RATE_LIMIT_MAX_REQUESTS };
}

function cleanupCaches() {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (now >= bucket.resetAt + RATE_LIMIT_WINDOW_MS) rateBuckets.delete(ip);
  }
  for (const [key, entry] of responseCache.entries()) {
    if (now >= entry.expiresAt) responseCache.delete(key);
  }
}

function getCacheKey(action, params) {
  return `${action}:${JSON.stringify(params)}`;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  responseCache.delete(key);
  return null;
}

function setCache(key, data) {
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** ---------------------------
 *  Kroger OAuth2 Token
 *  --------------------------- */
async function getKrogerToken() {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing KROGER_CLIENT_ID or KROGER_CLIENT_SECRET in Vercel Environment Variables");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(KROGER_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Kroger auth failed (${response.status}): ${responseText.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Kroger auth returned non-JSON: ${responseText.slice(0, 300)}`);
  }

  if (!data.access_token) {
    throw new Error("Kroger auth response missing access_token");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 1800) * 1000;

  console.log(`Kroger token refreshed, expires in ${data.expires_in}s`);
  return cachedToken;
}

/** ---------------------------
 *  Kroger API Calls
 *  --------------------------- */
async function krogerFetch(endpoint, params = {}) {
  const token = await getKrogerToken();

  const queryString = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const url = `${KROGER_API_BASE}${endpoint}${queryString ? "?" + queryString : ""}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
    }
    throw new Error(`Kroger API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  return response.json();
}

/** ---------------------------
 *  Location Search
 *  --------------------------- */
async function searchLocations(lat, lng, radiusMiles, limit) {
  const cacheKey = getCacheKey("locations", { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100, radiusMiles });
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await krogerFetch("/locations", {
    "filter.lat.near": lat,
    "filter.lon.near": lng,
    "filter.radiusInMiles": radiusMiles,
    "filter.limit": limit,
  });

  const locations = (data.data || []).map((loc) => {
    const name = (loc.name || "").toUpperCase();
    const chain = (loc.chain || "").toUpperCase();

    let banner = "Kroger";
    for (const [key, displayName] of Object.entries(KROGER_BANNERS)) {
      if (name.includes(key) || chain.includes(key)) {
        banner = displayName;
        break;
      }
    }

    return {
      locationId: loc.locationId,
      name: loc.name,
      banner,
      chain: loc.chain,
      address: {
        line1: loc.address?.addressLine1,
        city: loc.address?.city,
        state: loc.address?.state,
        zipCode: loc.address?.zipCode,
      },
      geolocation: {
        lat: loc.geolocation?.latitude,
        lng: loc.geolocation?.longitude,
      },
      phone: loc.phone,
      departments: (loc.departments || []).map((d) => d.name),
    };
  });

  const result = {
    success: true,
    count: locations.length,
    locations,
    krogerNearby: locations.length > 0,
    nearestBanner: locations.length > 0 ? locations[0].banner : null,
    nearestLocationId: locations.length > 0 ? locations[0].locationId : null,
  };

  setCache(cacheKey, result);
  return result;
}

/** ---------------------------
 *  Product Search
 *  --------------------------- */
async function searchProducts(term, locationId, limit) {
  const cacheKey = getCacheKey("products", { term, locationId, limit });
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const params = {
    "filter.term": term,
    "filter.limit": limit,
  };

  if (locationId) {
    params["filter.locationId"] = locationId;
  }

  const data = await krogerFetch("/products", params);

  const products = (data.data || []).map((product) => {
    // Best image
    const images = product.images || [];
    let imageUrl = null;
    for (const img of images) {
      if (img.perspective === "front") {
        const sizes = img.sizes || [];
        const large = sizes.find((s) => s.size === "large") || sizes.find((s) => s.size === "medium") || sizes[0];
        if (large) imageUrl = large.url;
        break;
      }
    }
    if (!imageUrl && images.length > 0) {
      const sizes = images[0].sizes || [];
      const large = sizes.find((s) => s.size === "large") || sizes.find((s) => s.size === "medium") || sizes[0];
      if (large) imageUrl = large.url;
    }

    // Price info
    const items = product.items || [];
    let price = null;
    let promoPrice = null;
    let size = null;
    let soldBy = null;
    let fulfillment = {};

    if (items.length > 0) {
      const item = items[0];
      price = item.price?.regular;
      promoPrice = item.price?.promo > 0 ? item.price?.promo : null;
      size = item.size;
      soldBy = item.soldBy;
      fulfillment = item.fulfillment || {};
    }

    return {
      productId: product.productId,
      upc: product.upc,
      brand: product.brand,
      description: product.description,
      imageUrl,
      price,
      promoPrice,
      size,
      soldBy,
      inStock: fulfillment.inStore || false,
      fulfillment: {
        curbside: fulfillment.curbside || false,
        delivery: fulfillment.delivery || false,
        inStore: fulfillment.inStore || false,
        shipToHome: fulfillment.shipToHome || false,
      },
      categories: product.categories || [],
      temperature: product.temperature?.indicator,
    };
  });

  const result = {
    success: true,
    term,
    locationId: locationId || null,
    count: products.length,
    products,
  };

  setCache(cacheKey, result);
  return result;
}

/** ---------------------------
 *  Main Handler
 *  --------------------------- */
module.exports = async (req, res) => {
  cleanupCaches();

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "GET only" }));
  }

  // Rate limiting
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-Reset", String(rl.resetSeconds));

  if (!rl.allowed) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      error: "Too many requests",
      message: `Rate limit exceeded. Try again in ~${rl.resetSeconds}s.`,
    }));
  }

  const { action, lat, lng, radius, term, locationId, limit } = req.query || {};

  try {
    // ===========================================================
    // DEBUG ENDPOINT — DELETE BEFORE PRODUCTION
    // Full pipeline test: credentials → token → locations → products
    // ===========================================================
    if (action === "debug") {
      const clientId = process.env.KROGER_CLIENT_ID || "";
      const clientSecret = process.env.KROGER_CLIENT_SECRET || "";

      const diagnostics = {
        timestamp: new Date().toISOString(),
        step1_envCheck: {
          KROGER_CLIENT_ID: clientId
            ? `✓ present (${clientId.length} chars, starts: "${clientId.slice(0, 4)}", ends: "${clientId.slice(-4)}")`
            : "✗ MISSING",
          KROGER_CLIENT_SECRET: clientSecret
            ? `✓ present (${clientSecret.length} chars, starts: "${clientSecret.slice(0, 4)}", ends: "${clientSecret.slice(-4)}")`
            : "✗ MISSING",
        },
        tokenCacheState: {
          hasToken: !!cachedToken,
          tokenLength: cachedToken ? cachedToken.length : 0,
          expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
          expiresInSeconds: tokenExpiresAt ? Math.round((tokenExpiresAt - Date.now()) / 1000) : null,
          isExpired: tokenExpiresAt ? Date.now() >= tokenExpiresAt : true,
        },
        cacheState: {
          responseCacheEntries: responseCache.size,
          rateLimitBuckets: rateBuckets.size,
        },
      };

      // Step 2: Try to get a token
      try {
        // Force fresh token for debug
        cachedToken = null;
        tokenExpiresAt = 0;
        const token = await getKrogerToken();
        diagnostics.step2_tokenAuth = {
          success: true,
          tokenLength: token.length,
          tokenPreview: token.slice(0, 12) + "..." + token.slice(-12),
          expiresInSeconds: Math.round((tokenExpiresAt - Date.now()) / 1000),
        };
      } catch (err) {
        diagnostics.step2_tokenAuth = { success: false, error: err.message };
        // Can't proceed without a token
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(diagnostics, null, 2));
      }

      // Step 3: Location search (use provided coords or default to Atlanta)
      const testLat = parseFloat(lat) || 33.749;
      const testLng = parseFloat(lng) || -84.388;
      try {
        const locData = await searchLocations(testLat, testLng, 15, 5);
        diagnostics.step3_locationSearch = {
          success: true,
          searchedAt: `${testLat}, ${testLng}`,
          radiusMiles: 15,
          found: locData.count,
          krogerNearby: locData.krogerNearby,
          nearestBanner: locData.nearestBanner,
          nearestLocationId: locData.nearestLocationId,
          locations: locData.locations.map((l) => ({
            name: l.name,
            banner: l.banner,
            locationId: l.locationId,
            address: `${l.address.line1}, ${l.address.city}, ${l.address.state} ${l.address.zipCode}`,
            lat: l.geolocation.lat,
            lng: l.geolocation.lng,
          })),
        };

        // Step 4: Product search at nearest location
        if (locData.nearestLocationId) {
          const testTerm = term || "organic milk";
          try {
            const prodData = await searchProducts(testTerm, locData.nearestLocationId, 5);
            diagnostics.step4_productSearch = {
              success: true,
              searchTerm: testTerm,
              locationId: locData.nearestLocationId,
              locationBanner: locData.nearestBanner,
              found: prodData.count,
              products: prodData.products.map((p) => ({
                brand: p.brand,
                description: p.description,
                price: p.price ? `$${p.price.toFixed(2)}` : "no price",
                promoPrice: p.promoPrice ? `$${p.promoPrice.toFixed(2)}` : null,
                inStock: p.inStock,
                size: p.size,
                upc: p.upc,
                fulfillment: p.fulfillment,
                hasImage: !!p.imageUrl,
              })),
            };
          } catch (err) {
            diagnostics.step4_productSearch = { success: false, error: err.message };
          }
        } else {
          diagnostics.step4_productSearch = { skipped: true, reason: "No Kroger locations found nearby" };
        }
      } catch (err) {
        diagnostics.step3_locationSearch = { success: false, error: err.message };
      }

      diagnostics.summary = {
        allStepsPassed: !!(
          diagnostics.step2_tokenAuth?.success &&
          diagnostics.step3_locationSearch?.success &&
          diagnostics.step4_productSearch?.success
        ),
        readyForIntegration: !!(
          diagnostics.step2_tokenAuth?.success &&
          diagnostics.step3_locationSearch?.success
        ),
      };

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(diagnostics, null, 2));
    }

    // ===========================================================
    // HEALTH CHECK
    // ===========================================================
    if (action === "health") {
      const token = await getKrogerToken();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        status: "ok",
        hasToken: !!token,
        tokenLength: token ? token.length : 0,
        expiresInSeconds: Math.round((tokenExpiresAt - Date.now()) / 1000),
        message: "Kroger proxy is operational",
      }));
    }

    // ===========================================================
    // LOCATION SEARCH
    // ===========================================================
    if (action === "locations") {
      if (!lat || !lng) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Missing ?lat= and ?lng= parameters" }));
      }

      const result = await searchLocations(
        parseFloat(lat),
        parseFloat(lng),
        parseInt(radius) || 25,
        parseInt(limit) || 10
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
      return res.end(JSON.stringify(result));
    }

    // ===========================================================
    // PRODUCT SEARCH
    // ===========================================================
    if (action === "products") {
      if (!term) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Missing ?term= parameter" }));
      }

      const result = await searchProducts(
        term,
        locationId || null,
        parseInt(limit) || 10
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
      return res.end(JSON.stringify(result));
    }

    // ===========================================================
    // UNKNOWN ACTION — show help
    // ===========================================================
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      error: "Missing or invalid ?action= parameter",
      validActions: ["health", "locations", "products", "debug"],
      examples: [
        "/api/kroger?action=health",
        "/api/kroger?action=debug",
        "/api/kroger?action=debug&lat=33.749&lng=-84.388&term=organic+eggs",
        "/api/kroger?action=locations&lat=33.749&lng=-84.388&radius=15",
        "/api/kroger?action=products&term=organic+milk&locationId=01400376&limit=5",
      ],
    }));

  } catch (err) {
    console.error("Kroger Proxy Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      error: "Server error",
      message: err && err.message ? err.message : String(err),
    }));
  }
};
