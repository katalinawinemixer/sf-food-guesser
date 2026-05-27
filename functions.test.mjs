import { describe, expect, it, vi } from 'vitest'
import { onRequestGet as healthGet } from './functions/api/health.js'
import { onRequestPost as analyzePhotoPost } from './functions/api/analyze-photo.js'
import { onRequestPost as feedbackPost } from './functions/api/feedback.js'

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

async function json(response) {
  return response.json()
}

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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
      },
    })
    const body = await json(response)
    const [, requestInit] = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(requestInit.body))

    expect(response.status).toBe(200)
    expect(payload.tools[0].type).toBe('openrouter:web_search')
    expect(body).toMatchObject({
      summary: 'Iced matcha in a small cafe prep area.',
      candidates: [
        {
          name: 'Kissaten Hifi',
          confidence: 77,
        },
      ],
      webSearchProvider: 'openrouter-web-search',
    })

    fetchMock.mockRestore()
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
