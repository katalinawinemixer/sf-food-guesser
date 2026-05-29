import { buildCacheStatus, buildProviderStatus } from '../../../shared/analysis-diagnostics.js'
import { goldenAnalysisFixtures } from '../../../shared/golden-fixtures.js'
import { jsonResponse, methodNotAllowed, normalizeAnalysis, optionsResponse } from '../_shared.js'

export function onRequestOptions() {
  return optionsResponse()
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url)
  const fixtureId = url.searchParams.get('fixtureId') || goldenAnalysisFixtures[0]?.id || ''
  const fixture = goldenAnalysisFixtures.find((item) => item.id === fixtureId) ?? goldenAnalysisFixtures[0]
  if (!fixture) return jsonResponse({ error: 'No replay fixtures are available.' }, 404)

  const analysis = normalizeAnalysis(fixture.analysis, {
    seedVenueIds: fixture.options?.seedVenueIds,
    searchPlan: {
      visibleText: fixture.options?.ocrVisibleText ?? [],
    },
  })

  return jsonResponse({
    ok: true,
    fixtureId: fixture.id,
    label: fixture.label,
    ...analysis,
    providerStatus: buildProviderStatus([]),
    cacheStatus: buildCacheStatus({
      cloudflareSearchCache: {
        enabled: false,
        provider: 'fixture-replay',
      },
    }),
  })
}

export function onRequestPost() {
  return methodNotAllowed()
}
