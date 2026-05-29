export const goldenAnalysisFixtures: Array<{
  id: string
  label: string
  analysis: {
    summary: string
    imageEvidence: string[]
    candidates: Array<Record<string, unknown>>
  }
  options?: {
    seedVenueIds?: string[]
    ocrVisibleText?: string[]
  }
  expectedShown: string[]
  expectedFiltered: number
}>
