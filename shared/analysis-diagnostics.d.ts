export function buildProviderStatus(providerWarnings?: Array<{
  provider?: string
  message?: string
}>): {
  ok: boolean
  warningCount: number
  failureAreas: string[]
  warnings: Array<{ provider: string; message: string; area: string }>
}

export function buildCacheStatus(options?: {
  localSearchCache?: {
    enabled?: boolean
    provider?: string
    hits?: number
    misses?: number
    writes?: number
    entries?: number
  } | null
  cloudflareSearchCache?: boolean | {
    enabled?: boolean
    provider?: string
    hits?: number
    misses?: number
    writes?: number
    entries?: number
  }
}): {
  enabled: boolean
  provider: string
  hits: number
  misses: number
  writes?: number
  entries: number
}
