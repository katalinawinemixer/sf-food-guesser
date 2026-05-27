import request from 'supertest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createApp as createServerApp,
  discoverArticleCandidates,
  rerankCandidates,
  searchCeramicWeb,
  searchExaWeb,
  searchHasDataPhotos,
  searchSerpApiPhotos,
} from './server.mjs'
import { createProviderConfig, parseFallbackModels } from './providers.mjs'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

function createApp(options = {}) {
  return createServerApp({
    feedbackLogPath: false,
    runLogPath: false,
    ...options,
  })
}

describe('SF Food Guesser API', () => {
  it('creates isolated provider wrappers from environment keys', async () => {
    const calls = []
    const searchFns = {
      discoverArticleCandidates: vi.fn(async () => []),
      searchCeramicWeb: vi.fn(async () => []),
      searchExaWeb: vi.fn(async () => []),
      searchHasDataPhotos: vi.fn(async () => []),
      searchSerpApiPhotos: vi.fn(async () => []),
    }
    const providers = createProviderConfig({
      env: {
        OPENROUTER_API_KEY: 'openrouter-key',
        OPENROUTER_VISION_MODEL: 'qwen/qwen3-vl-32b-instruct',
        OPENROUTER_FALLBACK_MODELS: ' google/gemma-3-4b-it:free, openai/gpt-4o-mini ',
        HASDATA_API_KEY: 'hasdata-key',
        SERPAPI_API_KEY: 'serpapi-key',
        CERAMIC_API_KEY: 'ceramic-key',
        EXA_API_KEY: 'exa-key',
      },
      searchFns,
      createVisionClient: false,
    })

    calls.push(providers.photoSearch.provider)
    calls.push(providers.webSearch.provider)
    calls.push(providers.articleSearch.provider)
    await providers.photoSearch.search(['photo query'])
    await providers.webSearch.search(['web query'])
    await providers.articleSearch.search({ summary: 'matcha' })

    expect(providers.visionProvider).toBe('openrouter')
    expect(providers.visionModel).toBe('qwen/qwen3-vl-32b-instruct')
    expect(providers.visionFallbackModels).toEqual([
      'google/gemma-3-4b-it:free',
      'openai/gpt-4o-mini',
    ])
    expect(calls).toEqual([
      'hasdata-google-maps-photos',
      'ceramic-web-search',
      'exa-article-discovery',
    ])
    expect(searchFns.searchHasDataPhotos).toHaveBeenCalledWith(['photo query'], 'hasdata-key')
    expect(searchFns.searchSerpApiPhotos).not.toHaveBeenCalled()
    expect(searchFns.searchCeramicWeb).toHaveBeenCalledWith(['web query'], 'ceramic-key')
    expect(searchFns.searchExaWeb).not.toHaveBeenCalled()
    expect(searchFns.discoverArticleCandidates).toHaveBeenCalledWith(
      { summary: 'matcha' },
      expect.objectContaining({ search: expect.any(Function) }),
    )
  })

  it('falls back from Ceramic to Exa web search when Ceramic is not configured', async () => {
    const searchFns = {
      discoverArticleCandidates: vi.fn(async () => []),
      searchExaWeb: vi.fn(async () => []),
    }
    const providers = createProviderConfig({
      env: {
        OPENAI_API_KEY: 'openai-key',
        EXA_API_KEY: 'exa-key',
      },
      searchFns,
      createVisionClient: false,
    })

    await providers.webSearch.search(['green tile cafe'])

    expect(providers.visionProvider).toBe('openai')
    expect(providers.webSearch.provider).toBe('exa-deep-highlights')
    expect(searchFns.searchExaWeb).toHaveBeenCalledWith(
      ['green tile cafe'],
      expect.objectContaining({ search: expect.any(Function) }),
    )
  })

  it('parses fallback model ids without keeping blank entries', () => {
    expect(parseFallbackModels(' model-a, ,model-b ,, ')).toEqual(['model-a', 'model-b'])
  })

  it('reports when vision is disabled', async () => {
    const response = await request(
      createApp({
        openAIClient: null,
        visionModel: 'test-model',
        visionProvider: null,
        photoSearch: null,
        webSearch: null,
      }),
    )
      .get('/api/health')
      .expect(200)

    expect(response.body).toEqual({
      ok: true,
      visionEnabled: false,
      model: 'test-model',
      fallbackModels: [],
      provider: null,
      photoSearchEnabled: false,
      photoSearchProvider: null,
      webSearchEnabled: false,
      webSearchProvider: null,
      articleSearchEnabled: false,
      articleSearchProvider: null,
    })
  })

  it('rejects photo analysis without a vision client', async () => {
    const response = await request(createApp({ openAIClient: null, photoSearch: null }))
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(503)

    expect(response.body.error).toMatch(/OPENROUTER_API_KEY|OPENAI_API_KEY/)
  })

  it('rejects analysis requests that do not include a photo', async () => {
    const openAIClient = {
      responses: {
        create: vi.fn(),
      },
    }

    const response = await request(createApp({ openAIClient, photoSearch: null }))
      .post('/api/analyze-photo')
      .field('venues', '[]')
      .expect(400)

    expect(response.body.error).toMatch(/No photo/)
    expect(openAIClient.responses.create).not.toHaveBeenCalled()
  })

  it('rejects unsupported image uploads with a clear error', async () => {
    const response = await request(createApp({ openAIClient: null, photoSearch: null }))
      .post('/api/analyze-photo')
      .attach('photo', Buffer.from('not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .field('venues', '[]')
      .expect(415)

    expect(response.body.error).toMatch(/Unsupported image type/)
  })

  it('rejects oversized image uploads with a clear error', async () => {
    const response = await request(createApp({ openAIClient: null, photoSearch: null }))
      .post('/api/analyze-photo')
      .attach('photo', Buffer.alloc(12 * 1024 * 1024 + 1), {
        filename: 'large.jpg',
        contentType: 'image/jpeg',
      })
      .field('venues', '[]')
      .expect(413)

    expect(response.body.error).toMatch(/under 12 MB/)
  })

  it('allows configured production origins and rejects unknown API origins', async () => {
    await request(createApp({ openAIClient: null, photoSearch: null }))
      .get('/api/health')
      .set('Origin', 'http://127.0.0.1:5173')
      .expect('Access-Control-Allow-Origin', 'http://127.0.0.1:5173')
      .expect(200)

    const response = await request(createApp({ openAIClient: null, photoSearch: null }))
      .get('/api/health')
      .set('Origin', 'https://not-this-app.example')
      .expect(403)

    expect(response.body.error).toMatch(/origin is not allowed/)
  })

  it('records guess feedback without storing uploaded photos', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sf-food-feedback-'))
    const feedbackLogPath = join(tempDir, 'feedback.jsonl')

    try {
      const response = await request(
        createApp({
          openAIClient: null,
          photoSearch: null,
          feedbackLogPath,
        }),
      )
        .post('/api/feedback')
        .send({
          runId: 'run-123',
          vote: 'incorrect',
          rank: 1,
          candidate: {
            id: 'web:Souvla',
            name: 'Souvla',
            category: 'Restaurant',
            neighborhood: 'San Francisco',
            address: 'Address not confirmed',
            confidence: 82,
            evidenceCategories: ['visible_text', 'packaging_logo'],
            reasons: ['The uploaded image contains readable visible text that says Souvla.'],
          },
          analysis: {
            summary: 'Food spread with visible tray text.',
            imageEvidence: ['SOUVLA text on tray'],
            needsMoreEvidence: true,
          },
          providers: {
            webSearchProvider: 'test-web',
          },
          photo: 'data:image/png;base64,should-not-be-stored',
        })
        .expect(201)

      expect(response.body.ok).toBe(true)
      const lines = (await readFile(feedbackLogPath, 'utf8')).trim().split('\n')
      const record = JSON.parse(lines[0])

      expect(record).toMatchObject({
        app: 'sf-food-guesser',
        runId: 'run-123',
        vote: 'incorrect',
        rank: 1,
        candidate: {
          name: 'Souvla',
          confidence: 82,
          evidenceCategories: ['visible_text', 'packaging_logo'],
        },
        analysis: {
          summary: 'Food spread with visible tray text.',
          imageEvidence: ['SOUVLA text on tray'],
        },
        providers: {
          webSearchProvider: 'test-web',
        },
      })
      expect(JSON.stringify(record)).not.toContain('should-not-be-stored')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('records unverified suggested answers with a lineup snapshot', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sf-food-correction-'))
    const feedbackLogPath = join(tempDir, 'feedback.jsonl')

    try {
      await request(
        createApp({
          openAIClient: null,
          photoSearch: null,
          feedbackLogPath,
        }),
      )
        .post('/api/feedback')
        .send({
          runId: 'run-correction',
          sessionId: 'anonymous-session',
          vote: 'suggested_answer',
          suggestedVenue: {
            name: 'Kissaten Hi-Fi',
            neighborhoodOrAddress: '189 6th Ave',
            note: 'Interior and cups match public photos.',
          },
          lineup: [
            {
              rank: 1,
              candidate: {
                name: 'Wrong Cafe One',
                confidence: 78,
                evidenceCategories: ['interior_match'],
              },
            },
            {
              rank: 2,
              candidate: {
                name: 'Wrong Cafe Two',
                confidence: 78,
                evidenceCategories: ['dish_match'],
              },
            },
          ],
          photo: 'data:image/png;base64,should-not-be-stored',
        })
        .expect(201)

      const record = JSON.parse((await readFile(feedbackLogPath, 'utf8')).trim())

      expect(record).toMatchObject({
        runId: 'run-correction',
        sessionId: 'anonymous-session',
        vote: 'suggested_answer',
        suggestedVenue: {
          name: 'Kissaten Hi-Fi',
          neighborhoodOrAddress: '189 6th Ave',
          verificationStatus: 'unverified_user_claim',
        },
      })
      expect(record.lineup).toEqual(expect.arrayContaining([
          expect.objectContaining({
            rank: 1,
            candidate: expect.objectContaining({
              name: 'Wrong Cafe One',
              confidence: 78,
            }),
          }),
      ]))
      expect(JSON.stringify(record)).not.toContain('should-not-be-stored')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('records completed analysis runs without storing uploaded photos', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sf-food-runs-'))
    const runLogPath = join(tempDir, 'runs.jsonl')
    const openAIClient = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            summary: 'A burger on a scalloped plate.',
            imageEvidence: ['burger', 'scalloped plate'],
            candidates: [
              {
                id: '',
                name: 'RT Bistro',
                category: 'Restaurant',
                neighborhood: 'Hayes Valley',
                address: '205 Oak St',
                confidence: 76,
                evidenceCategories: ['dish_match', 'web_source_match'],
                reasons: ['The burger and plate match known photos.'],
                sourceUrls: ['https://example.com/rt-bistro'],
              },
            ],
            needsMoreEvidence: true,
          }),
        })),
      },
    }

    try {
      const response = await request(
        createApp({
          openAIClient,
          visionModel: 'test-model',
          visionProvider: 'openai',
          photoSearch: null,
          webSearch: null,
          runLogPath,
        }),
      )
        .post('/api/analyze-photo')
        .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
        .field('venues', '[]')
        .expect(200)

      expect(response.body.runId).toBeTruthy()
      const lines = (await readFile(runLogPath, 'utf8')).trim().split('\n')
      const record = JSON.parse(lines[0])

      expect(record).toMatchObject({
        id: response.body.runId,
        app: 'sf-food-guesser',
        status: 'completed',
        upload: {
          mimeType: 'image/png',
        },
        providers: {
          visionProvider: 'openai',
          visionModel: 'test-model',
        },
        summary: 'A burger on a scalloped plate.',
        imageEvidence: ['burger', 'scalloped plate'],
        candidates: [
          {
            name: 'RT Bistro',
            confidence: 58,
          },
        ],
      })
      expect(record.upload.sizeBytes).toBeGreaterThan(0)
      expect(JSON.stringify(record)).not.toContain('base64')
      expect(JSON.stringify(record)).not.toContain('iVBOR')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns parsed model JSON from the vision client', async () => {
    const openAIClient = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            summary: 'A focaccia-style pizza slice.',
            imageEvidence: ['square slice'],
            candidates: [
              {
                id: 'golden-boy',
                confidence: 92,
                evidenceCategories: ['dish_match', 'web_source_match'],
                reasons: ['The slice shape matches the venue signature.'],
                sourceUrls: ['https://www.goldenboypizza.com/'],
              },
            ],
            needsMoreEvidence: false,
          }),
        })),
      },
    }

    const response = await request(
      createApp({
        openAIClient,
        visionModel: 'test-model',
        visionProvider: 'openai',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field(
        'venues',
        JSON.stringify([
          {
            id: 'golden-boy',
            name: 'Golden Boy Pizza',
            category: 'Counter',
            neighborhood: 'North Beach',
            address: '542 Green St',
            signature: ['Focaccia pizza'],
            imageEvidenceHints: ['square slice'],
            note: 'North Beach slice counter.',
          },
        ]),
      )
      .expect(200)

    expect(response.body.candidates[0]).toMatchObject({
      id: 'golden-boy',
      evidenceCategories: ['dish_match', 'web_source_match'],
      originalConfidence: 92,
    })
    expect(response.body.candidates[0].confidence).toBeGreaterThan(45)
    expect(openAIClient.responses.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        temperature: 0.1,
      }),
    )
    const modelRequest = openAIClient.responses.create.mock.calls[0][0]
    const userContent = modelRequest.input[1].content
    expect(userContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_image' }),
      ]),
    )
    expect(userContent[0].text).toContain('imageEvidenceHints')
    expect(userContent[0].text).not.toContain('"clue"')
    expect(userContent[0].text).not.toContain('"manual"')
  })

  it('allows repeated anonymous local photo analysis requests', async () => {
    const openAIClient = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            summary: 'A focaccia-style pizza slice.',
            imageEvidence: ['square slice'],
            candidates: [
              {
                id: 'golden-boy',
                confidence: 92,
                evidenceCategories: ['dish_match', 'web_source_match'],
                reasons: ['The slice shape matches the venue signature.'],
                sourceUrls: ['https://www.goldenboypizza.com/'],
              },
            ],
            needsMoreEvidence: false,
          }),
        })),
      },
    }
    const app = createApp({
      openAIClient,
      visionModel: 'test-model',
      visionProvider: 'openai',
      photoSearch: null,
      webSearch: null,
    })
    const agent = request.agent(app)

    const firstResponse = await agent
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(firstResponse.headers['set-cookie']).toBeUndefined()

    const secondResponse = await agent
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(secondResponse.body).toMatchObject({ summary: 'A focaccia-style pizza slice.' })
    expect(openAIClient.responses.create).toHaveBeenCalledTimes(2)
  })

  it('rejects fake local image uploads before model providers are called', async () => {
    const openAIClient = {
      responses: {
        create: vi.fn(),
      },
    }
    const app = createApp({
      openAIClient,
      visionModel: 'test-model',
      visionProvider: 'openai',
      photoSearch: null,
      webSearch: null,
    })

    const response = await request(app)
      .post('/api/analyze-photo')
      .attach('photo', Buffer.from('not really a png'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .field('venues', '[]')
      .expect(415)

    expect(response.body.error).toContain('did not look like a real image')
    expect(openAIClient.responses.create).not.toHaveBeenCalled()
  })

  it('sends OpenRouter-compatible chat completion requests when configured', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'A storefront photo near a slice counter.',
                    imageEvidence: ['square slice', 'North Beach'],
                    candidates: [
                      {
                        id: 'golden-boy',
                        confidence: 88,
                        evidenceCategories: ['storefront_match', 'web_source_match'],
                        reasons: ['The image includes a square pizza slice.'],
                        sourceUrls: ['https://www.goldenboypizza.com/'],
                      },
                    ],
                    needsMoreEvidence: false,
                  }),
                },
              },
            ],
          })),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionFallbackModels: [],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field(
        'venues',
        JSON.stringify([
          {
            id: 'golden-boy',
            name: 'Golden Boy Pizza',
            category: 'Counter',
            neighborhood: 'North Beach',
            address: '542 Green St',
            signature: ['Focaccia pizza'],
            imageEvidenceHints: ['square slice'],
            note: 'North Beach slice counter.',
          },
        ]),
      )
      .expect(200)

    expect(response.body.candidates[0]).toMatchObject({
      id: 'golden-boy',
      originalConfidence: 88,
    })
    expect(response.body.candidates[0].evidenceCategories).toEqual(
      expect.arrayContaining(['storefront_match', 'web_source_match']),
    )
    expect(response.body.candidates[0].confidence).toBeGreaterThan(70)
    expect(visionClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai/gpt-4o-mini',
        response_format: { type: 'json_object' },
        tools: [
          expect.objectContaining({
            type: 'openrouter:web_search',
          }),
        ],
        temperature: 0.1,
      }),
    )

    const modelRequest = visionClient.chat.completions.create.mock.calls[0][0]
    const promptText = modelRequest.messages[1].content[0].text
    expect(modelRequest.messages[0].content).toContain('seed data')
    expect(modelRequest.messages[0].content).not.toContain('use only the provided venue list')
    expect(promptText).toContain('Google Maps / Google Business Profile')
    expect(promptText).toContain('matching interiors and public customer/business photos')
    expect(promptText).toContain('Return 3-5 candidates')
    expect(modelRequest.tools[0].parameters).toMatchObject({
      max_results: 10,
      max_total_results: 40,
      search_context_size: 'high',
    })
    expect(modelRequest.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' }),
      ]),
    )
  })

  it('retries OpenRouter analysis without the web-search tool when the first analysis call fails', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error('OpenRouter 500'))
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'A matcha drink without enough venue evidence.',
                      imageEvidence: ['matcha drink'],
                      candidates: [
                        {
                          id: '',
                          name: 'Unconfirmed Matcha Cafe',
                          category: 'Cafe',
                          neighborhood: 'San Francisco',
                          address: 'Address not confirmed',
                          confidence: 45,
                          evidenceCategories: ['dish_match'],
                          reasons: ['Only the drink is clearly visible.'],
                          sourceUrls: [],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionFallbackModels: [],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(response.body.providerWarnings[0]).toMatchObject({
      provider: 'vision-analysis:openai/gpt-4o-mini',
      message: 'OpenRouter 500',
    })
    expect(response.body.candidates[0].name).toBe('Unconfirmed Matcha Cafe')
    expect(visionClient.chat.completions.create.mock.calls[0][0].tools).toBeDefined()
    expect(visionClient.chat.completions.create.mock.calls[1][0].tools).toBeUndefined()
  })

  it('returns a specific message when OpenRouter lacks credits', async () => {
    const creditError = Object.assign(new Error('This request requires more credits.'), {
      status: 402,
    })
    const visionClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(creditError),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionFallbackModels: [],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(500)

    expect(response.body.error).toContain('OpenRouter needs more credits')
    expect(response.body.error).not.toContain('clearer image')
    expect(visionClient.chat.completions.create).toHaveBeenCalledTimes(2)
  })

  it('returns a specific message when OpenRouter DNS lookup fails', async () => {
    const dnsError = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), {
          code: 'ENOTFOUND',
          hostname: 'openrouter.ai',
        }),
      }),
    })
    const visionClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(dnsError),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionFallbackModels: [],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(500)

    expect(response.body.error).toContain('OpenRouter could not be reached')
    expect(response.body.error).toContain('DNS/network lookup failed')
  })

  it('tries configured fallback vision models when the primary model is rate-limited', async () => {
    const rateLimitError = Object.assign(new Error('Provider returned error'), {
      status: 429,
    })
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(rateLimitError)
            .mockRejectedValueOnce(rateLimitError)
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Fallback model analyzed the uploaded image.',
                      imageEvidence: ['matcha drink'],
                      candidates: [
                        {
                          id: '',
                          name: 'Fallback Vision Cafe',
                          category: 'Cafe',
                          neighborhood: 'San Francisco',
                          address: 'Address not confirmed',
                          confidence: 50,
                          evidenceCategories: ['dish_match'],
                          reasons: ['Fallback model could inspect the image.'],
                          sourceUrls: [],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'primary/free-vision',
        visionFallbackModels: ['fallback/free-vision'],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(visionClient.chat.completions.create.mock.calls.map(([requestBody]) => requestBody.model)).toEqual([
      'primary/free-vision',
      'primary/free-vision',
      'fallback/free-vision',
    ])
    expect(response.body.visionModel).toBe('fallback/free-vision')
    expect(response.body.providerWarnings).toEqual([
      expect.objectContaining({ provider: 'vision-analysis:primary/free-vision' }),
      expect.objectContaining({ provider: 'vision-analysis-fallback:primary/free-vision' }),
    ])
    expect(response.body.candidates[0].name).toBe('Fallback Vision Cafe')
  })

  it('repairs malformed model JSON before trying the next fallback model', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: 'I think this is probably a cafe.' } }],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'JSON repair returned strict JSON.',
                      imageEvidence: ['matcha drink'],
                      candidates: [
                        {
                          id: '',
                          name: 'JSON Repair Cafe',
                          category: 'Cafe',
                          neighborhood: 'San Francisco',
                          address: 'Address not confirmed',
                          confidence: 48,
                          evidenceCategories: ['dish_match'],
                          reasons: ['The JSON repair call returned parseable JSON.'],
                          sourceUrls: [],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'primary/free-vision',
        visionFallbackModels: ['fallback/free-vision'],
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(visionClient.chat.completions.create.mock.calls.map(([requestBody]) => requestBody.model)).toEqual([
      'primary/free-vision',
      'primary/free-vision',
    ])
    expect(response.body.providerWarnings[0]).toMatchObject({
      provider: 'vision-analysis-json:primary/free-vision',
      message: 'Model did not return JSON.',
    })
    expect(response.body.visionModel).toBe('primary/free-vision')
    expect(response.body.candidates[0].name).toBe('JSON Repair Cafe')
  })

  it('uses a photo-search provider to compare external candidate photos', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Cafe interior with a green tile wall.',
                      imageEvidence: ['green tile wall', 'pastry case'],
                      searchQueries: [
                        'San Francisco cafe green tile wall pastry case interior photos',
                      ],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'The uploaded image matches a cafe interior photo.',
                      imageEvidence: ['green tile wall', 'pastry case'],
                      candidates: [
                        {
                          id: '',
                          name: 'Green Tile Cafe',
                          category: 'Cafe',
                          neighborhood: 'Mission',
                          address: '123 Valencia St',
                          confidence: 86,
                          evidenceType: 'interior',
                          evidenceCategories: ['interior_match', 'web_source_match'],
                          reasons: ['External candidate photo shows the same green tile wall.'],
                          sourceUrls: ['https://example.com/green-tile-cafe'],
                          comparisonPhotos: [
                            {
                              title: 'Green Tile Cafe interior',
                              source: 'Google Images',
                              url: 'https://example.com/green-tile-cafe',
                              matchReason: 'Same tile and pastry case.',
                            },
                          ],
                        },
                      ],
                      needsMoreEvidence: false,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => [
        {
          title: 'Green Tile Cafe interior',
          source: 'Google Images',
          pageUrl: 'https://example.com/green-tile-cafe',
          imageUrl: 'https://example.com/green-tile-cafe.jpg',
          thumbnailUrl: 'https://example.com/green-tile-cafe-thumb.jpg',
          query: 'San Francisco cafe green tile wall pastry case interior photos',
        },
      ]),
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        photoSearch,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(photoSearch.search).toHaveBeenCalledWith([
      'San Francisco cafe green tile wall pastry case interior photos',
    ])
    expect(response.body.searchProvider).toBe('mock-photo-search')
    expect(response.body.photoEvidence[0]).toMatchObject({
      title: 'Green Tile Cafe interior',
      source: 'Google Images',
    })
    expect(response.body.candidates[0]).toMatchObject({
      name: 'Green Tile Cafe',
      evidenceType: 'interior',
    })

    const comparisonRequest = visionClient.chat.completions.create.mock.calls[1][0]
    expect(comparisonRequest.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('External candidate photo 1'),
        }),
        expect.objectContaining({
          type: 'image_url',
          image_url: expect.objectContaining({
            url: 'https://example.com/green-tile-cafe.jpg',
          }),
        }),
      ]),
    )
  })

  it('turns readable brand text into exact search queries', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'A table spread with visible restaurant branding.',
                      imageEvidence: ['blue-rim plates', 'visible tray text'],
                      visibleText: ['Souvla'],
                      searchQueries: ['San Francisco Greek counter blue rim plates photos'],
                      likelyVenueTypes: ['Restaurant', 'Counter'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Visible Souvla text identifies the restaurant brand.',
                      imageEvidence: ['Readable Souvla text on the tray liner'],
                      candidates: [
                        {
                          id: '',
                          name: 'Souvla',
                          category: 'Restaurant',
                          neighborhood: 'San Francisco',
                          address: '',
                          confidence: 90,
                          evidenceType: 'packaging',
                          evidenceCategories: ['visible_text', 'packaging_logo'],
                          reasons: ['The tray liner has readable visible branding that says Souvla.'],
                          sourceUrls: ['https://www.souvla.com/'],
                          comparisonPhotos: [],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => []),
    }

    await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        photoSearch,
        webSearch: null,
        articleSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(photoSearch.search).toHaveBeenCalledWith([
      '"Souvla" San Francisco restaurant cafe',
      '"Souvla" San Francisco menu photos reviews',
      'San Francisco Greek counter blue rim plates photos',
    ])
  })

  it('retries comparison without external image URLs when the image-heavy request fails', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Matcha drink in a cafe prep area.',
                      imageEvidence: ['matcha drink', 'brown bags on shelves'],
                      searchQueries: ['San Francisco matcha cafe brown bags shelves photos'],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockRejectedValueOnce(new Error('OpenRouter 500'))
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Fallback comparison used photo metadata and web evidence.',
                      imageEvidence: ['matcha drink', 'brown bags on shelves'],
                      candidates: [
                        {
                          id: '',
                          name: 'Photo Metadata Cafe',
                          category: 'Cafe',
                          neighborhood: 'Mission',
                          address: '100 Example St',
                          confidence: 76,
                          evidenceType: 'interior',
                          evidenceCategories: ['interior_match', 'web_source_match'],
                          reasons: ['A returned Google Maps photo page names the same cafe.'],
                          sourceUrls: ['https://example.com/page-1'],
                          comparisonPhotos: [
                            {
                              title: 'Photo Metadata Cafe customer photo',
                              source: 'Google Maps reviews/photos',
                              url: 'https://example.com/page-1',
                              matchReason: 'Same prep shelf context.',
                            },
                          ],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const photoEvidence = Array.from({ length: 10 }, (_, index) => ({
      title: `Candidate ${index + 1}`,
      source: 'Google Maps reviews/photos',
      pageUrl: `https://example.com/page-${index + 1}`,
      imageUrl: `https://example.com/photo-${index + 1}.jpg`,
      thumbnailUrl: `https://example.com/thumb-${index + 1}.jpg`,
      query: 'San Francisco matcha cafe brown bags shelves photos',
    }))
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => photoEvidence),
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        photoSearch,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(response.body.providerWarnings).toEqual([
      expect.objectContaining({
        provider: 'vision-analysis:openai/gpt-4o-mini',
        message: 'OpenRouter 500',
      }),
    ])
    expect(response.body.candidates[0]).toMatchObject({
      name: 'Photo Metadata Cafe',
    })

    const imageHeavyRequest = visionClient.chat.completions.create.mock.calls[1][0]
    const imageHeavyExternalImages = imageHeavyRequest.messages[1].content.filter(
      (part) => part.type === 'image_url' && part.image_url.url.includes('example.com/photo-'),
    )
    expect(imageHeavyExternalImages).toHaveLength(4)

    const fallbackRequest = visionClient.chat.completions.create.mock.calls[2][0]
    const fallbackExternalImages = fallbackRequest.messages[1].content.filter(
      (part) => part.type === 'image_url' && part.image_url.url.includes('example.com/photo-'),
    )
    const fallbackUploadedImages = fallbackRequest.messages[1].content.filter(
      (part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg'),
    )
    expect(fallbackExternalImages).toHaveLength(0)
    expect(fallbackUploadedImages).toHaveLength(1)
    expect(fallbackRequest.tools).toBeUndefined()
  })

  it('searches Google Maps places before fetching Google review photos', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            local_results: [
              {
                title: 'Green Tile Cafe',
                address: '123 Valencia St, San Francisco, CA',
                data_id: '0xabc:0x123',
                place_id: 'place-123',
                gps_coordinates: { latitude: 37.76, longitude: -122.42 },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            photos: [
              {
                image: 'https://lh5.googleusercontent.com/p/interior=w1200-h900-k-no',
                thumbnail: 'https://lh5.googleusercontent.com/p/interior=w203-h152-k-no',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const photos = await searchSerpApiPhotos(['green tile matcha counter'])
    const firstUrl = new URL(fetchMock.mock.calls[0][0])
    const secondUrl = new URL(fetchMock.mock.calls[1][0])

    expect(firstUrl.searchParams.get('engine')).toBe('google_maps')
    expect(firstUrl.searchParams.get('q')).toContain('green tile matcha counter')
    expect(secondUrl.searchParams.get('engine')).toBe('google_maps_photos')
    expect(secondUrl.searchParams.get('data_id')).toBe('0xabc:0x123')
    expect(photos[0]).toMatchObject({
      title: 'Green Tile Cafe customer photo',
      source: 'Google Maps reviews/photos',
      imageUrl: 'https://lh5.googleusercontent.com/p/interior=w1200-h900-k-no',
      placeTitle: 'Green Tile Cafe',
      placeAddress: '123 Valencia St, San Francisco, CA',
    })

    fetchMock.mockRestore()
  })

  it('starts Google Maps place searches in parallel before fetching review photos', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      const engine = url.searchParams.get('engine')
      const query = url.searchParams.get('q') ?? ''
      const dataId = url.searchParams.get('data_id') ?? ''

      if (engine === 'google_maps') {
        const suffix = query.includes('second') ? 'second' : 'first'
        return new Response(
          JSON.stringify({
            local_results: [
              {
                title: `${suffix} cafe`,
                address: `${suffix} address, San Francisco, CA`,
                data_id: `data-${suffix}`,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          photos: [
            {
              image: `https://lh5.googleusercontent.com/p/${dataId}=w1200-h900-k-no`,
              thumbnail: `https://lh5.googleusercontent.com/p/${dataId}=w203-h152-k-no`,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const photos = await searchSerpApiPhotos(['first matcha counter', 'second matcha counter'])
    const engines = fetchMock.mock.calls.map(([input]) =>
      new URL(String(input)).searchParams.get('engine'),
    )

    expect(engines.slice(0, 2)).toEqual(['google_maps', 'google_maps'])
    expect(engines).toContain('google_maps_photos')
    expect(photos.map((photo) => photo.placeTitle)).toEqual(['first cafe', 'second cafe'])

    fetchMock.mockRestore()
  })

  it('uses HasData Maps search before fetching Google review photos', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            placeResults: {
              title: 'Green Tile Cafe',
              address: '123 Valencia St, San Francisco, CA',
              dataId: '0xabc:0x123',
              placeId: 'place-123',
              gpsCoordinates: { latitude: 37.76, longitude: -122.42 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            photos: [
              {
                image: 'https://lh5.googleusercontent.com/p/hasdata-interior=w1200-h900-k-no',
                thumbnail: 'https://lh5.googleusercontent.com/p/hasdata-interior=w203-h152-k-no',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const photos = await searchHasDataPhotos(['green tile matcha counter'])
    const firstUrl = new URL(fetchMock.mock.calls[0][0])
    const secondUrl = new URL(fetchMock.mock.calls[1][0])
    const firstOptions = fetchMock.mock.calls[0][1]

    expect(firstUrl.href).toContain('/scrape/google-maps/search')
    expect(firstUrl.searchParams.get('q')).toContain('green tile matcha counter')
    expect(firstOptions.headers).toHaveProperty('x-api-key')
    expect(secondUrl.href).toContain('/scrape/google-maps/photos')
    expect(secondUrl.searchParams.get('dataId')).toBe('0xabc:0x123')
    expect(photos[0]).toMatchObject({
      title: 'Green Tile Cafe customer photo',
      source: 'Google Maps reviews/photos',
      imageUrl: 'https://lh5.googleusercontent.com/p/hasdata-interior=w1200-h900-k-no',
      placeTitle: 'Green Tile Cafe',
      placeAddress: '123 Valencia St, San Francisco, CA',
    })

    fetchMock.mockRestore()
  })

  it('does not fan out HasData Maps searches after the seed query returns places', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            placeResults: {
              title: 'Kissaten HiFi',
              address: '189 6th Ave, San Francisco, CA',
              dataId: 'kissaten-data-id',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ photos: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    await searchHasDataPhotos([
      'Kissaten HiFi 189 6th Ave San Francisco Google Maps reviews photos interior',
      'San Francisco layered matcha brown bags cafe',
      'San Francisco new Richmond matcha cafe vinyl',
    ])

    const mapSearchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/scrape/google-maps/search'),
    )
    expect(mapSearchCalls).toHaveLength(1)
    expect(new URL(String(mapSearchCalls[0][0])).searchParams.get('q')).toContain('Kissaten HiFi')

    fetchMock.mockRestore()
  })

  it('uses an Exa-style web provider to collect review pages before ranking', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Cafe interior with a black counter and pastry case.',
                      imageEvidence: ['black counter', 'pastry case'],
                      searchQueries: ['San Francisco cafe black counter pastry case interior'],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'A cafe interior compared against web review pages.',
                      imageEvidence: ['black counter', 'pastry case'],
                      candidates: [
                        {
                          id: '',
                          name: 'Black Counter Cafe',
                          category: 'Cafe',
                          neighborhood: 'Mission',
                          address: '456 Valencia St',
                          confidence: 78,
                          evidenceType: 'interior',
                          evidenceCategories: ['interior_match', 'web_source_match'],
                          reasons: ['Exa review pages mention a matching black counter.'],
                          sourceUrls: ['https://example.com/black-counter-cafe-review'],
                        },
                      ],
                      needsMoreEvidence: false,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const webSearch = {
      provider: 'exa',
      search: vi.fn(async () => [
        {
          title: 'Black Counter Cafe review',
          source: 'Exa',
          url: 'https://example.com/black-counter-cafe-review',
          snippet: 'Review mentions black counter, pastry case, and cafe interior.',
          query: 'San Francisco cafe black counter pastry case interior',
        },
      ]),
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(webSearch.search).toHaveBeenCalledWith([
      'San Francisco cafe black counter pastry case interior',
    ])
    expect(response.body.webSearchProvider).toBe('exa')
    expect(response.body.webEvidence[0]).toMatchObject({
      title: 'Black Counter Cafe review',
      url: 'https://example.com/black-counter-cafe-review',
    })
    expect(response.body.candidates[0]).toMatchObject({
      name: 'Black Counter Cafe',
      evidenceType: 'interior',
    })

    const rankingRequest = visionClient.chat.completions.create.mock.calls[1][0]
    const promptText = rankingRequest.messages[1].content[0].text
    expect(promptText).toContain('External web/review pages collected from search providers')
    expect(promptText).toContain('Black Counter Cafe review')
  })

  it('uses article-discovered candidates to drive Google Maps photo verification', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Matcha drink inside a compact cafe prep area.',
                      imageEvidence: ['iced matcha', 'brown bags on shelves'],
                      searchQueries: ['San Francisco new matcha cafe brown bags shelves'],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Article discovery found the venue and Maps photos verified it.',
                      imageEvidence: ['iced matcha', 'brown bags on shelves'],
                      candidates: [
                        {
                          id: '',
                          name: 'Kissaten Hifi',
                          category: 'Cafe',
                          neighborhood: 'Richmond',
                          address: '189 6th Ave',
                          confidence: 88,
                          evidenceType: 'mixed',
                          evidenceCategories: ['interior_match', 'web_source_match', 'dish_match'],
                          reasons: [
                            'Article search surfaced Kissaten Hifi as a recent SF matcha cafe.',
                            'Google Maps customer photos were provided for visual comparison.',
                          ],
                          sourceUrls: ['https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi'],
                          comparisonPhotos: [
                            {
                              title: 'Kissaten Hifi customer photo',
                              source: 'Google Maps reviews/photos',
                              url: 'https://maps.example/kissaten-photo',
                              matchReason: 'Same compact prep shelf context.',
                            },
                          ],
                        },
                      ],
                      needsMoreEvidence: false,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const articleSearch = {
      provider: 'mock-article-search',
      search: vi.fn(async () => ({
        candidates: [
          {
            name: 'Kissaten Hifi',
            category: 'Cafe',
            neighborhood: 'Richmond',
            address: '189 6th Ave',
            whyRelevant: 'Infatuation review says this is a recently opened matcha cafe.',
            openingContext: 'Reviewed March 2026',
            sourceUrls: ['https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi'],
          },
        ],
        pages: [
          {
            title: 'Kissaten Hifi review',
            source: 'theinfatuation.com',
            url: 'https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi',
            snippet: 'Recently opened matcha cafe.',
            query: 'article discovery',
            searchLabel: 'article-discovery',
          },
        ],
      })),
    }
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => [
        {
          title: 'Kissaten Hifi customer photo',
          source: 'Google Maps reviews/photos',
          pageUrl: 'https://maps.example/kissaten-photo',
          imageUrl: 'https://maps.example/kissaten-photo.jpg',
          thumbnailUrl: 'https://maps.example/kissaten-photo-thumb.jpg',
          query: 'Kissaten Hifi 189 6th Ave San Francisco Google Maps reviews photos interior',
          placeTitle: 'Kissaten Hifi',
          placeAddress: '189 6th Ave, San Francisco, CA',
        },
      ]),
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        articleSearch,
        photoSearch,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(articleSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Matcha drink inside a compact cafe prep area.',
      }),
    )
    expect(photoSearch.search.mock.calls[0][0][0]).toContain('Kissaten Hifi')
    expect(response.body.articleSearchProvider).toBe('mock-article-search')
    expect(response.body.articleCandidates[0]).toMatchObject({
      name: 'Kissaten Hifi',
      sourceUrls: ['https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi'],
    })
    expect(response.body.webEvidence[0]).toMatchObject({
      searchLabel: 'article-discovery',
      source: 'theinfatuation.com',
    })

    const rankingRequest = visionClient.chat.completions.create.mock.calls[1][0]
    const promptText = rankingRequest.messages[1].content[0].text
    expect(promptText).toContain('Article-discovered candidate venues')
    expect(promptText).toContain('Kissaten Hifi')
  })

  it('keeps raw visual search queries in the early photo-search batch when article candidates are noisy', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Matcha drink in a compact cafe with brown bags on shelves.',
                      imageEvidence: ['iced matcha', 'brown coffee bags', 'tan aprons'],
                      searchQueries: [
                        'San Francisco matcha cafe brown bags shelves',
                        'San Francisco cafe tan aprons stainless steel counter',
                      ],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Noisy article candidates were compared with raw photo clues.',
                      imageEvidence: ['iced matcha', 'brown coffee bags'],
                      candidates: [
                        {
                          id: '',
                          name: 'Cà Phê Việt',
                          category: 'Cafe',
                          neighborhood: 'Downtown',
                          address: '121 New Montgomery St',
                          confidence: 60,
                          evidenceCategories: ['web_source_match', 'dish_match'],
                          reasons: ['Article search surfaced a recent cafe candidate.'],
                          sourceUrls: ['https://example.com/ca-phe-viet'],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const articleSearch = {
      provider: 'mock-article-search',
      search: vi.fn(async () => ({
        candidates: [
          {
            name: 'Cà Phê Việt',
            category: 'Cafe',
            neighborhood: 'Downtown',
            address: '121 New Montgomery St',
            whyRelevant: 'Recent cafe article candidate.',
            sourceUrls: ['https://example.com/ca-phe-viet'],
          },
          {
            name: 'Elaichi Co.',
            category: 'Cafe',
            neighborhood: 'SoMa',
            address: '360 3rd St',
            whyRelevant: 'Recent chai cafe article candidate.',
            sourceUrls: ['https://example.com/elaichi'],
          },
        ],
        pages: [],
      })),
    }
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => []),
    }

    await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        articleSearch,
        photoSearch,
        webSearch: null,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    const photoQueries = photoSearch.search.mock.calls[0][0]
    expect(photoQueries.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cà Phê Việt'),
        expect.stringContaining('Elaichi Co.'),
        'San Francisco matcha cafe brown bags shelves',
        'San Francisco cafe tan aprons stainless steel counter',
      ]),
    )
    expect(photoQueries[0]).toBe('Cà Phê Việt San Francisco Google Maps reviews photos interior')
    expect(photoQueries[1]).toBe('Elaichi Co. San Francisco Google Maps reviews photos interior')
  })

  it('runs article discovery and base web search in parallel before candidate photo search', async () => {
    const events = []
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Matcha drink in a cafe interior.',
                      imageEvidence: ['matcha drink', 'retail bags'],
                      searchQueries: ['San Francisco recent matcha cafe retail bags'],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Parallel search completed.',
                      imageEvidence: ['matcha drink', 'retail bags'],
                      candidates: [
                        {
                          id: '',
                          name: 'Parallel Cafe',
                          category: 'Cafe',
                          neighborhood: 'Richmond',
                          address: '100 Example St',
                          confidence: 72,
                          evidenceType: 'mixed',
                          evidenceCategories: ['web_source_match', 'dish_match'],
                          reasons: ['Search providers returned candidate evidence.'],
                          sourceUrls: ['https://example.com/parallel-cafe'],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const articleSearch = {
      provider: 'slow-article-search',
      search: vi.fn(async () => {
        events.push('article-start')
        await new Promise((resolve) => setTimeout(resolve, 10))
        events.push('article-end')
        return {
          candidates: [
            {
              name: 'Parallel Cafe',
              neighborhood: 'Richmond',
              whyRelevant: 'Recently opened cafe from article discovery.',
              sourceUrls: ['https://example.com/parallel-cafe'],
            },
          ],
          pages: [],
        }
      }),
    }
    const webSearch = {
      provider: 'mock-web-search',
      search: vi.fn(async (queries) => {
        events.push(queries.some((query) => query.includes('Parallel Cafe')) ? 'candidate-web' : 'base-web')
        return []
      }),
    }
    const photoSearch = {
      provider: 'mock-photo-search',
      search: vi.fn(async () => {
        events.push('photo-search')
        return []
      }),
    }

    await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        articleSearch,
        webSearch,
        photoSearch,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(events.indexOf('base-web')).toBeGreaterThan(events.indexOf('article-start'))
    expect(events.indexOf('base-web')).toBeLessThan(events.indexOf('article-end'))
    expect(events.indexOf('photo-search')).toBeGreaterThan(events.indexOf('article-end'))
    expect(events.indexOf('candidate-web')).toBeGreaterThan(events.indexOf('article-end'))
  })

  it('uses Exa deep search with highlights for web evidence', async () => {
    const exaClient = {
      search: vi.fn(async () => ({
        results: [
          {
            title: 'Cafe interior photos',
            url: 'https://example.com/cafe-interior',
            highlights: ['Black counter and pastry case.', 'Green tile wall near espresso bar.'],
          },
        ],
      })),
    }

    const pages = await searchExaWeb(['San Francisco cafe green tile interior'], exaClient)

    expect(exaClient.search).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('San Francisco cafe green tile interior'),
      {
        type: 'deep',
        numResults: 8,
        contents: {
          highlights: true,
        },
      },
    )
    expect(exaClient.search).toHaveBeenCalledWith(
      expect.stringContaining('Yelp photos'),
      expect.objectContaining({
        includeDomains: ['yelp.com'],
      }),
    )
    expect(exaClient.search).toHaveBeenCalledWith(
      expect.stringContaining('Instagram TikTok'),
      expect.objectContaining({
        includeDomains: ['instagram.com', 'tiktok.com'],
      }),
    )
    expect(pages[0]).toMatchObject({
      title: 'Cafe interior photos',
      source: 'example.com',
      url: 'https://example.com/cafe-interior',
      searchLabel: 'broad-web',
      snippet: expect.stringContaining('Green tile wall'),
    })
  })

  it('uses Ceramic web search as a low-cost broad evidence provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            results: [
              {
                title: 'Green Tile Cafe review',
                url: 'https://example.com/green-tile-cafe-review',
                description: 'A San Francisco cafe with green tile and pastry cases.',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const pages = await searchCeramicWeb(['San Francisco cafe green tile interior'], 'test-key')
    const [url, options] = fetchMock.mock.calls[0]

    expect(url).toBe('https://api.ceramic.ai/search')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer test-key')
    expect(JSON.parse(options.body).query).toContain('San Francisco cafe green tile interior')
    expect(pages[0]).toMatchObject({
      title: 'Green Tile Cafe review',
      source: 'example.com',
      url: 'https://example.com/green-tile-cafe-review',
      snippet: 'A San Francisco cafe with green tile and pastry cases.',
    })

    fetchMock.mockRestore()
  })

  it('uses Exa structured article discovery for recently opened cafe candidates', async () => {
    const exaClient = {
      search: vi.fn(async () => ({
        output: {
          content: {
            candidates: [
              {
                name: 'Kissaten Hifi',
                category: 'Cafe',
                neighborhood: 'Richmond',
                address: '189 6th Ave',
                whyRelevant: 'A recently opened matcha cafe from an article-style review.',
                openingContext: 'Reviewed March 2026',
              },
            ],
          },
          grounding: [
            {
              field: 'candidates[0].name',
              citations: [
                {
                  url: 'https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi',
                  title: 'Kissaten Hifi review',
                },
              ],
            },
          ],
        },
        results: [
          {
            title: 'Kissaten Hifi review',
            url: 'https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi',
            highlights: ['A recently opened matcha cafe in the Richmond.'],
          },
        ],
      })),
    }

    const result = await discoverArticleCandidates(
      {
        summary: 'Iced matcha in a cafe prep area.',
        imageEvidence: ['brown bags on shelves', 'tan aprons'],
      },
      exaClient,
    )

    expect(exaClient.search).toHaveBeenCalledWith(
      expect.stringContaining('recently opened new popular cafe'),
      expect.objectContaining({
        type: 'deep',
        numResults: 12,
        contents: { highlights: true },
        outputSchema: expect.any(Object),
      }),
    )
    expect(result.candidates[0]).toMatchObject({
      name: 'Kissaten Hifi',
      sourceUrls: ['https://www.theinfatuation.com/san-francisco/reviews/kissaten-hifi'],
    })
    expect(result.pages[0]).toMatchObject({
      searchLabel: 'article-discovery',
      source: 'theinfatuation.com',
    })
  })

  it('reranks strong venue evidence above dish-only guesses', () => {
    const candidates = rerankCandidates(
      [
        {
          id: 'dish-only',
          name: 'Dish Only Cafe',
          confidence: 93,
          evidenceCategories: ['dish_match'],
          reasons: ['The photo shows a similar matcha drink.'],
          sourceUrls: [],
        },
        {
          id: 'interior',
          name: 'Interior Match Cafe',
          confidence: 72,
          evidenceCategories: ['interior_match', 'web_source_match'],
          reasons: ['Public photos show the same green tile wall and counter.'],
          sourceUrls: ['https://example.com/interior-match'],
        },
      ],
      { seedVenueIds: ['interior'] },
    )

    expect(candidates[0]).toMatchObject({
      id: 'interior',
      evidenceCategories: ['interior_match', 'web_source_match'],
    })
    expect(candidates[1].rankingNotes).toContain(
      'Food/drink similarity alone is weak evidence, so this was ranked lower.',
    )
  })

  it('caps unverified web-discovered interior claims', () => {
    const candidates = rerankCandidates([
      {
        id: '',
        name: 'Generic Matcha Cafe',
        confidence: 90,
        evidenceCategories: ['interior_match', 'storefront_match', 'web_source_match', 'dish_match'],
        reasons: [
          'The cafe has a modern interior and matcha drinks.',
          'Search results show many matcha drinks at this venue.',
        ],
        sourceUrls: ['https://example.com/generic-matcha-cafe'],
      },
    ])

    expect(candidates[0].confidence).toBeLessThanOrEqual(68)
    expect(candidates[0].rankingNotes).toContain(
      'Interior/storefront similarity was not verified against external photos, so confidence is capped.',
    )
  })

  it('caps web-discovered photo matches without readable identity evidence', () => {
    const candidates = rerankCandidates(
      [
        {
          id: '',
          name: 'Generic Industrial Cafe',
          confidence: 100,
          evidenceCategories: ['interior_match', 'web_source_match', 'dish_match'],
          reasons: ['External photos show a similar stainless counter and brown bags.'],
          sourceUrls: ['https://example.com/generic-industrial-cafe'],
          comparisonPhotos: [
            {
              title: 'Generic Industrial Cafe customer photo',
              source: 'Google Maps reviews/photos',
              url: 'https://example.com/returned-photo.jpg',
            },
          ],
        },
      ],
      { photoEvidenceUrls: ['https://example.com/returned-photo.jpg'] },
    )

    expect(candidates[0].confidence).toBeLessThanOrEqual(72)
    expect(candidates[0].rankingNotes).toContain(
      'No readable venue name, GPS, or unique identity clue was verified, so this web-discovered guess is capped.',
    )
  })

  it('does not treat a blank or blurred label as readable venue text', () => {
    const candidates = rerankCandidates(
      [
        {
          id: '',
          name: 'Blank Label Cafe',
          confidence: 100,
          evidenceCategories: ['visible_text', 'interior_match', 'web_source_match', 'dish_match'],
          reasons: [
            'The image shows a green drink with a blank white label and similar stainless counter.',
          ],
          sourceUrls: ['https://example.com/blank-label-cafe'],
          comparisonPhotos: [
            {
              title: 'Blank Label Cafe customer photo',
              source: 'Google Maps reviews/photos',
              url: 'https://example.com/returned-photo.jpg',
            },
          ],
        },
      ],
      { photoEvidenceUrls: ['https://example.com/returned-photo.jpg'] },
    )

    expect(candidates[0].evidenceCategories).not.toContain('visible_text')
    expect(candidates[0].confidence).toBeLessThanOrEqual(72)
  })

  it('treats readable visible branding as identity evidence', () => {
    const candidates = rerankCandidates([
      {
        id: '',
        name: 'Souvla',
        confidence: 88,
        evidenceCategories: ['packaging_logo', 'dish_match'],
        reasons: ['The tray liner has visible branding that says Souvla.'],
        sourceUrls: ['https://www.souvla.com/'],
      },
    ])

    expect(candidates[0].evidenceCategories).toContain('visible_text')
    expect(candidates[0].confidence).toBeGreaterThan(58)
    expect(candidates[0].rankingNotes).toContain('Matched visible text from the photo.')
  })

  it('does not treat partial packaging text as exact venue identity', () => {
    const candidates = rerankCandidates([
      {
        id: 'bodega-sf',
        name: 'Bodega SF',
        confidence: 100,
        evidenceCategories: ['visible_text', 'packaging_logo', 'dish_match', 'web_source_match'],
        reasons: ["The image shows a cup with a visible 'BODEGA' logo."],
        sourceUrls: ['https://www.bodegasf.com/'],
      },
    ], { seedVenueIds: ['bodega-sf'] })

    expect(candidates[0].evidenceCategories).not.toContain('visible_text')
    expect(candidates[0].confidence).toBeLessThanOrEqual(72)
  })

  it('does not keep duplicate candidate names after reranking', () => {
    const candidates = rerankCandidates([
      {
        id: '',
        name: 'Souvla',
        confidence: 80,
        evidenceCategories: ['visible_text', 'packaging_logo'],
        reasons: ['The uploaded image contains readable visible text that says Souvla.'],
        sourceUrls: ['https://www.souvla.com/'],
      },
      {
        id: '',
        name: 'Souvla',
        confidence: 70,
        evidenceCategories: ['packaging_logo'],
        reasons: ['The tray liner has visible branding that says Souvla.'],
        sourceUrls: ['https://www.souvla.com/'],
      },
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0].name).toBe('Souvla')
  })

  it('does not trust invented non-seed ids as verified venues', () => {
    const candidates = rerankCandidates(
      [
        {
          id: 'invented-cafe-id',
          name: 'Invented Cafe',
          confidence: 92,
          evidenceCategories: ['interior_match', 'web_source_match', 'dish_match'],
          reasons: ['The cafe has a similar interior and matcha drink.'],
          sourceUrls: ['https://example.com/invented-cafe'],
        },
      ],
      { seedVenueIds: ['real-seed-id'] },
    )

    expect(candidates[0].id).toBe('')
    expect(candidates[0].confidence).toBeLessThanOrEqual(68)
  })

  it('does not trust model-invented comparison photos', () => {
    const candidates = rerankCandidates([
      {
        id: '',
        name: 'Invented Photo Cafe',
        confidence: 96,
        evidenceCategories: ['interior_match', 'web_source_match', 'dish_match'],
        reasons: ['The interior appears similar.'],
        sourceUrls: ['https://example.com/cafe'],
        comparisonPhotos: [
          {
            title: 'Invented interior',
            source: 'Yelp',
            url: 'https://example.com/not-returned-by-provider.jpg',
          },
        ],
      },
    ])

    expect(candidates[0].confidence).toBeLessThanOrEqual(68)
    expect(candidates[0].rankingNotes).toContain(
      'Interior/storefront similarity was not verified against external photos, so confidence is capped.',
    )
  })

  it('continues analysis when a web evidence provider fails', async () => {
    const visionClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Cafe counter with matcha.',
                      imageEvidence: ['matcha', 'counter'],
                      searchQueries: ['San Francisco matcha cafe counter'],
                      likelyVenueTypes: ['Cafe'],
                    }),
                  },
                },
              ],
            })
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'A cafe counter with a matcha drink.',
                      imageEvidence: ['matcha', 'counter'],
                      candidates: [
                        {
                          id: '',
                          name: 'Fallback Cafe',
                          category: 'Cafe',
                          neighborhood: 'San Francisco',
                          address: 'Address not confirmed',
                          confidence: 55,
                          evidenceCategories: ['dish_match'],
                          reasons: ['The drink visually resembles a matcha latte.'],
                          sourceUrls: [],
                        },
                      ],
                      needsMoreEvidence: true,
                    }),
                  },
                },
              ],
            }),
        },
      },
    }
    const webSearch = {
      provider: 'failing-exa',
      search: vi.fn(async () => {
        throw new Error('Exa unavailable')
      }),
    }

    const response = await request(
      createApp({
        visionClient,
        visionModel: 'openai/gpt-4o-mini',
        visionProvider: 'openrouter',
        photoSearch: null,
        webSearch,
      }),
    )
      .post('/api/analyze-photo')
      .attach('photo', pngPixel, { filename: 'food.png', contentType: 'image/png' })
      .field('venues', '[]')
      .expect(200)

    expect(response.body.candidates[0]).toMatchObject({
      name: 'Fallback Cafe',
      evidenceCategories: ['dish_match'],
    })
    expect(response.body.providerWarnings[0]).toMatchObject({
      provider: 'failing-exa',
      message: 'Exa unavailable',
    })
  })
})
