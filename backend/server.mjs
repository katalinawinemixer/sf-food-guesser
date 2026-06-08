import 'dotenv/config'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { createProviderConfig } from './providers.mjs'
import { buildCacheStatus, buildProviderStatus } from '../shared/analysis-diagnostics.js'
import { buildResultQuality, candidatePassesQualityGate, isPlaceholderCandidateName } from '../shared/candidate-quality.js'
import { goldenAnalysisFixtures } from '../shared/golden-fixtures.js'
import { venues as seedVenues } from '../shared/venues.js'

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
const defaultAllowedOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  ...parseAllowedOrigins(process.env.SF_FOOD_GUESSER_ALLOWED_ORIGINS),
]

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: 2,
  },
  fileFilter: (_request, file, callback) => {
    if (isSupportedImageUpload(file)) {
      callback(null, true)
      return
    }

    const error = new Error(
      'Unsupported image type. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.',
    )
    error.status = 415
    error.code = 'UNSUPPORTED_IMAGE_TYPE'
    callback(error)
  },
})

const port = Number(process.env.SF_FOOD_GUESSER_API_PORT ?? 5174)
const defaultFeedbackLogPath = resolve(process.cwd(), 'data', 'feedback.jsonl')
const defaultRunLogPath = resolve(process.cwd(), 'data', 'runs.jsonl')
const maxExternalPhotoImagesForVision = 4
const evidenceSearchTimeoutMs = 45_000
const visionRequestTimeoutMs = 60_000
const embeddingFetchTimeoutMs = 7_000
const evidenceCategories = [
  'visible_text',
  'interior_match',
  'storefront_match',
  'packaging_logo',
  'dish_match',
  'gps_match',
  'web_source_match',
]
const compactSeedVenues = seedVenues.map((venue) => ({
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
  sourceUrl: venue.sourceUrl,
  note: venue.note,
}))

function parseAllowedOrigins(value = '') {
  return String(value)
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

function isSupportedImageUpload(file) {
  const mimeType = String(file?.mimetype ?? '').toLowerCase()
  const fileName = String(file?.originalname ?? '')
  return allowedImageMimeTypes.has(mimeType) || allowedImageExtensions.test(fileName)
}

function looksLikeSupportedImage(buffer) {
  if (!buffer || buffer.length < 4) return false
  const ascii = (start, end) => buffer.subarray(start, end).toString('ascii')

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return true
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true
  if (ascii(4, 8) === 'ftyp') {
    return ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(8, 12))
  }

  return false
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true
  const normalizedOrigin = origin.replace(/\/$/, '')
  return allowedOrigins.includes('*') || allowedOrigins.includes(normalizedOrigin)
}

function applyCors(app, allowedOrigins) {
  app.use((request, response, next) => {
    const origin = request.get('origin')
    const requestedHeaders = request.get('access-control-request-headers')

    if (origin && isAllowedOrigin(origin, allowedOrigins)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      response.setHeader('Access-Control-Allow-Credentials', 'true')
      response.setHeader(
        'Access-Control-Allow-Headers',
        requestedHeaders || 'Content-Type, Authorization',
      )
    }

    if (request.method === 'OPTIONS') {
      response.status(isAllowedOrigin(origin, allowedOrigins) ? 204 : 403).end()
      return
    }

    if (origin && !isAllowedOrigin(origin, allowedOrigins) && request.path.startsWith('/api/')) {
      response.status(403).json({
        error:
          'This API origin is not allowed. Add the deployed frontend URL to SF_FOOD_GUESSER_ALLOWED_ORIGINS.',
      })
      return
    }

    next()
  })
}

function checkLocalRateLimit(store, key, limit, windowSeconds) {
  if (!Number.isFinite(limit) || limit <= 0) return null
  const now = Date.now()
  const existing = store.get(key)
  const resetAt =
    existing && Number.isFinite(existing.resetAt) && existing.resetAt > now
      ? existing.resetAt
      : now + windowSeconds * 1000
  const count = existing && existing.resetAt === resetAt ? existing.count + 1 : 1
  store.set(key, { count, resetAt })
  if (count <= limit) return null
  return Math.max(1, Math.ceil((resetAt - now) / 1000))
}

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

function uniqueModels(models) {
  return [...new Set(models.map((model) => String(model).trim()).filter(Boolean))]
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

function imageDataUrl(buffer, mimeType = 'image/jpeg') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function createLocalImageEmbedding(buffer) {
  const raw = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 6, height: 6, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const values = [...raw].map((value) => value / 255)
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / magnitude)
}

export function cosineSimilarity(left = [], right = []) {
  const length = Math.min(left.length, right.length)
  if (!length) return 0
  let score = 0
  for (let index = 0; index < length; index += 1) {
    score += Number(left[index] ?? 0) * Number(right[index] ?? 0)
  }
  return Math.max(0, Math.min(1, score))
}

async function fetchBufferWithTimeout(url, timeoutMs = embeddingFetchTimeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function compareExternalPhotoEmbeddings({ uploadedBuffer, photoEvidence = [], enabled = false }) {
  if (!enabled || !photoEvidence.length) return { photos: photoEvidence, trustedUrls: [] }

  let uploadedEmbedding = null
  try {
    uploadedEmbedding = await createLocalImageEmbedding(uploadedBuffer)
  } catch {
    return { photos: photoEvidence, trustedUrls: [] }
  }

  const comparedPhotos = await Promise.all(
    photoEvidence.map(async (photo, index) => {
      if (index >= maxExternalPhotoImagesForVision) return photo
      const imageUrl = photo.imageUrl || photo.thumbnailUrl
      if (!imageUrl) return photo
      const buffer = await fetchBufferWithTimeout(imageUrl)
      if (!buffer) return photo
      try {
        const score = cosineSimilarity(uploadedEmbedding, await createLocalImageEmbedding(buffer))
        return {
          ...photo,
          visualSimilarityScore: Number(score.toFixed(3)),
        }
      } catch {
        return photo
      }
    }),
  )
  const trustedUrls = comparedPhotos
    .filter((photo) => Number(photo.visualSimilarityScore ?? 0) >= 0.86)
    .flatMap((photo) => [photo.pageUrl, photo.imageUrl, photo.thumbnailUrl].filter(Boolean))

  return { photos: comparedPhotos, trustedUrls }
}

function cropBounds(metadata, leftRatio, topRatio, widthRatio, heightRatio) {
  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0
  const width = Math.max(1, Math.min(imageWidth, Math.round(imageWidth * widthRatio)))
  const height = Math.max(1, Math.min(imageHeight, Math.round(imageHeight * heightRatio)))
  const left = Math.max(0, Math.min(imageWidth - width, Math.round(imageWidth * leftRatio)))
  const top = Math.max(0, Math.min(imageHeight - height, Math.round(imageHeight * topRatio)))

  return { left, top, width, height }
}

export async function buildUploadedImageViews(file) {
  const fallbackView = {
    label: 'full uploaded image, original encoding',
    dataUrl: imageDataUrl(file.buffer, file.mimetype || 'application/octet-stream'),
  }

  try {
    const normalizedBuffer = await sharp(file.buffer, { failOn: 'none' }).rotate().toBuffer()
    const metadata = await sharp(normalizedBuffer).metadata()

    if (!metadata.width || !metadata.height) return [fallbackView]

    const fullImage = await sharp(normalizedBuffer)
      .resize({ width: 900, height: 680, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 84 })
      .toBuffer()

    if (metadata.width < 300 || metadata.height < 300) {
      return [{ label: 'full uploaded image', dataUrl: imageDataUrl(fullImage) }]
    }

    const panelWidth = 420
    const panelHeight = 280
    const buildPanel = async (bounds = null, highContrast = false) => {
      let image = bounds ? sharp(normalizedBuffer).extract(bounds) : sharp(normalizedBuffer)
      if (highContrast) {
        image = image.grayscale().linear(1.85, -28).modulate({ brightness: 1.08 })
      }
      return image
        .resize({
          width: panelWidth,
          height: panelHeight,
          fit: bounds ? 'cover' : 'contain',
          background: '#ffffff',
          withoutEnlargement: false,
        })
        .jpeg({ quality: 84 })
        .toBuffer()
    }
    const cropPanels = await Promise.all([
      buildPanel(),
      buildPanel(cropBounds(metadata, 0, 0, 1, 0.55)),
      buildPanel(cropBounds(metadata, 0, 0.45, 1, 0.55)),
      buildPanel(cropBounds(metadata, 0, 0, 0.55, 1)),
      buildPanel(cropBounds(metadata, 0.45, 0, 0.55, 1)),
      buildPanel(cropBounds(metadata, 0.18, 0.18, 0.64, 0.64)),
      buildPanel(null, true),
      buildPanel(cropBounds(metadata, 0, 0.45, 1, 0.55), true),
      buildPanel(cropBounds(metadata, 0.15, 0.15, 0.7, 0.7), true),
    ])
    const canvasWidth = panelWidth * 3
    const canvasHeight = panelHeight * 3
    const contactSheet = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite(
        cropPanels.map((input, index) => ({
          input,
          left: (index % 3) * panelWidth,
          top: Math.floor(index / 3) * panelHeight,
        })),
      )
      .jpeg({ quality: 84 })
      .toBuffer()

    return [
      {
        label:
          'single contact sheet: row 1 has full image, background/interior crop, and foreground/food crop; row 2 has left, right, and center crops; row 3 has high-contrast full, foreground, and center text crops',
        dataUrl: imageDataUrl(contactSheet),
      },
    ]
  } catch {
    return [fallbackView]
  }
}

function buildOpenRouterUploadedImageParts(uploadedImageViews) {
  return uploadedImageViews.flatMap((view, index) => [
    {
      type: 'text',
      text: `Uploaded image ${index + 1}: ${view.label}. Inspect it for readable text, logos, packaging, menus, receipts, storefronts, and interior details. If it is a contact sheet, treat every panel as coming from the same uploaded photo.`,
    },
    {
      type: 'image_url',
      image_url: { url: view.dataUrl, detail: 'high' },
    },
  ])
}

function buildOpenAIUploadedImageParts(uploadedImageViews) {
  return uploadedImageViews.flatMap((view, index) => [
    {
      type: 'input_text',
      text: `Uploaded image ${index + 1}: ${view.label}. Inspect it for readable text, logos, packaging, menus, receipts, storefronts, and interior details. If it is a contact sheet, treat every panel as coming from the same uploaded photo.`,
    },
    {
      type: 'input_image',
      image_url: view.dataUrl,
      detail: 'high',
    },
  ])
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

Use interior/storefront evidence more heavily than generic dish evidence. A croissant, pizza slice, latte, or sandwich alone is usually not enough. A matching counter, mural, menu board, tile wall, plate, or window view is much stronger.

Treat visible text and branding carefully. Exact storefront/menu/receipt/venue-name text is strong evidence. Generic words, partial brand marks, sauce bottles, packaged goods, delivery bags, cups, or third-party branding are not enough for very high confidence unless the exact venue name is readable or web/photo evidence confirms that branding belongs to the venue shown.

You may receive a contact sheet built from the same uploaded image. Inspect every panel: full image, background/interior crop, foreground/food crop, left/right/center crops, and high-contrast text crops. Small logo, tray, cup, bag, label, receipt, menu, or storefront text may only be readable in a crop or high-contrast panel.

The JSON venue list below is only a seed dataset. It is not the full search space. If web evidence points to a better San Francisco venue that is not in the seed list, return it as a web-discovered candidate with no seed id.
Return only real named venues. Never invent placeholder candidates such as "Other Inner Richmond Cafe", "Unknown Mission Restaurant", or "Generic Matcha Cafe"; if the venue is uncertain, lower confidence and set needsMoreEvidence instead.
Seed fields named doNotInferFrom are negative constraints: do not use those clues as identity evidence unless stronger uploaded-photo or public-photo evidence confirms the venue.

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
      "photoEvidence": ["specific facts visible in the uploaded photo only"],
      "externalEvidence": ["specific supporting facts from web/search/photo evidence only"],
      "rankingRules": ["short notes about confidence caps or uncertainty"],
      "reasons": ["legacy combined reasons, keep concise"],
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
- If any readable brand or venue text is visible anywhere in the image or crops, copy the exact text into imageEvidence, create/search a candidate for that text first, and include visible_text only when the exact venue name is readable. Readable exact venue text outranks generic dish, plate, and interior similarity.
- Do not give a very high confidence score to a venue based only on packaging, cups, bottles, bags, or a partial logo. Keep those guesses moderate unless the exact venue name is visible.
- Search broadly across the internet for San Francisco-specific matches when the seed list is insufficient.
- For interior photos, explicitly search for matching interiors and public customer/business photos; do not stop after matching the food item.
- Prefer candidates with matching interior/storefront/photo-page evidence over candidates that only share a common dish.
- Use evidenceCategories to make the evidence explicit. Choose from: visible_text, interior_match, storefront_match, packaging_logo, dish_match, gps_match, web_source_match.
- Put uploaded-photo observations only in photoEvidence. Put articles, review pages, Google Maps/Yelp/public photos, or seed/source support only in externalEvidence. Put uncertainty and confidence caps in rankingRules.
- Use dish_match only when the only strong overlap is the food or drink itself. Use interior_match, storefront_match, visible_text, or packaging_logo when those stronger clues are present.
- Omit any candidate whose "name" is only a descriptive fallback or neighborhood/category phrase, not a real venue name.
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

You may receive a contact sheet built from the same uploaded image. Inspect every panel before writing the search plan: full image, background/interior crop, foreground/food crop, left/right/center crops, and high-contrast text crops. Small logo, tray, cup, bag, label, receipt, menu, or storefront text may only be readable in a crop or high-contrast panel.

Return strict JSON only:
{
  "summary": "what the uploaded image shows",
  "imageEvidence": ["specific visual details to search for"],
  "visibleText": ["exact readable words or brand names visible in the image, empty if none"],
  "searchQueries": ["5-8 targeted search queries for Google Maps/Yelp/review/photo pages"],
  "likelyVenueTypes": ["Cafe/Restaurant/Bakery/Counter/etc"]
}

Rules:
- Focus heavily on interior/storefront clues: wall color, tile, counters, menu boards, display cases, seating, lighting, murals, windows, bags, cups, plates, and logos.
- If readable venue or brand text appears, include exact quoted text in the first search queries with San Francisco restaurant/cafe terms.
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

function buildSearchEvidencePromptWithArticles(
  compactVenues,
  searchPlan,
  articleCandidates,
  photoEvidence,
  webEvidence,
) {
  const articleCandidateText = JSON.stringify(
    articleCandidates.slice(0, 12).map((candidate, index) => ({
      index: index + 1,
      name: candidate.name,
      category: candidate.category,
      neighborhood: candidate.neighborhood,
      address: candidate.address,
      whyRelevant: candidate.whyRelevant,
      sourceUrls: candidate.sourceUrls,
      openingContext: candidate.openingContext,
    })),
  )

  return `${buildSearchEvidencePrompt(compactVenues, searchPlan, photoEvidence, webEvidence)}

Article-discovered candidate venues:
${articleCandidateText}

Additional article-discovery rules:
- Treat article-discovered venues as candidate generation only. Do not choose one unless the uploaded image or external public photos support it.
- Recent-opening and local food-guide articles can bring new venues into the search space, especially when the uploaded image lacks readable signage.
- If an article-discovered venue has matching Google Maps/review/customer photos, rank it above generic web guesses and include both the article source and the matching photo source.
- If article evidence names a venue but the visual evidence conflicts with the uploaded photo, keep confidence low or omit it.`
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
  const visibleText = Array.isArray(plan.visibleText)
    ? plan.visibleText.map(String).map((text) => text.trim()).filter(Boolean).slice(0, 5)
    : []
  const visibleTextQueries = visibleText.flatMap((text) => [
    `"${text}" San Francisco restaurant cafe`,
    `"${text}" San Francisco menu photos reviews`,
  ])
  const searchQueries = [...new Set([
    ...visibleTextQueries,
    ...(Array.isArray(plan.searchQueries)
      ? plan.searchQueries.map(String).filter(Boolean).slice(0, 8)
      : []),
  ])].slice(0, 8)

  const normalizedPlan = {
    summary: String(plan.summary ?? ''),
    imageEvidence: Array.isArray(plan.imageEvidence)
      ? plan.imageEvidence.map(String).filter(Boolean).slice(0, 12)
      : [],
    visibleText,
    searchQueries,
    likelyVenueTypes: Array.isArray(plan.likelyVenueTypes)
      ? plan.likelyVenueTypes.map(String).filter(Boolean).slice(0, 6)
      : [],
  }
  return {
    ...normalizedPlan,
    queryLanes: buildEvidenceQueryLanes(normalizedPlan),
  }
}

function uniqueQueries(queries, maxItems = 8) {
  return [...new Set(queries.map((query) => String(query).trim()).filter(Boolean))].slice(0, maxItems)
}

export function buildEvidenceQueryLanes(searchPlan = {}, articleCandidates = []) {
  const visibleText = Array.isArray(searchPlan.visibleText) ? searchPlan.visibleText : []
  const imageText = [
    searchPlan.summary,
    ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
  ].filter(Boolean).join(' ')
  const modelQueries = Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []
  const interiorQuery = [
    imageText,
    'San Francisco cafe restaurant interior Google Maps Yelp photos reviews',
  ].filter(Boolean).join(' ')
  const dishQuery = [
    imageText,
    'San Francisco menu dish drink restaurant cafe',
  ].filter(Boolean).join(' ')
  const articleQueries = buildArticleCandidateQueries(articleCandidates)

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
        interiorQuery,
        ...modelQueries.filter((query) =>
          /\b(interior|counter|tile|wall|shelf|shelving|decor|storefront|photos|reviews)\b/i.test(query),
        ),
      ], 6),
    },
    {
      lane: 'dish_menu',
      queries: uniqueQueries([
        dishQuery,
        ...modelQueries.filter((query) =>
          /\b(menu|dish|food|drink|coffee|matcha|latte|burger|pastry|sandwich|noodle)\b/i.test(query),
        ),
      ], 6),
    },
    {
      lane: 'recent_openings',
      queries: uniqueQueries([
        `${imageText} San Francisco recently opened new popular cafe restaurant Eater Infatuation SF Standard SFGATE`,
        ...articleQueries,
      ], 8),
    },
  ].filter((lane) => lane.queries.length)
}

function flattenQueryLanes(queryLanes = [], maxItems = 12) {
  return uniqueQueries(queryLanes.flatMap((lane) => lane.queries ?? []), maxItems)
}

function normalizeArticleCandidate(candidate) {
  const name = String(candidate.name ?? '').trim()
  const sourceUrls = Array.isArray(candidate.sourceUrls)
    ? candidate.sourceUrls.map(String).filter(isUsefulEvidenceUrl).slice(0, 4)
    : []

  return {
    name: isPlaceholderCandidateName(name) ? '' : name,
    category: candidate.category ? String(candidate.category) : 'Cafe',
    neighborhood: candidate.neighborhood ? String(candidate.neighborhood) : '',
    address: candidate.address ? String(candidate.address) : '',
    whyRelevant: candidate.whyRelevant ? String(candidate.whyRelevant) : '',
    openingContext: candidate.openingContext ? String(candidate.openingContext) : '',
    sourceUrls,
  }
}

function normalizeStringList(value, maxItems = 4) {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, maxItems)
    : []
}

const blockedEvidenceDomains = new Set([
  'doordash.com',
  'grubhub.com',
  'postmates.com',
  'ubereats.com',
  'waymo.com',
])

function sourceDomain(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function isUsefulEvidenceUrl(url) {
  const domain = sourceDomain(url)
  if (!domain) return false
  return ![...blockedEvidenceDomains].some((blockedDomain) =>
    domain === blockedDomain || domain.endsWith(`.${blockedDomain}`),
  )
}

function reasonLooksExternal(reason) {
  return /\b(web|source|article|review|public photo|google maps|maps|yelp|eater|infatuation|sf standard|sfgate|url|site|external)\b/i.test(
    reason,
  )
}

function explanationBuckets(candidate = {}) {
  const reasons = normalizeStringList(candidate.reasons, 4)
  const explicitPhotoEvidence = normalizeStringList(candidate.photoEvidence, 5)
  const explicitExternalEvidence = normalizeStringList(candidate.externalEvidence, 5)
  const rankingRules = [
    ...normalizeStringList(candidate.rankingRules, 5),
    ...normalizeStringList(candidate.rankingNotes, 5),
  ].slice(0, 5)
  const fallbackPhotoEvidence = reasons.filter((reason) => !reasonLooksExternal(reason)).slice(0, 4)
  const fallbackExternalEvidence = reasons.filter(reasonLooksExternal).slice(0, 4)
  const uploadedPhotoEvidence = explicitPhotoEvidence.filter((reason) => !reasonLooksExternal(reason))
  const misplacedExternalEvidence = explicitPhotoEvidence.filter(reasonLooksExternal)

  return {
    photoEvidence: uploadedPhotoEvidence.length ? uploadedPhotoEvidence : fallbackPhotoEvidence,
    externalEvidence: [
      ...explicitExternalEvidence,
      ...misplacedExternalEvidence,
      ...(!explicitExternalEvidence.length && !misplacedExternalEvidence.length ? fallbackExternalEvidence : []),
    ].slice(0, 5),
    rankingRules,
    reasons,
  }
}

function candidateKey(candidate) {
  return String(candidate.name || candidate.id || '').trim().toLowerCase()
}

function mergeUniqueStrings(...values) {
  return [...new Set(values.flat().filter(Boolean).map(String))].slice(0, 12)
}

function mergeCandidateRecords(existing, incoming) {
  const existingConfidence = normalizeConfidence(existing.confidence) ?? 0
  const incomingConfidence = normalizeConfidence(incoming.confidence) ?? 0
  const preferred = incomingConfidence > existingConfidence ? incoming : existing
  const fallback = preferred === incoming ? existing : incoming

  return {
    ...fallback,
    ...preferred,
    id: existing.id || incoming.id || '',
    confidence: Math.max(existingConfidence, incomingConfidence),
    evidenceCategories: mergeUniqueStrings(existing.evidenceCategories ?? [], incoming.evidenceCategories ?? []),
    photoEvidence: mergeUniqueStrings(existing.photoEvidence ?? [], incoming.photoEvidence ?? []).slice(0, 5),
    externalEvidence: mergeUniqueStrings(existing.externalEvidence ?? [], incoming.externalEvidence ?? []).slice(0, 5),
    rankingRules: mergeUniqueStrings(existing.rankingRules ?? [], incoming.rankingRules ?? []).slice(0, 6),
    rankingNotes: mergeUniqueStrings(existing.rankingNotes ?? [], incoming.rankingNotes ?? []).slice(0, 6),
    reasons: mergeUniqueStrings(existing.reasons ?? [], incoming.reasons ?? []).slice(0, 4),
    sourceUrls: mergeUniqueStrings(existing.sourceUrls ?? [], incoming.sourceUrls ?? [])
      .filter(isUsefulEvidenceUrl)
      .slice(0, 4),
    searchQueries: mergeUniqueStrings(existing.searchQueries ?? [], incoming.searchQueries ?? []).slice(0, 6),
    comparisonPhotos: [
      ...new Map(
        [...(existing.comparisonPhotos ?? []), ...(incoming.comparisonPhotos ?? [])]
          .filter(Boolean)
          .map((photo) => [photo.url || photo.pageUrl || photo.title, photo]),
      ).values(),
    ].slice(0, 4),
  }
}

export function dedupeCandidatesBeforeRanking(candidates = []) {
  const mergedByKey = new Map()

  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (!key) continue
    const existing = mergedByKey.get(key)
    mergedByKey.set(key, existing ? mergeCandidateRecords(existing, candidate) : candidate)
  }

  return [...mergedByKey.values()]
}

function mergeArticleCandidates(primaryCandidates = [], fallbackCandidates = []) {
  const seen = new Set()
  const merged = []

  for (const candidate of [...primaryCandidates, ...fallbackCandidates]) {
    const key = candidateKey(candidate)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(candidate)
  }

  return merged.slice(0, 12)
}

function imageEvidenceScore(text, searchPlan = {}) {
  const normalizedText = String(text).toLowerCase()
  const evidenceText = [
    searchPlan.summary,
    ...(Array.isArray(searchPlan.imageEvidence) ? searchPlan.imageEvidence : []),
  ]
    .join(' ')
    .toLowerCase()
  const clueGroups = [
    ['blue', 'rim', 'rimmed', 'enamel', 'plate', 'plates', 'tray', 'trays'],
    ['salad', 'feta', 'tomato', 'tomatoes'],
    ['chicken', 'lemon'],
    ['wrap', 'sandwich', 'pita'],
    ['olive', 'branch'],
    ['hot sauce', 'sauce'],
  ]

  return clueGroups.reduce((score, group) => {
    const clueIsInPhoto = group.some((word) => evidenceText.includes(word))
    const clueIsInSource = group.some((word) => normalizedText.includes(word))
    return clueIsInPhoto && clueIsInSource ? score + 1 : score
  }, 0)
}

function venueNamesFromWebPage(page) {
  const text = [page.title, page.snippet].filter(Boolean).join(' ')
  const names = new Set()
  const patterns = [
    /\b(?:founder|owner|chef|team|CEO and founder) of ([A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,3}) in San Francisco\b/g,
    /\bat ([A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,3}) in San Francisco\b/g,
    /\b([A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,3}) - Review -/g,
    /\b# ([A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,3})\b/g,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = String(match[1] ?? '').trim()
      if (
        name &&
        name.length <= 40 &&
        !/\b(San Francisco|Google Maps|Yelp|Eater|Infatuation|OpenTable|The Latest|Best New|Review Highlights)\b/i.test(
          name,
        )
      ) {
        names.add(name)
      }
    }
  }

  return [...names]
}

function discoverWebMentionCandidates(webEvidence = [], searchPlan = {}) {
  const candidates = []

  for (const page of webEvidence) {
    const pageText = [page.title, page.snippet].filter(Boolean).join(' ')
    const score = imageEvidenceScore(pageText, searchPlan)
    if (score === 0) continue

    for (const name of venueNamesFromWebPage(page)) {
      candidates.push({
        name,
        category: 'Restaurant',
        neighborhood: 'San Francisco',
        address: '',
        whyRelevant:
          score >= 2
            ? `A web result names ${name} while discussing visual clues that overlap with the uploaded image.`
            : `A web result names ${name} in a source returned for the uploaded image clues.`,
        openingContext: 'Discovered from web/review evidence',
        sourceUrls: page.url && isUsefulEvidenceUrl(page.url) ? [page.url] : [],
        _evidenceScore: score,
      })
    }
  }

  return candidates
    .sort((a, b) => b._evidenceScore - a._evidenceScore)
    .map(({ _evidenceScore, ...candidate }) => candidate)
    .slice(0, 8)
}

function normalizeNameText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uploadedEvidenceSupportsSceneCategory(category, uploadedEvidenceText) {
  if (!['interior_match', 'storefront_match'].includes(category)) return true
  const text = normalizeMatchText(uploadedEvidenceText)
  if (!text) return true
  if (category === 'interior_match') {
    return /\b(interior|inside|prep area|open kitchen|kitchen|service counter|prep counter|bar counter|counter seating|countertop|bar|shelf|shelves|shelving|tile|tiles|tiled|wall|walls|wood paneled|wood paneling|mural|murals|lighting|seating|booth|booths|dining room|display case|decor|room)\b/.test(text)
  }
  return /\b(storefront|exterior|front door|front doors|awning|awnings|front window|front windows|street facing window|street facing windows|facade|facades|street sign|street signs|signage|entrance|entrances|outside)\b/.test(text)
}

function extractQuotedVisibleText(items = []) {
  const visibleTexts = new Set()
  const text = items.filter(Boolean).join(' ')
  const quotedPatterns = [
    /['"“”]([A-Z][A-Z0-9&'’ -]{2,24})['"“”]/g,
    /\b(?:reads|says|labeled|labelled|branded|branding|logo|text)\s+([A-Z][A-Z0-9&'’ -]{2,24})\b/g,
  ]
  const blocked = new Set(['HOT', 'SAUCE', 'SAN FRANCISCO', 'GOOGLE MAPS'])

  for (const pattern of quotedPatterns) {
    for (const match of text.matchAll(pattern)) {
      const visibleText = String(match[1] ?? '').trim().replace(/\s+/g, ' ')
      if (visibleText.length >= 4 && !blocked.has(visibleText.toUpperCase())) {
        visibleTexts.add(visibleText)
      }
    }
  }

  return [...visibleTexts]
}

function titleCaseVisibleText(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanTextArray(value, maxItems = 8, maxLength = 500) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : []
}

function normalizeConfidence(value) {
  const confidence = Number(value ?? 0)
  if (!Number.isFinite(confidence)) return null
  const normalized = confidence > 0 && confidence <= 1 ? confidence * 100 : confidence
  return Math.round(Math.max(0, Math.min(100, normalized)))
}

function normalizeFeedbackPayload(body = {}) {
  const vote = cleanText(body.vote, 20)
  if (!['correct', 'incorrect', 'undo', 'suggested_answer'].includes(vote)) {
    throw new Error('Feedback vote must be correct, incorrect, undo, or suggested_answer.')
  }

  const candidate = body.candidate && typeof body.candidate === 'object' ? body.candidate : {}
  const analysis = body.analysis && typeof body.analysis === 'object' ? body.analysis : {}
  const providers = body.providers && typeof body.providers === 'object' ? body.providers : {}
  const suggestedVenue = body.suggestedVenue && typeof body.suggestedVenue === 'object' ? body.suggestedVenue : {}

  return {
    runId: cleanText(body.runId, 120),
    sessionId: cleanText(body.sessionId, 120),
    vote,
    rank: Number.isFinite(Number(body.rank)) ? Number(body.rank) : null,
    candidate: {
      id: cleanText(candidate.id, 120),
      name: cleanText(candidate.name, 160),
      category: cleanText(candidate.category, 80),
      neighborhood: cleanText(candidate.neighborhood, 120),
      address: cleanText(candidate.address, 180),
      confidence: normalizeConfidence(candidate.confidence),
      locationVerified: Boolean(candidate.locationVerified),
      evidenceCategories: cleanTextArray(candidate.evidenceCategories, 10, 80),
      photoEvidence: cleanTextArray(candidate.photoEvidence, 6, 700),
      externalEvidence: cleanTextArray(candidate.externalEvidence, 6, 700),
      rankingRules: cleanTextArray(candidate.rankingRules, 6, 700),
      reasons: cleanTextArray(candidate.reasons, 6, 700),
      rankingNotes: cleanTextArray(candidate.rankingNotes, 6, 700),
      sourceUrls: cleanTextArray(candidate.sourceUrls, 6, 500).filter(isUsefulEvidenceUrl),
    },
    lineup: Array.isArray(body.lineup)
      ? body.lineup
          .map((entry) => {
            const lineupCandidate =
              entry?.candidate && typeof entry.candidate === 'object' ? entry.candidate : {}
            return {
              rank: Number.isFinite(Number(entry?.rank)) ? Number(entry.rank) : null,
              candidate: {
                id: cleanText(lineupCandidate.id, 120),
                name: cleanText(lineupCandidate.name, 160),
                category: cleanText(lineupCandidate.category, 80),
                neighborhood: cleanText(lineupCandidate.neighborhood, 120),
                address: cleanText(lineupCandidate.address, 180),
                confidence: normalizeConfidence(lineupCandidate.confidence),
                locationVerified: Boolean(lineupCandidate.locationVerified),
                evidenceCategories: cleanTextArray(lineupCandidate.evidenceCategories, 10, 80),
                photoEvidence: cleanTextArray(lineupCandidate.photoEvidence, 6, 700),
                externalEvidence: cleanTextArray(lineupCandidate.externalEvidence, 6, 700),
                rankingRules: cleanTextArray(lineupCandidate.rankingRules, 6, 700),
              },
            }
          })
          .slice(0, 5)
      : [],
    suggestedVenue: {
      name: cleanText(suggestedVenue.name, 160),
      neighborhoodOrAddress: cleanText(suggestedVenue.neighborhoodOrAddress, 220),
      note: cleanText(suggestedVenue.note, 500),
      verificationStatus: 'unverified_user_claim',
    },
    analysis: {
      summary: cleanText(analysis.summary, 1000),
      imageEvidence: cleanTextArray(analysis.imageEvidence, 10, 500),
      needsMoreEvidence: Boolean(analysis.needsMoreEvidence),
    },
    providers: {
      searchProvider: cleanText(providers.searchProvider, 120),
      webSearchProvider: cleanText(providers.webSearchProvider, 120),
      articleSearchProvider: cleanText(providers.articleSearchProvider, 120),
    },
  }
}

function cleanCandidateForLog(candidate = {}) {
  return {
    id: cleanText(candidate.id, 120),
    name: cleanText(candidate.name, 160),
    category: cleanText(candidate.category, 80),
    neighborhood: cleanText(candidate.neighborhood, 120),
    address: cleanText(candidate.address, 180),
    confidence: normalizeConfidence(candidate.confidence),
    originalConfidence: normalizeConfidence(candidate.originalConfidence),
    evidenceType: cleanText(candidate.evidenceType, 120),
    evidenceCategories: cleanTextArray(candidate.evidenceCategories, 10, 80),
    photoEvidence: cleanTextArray(candidate.photoEvidence, 6, 700),
    externalEvidence: cleanTextArray(candidate.externalEvidence, 6, 700),
    rankingRules: cleanTextArray(candidate.rankingRules, 6, 700),
    reasons: cleanTextArray(candidate.reasons, 6, 700),
    rankingNotes: cleanTextArray(candidate.rankingNotes, 6, 700),
    sourceUrls: cleanTextArray(candidate.sourceUrls, 6, 500).filter(isUsefulEvidenceUrl),
    mapsQuery: cleanText(candidate.mapsQuery, 240),
    searchQueries: cleanTextArray(candidate.searchQueries, 6, 300),
  }
}

function cleanResultQualityForLog(resultQuality = {}) {
  return {
    state: cleanText(resultQuality.state, 80),
    shownCandidates: Number(resultQuality.shownCandidates ?? 0),
    filteredCandidates: Number(resultQuality.filteredCandidates ?? 0),
    hiddenCandidates: Number(resultQuality.hiddenCandidates ?? 0),
    topConfidence: normalizeConfidence(resultQuality.topConfidence),
    closeCandidateCount: Number(resultQuality.closeCandidateCount ?? 0),
    notEnoughEvidence: Boolean(resultQuality.notEnoughEvidence),
    summary: cleanText(resultQuality.summary, 500),
    filteredCandidateDetails: Array.isArray(resultQuality.filteredCandidateDetails)
      ? resultQuality.filteredCandidateDetails.map((candidate) => ({
          name: cleanText(candidate.name, 160),
          reasons: cleanTextArray(candidate.reasons, 6, 80),
        })).slice(0, 8)
      : [],
    hiddenCandidateDetails: Array.isArray(resultQuality.hiddenCandidateDetails)
      ? resultQuality.hiddenCandidateDetails.map((candidate) => ({
          name: cleanText(candidate.name, 160),
          reasons: cleanTextArray(candidate.reasons, 6, 80),
        })).slice(0, 8)
      : [],
  }
}

function cleanProviderStatusForLog(providerStatus = {}) {
  return {
    ok: Boolean(providerStatus.ok),
    warningCount: Number(providerStatus.warningCount ?? 0),
    failureAreas: cleanTextArray(providerStatus.failureAreas, 8, 80),
    warnings: Array.isArray(providerStatus.warnings)
      ? providerStatus.warnings.map((warning) => ({
          provider: cleanText(warning.provider, 160),
          area: cleanText(warning.area, 80),
          message: cleanText(warning.message, 800),
        })).slice(0, 8)
      : [],
  }
}

function cleanArticleCandidateForLog(candidate = {}) {
  return {
    name: cleanText(candidate.name, 160),
    category: cleanText(candidate.category, 80),
    neighborhood: cleanText(candidate.neighborhood, 120),
    address: cleanText(candidate.address, 180),
    whyRelevant: cleanText(candidate.whyRelevant, 700),
    openingContext: cleanText(candidate.openingContext, 300),
    sourceUrls: cleanTextArray(candidate.sourceUrls, 4, 500).filter(isUsefulEvidenceUrl),
  }
}

function cleanWebPageForLog(page = {}) {
  return {
    title: cleanText(page.title, 220),
    source: cleanText(page.source, 120),
    url: cleanText(page.url, 500),
    snippet: cleanText(page.snippet, 900),
    query: cleanText(page.query, 500),
    searchLabel: cleanText(page.searchLabel, 80),
  }
}

function cleanPhotoEvidenceForLog(photo = {}) {
  return {
    title: cleanText(photo.title, 220),
    source: cleanText(photo.source, 120),
    pageUrl: cleanText(photo.pageUrl, 500),
    query: cleanText(photo.query, 500),
    placeTitle: cleanText(photo.placeTitle, 220),
    placeAddress: cleanText(photo.placeAddress, 220),
    visualSimilarityScore: Number.isFinite(Number(photo.visualSimilarityScore))
      ? Number(photo.visualSimilarityScore)
      : null,
  }
}

async function appendJsonl(logPath, record) {
  if (!logPath) return
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8')
}

async function appendRunLog(logPath, record) {
  try {
    await appendJsonl(logPath, record)
  } catch (error) {
    console.warn('Could not save local run log.', error)
  }
}

async function hasExistingSuggestedCorrection(logPath, feedback) {
  if (!logPath || feedback.vote !== 'suggested_answer' || !feedback.runId) return false

  try {
    const contents = await readFile(logPath, 'utf8')
    return contents
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        try {
          const record = JSON.parse(line)
          return (
            record.vote === 'suggested_answer' &&
            record.runId === feedback.runId &&
            String(record.sessionId || '') === String(feedback.sessionId || '')
          )
        } catch {
          return false
        }
      })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function feedbackCandidateName(record) {
  return record?.candidate?.name || record?.suggestedVenue?.name || 'Unknown'
}

function classifyFeedbackRun(records = []) {
  const activeRecords = records.filter((record) => record.vote !== 'undo')
  const correct = activeRecords.filter((record) => record.vote === 'correct')
  const incorrect = activeRecords.filter((record) => record.vote === 'incorrect')
  const suggestions = activeRecords.filter((record) => record.vote === 'suggested_answer')
  const lineup = activeRecords.find((record) => Array.isArray(record.lineup) && record.lineup.length)?.lineup ?? []
  const lineupSize =
    lineup.length ||
    new Set(activeRecords.map((record) => record.candidate?.id || record.candidate?.name).filter(Boolean)).size

  if (suggestions.length) {
    return {
      type: 'missing_candidate_suggested',
      summary: `User suggested ${suggestions.map((record) => record.suggestedVenue?.name).filter(Boolean).join(', ') || 'a missing venue'}.`,
    }
  }
  if (correct.length) {
    const bestCorrectRank = Math.min(...correct.map((record) => Number(record.rank || Infinity)))
    const lowerRankWrong = incorrect.some((record) => Number(record.rank || Infinity) < bestCorrectRank)
    if (bestCorrectRank > 1 || lowerRankWrong) {
      return {
        type: 'ranking_calibration_failure',
        summary: `${feedbackCandidateName(correct[0])} was correct at rank ${bestCorrectRank}; a higher-ranked guess was wrong.`,
      }
    }
    return {
      type: 'confirmed_top_match',
      summary: `${feedbackCandidateName(correct[0])} was confirmed at rank 1.`,
    }
  }
  if (lineupSize > 0 && incorrect.length >= lineupSize) {
    return {
      type: 'all_wrong_no_suggestion',
      summary: 'All visible candidates were marked incorrect, but no correction was submitted.',
    }
  }
  if (incorrect.length) {
    return {
      type: 'partial_negative_feedback',
      summary: `${incorrect.length} candidate(s) were marked incorrect.`,
    }
  }
  return { type: 'unclassified', summary: 'No actionable saved feedback.' }
}

function groupFeedbackByRun(records = []) {
  const groups = new Map()
  for (const record of records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const runId = record.runId || `missing-run:${record.id || record.createdAt}`
    if (!groups.has(runId)) groups.set(runId, [])
    groups.get(runId).push(record)
  }
  return [...groups.entries()].map(([runId, runRecords]) => {
    const classification = classifyFeedbackRun(runRecords)
    const lastRecord = runRecords.at(-1)
    return {
      runId,
      classification,
      recordCount: runRecords.length,
      lastFeedbackAt: lastRecord?.createdAt ?? null,
      lastVote: lastRecord?.vote ?? null,
      lastCandidate: feedbackCandidateName(lastRecord),
      lineup: Array.isArray(lastRecord?.lineup) ? lastRecord.lineup.slice(0, 5) : [],
    }
  })
}

async function readFeedbackRecords(logPath) {
  try {
    const contents = await readFile(logPath, 'utf8')
    return contents
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function correctCandidatesFromVisibleText(candidates = [], imageEvidence = []) {
  const visibleTexts = extractQuotedVisibleText([
    ...imageEvidence,
    ...candidates.flatMap((candidate) => [
      candidate.name,
      candidate.evidenceType,
      ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
    ]),
  ])

  if (!visibleTexts.length) return candidates

  return candidates.map((candidate) => {
    const candidateName = normalizeNameText(candidate.name)
    const exactVisibleText = visibleTexts.find((visibleText) => {
      const normalizedVisibleText = normalizeNameText(visibleText)
      return (
        normalizedVisibleText.length >= 4 &&
        candidateName.startsWith(normalizedVisibleText) &&
        candidateName !== normalizedVisibleText
      )
    })

    if (!exactVisibleText) return candidate

    const correctedName = titleCaseVisibleText(exactVisibleText)
    return {
      ...candidate,
      name: correctedName,
      confidence: Math.max(Number(candidate.confidence ?? 0), 82),
      evidenceCategories: [
        ...new Set([...(candidate.evidenceCategories ?? []), 'visible_text', 'packaging_logo']),
      ],
      reasons: [
        `The uploaded image contains readable visible text that says ${correctedName}.`,
        ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
      ].slice(0, 2),
      mapsQuery: [correctedName, candidate.address || candidate.neighborhood || 'San Francisco']
        .filter(Boolean)
        .join(' '),
      searchQueries: [
        `"${correctedName}" San Francisco restaurant cafe photos reviews`,
        ...(Array.isArray(candidate.searchQueries) ? candidate.searchQueries : []),
      ].slice(0, 3),
    }
  })
}

function buildFallbackCandidates(articleCandidates = []) {
  return articleCandidates.slice(0, 5).map((candidate) => ({
    id: '',
    name: candidate.name,
    category: candidate.category || 'Restaurant',
    neighborhood: candidate.neighborhood || 'San Francisco',
    address: candidate.address || '',
    confidence: 64,
    evidenceType: 'web',
    evidenceCategories: ['web_source_match'],
    reasons: [
      candidate.whyRelevant || 'This venue was discovered from web evidence matching the uploaded image clues.',
      candidate.openingContext || 'Needs visual confirmation before trusting the exact location.',
    ].filter(Boolean).slice(0, 2),
    sourceUrls: Array.isArray(candidate.sourceUrls)
      ? candidate.sourceUrls.filter(isUsefulEvidenceUrl).slice(0, 3)
      : [],
    comparisonPhotos: [],
    mapsQuery: [candidate.name, candidate.address || candidate.neighborhood || 'San Francisco']
      .filter(Boolean)
      .join(' '),
    searchQueries: [
      [candidate.name, candidate.address || candidate.neighborhood, 'San Francisco photos reviews']
        .filter(Boolean)
        .join(' '),
    ],
  }))
}

function articleGroundingUrls(grounding = [], fieldPrefix = '') {
  const urls = []

  for (const item of Array.isArray(grounding) ? grounding : []) {
    if (fieldPrefix && !String(item.field ?? '').startsWith(fieldPrefix)) continue
    for (const citation of Array.isArray(item.citations) ? item.citations : []) {
      const url = citation.url || citation.id
      if (url) urls.push(String(url))
    }
  }

  return [...new Set(urls)].slice(0, 4)
}

function buildArticleDiscoveryQuery(searchPlan) {
  const evidence = [
    searchPlan?.summary,
    ...(Array.isArray(searchPlan?.imageEvidence) ? searchPlan.imageEvidence : []),
  ]
    .filter(Boolean)
    .join('; ')

  return [
    'San Francisco recently opened new popular cafe coffee matcha bakery restaurant 2026',
    'sources like The Infatuation Eater SF Standard SFGATE Chronicle Hoodline local food blogs',
    'return single-location or newly opened venue candidates when possible',
    evidence ? `uploaded photo clues: ${evidence}` : '',
  ]
    .filter(Boolean)
    .join('. ')
}

export async function discoverArticleCandidates(searchPlan, searchClient = null) {
  if (!searchClient) return { candidates: [], pages: [] }

  const query = buildArticleDiscoveryQuery(searchPlan)
  const result = await searchClient.search(query, {
    type: 'deep',
    numResults: 12,
    contents: {
      highlights: true,
    },
    outputSchema: {
      type: 'object',
      description:
        'Recently opened, upcoming, or newly popular San Francisco cafe, coffee, matcha, bakery, or restaurant candidates from article-style sources.',
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          description: 'Article-backed venue candidates to verify later against public photos.',
          items: {
            type: 'object',
            required: ['name', 'whyRelevant'],
            properties: {
              name: { type: 'string', description: 'Venue name' },
              category: { type: 'string', description: 'Venue type such as Cafe or Bakery' },
              neighborhood: { type: 'string', description: 'SF neighborhood if found' },
              address: { type: 'string', description: 'Street address if found' },
              whyRelevant: {
                type: 'string',
                description: 'Why the article makes this useful for this photo search',
              },
              openingContext: {
                type: 'string',
                description: 'Recent opening, upcoming opening, popularity, or guide context',
              },
            },
          },
        },
      },
    },
  })

  const grounding = result.output?.grounding ?? []
  const rawCandidates = Array.isArray(result.output?.content?.candidates)
    ? result.output.content.candidates
    : []
  const candidates = rawCandidates
    .map((candidate, index) => {
      const normalized = normalizeArticleCandidate(candidate)
      return {
        ...normalized,
        sourceUrls: articleGroundingUrls(grounding, `candidates[${index}]`).filter(isUsefulEvidenceUrl),
      }
    })
    .filter((candidate) => candidate.name)

  const pages = (Array.isArray(result.results) ? result.results : [])
    .map((item) => {
      const url = item.url || item.id
      const highlights = Array.isArray(item.highlights) ? item.highlights : []
      return {
        title: String(item.title ?? 'Article candidate page'),
        source: getSourceName(url, item.author),
        url: String(url),
        snippet: highlights.join(' ').slice(0, 900),
        query,
        searchLabel: 'article-discovery',
      }
    })
    .filter((page) => isUsefulEvidenceUrl(page.url))

  return { candidates: candidates.slice(0, 12), pages: pages.slice(0, 12) }
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

  const normalizedCandidateName = normalizeNameText(candidate.name)
  const normalizedEvidenceText = normalizeNameText(text)
  const exactCandidateNameIsReadable =
    normalizedCandidateName.length >= 4 && normalizedEvidenceText.includes(normalizedCandidateName)
  const hasReliableVisibleText =
    /\b(readable|reads|says|spells|labeled|labelled|venue name|store name|sign says|label says|logo says|menu says|receipt says|visible sign|visible text|brand text|brand name|printed text|printed logo|visible logo|visible branding)\b/.test(
      text,
    ) &&
    exactCandidateNameIsReadable &&
    !/\b(blurred|unreadable|blank|white label|no readable)\b/.test(text)

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
  const uploadedEvidenceText = [
    options.uploadedSummary,
    ...(Array.isArray(options.uploadedImageEvidence) ? options.uploadedImageEvidence : []),
  ].join(' ')
  const ocrVisibleText = (options.ocrVisibleText ?? [])
    .map((text) => normalizeNameText(text))
    .filter((text) => text.length >= 4)
  const rankedCandidates = dedupeCandidatesBeforeRanking(rawCandidates)
    .map((rawCandidate, originalIndex) => {
      const candidate = {
        ...rawCandidate,
        sourceUrls: Array.isArray(rawCandidate.sourceUrls)
          ? rawCandidate.sourceUrls.filter(isUsefulEvidenceUrl)
          : [],
      }
      const evidenceCategoriesForCandidate = normalizeEvidenceCategories(candidate).filter((category) =>
        uploadedEvidenceSupportsSceneCategory(category, uploadedEvidenceText),
      )
      const rawEvidenceCategories = Array.isArray(candidate.evidenceCategories)
        ? candidate.evidenceCategories.map((category) => String(category).toLowerCase())
        : []
      const visibleTextWasRemoved =
        rawEvidenceCategories.includes('visible_text') &&
        !evidenceCategoriesForCandidate.includes('visible_text')
      const strongEvidence = evidenceCategoriesForCandidate.filter(
        (category) => category !== 'dish_match',
      )
      const nonSourceEvidence = evidenceCategoriesForCandidate.filter(
        (category) => category !== 'web_source_match',
      )
      const hasExternalPhotoMatch =
        Array.isArray(candidate.comparisonPhotos) &&
        candidate.comparisonPhotos.some((photo) => trustedPhotoUrls.has(photo.url))
      const hasSeedMatch = Boolean(candidate.id) && seedVenueIds.has(candidate.id)
      const hasIdentityEvidence = evidenceCategoriesForCandidate.some((category) =>
        ['visible_text', 'gps_match'].includes(category),
      )
      const normalizedCandidateName = normalizeNameText(candidate.name)
      const ocrContradictedCandidate =
        ocrVisibleText.length > 0 &&
        normalizedCandidateName.length >= 4 &&
        !ocrVisibleText.some(
          (text) => normalizedCandidateName.includes(text) || text.includes(normalizedCandidateName),
        )
      const hasLogoEvidence = evidenceCategoriesForCandidate.includes('packaging_logo')
      const isWebDiscovered = !hasSeedMatch
      const sourceOnly =
        evidenceCategoriesForCandidate.includes('web_source_match') && nonSourceEvidence.length === 0
      const seedOnly = hasSeedMatch && sourceOnly
      const hasSeedPhotoEvidence = hasSeedMatch && nonSourceEvidence.length > 0
      const hasHardVenueEvidence =
        hasSeedPhotoEvidence ||
        hasExternalPhotoMatch ||
        hasIdentityEvidence
      const hasUnverifiedVisualClaim =
        !hasExternalPhotoMatch &&
        evidenceCategoriesForCandidate.some((category) =>
          ['interior_match', 'storefront_match'].includes(category),
        )
      const dishOnly =
        evidenceCategoriesForCandidate.includes('dish_match') &&
        nonSourceEvidence.every((category) => category === 'dish_match') &&
        !hasIdentityEvidence &&
        !hasExternalPhotoMatch
      const hasSource = Array.isArray(candidate.sourceUrls) && candidate.sourceUrls.length > 0
      const hasReasons = Array.isArray(candidate.reasons) && candidate.reasons.length > 0
      const explanations = explanationBuckets(candidate)
      const baseConfidence = normalizeConfidence(candidate.confidence) ?? 0
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
        ...(seedOnly ? ['Seed-list identity alone is not photo evidence, so this was capped.'] : []),
        ...(sourceOnly ? ['Source/article evidence alone is weak without a matching uploaded-photo clue.'] : []),
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
      const rankingRules = [
        ...explanations.rankingRules,
        ...rankingNotes,
      ].slice(0, 6)
      const rankingDebugReasons = [
        ...(visibleTextWasRemoved
          ? ['visible text removed because exact candidate name was not readable']
          : []),
        ...(seedOnly ? ['seed source text only'] : []),
        ...(sourceOnly ? ['source-only cap'] : []),
        ...(dishOnly ? ['dish-only cap'] : []),
        ...(hasUnverifiedVisualClaim ? ['unverified interior/storefront cap'] : []),
        ...(!hasIdentityEvidence ? ['no identity clue'] : []),
        ...(ocrContradictedCandidate ? ['OCR contradicted candidate'] : []),
        ...(adjustedScore < rawAdjustedScore ? [`confidence capped at ${confidenceCap}`] : []),
      ]

      return {
        ...candidate,
        id: hasSeedMatch ? candidate.id : '',
        confidence: adjustedConfidence,
        originalConfidence: baseConfidence,
        evidenceCategories: evidenceCategoriesForCandidate,
        photoEvidence: explanations.photoEvidence,
        externalEvidence: explanations.externalEvidence,
        reasons: explanations.reasons,
        rankingRules,
        rankingNotes,
        rankingDebugReasons,
        _rankScore: adjustedScore,
        _rawRankScore: rawAdjustedScore,
        _confidenceCap: confidenceCap,
        _originalIndex: originalIndex,
      }
    })
    .filter((candidate) =>
      candidatePassesQualityGate(candidate, {
        seedVenueIds: [...seedVenueIds],
        trustedPhotoUrls: [...trustedPhotoUrls],
      }),
    )
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
      originalConfidence: candidate.originalConfidence,
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

function buildArticleCandidateQueries(articleCandidates = []) {
  return articleCandidates.flatMap((candidate) => {
    const name = String(candidate.name ?? '').trim()
    if (!name) return []
    const context = [candidate.address || candidate.neighborhood, 'San Francisco']
      .filter(Boolean)
      .join(' ')

    return [
      `${name} San Francisco Google Maps reviews photos interior`,
      [name, context, 'cafe coffee matcha interior photos reviews']
        .filter(Boolean)
        .join(' '),
    ]
  })
}

function buildEvidenceSearchQueries(searchPlanQueries = [], articleCandidates = []) {
  const articleQueries = buildArticleCandidateQueries(articleCandidates)
  const primaryArticleQueries = articleQueries.filter((_query, index) => index % 2 === 0)
  const secondaryArticleQueries = articleQueries.filter((_query, index) => index % 2 === 1)
  const baseQueries = searchPlanQueries.map((query) => String(query).trim()).filter(Boolean)
  const combined = [
    ...primaryArticleQueries,
    ...baseQueries.slice(0, 4),
    ...secondaryArticleQueries,
    ...baseQueries.slice(4),
  ]
    .map((query) => String(query).trim())
    .filter(Boolean)

  return [...new Set(combined)].slice(0, 12)
}

async function describeForExternalPhotoSearch({
  visionClient,
  visionProvider,
  visionModel,
  uploadedImageViews,
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
            ...buildOpenRouterUploadedImageParts(uploadedImageViews),
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
          ...buildOpenAIUploadedImageParts(uploadedImageViews),
        ],
      },
    ],
    temperature: 0.1,
    max_output_tokens: 800,
  })

  return normalizeSearchPlan(parseModelJson(result.output_text ?? '{}'))
}

export async function searchSerpApiPhotos(searchQueries, apiKey = process.env.SERPAPI_API_KEY) {
  const photos = []
  const seen = new Set()
  const seenPlaces = new Set()
  const mapSearches = searchQueries.slice(0, 5).map(async (rawQuery, queryIndex) => {
    const query = `${rawQuery} San Francisco cafe restaurant`
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google_maps')
    url.searchParams.set('q', query)
    url.searchParams.set('ll', '@37.7749,-122.4194,12z')
    url.searchParams.set('hl', 'en')
    url.searchParams.set('api_key', apiKey)

    const response = await fetch(url)
    if (!response.ok) return []
    const result = await response.json()
    const places = Array.isArray(result.local_results) ? result.local_results : []

    return places.slice(0, 3).map((place, placeIndex) => ({
      place,
      query,
      queryIndex,
      placeIndex,
    }))
  })

  const settledMapSearches = await Promise.allSettled(mapSearches)
  const places = settledMapSearches
    .flatMap((settledSearch) =>
      settledSearch.status === 'fulfilled' ? settledSearch.value : [],
    )
    .sort((a, b) => a.queryIndex - b.queryIndex || a.placeIndex - b.placeIndex)
    .filter(({ place }) => {
      if (!place.data_id || seenPlaces.has(place.data_id)) return false
      seenPlaces.add(place.data_id)
      return true
    })
    .slice(0, 8)

  const photoSearches = places.map(async ({ place, query, queryIndex, placeIndex }) => {
    const photosUrl = new URL('https://serpapi.com/search.json')
    photosUrl.searchParams.set('engine', 'google_maps_photos')
    photosUrl.searchParams.set('data_id', String(place.data_id))
    photosUrl.searchParams.set('hl', 'en')
    photosUrl.searchParams.set('api_key', apiKey)

    const photosResponse = await fetch(photosUrl)
    if (!photosResponse.ok) return []
    const photosResult = await photosResponse.json()
    const mapsPhotos = Array.isArray(photosResult.photos) ? photosResult.photos : []

    return mapsPhotos.slice(0, 4).map((photo, photoIndex) => {
      const imageUrl = photo.image || photo.thumbnail
      return {
        title: `${String(place.title ?? 'Google Maps place')} customer photo`,
        source: 'Google Maps reviews/photos',
        pageUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          [place.title, place.address].filter(Boolean).join(' '),
        )}`,
        imageUrl: imageUrl ? String(imageUrl) : '',
        thumbnailUrl: photo.thumbnail ? String(photo.thumbnail) : String(imageUrl),
        query,
        placeTitle: String(place.title ?? ''),
        placeAddress: String(place.address ?? ''),
        placeDataId: String(place.data_id),
        placeId: place.place_id ? String(place.place_id) : undefined,
        mapsQuery: [place.title, place.address].filter(Boolean).join(' '),
        gpsCoordinates: place.gps_coordinates ?? null,
        queryIndex,
        placeIndex,
        photoIndex,
      }
    })
  })

  const settledPhotoSearches = await Promise.allSettled(photoSearches)
  const candidatePhotos = settledPhotoSearches
    .flatMap((settledSearch) =>
      settledSearch.status === 'fulfilled' ? settledSearch.value : [],
    )
    .sort(
      (a, b) =>
        a.queryIndex - b.queryIndex ||
        a.placeIndex - b.placeIndex ||
        a.photoIndex - b.photoIndex,
    )

  for (const photo of candidatePhotos) {
    if (!photo.imageUrl || seen.has(photo.imageUrl)) continue
    seen.add(photo.imageUrl)
    const { queryIndex, placeIndex, photoIndex, ...publicPhoto } = photo
    photos.push(publicPhoto)
    if (photos.length >= 18) return photos
  }

  return photos.slice(0, 18)
}

function normalizeMapPlaces(result) {
  const localResults = result?.localResults
  if (Array.isArray(result?.placeResults)) return result.placeResults
  if (result?.placeResults && typeof result.placeResults === 'object') return [result.placeResults]
  if (Array.isArray(result?.local_results)) return result.local_results
  if (Array.isArray(localResults)) return localResults
  if (localResults && typeof localResults === 'object' && !Array.isArray(localResults?.places)) {
    return [localResults]
  }
  if (Array.isArray(localResults?.places)) return localResults.places
  if (Array.isArray(result?.places)) return result.places
  return []
}

function normalizePlaceDataId(place) {
  return place?.data_id ?? place?.dataId ?? place?.dataID ?? null
}

function normalizePlaceId(place) {
  return place?.place_id ?? place?.placeId ?? null
}

function normalizeGpsCoordinates(place) {
  return place?.gps_coordinates ?? place?.gpsCoordinates ?? place?.coordinates ?? null
}

function normalizeMapsPhotos(result) {
  if (Array.isArray(result?.photos)) return result.photos
  if (Array.isArray(result?.images)) return result.images
  if (Array.isArray(result?.items)) return result.items
  return []
}

function mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }) {
  const imageUrl = normalizePhotoImageUrl(photo)
  const thumbnailUrl = normalizePhotoThumbnailUrl(photo)
  const placeTitle = String(place.title ?? place.name ?? 'Google Maps place')
  const placeAddress = String(place.address ?? place.fullAddress ?? '')
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
    placeDataId: normalizePlaceDataId(place) ? String(normalizePlaceDataId(place)) : undefined,
    placeId: normalizePlaceId(place) ? String(normalizePlaceId(place)) : undefined,
    mapsQuery: [placeTitle, placeAddress].filter(Boolean).join(' '),
    gpsCoordinates: normalizeGpsCoordinates(place),
    queryIndex,
    placeIndex,
    photoIndex,
  }
}

function normalizePhotoImageUrl(photo) {
  if (typeof photo === 'string') return photo
  return photo?.image ?? photo?.url ?? photo?.fullImage ?? photo?.original ?? photo?.thumbnail ?? ''
}

function normalizePhotoThumbnailUrl(photo) {
  if (typeof photo === 'string') return photo
  return photo?.thumbnail ?? photo?.thumb ?? photo?.image ?? photo?.url ?? ''
}

export async function searchGooglePlacesPhotos(
  searchQueries,
  apiKey = process.env.GOOGLE_PLACES_API_KEY,
) {
  if (!apiKey) return []

  const photos = []
  const seenPhotos = new Set()
  const seenPlaces = new Set()
  const textSearches = searchQueries.slice(0, 4).map(async (rawQuery, queryIndex) => {
    const query = `${rawQuery} San Francisco cafe restaurant`
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': String(apiKey),
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
    if (!response.ok) return []
    const result = await response.json()
    return (Array.isArray(result.places) ? result.places : []).slice(0, 3).map((place, placeIndex) => ({
      place,
      query,
      queryIndex,
      placeIndex,
    }))
  })

  const settledTextSearches = await Promise.allSettled(textSearches)
  const places = settledTextSearches
    .flatMap((settledSearch) =>
      settledSearch.status === 'fulfilled' ? settledSearch.value : [],
    )
    .sort((a, b) => a.queryIndex - b.queryIndex || a.placeIndex - b.placeIndex)
    .filter(({ place }) => {
      if (!place.id || seenPlaces.has(place.id)) return false
      seenPlaces.add(place.id)
      return true
    })
    .slice(0, 8)

  const photoLookups = places.flatMap(({ place, query, queryIndex, placeIndex }) => {
    const placePhotos = Array.isArray(place.photos) ? place.photos.slice(0, 4) : []
    return placePhotos.map(async (photo, photoIndex) => {
      if (!photo.name) return null
      const photoUrl = new URL(`https://places.googleapis.com/v1/${photo.name}/media`)
      photoUrl.searchParams.set('maxWidthPx', '900')
      photoUrl.searchParams.set('skipHttpRedirect', 'true')
      photoUrl.searchParams.set('key', String(apiKey))
      const photoResponse = await fetch(photoUrl)
      if (!photoResponse.ok) return null
      const photoResult = await photoResponse.json()
      const imageUrl = photoResult.photoUri || ''
      const placeTitle = String(place.displayName?.text ?? 'Google Places result')
      const placeAddress = String(place.formattedAddress ?? '')
      return {
        title: `${placeTitle} Google Places photo`,
        source: 'Google Places photos',
        pageUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          [placeTitle, placeAddress].filter(Boolean).join(' '),
        )}`,
        imageUrl: String(imageUrl),
        thumbnailUrl: String(imageUrl),
        query,
        placeTitle,
        placeAddress,
        placeId: String(place.id),
        mapsQuery: [placeTitle, placeAddress].filter(Boolean).join(' '),
        gpsCoordinates: place.location ?? null,
        queryIndex,
        placeIndex,
        photoIndex,
      }
    })
  })

  const settledPhotoLookups = await Promise.allSettled(photoLookups)
  const candidatePhotos = settledPhotoLookups
    .flatMap((settledLookup) =>
      settledLookup.status === 'fulfilled' && settledLookup.value ? [settledLookup.value] : [],
    )
    .sort(
      (a, b) =>
        a.queryIndex - b.queryIndex ||
        a.placeIndex - b.placeIndex ||
        a.photoIndex - b.photoIndex,
    )

  for (const photo of candidatePhotos) {
    if (!photo.imageUrl || seenPhotos.has(photo.imageUrl)) continue
    seenPhotos.add(photo.imageUrl)
    const { queryIndex, placeIndex, photoIndex, ...publicPhoto } = photo
    photos.push(publicPhoto)
    if (photos.length >= 18) return photos
  }

  return photos.slice(0, 18)
}

export async function searchHasDataPhotos(searchQueries, apiKey = process.env.HASDATA_API_KEY) {
  const photos = []
  const seen = new Set()
  const seenPlaces = new Set()
  const mapSearches = []
  const queries = searchQueries.slice(0, 3)
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const rawQuery = queries[queryIndex]
    const query = `${rawQuery} San Francisco cafe restaurant`
    const url = new URL('https://api.hasdata.com/scrape/google-maps/search')
    url.searchParams.set('q', query)
    url.searchParams.set('ll', '@37.7749,-122.4194,12z')
    url.searchParams.set('hl', 'en')
    url.searchParams.set('gl', 'us')

    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': String(apiKey ?? ''),
      },
    })
    if (!response.ok) {
      mapSearches.push([])
      continue
    }
    const result = await response.json()
    const places = normalizeMapPlaces(result)

    const search = places.slice(0, 3).map((place, placeIndex) => ({
      place,
      query,
      queryIndex,
      placeIndex,
    }))
    mapSearches.push(search)
    if (search.length && queryIndex === 0) break
  }

  const places = mapSearches
    .flat()
    .sort((a, b) => a.queryIndex - b.queryIndex || a.placeIndex - b.placeIndex)
    .filter(({ place }) => {
      const placeKey = normalizePlaceDataId(place) ?? normalizePlaceId(place)
      if (!placeKey || seenPlaces.has(placeKey)) return false
      seenPlaces.add(placeKey)
      return true
    })
    .slice(0, 8)

  const inlinePlacePhotos = places.flatMap(({ place, query, queryIndex, placeIndex }) =>
    normalizeMapsPhotos(place).slice(0, 4).map((photo, photoIndex) =>
      mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }),
    ),
  )

  const photoSearches = places.map(async ({ place, query, queryIndex, placeIndex }) => {
    const dataId = normalizePlaceDataId(place)
    const placeId = normalizePlaceId(place)
    const photosUrl = new URL('https://api.hasdata.com/scrape/google-maps/photos')
    if (dataId) photosUrl.searchParams.set('dataId', String(dataId))
    if (!dataId && placeId) photosUrl.searchParams.set('placeId', String(placeId))
    photosUrl.searchParams.set('hl', 'en')

    const photosResponse = await fetch(photosUrl, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': String(apiKey ?? ''),
      },
    })
    if (!photosResponse.ok) return []
    const photosResult = await photosResponse.json()
    const mapsPhotos = normalizeMapsPhotos(photosResult)

    return mapsPhotos.slice(0, 4).map((photo, photoIndex) =>
      mapHasDataPhoto({ photo, place, query, queryIndex, placeIndex, photoIndex }),
    )
  })

  const settledPhotoSearches = await Promise.allSettled(photoSearches)
  const candidatePhotos = [
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

  for (const photo of candidatePhotos) {
    if (!photo.imageUrl || seen.has(photo.imageUrl)) continue
    seen.add(photo.imageUrl)
    const { queryIndex, placeIndex, photoIndex, ...publicPhoto } = photo
    photos.push(publicPhoto)
    if (photos.length >= 18) return photos
  }

  return photos.slice(0, 18)
}

export async function searchExaWeb(searchQueries, searchClient = null) {
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
      }).filter((page) => isUsefulEvidenceUrl(page.url))
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

export async function searchCeramicWeb(searchQueries, apiKey = process.env.CERAMIC_API_KEY) {
  const pages = []
  const seen = new Set()

  if (!apiKey) return pages

  const searches = searchQueries.slice(0, 3).flatMap(buildSourceSearches)
  const settledSearches = await Promise.allSettled(
    searches.map(async (search) => {
      const response = await fetch('https://api.ceramic.ai/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: search.query }),
      })
      if (!response.ok) return []
      const result = await response.json()
      const results = Array.isArray(result?.result?.results) ? result.result.results : []

      return results.map((item) => {
        const url = item.url || item.id
        return {
          title: String(item.title ?? 'Candidate page'),
          source: getSourceName(url, item.source),
          url: String(url),
          snippet: String(item.description ?? item.snippet ?? '').slice(0, 900),
          query: search.query,
          searchLabel: search.label,
        }
      }).filter((page) => isUsefulEvidenceUrl(page.url))
    }),
  )

  for (const settledSearch of settledSearches) {
    if (settledSearch.status !== 'fulfilled') continue
    for (const page of settledSearch.value) {
      if (!page.url || seen.has(page.url)) continue
      seen.add(page.url)
      pages.push(page)
      if (pages.length >= 20) return pages
    }
  }

  return pages.slice(0, 20)
}

function appendUniqueWebEvidence(existingPages, nextPages) {
  const seen = new Set(existingPages.map((page) => page.url).filter(Boolean))
  const merged = [...existingPages]

  for (const page of Array.isArray(nextPages) ? nextPages : []) {
    if (!page?.url || seen.has(page.url)) continue
    seen.add(page.url)
    merged.push(page)
  }

  return merged
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
  const causeText = [
    message,
    error?.cause?.message,
    error?.cause?.cause?.message,
    error?.cause?.code,
    error?.cause?.cause?.code,
    error?.cause?.hostname,
    error?.cause?.cause?.hostname,
  ]
    .filter(Boolean)
    .join(' ')

  if (status === 401 || /api key|unauthorized|authentication/i.test(message)) {
    return `${providerName} rejected the API key. Check the local .env key, then restart npm run dev.`
  }

  if (status === 402 || /more credits|billing|quota|can only afford/i.test(message)) {
    return `${providerName} needs more credits for photo analysis. Add credits or switch to a direct OpenAI key in the local .env, then restart npm run dev.`
  }

  if (status === 429 || /rate limit/i.test(message)) {
    return `${providerName} is rate limiting photo analysis. Wait a bit, then try the upload again.`
  }

  if (/ENOTFOUND|getaddrinfo|fetch failed|Connection error|network|DNS|EAI_AGAIN/i.test(causeText)) {
    return `${providerName} could not be reached from this computer. Your local app is running, but DNS/network lookup failed for the external AI/search provider. Check internet/VPN/DNS, then try again.`
  }

  return 'The photo analysis failed. Try again in a moment or restart the dev server.'
}

async function analyzeWithProvider({
  visionClient,
  visionProvider,
  visionModel,
  uploadedImageViews,
  compactVenues,
  searchPlan = null,
  articleCandidates = [],
  photoEvidence = [],
  webEvidence = [],
  includeExternalPhotoImages = true,
  includeOpenRouterWebSearch = true,
}) {
  const systemPrompt =
    'You identify likely San Francisco food venues from uploaded food, interior, storefront, menu, receipt, or street-context images. Use the uploaded image itself as the source of evidence, be honest about uncertainty, and use the provided venue list only as seed data. You may return web-discovered San Francisco venues outside the seed list when supported by web evidence.'
  const analysisPrompt =
    photoEvidence.length > 0 || webEvidence.length > 0 || articleCandidates.length > 0
      ? buildSearchEvidencePromptWithArticles(
          compactVenues,
          searchPlan,
          articleCandidates,
          photoEvidence,
          webEvidence,
        )
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
            ...buildOpenRouterUploadedImageParts(uploadedImageViews),
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
          ...buildOpenAIUploadedImageParts(uploadedImageViews),
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
  const defaultProviders =
    options.providerConfig ??
    createProviderConfig({
      env: options.env ?? process.env,
      createVisionClient: !hasOpenAIClient && !hasVisionClient,
      searchFns: {
        discoverArticleCandidates,
        searchCeramicWeb,
        searchExaWeb,
        searchGooglePlacesPhotos,
        searchHasDataPhotos,
        searchSerpApiPhotos,
      },
    })
  const visionModel = options.visionModel ?? defaultProviders.visionModel
  const visionProvider =
    hasVisionProvider
      ? options.visionProvider
      : defaultProviders.visionProvider ??
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
      : defaultProviders.visionClient
  const visionFallbackModels = uniqueModels(
    options.visionFallbackModels ??
      (visionProvider === 'openrouter' ? defaultProviders.visionFallbackModels : []),
  ).filter((fallbackModel) => fallbackModel !== visionModel)
  const visionModelAttempts = uniqueModels([visionModel, ...visionFallbackModels])
  const hasPhotoSearch = Object.hasOwn(options, 'photoSearch')
  const photoSearch = hasPhotoSearch ? options.photoSearch : defaultProviders.photoSearch
  const hasWebSearch = Object.hasOwn(options, 'webSearch')
  const webSearch = hasWebSearch ? options.webSearch : defaultProviders.webSearch
  const hasArticleSearch = Object.hasOwn(options, 'articleSearch')
  const articleSearch =
    hasArticleSearch || hasPhotoSearch || hasWebSearch
      ? options.articleSearch ?? null
      : defaultProviders.articleSearch
  const searchCache = options.searchCache ?? defaultProviders.searchCache ?? null
  const debugRanking =
    options.debugRanking === true ||
    String((options.env ?? process.env).DEBUG_RANKING ?? '').toLowerCase() === 'true'
  const imageEmbeddingProvider =
    options.imageEmbeddingProvider ??
    String((options.env ?? process.env).IMAGE_EMBEDDING_PROVIDER ?? '')
  const app = express()
  const adminReviewRateLimits = new Map()
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? defaultAllowedOrigins.join(','))
  applyCors(app, allowedOrigins)

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
      articleSearchEnabled: Boolean(articleSearch),
      articleSearchProvider: articleSearch?.provider ?? null,
    })
  })

  app.post('/api/feedback', express.json({ limit: '64kb' }), async (request, response) => {
    let feedback
    try {
      feedback = normalizeFeedbackPayload(request.body)
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Feedback payload was invalid.',
      })
      return
    }

    const logPath = options.feedbackLogPath ?? defaultFeedbackLogPath
    try {
      if (await hasExistingSuggestedCorrection(logPath, feedback)) {
        response.status(409).json({ error: 'A correction was already submitted for this run.' })
        return
      }

      const record = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        app: 'sf-food-guesser',
        ...feedback,
      }
      await appendJsonl(logPath, record)
      response.status(201).json({ ok: true, id: record.id })
    } catch {
      response.status(500).json({ error: 'Could not save feedback locally.' })
    }
  })

  app.get('/api/admin/feedback-review', async (request, response) => {
    const env = options.env ?? process.env
    const retryAfterSeconds = checkLocalRateLimit(
      adminReviewRateLimits,
      `admin-feedback-review:${request.ip || request.get('x-forwarded-for') || 'unknown'}`,
      Number(env.SF_FOOD_ADMIN_REVIEW_RATE_LIMIT || 20),
      Number(env.SF_FOOD_ADMIN_REVIEW_RATE_WINDOW_SECONDS || 3600),
    )
    if (retryAfterSeconds) {
      response.setHeader('Retry-After', String(retryAfterSeconds))
      response.status(429).json({
        error: 'Rate limit reached for this browser or network. Wait a bit, then try again.',
        retryAfterSeconds,
      })
      return
    }

    const adminToken = options.adminToken ?? (options.env ?? process.env).SF_FOOD_ADMIN_TOKEN
    if (!adminToken || request.get('x-admin-token') !== adminToken) {
      response.status(401).json({ error: 'Admin token required.' })
      return
    }

    try {
      const records = await readFeedbackRecords(options.feedbackLogPath ?? defaultFeedbackLogPath)
      const runs = groupFeedbackByRun(records)
      const counts = runs.reduce((state, run) => {
        state[run.classification.type] = (state[run.classification.type] ?? 0) + 1
        return state
      }, {})
      response.json({
        ok: true,
        recordCount: records.length,
        runCount: runs.length,
        counts,
        runs: runs.slice(-50).reverse(),
      })
    } catch {
      response.status(500).json({ error: 'Could not read feedback review data.' })
    }
  })

  app.get('/api/admin/replay-fixture', (request, response) => {
    const fixtureId = String(request.query.fixtureId ?? goldenAnalysisFixtures[0]?.id ?? '')
    const fixture = goldenAnalysisFixtures.find((item) => item.id === fixtureId) ?? goldenAnalysisFixtures[0]
    if (!fixture) {
      response.status(404).json({ error: 'No replay fixtures are available.' })
      return
    }
    const candidates = rerankCandidates(fixture.analysis.candidates, {
      seedVenueIds: fixture.options?.seedVenueIds,
      uploadedSummary: fixture.analysis.summary,
      uploadedImageEvidence: fixture.analysis.imageEvidence,
      ocrVisibleText: fixture.options?.ocrVisibleText,
    })
    const resultQuality = buildResultQuality(fixture.analysis.candidates, candidates, {
      seedVenueIds: fixture.options?.seedVenueIds,
      modelNeedsMoreEvidence: Boolean(fixture.analysis.needsMoreEvidence),
    })
    response.json({
      ok: true,
      fixtureId: fixture.id,
      label: fixture.label,
      ...fixture.analysis,
      candidates,
      needsMoreEvidence: resultQuality.notEnoughEvidence,
      resultQuality,
      providerStatus: buildProviderStatus([]),
      cacheStatus: buildCacheStatus({
        localSearchCache: {
          enabled: false,
          provider: 'fixture-replay',
        },
      }),
    })
  })

  app.post('/api/analyze-photo', upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'ocrPhoto', maxCount: 1 },
  ]), async (request, response) => {
    if (!visionClient) {
      response.status(503).json({
        error:
          'Photo analysis needs OPENROUTER_API_KEY or OPENAI_API_KEY in .env. Add one, then restart npm run dev.',
      })
      return
    }

    const uploadedPhoto = request.files?.photo?.[0]
    if (!uploadedPhoto) {
      response.status(400).json({ error: 'No photo was uploaded.' })
      return
    }

    if (!looksLikeSupportedImage(uploadedPhoto.buffer)) {
      response.status(415).json({
        error:
          'Uploaded file did not look like a real image. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF photo.',
      })
      return
    }

    const compactVenues = compactSeedVenues

    const runId = randomUUID()
    const runStartedAt = Date.now()
    const uploadMetadata = {
      mimeType: cleanText(uploadedPhoto.mimetype, 120),
      sizeBytes: uploadedPhoto.size,
    }
    const runLogPath = options.runLogPath ?? defaultRunLogPath
    const uploadedImageViews = await buildUploadedImageViews(uploadedPhoto)

    try {
      let searchPlan = null
      let articleCandidates = []
      let photoEvidence = []
      let webEvidence = []
      const providerWarnings = []
      if (photoSearch?.search || webSearch?.search || articleSearch?.search) {
        for (const modelAttempt of visionModelAttempts) {
          try {
            searchPlan = await withTimeout(
              describeForExternalPhotoSearch({
                visionClient,
                visionProvider,
                visionModel: modelAttempt,
                uploadedImageViews,
              }),
              visionRequestTimeoutMs,
              `search-plan:${modelAttempt}`,
            )
            break
          } catch (error) {
            providerWarnings.push(providerWarning(`search-plan:${modelAttempt}`, error))
          }
        }
      }

      if (searchPlan) {
        searchPlan = {
          ...searchPlan,
          queryLanes: buildEvidenceQueryLanes(searchPlan),
        }
        const baseSearchQueries = flattenQueryLanes(searchPlan.queryLanes)
        const initialEvidenceSearches = []
        if (articleSearch?.search) {
          initialEvidenceSearches.push({
            type: 'article',
            provider: articleSearch.provider ?? 'article-search',
            run: () =>
              withTimeout(
                articleSearch.search(searchPlan),
                evidenceSearchTimeoutMs,
                articleSearch.provider ?? 'article-search',
              ),
          })
        }
        if (webSearch?.search) {
          initialEvidenceSearches.push({
            type: 'web',
            provider: webSearch.provider ?? 'web-search',
            run: () =>
              withTimeout(
                webSearch.search(baseSearchQueries),
                evidenceSearchTimeoutMs,
                webSearch.provider ?? 'web-search',
              ),
          })
        }
        if (!articleSearch?.search && photoSearch?.search) {
          initialEvidenceSearches.push({
            type: 'photo',
            provider: photoSearch.provider ?? 'photo-search',
            run: () =>
              withTimeout(
                photoSearch.search(baseSearchQueries),
                evidenceSearchTimeoutMs,
                photoSearch.provider ?? 'photo-search',
              ),
          })
        }

        const settledInitialEvidence = await Promise.all(
          initialEvidenceSearches.map(async (search) => {
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

        for (const settledSearch of settledInitialEvidence) {
          if (settledSearch.status !== 'fulfilled') {
            providerWarnings.push(providerWarning(settledSearch.provider, settledSearch.error))
            continue
          }
          if (settledSearch.type === 'article') {
            articleCandidates = Array.isArray(settledSearch.results?.candidates)
              ? settledSearch.results.candidates
              : []
            webEvidence = appendUniqueWebEvidence(
              webEvidence,
              Array.isArray(settledSearch.results?.pages) ? settledSearch.results.pages : [],
            )
          }
          if (settledSearch.type === 'web') {
            webEvidence = appendUniqueWebEvidence(webEvidence, settledSearch.results)
          }
          if (settledSearch.type === 'photo') photoEvidence = settledSearch.results
        }

        articleCandidates = mergeArticleCandidates(
          articleCandidates,
          discoverWebMentionCandidates(webEvidence, searchPlan),
        )

        searchPlan = {
          ...searchPlan,
          queryLanes: buildEvidenceQueryLanes(searchPlan, articleCandidates),
        }
        const candidateSearchQueries = buildArticleCandidateQueries(articleCandidates)
        const photoSearchQueries = buildEvidenceSearchQueries(
          flattenQueryLanes(searchPlan.queryLanes),
          articleCandidates,
        )
        const followupEvidenceSearches = []

        if (articleSearch?.search && photoSearch?.search) {
          followupEvidenceSearches.push({
            type: 'photo',
            provider: photoSearch.provider ?? 'photo-search',
            run: () =>
              withTimeout(
                photoSearch.search(photoSearchQueries),
                evidenceSearchTimeoutMs,
                photoSearch.provider ?? 'photo-search',
              ),
          })
        }
        if (webSearch?.search && candidateSearchQueries.length) {
          followupEvidenceSearches.push({
            type: 'web',
            provider: webSearch.provider ?? 'web-search',
            run: () =>
              withTimeout(
                webSearch.search(candidateSearchQueries),
                evidenceSearchTimeoutMs,
                webSearch.provider ?? 'web-search',
              ),
          })
        }

        const settledFollowupEvidence = await Promise.all(
          followupEvidenceSearches.map(async (search) => {
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

        for (const settledSearch of settledFollowupEvidence) {
          if (settledSearch.status !== 'fulfilled') {
            providerWarnings.push(providerWarning(settledSearch.provider, settledSearch.error))
            continue
          }
          if (settledSearch.type === 'web') {
            webEvidence = appendUniqueWebEvidence(webEvidence, settledSearch.results)
          }
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
            const outputText = await withTimeout(
              analyzeWithProvider({
                visionClient,
                visionProvider,
                visionModel: modelAttempt,
                uploadedImageViews,
                compactVenues,
                searchPlan,
                articleCandidates,
                photoEvidence,
                webEvidence,
                includeExternalPhotoImages: attempt.includeExternalPhotoImages,
                includeOpenRouterWebSearch: attempt.includeOpenRouterWebSearch,
              }),
              visionRequestTimeoutMs,
              `${attempt.label}:${modelAttempt}`,
            )
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
      if (!result) {
        if (articleCandidates.length) {
          result = {
            summary: searchPlan?.summary || 'Vision analysis failed, but web evidence returned venue candidates.',
            imageEvidence: searchPlan?.imageEvidence ?? [],
            candidates: [],
            needsMoreEvidence: true,
          }
        } else {
          throw lastVisionError ?? new Error('No vision model returned an analysis.')
        }
      }
      const embeddingComparison = await compareExternalPhotoEmbeddings({
        uploadedBuffer: uploadedPhoto.buffer,
        photoEvidence,
        enabled: imageEmbeddingProvider === 'local-signature',
      })
      photoEvidence = embeddingComparison.photos
      const photoEvidenceUrls = [
        ...photoEvidence.flatMap((photo) =>
          [photo.pageUrl, photo.imageUrl, photo.thumbnailUrl].filter(Boolean),
        ),
        ...embeddingComparison.trustedUrls,
      ]
      const modelCandidates = Array.isArray(result.candidates) ? result.candidates : []
      const seedVenueById = new Map(compactVenues.map((venue) => [venue.id, venue]))
      const rawCandidates = modelCandidates.length
        ? correctCandidatesFromVisibleText(modelCandidates, result.imageEvidence)
        : buildFallbackCandidates(articleCandidates)
      const constrainedCandidates = rawCandidates.map((candidate) => {
        const seedVenue = candidate.id ? seedVenueById.get(candidate.id) : null
        return seedVenue
          ? {
              ...candidate,
              sourceUrls: candidate.sourceUrls?.length
                ? candidate.sourceUrls.filter(isUsefulEvidenceUrl)
                : seedVenue.sourceUrl
                  ? [seedVenue.sourceUrl]
                  : [],
              doNotInferFrom: seedVenue.doNotInferFrom ?? candidate.doNotInferFrom,
            }
          : {
              ...candidate,
              sourceUrls: Array.isArray(candidate.sourceUrls)
                ? candidate.sourceUrls.filter(isUsefulEvidenceUrl)
                : [],
            }
      })
      const rankingDebug = debugRanking ? [] : null
      const candidates = rerankCandidates(constrainedCandidates, {
        seedVenueIds: compactVenues.map((venue) => venue.id),
        photoEvidenceUrls,
        uploadedSummary: result.summary,
        uploadedImageEvidence: result.imageEvidence,
        ocrVisibleText: searchPlan?.visibleText ?? [],
        debugReport: rankingDebug,
      })
      const resultQuality = buildResultQuality(constrainedCandidates, candidates, {
        seedVenueIds: compactVenues.map((venue) => venue.id),
        photoEvidenceUrls,
        modelNeedsMoreEvidence: Boolean(result.needsMoreEvidence),
      })
      const providerStatus = buildProviderStatus(providerWarnings)
      const cacheStatus = buildCacheStatus({
        localSearchCache: searchCache
          ? {
              enabled: searchCache.enabled,
              provider: searchCache.provider,
              ...(typeof searchCache.stats === 'function' ? searchCache.stats() : {}),
            }
          : null,
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
      const responseBody = {
        ...result,
        runId,
        candidates,
        needsMoreEvidence,
        searchPlan,
        articleCandidates: articleCandidates.map((candidate) => ({
          name: candidate.name,
          category: candidate.category,
          neighborhood: candidate.neighborhood,
          address: candidate.address,
          whyRelevant: candidate.whyRelevant,
          openingContext: candidate.openingContext,
          sourceUrls: candidate.sourceUrls,
        })),
        photoEvidence: photoEvidence.map((photo) => ({
          title: photo.title,
          source: photo.source,
          pageUrl: photo.pageUrl,
          thumbnailUrl: photo.thumbnailUrl,
          visualSimilarityScore: photo.visualSimilarityScore,
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
        articleSearchProvider: articleSearch?.provider ?? null,
        visionModel: visionModelUsed,
        providerWarnings,
        providerStatus,
        cacheStatus,
        resultQuality,
        ...(rankingDebug ? { rankingDebug } : {}),
      }
      await appendRunLog(runLogPath, {
        id: runId,
        createdAt: new Date().toISOString(),
        app: 'sf-food-guesser',
        status: 'completed',
        durationMs: Date.now() - runStartedAt,
        upload: uploadMetadata,
        imageViews: uploadedImageViews.map((view) => ({ label: cleanText(view.label, 300) })),
        providers: {
          visionProvider,
          visionModel: visionModelUsed,
          fallbackModels: visionFallbackModels,
          searchProvider: photoSearch?.provider ?? null,
          webSearchProvider: webSearch?.provider ?? null,
          articleSearchProvider: articleSearch?.provider ?? null,
        },
        summary: cleanText(result.summary, 1000),
        imageEvidence: cleanTextArray(result.imageEvidence, 12, 500),
        needsMoreEvidence,
        topConfidence,
        closeCandidateCount,
        resultQuality: cleanResultQualityForLog(resultQuality),
        providerStatus: cleanProviderStatusForLog(providerStatus),
        cacheStatus,
        candidates: candidates.map(cleanCandidateForLog),
        searchPlan: searchPlan
          ? {
              summary: cleanText(searchPlan.summary, 1000),
              imageEvidence: cleanTextArray(searchPlan.imageEvidence, 12, 500),
              visibleText: cleanTextArray(searchPlan.visibleText, 8, 120),
              searchQueries: cleanTextArray(searchPlan.searchQueries, 12, 500),
              queryLanes: Array.isArray(searchPlan.queryLanes)
                ? searchPlan.queryLanes.map((lane) => ({
                    lane: cleanText(lane.lane, 80),
                    queries: cleanTextArray(lane.queries, 8, 500),
                  }))
                : [],
              likelyVenueTypes: cleanTextArray(searchPlan.likelyVenueTypes, 8, 120),
            }
          : null,
        articleCandidates: articleCandidates.map(cleanArticleCandidateForLog),
        webEvidence: webEvidence.map(cleanWebPageForLog),
        photoEvidence: photoEvidence.map(cleanPhotoEvidenceForLog),
        providerWarnings: providerWarnings.map((warning) => ({
          provider: cleanText(warning.provider, 160),
          message: cleanText(warning.message, 800),
        })),
      })
      response.json(responseBody)
    } catch (error) {
      console.error(error)
      await appendRunLog(runLogPath, {
        id: runId,
        createdAt: new Date().toISOString(),
        app: 'sf-food-guesser',
        status: 'failed',
        durationMs: Date.now() - runStartedAt,
        upload: uploadMetadata,
        imageViews: uploadedImageViews.map((view) => ({ label: cleanText(view.label, 300) })),
        providers: {
          visionProvider,
          visionModel,
          fallbackModels: visionFallbackModels,
          searchProvider: photoSearch?.provider ?? null,
          webSearchProvider: webSearch?.provider ?? null,
          articleSearchProvider: articleSearch?.provider ?? null,
        },
        error: analysisFailureMessage(error, visionProvider),
      })
      response.status(500).json({
        error: analysisFailureMessage(error, visionProvider),
        runId,
      })
    }
  })

  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error)
      return
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      response.status(413).json({
        error: 'That image is too large. Upload a photo under 12 MB.',
      })
      return
    }

    if (error?.status === 415 || error?.code === 'UNSUPPORTED_IMAGE_TYPE') {
      response.status(415).json({
        error:
          error instanceof Error
            ? error.message
            : 'Unsupported image type. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.',
      })
      return
    }

    if (error instanceof SyntaxError) {
      response.status(400).json({ error: 'Request JSON was not valid.' })
      return
    }

    console.error(error)
    response.status(500).json({ error: 'The local API hit an unexpected error.' })
  })

  return app
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`SF Food Guesser API running at http://127.0.0.1:${port}`)
  })
}
