import {
  buildCloudflarePrompt,
  buildCloudflarePhotoEvidenceParts,
  buildOcrPrompt,
  buildSearchPlanPrompt,
  disallowedOriginResponse,
  enforceCloudflareRateLimit,
  fileToDataUrl,
  jsonResponse,
  mergeOcrIntoSearchPlan,
  methodNotAllowed,
  normalizeAnalysis,
  normalizeOcrResult,
  normalizeSearchPlan,
  optionsResponse,
  parseModelJson,
  providerErrorMessage,
  providerFromEnv,
  searchExaEvidence,
  searchGooglePlacesPhotoEvidence,
  searchHasDataPhotoEvidence,
  validateImageBytes,
  validateImageFile,
} from './_shared.js'

const providerFetchTimeoutMs = 18_000
const requestDeadlineMs = 82_000
const providerNativeImageTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

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
      const hints = [
        ...(Array.isArray(venue.imageEvidenceHints) ? venue.imageEvidenceHints : []),
        ...(Array.isArray(venue.visualClues) ? venue.visualClues : []),
        ...(Array.isArray(venue.menuClues) ? venue.menuClues : []),
      ]
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

function shouldTryNextProviderAttempt(error) {
  const status = Number(error?.status ?? 0)
  return status !== 401 && status !== 402
}

function remainingProviderTimeout(deadline) {
  return Math.max(1, Math.min(providerFetchTimeoutMs, deadline - Date.now()))
}

function createTimeoutFetch(fetchImpl, timeoutMs, label) {
  return async (url, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(url, {
        ...init,
        signal: init.signal ?? controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(`${label} timed out.`)
        timeoutError.status = 504
        throw timeoutError
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function searchPlanHasImageContent(searchPlan) {
  const summary = String(searchPlan?.summary ?? '')
  const evidenceCount =
    (Array.isArray(searchPlan?.imageEvidence) ? searchPlan.imageEvidence.length : 0) +
    (Array.isArray(searchPlan?.visibleText) ? searchPlan.visibleText.length : 0)
  return evidenceCount > 0 || !/no image content|image content is unavailable|unable to inspect/i.test(summary)
}

async function fetchJsonWithTimeout(url, init, timeoutMs, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    const result = await response.json().catch(() => ({}))
    return { response, result }
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${label} timed out.`)
      timeoutError.status = 504
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function onRequestPost({ request, env }) {
  const provider = providerFromEnv(env)
  const runId = crypto.randomUUID()
  const deadline = Date.now() + requestDeadlineMs

  const originResponse = disallowedOriginResponse(request, env)
  if (originResponse) return originResponse

  const rateLimitResponse = await enforceCloudflareRateLimit({
    request,
    env,
    scope: 'analyze-photo',
    limit: Number(env.SF_FOOD_ANALYZE_RATE_LIMIT || 10),
    windowSeconds: Number(env.SF_FOOD_ANALYZE_RATE_WINDOW_SECONDS || 3600),
  })
  if (rateLimitResponse) return rateLimitResponse

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

  const fileType = String(file.type || '').toLowerCase()
  if (!providerNativeImageTypes.has(fileType)) {
    return jsonResponse(
      {
        runId,
        error:
          'This image type could not be converted for AI vision. Export it as JPG, PNG, or WebP and upload it again.',
      },
      415,
    )
  }

  const ocrFile = formData.get('ocrPhoto')
  let ocrDataUrl = null
  if (ocrFile && typeof ocrFile === 'object' && typeof ocrFile.arrayBuffer === 'function' && typeof ocrFile.slice === 'function') {
    const ocrValidationError = validateImageFile(ocrFile)
    if (!ocrValidationError) {
      const ocrImageBytesError = await validateImageBytes(ocrFile)
      if (!ocrImageBytesError) ocrDataUrl = await fileToDataUrl(ocrFile)
    }
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
  let ocrResult = null
  let webEvidence = []
  let photoEvidence = []
  const evidenceFetch = createTimeoutFetch(
    fetch,
    Number(env.SF_FOOD_EVIDENCE_FETCH_TIMEOUT_MS || 10_000),
    'External evidence search',
  )
  const shouldDebugPhotoEvidence = env.DEBUG_PHOTO_EVIDENCE === 'true'
  const shouldDebugRanking = env.DEBUG_RANKING === 'true'
  let photoEvidenceDebug = null
  let lastError = null

  if (ocrDataUrl) {
    for (const model of models) {
      try {
        const { response, result } = await fetchJsonWithTimeout(provider.endpoint, {
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
                content: 'You are a careful OCR reader. Return strict JSON only.',
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: buildOcrPrompt() },
                  { type: 'image_url', image_url: { url: ocrDataUrl, detail: 'high' } },
                ],
              },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 800,
          }),
        }, remainingProviderTimeout(deadline), `OCR text reading with ${model}`)
        if (!response.ok) {
          const error = new Error(result?.error?.message || result?.message || response.statusText)
          error.status = response.status
          throw error
        }
        ocrResult = normalizeOcrResult(parseModelJson(result?.choices?.[0]?.message?.content ?? ''))
        break
      } catch (error) {
        providerWarnings.push({
          provider: `ocr:${model}`,
          message: String(error?.message ?? 'OCR text reading failed.'),
        })
        lastError = error
        if (!shouldTryNextProviderAttempt(error)) break
      }
      if (Date.now() >= deadline) break
    }
  }

  for (const model of models) {
    try {
      const { response, result } = await fetchJsonWithTimeout(provider.endpoint, {
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
      }, remainingProviderTimeout(deadline), `Search planning with ${model}`)
      if (!response.ok) {
        const error = new Error(result?.error?.message || result?.message || response.statusText)
        error.status = response.status
        throw error
      }
      searchPlan = mergeOcrIntoSearchPlan(
        normalizeSearchPlan(parseModelJson(result?.choices?.[0]?.message?.content ?? '')),
        ocrResult,
      )
      break
    } catch (error) {
      providerWarnings.push({
        provider: `search-plan:${model}`,
        message: String(error?.message ?? 'Search planning failed.'),
      })
      lastError = error
      if (!shouldTryNextProviderAttempt(error)) break
    }
    if (Date.now() >= deadline) break
  }

  if (searchPlan && searchPlanHasImageContent(searchPlan)) {
    const seededPhotoQueries = seedPhotoSearchQueries(venues, searchPlan)
    const photoSearchPlan = {
      ...searchPlan,
      searchQueries: [
        ...seededPhotoQueries,
        ...(Array.isArray(searchPlan.searchQueries) ? searchPlan.searchQueries : []),
      ],
    }
    const hasDataDebug = shouldDebugPhotoEvidence
      ? {
          searches: [],
          placeCount: 0,
          inlinePhotoCount: 0,
          endpointPhotoCount: 0,
          photoEndpointStatuses: [],
        }
      : null
    const photoEvidenceSearch = env.GOOGLE_PLACES_API_KEY
      ? searchGooglePlacesPhotoEvidence(photoSearchPlan, env, evidenceFetch)
      : searchHasDataPhotoEvidence(photoSearchPlan, env, evidenceFetch, hasDataDebug)
    const photoProviderName = env.GOOGLE_PLACES_API_KEY
      ? 'google-places-new-photos'
      : 'hasdata-google-maps-photos'
    const [exaResult, photoResult] = await Promise.allSettled([
      searchExaEvidence(searchPlan, env, evidenceFetch),
      photoEvidenceSearch,
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
        provider: photoProviderName,
        message: String(photoResult.reason?.message ?? `${photoProviderName} evidence search failed.`),
      })
    }
    if (shouldDebugPhotoEvidence) {
      photoEvidenceDebug = {
        seededQueryCount: seededPhotoQueries.length,
        totalQueryCount: photoSearchPlan.searchQueries.length,
        resultCount: photoEvidence.length,
        firstSeededQuery: seededPhotoQueries[0] ?? null,
        hasData: hasDataDebug,
      }
    }
  } else if (searchPlan) {
    providerWarnings.push({
      provider: 'search-plan',
      message: 'The vision model did not return usable image details, so external venue search was skipped.',
    })
  }

  const analysisAttempts = [
    {
      label: 'vision-analysis',
      includeExternalPhotoImages: true,
      includeOpenRouterWebSearch: true,
    },
    {
      label: 'vision-analysis-fallback',
      includeExternalPhotoImages: false,
      includeOpenRouterWebSearch: false,
    },
  ]
  for (const model of models) {
    for (const attempt of analysisAttempts) {
      try {
        const { response, result } = await fetchJsonWithTimeout(provider.endpoint, {
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
                  {
                    type: 'text',
                    text: buildCloudflarePrompt(venues, webEvidence, searchPlan, photoEvidence),
                  },
                  ...(attempt.includeExternalPhotoImages
                    ? buildCloudflarePhotoEvidenceParts(photoEvidence)
                    : []),
                  { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                ],
              },
            ],
            response_format: { type: 'json_object' },
            ...(provider.provider === 'openrouter' && attempt.includeOpenRouterWebSearch
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
        }, remainingProviderTimeout(deadline), `${attempt.label} with ${model}`)
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
          ocr: ocrResult,
          webEvidence,
          debugRanking: shouldDebugRanking,
        })
        return jsonResponse({
          runId,
          ...analysis,
          searchProvider: env.GOOGLE_PLACES_API_KEY
            ? 'google-places-new-photos'
            : env.HASDATA_API_KEY
              ? 'hasdata-google-maps-photos'
              : null,
          webSearchProvider:
            provider.provider === 'openrouter' && attempt.includeOpenRouterWebSearch
              ? 'openrouter-web-search'
              : null,
          articleSearchProvider: env.EXA_API_KEY ? 'exa-deep-highlights' : null,
          articleCandidates: [],
          photoEvidence,
          ...(photoEvidenceDebug ? { photoEvidenceDebug } : {}),
          webEvidence,
          searchPlan,
          ocr: ocrResult,
          providerWarnings,
        })
      } catch (error) {
        providerWarnings.push({
          provider: `${attempt.label}:${model}`,
          message: String(error?.message ?? 'Vision analysis failed.'),
        })
        lastError = error
        if (!shouldTryNextProviderAttempt(error)) break
      }
      if (Date.now() >= deadline) break
    }
    if (!shouldTryNextProviderAttempt(lastError)) break
    if (Date.now() >= deadline) break
  }

  return jsonResponse(
    {
      runId,
      error: providerErrorMessage(lastError, provider.provider),
      providerWarnings,
    },
    Number(lastError?.status) || 500,
  )
}

export function onRequest() {
  return methodNotAllowed()
}
