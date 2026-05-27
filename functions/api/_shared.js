const maxUploadBytes = 12 * 1024 * 1024
const freeUploadCookieName = 'sf_food_free_photo_used'
const freeUploadCookieMaxAge = 60 * 60 * 24 * 365
const uploadLimitMessage = 'This public demo includes one photo analysis for now.'
const anonymousUsagePrefix = 'anonymous-free-upload'
const anonymousUsageHoldTtlMs = 2 * 60 * 1000
const anonymousUsageHolds = new Map()
const defaultCloudflareOrigins = [
  'https://spotted-in-sf.pages.dev',
  'https://spotted-in-sf.com',
  'https://www.spotted-in-sf.com',
  'https://sf-food-guesser.pages.dev',
]
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

export function hasUsedFreeUpload(request) {
  const cookieHeader = String(request?.headers?.get?.('cookie') ?? '')
  return cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .some((cookie) => cookie === `${freeUploadCookieName}=1`)
}

export function freeUploadLimitResponse(runId, reason = 'anonymous_limit') {
  return jsonResponse(
    {
      runId,
      code: 'upload_limit_reached',
      reason,
      error: uploadLimitMessage,
    },
    402,
  )
}

export function freeUploadCookie() {
  return `${freeUploadCookieName}=1; Max-Age=${freeUploadCookieMaxAge}; Path=/; SameSite=Lax; Secure`
}

export async function checkAnonymousUsageLimit(request, env, runId) {
  if (hasUsedFreeUpload(request)) return freeUploadLimitResponse(runId, 'cookie')

  if (!clientIp(request)) {
    return jsonResponse(
      {
        runId,
        error: 'Anonymous upload limiting needs a trusted client IP before photo analysis can run.',
      },
      503,
    )
  }

  const database = anonymousUsageDatabase(env)
  if (!database) {
    return jsonResponse(
      {
        runId,
        error: 'Anonymous upload limiting is not configured. Set SF_FOOD_USAGE_DB before enabling photo analysis.',
      },
      503,
    )
  }

  const keys = await anonymousUsageKeys(request, env)
  if (hasAnonymousUsageMapRecord(keys, anonymousUsageHolds)) {
    return freeUploadLimitResponse(runId, 'in_flight')
  }

  const existingRecord = await findD1UsageRecord(database, keys)
  if (existingRecord) return freeUploadLimitResponse(runId, 'server_usage_record')

  return null
}

export async function holdAnonymousUsageSlot(request, env, runId) {
  const keys = await anonymousUsageKeys(request, env)
  if (!keys.length) {
    return {
      blockedResponse: jsonResponse(
        {
          runId,
          error: 'Anonymous upload limiting needs a trusted client IP before photo analysis can run.',
        },
        503,
      ),
    }
  }
  if (hasAnonymousUsageMapRecord(keys, anonymousUsageHolds)) {
    return { blockedResponse: freeUploadLimitResponse(runId, 'in_flight') }
  }

  const expiresAt = Date.now() + anonymousUsageHoldTtlMs
  for (const key of keys) anonymousUsageHolds.set(key, expiresAt)

  return {
    release: () => {
      for (const key of keys) anonymousUsageHolds.delete(key)
    },
  }
}

export async function reserveAnonymousUsage(request, env, runId) {
  const keys = await anonymousUsageKeys(request, env)
  const database = anonymousUsageDatabase(env)
  if (!keys.length) {
    return jsonResponse(
      {
        runId,
        error: 'Anonymous upload limiting needs a trusted client IP before photo analysis can run.',
      },
      503,
    )
  }
  if (!database) {
    return jsonResponse(
      {
        runId,
        error: 'Anonymous upload limiting is not configured. Set SF_FOOD_USAGE_DB before enabling photo analysis.',
      },
      503,
    )
  }

  const reserved = await reserveD1UsageRecord(database, keys)
  if (!reserved) return freeUploadLimitResponse(runId, 'server_usage_record')
  return null
}

function anonymousUsageDatabase(env) {
  return env.SF_FOOD_USAGE_DB || null
}

async function findD1UsageRecord(database, keys) {
  const now = new Date().toISOString()
  const placeholders = keys.map(() => '?').join(',')
  const result = await database
    .prepare(`SELECT usage_key FROM anonymous_usage WHERE usage_key IN (${placeholders}) AND expires_at > ? LIMIT 1`)
    .bind(...keys, now)
    .first()
  return Boolean(result)
}

async function reserveD1UsageRecord(database, keys) {
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + freeUploadCookieMaxAge * 1000).toISOString()
  const primaryKey = keys[0]
  await database
    .prepare('DELETE FROM anonymous_usage WHERE expires_at <= ?')
    .bind(createdAt)
    .run()
  const primaryResult = await database
    .prepare(
      'INSERT OR IGNORE INTO anonymous_usage (usage_key, created_at, expires_at, reason) VALUES (?, ?, ?, ?)',
    )
    .bind(primaryKey, createdAt, expiresAt, 'anonymous_free_upload_used')
    .run()

  if (primaryResult?.meta?.changes !== 1) return false

  await Promise.all(
    keys.slice(1).map((key) =>
      database
        .prepare(
          'INSERT OR IGNORE INTO anonymous_usage (usage_key, created_at, expires_at, reason) VALUES (?, ?, ?, ?)',
        )
        .bind(key, createdAt, expiresAt, 'anonymous_free_upload_used')
        .run(),
    ),
  )

  return true
}

function hasAnonymousUsageMapRecord(keys, store) {
  const now = Date.now()
  for (const key of keys) {
    const expiresAt = store.get(key)
    if (!expiresAt) continue
    if (expiresAt > now) return true
    store.delete(key)
  }
  return false
}

export function disallowedOriginResponse(request, env) {
  const origin = normalizedHeader(request, 'origin')
  if (!origin || isAllowedCloudflareOrigin(origin, request, env)) return null
  return jsonResponse({ error: 'This API origin is not allowed.' }, 403)
}

function isAllowedCloudflareOrigin(origin, request, env) {
  const allowedOrigins = [
    ...defaultCloudflareOrigins,
    ...String(env.SF_FOOD_GUESSER_ALLOWED_ORIGINS || '')
      .split(',')
      .map((entry) => entry.trim().replace(/\/$/, '').toLowerCase())
      .filter(Boolean),
  ]
  const requestUrl = request?.url ? new URL(request.url).origin.toLowerCase() : ''
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin) || origin === requestUrl
}

async function anonymousUsageKeys(request, env) {
  const ip = clientIp(request)
  const userAgent = normalizedHeader(request, 'user-agent')
  const acceptLanguage = normalizedHeader(request, 'accept-language')
  const salt = env.ANON_USAGE_SALT || 'sf-food-guesser-anonymous-v1'
  const components = []

  if (!ip) return []
  if (ip) components.push(['ip', ip])
  if (ip && userAgent) components.push(['ip-ua', `${ip}|${userAgent}`])
  if (ip && userAgent && acceptLanguage) {
    components.push(['ip-ua-lang', `${ip}|${userAgent}|${acceptLanguage}`])
  }

  return Promise.all(
    components.map(async ([label, value]) => `${anonymousUsagePrefix}:${label}:${await sha256Hex(`${salt}|${value}`)}`),
  )
}

function clientIp(request) {
  const cfIp = normalizedHeader(request, 'cf-connecting-ip')
  if (cfIp) return cfIp
  const trueClientIp = normalizedHeader(request, 'true-client-ip')
  if (trueClientIp) return trueClientIp
  return ''
}

function normalizedHeader(request, name) {
  return String(request?.headers?.get?.(name) ?? '').trim().toLowerCase()
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

export async function validateImageBytes(file) {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  if (looksLikeSupportedImage(bytes)) return null
  return 'Uploaded file did not look like a real image. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF photo.'
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

function looksLikeSupportedImage(bytes) {
  if (bytes.length < 4) return false
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end))
  const startsWith = (signature) => signature.every((byte, index) => bytes[index] === byte)

  if (startsWith([0xff, 0xd8, 0xff])) return true
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return true
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    return ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)
  }

  return false
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

export function buildSearchPlanPrompt(venues) {
  const compactVenues = Array.isArray(venues)
    ? venues.slice(0, 120).map((venue) => ({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        signature: venue.signature,
        imageEvidenceHints: venue.imageEvidenceHints,
      }))
    : []

  return `Inspect the uploaded San Francisco food or cafe photo and create search queries that another agent can use to find the exact venue. Do not guess from generic dish type alone.

Return strict JSON only:
{
  "summary": "short visual summary",
  "imageEvidence": ["specific visible clues from the uploaded image"],
  "visibleText": ["readable words, logos, labels, signs, menus, bags, receipts"],
  "searchQueries": ["web search query"],
  "likelyVenueTypes": ["cafe"]
}

Search-query rules:
- Include San Francisco in every query.
- Use visible text, interior details, packaging, drink/food style, recent-opening clues, and review-photo clues.
- Include queries for local articles/recent openings when the place looks new or heavily shared.
- Return 3 to 5 distinct queries.

Seed venues for comparison hints:
${JSON.stringify(compactVenues).slice(0, 12000)}`
}

export function normalizeSearchPlan(result) {
  return {
    summary: String(result?.summary ?? ''),
    imageEvidence: Array.isArray(result?.imageEvidence)
      ? result.imageEvidence.map(String).slice(0, 10)
      : [],
    visibleText: Array.isArray(result?.visibleText) ? result.visibleText.map(String).slice(0, 8) : [],
    searchQueries: Array.isArray(result?.searchQueries)
      ? result.searchQueries
          .map(String)
          .map((query) => (/\bsan francisco\b/i.test(query) ? query : `${query} San Francisco`))
          .slice(0, 5)
      : [],
    likelyVenueTypes: Array.isArray(result?.likelyVenueTypes)
      ? result.likelyVenueTypes.map(String).slice(0, 8)
      : [],
  }
}

export function buildCloudflarePrompt(venues, webEvidence = [], searchPlan = null) {
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
  const compactEvidence = Array.isArray(webEvidence)
    ? webEvidence.slice(0, 24).map((page) => ({
        title: page.title,
        source: page.source,
        url: page.url,
        snippet: page.snippet,
        query: page.query,
      }))
    : []

  return `Identify the most likely San Francisco food venue from the uploaded photo. Inspect visible text, logos, cups, bags, receipts, menus, counters, shelving, decor, lighting, storefront clues, and food. Do not require the user to provide clues.

Use the seed venue list only as hints. You may return San Francisco venues outside the seed list when the image or web evidence supports them.
Use external evidence as leads, not truth: compare it against the uploaded image before ranking a venue.

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

Photo-derived search plan:
${JSON.stringify(searchPlan ?? null).slice(0, 5000)}

External web/article evidence:
${JSON.stringify(compactEvidence).slice(0, 12000)}

Seed venues:
${JSON.stringify(compactVenues).slice(0, 18000)}`
}

export async function searchExaEvidence(searchPlan, env, fetchImpl = fetch) {
  if (!env.EXA_API_KEY) return []
  const queries = (searchPlan?.searchQueries ?? [])
    .filter(Boolean)
    .slice(0, Number(env.EXA_MAX_PARALLEL_QUERIES || 4))
  if (!queries.length) return []

  const responses = await Promise.all(
    queries.map(async (query) => {
      const response = await fetchImpl('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.EXA_API_KEY,
        },
        body: JSON.stringify({
          query,
          type: env.EXA_SEARCH_TYPE || 'deep',
          numResults: Number(env.EXA_NUM_RESULTS || 6),
          contents: {
            highlights: true,
          },
          userLocation: 'US',
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body?.error || response.statusText)
        error.status = response.status
        throw error
      }
      return { query, results: Array.isArray(body.results) ? body.results : [] }
    }),
  )

  const seen = new Set()
  return responses
    .flatMap(({ query, results }) =>
      results.map((result) => ({
        title: result.title ? String(result.title) : '',
        source: 'exa',
        url: result.url ? String(result.url) : '',
        snippet: Array.isArray(result.highlights)
          ? result.highlights.join(' ').slice(0, 900)
          : String(result.summary ?? result.text ?? '').slice(0, 900),
        query,
      })),
    )
    .filter((result) => {
      const key = result.url || `${result.title}:${result.snippet}`
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 24)
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

const evidenceWeights = {
  visible_text: 32,
  packaging_logo: 26,
  gps_match: 24,
  storefront_match: 18,
  interior_match: 16,
  web_source_match: 10,
  dish_match: 4,
}

function candidateKey(candidate) {
  if (candidate.id) return String(candidate.id).toLowerCase()
  return `${candidate.name}:${candidate.address}`.toLowerCase()
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function seedVenueCandidates(seedVenues = [], options = {}) {
  const searchPlan = options.searchPlan ?? {}
  const webEvidence = Array.isArray(options.webEvidence) ? options.webEvidence : []
  const haystack = normalizeMatchText(
    [
      options.summary,
      ...(Array.isArray(options.imageEvidence) ? options.imageEvidence : []),
      searchPlan.summary,
      ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
      ...(Array.isArray(searchPlan.visibleText) ? searchPlan.visibleText : []),
      ...(Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []),
      ...webEvidence.flatMap((page) => [page.title, page.snippet, page.url]),
    ].join(' '),
  )

  return seedVenues
    .map((venue) => {
      const hints = Array.isArray(venue.imageEvidenceHints) ? venue.imageEvidenceHints : []
      const matchedHints = hints
        .map((hint) => normalizeMatchText(hint))
        .filter((hint) => hint.length >= 4 && haystack.includes(hint))
      const venueName = normalizeMatchText(venue.name)
      const nameHit = venueName && haystack.includes(venueName)
      const sourceHit = webEvidence.some((page) =>
        normalizeMatchText([page.title, page.snippet, page.url].join(' ')).includes(venueName),
      )
      if (matchedHints.length < 3 && !nameHit && !sourceHit) return null

      const confidence = Math.min(94, 62 + matchedHints.length * 6 + (nameHit ? 10 : 0) + (sourceHit ? 8 : 0))
      return normalizeCandidate({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        confidence,
        evidenceCategories: ['interior_match', 'dish_match', 'web_source_match'],
        reasons: [
          `Seed venue matched photo/search clues: ${matchedHints.slice(0, 4).join(', ') || venue.name}.`,
          'Seed source and search context support checking this venue before generic lookalikes.',
        ],
        sourceUrls: venue.sourceUrl ? [venue.sourceUrl] : [],
        mapsQuery: [venue.name, venue.address, 'San Francisco'].filter(Boolean).join(' '),
      })
    })
    .filter(Boolean)
}

function rankCandidates(candidates, seedVenueIds = []) {
  const seedIds = new Set(seedVenueIds.filter(Boolean))

  return candidates
    .map((candidate, originalIndex) => {
      const categories = new Set(candidate.evidenceCategories)
      const hasSeedMatch = Boolean(candidate.id) && seedIds.has(candidate.id)
      const hasIdentityEvidence = ['visible_text', 'packaging_logo', 'gps_match'].some((category) =>
        categories.has(category),
      )
      const hasInteriorOrStorefront = ['interior_match', 'storefront_match'].some((category) =>
        categories.has(category),
      )
      const dishOnly = categories.has('dish_match') && !hasInteriorOrStorefront && !hasIdentityEvidence
      const hasSource = candidate.sourceUrls.length > 0
      const evidenceScore = [...categories].reduce(
        (score, category) => score + (evidenceWeights[category] ?? 0),
        0,
      )
      const seedBoost = hasSeedMatch ? 18 : 0
      const unsupportedWebPenalty = !hasSeedMatch && !hasIdentityEvidence ? 24 : 0
      const dishOnlyPenalty = dishOnly ? 28 : 0
      const sourceScore = hasSource ? 6 : -8
      const rawScore = Math.max(
        0,
        Math.min(
          100,
          candidate.confidence * 0.55 + evidenceScore + seedBoost + sourceScore - unsupportedWebPenalty - dishOnlyPenalty,
        ),
      )
      const confidenceCap =
        dishOnly
          ? 42
          : !hasSeedMatch && !hasIdentityEvidence
            ? hasInteriorOrStorefront
              ? 62
              : 54
            : 100

      return {
        ...candidate,
        confidence: Math.round(Math.min(rawScore, confidenceCap)),
        _rankScore: Math.min(rawScore, confidenceCap),
        _originalIndex: originalIndex,
      }
    })
    .sort((a, b) => b._rankScore - a._rankScore || a._originalIndex - b._originalIndex)
    .filter((candidate, index, rankedCandidates) => {
      const key = candidateKey(candidate)
      return key && rankedCandidates.findIndex((item) => candidateKey(item) === key) === index
    })
    .map(({ _rankScore, _originalIndex, ...candidate }) => candidate)
}

export function normalizeAnalysis(result, options = {}) {
  const modelCandidates = Array.isArray(result?.candidates)
    ? result.candidates.map(normalizeCandidate).filter((candidate) => candidate.name)
    : []
  const imageEvidence = Array.isArray(result?.imageEvidence) ? result.imageEvidence.map(String).slice(0, 8) : []
  const candidates = [
    ...modelCandidates,
    ...seedVenueCandidates(options.seedVenues, {
      summary: result?.summary,
      imageEvidence,
      searchPlan: options.searchPlan,
      webEvidence: options.webEvidence,
    }),
  ]

  return {
    summary: String(result?.summary ?? 'No visual summary returned.'),
    imageEvidence,
    candidates: rankCandidates(candidates, options.seedVenueIds).slice(0, 3),
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
