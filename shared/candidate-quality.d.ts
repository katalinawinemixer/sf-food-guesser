export function isPlaceholderCandidateName(name?: string): boolean

export function candidatePassesQualityGate(
  candidate?: {
    id?: string
    name?: string
    evidenceCategories?: string[]
    sourceUrls?: string[]
    comparisonPhotos?: Array<{
      url?: string
      pageUrl?: string
      thumbnailUrl?: string
    }>
  },
  options?: {
    seedMatched?: boolean
    seedVenueIds?: string[]
    trustedPhotoUrls?: string[]
    photoEvidenceUrls?: string[]
  },
): boolean
