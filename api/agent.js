/**
 * /api/agent — Layer 4 Conversational Agent
 * 
 * POST /api/agent
 * Body: { message, familyProfiles, conversationHistory, scannedProduct? }
 * 
 * Proxies to Claude Haiku with full family context as system prompt.
 * The AI can reason about food safety, meal planning, nutrition,
 * and shopping — scoped to specific family members.
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

/** Verify JWT and extract user ID */
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

/** Build system prompt with family context */
function buildSystemPrompt(familyProfiles, scannedProduct) {
  let prompt = `You are the Harmony Agent — a friendly, knowledgeable family nutrition assistant built by Harmony Technologies. You help families navigate food safety, meal planning, and grocery shopping based on each member's specific dietary needs.

PERSONALITY:
- Warm, helpful, and concise
- Use emoji sparingly (✅ ⚠️ ❌ for safety checks)
- Bold (**text**) for emphasis on key items
- Keep responses focused — no filler or disclaimers unless medically relevant
- When in doubt about an allergy or sensitivity, err on the side of caution
- Always specify WHICH family member is affected, not just "your family"

CAPABILITIES:
- Food safety checks: "Is [food] safe for [person/family]?"
- Meal planning: "Plan 5 dinners avoiding nightshades for Carla"
- Nutrition Q&A: "Is quinoa high in protein?"
- Shopping guidance: "What should I grab for Tommy's lunch this week?"
- Product analysis: When a scanned product is provided, analyze its ingredients
- Substitution suggestions: If something isn't safe, suggest alternatives

RULES:
- If a food triggers a known ALLERGY → ❌ mark it clearly as dangerous, name the person
- If a food triggers a SENSITIVITY → ⚠️ flag it as caution, name the person
- If a food conflicts with a GOAL (like Low Sugar) → mention it as a note, not a warning
- ALWAYS scope safety answers to specific people, never generic
- For meal plans, respect the requested count of meals/days — do not default to 3
- When suggesting meals, avoid ALL flagged allergens and sensitivities for the target person(s)
- If no family profiles are loaded, let the user know they should add profiles first
- Keep responses under 300 words unless the user asks for detailed planning
`;

  if (familyProfiles && familyProfiles.length > 0) {
    prompt += `\nFAMILY PROFILES:\n`;
    for (const p of familyProfiles) {
      prompt += `\n**${p.name}**${p.role ? ` (${p.role})` : ''}:\n`;
      if (p.allergies && p.allergies.length > 0) {
        prompt += `  Allergies: ${p.allergies.join(', ')}\n`;
      }
      if (p.sensitivities && p.sensitivities.length > 0) {
        prompt += `  Sensitivities: ${p.sensitivities.join(', ')}\n`;
      }
      if (p.dietary_goals && p.dietary_goals.length > 0) {
        prompt += `  Dietary goals: ${p.dietary_goals.join(', ')}\n`;
      }
      if (p.medical_conditions && p.medical_conditions.length > 0) {
        prompt += `  Medical conditions: ${p.medical_conditions.join(', ')}\n`;
      }
      if (!p.allergies?.length && !p.sensitivities?.length && !p.dietary_goals?.length) {
        prompt += `  No restrictions on file\n`;
      }
    }
  } else {
    prompt += `\nNo family profiles loaded. If the user asks about food safety for specific people, remind them to add family profiles in the app first.\n`;
  }

  if (scannedProduct) {
    prompt += `\nCURRENTLY SCANNED PRODUCT:\n`;
    prompt += `  Name: ${scannedProduct.name || 'Unknown'}\n`;
    if (scannedProduct.brand) prompt += `  Brand: ${scannedProduct.brand}\n`;
    if (scannedProduct.ingredients) prompt += `  Ingredients: ${scannedProduct.ingredients}\n`;
    if (scannedProduct.healthScore !== undefined) prompt += `  Health Score: ${scannedProduct.healthScore}/100\n`;
    if (scannedProduct.isOrganic) prompt += `  Organic: Yes\n`;
    if (scannedProduct.isNonGMO) prompt += `  Non-GMO: Yes\n`;
    prompt += `\nThe user may ask questions about this product. Analyze its ingredients against the family profiles above.\n`;
  }

  return prompt;
}

/** Main handler */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  // Validate API key exists
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Agent not configured. Contact support.' });
  }

  const { message, familyProfiles, conversationHistory, scannedProduct } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Cap message length
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  try {
    // Build system prompt with family context
    const systemPrompt = buildSystemPrompt(familyProfiles || [], scannedProduct || null);

    // Build conversation messages (keep last 10 exchanges for context)
    const messages = [];
    const history = (conversationHistory || []).slice(-20); // last 20 messages = ~10 exchanges

    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.text });
      } else if (msg.role === 'agent' || msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.text });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: message.trim() });

    // Call Claude Haiku
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
        messages: messages,
      }),
    });

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errorText);
      
      if (anthropicResponse.status === 429) {
        return res.status(429).json({ error: 'Agent is busy. Please try again in a moment.' });
      }
      if (anthropicResponse.status === 401) {
        return res.status(500).json({ error: 'Agent configuration error. Contact support.' });
      }
      
      return res.status(500).json({ error: 'Agent temporarily unavailable. Try again.' });
    }

    const data = await anthropicResponse.json();
    
    // Extract text response
    const responseText = data.content
      ?.filter(block => block.type === 'text')
      ?.map(block => block.text)
      ?.join('\n') || 'I had trouble processing that. Could you rephrase?';

    return res.status(200).json({
      success: true,
      response: responseText,
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      },
    });

  } catch (err) {
    console.error('Agent error:', err);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      detail: err.message,
    });
  }
};
