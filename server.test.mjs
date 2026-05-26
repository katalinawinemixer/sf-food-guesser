import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp, rerankCandidates, searchExaWeb, searchSerpApiPhotos } from './server.mjs'

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
      (part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png'),
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
