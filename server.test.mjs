import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp, rerankCandidates, searchExaWeb } from './server.mjs'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

describe('SF Food Guesser API', () => {
  it('reports when vision is disabled', async () => {
    const response = await request(
      createApp({
        openAIClient: null,
        visionModel: 'test-model',
        visionProvider: null,
        webSearch: null,
      }),
    )
      .get('/api/health')
      .expect(200)

    expect(response.body).toEqual({
      ok: true,
      visionEnabled: false,
      model: 'test-model',
      provider: null,
      photoSearchEnabled: false,
      photoSearchProvider: null,
      webSearchEnabled: false,
      webSearchProvider: null,
    })
  })

  it('rejects photo analysis without a vision client', async () => {
    const response = await request(createApp({ openAIClient: null }))
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

    const response = await request(createApp({ openAIClient }))
      .post('/api/analyze-photo')
      .field('venues', '[]')
      .expect(400)

    expect(response.body.error).toMatch(/No photo/)
    expect(openAIClient.responses.create).not.toHaveBeenCalled()
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
        visionProvider: 'openrouter',
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
    expect(promptText).toContain('Return 5-8 candidates')
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

  it('reranks strong venue evidence above dish-only guesses', () => {
    const candidates = rerankCandidates([
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
    ])

    expect(candidates[0]).toMatchObject({
      id: 'interior',
      evidenceCategories: ['interior_match', 'web_source_match'],
    })
    expect(candidates[1].rankingNotes).toContain(
      'Food/drink similarity alone is weak evidence, so this was ranked lower.',
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
