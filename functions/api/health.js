import { jsonResponse, methodNotAllowed, optionsResponse, providerFromEnv } from './_shared.js'

export function onRequestOptions() {
  return optionsResponse()
}

export function onRequestGet({ env }) {
  const provider = providerFromEnv(env)

  return jsonResponse({
    ok: true,
    runtime: 'cloudflare-pages-functions',
    visionEnabled: Boolean(provider),
    model: provider?.model ?? null,
    fallbackModels: provider?.fallbackModels ?? [],
    provider: provider?.provider ?? null,
    photoSearchEnabled: Boolean(env.GOOGLE_PLACES_API_KEY || env.HASDATA_API_KEY),
    photoSearchProvider: env.GOOGLE_PLACES_API_KEY
      ? 'google-places-new-photos'
      : env.HASDATA_API_KEY
        ? 'hasdata-google-maps-photos'
        : null,
    webSearchEnabled: provider?.provider === 'openrouter',
    webSearchProvider: provider?.provider === 'openrouter' ? 'openrouter-web-search' : null,
    articleSearchEnabled: Boolean(env.EXA_API_KEY),
    articleSearchProvider: env.EXA_API_KEY ? 'exa-deep-highlights' : null,
  })
}

export function onRequest() {
  return methodNotAllowed()
}
