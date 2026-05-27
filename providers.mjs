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

  const photoSearch = createPhotoSearchProvider({
    hasDataApiKey: env.HASDATA_API_KEY,
    serpApiKey: env.SERPAPI_API_KEY,
    searchFns,
  })
  const webSearch = createWebSearchProvider({
    ceramicApiKey: env.CERAMIC_API_KEY,
    exaClient,
    searchFns,
  })
  const articleSearch = createArticleSearchProvider({ exaClient, searchFns })

  return {
    visionProvider,
    visionModel,
    visionFallbackModels,
    visionClient,
    exaClient,
    photoSearch,
    webSearch,
    articleSearch,
  }
}

function createPhotoSearchProvider({ hasDataApiKey, serpApiKey, searchFns }) {
  if (hasDataApiKey && searchFns.searchHasDataPhotos) {
    return {
      provider: 'hasdata-google-maps-photos',
      search: (queries) => searchFns.searchHasDataPhotos(queries, hasDataApiKey),
    }
  }

  if (serpApiKey && searchFns.searchSerpApiPhotos) {
    return {
      provider: 'serpapi-google-maps-photos',
      search: (queries) => searchFns.searchSerpApiPhotos(queries, serpApiKey),
    }
  }

  return null
}

function createWebSearchProvider({ ceramicApiKey, exaClient, searchFns }) {
  if (ceramicApiKey && searchFns.searchCeramicWeb) {
    return {
      provider: 'ceramic-web-search',
      search: (queries) => searchFns.searchCeramicWeb(queries, ceramicApiKey),
    }
  }

  if (exaClient && searchFns.searchExaWeb) {
    return {
      provider: 'exa-deep-highlights',
      search: (queries) => searchFns.searchExaWeb(queries, exaClient),
    }
  }

  return null
}

function createArticleSearchProvider({ exaClient, searchFns }) {
  if (!exaClient || !searchFns.discoverArticleCandidates) return null

  return {
    provider: 'exa-article-discovery',
    search: (searchPlan) => searchFns.discoverArticleCandidates(searchPlan, exaClient),
  }
}
