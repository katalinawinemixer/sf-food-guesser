import OpenAI from 'openai'
import Exa from 'exa-js'

export function parseFallbackModels(value = '') {
  return String(value)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

export function createVisionClient({ env = process.env, visionProvider }) {
  if (visionProvider === 'openrouter') {
    return new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_SITE_URL ?? 'http://127.0.0.1:5173',
        'X-OpenRouter-Title': 'SF Food Guesser',
      },
    })
  }

  if (visionProvider === 'openai') {
    return new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }

  return null
}

export function createProviderConfig({
  env = process.env,
  searchFns = {},
  createVisionClient: shouldCreateVisionClient = true,
} = {}) {
  const visionProvider = env.OPENROUTER_API_KEY
    ? 'openrouter'
    : env.OPENAI_API_KEY
      ? 'openai'
      : null
  const visionModel =
    env.OPENROUTER_VISION_MODEL ??
    env.OPENAI_VISION_MODEL ??
    (visionProvider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4.1-mini')
  const visionFallbackModels =
    visionProvider === 'openrouter' ? parseFallbackModels(env.OPENROUTER_FALLBACK_MODELS) : []
  const visionClient = shouldCreateVisionClient
    ? createVisionClient({ env, visionProvider })
    : null
  const exaClient = env.EXA_API_KEY ? new Exa(env.EXA_API_KEY) : null
  const cacheStore = new Map()
  const cacheStats = { hits: 0, misses: 0 }
  const cacheTtlMs = Number(env.SF_FOOD_SEARCH_CACHE_TTL_MS || 1000 * 60 * 30)

  const photoSearch = createPhotoSearchProvider({
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
    hasDataApiKey: env.HASDATA_API_KEY,
    serpApiKey: env.SERPAPI_API_KEY,
    searchFns,
    cacheStore,
    cacheStats,
    cacheTtlMs,
  })
  const webSearch = createWebSearchProvider({
    ceramicApiKey: env.CERAMIC_API_KEY,
    exaClient,
    searchFns,
    cacheStore,
    cacheStats,
    cacheTtlMs,
  })
  const articleSearch = createArticleSearchProvider({
    exaClient,
    searchFns,
    cacheStore,
    cacheStats,
    cacheTtlMs,
  })

  return {
    visionProvider,
    visionModel,
    visionFallbackModels,
    visionClient,
    exaClient,
    photoSearch,
    webSearch,
    articleSearch,
    searchCache: {
      enabled: cacheTtlMs > 0,
      provider: 'local-memory',
      stats: () => ({
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        entries: cacheStore.size,
      }),
    },
  }
}

function cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, search) {
  return async (input) => {
    const cacheKey = `${provider}:${JSON.stringify(input)}`
    const cached = cacheStore.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      cacheStats.hits += 1
      return cached.value
    }
    cacheStats.misses += 1
    const value = await search(input)
    if (cacheTtlMs > 0) {
      cacheStore.set(cacheKey, { value, expiresAt: Date.now() + cacheTtlMs })
    }
    return value
  }
}

function createPhotoSearchProvider({
  googlePlacesApiKey,
  hasDataApiKey,
  serpApiKey,
  searchFns,
  cacheStore,
  cacheTtlMs,
  cacheStats,
}) {
  if (googlePlacesApiKey && searchFns.searchGooglePlacesPhotos) {
    const provider = 'google-places-new-photos'
    return {
      provider,
      search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (queries) =>
        searchFns.searchGooglePlacesPhotos(queries, googlePlacesApiKey),
      ),
    }
  }

  if (hasDataApiKey && searchFns.searchHasDataPhotos) {
    const provider = 'hasdata-google-maps-photos'
    return {
      provider,
      search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (queries) =>
        searchFns.searchHasDataPhotos(queries, hasDataApiKey),
      ),
    }
  }

  if (serpApiKey && searchFns.searchSerpApiPhotos) {
    const provider = 'serpapi-google-maps-photos'
    return {
      provider,
      search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (queries) =>
        searchFns.searchSerpApiPhotos(queries, serpApiKey),
      ),
    }
  }

  return null
}

function createWebSearchProvider({ ceramicApiKey, exaClient, searchFns, cacheStore, cacheTtlMs, cacheStats }) {
  if (ceramicApiKey && searchFns.searchCeramicWeb) {
    const provider = 'ceramic-web-search'
    return {
      provider,
      search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (queries) =>
        searchFns.searchCeramicWeb(queries, ceramicApiKey),
      ),
    }
  }

  if (exaClient && searchFns.searchExaWeb) {
    const provider = 'exa-deep-highlights'
    return {
      provider,
      search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (queries) =>
        searchFns.searchExaWeb(queries, exaClient),
      ),
    }
  }

  return null
}

function createArticleSearchProvider({ exaClient, searchFns, cacheStore, cacheTtlMs, cacheStats }) {
  if (!exaClient || !searchFns.discoverArticleCandidates) return null

  const provider = 'exa-article-discovery'
  return {
    provider,
    search: cachedSearch(cacheStore, provider, cacheTtlMs, cacheStats, (searchPlan) =>
      searchFns.discoverArticleCandidates(searchPlan, exaClient),
    ),
  }
}
