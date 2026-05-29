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

export function evaluateCandidateQuality(
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
): {
  passes: boolean
  reasons: string[]
}

export function buildResultQuality(
  rawCandidates?: Array<Record<string, unknown>>,
  shownCandidates?: Array<Record<string, unknown>>,
  options?: {
    seedMatched?: boolean
    seedVenueIds?: string[]
    trustedPhotoUrls?: string[]
    photoEvidenceUrls?: string[]
    modelNeedsMoreEvidence?: boolean
    minimumTopConfidence?: number
  },
): {
  state: 'no_showable_candidates' | 'model_needs_more_evidence' | 'close_call' | 'weak_evidence' | 'enough_evidence'
  shownCandidates: number
  filteredCandidates: number
  filteredCandidateDetails: Array<{ name: string; reasons: string[] }>
  hiddenCandidates: number
  hiddenCandidateDetails: Array<{ name: string; reasons: string[] }>
  topConfidence: number
  closeCandidateCount: number
  notEnoughEvidence: boolean
  summary: string
}
