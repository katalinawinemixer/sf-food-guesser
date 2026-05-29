const venueTypeWordsPattern = /\b(cafe|coffee|restaurant|bakery|bar|counter|spot|venue|place|shop|eatery|bistro)\b/i
const placeholderPrefixPattern = /^(other|another|unknown|unidentified|unnamed)\b/i

function stringList(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : []
}

function evidenceCategories(candidate = {}) {
  return stringList(candidate.evidenceCategories).map((category) =>
    category.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
  )
}

function hasTrustedComparisonPhoto(candidate = {}, trustedPhotoUrls = []) {
  const trusted = new Set(trustedPhotoUrls.filter(Boolean).map(String))
  const photos = Array.isArray(candidate.comparisonPhotos) ? candidate.comparisonPhotos : []
  return photos.some((photo) => {
    const url = photo?.url || photo?.pageUrl || photo?.thumbnailUrl
    return url && trusted.has(String(url))
  })
}

export function isPlaceholderCandidateName(name) {
  const cleanedName = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!cleanedName) return false
  return placeholderPrefixPattern.test(cleanedName) && venueTypeWordsPattern.test(cleanedName)
}

export function candidatePassesQualityGate(candidate = {}, options = {}) {
  return evaluateCandidateQuality(candidate, options).passes
}

export function evaluateCandidateQuality(candidate = {}, options = {}) {
  const name = String(candidate.name ?? '').trim()
  const id = String(candidate.id ?? '').trim()
  if (!name && !id) return { passes: false, reasons: ['missing_name'] }
  if (name && isPlaceholderCandidateName(name)) {
    return { passes: false, reasons: ['placeholder_name'] }
  }

  const categories = evidenceCategories(candidate)
  const seedVenueIds = new Set(stringList(options.seedVenueIds))
  const hasSeedMatch = Boolean(
    options.seedMatched || (id && seedVenueIds.has(id)),
  )
  const hasIdentityEvidence = categories.some((category) =>
    ['visible_text', 'gps_match'].includes(category),
  )
  const hasSource = stringList(candidate.sourceUrls).length > 0
  const hasExternalPhotoMatch = hasTrustedComparisonPhoto(
    candidate,
    stringList(options.trustedPhotoUrls ?? options.photoEvidenceUrls),
  )
  const passes = hasSeedMatch || hasIdentityEvidence || hasExternalPhotoMatch || hasSource
  const reasons = [
    ...(hasSeedMatch ? ['seed_match'] : []),
    ...(hasIdentityEvidence ? ['identity_evidence'] : []),
    ...(hasExternalPhotoMatch ? ['trusted_photo_match'] : []),
    ...(hasSource ? ['source_url'] : []),
    ...(!passes ? ['no_source_or_identity_evidence'] : []),
  ]

  return { passes, reasons }
}

export function buildResultQuality(rawCandidates = [], shownCandidates = [], options = {}) {
  const raw = Array.isArray(rawCandidates) ? rawCandidates : []
  const shown = Array.isArray(shownCandidates) ? shownCandidates : []
  const shownKeyCounts = shown.reduce((counts, candidate) => {
    const key = String(candidate?.id || candidate?.name || '').trim().toLowerCase()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map())
  const candidateDetails = raw
    .map((candidate) => {
      const quality = evaluateCandidateQuality(candidate, options)
      const key = String(candidate?.id || candidate?.name || '').trim().toLowerCase()
      const remainingShownCount = key ? shownKeyCounts.get(key) ?? 0 : 0
      const isShown = remainingShownCount > 0
      if (isShown) shownKeyCounts.set(key, remainingShownCount - 1)
      return {
        name: String(candidate?.name || candidate?.id || 'Unnamed candidate'),
        shown: isShown,
        passes: quality.passes,
        reasons: isShown ? quality.reasons : [
          ...quality.reasons,
          ...(quality.passes ? ['not_in_top_shown_results'] : []),
        ],
      }
    })
  const filteredCandidates = candidateDetails
    .filter((candidate) => !candidate.passes && candidate.reasons.some((reason) =>
      ['missing_name', 'placeholder_name', 'no_source_or_identity_evidence'].includes(reason),
    ))
  const hiddenCandidates = candidateDetails.filter((candidate) => !candidate.shown)

  const topConfidence = Number(shown[0]?.confidence ?? 0)
  const closeCandidateCount = shown.filter((candidate) =>
    topConfidence - Number(candidate?.confidence ?? 0) <= 6,
  ).length
  const state = shown.length === 0
    ? 'no_showable_candidates'
    : options.modelNeedsMoreEvidence
      ? 'model_needs_more_evidence'
      : closeCandidateCount > 1
        ? 'close_call'
        : topConfidence < Number(options.minimumTopConfidence ?? 80)
          ? 'weak_evidence'
          : 'enough_evidence'
  const summary = {
    no_showable_candidates: 'No candidate had enough source, identity, seed, or trusted photo evidence to show.',
    model_needs_more_evidence: `${shown.length} candidate${shown.length === 1 ? '' : 's'} passed the evidence gate, but the model requested more evidence.`,
    close_call: `${shown.length} candidate${shown.length === 1 ? '' : 's'} passed the evidence gate, but the top results are too close to crown one clear match.`,
    weak_evidence: `${shown.length} candidate${shown.length === 1 ? '' : 's'} passed the evidence gate, but the strongest score is below the confidence threshold.`,
    enough_evidence: `${shown.length} candidate${shown.length === 1 ? '' : 's'} passed the evidence gate.`,
  }[state]

  return {
    state,
    shownCandidates: shown.length,
    filteredCandidates: filteredCandidates.length,
    filteredCandidateDetails: filteredCandidates.slice(0, 8),
    hiddenCandidates: hiddenCandidates.length,
    hiddenCandidateDetails: hiddenCandidates.slice(0, 8).map(({ name, reasons }) => ({ name, reasons })),
    topConfidence,
    closeCandidateCount,
    notEnoughEvidence: state !== 'enough_evidence',
    summary,
  }
}
