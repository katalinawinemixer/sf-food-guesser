import {
  buildCloudflarePrompt,
  buildCloudflarePhotoEvidenceParts,
  buildSearchPlanPrompt,
  disallowedOriginResponse,
  fileToDataUrl,
  jsonResponse,
  methodNotAllowed,
  normalizeAnalysis,
  normalizeSearchPlan,
  optionsResponse,
  parseModelJson,
  providerErrorMessage,
  providerFromEnv,
  searchExaEvidence,
  searchHasDataPhotoEvidence,
  validateImageBytes,
  validateImageFile,
} from './_shared.js'

export function onRequestOptions() {
  return optionsResponse()
}

function seedPhotoSearchQueries(venues = [], searchPlan = null) {
  const haystack = [
    searchPlan?.summary,
    ...(Array.isArray(searchPlan?.imageEvidence) ? searchPlan.imageEvidence : []),
    ...(Array.isArray(searchPlan?.searchQueries) ? searchPlan.searchQueries : []),
  ]
    .join(' ')
    .toLowerCase()

  return venues
    .map((venue, originalIndex) => {
      const hints = Array.isArray(venue.imageEvidenceHints) ? venue.imageEvidenceHints : []
      const matchedHintCount = hints.filter((hint) => {
        const normalizedHint = String(hint).toLowerCase().trim()
        return normalizedHint.length >= 4 && haystack.includes(normalizedHint)
      }).length
      const name = String(venue.name ?? '').trim()
      const nameHit = name && haystack.includes(name.toLowerCase())
      return {
        venue,
        originalIndex,
        score: matchedHintCount + (nameHit ? 4 : 0),
      }
    })
    .filter(({ venue, score }) => score >= 1 && venue.name)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .slice(0, 4)
    .map(({ venue }) =>
      [venue.name, venue.address, venue.neighborhood, 'San Francisco Google Maps reviews photos interior']
        .filter(Boolean)
        .join(' '),
    )
}

export async function onRequestPost({ request, env }) {
  const provider = providerFromEnv(env)
  const runId = crypto.randomUUID()

  const originResponse = disallowedOriginResponse(request, env)
  if (originResponse) return originResponse

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

  const imageBytesError = await validateImageBytes(file)
  if (imageBytesError) {
    return jsonResponse({ runId, error: imageBytesError }, 415)
  }

  let venues = []
  try {
    venues = JSON.parse(String(formData.get('venues') ?? '[]'))
  } catch {
    return jsonResponse({ runId, error: 'Venue payload was not valid JSON.' }, 400)
  }

  const dataUrl = await fileToDataUrl(file)
  const models = [provider.model, ...provider.fallbackModels].filter(Boolean)
  const providerWarnings = []
  let searchPlan = null
  let webEvidence = []
  let photoEvidence = []
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
                'You inspect San Francisco food venue photos and create concise web-search plans. Return strict JSON only.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: buildSearchPlanPrompt(venues) },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 1200,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(result?.error?.message || result?.message || response.statusText)
        error.status = response.status
        throw error
      }
      searchPlan = normalizeSearchPlan(parseModelJson(result?.choices?.[0]?.message?.content ?? ''))
      break
    } catch (error) {
      providerWarnings.push({
        provider: `search-plan:${model}`,
        message: String(error?.message ?? 'Search planning failed.'),
      })
      lastError = error
      if (Number(error?.status) !== 429) break
    }
  }

  if (searchPlan) {
    const [exaResult, photoResult] = await Promise.allSettled([
      searchExaEvidence(searchPlan, env),
      searchHasDataPhotoEvidence(
        {
          ...searchPlan,
          searchQueries: [
            ...seedPhotoSearchQueries(venues, searchPlan),
            ...(Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []),
          ],
        },
        env,
      ),
    ])
    if (exaResult.status === 'fulfilled') {
      webEvidence = exaResult.value
    } else {
      providerWarnings.push({
        provider: 'exa-deep-highlights',
        message: String(exaResult.reason?.message ?? 'Exa evidence search failed.'),
      })
    }
    if (photoResult.status === 'fulfilled') {
      photoEvidence = photoResult.value
    } else {
      providerWarnings.push({
        provider: 'hasdata-google-maps-photos',
        message: String(photoResult.reason?.message ?? 'HasData photo evidence search failed.'),
      })
    }
  }

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
                { type: 'text', text: buildCloudflarePrompt(venues, webEvidence, searchPlan, photoEvidence) },
                ...buildCloudflarePhotoEvidenceParts(photoEvidence),
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
      const analysis = normalizeAnalysis(parseModelJson(outputText), {
        seedVenueIds: venues.map((venue) => venue.id).filter(Boolean),
        seedVenues: venues,
        searchPlan,
        webEvidence,
      })
      return jsonResponse({
        runId,
        ...analysis,
        searchProvider: env.HASDATA_API_KEY ? 'hasdata-google-maps-photos' : null,
        webSearchProvider: provider.provider === 'openrouter' ? 'openrouter-web-search' : null,
        articleSearchProvider: env.EXA_API_KEY ? 'exa-deep-highlights' : null,
        articleCandidates: [],
        photoEvidence,
        webEvidence,
        searchPlan,
        providerWarnings,
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
