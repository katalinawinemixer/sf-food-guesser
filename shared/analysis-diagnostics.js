function warningList(value) {
  return Array.isArray(value) ? value : []
}

function providerArea(provider = '') {
  const text = String(provider).toLowerCase()
  if (text.includes('ocr')) return 'ocr'
  if (text.includes('search-plan')) return 'search_plan'
  if (text.includes('photo') || text.includes('maps') || text.includes('places') || text.includes('hasdata')) return 'photo_search'
  if (text.includes('exa') || text.includes('web') || text.includes('ceramic')) return 'web_search'
  if (text.includes('vision')) return 'vision'
  return 'other'
}

export function buildProviderStatus(providerWarnings = []) {
  const warnings = warningList(providerWarnings)
  const failureAreas = [...new Set(warnings.map((warning) => providerArea(warning.provider)))]
  return {
    ok: warnings.length === 0,
    warningCount: warnings.length,
    failureAreas,
    warnings: warnings.slice(0, 8).map((warning) => ({
      provider: String(warning.provider ?? 'provider'),
      message: String(warning.message ?? 'Provider unavailable'),
      area: providerArea(warning.provider),
    })),
  }
}

export function buildCacheStatus({ localSearchCache = null, cloudflareSearchCache = null } = {}) {
  const cloudflareCache =
    cloudflareSearchCache && typeof cloudflareSearchCache === 'object'
      ? cloudflareSearchCache
      : { enabled: Boolean(cloudflareSearchCache), provider: 'cloudflare-kv' }
  const localCache =
    localSearchCache && typeof localSearchCache === 'object'
      ? localSearchCache
      : { enabled: false, provider: 'local-memory' }
  const enabled = Boolean(cloudflareCache.enabled || localCache.enabled)
  const provider = cloudflareSearchCache && typeof cloudflareSearchCache === 'object'
    ? cloudflareCache.provider ?? 'cloudflare-kv'
    : cloudflareCache.enabled
      ? cloudflareCache.provider ?? 'cloudflare-kv'
      : localCache.provider ?? 'local-memory'
  const status = {
    enabled,
    provider,
  }
  for (const key of ['hits', 'misses', 'writes', 'entries']) {
    const value = cloudflareCache.enabled ? cloudflareCache[key] : localCache[key]
    if (Number.isFinite(Number(value))) status[key] = Number(value)
  }
  return {
    hits: 0,
    misses: 0,
    entries: 0,
    ...status,
  }
}
