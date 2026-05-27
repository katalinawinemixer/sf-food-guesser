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
    photoSearchEnabled: false,
    photoSearchProvider: null,
    webSearchEnabled: provider?.provider === 'openrouter',
    webSearchProvider: provider?.provider === 'openrouter' ? 'openrouter-web-search' : null,
    articleSearchEnabled: false,
    articleSearchProvider: null,
  })
}

export function onRequest() {
  return methodNotAllowed()
}
