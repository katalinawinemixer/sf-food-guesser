import {
  buildCloudflarePrompt,
  fileToDataUrl,
  jsonResponse,
  methodNotAllowed,
  normalizeAnalysis,
  optionsResponse,
  parseModelJson,
  providerErrorMessage,
  providerFromEnv,
  validateImageFile,
} from './_shared.js'

export function onRequestOptions() {
  return optionsResponse()
}

export async function onRequestPost({ request, env }) {
  const provider = providerFromEnv(env)
  const runId = crypto.randomUUID()

  if (!provider) {
    return jsonResponse(
      {
        runId,
        error:
          'Photo analysis needs OPENROUTER_API_KEY or OPENAI_API_KEY in Cloudflare Pages environment variables.',
      },
      503,
    )
  }

  let formData
  try {
    formData = await request.formData()
  } catch {
    return jsonResponse({ runId, error: 'Photo upload form data was invalid.' }, 400)
  }

  const file = formData.get('photo')
  const validationError = validateImageFile(file)
  if (validationError) {
    const status = validationError.includes('too large')
      ? 413
      : validationError.includes('Unsupported')
        ? 415
        : 400
    return jsonResponse({ runId, error: validationError }, status)
  }

  let venues = []
  try {
    venues = JSON.parse(String(formData.get('venues') ?? '[]'))
  } catch {
    return jsonResponse({ runId, error: 'Venue payload was not valid JSON.' }, 400)
  }

  const dataUrl = await fileToDataUrl(file)
  const models = [provider.model, ...provider.fallbackModels].filter(Boolean)
  let lastError = null

  for (const model of models) {
    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...(provider.provider === 'openrouter'
            ? {
                'HTTP-Referer': env.OPENROUTER_SITE_URL || request.headers.get('origin') || '',
                'X-OpenRouter-Title': 'SF Food Guesser',
              }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You identify likely San Francisco restaurants, cafes, bakeries, counters, bars, and dessert shops from uploaded photos. Be honest about uncertainty and return strict JSON only.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: buildCloudflarePrompt(venues) },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          ...(provider.provider === 'openrouter'
            ? {
                tools: [
                  {
                    type: 'openrouter:web_search',
                    parameters: {
                      engine: 'auto',
                      max_results: 8,
                      max_total_results: 24,
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
        }),
      })

      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(result?.error?.message || result?.message || response.statusText)
        error.status = response.status
        throw error
      }

      const outputText = result?.choices?.[0]?.message?.content ?? ''
      const analysis = normalizeAnalysis(parseModelJson(outputText))
      return jsonResponse({
        runId,
        ...analysis,
        searchProvider: null,
        webSearchProvider: provider.provider === 'openrouter' ? 'openrouter-web-search' : null,
        articleSearchProvider: null,
        articleCandidates: [],
        photoEvidence: [],
        webEvidence: [],
        providerWarnings: [],
      })
    } catch (error) {
      lastError = error
      if (Number(error?.status) !== 429) break
    }
  }

  return jsonResponse(
    {
      runId,
      error: providerErrorMessage(lastError, provider.provider),
    },
    Number(lastError?.status) || 500,
  )
}

export function onRequest() {
  return methodNotAllowed()
}
