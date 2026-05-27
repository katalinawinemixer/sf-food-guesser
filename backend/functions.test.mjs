import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as healthGet } from '../functions/api/health.js'
import { onRequestPost as analyzePhotoPost } from '../functions/api/analyze-photo.js'
import { onRequestPost as feedbackPost } from '../functions/api/feedback.js'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

async function json(response) {
  return response.json()
}

function emptyUsageKv() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  }
}

function usageD1({ existingRecord = false, primaryInsertChanges = 1 } = {}) {
  return {
    prepare: vi.fn((sql) => ({
      bind: vi.fn((...params) => ({
        first: vi.fn(async () =>
          sql.startsWith('SELECT') && existingRecord ? { usage_key: params[0] } : null,
        ),
        run: vi.fn(async () => ({
          meta: {
            changes: sql.startsWith('INSERT OR IGNORE') ? primaryInsertChanges : 1,
          },
        })),
      })),
    })),
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
      webSearchProvider: 'openrouter-web-search',
    })
    expect(response.headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('analyzes an uploaded image through the OpenRouter-compatible endpoint', async () => {
    const usageKv = emptyUsageKv()
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
        headers: {
          get: (name) =>
            name.toLowerCase() === 'origin' ? 'https://sf-food-guesser.pages.dev' : null,
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
        SF_FOOD_USAGE_KV: usageKv,
      },
    })
    const body = await json(response)
    const [, requestInit] = fetchMock.mock.calls[1]
    const payload = JSON.parse(String(requestInit.body))

    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toContain('sf_food_free_photo_used=1')
    expect(usageKv.get).toHaveBeenCalled()
    expect(usageKv.put).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it('blocks Cloudflare photo analysis after the anonymous free upload is used', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = vi.fn(async () => new FormData())

    const response = await analyzePhotoPost({
      request: {
        formData,
        headers: {
          get: (name) =>
            name.toLowerCase() === 'cookie' ? 'sf_food_free_photo_used=1' : null,
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
      },
    })
    const body = await json(response)

    expect(response.status).toBe(402)
    expect(body).toMatchObject({
      code: 'upload_limit_reached',
      error: 'This public demo includes one photo analysis for now.',
    })
    expect(formData).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('blocks Cloudflare photo analysis from server usage records even without the cookie', async () => {
    const usageKv = {
      get: vi.fn(async () => '1'),
      put: vi.fn(async () => undefined),
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = vi.fn(async () => new FormData())

    const response = await analyzePhotoPost({
      request: {
        formData,
        headers: {
          get: (name) => {
            const headers = {
              'cf-connecting-ip': '203.0.113.10',
              'user-agent': 'bypass-curl',
              'accept-language': 'en-US',
            }
            return headers[name.toLowerCase()] ?? null
          },
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: usageKv,
      },
    })
    const body = await json(response)

    expect(response.status).toBe(402)
    expect(body).toMatchObject({
      code: 'upload_limit_reached',
      reason: 'server_usage_record',
    })
    expect(formData).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(usageKv.put).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('fails closed when atomic Cloudflare usage limiting is required but D1 is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = vi.fn(async () => new FormData())

    const response = await analyzePhotoPost({
      request: {
        formData,
        headers: {
          get: () => null,
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        REQUIRE_ATOMIC_USAGE_LIMIT: 'true',
      },
    })
    const body = await json(response)

    expect(response.status).toBe(503)
    expect(body.error).toContain('Anonymous upload limiting is not configured')
    expect(formData).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('blocks Cloudflare D1 reservation conflicts before provider calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: {
          get: (name) => {
            const headers = {
              'cf-connecting-ip': '203.0.113.30',
              'user-agent': 'parallel-cross-isolate-test',
              origin: 'https://spotted-in-sf.com',
            }
            return headers[name.toLowerCase()] ?? null
          },
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_DB: usageD1({ primaryInsertChanges: 0 }),
        REQUIRE_ATOMIC_USAGE_LIMIT: 'true',
      },
    })
    const body = await json(response)

    expect(response.status).toBe(402)
    expect(body).toMatchObject({
      code: 'upload_limit_reached',
      reason: 'server_usage_record',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRestore()
  })

  it('blocks concurrent Cloudflare first-upload attempts before duplicate provider calls', async () => {
    const usageKv = emptyUsageKv()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Iced matcha in a cafe.',
                    imageEvidence: ['iced matcha'],
                    visibleText: [],
                    searchQueries: ['San Francisco iced matcha cafe'],
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
                    summary: 'Iced matcha in a cafe.',
                    imageEvidence: ['iced matcha'],
                    candidates: [],
                    needsMoreEvidence: true,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    let releaseFormData
    const delayedFormData = new Promise((resolve) => {
      releaseFormData = resolve
    })
    const formData = new FormData()
    formData.set('photo', new File([pngPixel], 'matcha.png', { type: 'image/png' }))
    formData.set('venues', '[]')
    const headers = {
      get: (name) => {
        const values = {
          'cf-connecting-ip': '203.0.113.20',
          'user-agent': 'parallel-upload-test',
          origin: 'https://spotted-in-sf.com',
        }
        return values[name.toLowerCase()] ?? null
      },
    }

    const firstResponsePromise = analyzePhotoPost({
      request: {
        formData: () => delayedFormData,
        headers,
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: usageKv,
      },
    })
    await Promise.resolve()

    const secondResponse = await analyzePhotoPost({
      request: {
        formData: vi.fn(async () => formData),
        headers,
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: usageKv,
      },
    })

    releaseFormData(formData)
    const firstResponse = await firstResponsePromise
    const secondBody = await json(secondResponse)

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(402)
    expect(secondBody).toMatchObject({
      code: 'upload_limit_reached',
      reason: 'in_flight',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

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
    const usageKv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    formData.set('photo', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: {
          get: (name) =>
            name.toLowerCase() === 'cf-connecting-ip' ? '203.0.113.12' : null,
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: usageKv,
      },
    })
    const body = await json(response)

    expect(response.status).toBe(415)
    expect(body.error).toContain('did not look like a real image')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(usageKv.put).not.toHaveBeenCalled()

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
    formData.set('venues', JSON.stringify([{ id: 'kissaten-hifi', name: 'Kissaten HiFi' }]))

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: {
          get: () => 'https://spotted-in-sf.pages.dev',
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
        EXA_API_KEY: 'test-exa-key',
        SF_FOOD_USAGE_KV: emptyUsageKv(),
      },
    })
    const body = await json(response)

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.exa.ai'))).toHaveLength(2)
    expect(body).toMatchObject({
      articleSearchProvider: 'exa-deep-highlights',
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
          confidence: 96,
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
        headers: {
          get: () => 'https://spotted-in-sf.pages.dev',
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: emptyUsageKv(),
      },
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
        headers: {
          get: () => 'https://spotted-in-sf.pages.dev',
        },
      },
      env: {
        OPENROUTER_API_KEY: 'test-openrouter-key',
        SF_FOOD_USAGE_KV: emptyUsageKv(),
      },
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

  it('rejects unsupported Cloudflare photo uploads before provider calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const formData = new FormData()
    formData.set('photo', new File(['not image'], 'notes.txt', { type: 'text/plain' }))
    formData.set('venues', '[]')

    const response = await analyzePhotoPost({
      request: {
        formData: async () => formData,
        headers: {
          get: () => null,
        },
      },
      env: { OPENROUTER_API_KEY: 'test-openrouter-key' },
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
