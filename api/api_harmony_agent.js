/**
 * Harmony Agent — Universal API Endpoint
 * v8.4 — Drop into fatsecret-proxy/api/harmony-agent.js on Vercel
 *
 * 10 endpoints, all Pro-gated with Bearer auth:
 *   /api/harmony-agent?action=analyze
 *   /api/harmony-agent?action=family-check
 *   /api/harmony-agent?action=batch-check
 *   /api/harmony-agent?action=family-profiles
 *   /api/harmony-agent?action=preferences
 *   /api/harmony-agent?action=device-register
 *   /api/harmony-agent?action=device-scan
 *   /api/harmony-agent?action=clothing-check
 *   /api/harmony-agent?action=webhook-register
 *   /api/harmony-agent?action=recommend
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FATSECRET_PROXY = process.env.FATSECRET_PROXY_URL || '';

// ── Auth helper ──────────────────────────────────────────────
async function authenticateRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return { error: 'Missing or invalid Bearer token', status: 401 };
  }
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { error: 'Invalid token', status: 401 };

  // Pro check
  const { data: sub } = await supabase
    .from('user_subscriptions')
    .select('plan, status')
    .eq('user_id', user.id)
    .single();

  if (!sub || sub.plan !== 'pro' || sub.status !== 'active') {
    return { error: 'Pro subscription required', status: 403 };
  }
  return { user, token };
}

// ── Family helpers ───────────────────────────────────────────
async function getFamilyProfiles(userId) {
  const { data, error } = await supabase
    .from('family_profiles')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

function checkFamilyConflicts(product, profiles) {
  const alerts = [];
  const ingredients = (product.ingredients || '').toLowerCase();
  for (const member of profiles) {
    const sensitivities = (member.sensitivities || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const allergies = (member.allergies || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

    for (const allergy of allergies) {
      if (ingredients.includes(allergy)) {
        alerts.push({
          member: member.name,
          type: 'allergy',
          severity: 'critical',
          trigger: allergy,
          message: `ALLERGY ALERT: ${member.name} is allergic to ${allergy}`
        });
      }
    }
    for (const sens of sensitivities) {
      if (ingredients.includes(sens)) {
        alerts.push({
          member: member.name,
          type: 'sensitivity',
          severity: 'warning',
          trigger: sens,
          message: `SENSITIVITY: ${member.name} is sensitive to ${sens}`
        });
      }
    }
  }
  return alerts;
}

// ── Route handlers ───────────────────────────────────────────

/** POST ?action=analyze — Full product analysis with family alerts */
async function handleAnalyze(req, user) {
  const { barcode, product_name, ingredients } = req.body;
  if (!barcode && !product_name) {
    return { error: 'Provide barcode or product_name', status: 400 };
  }
  const profiles = await getFamilyProfiles(user.id);
  const product = { ingredients: ingredients || '' };

  if (barcode && FATSECRET_PROXY) {
    try {
      const res = await fetch(`${FATSECRET_PROXY}/api/food-barcode?barcode=${barcode}`);
      const data = await res.json();
      if (data.food) {
        product.name = data.food.food_name;
        product.brand = data.food.brand_name || '';
        product.nutrition = data.food.servings?.serving || {};
      }
    } catch (e) { /* continue with provided data */ }
  }

  const alerts = checkFamilyConflicts(product, profiles);
  const safe = alerts.filter(a => a.severity === 'critical').length === 0;

  return {
    data: {
      product,
      safe,
      alerts,
      family_members_checked: profiles.length,
      timestamp: new Date().toISOString()
    }
  };
}

/** POST ?action=family-check — Quick safe/unsafe check */
async function handleFamilyCheck(req, user) {
  const { ingredients } = req.body;
  if (!ingredients) return { error: 'Provide ingredients string', status: 400 };

  const profiles = await getFamilyProfiles(user.id);
  const alerts = checkFamilyConflicts({ ingredients }, profiles);
  const safe = alerts.filter(a => a.severity === 'critical').length === 0;

  return { data: { safe, alerts, checked_members: profiles.length } };
}

/** POST ?action=batch-check — Scan up to 50 barcodes (smart fridge) */
async function handleBatchCheck(req, user) {
  const { barcodes } = req.body;
  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return { error: 'Provide barcodes array', status: 400 };
  }
  if (barcodes.length > 50) {
    return { error: 'Maximum 50 barcodes per batch', status: 400 };
  }

  const profiles = await getFamilyProfiles(user.id);
  const results = [];

  for (const barcode of barcodes) {
    try {
      let product = { barcode };
      if (FATSECRET_PROXY) {
        const res = await fetch(`${FATSECRET_PROXY}/api/food-barcode?barcode=${barcode}`);
        const data = await res.json();
        if (data.food) {
          product.name = data.food.food_name;
          product.ingredients = data.food.ingredients || '';
        }
      }
      const alerts = checkFamilyConflicts(product, profiles);
      results.push({
        barcode,
        name: product.name || 'Unknown',
        safe: alerts.filter(a => a.severity === 'critical').length === 0,
        alerts
      });
    } catch (e) {
      results.push({ barcode, error: 'Lookup failed' });
    }
  }

  return { data: { results, total: barcodes.length, checked_members: profiles.length } };
}

/** GET/POST ?action=family-profiles — Full CRUD */
async function handleFamilyProfiles(req, user) {
  const method = req.method;

  if (method === 'GET') {
    const profiles = await getFamilyProfiles(user.id);
    return { data: { profiles } };
  }

  if (method === 'POST') {
    const { name, sensitivities, allergies, diet_preferences } = req.body;
    if (!name) return { error: 'Name is required', status: 400 };

    const { data, error } = await supabase
      .from('family_profiles')
      .insert({ user_id: user.id, name, sensitivities, allergies, diet_preferences })
      .select()
      .single();
    if (error) throw error;
    return { data: { profile: data, message: 'Member added' } };
  }

  if (method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return { error: 'Profile id is required', status: 400 };

    const { data, error } = await supabase
      .from('family_profiles')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();
    if (error) throw error;
    return { data: { profile: data, message: 'Member updated' } };
  }

  if (method === 'DELETE') {
    const { id } = req.body;
    if (!id) return { error: 'Profile id is required', status: 400 };

    const { error } = await supabase
      .from('family_profiles')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) throw error;
    return { data: { message: 'Member deleted' } };
  }

  return { error: 'Method not supported for this action', status: 405 };
}

/** GET ?action=preferences — Aggregated family restrictions (for appliance integration) */
async function handlePreferences(req, user) {
  const profiles = await getFamilyProfiles(user.id);
  const allAllergies = new Set();
  const allSensitivities = new Set();
  const allDietPrefs = new Set();

  for (const p of profiles) {
    (p.allergies || '').split(',').map(s => s.trim()).filter(Boolean).forEach(a => allAllergies.add(a.toLowerCase()));
    (p.sensitivities || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => allSensitivities.add(s.toLowerCase()));
    (p.diet_preferences || '').split(',').map(s => s.trim()).filter(Boolean).forEach(d => allDietPrefs.add(d.toLowerCase()));
  }

  return {
    data: {
      allergies: [...allAllergies],
      sensitivities: [...allSensitivities],
      diet_preferences: [...allDietPrefs],
      member_count: profiles.length,
      note: 'Aggregated across all family members — use for appliance filtering'
    }
  };
}

/** POST ?action=device-register — Register smart devices */
async function handleDeviceRegister(req, user) {
  const { device_type, device_name, device_id, manufacturer, capabilities } = req.body;
  if (!device_type || !device_name) {
    return { error: 'Provide device_type and device_name', status: 400 };
  }

  const validTypes = ['refrigerator', 'pantry_sensor', 'wearable', 'smart_display', 'iot_hub', 'washing_machine', 'dryer', 'other'];
  if (!validTypes.includes(device_type)) {
    return { error: `device_type must be one of: ${validTypes.join(', ')}`, status: 400 };
  }

  const { data, error } = await supabase
    .from('registered_devices')
    .upsert({
      user_id: user.id,
      device_type,
      device_name,
      device_id: device_id || `dev_${Date.now()}`,
      manufacturer: manufacturer || 'unknown',
      capabilities: capabilities || [],
      last_seen: new Date().toISOString(),
      status: 'active'
    }, { onConflict: 'device_id' })
    .select()
    .single();

  if (error) throw error;
  return { data: { device: data, message: 'Device registered' } };
}

/** POST ?action=device-scan — Submit scans from registered devices */
async function handleDeviceScan(req, user) {
  const { device_id, barcode, scan_type, raw_data } = req.body;
  if (!device_id) return { error: 'Provide device_id', status: 400 };
  if (!barcode && !raw_data) return { error: 'Provide barcode or raw_data', status: 400 };

  // Verify device belongs to user
  const { data: device } = await supabase
    .from('registered_devices')
    .select('*')
    .eq('device_id', device_id)
    .eq('user_id', user.id)
    .single();

  if (!device) return { error: 'Device not found or not registered to you', status: 404 };

  // Update last_seen
  await supabase.from('registered_devices').update({ last_seen: new Date().toISOString() }).eq('device_id', device_id);

  // Run analysis
  const profiles = await getFamilyProfiles(user.id);
  let product = { barcode };

  if (barcode && FATSECRET_PROXY) {
    try {
      const res = await fetch(`${FATSECRET_PROXY}/api/food-barcode?barcode=${barcode}`);
      const data = await res.json();
      if (data.food) {
        product.name = data.food.food_name;
        product.ingredients = data.food.ingredients || '';
      }
    } catch (e) { /* continue */ }
  }

  const alerts = checkFamilyConflicts(product, profiles);
  const safe = alerts.filter(a => a.severity === 'critical').length === 0;

  // Fire webhooks if alerts
  if (alerts.length > 0) {
    fireWebhooks(user.id, 'device_alert', { device_id, device_name: device.device_name, product, alerts });
  }

  return {
    data: {
      device: device.device_name,
      product,
      safe,
      alerts,
      scan_type: scan_type || 'barcode',
      timestamp: new Date().toISOString()
    }
  };
}

/** POST ?action=clothing-check — Check textile materials against sensitivities */
async function handleClothingCheck(req, user) {
  const { materials, brand, product_name, label_text } = req.body;
  if (!materials && !label_text) {
    return { error: 'Provide materials array or label_text', status: 400 };
  }

  const profiles = await getFamilyProfiles(user.id);
  const materialsList = materials || label_text.toLowerCase().split(',').map(s => s.trim());
  const alerts = [];

  // Common textile allergens mapping
  const textileAllergens = {
    'latex': ['latex', 'rubber', 'elastane', 'spandex', 'lycra'],
    'nickel': ['nickel', 'metal fiber', 'metallic'],
    'formaldehyde': ['formaldehyde', 'wrinkle-free', 'permanent press'],
    'wool': ['wool', 'merino', 'cashmere', 'angora', 'mohair', 'alpaca'],
    'silk': ['silk'],
    'polyester': ['polyester', 'microfiber'],
    'nylon': ['nylon'],
    'dye': ['dye', 'colored', 'pigment', 'chromium'],
    'fragrance': ['fragrance', 'scented', 'perfumed']
  };

  for (const member of profiles) {
    const sensitivities = (member.sensitivities || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const allergies = (member.allergies || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const allTriggers = [...allergies, ...sensitivities];

    for (const trigger of allTriggers) {
      for (const mat of materialsList) {
        if (mat.toLowerCase().includes(trigger)) {
          alerts.push({
            member: member.name,
            type: allergies.includes(trigger) ? 'allergy' : 'sensitivity',
            severity: allergies.includes(trigger) ? 'critical' : 'warning',
            trigger,
            material: mat,
            message: `${member.name}: ${trigger} found in ${mat}`
          });
        }
      }
      for (const [allergen, variants] of Object.entries(textileAllergens)) {
        if (trigger.includes(allergen)) {
          for (const mat of materialsList) {
            if (variants.some(v => mat.toLowerCase().includes(v))) {
              const existing = alerts.find(a => a.member === member.name && a.material === mat);
              if (!existing) {
                alerts.push({
                  member: member.name,
                  type: allergies.includes(trigger) ? 'allergy' : 'sensitivity',
                  severity: allergies.includes(trigger) ? 'critical' : 'warning',
                  trigger: allergen,
                  material: mat,
                  message: `${member.name}: ${allergen} related material (${mat}) detected`
                });
              }
            }
          }
        }
      }
    }
  }

  const safe = alerts.filter(a => a.severity === 'critical').length === 0;

  return {
    data: {
      product_name: product_name || 'Unknown garment',
      brand: brand || 'Unknown',
      materials: materialsList,
      safe,
      alerts,
      checked_members: profiles.length,
      timestamp: new Date().toISOString()
    }
  };
}

/** POST ?action=webhook-register — Real-time alert hooks for IoT */
async function handleWebhookRegister(req, user) {
  const { url, events, secret } = req.body;
  if (!url) return { error: 'Provide webhook url', status: 400 };

  const validEvents = ['device_alert', 'scan_complete', 'allergy_detected', 'new_member', 'profile_updated'];
  const selectedEvents = events || validEvents;

  const { data, error } = await supabase
    .from('webhooks')
    .upsert({
      user_id: user.id,
      url,
      events: selectedEvents,
      secret: secret || null,
      status: 'active',
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id,url' })
    .select()
    .single();

  if (error) throw error;
  return {
    data: {
      webhook: data,
      available_events: validEvents,
      message: 'Webhook registered — you will receive POST payloads at your URL'
    }
  };
}

/** Fire webhooks (internal) */
async function fireWebhooks(userId, event, payload) {
  try {
    const { data: hooks } = await supabase
      .from('webhooks')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (!hooks) return;
    for (const hook of hooks) {
      if (hook.events.includes(event)) {
        fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(hook.secret ? { 'X-Harmony-Signature': hook.secret } : {})
          },
          body: JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload })
        }).catch(() => {});
      }
    }
  } catch (e) { /* silently fail */ }
}

/** POST ?action=recommend — Get healthier alternatives */
async function handleRecommend(req, user) {
  const { barcode, product_name, category } = req.body;
  if (!barcode && !product_name && !category) {
    return { error: 'Provide barcode, product_name, or category', status: 400 };
  }

  const profiles = await getFamilyProfiles(user.id);
  const allAllergies = new Set();
  const allSensitivities = new Set();

  for (const p of profiles) {
    (p.allergies || '').split(',').map(s => s.trim()).filter(Boolean).forEach(a => allAllergies.add(a.toLowerCase()));
    (p.sensitivities || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => allSensitivities.add(s.toLowerCase()));
  }

  return {
    data: {
      query: { barcode, product_name, category },
      family_restrictions: {
        allergies: [...allAllergies],
        sensitivities: [...allSensitivities]
      },
      note: 'Use these restrictions to filter product databases or pass to a recommendation engine.',
      member_count: profiles.length,
      timestamp: new Date().toISOString()
    }
  };
}

// ── Router ───────────────────────────────────────────────────
const handlers = {
  'analyze': handleAnalyze,
  'family-check': handleFamilyCheck,
  'batch-check': handleBatchCheck,
  'family-profiles': handleFamilyProfiles,
  'preferences': handlePreferences,
  'device-register': handleDeviceRegister,
  'device-scan': handleDeviceScan,
  'clothing-check': handleClothingCheck,
  'webhook-register': handleWebhookRegister,
  'recommend': handleRecommend
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  if (!action || !handlers[action]) {
    return res.status(400).json({
      error: 'Invalid or missing action parameter',
      available_actions: Object.keys(handlers),
      usage: '/api/harmony-agent?action=analyze'
    });
  }

  // Authenticate
  const auth = await authenticateRequest(req);
  if (auth.error) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const result = await handlers[action](req, auth.user);
    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    return res.status(200).json(result.data);
  } catch (err) {
    console.error(`[harmony-agent] ${action} error:`, err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
