import 'dotenv/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import OpenAI from 'openai'
import Exa from 'exa-js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
  },
})

const port = Number(process.env.SF_FOOD_GUESSER_API_PORT ?? 5174)
const provider = process.env.OPENROUTER_API_KEY
  ? 'openrouter'
  : process.env.OPENAI_API_KEY
    ? 'openai'
    : null
const model =
  process.env.OPENROUTER_VISION_MODEL ??
  process.env.OPENAI_VISION_MODEL ??
  (provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4.1-mini')
const openRouterFallbackModels = (process.env.OPENROUTER_FALLBACK_MODELS ?? '')
  .split(',')
  .map((fallbackModel) => fallbackModel.trim())
  .filter(Boolean)
const serpApiKey = process.env.SERPAPI_API_KEY
const exaApiKey = process.env.EXA_API_KEY
const exaClient = exaApiKey ? new Exa(exaApiKey) : null
const maxExternalPhotoImagesForVision = 4
const evidenceSearchTimeoutMs = 45_000
const evidenceCategories = [
  'visible_text',
  'interior_match',
  'storefront_match',
  'packaging_logo',
  'dish_match',
  'gps_match',
  'web_source_match',
]

function parseModelJson(outputText) {
  const jsonStart = outputText.indexOf('{')
  const jsonEnd = outputText.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Model did not return JSON.')
  }

  return JSON.parse(outputText.slice(jsonStart, jsonEnd + 1))
}

function getSourceName(url, fallback = 'Exa') {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return String(fallback ?? 'Exa')
  }
}

function createDefaultClient(visionProvider) {
  return visionProvider === 'openrouter'
    ? new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'http://127.0.0.1:5173',
          'X-OpenRouter-Title': 'SF Food Guesser',
        },
      })
    : visionProvider === 'openai'
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null
}

function uniqueModels(models) {
  return [...new Set(models.map(String).map((item) => item.trim()).filter(Boolean))]
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

async function repairModelJson({
  visionClient,
  visionProvider,
  visionModel,
  outputText,
}) {
  const prompt = `Repair this model response into valid strict JSON only. Preserve the same fields and meaning. Do not add markdown, comments, or explanation.

Expected top-level shape:
{
  "summary": "short visual summary",
  "imageEvidence": ["specific image evidence"],
  "candidates": [],
  "needsMoreEvidence": true
}

Model response to repair:
${outputText}`

  if (visionProvider === 'openrouter') {
    const result = await visionClient.chat.completions.create({
      model: visionModel,
      messages: [
        {
          role: 'system',
          content: 'You repair malformed JSON into parseable JSON. Return JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2200,
    })

    return result.choices?.[0]?.message?.content ?? ''
  }

  const result = await visionClient.responses.create({
    model: visionModel,
    input: [
      {
        role: 'system',
        content: 'You repair malformed JSON into parseable JSON. Return JSON only.',
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ],
    temperature: 0,
    max_output_tokens: 2200,
  })

  return result.output_text ?? ''
}

function buildAnalysisPrompt(compactVenues) {
  return `Analyze this uploaded image and identify the most likely San Francisco restaurant, cafe, bakery, counter, or bar it came from.

Use both:
1. the uploaded image itself, and
2. broad web search when useful, especially for signs, menu text, dish names, packaging, interior details, storefronts, captions/screenshots, or neighborhood hints.

If the photo shows the interior of a store, dining room, counter, bar, wall art, lighting, tile, tables, menu boards, display cases, murals, plants, windows, flooring, shelving, or other room details, treat those as primary evidence. Search for public photo/review pages and venue pages that could show matching interiors, including Google Maps / Google Business Profile pages when surfaced by search, Yelp photo pages, Tripadvisor, restaurant websites, Instagram/TikTok captions, food blogs, Eater, Infatuation, Michelin, and local press.

Use interior/storefront evidence more heavily than generic dish evidence. A croissant, pizza slice, latte, or sandwich alone is usually not enough. A matching counter, mural, menu board, tile wall, logo, plate, cup, bag, or window view is much stronger.

The JSON venue list below is only a seed dataset. It is not the full search space. If web evidence points to a better San Francisco venue that is not in the seed list, return it as a web-discovered candidate with no seed id.

Return strict JSON only with this shape:
{
  "summary": "short visual summary",
  "imageEvidence": ["specific image evidence that helped identify the place"],
  "candidates": [
    {
      "id": "seed venue id when it matches, otherwise empty string",
      "name": "venue name",
      "category": "Restaurant/Cafe/Bakery/Counter/Dessert/Late night",
      "neighborhood": "SF neighborhood if known",
      "address": "street address if found",
      "confidence": 0-100,
      "evidenceType": "interior/storefront/menu/packaging/dish/gps/mixed",
      "evidenceCategories": ["visible_text", "interior_match", "web_source_match"],
      "reasons": ["specific image evidence", "specific web evidence or seed dataset evidence"],
      "sourceUrls": ["supporting URL"],
      "comparisonPhotos": [{"title": "photo title", "source": "Google Maps/Yelp/site/etc", "url": "page or image URL", "matchReason": "why this external photo visually matches"}],
      "mapsQuery": "venue name and address for maps",
      "searchQueries": ["search query you used or would use to verify this match"]
    }
  ],
  "needsMoreEvidence": true/false
}

Rules:
- Do not invent unsupported venues. Use web evidence or the seed dataset.
- Do not use live hours, reviews, or unsupported claims.
- Base the ranking on what can be inferred from the uploaded image, any embedded location context, the seed dataset, and web evidence.
- If signage, menu text, street signs, dish shape, packaging, or interior details are visible, use them as image evidence.
- Search broadly across the internet for San Francisco-specific matches when the seed list is insufficient.
- For interior photos, explicitly search for matching interiors and public customer/business photos; do not stop after matching the food item.
- Prefer candidates with matching interior/storefront/photo-page evidence over candidates that only share a common dish.
- Use evidenceCategories to make the evidence explicit. Choose from: visible_text, interior_match, storefront_match, packaging_logo, dish_match, gps_match, web_source_match.
- Use dish_match only when the only strong overlap is the food or drink itself. Use interior_match, storefront_match, visible_text, or packaging_logo when those stronger clues are present.
- Return 3-5 candidates when uncertainty remains.
- Keep each candidate concise: at most 2 reasons, at most 3 sourceUrls, and at most 2 comparisonPhotos.
- Return syntactically valid JSON only: no markdown, no comments, no trailing commas, and no truncated arrays.
- If the photo is too ambiguous, still return the best candidates but set needsMoreEvidence true and keep confidence modest.
- Use exact ids only for seed venues. Leave id empty for web-discovered candidates.

Seed venue list:
${JSON.stringify(compactVenues)}`
}

function buildSearchPlanPrompt() {
  return `Look at the uploaded image and create a web/photo-search plan to identify the San Francisco restaurant, cafe, bakery, counter, or bar.

Return strict JSON only:
{
  "summary": "what the uploaded image shows",
  "imageEvidence": ["specific visual details to search for"],
  "searchQueries": ["5-8 targeted search queries for Google Maps/Yelp/review/photo pages"],
  "likelyVenueTypes": ["Cafe/Restaurant/Bakery/Counter/etc"]
}

Rules:
- Focus heavily on interior/storefront clues: wall color, tile, counters, menu boards, display cases, seating, lighting, murals, windows, bags, cups, plates, and logos.
- Include queries aimed at public photos and reviews, such as Google Maps photos, Yelp photos, Tripadvisor photos, restaurant websites, Instagram captions, TikTok captions, local food blogs, Eater, Infatuation, and Michelin.
- Do not guess a final venue yet. This is only the search plan.`
}

function buildSearchEvidencePrompt(compactVenues, searchPlan, photoEvidence, webEvidence) {
  return `${buildAnalysisPrompt(compactVenues)}

External photo/review search plan:
${JSON.stringify(searchPlan)}

External web/review pages collected from search providers:
${JSON.stringify(
  webEvidence.slice(0, 12).map((page, index) => ({
    index: index + 1,
    title: page.title,
    source: page.source,
    query: page.query,
    url: page.url,
    snippet: page.snippet,
  })),
)}

External candidate photos collected from search providers:
${JSON.stringify(
  photoEvidence.slice(0, 10).map((photo, index) => ({
    index: index + 1,
    title: photo.title,
    source: photo.source,
    query: photo.query,
    pageUrl: photo.pageUrl,
    imageUrl: photo.imageUrl,
    placeTitle: photo.placeTitle,
    placeAddress: photo.placeAddress,
  })),
)}

Important:
- Compare the uploaded image against the external candidate photos, especially Google Maps review/customer photos. Use visual overlap with interiors, storefronts, counters, menu boards, decor, lighting, walls, display cases, cups, plates, employee aprons, shelves, bags, bottles, and packaging.
- Use external web/review pages to discover candidate venue names, addresses, neighborhoods, and pages likely to contain matching public photos.
- Do not pick a candidate just because it has similar food. Similar interiors/photo-page evidence should outrank generic dish matches.
- For every returned candidate, include comparisonPhotos showing which external candidate photos supported it.
- Keep the JSON short and valid. Prefer fewer well-supported candidates over a long malformed response.`
}

function buildOpenRouterPhotoEvidenceParts(photoEvidence, includeExternalPhotoImages = true) {
  return photoEvidence.flatMap((photo, index) => [
    {
      type: 'text',
      text: `External candidate photo ${index + 1}: ${photo.title} | ${photo.source} | ${photo.pageUrl}`,
    },
    ...(includeExternalPhotoImages && index < maxExternalPhotoImagesForVision && photo.imageUrl
      ? [
          {
            type: 'image_url',
            image_url: {
              url: photo.imageUrl,
              detail: 'low',
            },
          },
        ]
      : []),
  ])
}

function buildOpenAIPhotoEvidenceParts(photoEvidence, includeExternalPhotoImages = true) {
  return photoEvidence.flatMap((photo, index) => [
    {
      type: 'input_text',
      text: `External candidate photo ${index + 1}: ${photo.title} | ${photo.source} | ${photo.pageUrl}`,
    },
    ...(includeExternalPhotoImages && index < maxExternalPhotoImagesForVision && photo.imageUrl
      ? [
          {
            type: 'input_image',
            image_url: photo.imageUrl,
            detail: 'low',
          },
        ]
      : []),
  ])
}

function normalizeSearchPlan(plan) {
  const searchQueries = Array.isArray(plan.searchQueries)
    ? plan.searchQueries.map(String).filter(Boolean).slice(0, 8)
    : []

  return {
    summary: String(plan.summary ?? ''),
    imageEvidence: Array.isArray(plan.imageEvidence)
      ? plan.imageEvidence.map(String).filter(Boolean).slice(0, 12)
      : [],
    searchQueries,
    likelyVenueTypes: Array.isArray(plan.likelyVenueTypes)
      ? plan.likelyVenueTypes.map(String).filter(Boolean).slice(0, 6)
      : [],
  }
}

function normalizeEvidenceCategories(candidate) {
  const rawCategories = Array.isArray(candidate.evidenceCategories)
    ? candidate.evidenceCategories
    : candidate.evidenceType
      ? [candidate.evidenceType]
      : []
  const text = [
    candidate.evidenceType,
    ...(candidate.reasons ?? []),
    ...(candidate.sourceUrls ?? []),
  ]
    .join(' ')
    .toLowerCase()
  const categories = new Set(
    rawCategories
      .map((category) => String(category).toLowerCase().replace(/[^a-z0-9]+/g, '_'))
      .filter((category) => evidenceCategories.includes(category)),
  )

  const hasReliableVisibleText =
    /\b(readable|reads|says|spells|venue name|store name|sign says|label says|logo says|menu says|receipt says|visible sign)\b/.test(
      text,
    ) && !/\b(blurred|unreadable|blank|white label|no readable)\b/.test(text)

  if (categories.has('visible_text') && !hasReliableVisibleText) {
    categories.delete('visible_text')
  }

  if (hasReliableVisibleText) {
    categories.add('visible_text')
  }
  if (/\b(interior|inside|tile|counter|wall|mural|lighting|display case|seating|decor|room)\b/.test(text)) {
    categories.add('interior_match')
  }
  if (/\b(storefront|exterior|awning|window|street|facade)\b/.test(text)) {
    categories.add('storefront_match')
  }
  if (/\b(packaging|branded|logo|bag|box|sticker|sleeve)\b/.test(text)) {
    categories.add('packaging_logo')
  }
  if (/\b(dish|food|drink|matcha|coffee|latte|pastry|croissant|sandwich|pizza|noodle|dumpling|bun)\b/.test(text)) {
    categories.add('dish_match')
  }
  if (/\b(gps|location metadata|exif)\b/.test(text)) {
    categories.add('gps_match')
  }
  if ((candidate.sourceUrls ?? []).length || /\b(web|source|review|yelp|eater|infatuation|instagram|tiktok|maps)\b/.test(text)) {
    categories.add('web_source_match')
  }

  return [...categories]
}

function scoreEvidenceCategories(categories, options = {}) {
  const hasExternalPhotoMatch = Boolean(options.hasExternalPhotoMatch)
  const weights = {
    visible_text: 28,
    packaging_logo: 24,
    interior_match: hasExternalPhotoMatch ? 22 : 8,
    storefront_match: hasExternalPhotoMatch ? 22 : 8,
    gps_match: 20,
    web_source_match: 14,
    dish_match: 6,
  }
  return categories.reduce((score, category) => score + (weights[category] ?? 0), 0)
}

function evidenceNote(category) {
  const notes = {
    visible_text: 'Matched visible text from the photo.',
    packaging_logo: 'Matched packaging, logo, or branded item details.',
    interior_match: 'Matched interior details from the uploaded image.',
    storefront_match: 'Matched storefront or exterior details.',
    gps_match: 'Matched location metadata from the uploaded photo.',
    web_source_match: 'Found supporting web evidence for this venue.',
  }

  return notes[category] ?? null
}

export function rerankCandidates(rawCandidates = [], options = {}) {
  const seedVenueIds = new Set(options.seedVenueIds ?? [])
  const trustedPhotoUrls = new Set(options.photoEvidenceUrls ?? [])

  return rawCandidates
    .map((candidate, originalIndex) => {
      const evidenceCategoriesForCandidate = normalizeEvidenceCategories(candidate)
      const strongEvidence = evidenceCategoriesForCandidate.filter(
        (category) => category !== 'dish_match',
      )
      const hasExternalPhotoMatch =
        Array.isArray(candidate.comparisonPhotos) &&
        candidate.comparisonPhotos.some((photo) => trustedPhotoUrls.has(photo.url))
      const hasSeedMatch = Boolean(candidate.id) && seedVenueIds.has(candidate.id)
      const hasIdentityEvidence = evidenceCategoriesForCandidate.some((category) =>
        ['visible_text', 'gps_match'].includes(category),
      )
      const hasLogoEvidence = evidenceCategoriesForCandidate.includes('packaging_logo')
      const isWebDiscovered = !hasSeedMatch
      const hasHardVenueEvidence =
        hasSeedMatch ||
        hasExternalPhotoMatch ||
        hasIdentityEvidence ||
        hasLogoEvidence
      const hasUnverifiedVisualClaim =
        !hasExternalPhotoMatch &&
        evidenceCategoriesForCandidate.some((category) =>
          ['interior_match', 'storefront_match'].includes(category),
        )
      const dishOnly =
        evidenceCategoriesForCandidate.includes('dish_match') && strongEvidence.length === 0
      const hasSource = Array.isArray(candidate.sourceUrls) && candidate.sourceUrls.length > 0
      const hasReasons = Array.isArray(candidate.reasons) && candidate.reasons.length > 0
      const baseConfidence = Math.max(0, Math.min(100, Number(candidate.confidence ?? 0)))
      const evidenceScore = scoreEvidenceCategories(evidenceCategoriesForCandidate, {
        hasExternalPhotoMatch,
      })
      const sourceScore = hasSource ? (hasHardVenueEvidence ? 8 : 2) : -8
      const reasonScore = hasReasons ? Math.min(8, candidate.reasons.length * 2) : -6
      const dishOnlyPenalty = dishOnly ? -28 : 0
      const rawAdjustedScore = Math.max(
        0,
        Math.min(100, baseConfidence * 0.62 + evidenceScore + sourceScore + reasonScore + dishOnlyPenalty),
      )
      const confidenceCap =
        dishOnly
          ? 42
          : isWebDiscovered && !hasIdentityEvidence && !hasExternalPhotoMatch
            ? 58
            : isWebDiscovered && !hasIdentityEvidence && hasUnverifiedVisualClaim
              ? 68
              : isWebDiscovered && !hasIdentityEvidence
                ? hasLogoEvidence
                  ? 78
                  : 72
                : !hasHardVenueEvidence && hasUnverifiedVisualClaim
                  ? 68
                  : !hasHardVenueEvidence
                    ? 74
                    : 100
      const adjustedScore = Math.min(rawAdjustedScore, confidenceCap)
      const adjustedConfidence = Math.round(adjustedScore)
      const rankingNotes = [
        ...strongEvidence.map(evidenceNote).filter(Boolean),
        ...(dishOnly ? ['Food/drink similarity alone is weak evidence, so this was ranked lower.'] : []),
        ...(hasUnverifiedVisualClaim
          ? ['Interior/storefront similarity was not verified against external photos, so confidence is capped.']
          : []),
        ...(isWebDiscovered && !hasIdentityEvidence
          ? [
              'No readable venue name, GPS, or unique identity clue was verified, so this web-discovered guess is capped.',
            ]
          : []),
        ...(hasSource ? ['Supporting source links were found for this venue.'] : ['No supporting source link was returned for this candidate.']),
      ]

      return {
        ...candidate,
        id: hasSeedMatch ? candidate.id : '',
        confidence: adjustedConfidence,
        originalConfidence: baseConfidence,
        evidenceCategories: evidenceCategoriesForCandidate,
        rankingNotes,
        _rankScore: adjustedScore,
        _originalIndex: originalIndex,
      }
    })
    .sort((a, b) => b._rankScore - a._rankScore || a._originalIndex - b._originalIndex)
    .map(({ _rankScore, _originalIndex, ...candidate }) => candidate)
}

function buildSourceSearches(rawQuery) {
  const query = String(rawQuery).trim()
  if (!query) return []

  return [
    {
      query: `${query} San Francisco cafe restaurant interior reviews photos Yelp Google Maps`,
      label: 'broad-web',
      numResults: 8,
    },
    {
      query: `${query} San Francisco Yelp photos reviews cafe restaurant interior`,
      label: 'yelp-photos',
      numResults: 5,
      includeDomains: ['yelp.com'],
    },
    {
      query: `${query} San Francisco Eater Infatuation food blog restaurant cafe interior`,
      label: 'editorial-guides',
      numResults: 5,
      includeDomains: ['eater.com', 'theinfatuation.com', 'sf.eater.com'],
    },
    {
      query: `${query} San Francisco Instagram TikTok cafe restaurant matcha coffee pastry interior`,
      label: 'social-captions',
      numResults: 5,
      includeDomains: ['instagram.com', 'tiktok.com'],
    },
  ]
}

async function describeForExternalPhotoSearch({
  visionClient,
  visionProvider,
  visionModel,
  imageDataUrl,
}) {
  const prompt = buildSearchPlanPrompt()

  if (visionProvider === 'openrouter') {
    const result = await visionClient.chat.completions.create({
      model: visionModel,
      messages: [
        {
          role: 'system',
          content:
            'You inspect uploaded images and produce targeted search plans for finding matching restaurant, cafe, bakery, counter, or bar interiors and public photo pages.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 800,
    })

    return normalizeSearchPlan(parseModelJson(result.choices?.[0]?.message?.content ?? '{}'))
  }

  const result = await visionClient.responses.create({
    model: visionModel,
    input: [
      {
        role: 'system',
        content:
          'You inspect uploaded images and produce targeted search plans for finding matching restaurant, cafe, bakery, counter, or bar interiors and public photo pages.',
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' },
        ],
      },
    ],
    temperature: 0.1,
    max_output_tokens: 800,
  })

  return normalizeSearchPlan(parseModelJson(result.output_text ?? '{}'))
}

export async function searchSerpApiPhotos(searchQueries) {
  const photos = []
  const seen = new Set()
  const seenPlaces = new Set()

  for (const rawQuery of searchQueries.slice(0, 3)) {
    const query = `${rawQuery} San Francisco cafe restaurant`
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google_maps')
    url.searchParams.set('q', query)
    url.searchParams.set('ll', '@37.7749,-122.4194,12z')
    url.searchParams.set('hl', 'en')
    url.searchParams.set('api_key', serpApiKey)

    const response = await fetch(url)
    if (!response.ok) continue
    const result = await response.json()
    const places = Array.isArray(result.local_results) ? result.local_results : []

    for (const place of places.slice(0, 3)) {
      if (!place.data_id || seenPlaces.has(place.data_id)) continue
      seenPlaces.add(place.data_id)

      const photosUrl = new URL('https://serpapi.com/search.json')
      photosUrl.searchParams.set('engine', 'google_maps_photos')
      photosUrl.searchParams.set('data_id', String(place.data_id))
      photosUrl.searchParams.set('hl', 'en')
      photosUrl.searchParams.set('api_key', serpApiKey)

      const photosResponse = await fetch(photosUrl)
      if (!photosResponse.ok) continue
      const photosResult = await photosResponse.json()
      const mapsPhotos = Array.isArray(photosResult.photos) ? photosResult.photos : []

      for (const photo of mapsPhotos.slice(0, 4)) {
        const imageUrl = photo.image || photo.thumbnail
        if (!imageUrl || seen.has(imageUrl)) continue
        seen.add(imageUrl)
        photos.push({
          title: `${String(place.title ?? 'Google Maps place')} customer photo`,
          source: 'Google Maps reviews/photos',
          pageUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            [place.title, place.address].filter(Boolean).join(' '),
          )}`,
          imageUrl: String(imageUrl),
          thumbnailUrl: photo.thumbnail ? String(photo.thumbnail) : String(imageUrl),
          query,
          placeTitle: String(place.title ?? ''),
          placeAddress: String(place.address ?? ''),
          placeDataId: String(place.data_id),
          placeId: place.place_id ? String(place.place_id) : undefined,
          mapsQuery: [place.title, place.address].filter(Boolean).join(' '),
          gpsCoordinates: place.gps_coordinates ?? null,
        })
        if (photos.length >= 18) return photos
      }
    }
  }

  return photos.slice(0, 18)
}

function createDefaultPhotoSearch() {
  return serpApiKey
    ? {
        provider: 'serpapi-google-maps-photos',
        search: searchSerpApiPhotos,
      }
    : null
}

export async function searchExaWeb(searchQueries, searchClient = exaClient) {
  const pages = []
  const seen = new Set()

  if (!searchClient) return pages

  const searches = searchQueries.slice(0, 3).flatMap(buildSourceSearches)
  const settledSearches = await Promise.allSettled(
    searches.map(async (search) => {
      const result = await searchClient.search(search.query, {
        type: 'deep',
        numResults: search.numResults,
        ...(search.includeDomains ? { includeDomains: search.includeDomains } : {}),
        contents: {
          highlights: true,
        },
      })

      return (Array.isArray(result.results) ? result.results : []).map((item) => {
        const url = item.url || item.id
        const highlights = Array.isArray(item.highlights) ? item.highlights : []
        return {
          title: String(item.title ?? 'Candidate page'),
          source: getSourceName(url, item.author),
          url: String(url),
          snippet: highlights.join(' ').slice(0, 900),
          query: search.query,
          searchLabel: search.label,
        }
      })
    }),
  )

  for (const settledSearch of settledSearches) {
    if (settledSearch.status !== 'fulfilled') continue
    for (const page of settledSearch.value) {
      if (!page.url || seen.has(page.url)) continue
      seen.add(page.url)
      pages.push(page)
      if (pages.length >= 20) {
        return pages
      }
    }
  }

  return pages.slice(0, 20)
}

function createDefaultWebSearch() {
  return exaClient
    ? {
        provider: 'exa-deep-highlights',
        search: searchExaWeb,
      }
    : null
}

function providerWarning(providerName, error) {
  return {
    provider: providerName,
    message:
      error instanceof Error
        ? error.message
        : `${providerName} was unavailable for this request.`,
  }
}

function analysisFailureMessage(error, visionProvider) {
  const providerName = visionProvider === 'openrouter' ? 'OpenRouter' : 'OpenAI'
  const status = Number(error?.status ?? error?.code ?? 0)
  const message =
    error instanceof Error
      ? error.message
      : typeof error?.message === 'string'
        ? error.message
        : ''

  if (status === 401 || /api key|unauthorized|authentication/i.test(message)) {
    return `${providerName} rejected the API key. Check the local .env key, then restart npm run dev.`
  }

  if (status === 402 || /more credits|billing|quota|can only afford/i.test(message)) {
    return `${providerName} needs more credits for photo analysis. Add credits or switch to a direct OpenAI key in the local .env, then restart npm run dev.`
  }

  if (status === 429 || /rate limit/i.test(message)) {
    return `${providerName} is rate limiting photo analysis. Wait a bit, then try the upload again.`
  }

  return 'The photo analysis failed. Try again in a moment or restart the dev server.'
}

async function analyzeWithProvider({
  visionClient,
  visionProvider,
  visionModel,
  imageDataUrl,
  compactVenues,
  searchPlan = null,
  photoEvidence = [],
  webEvidence = [],
  includeExternalPhotoImages = true,
  includeOpenRouterWebSearch = true,
}) {
  const systemPrompt =
    'You identify likely San Francisco food venues from uploaded food, interior, storefront, menu, receipt, or street-context images. Use the uploaded image itself as the source of evidence, be honest about uncertainty, and use the provided venue list only as seed data. You may return web-discovered San Francisco venues outside the seed list when supported by web evidence.'
  const analysisPrompt =
    photoEvidence.length > 0 || webEvidence.length > 0
      ? buildSearchEvidencePrompt(compactVenues, searchPlan, photoEvidence, webEvidence)
      : buildAnalysisPrompt(compactVenues)

  if (visionProvider === 'openrouter') {
    const result = await visionClient.chat.completions.create({
      model: visionModel,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: analysisPrompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
                detail: 'high',
              },
            },
            ...buildOpenRouterPhotoEvidenceParts(photoEvidence, includeExternalPhotoImages),
          ],
        },
      ],
      response_format: { type: 'json_object' },
      ...(includeOpenRouterWebSearch
        ? {
            tools: [
              {
                type: 'openrouter:web_search',
                parameters: {
                  engine: 'auto',
                  max_results: 10,
                  max_total_results: 40,
                  search_context_size: 'high',
                  user_location: {
                    type: 'approximate',
                    city: 'San Francisco',
                    region: 'California',
                    country: 'US',
                    timezone: 'America/Los_Angeles',
                  },
                },
              },
            ],
          }
        : {}),
      temperature: 0.1,
      max_tokens: 2200,
    })

    return result.choices?.[0]?.message?.content ?? ''
  }

  const result = await visionClient.responses.create({
    model: visionModel,
    input: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: analysisPrompt,
          },
          {
            type: 'input_image',
            image_url: imageDataUrl,
            detail: 'high',
          },
          ...buildOpenAIPhotoEvidenceParts(photoEvidence, includeExternalPhotoImages),
        ],
      },
    ],
    temperature: 0.1,
    max_output_tokens: 2200,
  })

  return result.output_text ?? ''
}

export function createApp(options = {}) {
  const hasOpenAIClient = Object.hasOwn(options, 'openAIClient')
  const hasVisionClient = Object.hasOwn(options, 'visionClient')
  const hasVisionProvider = Object.hasOwn(options, 'visionProvider')
  const visionModel = options.visionModel ?? model
  const visionProvider =
    hasVisionProvider
      ? options.visionProvider
      : provider ??
        (hasVisionClient
          ? options.visionClient
            ? 'openai'
            : null
          : hasOpenAIClient && options.openAIClient
            ? 'openai'
            : null)
  const visionClient = hasVisionClient
    ? options.visionClient
    : hasOpenAIClient
      ? options.openAIClient
      : createDefaultClient(visionProvider)
  const visionFallbackModels = uniqueModels(
    options.visionFallbackModels ??
      (visionProvider === 'openrouter' ? openRouterFallbackModels : []),
  ).filter((fallbackModel) => fallbackModel !== visionModel)
  const visionModelAttempts = uniqueModels([visionModel, ...visionFallbackModels])
  const hasPhotoSearch = Object.hasOwn(options, 'photoSearch')
  const photoSearch = hasPhotoSearch ? options.photoSearch : createDefaultPhotoSearch()
  const hasWebSearch = Object.hasOwn(options, 'webSearch')
  const webSearch = hasWebSearch ? options.webSearch : createDefaultWebSearch()

  const app = express()

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      visionEnabled: Boolean(visionClient),
      model: visionModel,
      fallbackModels: visionFallbackModels,
      provider: visionProvider,
      photoSearchEnabled: Boolean(photoSearch),
      photoSearchProvider: photoSearch?.provider ?? null,
      webSearchEnabled: Boolean(webSearch),
      webSearchProvider: webSearch?.provider ?? null,
    })
  })

  app.post('/api/analyze-photo', upload.single('photo'), async (request, response) => {
    if (!visionClient) {
      response.status(503).json({
        error:
          'Photo analysis needs OPENROUTER_API_KEY or OPENAI_API_KEY in .env. Add one, then restart npm run dev.',
      })
      return
    }

    if (!request.file) {
      response.status(400).json({ error: 'No photo was uploaded.' })
      return
    }

    let venues = []
    try {
      venues = JSON.parse(String(request.body.venues ?? '[]'))
    } catch {
      response.status(400).json({ error: 'Venue payload was not valid JSON.' })
      return
    }

    const compactVenues = venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      category: venue.category,
      neighborhood: venue.neighborhood,
      address: venue.address,
      signature: venue.signature,
      imageEvidenceHints: venue.imageEvidenceHints,
      note: venue.note,
    }))

    const imageDataUrl = `data:${request.file.mimetype};base64,${request.file.buffer.toString(
      'base64',
    )}`

    try {
      let searchPlan = null
      let photoEvidence = []
      let webEvidence = []
      const providerWarnings = []
      if (photoSearch?.search || webSearch?.search) {
        for (const modelAttempt of visionModelAttempts) {
          try {
            searchPlan = await describeForExternalPhotoSearch({
              visionClient,
              visionProvider,
              visionModel: modelAttempt,
              imageDataUrl,
            })
            break
          } catch (error) {
            providerWarnings.push(providerWarning(`search-plan:${modelAttempt}`, error))
          }
        }
      }

      if (searchPlan) {
        const evidenceSearches = []
        if (webSearch?.search) {
          evidenceSearches.push({
            type: 'web',
            provider: webSearch.provider ?? 'web-search',
            run: () =>
              withTimeout(
                webSearch.search(searchPlan.searchQueries),
                evidenceSearchTimeoutMs,
                webSearch.provider ?? 'web-search',
              ),
          })
        }
        if (photoSearch?.search) {
          evidenceSearches.push({
            type: 'photo',
            provider: photoSearch.provider ?? 'photo-search',
            run: () =>
              withTimeout(
                photoSearch.search(searchPlan.searchQueries),
                evidenceSearchTimeoutMs,
                photoSearch.provider ?? 'photo-search',
              ),
          })
        }

        const settledEvidence = await Promise.all(
          evidenceSearches.map(async (search) => {
            try {
              return {
                status: 'fulfilled',
                ...search,
                results: await search.run(),
              }
            } catch (error) {
              return {
                status: 'rejected',
                ...search,
                error,
              }
            }
          }),
        )

        for (const settledSearch of settledEvidence) {
          if (settledSearch.status !== 'fulfilled') {
            providerWarnings.push(providerWarning(settledSearch.provider, settledSearch.error))
            continue
          }
          if (settledSearch.type === 'web') webEvidence = settledSearch.results
          if (settledSearch.type === 'photo') photoEvidence = settledSearch.results
        }
      }

      let result = null
      let visionModelUsed = visionModel
      let lastVisionError = null
      const analysisAttempts = [
        {
          label: 'vision-analysis',
          includeExternalPhotoImages: true,
          includeOpenRouterWebSearch: true,
        },
        {
          label: 'vision-analysis-fallback',
          includeExternalPhotoImages: false,
          includeOpenRouterWebSearch: false,
        },
      ]
      for (const modelAttempt of visionModelAttempts) {
        for (const attempt of analysisAttempts) {
          try {
            const outputText = await analyzeWithProvider({
              visionClient,
              visionProvider,
              visionModel: modelAttempt,
              imageDataUrl,
              compactVenues,
              searchPlan,
              photoEvidence,
              webEvidence,
              includeExternalPhotoImages: attempt.includeExternalPhotoImages,
              includeOpenRouterWebSearch: attempt.includeOpenRouterWebSearch,
            })
            try {
              result = parseModelJson(outputText)
            } catch (parseError) {
              providerWarnings.push(
                providerWarning(`${attempt.label}-json:${modelAttempt}`, parseError),
              )
              const repairedOutputText = await repairModelJson({
                visionClient,
                visionProvider,
                visionModel: modelAttempt,
                outputText,
              })
              result = parseModelJson(repairedOutputText)
            }
            visionModelUsed = modelAttempt
            break
          } catch (error) {
            providerWarnings.push(providerWarning(`${attempt.label}:${modelAttempt}`, error))
            lastVisionError = error
            if (error instanceof Error && error.message === 'Model did not return JSON.') {
              break
            }
          }
        }
        if (result) break
      }
      if (!result) throw lastVisionError ?? new Error('No vision model returned an analysis.')
      const photoEvidenceUrls = photoEvidence.flatMap((photo) =>
        [photo.pageUrl, photo.imageUrl, photo.thumbnailUrl].filter(Boolean),
      )
      const candidates = rerankCandidates(Array.isArray(result.candidates) ? result.candidates : [], {
        seedVenueIds: compactVenues.map((venue) => venue.id),
        photoEvidenceUrls,
      })
      const topConfidence = candidates[0]?.confidence ?? 0
      const closeCandidateCount = candidates.filter(
        (candidate) => topConfidence - candidate.confidence <= 6,
      ).length
      const needsMoreEvidence =
        Boolean(result.needsMoreEvidence) ||
        candidates.length === 0 ||
        topConfidence < 80 ||
        closeCandidateCount > 1
      response.json({
        ...result,
        candidates,
        needsMoreEvidence,
        searchPlan,
        photoEvidence: photoEvidence.map((photo) => ({
          title: photo.title,
          source: photo.source,
          pageUrl: photo.pageUrl,
          thumbnailUrl: photo.thumbnailUrl,
          query: photo.query,
          placeTitle: photo.placeTitle,
          placeAddress: photo.placeAddress,
        })),
        webEvidence: webEvidence.map((page) => ({
          title: page.title,
          source: page.source,
          url: page.url,
          snippet: page.snippet,
          query: page.query,
          searchLabel: page.searchLabel,
        })),
        searchProvider: photoSearch?.provider ?? null,
        webSearchProvider: webSearch?.provider ?? null,
        visionModel: visionModelUsed,
        providerWarnings,
      })
    } catch (error) {
      console.error(error)
      response.status(500).json({
        error: analysisFailureMessage(error, visionProvider),
      })
    }
  })

  return app
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`SF Food Guesser API running at http://127.0.0.1:${port}`)
  })
}
