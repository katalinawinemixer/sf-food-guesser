import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as healthGet } from '../functions/api/health.js'
import { onRequestPost as analyzePhotoPost } from '../functions/api/analyze-photo.js'
import { onRequestPost as feedbackPost } from '../functions/api/feedback.js'
import { normalizeAnalysis } from '../functions/api/_shared.js'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

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
    expect(body).toMatchObject({
      summary: 'Iced matcha in a small cafe prep area.',
      candidates: [
        {
          name: 'Kissaten Hifi',
          confidence: 50,
        },
      ],
      webSearchProvider: 'openrouter-web-search',
      searchPlan: {
        searchQueries: ['San Francisco matcha brown coffee bags tan aprons cafe'],
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
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.exa.ai'))).toHaveLength(2)
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
    const storedRecord = JSON.parse(put.mock.calls[0][1])

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
})
