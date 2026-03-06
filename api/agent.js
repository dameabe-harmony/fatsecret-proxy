/**
 * /api/agent — Layer 4 Conversational Agent + Budget-Aware Meal Planning
 * 
 * POST /api/agent
 * Body: {
 *   message,
 *   familyProfiles,
 *   conversationHistory,
 *   scannedProduct?,
 *   krogerLocationId?,
 *   krogerBannerName?,
 *   userLocation?,
 * }
 * 
 * When budget or pricing is mentioned, the agent fetches real Kroger prices
 * for ingredients and builds cost-aware meal plans.
 *
 * Env vars (Vercel):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const KROGER_WORKER_URL = 'https://harmonious-api.dameabe.workers.dev';

async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
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

/** Search Kroger for a product and return pricing */
async function searchKrogerPrice(searchTerm, locationId, limit = 3) {
  try {
    const response = await fetch(
      `${KROGER_WORKER_URL}/kroger/products?term=${encodeURIComponent(searchTerm)}&locationId=${locationId}&limit=${limit}`
    );
    if (!response.ok) return [];
    const data = await response.json();
    if (data.success && data.count > 0) {
      return data.products.map(p => ({
        name: p.description || searchTerm,
        brand: p.brand || '',
        price: p.price || null,
        promoPrice: p.promoPrice || null,
        size: p.size || '',
        inStock: p.inStock !== false,
      }));
    }
    return [];
  } catch (err) {
    console.error('Kroger price lookup failed for:', searchTerm, err.message);
    return [];
  }
}

function isBudgetQuery(message) {
  return /budget|under \$|less than \$|cheap|affordable|cost|price|how much|save money|frugal|inexpensive|\$\d+/i.test(message);
}

function extractBudget(message) {
  const patterns = [
    /under\s*\$(\d+)/i,
    /less than\s*\$(\d+)/i,
    /within\s*\$(\d+)/i,
    /\$(\d+)\s*(?:budget|max|limit|or less|or under)/i,
    /budget\s*(?:of|is|:)?\s*\$(\d+)/i,
    /\$(\d+)/,
    /(\d+)\s*dollars/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

async function fetchIngredientPrices(ingredients, locationId) {
  const results = {};
  const batches = [];
  for (let i = 0; i < ingredients.length; i += 8) {
    batches.push(ingredients.slice(i, i + 8));
  }
  for (const batch of batches) {
    const promises = batch.map(async (item) => {
      const products = await searchKrogerPrice(item, locationId, 2);
      if (products.length > 0) {
        const best = products.sort((a, b) => {
          const pa = a.promoPrice || a.price || 999;
          const pb = b.promoPrice || b.price || 999;
          return pa - pb;
        })[0];
        results[item] = {
          name: best.name,
          brand: best.brand,
          price: best.promoPrice || best.price,
          size: best.size,
          inStock: best.inStock,
        };
      }
    });
    await Promise.all(promises);
  }
  return results;
}

function buildSystemPrompt(familyProfiles, scannedProduct, pricingContext) {
  let prompt = `You are the Harmony Agent — a friendly, knowledgeable family nutrition assistant built by Harmony Technologies. You help families navigate food safety, meal planning, and grocery shopping based on each member's specific dietary needs.

PERSONALITY:
- Warm, helpful, and concise
- Use emoji sparingly (✅ ⚠️ ❌ for safety checks)
- Bold (**text**) for emphasis on key items
- Keep responses focused — no filler or disclaimers unless medically relevant
- When in doubt about an allergy or sensitivity, err on the side of caution
- Always specify WHICH family member is affected, not just "your family"

CAPABILITIES:
- Food safety checks scoped to specific family members
- Meal planning with day/count awareness
- Budget-aware meal planning with real store pricing
- Frozen dinner recommendations (safe brands per family)
- Shopping lists with estimated or real costs
- Nutrition Q&A
- Product analysis when a scanned product is provided

FROZEN DINNER KNOWLEDGE:
When users ask about frozen dinners, quick meals, or convenience foods, recommend from these brands based on dietary fit:
- **Amy's Kitchen**: Organic, many GF/dairy-free options. Watch for soy.
- **Saffron Road**: Halal, many GF, clean ingredients. Watch for soy/sesame.
- **Evol**: Clean label burritos/bowls. Some contain dairy/gluten.
- **Beetnik Foods**: Organic, paleo-friendly, GF.
- **Primal Kitchen**: Grain-free, dairy-free, clean label. Paleo/Whole30.
- **Kevin's Natural Foods**: Clean-label, GF, paleo. Sous vide proteins.
- **Tattooed Chef**: Plant-based, many GF. May contain soy.
- **Sweet Earth**: Plant-based but often contains soy and gluten.
- **Good & Gather (Target)**: Budget-friendly, check labels.
- **Trader Joe's**: Wide variety, check individual labels.
Always cross-reference frozen dinner ingredients against family allergen/sensitivity profiles.

BUDGET MEAL PLANNING:
When users mention a budget, cost, or price:
- If real store prices are provided in PRICING DATA, use them to estimate costs accurately
- Show itemized costs: each ingredient with price, then a running subtotal per meal
- Show **Estimated total: $XX.XX** at the end, noting if under/over budget
- If over budget, suggest specific swaps: chicken thighs vs breasts, frozen vs fresh veggies, store brand vs name brand
- If no real pricing data is available, use general US grocery price knowledge and clearly mark estimates with "~" (e.g., ~$3.49)
- Prioritize cost-effective proteins: chicken thighs, ground turkey, canned tuna, eggs, beans
- Mention bulk buying tips when relevant

RULES:
- ALLERGY → ❌ dangerous, name the person
- SENSITIVITY → ⚠️ caution, name the person
- GOAL conflict → informational note only
- ALWAYS scope to specific people
- Respect requested meal count — never default to 3
- Avoid ALL flagged allergens/sensitivities for target person(s)
- If no family profiles loaded, tell user to add them
- Keep responses under 300 words unless detailed planning requested
`;

  if (familyProfiles && familyProfiles.length > 0) {
    prompt += `\nFAMILY PROFILES:\n`;
    for (const p of familyProfiles) {
      prompt += `\n**${p.name}**${p.role ? ` (${p.role})` : ''}:\n`;
      if (p.allergies?.length) prompt += `  Allergies: ${p.allergies.join(', ')}\n`;
      if (p.sensitivities?.length) prompt += `  Sensitivities: ${p.sensitivities.join(', ')}\n`;
      if (p.dietary_goals?.length) prompt += `  Dietary goals: ${p.dietary_goals.join(', ')}\n`;
      if (p.medical_conditions?.length) prompt += `  Medical conditions: ${p.medical_conditions.join(', ')}\n`;
      if (!p.allergies?.length && !p.sensitivities?.length && !p.dietary_goals?.length) {
        prompt += `  No restrictions on file\n`;
      }
    }
  } else {
    prompt += `\nNo family profiles loaded. Remind user to add family profiles.\n`;
  }

  if (scannedProduct) {
    prompt += `\nCURRENTLY SCANNED PRODUCT:\n`;
    prompt += `  Name: ${scannedProduct.name || 'Unknown'}\n`;
    if (scannedProduct.brand) prompt += `  Brand: ${scannedProduct.brand}\n`;
    if (scannedProduct.ingredients) prompt += `  Ingredients: ${scannedProduct.ingredients}\n`;
    if (scannedProduct.healthScore !== undefined) prompt += `  Health Score: ${scannedProduct.healthScore}/100\n`;
    if (scannedProduct.isOrganic) prompt += `  Organic: Yes\n`;
    if (scannedProduct.isNonGMO) prompt += `  Non-GMO: Yes\n`;
  }

  if (pricingContext) {
    prompt += `\nPRICING DATA (real prices from ${pricingContext.storeName || 'nearby store'}):\n`;
    const priceEntries = Object.entries(pricingContext.prices);
    if (priceEntries.length > 0) {
      for (const [item, data] of priceEntries) {
        if (data.price) {
          prompt += `  ${item}: $${data.price.toFixed(2)} (${data.brand || 'store brand'}, ${data.size || ''})${data.inStock === false ? ' [OUT OF STOCK]' : ''}\n`;
        }
      }
    } else {
      prompt += `  No real prices available — use estimated US grocery prices and mark with ~\n`;
    }
    if (pricingContext.budget) {
      prompt += `\nUser's budget: $${pricingContext.budget.toFixed(2)}\nBuild the meal plan to stay WITHIN this budget. Show line items with prices and a total.\n`;
    }
  }

  return prompt;
}

const COMMON_INGREDIENTS = [
  'chicken breast', 'chicken thigh', 'ground beef', 'ground turkey', 'salmon fillet', 'cod fillet', 'canned tuna',
  'eggs', 'rice', 'pasta', 'quinoa', 'bread', 'tortillas',
  'broccoli', 'carrots', 'sweet potato', 'bell pepper', 'onion', 'garlic', 'zucchini', 'spinach', 'lettuce',
  'frozen vegetables', 'canned beans', 'canned tomatoes', 'chicken broth', 'tomato sauce',
  'olive oil', 'butter', 'milk', 'cheese',
  'banana', 'apple', 'lemon',
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized. Please log in.' });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Agent not configured. Contact support.' });
  }

  const {
    message, familyProfiles, conversationHistory,
    scannedProduct, krogerLocationId, krogerBannerName,
  } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  try {
    let pricingContext = null;
    const budgetDetected = isBudgetQuery(message);
    const budgetAmount = extractBudget(message);

    if (budgetDetected && krogerLocationId) {
      console.log(`Budget query: $${budgetAmount || '?'}. Fetching Kroger prices...`);
      const prices = await fetchIngredientPrices(COMMON_INGREDIENTS, krogerLocationId);
      console.log(`Got prices for ${Object.keys(prices).length}/${COMMON_INGREDIENTS.length} items`);
      if (Object.keys(prices).length > 0) {
        pricingContext = { storeName: krogerBannerName || 'Kroger', budget: budgetAmount, prices };
      }
    } else if (budgetDetected) {
      pricingContext = { storeName: 'estimated (no store connected)', budget: budgetAmount, prices: {} };
    }

    const systemPrompt = buildSystemPrompt(familyProfiles || [], scannedProduct || null, pricingContext);

    const messages = [];
    for (const msg of (conversationHistory || []).slice(-20)) {
      if (msg.role === 'user') messages.push({ role: 'user', content: msg.text });
      else if (msg.role === 'agent' || msg.role === 'assistant') messages.push({ role: 'assistant', content: msg.text });
    }
    messages.push({ role: 'user', content: message.trim() });

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errorText);
      if (anthropicResponse.status === 429) return res.status(429).json({ error: 'Agent is busy. Try again in a moment.' });
      if (anthropicResponse.status === 401) return res.status(500).json({ error: 'Agent configuration error.' });
      return res.status(500).json({ error: 'Agent temporarily unavailable.' });
    }

    const data = await anthropicResponse.json();
    const responseText = data.content?.filter(b => b.type === 'text')?.map(b => b.text)?.join('\n')
      || 'I had trouble processing that. Could you rephrase?';

    return res.status(200).json({
      success: true,
      response: responseText,
      usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 },
      budgetDetected,
      pricedIngredients: pricingContext ? Object.keys(pricingContext.prices).length : 0,
    });

  } catch (err) {
    console.error('Agent error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
