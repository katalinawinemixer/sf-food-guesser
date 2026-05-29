export type SharedVenueCategory =
  | 'Bakery'
  | 'Cafe'
  | 'Restaurant'
  | 'Dessert'
  | 'Late night'
  | 'Counter'

export type SharedVenue = {
  id: string
  name: string
  category: SharedVenueCategory
  neighborhood: string
  address: string
  lat: number
  lng: number
  signature: string[]
  imageEvidenceHints: string[]
  visualClues?: string[]
  menuClues?: string[]
  doNotInferFrom?: string[]
  multiLocation?: boolean
  sourceConfidence?: 'source-backed' | 'needs-review'
  sourceUrl: string
  mapsUrl: string
  note: string
}

export const venues: SharedVenue[]
