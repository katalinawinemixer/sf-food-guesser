import 'dotenv/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import OpenAI from 'openai'

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
const serpApiKey = process.env.SERPAPI_API_KEY
const exaApiKey = process.env.EXA_API_KEY

function parseModelJson(outputText) {
  const jsonStart = outputText.indexOf('{')
  const jsonEnd = outputText.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Model did not return JSON.')
  }

  return JSON.parse(outputText.slice(jsonStart, jsonEnd + 1))
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
- Return 5-8 candidates when uncertainty remains, not just the top 2-3.
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
  webEvidence.map((page, index) => ({
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
  photoEvidence.map((photo, index) => ({
    index: index + 1,
    title: photo.title,
    source: photo.source,
    query: photo.query,
    pageUrl: photo.pageUrl,
    imageUrl: photo.imageUrl,
  })),
)}

Important:
- Compare the uploaded image against the external candidate photos. Use visual overlap with interiors, storefronts, counters, menu boards, decor, lighting, walls, display cases, cups, plates, and packaging.
- Use external web/review pages to discover candidate venue names, addresses, neighborhoods, and pages likely to contain matching public photos.
- Do not pick a candidate just because it has similar food. Similar interiors/photo-page evidence should outrank generic dish matches.
- For every returned candidate, include comparisonPhotos showing which external candidate photos supported it.`
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

async function searchSerpApiPhotos(searchQueries) {
  const photos = []
  const seen = new Set()

  for (const rawQuery of searchQueries.slice(0, 5)) {
    const query = `${rawQuery} San Francisco interior photos Yelp Google Maps`
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google_images')
    url.searchParams.set('q', query)
    url.searchParams.set('api_key', serpApiKey)

    const response = await fetch(url)
    if (!response.ok) continue
    const result = await response.json()
    const imageResults = Array.isArray(result.images_results) ? result.images_results : []

    for (const image of imageResults.slice(0, 6)) {
      const imageUrl = image.original || image.thumbnail
      if (!imageUrl || seen.has(imageUrl)) continue
      seen.add(imageUrl)
      photos.push({
        title: String(image.title ?? image.source ?? 'Candidate photo'),
        source: String(image.source ?? 'Google Images'),
        pageUrl: String(image.link ?? image.source ?? imageUrl),
        imageUrl: String(imageUrl),
        thumbnailUrl: image.thumbnail ? String(image.thumbnail) : String(imageUrl),
        query,
      })
    }
  }

  return photos.slice(0, 18)
}

function createDefaultPhotoSearch() {
  return serpApiKey
    ? {
        provider: 'serpapi-google-images',
        search: searchSerpApiPhotos,
      }
    : null
}

async function searchExaWeb(searchQueries) {
  const pages = []
  const seen = new Set()

  for (const rawQuery of searchQueries.slice(0, 5)) {
    const query = `${rawQuery} San Francisco cafe restaurant interior reviews photos Yelp Google Maps`
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': exaApiKey,
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: 6,
        contents: {
          text: {
            maxCharacters: 700,
          },
        },
      }),
    })
    if (!response.ok) continue

    const result = await response.json()
    const results = Array.isArray(result.results) ? result.results : []
    for (const item of results) {
      const url = item.url || item.id
      if (!url || seen.has(url)) continue
      seen.add(url)
      pages.push({
        title: String(item.title ?? 'Candidate page'),
        source: String(item.author ?? item.publishedDate ?? 'Exa'),
        url: String(url),
        snippet: String(item.text ?? item.summary ?? '').slice(0, 700),
        query,
      })
    }
  }

  return pages.slice(0, 20)
}

function createDefaultWebSearch() {
  return exaApiKey
    ? {
        provider: 'exa',
        search: searchExaWeb,
      }
    : null
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
            ...photoEvidence.flatMap((photo, index) => [
              {
                type: 'text',
                text: `External candidate photo ${index + 1}: ${photo.title} | ${photo.source} | ${photo.pageUrl}`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: photo.imageUrl,
                  detail: 'low',
                },
              },
            ]),
          ],
        },
      ],
      response_format: { type: 'json_object' },
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
      temperature: 0.1,
      max_tokens: 1200,
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
          ...photoEvidence.flatMap((photo, index) => [
            {
              type: 'input_text',
              text: `External candidate photo ${index + 1}: ${photo.title} | ${photo.source} | ${photo.pageUrl}`,
            },
            {
              type: 'input_image',
              image_url: photo.imageUrl,
              detail: 'low',
            },
          ]),
        ],
      },
    ],
    temperature: 0.1,
    max_output_tokens: 1200,
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
      if (photoSearch?.search || webSearch?.search) {
        searchPlan = await describeForExternalPhotoSearch({
          visionClient,
          visionProvider,
          visionModel,
          imageDataUrl,
        })
      }

      if (webSearch?.search && searchPlan) {
        webEvidence = await webSearch.search(searchPlan.searchQueries)
      }

      if (photoSearch?.search && searchPlan) {
        photoEvidence = await photoSearch.search(searchPlan.searchQueries)
      }

      const outputText = await analyzeWithProvider({
        visionClient,
        visionProvider,
        visionModel,
        imageDataUrl,
        compactVenues,
        searchPlan,
        photoEvidence,
        webEvidence,
      })
      const result = parseModelJson(outputText)
      response.json({
        ...result,
        searchPlan,
        photoEvidence: photoEvidence.map((photo) => ({
          title: photo.title,
          source: photo.source,
          pageUrl: photo.pageUrl,
          thumbnailUrl: photo.thumbnailUrl,
          query: photo.query,
        })),
        webEvidence: webEvidence.map((page) => ({
          title: page.title,
          source: page.source,
          url: page.url,
          snippet: page.snippet,
          query: page.query,
        })),
        searchProvider: photoSearch?.provider ?? null,
        webSearchProvider: webSearch?.provider ?? null,
      })
    } catch (error) {
      console.error(error)
      response.status(500).json({
        error: 'The photo analysis failed. Try a clearer image or restart the dev server.',
      })
    }
  })

  return app
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`SF Food Guesser API running at http://127.0.0.1:${port}`)
  })
}
