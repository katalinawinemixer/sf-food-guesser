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
  const name = String(candidate.name ?? '').trim()
  const id = String(candidate.id ?? '').trim()
  if (!name && !id) return false
  if (name && isPlaceholderCandidateName(name)) return false

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

  return hasSeedMatch || hasIdentityEvidence || hasExternalPhotoMatch || hasSource
}
