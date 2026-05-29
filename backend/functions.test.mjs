import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as healthGet } from '../functions/api/health.js'
import { onRequestPost as analyzePhotoPost } from '../functions/api/analyze-photo.js'
import { onRequestPost as feedbackPost } from '../functions/api/feedback.js'
import { onRequestGet as adminFeedbackReviewGet } from '../functions/api/admin/feedback-review.js'
import {
  buildCloudflareQueryLanes,
  fileToDataUrl,
  normalizeAnalysis,
  searchGooglePlacesPhotoEvidence,
} from '../functions/api/_shared.js'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)
const jpegWithExif = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe1, 0x00, 0x10,
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x44, 0x41, 0x54, 0x41, 0x21,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x11, 0x22, 0xff, 0xd9,
])

async function json(response) {
  return response.json()
}

function cloudflareHeaders(overrides = {}) {
  const values = {
    'cf-connecting-ip': '203.0.113.50',
    'user-agent': 'vitest',
    origin: 'https://spotted-in-sf.pages.dev',
    ...overrides,
  }
  return {
    get: (name) => values[name.toLowerCase()] ?? null,
  }
}

function usageEnv(overrides = {}) {
  return {
    OPENROUTER_API_KEY: 'test-openrouter-key',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Cloudflare Pages Functions API', () => {
  it('strips JPEG metadata before building provider data URLs', async () => {
    const dataUrl = await fileToDataUrl(new File([jpegWithExif], 'gps.jpg', { type: 'image/jpeg' }))
    const decoded = Buffer.from(dataUrl.split(',')[1], 'base64').toString('latin1')

    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(decoded).not.toContain('Exif')
    expect(decoded).not.toContain('GPSDATA')
  })

  it('reports Cloudflare runtime health from environment variables', async () => {
    const response = healthGet({
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
        OPENROUTER_FALLBACK_MODELS: 'google/gemma-3-4b-it:free',
      },
    })

    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      runtime: 'cloudflare-pages-functions',
      visionEnabled: true,
      provider: 'openrouter',
      model: 'qwen/qwen3-vl-32b-instruct',
      fallbackModels: ['google/gemma-3-4b-it:free'],
      photoSearchEnabled: false,
      photoSearchProvider: null,
      webSearchProvider: 'openrouter-web-search',
    })
    expect(response.headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('analyzes an uploaded image through the OpenRouter-compatible endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha in a small cafe prep area.',
                    imageEvidence: ['iced matcha', 'brown coffee bags', 'tan aprons'],
                    visibleText: [],
                    searchQueries: ['San Francisco matcha brown coffee bags tan aprons cafe'],
                    likelyVenueTypes: ['cafe'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha in a small cafe prep area.',
                    imageEvidence: ['iced matcha', 'brown coffee bags', 'tan aprons'],
                    candidates: [
                      {
                        id: '',
                        name: 'Kissaten Hifi',
                        category: 'Cafe',
                        neighborhood: 'Richmond',
                        address: '189 6th Ave',
                        confidence: 0.77,
                        evidenceCategories: ['interior_match', 'web_source_match'],
                        reasons: ['The prep area and brown bag shelving match public cafe photos.'],
                        sourceUrls: ['https://example.com/kissaten'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set('venues', JSON.stringify([{ id: 'seed', name: 'Seed Cafe' }]))

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders({ origin: 'https://sf-food-guesser.pages.dev' }),
      },
      env: usageEnv({
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
      }),
    })
    const body = await json(response)
    const [, requestInit] = fetchMock.mock.calls[1]
    const payload = JSON.parse(String(requestInit.body))

    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestInit.signal).toBeInstanceOf(AbortSignal)
    expect(payload.tools[0].type).toBe('openrouter:web_search')
    expect(payload.messages[1].content[0].text).not.toContain('Seed Cafe')
    expect(body).toMatchObject({
      summary: 'Iced matcha in a small cafe prep area.',
      candidates: [
        {
          name: 'Kissaten HiFi',
          confidence: 78,
        },
      ],
      webSearchProvider: 'openrouter-web-search',
      searchPlan: {
        searchQueries: expect.arrayContaining(['San Francisco matcha brown coffee bags tan aprons cafe']),
      },
    })

    fetchMock.mockRestore()
  })

  it('falls back to a simpler Cloudflare vision request when provider tools fail', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'A Mediterranean tray with blue-rim plates.',
                    imageEvidence: ['blue-rim plates', 'salad', 'fries'],
                    visibleText: [],
                    searchQueries: ['San Francisco blue rim plates Mediterranean tray'],
                    likelyVenueTypes: ['restaurant'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Provider tool call failed' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'A Mediterranean tray with blue-rim plates.',
                    imageEvidence: ['blue-rim plates', 'salad', 'fries'],
                    candidates: [
                      {
                        id: '',
                        name: 'Souvla',
                        category: 'Restaurant',
                        neighborhood: 'Hayes Valley',
                        address: '517 Hayes St',
                        confidence: 82,
                        evidenceCategories: ['dish_match', 'visible_brand_match'],
                        reasons: ['The blue-rim plates and Greek dishes match Souvla.'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'souvla.png', { type: 'image/png' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
      }),
    })
    const body = await json(response)
    const primaryPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    const fallbackPayload = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(primaryPayload.tools[0].type).toBe('openrouter:web_search')
    expect(fallbackPayload.tools).toBeUndefined()
    expect(body).toMatchObject({
      candidates: [
        {
          name: 'Souvla',
        },
      ],
      webSearchProvider: null,
      providerWarnings: [
        {
          provider: 'vision-analysis:qwen/qwen3-vl-32b-instruct',
          message: 'Provider tool call failed',
        },
      ],
    })

    fetchMock.mockRestore()
  })

  it('rejects disallowed Cloudflare origins before parsing uploads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = vi.fn(async () => new FormData())

    const response = await analyzePhotoPost({
      request: {
        formData,
        headers: {
          get: (name) =>
            name.toLowerCase() === 'origin' ? 'https://not-this-app.example' : null,
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
      },
    })
    const body = await json(response)

    expect(response.status).toBe(403)
    expect(body.error).toBe('This API origin is not allowed.')
    expect(formData).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('rejects fake Cloudflare image uploads before model providers are called', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    formData.set('photo', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders({ 'cf-connecting-ip': '203.0.113.12' }),
      },
      env: usageEnv(),
    })
    const body = await json(response)

    expect(response.status).toBe(415)
    expect(body.error).toContain('did not look like a real image')
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('reads text from the OCR contact sheet before Cloudflare ranking', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    visibleText: ['SOUVLA'],
                    uncertainText: [],
                    textEvidence: ['SOUVLA logo on tray and cup'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Greek food spread with blue-rim plates.',
                    imageEvidence: ['blue-rim plates', 'Greek fries'],
                    visibleText: [],
                    searchQueries: ['Greek fries blue rim plates San Francisco restaurant'],
                    likelyVenueTypes: ['restaurant'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Greek food spread with SOUVLA branding.',
                    imageEvidence: ['Readable SOUVLA logo', 'Greek fries'],
                    candidates: [
                      {
                        id: 'souvla',
                        name: 'Souvla',
                        category: 'Restaurant',
                        neighborhood: 'Multiple SF neighborhoods',
                        address: 'Multiple San Francisco locations',
                        confidence: 92,
                        evidenceCategories: ['visible_text', 'packaging_logo', 'dish_match'],
                        reasons: ['The OCR pass read SOUVLA on the tray and cup.'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'souvla.png', { type: 'image/png' }))
    formData.set('ocrPhoto', new File([pngPixel], 'souvla-ocr-contact-sheet.jpg', { type: 'image/jpeg' }))
    formData.set('venues', JSON.stringify([{ id: 'souvla', name: 'Souvla' }]))

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
      }),
    })
    const body = await json(response)
    const ocrPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const finalPayload = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))

    expect(response.status).toBe(200)
    expect(ocrPayload.messages[1].content[0].text).toContain('Read exact visible text')
    expect(finalPayload.messages[1].content[0].text).toContain('SOUVLA')
    expect(body.searchPlan).toMatchObject({
      visibleText: ['SOUVLA'],
      ocr: {
        visibleText: ['SOUVLA'],
        textEvidence: ['SOUVLA logo on tray and cup'],
      },
    })
    expect(body.candidates[0]).toMatchObject({
      id: 'souvla',
      name: 'Souvla',
    })

    fetchMock.mockRestore()
  })

  it('ignores non-native OCR sidecar uploads before provider calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Blue-rim plates.',
                    imageEvidence: ['blue-rim plates'],
                    visibleText: [],
                    searchQueries: ['San Francisco blue-rim plates Greek restaurant'],
                    likelyVenueTypes: ['restaurant'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Blue-rim plates with Greek food.',
                    imageEvidence: ['blue-rim plates'],
                    candidates: [
                      {
                        id: 'souvla',
                        name: 'Souvla',
                        confidence: 72,
                        evidenceCategories: ['dish_match'],
                        reasons: ['The dishes and plates are plausible but not identity-level.'],
                      },
                    ],
                    needsMoreEvidence: true,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'souvla.png', { type: 'image/png' }))
    formData.set('ocrPhoto', new File([pngPixel], 'souvla-ocr.heic', { type: 'image/heic' }))

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[1].content[0].text).not.toContain('Read exact visible text')

    fetchMock.mockRestore()
  })

  it('runs Exa evidence searches in parallel before final Cloudflare analysis', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.exa.ai')) {
        const payload = JSON.parse(String(init.body))
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Kissaten HiFi in the Richmond',
                url: `https://example.com/${encodeURIComponent(payload.query)}`,
                highlights: ['Kissaten HiFi serves layered matcha in the Inner Richmond.'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (String(url).includes('api.hasdata.com/scrape/google-maps/search')) {
        const query = new URL(String(url)).searchParams.get('q')
        return new Response(
          JSON.stringify({
            placeResults: {
              title: query?.includes('Kissaten HiFi') ? 'Kissaten HiFi' : 'Generic Matcha Cafe',
              address: '189 6th Ave, San Francisco, CA',
              dataId: query?.includes('Kissaten HiFi') ? 'kissaten-data-id' : 'generic-data-id',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (String(url).includes('api.hasdata.com/scrape/google-maps/photos')) {
        return new Response(
          JSON.stringify({
            photos: [
              {
                image: 'https://lh5.googleusercontent.com/p/kissaten-interior=w1200-h900-k-no',
                thumbnail: 'https://lh5.googleusercontent.com/p/kissaten-interior=w203-h152-k-no',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const payload = JSON.parse(String(init.body))
      const isPlanningCall = !payload.tools
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  isPlanningCall
                    ? {
                        summary: 'Layered matcha with cafe prep area.',
                        imageEvidence: ['layered matcha', 'brown bags'],
                        visibleText: [],
                        searchQueries: [
                          'San Francisco layered matcha brown bags cafe',
                          'San Francisco new Richmond matcha cafe vinyl',
                        ],
                        likelyVenueTypes: ['cafe'],
                      }
                    : {
                        summary: 'Layered matcha with cafe prep area.',
                        imageEvidence: ['layered matcha', 'brown bags'],
                        candidates: [
                          {
                            id: 'kissaten-hifi',
                            name: 'Kissaten HiFi',
                            category: 'Cafe',
                            neighborhood: 'Inner Richmond',
                            address: '189 6th Ave',
                            confidence: 84,
                            evidenceCategories: ['interior_match', 'web_source_match'],
                            reasons: ['Exa evidence and seed hints match the photo.'],
                            sourceUrls: ['https://example.com/kissaten'],
                          },
                        ],
                        needsMoreEvidence: false,
                      },
                ),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set(
      'venues',
      JSON.stringify([
        {
          id: 'kissaten-hifi',
          name: 'Kissaten HiFi',
          address: '189 6th Ave',
          neighborhood: 'Inner Richmond',
          imageEvidenceHints: ['matcha', 'sightglass'],
        },
      ]),
    )

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
        EXA_API_KEY: 'test-exa-key',
        HASDATA_API_KEY: 'test-hasdata-key',
      }),
    })
    const body = await json(response)

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.exa.ai')).length).toBeGreaterThanOrEqual(2)
    const hasDataSearchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('api.hasdata.com/scrape/google-maps/search'),
    )
    expect(hasDataSearchCalls).toHaveLength(1)
    const firstHasDataSearchUrl = new URL(
      String(
        hasDataSearchCalls[0]?.[0],
      ),
    )
    expect(firstHasDataSearchUrl.searchParams.get('q')).toContain('Kissaten HiFi')
    const finalPayload = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(finalPayload.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('External candidate photo 1'),
        }),
        expect.objectContaining({
          type: 'image_url',
          image_url: expect.objectContaining({
            url: 'https://lh5.googleusercontent.com/p/kissaten-interior=w1200-h900-k-no',
          }),
        }),
      ]),
    )
    expect(body).toMatchObject({
      articleSearchProvider: 'exa-deep-highlights',
      searchProvider: 'hasdata-google-maps-photos',
      photoEvidence: [
        expect.objectContaining({
          placeTitle: 'Kissaten HiFi',
          source: 'Google Maps reviews/photos',
        }),
      ],
      webEvidence: expect.arrayContaining([
        expect.objectContaining({
          source: 'exa',
          title: 'Kissaten HiFi in the Richmond',
        }),
      ]),
      candidates: [
        {
          id: 'kissaten-hifi',
          name: 'Kissaten HiFi',
          confidence: 78,
          category: 'Cafe',
          neighborhood: 'Inner Richmond',
          address: '189 6th Ave',
          evidenceCategories: ['interior_match', 'web_source_match'],
          reasons: ['Exa evidence and seed hints match the photo.'],
          sourceUrls: ['https://example.com/kissaten'],
          mapsQuery: 'Kissaten HiFi San Francisco',
        },
      ],
    })

    fetchMock.mockRestore()
  })

  it('uses official Google Places photos without persisting Maps data in the search cache', async () => {
    const get = vi.fn(async () => null)
    const put = vi.fn(async () => undefined)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'places/green-tile-cafe',
                displayName: { text: 'Green Tile Cafe' },
                formattedAddress: '123 Valencia St, San Francisco, CA',
                photos: [{ name: 'places/green-tile-cafe/photos/photo-1' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            photoUri: 'https://lh3.googleusercontent.com/places-photo=w900',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const photos = await searchGooglePlacesPhotoEvidence(
      { searchQueries: ['green tile matcha counter'] },
      {
        GOOGLE_PLACES_API_KEY: 'google-places-key',
        SF_FOOD_SEARCH_CACHE_KV: { get, put },
      },
      fetch,
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://places.googleapis.com/v1/places:searchText')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/places/green-tile-cafe/photos/photo-1/media')
    expect(photos[0]).toMatchObject({
      title: 'Green Tile Cafe Google Places photo',
      source: 'Google Places photos',
      imageUrl: 'https://lh3.googleusercontent.com/places-photo=w900',
    })
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('reranks seeded venue matches above generic web-discovered lookalikes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha with brown bags and tan aprons.',
                    imageEvidence: ['iced matcha', 'brown bags', 'tan aprons'],
                    visibleText: [],
                    searchQueries: ['San Francisco iced matcha brown bags tan aprons cafe'],
                    likelyVenueTypes: ['cafe'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha with brown bags and tan aprons.',
                    imageEvidence: ['iced matcha', 'brown bags', 'tan aprons'],
                    candidates: [
                      {
                        id: '',
                        name: 'Matcha Cafe Maiko',
                        category: 'Cafe',
                        neighborhood: 'Japantown',
                        address: '1581 Webster St',
                        confidence: 80,
                        evidenceCategories: ['dish_match', 'web_source_match'],
                        reasons: ['It serves matcha drinks.'],
                        sourceUrls: ['https://example.com/maiko'],
                      },
                      {
                        id: 'kissaten-hifi',
                        name: 'Kissaten HiFi',
                        category: 'Cafe',
                        neighborhood: 'Inner Richmond',
                        address: '189 6th Ave',
                        confidence: 60,
                        evidenceCategories: ['interior_match', 'web_source_match'],
                        reasons: ['Seed interior hints and public evidence match brown bags and tan aprons.'],
                        sourceUrls: ['https://example.com/kissaten'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set('venues', JSON.stringify([{ id: 'kissaten-hifi', name: 'Kissaten HiFi' }]))

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv(),
    })
    const body = await json(response)

    expect(response.status).toBe(200)
    expect(body.candidates.map((candidate) => candidate.name)).toEqual([
      'Kissaten HiFi',
      'Matcha Cafe Maiko',
    ])

    globalThis.fetch.mockRestore()
  })

  it('recovers a seeded venue when the model omits it but photo clues match', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha with cream top, brown coffee bags, and tan aprons.',
                    imageEvidence: ['iced matcha', 'cream top', 'brown coffee bags', 'tan aprons'],
                    visibleText: [],
                    searchQueries: ['San Francisco iced matcha cream top brown coffee bags tan aprons cafe'],
                    likelyVenueTypes: ['cafe'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha with cream top, brown coffee bags, and tan aprons.',
                    imageEvidence: ['iced matcha', 'cream top', 'brown coffee bags', 'tan aprons'],
                    candidates: [
                      {
                        id: '',
                        name: 'Matcha Cafe Maiko',
                        category: 'Cafe',
                        neighborhood: 'Japantown',
                        address: '1581 Webster St',
                        confidence: 80,
                        evidenceCategories: ['dish_match', 'web_source_match'],
                        reasons: ['It serves matcha drinks.'],
                        sourceUrls: ['https://example.com/maiko'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set(
      'venues',
      JSON.stringify([
        {
          id: 'kissaten-hifi',
          name: 'Kissaten HiFi',
          category: 'Cafe',
          neighborhood: 'Inner Richmond',
          address: '189 6th Ave',
          imageEvidenceHints: ['matcha', 'cream top', 'brown coffee bags', 'tan aprons'],
          sourceUrl: 'https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi',
        },
      ]),
    )

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv(),
    })
    const body = await json(response)

    expect(response.status).toBe(200)
    expect(body.candidates[0]).toMatchObject({
      id: 'kissaten-hifi',
      name: 'Kissaten HiFi',
      address: '189 6th Ave',
    })

    globalThis.fetch.mockRestore()
  })

  it('caps partial packaging text in Cloudflare ranking', () => {
    const result = normalizeAnalysis(
      {
        summary: 'Greek-style food with a cup that says BODEGA.',
        imageEvidence: ['Cup with BODEGA logo', 'blue-rim plates', 'fries'],
        candidates: [
          {
            id: 'bodega-sf',
            name: 'Bodega SF',
            confidence: 100,
            evidenceCategories: ['visible_text', 'packaging_logo', 'dish_match', 'web_source_match'],
            reasons: ["The image shows a cup with a visible 'BODEGA' logo."],
            sourceUrls: ['https://www.bodegasf.com/'],
          },
        ],
      },
      { seedVenueIds: ['bodega-sf'] },
    )

    expect(result.candidates[0]).toMatchObject({
      name: 'Bodega SF',
      confidence: expect.any(Number),
    })
    expect(result.candidates[0].evidenceCategories).not.toContain('visible_text')
    expect(result.candidates[0].confidence).toBeLessThanOrEqual(72)
  })

  it('does not add seed venues from source/search text without direct photo clues', () => {
    const result = normalizeAnalysis(
      {
        summary: 'Burger and fries on a wooden table.',
        imageEvidence: ['burger', 'fries', 'wooden table'],
        candidates: [
          {
            id: '',
            name: 'RT Bistro',
            confidence: 82,
            evidenceCategories: ['dish_match', 'web_source_match'],
            reasons: ['The burger and fries match the article-backed venue.'],
            sourceUrls: ['https://example.com/rt-bistro'],
          },
        ],
      },
      {
        seedVenueIds: ['rintaro'],
        seedVenues: [
          {
            id: 'rintaro',
            name: 'Rintaro',
            category: 'Restaurant',
            neighborhood: 'Mission',
            address: '82 14th St',
            imageEvidenceHints: ['izakaya', 'yakitori', 'udon', 'japanese', 'mission', 'wood'],
            sourceUrl: 'https://www.izakayarintaro.com/',
          },
        ],
        searchPlan: {
          summary: 'Burger and fries.',
          imageEvidence: ['burger', 'fries'],
          searchQueries: ['udon Japanese mission restaurant San Francisco'],
        },
        webEvidence: [
          {
            title: 'Rintaro Japanese izakaya in the Mission',
            source: 'example.com',
            url: 'https://example.com/rintaro',
            snippet: 'Rintaro serves yakitori and handmade udon.',
          },
        ],
      },
    )

    expect(result.candidates.map((candidate) => candidate.name)).not.toContain('Rintaro')
    expect(result.candidates[0].name).toBe('RT Bistro')
  })

  it('separates Cloudflare photo evidence, external evidence, and ranking rules', () => {
    const result = normalizeAnalysis({
      summary: 'Burger and fries on a wooden table.',
      imageEvidence: ['burger', 'fries', 'wooden table'],
      candidates: [
        {
          id: '',
          name: 'RT Bistro',
          confidence: 82,
          evidenceCategories: ['dish_match', 'web_source_match'],
          photoEvidence: ['The uploaded photo shows a burger and fries on a wooden table.'],
          externalEvidence: ['A review page describes RT Bistro as serving a bistro burger.'],
          rankingRules: ['No readable venue text was visible, so confidence is capped.'],
          reasons: ['Legacy combined reason should not be needed by the UI.'],
          sourceUrls: ['https://example.com/rt-bistro'],
        },
      ],
    })

    expect(result.candidates[0]).toMatchObject({
      name: 'RT Bistro',
      photoEvidence: ['The uploaded photo shows a burger and fries on a wooden table.'],
      externalEvidence: ['A review page describes RT Bistro as serving a bistro burger.'],
    })
    expect(result.candidates[0].rankingRules).toEqual(
      expect.arrayContaining(['No readable venue text was visible, so confidence is capped.']),
    )
  })

  it('caps Cloudflare source-only and seed-only guesses', () => {
    const result = normalizeAnalysis(
      {
        summary: 'Burger and fries with no readable venue text.',
        imageEvidence: ['burger', 'fries'],
        candidates: [
          {
            id: 'rintaro',
            name: 'Rintaro',
            confidence: 99,
            evidenceCategories: ['web_source_match'],
            externalEvidence: ['A source page says Rintaro serves udon.'],
            sourceUrls: ['https://example.com/rintaro'],
          },
          {
            id: '',
            name: 'Article Only Cafe',
            confidence: 95,
            evidenceCategories: ['web_source_match'],
            externalEvidence: ['An article mentions a new cafe.'],
            sourceUrls: ['https://example.com/article-only'],
          },
        ],
      },
      { seedVenueIds: ['rintaro'] },
    )

    expect(result.candidates.find((candidate) => candidate.name === 'Rintaro')?.confidence).toBeLessThanOrEqual(40)
    expect(result.candidates.find((candidate) => candidate.name === 'Article Only Cafe')?.confidence).toBeLessThanOrEqual(38)
  })

  it('keeps Cloudflare ranking debug behind an explicit flag', () => {
    const payload = {
      summary: 'Burger and fries with OCR reading RT Bistro.',
      imageEvidence: ['burger', 'fries'],
      candidates: [
        {
          id: 'rintaro',
          name: 'Rintaro',
          confidence: 99,
          evidenceCategories: ['visible_text', 'web_source_match'],
          externalEvidence: ['A source page says Rintaro serves udon.'],
          reasons: ['No readable venue text was visible in the uploaded photo.'],
          sourceUrls: ['https://example.com/rintaro'],
        },
        {
          id: '',
          name: 'Burger Lead',
          confidence: 88,
          evidenceCategories: ['dish_match'],
          photoEvidence: ['The uploaded photo shows a burger.'],
          reasons: ['The photo shows a similar burger.'],
        },
      ],
    }

    const normalResult = normalizeAnalysis(payload, {
      seedVenueIds: ['rintaro'],
      searchPlan: { visibleText: ['RT Bistro'] },
    })
    expect(normalResult).not.toHaveProperty('rankingDebug')

    const debugResult = normalizeAnalysis(payload, {
      seedVenueIds: ['rintaro'],
      searchPlan: { visibleText: ['RT Bistro'] },
      debugRanking: true,
    })
    expect(debugResult.rankingDebug.find((candidate) => candidate.name === 'Rintaro')).toMatchObject({
      status: 'kept',
      reasons: expect.arrayContaining([
        'visible text removed because exact candidate name was not readable',
        'seed source text only',
        'source-only cap',
        'no identity clue',
        'OCR contradicted candidate',
      ]),
    })
    expect(debugResult.rankingDebug.find((candidate) => candidate.name === 'Burger Lead')).toMatchObject({
      reasons: expect.arrayContaining(['dish-only cap']),
    })
  })

  it('builds Cloudflare query lanes and merges duplicate candidates before ranking', () => {
    const lanes = buildCloudflareQueryLanes({
      summary: 'Souvla tray with blue-rim plates.',
      imageEvidence: ['readable Souvla text', 'blue-rim plates'],
      visibleText: ['Souvla'],
      searchQueries: ['blue rim plates Greek food San Francisco photos'],
    })
    const result = normalizeAnalysis({
      summary: 'Souvla tray with blue-rim plates.',
      imageEvidence: ['readable Souvla text', 'blue-rim plates'],
      candidates: [
        {
          id: 'souvla',
          name: 'Souvla',
          confidence: 60,
          evidenceCategories: ['dish_match'],
          photoEvidence: ['The uploaded photo shows Greek food.'],
          sourceUrls: ['https://example.com/menu'],
        },
        {
          id: '',
          name: 'Souvla',
          confidence: 88,
          evidenceCategories: ['visible_text', 'packaging_logo'],
          photoEvidence: ['The uploaded photo contains readable text that says Souvla.'],
          sourceUrls: ['https://example.com/photos'],
        },
      ],
    })

    expect(lanes.map((lane) => lane.lane)).toEqual(
      expect.arrayContaining(['exact_ocr_text', 'dish_menu', 'recent_openings']),
    )
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].evidenceCategories).toEqual(
      expect.arrayContaining(['dish_match', 'visible_text', 'packaging_logo']),
    )
    expect(result.candidates[0].sourceUrls).toEqual(
      expect.arrayContaining(['https://example.com/menu', 'https://example.com/photos']),
    )
  })

  it('rejects unsupported Cloudflare photo uploads before provider calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    formData.set('photo', new File(['not image'], 'notes.txt', { type: 'text/plain' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv(),
    })

    expect(response.status).toBe(415)
    await expect(json(response)).resolves.toMatchObject({
      error: expect.stringContaining('Unsupported image type'),
    })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('rejects provider-unsupported image containers when browser conversion did not happen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    const heicHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00,
    ])
    formData.set('photo', new File([heicHeader], 'photo.heic', { type: 'image/heic' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: cloudflareHeaders(),
      },
      env: usageEnv(),
    })
    const body = await json(response)

    expect(response.status).toBe(415)
    expect(body.error).toMatch(/Export it as JPG, PNG, or WebP/i)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('persists feedback to KV when the binding is configured', async () => {
    const put = vi.fn(async () => undefined)
    const response = await feedbackPost({
      request: new Request('https://sf-food-guesser.pages.dev/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-123',
          vote: 'correct',
          rank: 1,
          candidate: {
            name: 'RT Bistro',
            confidence: 82,
          },
          photo: 'data:image/png;base64,should-not-store',
        }),
      }),
      env: {
        SF_FOOD_FEEDBACK_KV: { put },
      },
    })
    const body = await json(response)
    const feedbackPut = put.mock.calls.find(([key]) => String(key).startsWith('feedback:'))
    const storedRecord = JSON.parse(feedbackPut[1])

    expect(response.status).toBe(201)
    expect(body.persisted).toBe(true)
    expect(storedRecord).toMatchObject({
      runId: 'run-123',
      vote: 'correct',
      candidate: {
        name: 'RT Bistro',
        confidence: 82,
      },
    })
    expect(JSON.stringify(storedRecord)).not.toContain('should-not-store')
  })

  it('persists suggested answer feedback as an unverified claim', async () => {
    const put = vi.fn(async () => undefined)
    const response = await feedbackPost({
      request: new Request('https://sf-food-guesser.pages.dev/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-suggestion',
          sessionId: 'anonymous-session',
          vote: 'suggested_answer',
          suggestedVenue: {
            name: 'Kissaten Hi-Fi',
            neighborhoodOrAddress: '189 6th Ave',
            note: 'Correct place according to user.',
          },
          lineup: [
            {
              rank: 1,
              candidate: {
                name: 'Wrong Cafe',
                confidence: 78,
              },
            },
          ],
          photo: 'data:image/png;base64,should-not-store',
        }),
      }),
      env: {
        SF_FOOD_FEEDBACK_KV: { put },
      },
    })
    const feedbackPut = put.mock.calls.find(([key]) => String(key).startsWith('feedback:'))
    const storedRecord = JSON.parse(feedbackPut[1])

    expect(response.status).toBe(201)
    expect(put).toHaveBeenCalledWith('feedback-suggestion:run-suggestion:anonymous-session', expect.any(String))
    expect(storedRecord).toMatchObject({
      runId: 'run-suggestion',
      sessionId: 'anonymous-session',
      vote: 'suggested_answer',
      suggestedVenue: {
        name: 'Kissaten Hi-Fi',
        verificationStatus: 'unverified_user_claim',
      },
      lineup: [
        {
          rank: 1,
          candidate: {
            name: 'Wrong Cafe',
            confidence: 78,
          },
        },
      ],
    })
    expect(JSON.stringify(storedRecord)).not.toContain('should-not-store')
  })

  it('rejects duplicate suggested answer feedback in KV', async () => {
    const get = vi.fn(async () => 'existing-feedback-id')
    const put = vi.fn(async () => undefined)
    const response = await feedbackPost({
      request: new Request('https://sf-food-guesser.pages.dev/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-suggestion',
          sessionId: 'anonymous-session',
          vote: 'suggested_answer',
          suggestedVenue: {
            name: 'Kissaten Hi-Fi',
          },
        }),
      }),
      env: {
        SF_FOOD_FEEDBACK_KV: { get, put },
      },
    })
    const body = await json(response)

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/already submitted/)
    expect(get).toHaveBeenCalledWith('feedback-suggestion:run-suggestion:anonymous-session')
    expect(put).not.toHaveBeenCalled()
  })

  it('rate limits Cloudflare photo analysis when a rate-limit KV binding is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const get = vi.fn(async () =>
      JSON.stringify({ count: 10, resetAt: Date.now() + 60_000 }),
    )
    const put = vi.fn(async () => undefined)

    const response = await analyzePhotoPost({
      request: {
        formData: async () => {
          throw new Error('Should not parse uploads when rate limited.')
        },
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        SF_FOOD_RATE_LIMIT_KV: { get, put },
        SF_FOOD_ANALYZE_RATE_LIMIT: '10',
      }),
    })
    const body = await json(response)

    expect(response.status).toBe(429)
    expect(body.error).toMatch(/Rate limit reached/)
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('fails closed when Cloudflare rate limiting is required but not bound', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await analyzePhotoPost({
      request: {
        formData: async () => {
          throw new Error('Should not parse uploads without required rate limiting.')
        },
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        SF_FOOD_RATE_LIMIT_REQUIRED: 'true',
      }),
    })
    const body = await json(response)

    expect(response.status).toBe(503)
    expect(body.error).toMatch(/Rate limiting is not configured/)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('fails closed when required Cloudflare rate-limit KV operations fail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await analyzePhotoPost({
      request: {
        formData: async () => {
          throw new Error('Should not parse uploads when required rate limiting is unavailable.')
        },
        headers: cloudflareHeaders(),
      },
      env: usageEnv({
        SF_FOOD_RATE_LIMIT_REQUIRED: 'true',
        SF_FOOD_RATE_LIMIT_KV: {
          get: vi.fn(async () => {
            throw new Error('KV unavailable')
          }),
          put: vi.fn(async () => undefined),
        },
      }),
    })
    const body = await json(response)

    expect(response.status).toBe(503)
    expect(body.error).toMatch(/Rate limiting is temporarily unavailable/)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('downweights repeated suggested corrections from the same anonymous session', async () => {
    const get = vi.fn(async (key) =>
      String(key).startsWith('feedback-suggestion:') ? null : '3',
    )
    const put = vi.fn(async () => undefined)
    const response = await feedbackPost({
      request: new Request('https://sf-food-guesser.pages.dev/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-weight',
          sessionId: 'anonymous-session',
          vote: 'suggested_answer',
          suggestedVenue: {
            name: 'Dubious Cafe',
          },
        }),
      }),
      env: {
        SF_FOOD_FEEDBACK_KV: { get, put },
      },
    })
    const feedbackPut = put.mock.calls.find(([key]) => String(key).startsWith('feedback:'))
    const storedRecord = JSON.parse(feedbackPut[1])

    expect(response.status).toBe(201)
    expect(storedRecord.feedbackWeight).toBe(0.25)
    expect(put).toHaveBeenCalledWith(
      'feedback-weight:anonymous-session:suggested_answer',
      '4',
      { expirationTtl: 30 * 24 * 60 * 60 },
    )
  })

  it('serves Cloudflare feedback review only with the admin token', async () => {
    const list = vi.fn(async () => ({
      keys: [{ name: 'feedback:run-admin:1' }],
      list_complete: true,
    }))
    const get = vi.fn(async () =>
      JSON.stringify({
        createdAt: '2026-05-27T10:00:00.000Z',
        runId: 'run-admin',
        vote: 'correct',
        rank: 1,
        candidate: { name: 'Souvla', confidence: 91 },
      }),
    )

    const blocked = await adminFeedbackReviewGet({
      request: new Request('https://sf-food-guesser.pages.dev/api/admin/feedback-review'),
      env: {
        SF_FOOD_ADMIN_TOKEN: 'admin-token',
        SF_FOOD_FEEDBACK_KV: { list, get },
      },
    })
    expect(blocked.status).toBe(401)

    const response = await adminFeedbackReviewGet({
      request: new Request('https://sf-food-guesser.pages.dev/api/admin/feedback-review', {
        headers: { 'x-admin-token': 'admin-token' },
      }),
      env: {
        SF_FOOD_ADMIN_TOKEN: 'admin-token',
        SF_FOOD_FEEDBACK_KV: { list, get },
      },
    })
    const body = await json(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      recordCount: 1,
      runCount: 1,
      counts: {
        confirmed_top_match: 1,
      },
      runs: [
        expect.objectContaining({
          runId: 'run-admin',
          lastCandidate: 'Souvla',
          classification: expect.objectContaining({
            type: 'confirmed_top_match',
          }),
        }),
      ],
    })
    expect(list).toHaveBeenCalledWith({ prefix: 'feedback:', cursor: undefined, limit: 100 })
    expect(get).toHaveBeenCalledWith('feedback:run-admin:1')
  })

  it('rate limits Cloudflare admin feedback review before checking tokens', async () => {
    const list = vi.fn()
    const get = vi.fn(async () =>
      JSON.stringify({ count: 20, resetAt: Date.now() + 60_000 }),
    )
    const put = vi.fn(async () => undefined)

    const response = await adminFeedbackReviewGet({
      request: new Request('https://sf-food-guesser.pages.dev/api/admin/feedback-review', {
        headers: { 'x-admin-token': 'admin-token' },
      }),
      env: {
        SF_FOOD_ADMIN_TOKEN: 'admin-token',
        SF_FOOD_FEEDBACK_KV: { list, get: vi.fn() },
        SF_FOOD_RATE_LIMIT_KV: { get, put },
        SF_FOOD_ADMIN_REVIEW_RATE_LIMIT: '20',
      },
    })
    const body = await json(response)

    expect(response.status).toBe(429)
    expect(body.error).toMatch(/Rate limit reached/)
    expect(list).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalled()
  })
})
