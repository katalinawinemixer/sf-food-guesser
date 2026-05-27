const maxUploadBytes = 12 * 1024 * 1024
const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
])
const allowedImageExtensions = /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...securityHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  })
}

export function methodNotAllowed() {
  return jsonResponse({ error: 'Method not allowed.' }, 405, {
    Allow: 'GET, POST, OPTIONS',
  })
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: securityHeaders })
}

export function isSupportedImage(file) {
  const mimeType = String(file?.type ?? '').toLowerCase()
  const fileName = String(file?.name ?? '')
  return allowedImageMimeTypes.has(mimeType) || allowedImageExtensions.test(fileName)
}

export function validateImageFile(file) {
  if (!file) return 'No photo was uploaded.'
  if (file.size > maxUploadBytes) return 'That image is too large. Upload a photo under 12 MB.'
  if (!isSupportedImage(file)) {
    return 'Unsupported image type. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.'
  }
  return null
}

export async function fileToDataUrl(file) {
  const bytes = await file.arrayBuffer()
  const byteArray = new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < byteArray.length; index += 0x8000) {
    binary += String.fromCharCode(...byteArray.subarray(index, index + 0x8000))
  }
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

export function parseFallbackModels(value = '') {
  return String(value)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

export function providerFromEnv(env) {
  if (env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: env.OPENROUTER_VISION_MODEL || 'openai/gpt-4o-mini',
      fallbackModels: parseFallbackModels(env.OPENROUTER_FALLBACK_MODELS),
    }
  }

  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: env.OPENAI_API_KEY,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
      fallbackModels: [],
    }
  }

  return null
}

export function buildCloudflarePrompt(venues) {
  const compactVenues = Array.isArray(venues)
    ? venues.slice(0, 120).map((venue) => ({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        signature: venue.signature,
        imageEvidenceHints: venue.imageEvidenceHints,
        note: venue.note,
      }))
    : []

  return `Identify the most likely San Francisco food venue from the uploaded photo. Inspect visible text, logos, cups, bags, receipts, menus, counters, shelving, decor, lighting, storefront clues, and food. Do not require the user to provide clues.

Use the seed venue list only as hints. You may return San Francisco venues outside the seed list when the image or web evidence supports them.

Return strict JSON only:
{
  "summary": "short visual summary",
  "imageEvidence": ["specific visible clues"],
  "candidates": [
    {
      "id": "seed id if exact seed match, otherwise empty string",
      "name": "venue name",
      "category": "Cafe or Restaurant or Bakery or Bar or Dessert or Counter",
      "neighborhood": "SF neighborhood if known",
      "address": "address if known, otherwise Address not confirmed",
      "confidence": 0,
      "evidenceCategories": ["visible_text", "interior_match", "storefront_match", "packaging_logo", "dish_match", "web_source_match"],
      "reasons": ["specific reasons tied to the uploaded photo"],
      "sourceUrls": ["source URLs if web/search evidence is used"],
      "mapsQuery": "venue San Francisco"
    }
  ],
  "needsMoreEvidence": true
}

Ranking rules:
- Prefer exact readable venue text, packaging/logo, storefront, or matching interior evidence over generic dish similarity.
- Penalize guesses based only on generic coffee/matcha/pastry/cuisine.
- Return up to three candidates. Use low confidence when evidence is weak.

Seed venues:
${JSON.stringify(compactVenues).slice(0, 18000)}`
}

export function parseModelJson(outputText) {
  const jsonStart = String(outputText).indexOf('{')
  const jsonEnd = String(outputText).lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Model did not return JSON.')
  }
  return JSON.parse(String(outputText).slice(jsonStart, jsonEnd + 1))
}

export function normalizeCandidate(candidate) {
  const name = candidate?.name ? String(candidate.name) : ''
  const rawConfidence = Number(candidate?.confidence ?? 0)
  const confidence = rawConfidence > 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence
  return {
    id: candidate?.id ? String(candidate.id) : '',
    name,
    category: candidate?.category ? String(candidate.category) : 'Restaurant',
    neighborhood: candidate?.neighborhood ? String(candidate.neighborhood) : 'San Francisco',
    address: candidate?.address ? String(candidate.address) : 'Address not confirmed',
    confidence: Math.round(Math.max(0, Math.min(100, confidence))),
    evidenceCategories: Array.isArray(candidate?.evidenceCategories)
      ? candidate.evidenceCategories.map(String).slice(0, 7)
      : [],
    reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.map(String).slice(0, 4) : [],
    sourceUrls: Array.isArray(candidate?.sourceUrls)
      ? candidate.sourceUrls.map(String).slice(0, 4)
      : [],
    mapsQuery: candidate?.mapsQuery ? String(candidate.mapsQuery) : [name, 'San Francisco'].filter(Boolean).join(' '),
  }
}

export function normalizeAnalysis(result) {
  const candidates = Array.isArray(result?.candidates)
    ? result.candidates.map(normalizeCandidate).filter((candidate) => candidate.name)
    : []

  return {
    summary: String(result?.summary ?? 'No visual summary returned.'),
    imageEvidence: Array.isArray(result?.imageEvidence)
      ? result.imageEvidence.map(String).slice(0, 8)
      : [],
    candidates: candidates.slice(0, 3),
    needsMoreEvidence: Boolean(result?.needsMoreEvidence),
  }
}

export function providerErrorMessage(error, provider) {
  const providerName = provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'
  const status = Number(error?.status ?? 0)
  const message = String(error?.message ?? '')

  if (status === 401 || /api key|unauthorized|authentication/i.test(message)) {
    return `${providerName} rejected the API key. Check the Cloudflare Pages environment variable.`
  }

  if (status === 402 || /more credits|billing|quota|can only afford/i.test(message)) {
    return `${providerName} needs more credits for photo analysis.`
  }

  if (status === 429 || /rate limit/i.test(message)) {
    return `${providerName} is rate limiting photo analysis. Wait a bit, then try the upload again.`
  }

  return 'The photo analysis failed. Try again in a moment.'
}
