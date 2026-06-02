import {
  buildResultQuality,
  candidatePassesQualityGate,
  isPlaceholderCandidateName,
} from '../../shared/candidate-quality.js'

const maxUploadBytes = 12 * 1024 * 1024
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

function normalizedHeader(request, name) {
  return String(request?.headers?.get?.(name) ?? '').trim().toLowerCase()
}

export function methodNotAllowed() {
  return jsonResponse({ error: 'Method not allowed.' }, 405, {
    Allow: 'GET, POST, OPTIONS',
  })
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: securityHeaders })
}

function searchCacheKey(scope, value) {
  return `search-cache:${scope}:${encodeURIComponent(JSON.stringify(value)).slice(0, 900)}`
}

async function cachedSearchJson(env, key, compute, ttlSeconds = 1800, cacheStats = null) {
  const store = env.SF_FOOD_SEARCH_CACHE_KV
  if (!store?.get || !store?.put) return compute()

  const cached = await store.get(key).catch(() => null)
  if (cached) {
    try {
      if (cacheStats) cacheStats.hits = Number(cacheStats.hits ?? 0) + 1
      return JSON.parse(cached)
    } catch {
      // Refresh corrupt rows below.
    }
  }

  if (cacheStats) cacheStats.misses = Number(cacheStats.misses ?? 0) + 1
  const value = await compute()
  await store.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).then(() => {
    if (cacheStats) cacheStats.writes = Number(cacheStats.writes ?? 0) + 1
  }).catch(() => undefined)
  return value
}

export function isSupportedImage(file) {
  const mimeType = String(file?.type ?? '').toLowerCase()
  const fileName = String(file?.name ?? '')
  return allowedImageMimeTypes.has(mimeType) || allowedImageExtensions.test(fileName)
}

function clientIp(request) {
  return (
    request?.headers?.get?.('cf-connecting-ip') ||
    request?.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

async function incrementRateLimit(store, key, limit, windowSeconds, failClosed = false) {
  const now = Date.now()
  let existing = null
  try {
    existing = await store.get(key)
  } catch (error) {
    if (failClosed) throw error
  }
  let state = null
  if (existing) {
    try {
      state = JSON.parse(existing)
    } catch {
      state = null
    }
  }
  if (!state || !Number.isFinite(state.resetAt) || state.resetAt <= now) {
    state = { count: 0, resetAt: now + windowSeconds * 1000 }
  }
  state.count += 1
  const ttl = Math.max(1, Math.ceil((state.resetAt - now) / 1000))
  try {
    await store.put(key, JSON.stringify(state), { expirationTtl: ttl })
  } catch (error) {
    if (failClosed) throw error
  }

  return state.count > limit
    ? {
        key,
        retryAfterSeconds: ttl,
      }
    : null
}

export async function enforceCloudflareRateLimit({
  request,
  env,
  scope,
  sessionId = '',
  limit = 20,
  windowSeconds = 3600,
}) {
  const store = env.SF_FOOD_RATE_LIMIT_KV
  const failClosed = String(env.SF_FOOD_RATE_LIMIT_REQUIRED || '').toLowerCase() === 'true'
  if (!store?.get || !store?.put) {
    if (failClosed) {
      return jsonResponse({ error: 'Rate limiting is not configured.' }, 503)
    }
    return null
  }

  const normalizedIp = clientIp(request).replace(/[^a-zA-Z0-9:_.-]+/g, '_')
  const checks = [
    incrementRateLimit(store, `rate:${scope}:ip:${normalizedIp}`, limit, windowSeconds, failClosed),
  ]
  if (sessionId) {
    checks.push(
      incrementRateLimit(
        store,
        `rate:${scope}:session:${String(sessionId).replace(/[^a-zA-Z0-9:_.-]+/g, '_')}`,
        limit,
        windowSeconds,
        failClosed,
      ),
    )
  }

  let results
  try {
    results = await Promise.all(checks)
  } catch {
    return jsonResponse({ error: 'Rate limiting is temporarily unavailable.' }, 503)
  }
  const limited = results.find(Boolean)
  if (!limited) return null

  return jsonResponse(
    {
      error:
        'Rate limit reached for this browser or network. Wait a bit, then try again.',
      retryAfterSeconds: limited.retryAfterSeconds,
      turnstileRequired: Boolean(env.TURNSTILE_SECRET_KEY),
    },
    429,
    { 'Retry-After': String(limited.retryAfterSeconds) },
  )
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
  const bytes = stripImageMetadataBytes(new Uint8Array(await file.arrayBuffer()))
  const byteArray = new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < byteArray.length; index += 0x8000) {
    binary += String.fromCharCode(...byteArray.subarray(index, index + 0x8000))
  }
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

export function stripImageMetadataBytes(bytes) {
  if (looksLikeJpeg(bytes)) return stripJpegMetadata(bytes)
  if (looksLikePng(bytes)) return stripPngMetadata(bytes)
  if (looksLikeWebp(bytes)) return stripWebpMetadata(bytes)
  return bytes
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end))
}

function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte)
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  )
}

function readUint32Le(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0
}

function writeUint32Le(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((length, chunk) => length + chunk.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function looksLikeJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function looksLikePng(bytes) {
  return bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function looksLikeWebp(bytes) {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
}

function stripJpegMetadata(bytes) {
  const chunks = [bytes.slice(0, 2)]
  let offset = 2
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]
    if (marker === 0xda) {
      chunks.push(bytes.slice(offset))
      return concatBytes(chunks)
    }
    if (marker === 0xd9) {
      chunks.push(bytes.slice(offset))
      return concatBytes(chunks)
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      chunks.push(bytes.slice(offset, offset + 2))
      offset += 2
      continue
    }
    const segmentLength = (bytes[offset + 2] << 8) + bytes[offset + 3]
    const segmentEnd = offset + 2 + segmentLength
    if (segmentLength < 2 || segmentEnd > bytes.length) return bytes
    const isMetadataSegment = marker === 0xe1 || marker === 0xed || marker === 0xfe
    if (!isMetadataSegment) chunks.push(bytes.slice(offset, segmentEnd))
    offset = segmentEnd
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset))
  return concatBytes(chunks)
}

function stripPngMetadata(bytes) {
  const chunks = [bytes.slice(0, 8)]
  const metadataTypes = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) return bytes
    const type = ascii(bytes, offset + 4, offset + 8)
    if (!metadataTypes.has(type)) chunks.push(bytes.slice(offset, chunkEnd))
    offset = chunkEnd
    if (type === 'IEND') break
  }
  return concatBytes(chunks)
}

function stripWebpMetadata(bytes) {
  const chunks = [bytes.slice(0, 12)]
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4)
    const length = readUint32Le(bytes, offset + 4)
    const paddedLength = length + (length % 2)
    const chunkEnd = offset + 8 + paddedLength
    if (chunkEnd > bytes.length) return bytes
    if (!['EXIF', 'XMP '].includes(type)) chunks.push(bytes.slice(offset, chunkEnd))
    offset = chunkEnd
  }
  const output = concatBytes(chunks)
  writeUint32Le(output, 4, output.length - 8)
  return output
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
        visualClues: venue.visualClues,
        menuClues: venue.menuClues,
        doNotInferFrom: venue.doNotInferFrom,
        multiLocation: venue.multiLocation,
        sourceConfidence: venue.sourceConfidence,
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

export function buildOcrPrompt() {
  return `Read exact visible text from this uploaded-food contact sheet. The panels are all crops from the same photo.
The contact sheet may include the full image, background/interior crop, foreground/food crop, left/right/center crops, and high-contrast text crops.

Return strict JSON only:
{
  "visibleText": ["exact readable words or logos"],
  "uncertainText": ["text that might be present but is not certain"],
  "textEvidence": ["where the readable text appears, such as cup, tray, sign, receipt, bag"]
}

Rules:
- Only return text that is actually visible in the image.
- Do not infer a restaurant name from food style, colors, patterns, or seed knowledge.
- If a word is cropped or stylized, put it in uncertainText unless the letters are clear.
- Prefer exact casing when readable.
- Return empty arrays when no text is readable.`
}

export function normalizeOcrResult(result) {
  return {
    visibleText: Array.isArray(result?.visibleText)
      ? result.visibleText.map(String).map((text) => text.trim()).filter(Boolean).slice(0, 8)
      : [],
    uncertainText: Array.isArray(result?.uncertainText)
      ? result.uncertainText.map(String).map((text) => text.trim()).filter(Boolean).slice(0, 8)
      : [],
    textEvidence: Array.isArray(result?.textEvidence)
      ? result.textEvidence.map(String).map((text) => text.trim()).filter(Boolean).slice(0, 8)
      : [],
  }
}

export function mergeOcrIntoSearchPlan(searchPlan, ocrResult = null) {
  if (!searchPlan || !ocrResult) return searchPlan
  const visibleText = [
    ...(Array.isArray(searchPlan.visibleText) ? searchPlan.visibleText : []),
    ...(Array.isArray(ocrResult.visibleText) ? ocrResult.visibleText : []),
  ]
    .map(String)
    .map((text) => text.trim())
    .filter(Boolean)
  const uniqueVisibleText = [...new Set(visibleText)].slice(0, 8)
  const textQueries = uniqueVisibleText.flatMap((text) => [
    `"${text}" San Francisco restaurant`,
    `"${text}" San Francisco menu photos reviews`,
  ])

  const mergedPlan = {
    ...searchPlan,
    visibleText: uniqueVisibleText,
    imageEvidence: [
      ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
      ...(Array.isArray(ocrResult.textEvidence) ? ocrResult.textEvidence : []),
      ...uniqueVisibleText.map((text) => `Readable text: ${text}`),
    ].slice(0, 12),
    searchQueries: uniqueQueries([
      ...textQueries,
      ...(Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []),
    ], 8),
    ocr: ocrResult,
  }
  const queryLanes = buildCloudflareQueryLanes(mergedPlan)
  return {
    ...mergedPlan,
    queryLanes,
    searchQueries: flattenCloudflareQueryLanes(queryLanes, 8),
  }
}

function uniqueQueries(queries, maxItems = 8) {
  return [...new Set(queries.map((query) => String(query).trim()).filter(Boolean))].slice(0, maxItems)
}

export function buildCloudflareQueryLanes(searchPlan = {}) {
  const visibleText = Array.isArray(searchPlan.visibleText) ? searchPlan.visibleText : []
  const imageText = [
    searchPlan.summary,
    ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
  ].filter(Boolean).join(' ')
  const modelQueries = Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []

  return [
    {
      lane: 'exact_ocr_text',
      queries: uniqueQueries(visibleText.flatMap((text) => [
        `"${text}" San Francisco restaurant cafe`,
        `"${text}" San Francisco menu photos reviews`,
      ]), 6),
    },
    {
      lane: 'general',
      queries: uniqueQueries(modelQueries, 8),
    },
    {
      lane: 'interior',
      queries: uniqueQueries([
        `${imageText} San Francisco cafe restaurant interior Google Maps Yelp photos reviews`,
        ...modelQueries.filter((query) =>
          /\b(interior|counter|tile|wall|shelf|shelving|decor|storefront|photos|reviews)\b/i.test(query),
        ),
      ], 6),
    },
    {
      lane: 'dish_menu',
      queries: uniqueQueries([
        `${imageText} San Francisco menu dish drink restaurant cafe`,
        ...modelQueries.filter((query) =>
          /\b(menu|dish|food|drink|coffee|matcha|latte|burger|pastry|sandwich|noodle)\b/i.test(query),
        ),
      ], 6),
    },
    {
      lane: 'recent_openings',
      queries: uniqueQueries([
        `${imageText} San Francisco recently opened new popular cafe restaurant Eater Infatuation SF Standard SFGATE`,
      ], 4),
    },
  ].filter((lane) => lane.queries.length)
}

function flattenCloudflareQueryLanes(queryLanes = [], maxItems = 8) {
  return uniqueQueries(queryLanes.flatMap((lane) => lane.queries ?? []), maxItems)
}

export function normalizeSearchPlan(result) {
  const normalizedPlan = {
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
  const queryLanes = buildCloudflareQueryLanes(normalizedPlan)
  return {
    ...normalizedPlan,
    queryLanes,
    searchQueries: flattenCloudflareQueryLanes(queryLanes, 8),
  }
}

export function buildCloudflarePrompt(venues, webEvidence = [], searchPlan = null, photoEvidence = []) {
  const compactVenues = Array.isArray(venues)
    ? venues.slice(0, 120).map((venue) => ({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        signature: venue.signature,
        imageEvidenceHints: venue.imageEvidenceHints,
        visualClues: venue.visualClues,
        menuClues: venue.menuClues,
        doNotInferFrom: venue.doNotInferFrom,
        multiLocation: venue.multiLocation,
        sourceConfidence: venue.sourceConfidence,
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
  const compactPhotoEvidence = Array.isArray(photoEvidence)
    ? photoEvidence.slice(0, 10).map((photo) => ({
        title: photo.title,
        source: photo.source,
        pageUrl: photo.pageUrl,
        imageUrl: photo.imageUrl,
        thumbnailUrl: photo.thumbnailUrl,
        query: photo.query,
        placeTitle: photo.placeTitle,
        placeAddress: photo.placeAddress,
      }))
    : []

  return `Identify the most likely San Francisco food venue from the uploaded photo. Inspect visible text, logos, cups, bags, receipts, menus, counters, shelving, decor, lighting, storefront clues, and food. Do not require the user to provide clues.

Use the seed venue list only as hints. You may return San Francisco venues outside the seed list when the image or web evidence supports them.
Use external evidence as leads, not truth: compare it against the uploaded image before ranking a venue.
Do not cite seed venue signature items as if they were visible in the uploaded photo. A seed's menu items, cuisine, neighborhood, or source page can support a guess only after the uploaded photo itself has matching visual, text, GPS, storefront, or interior evidence.
Treat visible text carefully. Exact storefront/menu/receipt/venue-name text is strong evidence. Generic words, partial brand marks, sauce bottles, packaged goods, delivery bags, cups, or third-party branding are not enough for very high confidence unless the exact venue name is readable or web/photo evidence confirms that branding belongs to the venue shown.
Return only real named venues. Never invent placeholder candidates such as "Other Inner Richmond Cafe", "Unknown Mission Restaurant", or "Generic Matcha Cafe"; if the venue is uncertain, lower confidence and set needsMoreEvidence instead.
Seed fields named doNotInferFrom are negative constraints: do not use those clues as identity evidence unless stronger uploaded-photo or public-photo evidence confirms the venue.

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
      "photoEvidence": ["specific facts visible in the uploaded photo only"],
      "externalEvidence": ["specific supporting facts from web/search/photo evidence only"],
      "rankingRules": ["short notes about confidence caps or uncertainty"],
      "reasons": ["legacy combined reasons, keep concise"],
      "sourceUrls": ["source URLs if web/search evidence is used"],
      "mapsQuery": "venue San Francisco"
    }
  ],
  "needsMoreEvidence": true
}

Ranking rules:
- Prefer exact readable venue text, storefront, receipt/menu text, or matching interior evidence over generic dish similarity.
- Never use a seed venue's known dishes as a reason unless those exact dish/interior details are visible in the uploaded photo.
- Put uploaded-photo observations only in photoEvidence. Put articles, review pages, Maps/Yelp/public photos, or seed/source support only in externalEvidence. Put confidence caps and uncertainty in rankingRules.
- Do not give a very high confidence score to a venue based only on packaging, cups, bottles, bags, or a partial logo. Keep those guesses moderate unless the exact venue name is visible.
- Penalize guesses based only on generic coffee/matcha/pastry/cuisine.
- Omit any candidate whose "name" is only a descriptive fallback or neighborhood/category phrase, not a real venue name.
- Return up to three candidates. Use low confidence when evidence is weak.

Photo-derived search plan:
${JSON.stringify(searchPlan ?? null).slice(0, 5000)}

External web/article evidence:
${JSON.stringify(compactEvidence).slice(0, 12000)}

External public photo evidence:
${JSON.stringify(compactPhotoEvidence).slice(0, 8000)}

Seed venues:
${JSON.stringify(compactVenues).slice(0, 18000)}`
}

export function buildCloudflarePhotoEvidenceParts(photoEvidence = []) {
  return photoEvidence.slice(0, 4).flatMap((photo, index) => {
    const imageUrl = photo.imageUrl || photo.thumbnailUrl
    if (!imageUrl) return []
    return [
      {
        type: 'text',
        text: `External candidate photo ${index + 1}: ${photo.title || photo.placeTitle || 'public venue photo'} from ${photo.source || 'public photos'} at ${photo.pageUrl || imageUrl}. Compare against the uploaded image before trusting this candidate.`,
      },
      { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
    ]
  })
}

export async function searchExaEvidence(searchPlan, env, fetchImpl = fetch, cacheStats = null) {
  if (!env.EXA_API_KEY) return []
  const queries = (searchPlan?.searchQueries ?? [])
    .filter(Boolean)
    .slice(0, Number(env.EXA_MAX_PARALLEL_QUERIES || 4))
  if (!queries.length) return []

  const responses = await Promise.all(
    queries.map((query) => cachedSearchJson(
      env,
      searchCacheKey('exa-evidence', query),
      async () => {
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
      },
      Number(env.SF_FOOD_SEARCH_CACHE_TTL_SECONDS || 1800),
      cacheStats,
    )),
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

function normalizeHasDataPlaces(result) {
  if (Array.isArray(result?.placeResults)) return result.placeResults
  if (result?.placeResults && typeof result.placeResults === 'object') return [result.placeResults]
  if (Array.isArray(result?.localResults)) return result.localResults
  if (result?.localResults && typeof result.localResults === 'object' && !Array.isArray(result.localResults?.places)) {
    return [result.localResults]
  }
  if (Array.isArray(result?.localResults?.places)) return result.localResults.places
  if (Array.isArray(result?.local_results)) return result.local_results
  if (Array.isArray(result?.places)) return result.places
  return []
}

function normalizeHasDataPhotos(result) {
  if (Array.isArray(result?.photos)) return result.photos
  if (Array.isArray(result?.images)) return result.images
  if (Array.isArray(result?.items)) return result.items
  return []
}

function hasDataPlaceKey(place) {
  return place?.dataId ?? place?.data_id ?? place?.placeId ?? place?.place_id ?? ''
}

function hasDataPhotoUrl(photo) {
  if (typeof photo === 'string') return photo
  return photo?.image ?? photo?.url ?? photo?.fullImage ?? photo?.original ?? photo?.thumbnail ?? ''
}

function hasDataPhotoThumbnail(photo) {
  if (typeof photo === 'string') return photo
  return photo?.thumbnail ?? photo?.thumb ?? photo?.image ?? photo?.url ?? ''
}

function mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }) {
  const imageUrl = hasDataPhotoUrl(photo)
  const thumbnailUrl = hasDataPhotoThumbnail(photo)
  const placeTitle = String(place?.title ?? place?.name ?? 'Google Maps place')
  const placeAddress = String(place?.address ?? place?.fullAddress ?? '')
  return {
    title: `${placeTitle} customer photo`,
    source: 'Google Maps reviews/photos',
    pageUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      [placeTitle, placeAddress].filter(Boolean).join(' '),
    )}`,
    imageUrl: imageUrl ? String(imageUrl) : '',
    thumbnailUrl: thumbnailUrl ? String(thumbnailUrl) : String(imageUrl),
    query,
    placeTitle,
    placeAddress,
    queryIndex,
    placeIndex,
    photoIndex,
  }
}

function mapGooglePlacesPhoto({ photoUri, place, query, queryIndex, placeIndex, photoIndex }) {
  const placeTitle = String(place?.displayName?.text ?? 'Google Places result')
  const placeAddress = String(place?.formattedAddress ?? '')
  return {
    title: `${placeTitle} Google Places photo`,
    source: 'Google Places photos',
    pageUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      [placeTitle, placeAddress].filter(Boolean).join(' '),
    )}`,
    imageUrl: String(photoUri || ''),
    thumbnailUrl: String(photoUri || ''),
    query,
    placeTitle,
    placeAddress,
    placeId: String(place?.id ?? ''),
    mapsQuery: [placeTitle, placeAddress].filter(Boolean).join(' '),
    gpsCoordinates: place?.location ?? null,
    queryIndex,
    placeIndex,
    photoIndex,
  }
}

export async function searchGooglePlacesPhotoEvidence(searchPlan, env, fetchImpl = fetch, cacheStats = null) {
  if (!env.GOOGLE_PLACES_API_KEY) return []
  const queries = (searchPlan?.searchQueries ?? [])
    .filter(Boolean)
    .slice(0, Number(env.GOOGLE_PLACES_MAX_PARALLEL_QUERIES || 3))
  if (!queries.length) return []

  const placeSearches = queries.map(async (rawQuery, queryIndex) => {
    const query = `${rawQuery} San Francisco cafe restaurant`
    const result = await cachedSearchJson(
      env,
      searchCacheKey('google-places-text-search', query),
      async () => {
        const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': String(env.GOOGLE_PLACES_API_KEY),
            'X-Goog-FieldMask':
              'places.id,places.displayName,places.formattedAddress,places.location,places.photos',
          },
          body: JSON.stringify({
            textQuery: query,
            includedType: 'restaurant',
            locationBias: {
              circle: {
                center: { latitude: 37.7749, longitude: -122.4194 },
                radius: 16000,
              },
            },
            pageSize: 5,
          }),
        })
        if (!response.ok) return { places: [] }
        const body = await response.json().catch(() => ({}))
        return { places: Array.isArray(body.places) ? body.places : [] }
      },
      Number(env.SF_FOOD_SEARCH_CACHE_TTL_SECONDS || 1800),
      cacheStats,
    )
    return result.places
      .slice(0, 3)
      .map((place, placeIndex) => ({ place, query, queryIndex, placeIndex }))
  })

  const settledPlaceSearches = await Promise.allSettled(placeSearches)
  const seenPlaces = new Set()
  const places = settledPlaceSearches
    .flatMap((settledSearch) =>
      settledSearch.status === 'fulfilled' ? settledSearch.value : [],
    )
    .sort((a, b) => a.queryIndex - b.queryIndex || a.placeIndex - b.placeIndex)
    .filter(({ place }) => {
      if (!place?.id || seenPlaces.has(place.id)) return false
      seenPlaces.add(place.id)
      return true
    })
    .slice(0, 8)

  const photoLookups = places.flatMap(({ place, query, queryIndex, placeIndex }) =>
    (Array.isArray(place.photos) ? place.photos.slice(0, 4) : []).map(async (photo, photoIndex) => {
      if (!photo.name) return null
      const photoUrl = new URL(`https://places.googleapis.com/v1/${photo.name}/media`)
      photoUrl.searchParams.set('maxWidthPx', '900')
      photoUrl.searchParams.set('skipHttpRedirect', 'true')
      photoUrl.searchParams.set('key', String(env.GOOGLE_PLACES_API_KEY))
      const result = await cachedSearchJson(
        env,
        searchCacheKey('google-places-photo-media', photo.name),
        async () => {
          const response = await fetchImpl(photoUrl)
          if (!response.ok) return {}
          return response.json().catch(() => ({}))
        },
        Number(env.SF_FOOD_SEARCH_CACHE_TTL_SECONDS || 1800),
        cacheStats,
      )
      return mapGooglePlacesPhoto({
        photoUri: result.photoUri,
        place,
        query,
        queryIndex,
        placeIndex,
        photoIndex,
      })
    }),
  )
  const settledPhotoLookups = await Promise.allSettled(photoLookups)
  const seenPhotos = new Set()
  const photos = []

  for (const photo of settledPhotoLookups
    .flatMap((settledLookup) =>
      settledLookup.status === 'fulfilled' && settledLookup.value ? [settledLookup.value] : [],
    )
    .sort(
      (a, b) =>
        a.queryIndex - b.queryIndex ||
        a.placeIndex - b.placeIndex ||
        a.photoIndex - b.photoIndex,
    )) {
    if (!photo.imageUrl || seenPhotos.has(photo.imageUrl)) continue
    seenPhotos.add(photo.imageUrl)
    const { queryIndex, placeIndex, photoIndex, ...publicPhoto } = photo
    photos.push(publicPhoto)
    if (photos.length >= 18) return photos
  }

  return photos.slice(0, 18)
}

export async function searchHasDataPhotoEvidence(searchPlan, env, fetchImpl = fetch, debug = null, cacheStats = null) {
  if (!env.HASDATA_API_KEY) return []
  const queries = (searchPlan?.searchQueries ?? [])
    .filter(Boolean)
    .slice(0, 3)
  if (!queries.length) return []

  const mapSearches = []
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const rawQuery = queries[queryIndex]
    const query = `${rawQuery} San Francisco cafe restaurant`
    const url = new URL('https://api.hasdata.com/scrape/google-maps/search')
    url.searchParams.set('q', query)
    url.searchParams.set('ll', '@37.7749,-122.4194,12z')
    url.searchParams.set('hl', 'en')
    url.searchParams.set('gl', 'us')

    try {
      const cachedSearch = await cachedSearchJson(
        env,
        searchCacheKey('hasdata-map-search', query),
        async () => {
          const response = await fetchImpl(url, {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.HASDATA_API_KEY,
            },
          })
          const result = await response.json().catch(() => ({}))
          return {
            status: response.status,
            ok: response.ok,
            result,
            places: response.ok ? normalizeHasDataPlaces(result) : [],
          }
        },
        Number(env.SF_FOOD_SEARCH_CACHE_TTL_SECONDS || 1800),
        cacheStats,
      )
      debug?.searches?.push?.({
        status: cachedSearch.status,
        ok: cachedSearch.ok,
        queryIndex,
        placeCount: cachedSearch.places.length,
        topLevelKeys: Object.keys(cachedSearch.result).slice(0, 8),
        error: cachedSearch.result?.message || cachedSearch.result?.error || null,
        placeResultsType: Array.isArray(cachedSearch.result?.placeResults) ? 'array' : typeof cachedSearch.result?.placeResults,
        localResultsType: Array.isArray(cachedSearch.result?.localResults) ? 'array' : typeof cachedSearch.result?.localResults,
      })
      if (!cachedSearch.ok) {
        mapSearches.push([])
        continue
      }
      const search = cachedSearch.places.slice(0, 3).map((place, placeIndex) => ({
        place,
        query,
        queryIndex,
        placeIndex,
      }))
      mapSearches.push(search)
      if (search.length && queryIndex === 0) break
    } catch (error) {
      debug?.searches?.push?.({
        status: 0,
        ok: false,
        queryIndex,
        placeCount: 0,
        topLevelKeys: [],
        error: String(error?.message ?? error),
      })
      mapSearches.push([])
    }
  }

  const seenPlaces = new Set()
  const places = mapSearches
    .flat()
    .sort((a, b) => a.queryIndex - b.queryIndex || a.placeIndex - b.placeIndex)
    .filter(({ place }) => {
      const key = hasDataPlaceKey(place)
      if (!key || seenPlaces.has(key)) return false
      seenPlaces.add(key)
      return true
    })
    .slice(0, 8)

  const inlinePlacePhotos = places.flatMap(({ place, query, queryIndex, placeIndex }) =>
    normalizeHasDataPhotos(place).slice(0, 4).map((photo, photoIndex) =>
      mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }),
    ),
  )
  if (debug) {
    debug.placeCount = places.length
    debug.inlinePhotoCount = inlinePlacePhotos.length
  }

  const photoSearches = places.map(async ({ place, query, queryIndex, placeIndex }) => {
    const dataId = place?.dataId ?? place?.data_id
    const placeId = place?.placeId ?? place?.place_id
    const photosUrl = new URL('https://api.hasdata.com/scrape/google-maps/photos')
    if (dataId) photosUrl.searchParams.set('dataId', String(dataId))
    if (!dataId && placeId) photosUrl.searchParams.set('placeId', String(placeId))
    photosUrl.searchParams.set('hl', 'en')

    const cachedPhotos = await cachedSearchJson(
      env,
      searchCacheKey('hasdata-photos', dataId || placeId || query),
      async () => {
        const response = await fetchImpl(photosUrl, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.HASDATA_API_KEY,
          },
        })
        if (!response.ok) return { status: response.status, photos: [] }
        const result = await response.json().catch(() => ({}))
        return { status: response.status, photos: normalizeHasDataPhotos(result) }
      },
      Number(env.SF_FOOD_SEARCH_CACHE_TTL_SECONDS || 1800),
      cacheStats,
    )
    const photos = cachedPhotos.photos
    if (debug) {
      debug.photoEndpointStatuses.push(cachedPhotos.status)
      debug.endpointPhotoCount += photos.length
    }
    const placeTitle = String(place?.title ?? place?.name ?? 'Google Maps place')
    const placeAddress = String(place?.address ?? place?.fullAddress ?? '')

    return photos.slice(0, 4).map((photo, photoIndex) =>
      mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }),
    )
  })

  const seenPhotos = new Set()
  const settledPhotoSearches = await Promise.allSettled(photoSearches)
  return [
    ...inlinePlacePhotos,
    ...settledPhotoSearches.flatMap((settledSearch) =>
      settledSearch.status === 'fulfilled' ? settledSearch.value : [],
    ),
  ]
    .sort(
      (a, b) =>
        a.queryIndex - b.queryIndex ||
        a.placeIndex - b.placeIndex ||
        a.photoIndex - b.photoIndex,
    )
    .filter((photo) => {
      if (!photo.imageUrl || seenPhotos.has(photo.imageUrl)) return false
      seenPhotos.add(photo.imageUrl)
      return true
    })
    .map(({ queryIndex, placeIndex, photoIndex, ...photo }) => photo)
    .slice(0, 18)
}

export function parseModelJson(outputText) {
  const jsonStart = String(outputText).indexOf('{')
  const jsonEnd = String(outputText).lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Model did not return JSON.')
  }
  return JSON.parse(String(outputText).slice(jsonStart, jsonEnd + 1))
}

function normalizeStringList(value, maxItems = 4) {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, maxItems)
    : []
}

function reasonLooksExternal(reason) {
  return /\b(web|source|article|review|public photo|google maps|maps|yelp|eater|infatuation|sf standard|sfgate|url|site|external)\b/i.test(
    reason,
  )
}

function explanationBuckets(candidate) {
  const reasons = normalizeStringList(candidate?.reasons, 4)
  const explicitPhotoEvidence = normalizeStringList(candidate?.photoEvidence, 5)
  const explicitExternalEvidence = normalizeStringList(candidate?.externalEvidence, 5)
  const rankingRules = [
    ...normalizeStringList(candidate?.rankingRules, 5),
    ...normalizeStringList(candidate?.rankingNotes, 5),
  ].slice(0, 5)

  const fallbackPhotoEvidence = reasons.filter((reason) => !reasonLooksExternal(reason)).slice(0, 4)
  const fallbackExternalEvidence = reasons.filter(reasonLooksExternal).slice(0, 4)

  return {
    photoEvidence: explicitPhotoEvidence.length ? explicitPhotoEvidence : fallbackPhotoEvidence,
    externalEvidence: explicitExternalEvidence.length ? explicitExternalEvidence : fallbackExternalEvidence,
    rankingRules,
    reasons,
  }
}

export function normalizeCandidate(candidate) {
  const rawName = candidate?.name ? String(candidate.name).trim() : ''
  const name = isPlaceholderCandidateName(rawName) ? '' : rawName
  const rawConfidence = Number(candidate?.confidence ?? 0)
  const confidence = rawConfidence > 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence
  const explanations = explanationBuckets(candidate)
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
    photoEvidence: explanations.photoEvidence,
    externalEvidence: explanations.externalEvidence,
    rankingRules: explanations.rankingRules,
    reasons: explanations.reasons,
    sourceUrls: Array.isArray(candidate?.sourceUrls)
      ? candidate.sourceUrls.map(String).slice(0, 4)
      : [],
    doNotInferFrom: Array.isArray(candidate?.doNotInferFrom)
      ? candidate.doNotInferFrom.map(String).slice(0, 6)
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

function candidateMergeKey(candidate) {
  return String(candidate.name || candidate.id || '').trim().toLowerCase()
}

function mergeUniqueStrings(...values) {
  return [...new Set(values.flat().filter(Boolean).map(String))].slice(0, 12)
}

function mergeCandidateRecords(existing, incoming) {
  const preferred = incoming.confidence > existing.confidence ? incoming : existing
  const fallback = preferred === incoming ? existing : incoming

  return {
    ...fallback,
    ...preferred,
    id: existing.id || incoming.id || '',
    confidence: Math.max(existing.confidence, incoming.confidence),
    evidenceCategories: mergeUniqueStrings(existing.evidenceCategories ?? [], incoming.evidenceCategories ?? []),
    photoEvidence: mergeUniqueStrings(existing.photoEvidence ?? [], incoming.photoEvidence ?? []).slice(0, 5),
    externalEvidence: mergeUniqueStrings(existing.externalEvidence ?? [], incoming.externalEvidence ?? []).slice(0, 5),
    rankingRules: mergeUniqueStrings(existing.rankingRules ?? [], incoming.rankingRules ?? []).slice(0, 6),
    reasons: mergeUniqueStrings(existing.reasons ?? [], incoming.reasons ?? []).slice(0, 4),
    sourceUrls: mergeUniqueStrings(existing.sourceUrls ?? [], incoming.sourceUrls ?? []).slice(0, 4),
  }
}

function dedupeCandidatesBeforeRanking(candidates = []) {
  const mergedByKey = new Map()

  for (const candidate of candidates) {
    const key = candidateMergeKey(candidate)
    if (!key) continue
    const existing = mergedByKey.get(key)
    mergedByKey.set(key, existing ? mergeCandidateRecords(existing, candidate) : candidate)
  }

  return [...mergedByKey.values()]
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
  const photoHaystack = normalizeMatchText(
    [
      options.summary,
      ...(Array.isArray(options.imageEvidence) ? options.imageEvidence : []),
      searchPlan.summary,
      ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
      ...(Array.isArray(searchPlan.visibleText) ? searchPlan.visibleText : []),
    ].join(' '),
  )

  return seedVenues
    .map((venue) => {
      const hints = [
        ...(Array.isArray(venue.imageEvidenceHints) ? venue.imageEvidenceHints : []),
        ...(Array.isArray(venue.visualClues) ? venue.visualClues : []),
        ...(Array.isArray(venue.menuClues) ? venue.menuClues : []),
      ]
      const matchedHints = [...new Set(hints
        .map((hint) => normalizeMatchText(hint))
        .filter((hint) => hint.length >= 4 && photoHaystack.includes(hint)))]
      const venueName = normalizeMatchText(venue.name)
      const nameHit = venueName && photoHaystack.includes(venueName)
      const sourceHit = webEvidence.some((page) =>
        normalizeMatchText([page.title, page.snippet, page.url].join(' ')).includes(venueName),
      )
      if (matchedHints.length < 2 && !nameHit) return null

      const confidence = Math.min(94, 62 + matchedHints.length * 6 + (nameHit ? 10 : 0) + (sourceHit ? 8 : 0))
      const evidenceCategories = [
        ...(nameHit ? ['visible_text'] : []),
        'interior_match',
        'dish_match',
        ...(sourceHit ? ['web_source_match'] : []),
      ]
      return normalizeCandidate({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        confidence,
        evidenceCategories,
        photoEvidence: [
          nameHit
            ? `The uploaded photo evidence includes readable or model-reported text matching ${venue.name}.`
            : `Seed venue matched direct photo clues: ${matchedHints.slice(0, 4).join(', ')}.`,
        ],
        externalEvidence: sourceHit
          ? ['Web/source context supports checking this venue after the direct photo match.']
          : [],
        rankingRules: ['This seed venue is only a candidate because direct photo clues matched.'],
        doNotInferFrom: venue.doNotInferFrom,
        reasons: [
          nameHit
            ? `The uploaded photo evidence includes readable or model-reported text matching ${venue.name}.`
            : `Seed venue matched direct photo clues: ${matchedHints.slice(0, 4).join(', ')}.`,
          sourceHit
            ? 'Web/source context supports checking this venue after the direct photo match.'
            : 'This seed venue is only a candidate because direct photo clues matched.',
        ],
        sourceUrls: venue.sourceUrl ? [venue.sourceUrl] : [],
        mapsQuery: [venue.name, venue.address, 'San Francisco'].filter(Boolean).join(' '),
      })
    })
    .filter(Boolean)
}

function rankCandidates(candidates, optionsOrSeedVenueIds = []) {
  const options = Array.isArray(optionsOrSeedVenueIds)
    ? { seedVenueIds: optionsOrSeedVenueIds }
    : optionsOrSeedVenueIds ?? {}
  const seedIds = new Set((options.seedVenueIds ?? []).filter(Boolean))
  const ocrVisibleText = (options.ocrVisibleText ?? [])
    .map((text) => normalizeMatchText(text))
    .filter((text) => text.length >= 4)

  const rankedCandidates = dedupeCandidatesBeforeRanking(candidates)
    .map((candidate, originalIndex) => {
      const categories = new Set(candidate.evidenceCategories)
      const originalCategories = new Set(candidate.evidenceCategories)
      const hasSeedMatch = Boolean(candidate.id) && seedIds.has(candidate.id)
      const candidateText = normalizeMatchText([
        ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
        ...(Array.isArray(candidate.photoEvidence) ? candidate.photoEvidence : []),
      ].join(' '))
      const normalizedName = normalizeMatchText(candidate.name)
      const hasReliableVisibleText =
        categories.has('visible_text') && normalizedName && candidateText.includes(normalizedName)
      if (categories.has('visible_text') && !hasReliableVisibleText) {
        categories.delete('visible_text')
      }
      const visibleTextWasRemoved =
        originalCategories.has('visible_text') && !categories.has('visible_text')
      const hasIdentityEvidence = ['visible_text', 'gps_match'].some((category) =>
        categories.has(category),
      )
      const nonSourceCategories = [...categories].filter((category) => category !== 'web_source_match')
      const ocrContradictedCandidate =
        ocrVisibleText.length > 0 &&
        normalizedName.length >= 4 &&
        !ocrVisibleText.some((text) => normalizedName.includes(text) || text.includes(normalizedName))
      const hasLogoEvidence = categories.has('packaging_logo')
      const hasInteriorOrStorefront = ['interior_match', 'storefront_match'].some((category) =>
        categories.has(category),
      )
      const sourceOnly = categories.has('web_source_match') && nonSourceCategories.length === 0
      const seedOnly = hasSeedMatch && sourceOnly
      const dishOnly =
        categories.has('dish_match') &&
        nonSourceCategories.every((category) => category === 'dish_match') &&
        !hasIdentityEvidence
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
        seedOnly
          ? 40
          : sourceOnly
            ? 38
            : dishOnly
              ? 42
              : hasSeedMatch && !hasIdentityEvidence && hasLogoEvidence
                ? 72
                : hasSeedMatch && !hasIdentityEvidence
                  ? 78
                  : !hasSeedMatch && !hasIdentityEvidence
                    ? hasInteriorOrStorefront
                      ? 62
                      : hasLogoEvidence
                        ? 58
                        : 54
                    : 100

      const rankingRules = [
        ...candidate.rankingRules,
        ...(seedOnly ? ['Seed-list identity alone is not photo evidence, so this was capped.'] : []),
        ...(sourceOnly ? ['Source/article evidence alone is weak without a matching uploaded-photo clue.'] : []),
        ...(dishOnly ? ['Food/drink similarity alone is weak evidence, so this was ranked lower.'] : []),
        ...(!hasSeedMatch && !hasIdentityEvidence
          ? ['No readable venue name, GPS, or unique identity clue was verified, so this guess is capped.']
          : []),
      ].slice(0, 5)
      const cappedScore = Math.min(rawScore, confidenceCap)
      const rankingDebugReasons = [
        ...(visibleTextWasRemoved
          ? ['visible text removed because exact candidate name was not readable']
          : []),
        ...(seedOnly ? ['seed source text only'] : []),
        ...(sourceOnly ? ['source-only cap'] : []),
        ...(dishOnly ? ['dish-only cap'] : []),
        ...(!hasSeedMatch && !hasIdentityEvidence && hasInteriorOrStorefront
          ? ['unverified interior/storefront cap']
          : []),
        ...(!hasIdentityEvidence ? ['no identity clue'] : []),
        ...(ocrContradictedCandidate ? ['OCR contradicted candidate'] : []),
        ...(cappedScore < rawScore ? [`confidence capped at ${confidenceCap}`] : []),
      ]

      return {
        ...candidate,
        evidenceCategories: [...categories],
        rankingRules,
        confidence: Math.round(cappedScore),
        rankingDebugReasons,
        _rankScore: cappedScore,
        _rawRankScore: rawScore,
        _confidenceCap: confidenceCap,
        _originalIndex: originalIndex,
      }
    })
    .sort((a, b) => b._rankScore - a._rankScore || a._originalIndex - b._originalIndex)

  const seenCandidateKeys = new Set()
  const keptCandidates = []
  const debugReport = []

  rankedCandidates.forEach((candidate) => {
    const key = candidateKey(candidate)
    const isDuplicate = !key || seenCandidateKeys.has(key)
    const status = isDuplicate ? 'deduplicated' : 'kept'
    if (!isDuplicate) {
      seenCandidateKeys.add(key)
      keptCandidates.push(candidate)
    }
    debugReport.push({
      name: candidate.name,
      status,
      rank: status === 'kept' ? keptCandidates.length : null,
      originalConfidence: candidate.originalConfidence ?? null,
      finalConfidence: candidate.confidence,
      rawRankScore: Math.round(candidate._rawRankScore),
      confidenceCap: candidate._confidenceCap,
      evidenceCategories: candidate.evidenceCategories,
      reasons: [
        ...(candidate.rankingDebugReasons ?? []),
        ...(isDuplicate ? ['duplicate candidate removed before final ranking'] : []),
      ],
    })
  })

  if (Array.isArray(options.debugReport)) {
    options.debugReport.push(...debugReport)
  }

  return keptCandidates.map(
    ({
      _rankScore,
      _rawRankScore,
      _confidenceCap,
      _originalIndex,
      rankingDebugReasons,
      ...candidate
    }) => candidate,
  )
}

export function normalizeAnalysis(result, options = {}) {
  const seedVenueById = new Map(
    (Array.isArray(options.seedVenues) ? options.seedVenues : [])
      .filter((venue) => venue?.id)
      .map((venue) => [String(venue.id), venue]),
  )
  const rawModelCandidates = Array.isArray(result?.candidates)
    ? result.candidates.map((candidate) => {
        const seedVenue = candidate?.id ? seedVenueById.get(String(candidate.id)) : null
        return seedVenue
          ? {
              ...candidate,
              sourceUrls: Array.isArray(candidate.sourceUrls) && candidate.sourceUrls.length
                ? candidate.sourceUrls
                : seedVenue.sourceUrl
                  ? [seedVenue.sourceUrl]
                  : [],
              doNotInferFrom: seedVenue.doNotInferFrom ?? candidate.doNotInferFrom,
            }
          : candidate
      })
    : []
  const modelCandidates = rawModelCandidates.length
    ? rawModelCandidates
        .map((candidate) => {
          const normalized = normalizeCandidate(candidate)
          return normalized
        })
        .filter((candidate) => candidate.name)
    : []
  const rawImageEvidence = Array.isArray(result?.imageEvidence) ? result.imageEvidence.map(String).slice(0, 8) : []
  const imageEvidence =
    rawImageEvidence.length === 1 && /^specific image evidence$/i.test(rawImageEvidence[0])
      ? Array.isArray(options.searchPlan?.imageEvidence)
        ? options.searchPlan.imageEvidence.map(String).slice(0, 8)
        : []
      : rawImageEvidence
  const candidates = [
    ...modelCandidates,
    ...seedVenueCandidates(options.seedVenues, {
      summary: result?.summary,
      imageEvidence,
      searchPlan: options.searchPlan,
      webEvidence: options.webEvidence,
    }),
  ]

  const rankingDebug = options.debugRanking ? [] : null
  const rankedCandidates = rankCandidates(candidates, {
    seedVenueIds: options.seedVenueIds,
    ocrVisibleText: [
      ...(Array.isArray(options.searchPlan?.visibleText) ? options.searchPlan.visibleText : []),
      ...(Array.isArray(options.ocr?.visibleText) ? options.ocr.visibleText : []),
    ],
    debugReport: rankingDebug,
  })
    .filter((candidate) =>
      candidatePassesQualityGate(candidate, {
        seedVenueIds: options.seedVenueIds,
      }),
    )
    .slice(0, 3)
  const resultQuality = buildResultQuality(rawModelCandidates.length ? rawModelCandidates : candidates, rankedCandidates, {
    seedVenueIds: options.seedVenueIds,
    modelNeedsMoreEvidence: Boolean(result?.needsMoreEvidence),
  })

  const rawSummary = String(result?.summary ?? '').trim()
  const summary =
    rawSummary && !/^short visual summary$/i.test(rawSummary)
      ? rawSummary
      : String(options.searchPlan?.summary ?? 'No visual summary returned.')

  return {
    summary,
    imageEvidence,
    candidates: rankedCandidates,
    needsMoreEvidence: Boolean(result?.needsMoreEvidence) || resultQuality.notEnoughEvidence,
    resultQuality,
    ...(rankingDebug ? { rankingDebug } : {}),
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
