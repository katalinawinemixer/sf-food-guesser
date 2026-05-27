import { type DragEvent, useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import { gps } from 'exifr'
import {
  ArrowUpRight,
  BadgeCheck,
  Camera,
  ChefHat,
  ExternalLink,
  Filter,
  LocateFixed,
  LoaderCircle,
  MapPin,
  Search,
  Upload,
  X,
} from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { categoryOptions, venues, type Venue, type VenueCategory } from './venues'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''
const maxUploadBytes = 12 * 1024 * 1024
const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
])
const allowedImageExtensions = /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i

function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`
}

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function validatePhotoFile(file: File) {
  const mimeType = file.type.toLowerCase()

  if (file.size > maxUploadBytes) {
    return `That photo is ${formatMegabytes(file.size)}. Upload an image under 12 MB.`
  }

  if (!allowedImageMimeTypes.has(mimeType) && !allowedImageExtensions.test(file.name)) {
    return 'Unsupported image type. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.'
  }

  return null
}

async function readApiError(response: Response) {
  try {
    const result = await response.json()
    if (typeof result.error === 'string' && result.error) return result.error
  } catch {
    // Fall through to status-specific messages below.
  }

  if (response.status === 413) return 'That image is too large. Upload a photo under 12 MB.'
  if (response.status === 415) {
    return 'Unsupported image type. Upload a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.'
  }
  if (response.status === 429) {
    return 'The AI provider is rate limiting photo analysis. Wait a bit, then try the upload again.'
  }

  return 'Photo analysis failed.'
}

function normalizeConfidence(value: unknown) {
  const confidence = Number(value ?? 0)
  if (!Number.isFinite(confidence)) return 0
  const normalized = confidence > 0 && confidence <= 1 ? confidence * 100 : confidence
  return Math.round(Math.max(0, Math.min(100, normalized)))
}

type VisionCandidate = {
  id: string
  name?: string
  category?: VenueCategory | string
  neighborhood?: string
  address?: string
  confidence: number
  originalConfidence?: number
  evidenceType?: string
  evidenceCategories?: string[]
  reasons: string[]
  rankingNotes?: string[]
  sourceUrls?: string[]
  mapsQuery?: string
  searchQueries?: string[]
}

type VisionAnalysis = {
  runId?: string
  summary: string
  imageEvidence: string[]
  candidates: VisionCandidate[]
  needsMoreEvidence: boolean
  searchProvider?: string | null
  webSearchProvider?: string | null
  articleSearchProvider?: string | null
  articleCandidates?: Array<{
    name: string
    category?: string
    neighborhood?: string
    address?: string
    whyRelevant?: string
    openingContext?: string
    sourceUrls?: string[]
  }>
  photoEvidence?: Array<{
    title: string
    source: string
    pageUrl?: string
    thumbnailUrl?: string
    query?: string
    placeTitle?: string
    placeAddress?: string
  }>
  webEvidence?: Array<{
    title: string
    source: string
    url: string
    snippet?: string
    query?: string
    searchLabel?: string
  }>
  providerWarnings?: Array<{
    provider: string
    message: string
  }>
}

type PhotoState = {
  status: 'empty' | 'ready' | 'reading' | 'gps' | 'nogps' | 'error'
  name?: string
  previewUrl?: string
  coords?: {
    latitude: number
    longitude: number
  }
  analysis?: VisionAnalysis
  message?: string
}

type MatchVenue = Omit<Venue, 'lat' | 'lng'> & {
  lat?: number
  lng?: number
  locationVerified?: boolean
}

type ApiHealth = {
  status: 'checking' | 'ready' | 'missing-key' | 'offline'
  model?: string
  message?: string
}

type FeedbackSelection = 'correct' | 'incorrect'
type FeedbackVote = FeedbackSelection | 'undo'

type FeedbackState = {
  vote: FeedbackSelection
  status: 'saving' | 'saved' | 'error'
  automatic?: boolean
}

function hasVerifiedCoordinates(
  venue: MatchVenue,
): venue is MatchVenue & { lat: number; lng: number } {
  return venue.locationVerified === true && Number.isFinite(venue.lat) && Number.isFinite(venue.lng)
}

function venueLocationLabel(venue: MatchVenue) {
  if (hasVerifiedCoordinates(venue)) return `${venue.address} · ${venue.neighborhood}`
  if (venue.address === 'Address not confirmed') return 'Location not confirmed'
  return `${venue.address} · ${venue.neighborhood} · Unverified location`
}

function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const earthRadius = 6371e3
  const fromLat = (from.latitude * Math.PI) / 180
  const toLat = (to.latitude * Math.PI) / 180
  const deltaLat = ((to.latitude - from.latitude) * Math.PI) / 180
  const deltaLng = ((to.longitude - from.longitude) * Math.PI) / 180
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(fromLat) *
      Math.cos(toLat) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return earthRadius * c
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

function confidenceFromDistance(meters: number) {
  if (meters <= 50) return 96
  if (meters <= 120) return 88
  if (meters <= 250) return 74
  if (meters <= 500) return 58
  if (meters <= 1000) return 38
  return 18
}

function getPhotoMatches(
  coords: { latitude: number; longitude: number },
  category: 'All' | VenueCategory,
) {
  return venues
    .filter((venue) => category === 'All' || venue.category === category)
    .map((venue) => {
      const distance = distanceMeters(coords, {
        latitude: venue.lat,
        longitude: venue.lng,
      })
      const proximityScore = Math.max(0, 130 - distance / 5)
      const distanceConfidence = confidenceFromDistance(distance)

      return {
        venue: {
          ...venue,
          locationVerified: true,
        },
        distanceMeters: distance,
        score: proximityScore,
        confidence: distanceConfidence,
        evidenceCategories: ['gps_match'],
        reasons: [`Photo GPS is ${formatDistance(distance)} from this venue.`],
        rankingNotes: ['Boosted for photo GPS.'],
      }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0)
    })
    .slice(0, 9)
}

function getVisionMatches(
  analysis: VisionAnalysis,
  category: 'All' | VenueCategory,
  coords?: { latitude: number; longitude: number },
) {
  const candidateMap = new Map(analysis.candidates.map((candidate) => [candidate.id, candidate]))
  const seedMatches = venues
    .filter((venue) => category === 'All' || venue.category === category)
    .map((venue) => {
      const candidate = candidateMap.get(venue.id)
      const distance = coords
        ? distanceMeters(coords, {
            latitude: venue.lat,
            longitude: venue.lng,
          })
        : undefined
      const gpsBoost = distance === undefined ? 0 : Math.max(0, 35 - distance / 20)
      const confidence = candidate ? Math.min(98, candidate.confidence) : 0
      const visionReasons = candidate?.reasons ?? []

      return {
        venue: {
          ...venue,
          locationVerified: true,
        },
        distanceMeters: distance,
        score: (candidate?.confidence ?? 0) * 2 + gpsBoost,
        confidence,
        evidenceCategories: candidate?.evidenceCategories ?? [],
        reasons: [
          ...visionReasons,
          ...(distance !== undefined ? [`Photo GPS is ${formatDistance(distance)} away.`] : []),
        ].slice(0, 4),
        rankingNotes: candidate?.rankingNotes ?? [],
      }
    })

  const webMatches = analysis.candidates
    .filter((candidate) => !candidate.id || !venues.some((venue) => venue.id === candidate.id))
    .filter((candidate) => category === 'All' || candidate.category === category)
    .map((candidate) => {
      const mapsQuery =
        candidate.mapsQuery ||
        [candidate.name, candidate.address, 'San Francisco'].filter(Boolean).join(' ')

      return {
        venue: {
          id: candidate.id || `web:${candidate.name ?? 'candidate'}`,
          name: candidate.name || 'Web-discovered candidate',
          category: (candidate.category || 'Restaurant') as VenueCategory,
          neighborhood: candidate.neighborhood || 'San Francisco',
          address: candidate.address || 'Address not confirmed',
          locationVerified: false,
          signature: [
            candidate.evidenceType ? `${candidate.evidenceType} evidence` : 'Image match',
            ...(candidate.sourceUrls?.length ? ['Web-discovered match'] : []),
          ],
          imageEvidenceHints: analysis.imageEvidence,
          sourceUrl: candidate.sourceUrls?.[0] || `https://www.google.com/search?q=${encodeURIComponent(mapsQuery)}`,
          mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
          note: 'Discovered through live web search from the uploaded image.',
        },
        distanceMeters: undefined,
        score: candidate.confidence * 2,
        confidence: Math.min(98, candidate.confidence),
        evidenceCategories: candidate.evidenceCategories ?? [],
        reasons: candidate.reasons.slice(0, 4),
        rankingNotes: candidate.rankingNotes ?? [],
        sourceUrls: candidate.sourceUrls ?? [],
      }
    })

  return [...seedMatches, ...webMatches]
    .filter((match) => match.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.confidence - a.confidence
    })
    .slice(0, 9)
}

function confidenceLabel(confidence: number) {
  if (confidence >= 75) return 'Strong'
  if (confidence >= 45) return 'Likely'
  if (confidence > 0) return 'Possible'
  return 'Ready'
}

function feedbackLabel(feedback: FeedbackState) {
  if (feedback.status === 'saving') return 'Saving feedback...'
  if (feedback.status === 'error') return 'Could not save feedback'
  if (feedback.vote === 'correct') return 'Marked correct'
  return feedback.automatic ? 'Auto-marked incorrect' : 'Marked incorrect'
}

const analysisSteps = [
  'Reading image details',
  'Searching new cafe articles',
  'Searching interiors and photo pages',
  'Ranking likely SF matches',
]

async function analyzePhotoWithVision(file: File): Promise<VisionAnalysis> {
  const payload = new FormData()
  payload.append('photo', file)
  payload.append(
    'venues',
    JSON.stringify(
      venues.map((venue) => ({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        neighborhood: venue.neighborhood,
        address: venue.address,
        signature: venue.signature,
        imageEvidenceHints: venue.imageEvidenceHints,
        note: venue.note,
      })),
    ),
  )

  const response = await fetch(apiUrl('/api/analyze-photo'), {
    method: 'POST',
    body: payload,
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const result = await response.json()

  return {
    runId: result.runId ? String(result.runId) : undefined,
    summary: String(result.summary ?? 'No visual summary returned.'),
    imageEvidence: Array.isArray(result.imageEvidence)
      ? result.imageEvidence.map(String).slice(0, 8)
      : Array.isArray(result.imageEvidenceHints)
        ? result.imageEvidenceHints.map(String).slice(0, 8)
        : [],
    candidates: Array.isArray(result.candidates)
      ? result.candidates
          .map((candidate: Partial<VisionCandidate>) => ({
            id: String(candidate.id ?? ''),
            name: candidate.name ? String(candidate.name) : undefined,
            category: candidate.category ? String(candidate.category) : undefined,
            neighborhood: candidate.neighborhood ? String(candidate.neighborhood) : undefined,
            address: candidate.address ? String(candidate.address) : undefined,
            confidence: normalizeConfidence(candidate.confidence),
            originalConfidence: candidate.originalConfidence
              ? normalizeConfidence(candidate.originalConfidence)
              : undefined,
            evidenceType: candidate.evidenceType ? String(candidate.evidenceType) : undefined,
            evidenceCategories: Array.isArray(candidate.evidenceCategories)
              ? candidate.evidenceCategories.map(String).slice(0, 7)
              : [],
            reasons: Array.isArray(candidate.reasons)
              ? candidate.reasons.map(String).slice(0, 4)
              : [],
            rankingNotes: Array.isArray(candidate.rankingNotes)
              ? candidate.rankingNotes.map(String).slice(0, 4)
              : [],
            sourceUrls: Array.isArray(candidate.sourceUrls)
              ? candidate.sourceUrls.map(String).slice(0, 4)
              : [],
            mapsQuery: candidate.mapsQuery ? String(candidate.mapsQuery) : undefined,
            searchQueries: Array.isArray(candidate.searchQueries)
              ? candidate.searchQueries.map(String).slice(0, 4)
              : [],
          }))
          .filter(
            (candidate: VisionCandidate) =>
              venues.some((venue) => venue.id === candidate.id) || Boolean(candidate.name),
          )
      : [],
    needsMoreEvidence: Boolean(result.needsMoreEvidence),
    searchProvider: result.searchProvider ? String(result.searchProvider) : null,
    webSearchProvider: result.webSearchProvider ? String(result.webSearchProvider) : null,
    articleSearchProvider: result.articleSearchProvider
      ? String(result.articleSearchProvider)
      : null,
    articleCandidates: Array.isArray(result.articleCandidates)
      ? result.articleCandidates
          .map((candidate: Record<string, unknown>) => ({
            name: String(candidate.name ?? ''),
            category: candidate.category ? String(candidate.category) : undefined,
            neighborhood: candidate.neighborhood ? String(candidate.neighborhood) : undefined,
            address: candidate.address ? String(candidate.address) : undefined,
            whyRelevant: candidate.whyRelevant ? String(candidate.whyRelevant) : undefined,
            openingContext: candidate.openingContext
              ? String(candidate.openingContext)
              : undefined,
            sourceUrls: Array.isArray(candidate.sourceUrls)
              ? candidate.sourceUrls.map(String).slice(0, 4)
              : [],
          }))
          .filter((candidate: { name: string }) => candidate.name)
          .slice(0, 8)
      : [],
    photoEvidence: Array.isArray(result.photoEvidence)
      ? result.photoEvidence
          .map((photo: Record<string, unknown>) => ({
            title: String(photo.title ?? 'Candidate photo'),
            source: String(photo.source ?? 'Photo search'),
            pageUrl: photo.pageUrl ? String(photo.pageUrl) : undefined,
            thumbnailUrl: photo.thumbnailUrl ? String(photo.thumbnailUrl) : undefined,
            query: photo.query ? String(photo.query) : undefined,
            placeTitle: photo.placeTitle ? String(photo.placeTitle) : undefined,
            placeAddress: photo.placeAddress ? String(photo.placeAddress) : undefined,
          }))
          .slice(0, 6)
      : [],
    webEvidence: Array.isArray(result.webEvidence)
      ? result.webEvidence
          .map((page: Record<string, unknown>) => ({
            title: String(page.title ?? 'Candidate page'),
            source: String(page.source ?? 'Web search'),
            url: String(page.url ?? ''),
            snippet: page.snippet ? String(page.snippet) : undefined,
            query: page.query ? String(page.query) : undefined,
            searchLabel: page.searchLabel ? String(page.searchLabel) : undefined,
          }))
          .filter((page: { url: string }) => page.url)
          .slice(0, 6)
      : [],
    providerWarnings: Array.isArray(result.providerWarnings)
      ? result.providerWarnings
          .map((warning: Record<string, unknown>) => ({
            provider: String(warning.provider ?? 'provider'),
            message: String(warning.message ?? 'Provider unavailable'),
          }))
          .slice(0, 4)
      : [],
  }
}

function App() {
  const [category, setCategory] = useState<'All' | VenueCategory>('All')
  const [activeVenueId, setActiveVenueId] = useState<string | null>(null)
  const [photo, setPhoto] = useState<PhotoState>({ status: 'empty' })
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false)
  const [apiHealth, setApiHealth] = useState<ApiHealth>({ status: 'checking' })
  const [feedbackByVenueId, setFeedbackByVenueId] = useState<Record<string, FeedbackState>>({})

  const matches = useMemo(
    () =>
      photo.analysis
        ? getVisionMatches(photo.analysis, category, photo.coords)
        : photo.coords
          ? getPhotoMatches(photo.coords, category)
          : [],
    [category, photo.analysis, photo.coords],
  )
  const activeMatch = matches.find((match) => match.venue.id === activeVenueId) ?? matches[0]

  useEffect(() => {
    const previewUrl = photo.previewUrl
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [photo.previewUrl])

  useEffect(() => {
    let shouldIgnore = false

    async function checkApiHealth() {
      try {
        const response = await fetch(apiUrl('/api/health'))
        const result = await response.json()
        if (shouldIgnore) return

        setApiHealth({
          status: result.visionEnabled ? 'ready' : 'missing-key',
          model: result.model,
          message: result.visionEnabled
            ? `Photo identification is ready with ${result.model}.`
            : 'Photo identification needs OPENROUTER_API_KEY or OPENAI_API_KEY in .env, then restart npm run dev.',
        })
      } catch {
        if (shouldIgnore) return
        setApiHealth({
          status: 'offline',
          message: 'Photo identification API is offline. Start the app with npm run dev.',
        })
      }
    }

    checkApiHealth()

    return () => {
      shouldIgnore = true
    }
  }, [])

  function nextMatches(
    nextCategory: 'All' | VenueCategory = category,
    nextCoords = photo.coords,
    nextAnalysis = photo.analysis,
  ) {
    return nextAnalysis
      ? getVisionMatches(nextAnalysis, nextCategory, nextCoords)
      : nextCoords
        ? getPhotoMatches(nextCoords, nextCategory)
        : []
  }

  function handlePhotoFile(file?: File) {
    if (!file) return
    const validationMessage = validatePhotoFile(file)

    if (validationMessage) {
      setPhotoFile(null)
      setFeedbackByVenueId({})
      setPhoto({
        status: 'error',
        name: file.name,
        message: validationMessage,
      })
      setActiveVenueId(null)
      return
    }

    const previewUrl = URL.createObjectURL(file)
    setPhotoFile(file)
    setFeedbackByVenueId({})
    setPhoto({
      status: 'ready',
      name: file.name,
      previewUrl,
      message: 'Photo loaded. Submit it to identify the most likely SF venue.',
    })
    setActiveVenueId(null)
  }

  function handlePhotoDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsDraggingPhoto(false)
    const file = Array.from(event.dataTransfer.files).find(
      (droppedFile) =>
        allowedImageMimeTypes.has(droppedFile.type.toLowerCase()) ||
        allowedImageExtensions.test(droppedFile.name),
    )
    if (file) {
      handlePhotoFile(file)
      return
    }

    setPhotoFile(null)
    setFeedbackByVenueId({})
    setPhoto({
      status: 'error',
      message: 'Drop a JPG, PNG, WebP, AVIF, GIF, HEIC, or HEIF image.',
    })
    setActiveVenueId(null)
  }

  async function submitPhoto() {
    if (!photoFile || !photo.previewUrl) return

    setPhoto({
      status: 'reading',
      name: photoFile.name,
      previewUrl: photo.previewUrl,
      message: 'Analyzing this photo for image evidence...',
    })
    setFeedbackByVenueId({})

    const previewUrl = photo.previewUrl
    try {
      const [location, analysis] = await Promise.all([
        gps(photoFile).catch(() => undefined),
        analyzePhotoWithVision(photoFile),
      ])
      const coords =
        location &&
        Number.isFinite(location.latitude) &&
        Number.isFinite(location.longitude)
          ? {
              latitude: location.latitude,
              longitude: location.longitude,
            }
          : undefined

      if (analysis.candidates.length > 0) {
        setPhoto({
          status: coords ? 'gps' : 'nogps',
          name: photoFile.name,
          previewUrl,
          coords,
          analysis,
          message: analysis.needsMoreEvidence
            ? `Analyzed photo, but confidence is limited: ${analysis.summary}`
            : `Analyzed photo: ${analysis.summary}`,
        })
        setActiveVenueId(nextMatches(category, coords, analysis)[0]?.venue.id ?? null)
        return
      }

      setPhoto({
        status: 'nogps',
        name: photoFile.name,
        previewUrl,
        coords,
        analysis,
        message: `The image was analyzed, but it was too ambiguous to rank a venue: ${analysis.summary}`,
      })
    } catch (error) {
      setPhoto({
        status: 'error',
        name: photoFile.name,
        previewUrl,
        message:
          error instanceof Error
            ? error.message
            : 'Could not analyze this image. Try again with a clearer image.',
      })
    }
  }

  function clearPhoto() {
    setPhoto({ status: 'empty' })
    setPhotoFile(null)
    setActiveVenueId(null)
    setFeedbackByVenueId({})
  }

  async function recordGuessFeedback(
    match: ReturnType<typeof getVisionMatches>[number] | ReturnType<typeof getPhotoMatches>[number],
    vote: FeedbackVote,
    rank: number,
  ) {
    const response = await fetch(apiUrl('/api/feedback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: photo.analysis?.runId,
        vote,
        rank,
        candidate: {
          id: match.venue.id,
          name: match.venue.name,
          category: match.venue.category,
          neighborhood: match.venue.neighborhood,
          address: match.venue.address,
          confidence: match.confidence,
          locationVerified: match.venue.locationVerified === true,
          evidenceCategories: match.evidenceCategories,
          reasons: match.reasons,
          rankingNotes: match.rankingNotes,
          sourceUrls: [
            match.venue.sourceUrl,
            ...('sourceUrls' in match && Array.isArray(match.sourceUrls) ? match.sourceUrls : []),
          ],
        },
        analysis: {
          summary: photo.analysis?.summary ?? '',
          imageEvidence: photo.analysis?.imageEvidence ?? [],
          needsMoreEvidence: photo.analysis?.needsMoreEvidence ?? false,
        },
        providers: {
          searchProvider: photo.analysis?.searchProvider,
          webSearchProvider: photo.analysis?.webSearchProvider,
          articleSearchProvider: photo.analysis?.articleSearchProvider,
        },
      }),
    })

    if (!response.ok) throw new Error('Feedback was not saved.')
  }

  async function submitGuessFeedback(
    match: ReturnType<typeof getVisionMatches>[number] | ReturnType<typeof getPhotoMatches>[number],
    vote: FeedbackSelection,
    rank: number,
  ) {
    if (vote === 'correct') {
      const nextFeedback = matches.reduce<Record<string, FeedbackState>>((state, candidate) => {
        state[candidate.venue.id] = {
          vote: candidate.venue.id === match.venue.id ? 'correct' : 'incorrect',
          status: 'saving',
          automatic: candidate.venue.id !== match.venue.id,
        }
        return state
      }, {})
      setFeedbackByVenueId((current) => ({ ...current, ...nextFeedback }))

      const results = await Promise.allSettled(
        matches.map((candidate, index) =>
          recordGuessFeedback(
            candidate,
            candidate.venue.id === match.venue.id ? 'correct' : 'incorrect',
            index + 1,
          ),
        ),
      )

      setFeedbackByVenueId((current) => {
        const updated = { ...current }
        matches.forEach((candidate, index) => {
          const intended = nextFeedback[candidate.venue.id]
          updated[candidate.venue.id] = {
            ...intended,
            status: results[index].status === 'fulfilled' ? 'saved' : 'error',
          }
        })
        return updated
      })
      return
    }

    const venueId = match.venue.id
    const nextState: FeedbackState = { vote, status: 'saving' }
    setFeedbackByVenueId((current) => ({ ...current, [venueId]: nextState }))

    try {
      await recordGuessFeedback(match, vote, rank)
      setFeedbackByVenueId((current) => ({
        ...current,
        [venueId]: { vote, status: 'saved' },
      }))
    } catch {
      setFeedbackByVenueId((current) => ({
        ...current,
        [venueId]: { vote, status: 'error' },
      }))
    }
  }

  async function undoGuessFeedback(
    match: ReturnType<typeof getVisionMatches>[number] | ReturnType<typeof getPhotoMatches>[number],
    rank: number,
  ) {
    const feedback = feedbackByVenueId[match.venue.id]
    if (!feedback) return

    const affectedMatches =
      feedback.vote === 'correct'
        ? matches.filter((candidate) => feedbackByVenueId[candidate.venue.id])
        : [match]
    setFeedbackByVenueId((current) => {
      const updated = { ...current }
      affectedMatches.forEach((candidate) => {
        const existing = updated[candidate.venue.id]
        if (existing) updated[candidate.venue.id] = { ...existing, status: 'saving' }
      })
      return updated
    })

    const results = await Promise.allSettled(
      affectedMatches.map((candidate) =>
        recordGuessFeedback(
          candidate,
          'undo',
          matches.findIndex((item) => item.venue.id === candidate.venue.id) + 1 || rank,
        ),
      ),
    )

    setFeedbackByVenueId((current) => {
      const updated = { ...current }
      affectedMatches.forEach((candidate, index) => {
        if (results[index].status === 'fulfilled') {
          delete updated[candidate.venue.id]
          return
        }
        const existing = updated[candidate.venue.id]
        if (existing) updated[candidate.venue.id] = { ...existing, status: 'error' }
      })
      return updated
    })
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ChefHat size={20} strokeWidth={2.4} />
          </span>
          <div>
            <h1>SF Food Guesser</h1>
            <p>Upload a food photo to identify likely SF restaurants, cafes, bakeries, and counters using image evidence plus live web search.</p>
          </div>
        </div>
        <div className="accuracy-pill">
          <BadgeCheck size={17} />
          <span>{venues.length} verified venue records</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel" aria-label="Photo identification controls">
          <section className="photo-panel" aria-label="Photo upload">
            <div className="photo-head">
              <div>
                <span className="eyebrow">Photo</span>
                <h2>Find the place from a photo</h2>
              </div>
              {photo.status !== 'empty' ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Remove photo"
                  onClick={clearPhoto}
                  title="Remove photo"
                >
                  <X size={18} />
                </button>
              ) : null}
            </div>

            <label
              className={[
                'upload-zone',
                photo.previewUrl ? 'has-image' : '',
                isDraggingPhoto ? 'dragging' : '',
              ].join(' ').trim()}
              onDragEnter={(event) => {
                event.preventDefault()
                setIsDraggingPhoto(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                setIsDraggingPhoto(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                if (event.currentTarget.contains(event.relatedTarget as Node)) return
                setIsDraggingPhoto(false)
              }}
              onDrop={handlePhotoDrop}
            >
              {photo.previewUrl ? (
                <span className="upload-preview">
                  <img src={photo.previewUrl} alt={photo.name ?? 'Uploaded food photo'} />
                  {photo.status === 'reading' ? (
                    <span className="analysis-overlay" aria-label="Analyzing uploaded photo">
                      <span className="scan-line" />
                      <span className="analysis-badge">
                        <LoaderCircle size={16} />
                        Searching image and web evidence
                      </span>
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="upload-empty">
                  <Upload size={22} />
                  <span>{isDraggingPhoto ? 'Drop it here' : 'Drop image here or choose'}</span>
                </span>
              )}
              <input
                type="file"
                accept="image/*,.heic,.heif"
                onChange={(event) => handlePhotoFile(event.target.files?.[0])}
              />
            </label>

            {photo.status !== 'empty' ? (
              <div className={`photo-status ${photo.status}`}>
                {photo.status === 'gps' ? <LocateFixed size={16} /> : <Camera size={16} />}
                <span>{photo.message}</span>
              </div>
            ) : null}

            {apiHealth.status !== 'ready' ? (
              <div className={`photo-status setup ${apiHealth.status}`}>
                <Camera size={16} />
                <span>
                  {apiHealth.message ??
                    'Checking whether photo identification is ready...'}
                </span>
              </div>
            ) : null}

            {photo.analysis?.imageEvidence.length ? (
              <div className="vision-evidence" aria-label="Detected image evidence">
                {photo.analysis.imageEvidence.map((evidence) => (
                  <span key={evidence}>{evidence}</span>
                ))}
              </div>
            ) : null}

            {photo.analysis &&
            (photo.analysis.articleCandidates?.length ||
              photo.analysis.webEvidence?.length ||
              photo.analysis.photoEvidence?.length) ? (
              <div className="search-trail" aria-label="Search evidence trail">
                <div className="search-trail-head">
                  <Search size={15} />
                  <span>Search trail</span>
                </div>
                {photo.analysis.articleCandidates?.length ? (
                  <p>
                    {photo.analysis.articleSearchProvider ?? 'Article search'} found{' '}
                    {photo.analysis.articleCandidates.length} article-backed venue candidates.
                  </p>
                ) : null}
                {photo.analysis.webEvidence?.length ? (
                  <p>
                    {photo.analysis.webSearchProvider ?? 'Web search'} checked{' '}
                    {photo.analysis.webEvidence.length} review/page results.
                  </p>
                ) : null}
                {photo.analysis.photoEvidence?.length ? (
                  <p>
                    {photo.analysis.searchProvider ?? 'Photo search'} compared{' '}
                    {photo.analysis.photoEvidence.length} public photos.
                  </p>
                ) : null}
              </div>
            ) : null}

            <button
              className="submit-photo"
              type="button"
              disabled={photo.status === 'reading' || !photoFile || apiHealth.status !== 'ready'}
              onClick={submitPhoto}
            >
              {photo.status === 'reading' ? (
                <>
                  <LoaderCircle size={17} />
                  Identifying...
                </>
              ) : (
                'Identify restaurant'
              )}
            </button>
          </section>

          <div className="filter-head">
            <Filter size={17} />
            <span>Type</span>
          </div>
          <div className="category-grid" aria-label="Venue type">
            {categoryOptions.map((option) => (
              <button
                key={option}
                className={option === category ? 'selected' : ''}
                type="button"
                onClick={() => {
                  setCategory(option)
                  setActiveVenueId(nextMatches(option)[0]?.venue.id ?? null)
                }}
              >
                {option}
              </button>
            ))}
          </div>

          {activeMatch ? (
            <section className="active-card" aria-live="polite">
              <div className="active-meta">
                <span>{activeMatch.venue.category}</span>
                <span>{activeMatch.venue.neighborhood}</span>
              </div>
              <h2>{activeMatch.venue.name}</h2>
              <p>{activeMatch.venue.note}</p>
              <div className="action-row">
                <a href={activeMatch.venue.mapsUrl} target="_blank" rel="noreferrer">
                  <MapPin size={16} />
                  {hasVerifiedCoordinates(activeMatch.venue) ? 'Maps' : 'Search Maps'}
                </a>
                <a href={activeMatch.venue.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} />
                  Source
                </a>
              </div>
            </section>
          ) : null}
        </aside>

        <section className="main-panel">
          {activeMatch ? (
            <section className="answer-panel" aria-live="polite">
              <div className="answer-copy">
                <span className="eyebrow">Best guess to confirm</span>
                <h2>{activeMatch.venue.name}</h2>
                <p>{venueLocationLabel(activeMatch.venue)}</p>
              </div>
              <div className="answer-score">
                <span>{confidenceLabel(activeMatch.confidence)}</span>
                <strong>{activeMatch.confidence || '--'}%</strong>
              </div>
            </section>
          ) : null}

          {photo.analysis?.providerWarnings?.length ? (
            <div className="provider-warning" role="status">
              <Search size={15} />
              <span>
                Some web evidence was unavailable, so the app ranked using the image and
                remaining sources.
              </span>
            </div>
          ) : null}

          <div className="map-panel" aria-label="Venue map">
            <MapContainer
              center={[37.7749, -122.445]}
              zoom={12}
              minZoom={11}
              maxZoom={16}
              scrollWheelZoom={false}
              className="sf-map"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {matches.map((match) => {
                if (!hasVerifiedCoordinates(match.venue)) return null

                return (
                  <CircleMarker
                    key={match.venue.id}
                    center={[match.venue.lat, match.venue.lng]}
                    radius={match.venue.id === activeMatch?.venue.id ? 10 : 7}
                    pathOptions={{
                      color: match.venue.id === activeMatch?.venue.id ? '#0f172a' : '#ffffff',
                      fillColor:
                        match.confidence >= 75
                          ? '#0f9f78'
                          : match.confidence >= 45
                            ? '#ec8f2d'
                            : '#d84f4f',
                      fillOpacity: 0.9,
                      weight: 2,
                    }}
                    eventHandlers={{
                      click: () => setActiveVenueId(match.venue.id),
                    }}
                  >
                    <Popup>
                      <strong>{match.venue.name}</strong>
                      <br />
                      {match.venue.address}
                    </Popup>
                  </CircleMarker>
                )
              })}
              {photo.coords ? (
                <CircleMarker
                  center={[photo.coords.latitude, photo.coords.longitude]}
                  radius={6}
                  pathOptions={{
                    color: '#0f172a',
                    fillColor: '#ffffff',
                    fillOpacity: 1,
                    weight: 3,
                  }}
                >
                  <Popup>
                    <strong>Uploaded photo GPS</strong>
                    <br />
                    {photo.coords.latitude.toFixed(5)}, {photo.coords.longitude.toFixed(5)}
                  </Popup>
                </CircleMarker>
              ) : null}
            </MapContainer>
          </div>

          <div className="results-head">
            <div>
              <span className="eyebrow">Guesses to confirm</span>
              <h2>
                {photo.analysis
                  ? `${matches.length} venue guesses`
                  : photo.coords
                    ? `${matches.length} nearby candidates`
                    : 'No results yet'}
              </h2>
            </div>
            <span className="freshness">
              {photo.analysis
                ? 'Confirm the name/location before trusting it'
                : photo.coords
                  ? 'GPS-ranked against verified venues'
                  : 'Waiting for photo analysis'}
            </span>
          </div>

          {photo.analysis && matches.length ? (
            <p className="guess-disclaimer">
              These are guesses from the uploaded photo and public evidence. If the top venue is
              wrong, use this list to confirm which candidates were tried.
            </p>
          ) : null}

          {matches.length ? (
            <div className="results-grid">
              {matches.map((match, index) => {
                const feedback = feedbackByVenueId[match.venue.id]

                return (
                  <article
                    className={[
                      'result-card',
                      match.venue.id === activeMatch?.venue.id ? 'active' : '',
                      feedback?.vote ? `feedback-${feedback.vote}` : '',
                    ].join(' ').trim()}
                    key={match.venue.id}
                    onClick={() => setActiveVenueId(match.venue.id)}
                  >
                    <div className="result-top">
                      <div>
                        <span className="category">{match.venue.category}</span>
                        <h3>{match.venue.name}</h3>
                      </div>
                      <div className="score">
                        <span>{confidenceLabel(match.confidence)}</span>
                        <strong>{match.confidence || '--'}%</strong>
                      </div>
                    </div>

                    <p className="address">
                      <MapPin size={15} />
                      {venueLocationLabel(match.venue)}
                    </p>

                    <div className="signature-list">
                      {match.venue.signature.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>

                    <div className="feedback-panel" aria-label={`Feedback for ${match.venue.name}`}>
                      <span>{feedback ? feedbackLabel(feedback) : 'Was this it?'}</span>
                      <div className="feedback-buttons">
                        <button
                          className={[
                            'heart-button',
                            'heart-correct',
                            feedback?.vote === 'correct' ? 'selected' : '',
                          ].join(' ').trim()}
                          type="button"
                          aria-label={`Mark ${match.venue.name} correct`}
                          disabled={feedback?.status === 'saving'}
                          onClick={(event) => {
                            event.stopPropagation()
                            void submitGuessFeedback(match, 'correct', index + 1)
                          }}
                        >
                          <span aria-hidden="true">💗</span>
                        </button>
                        <button
                          className={[
                            'heart-button',
                            'heart-wrong',
                            feedback?.vote === 'incorrect' ? 'selected broken' : '',
                          ].join(' ').trim()}
                          type="button"
                          aria-label={`Mark ${match.venue.name} incorrect`}
                          disabled={feedback?.status === 'saving'}
                          onClick={(event) => {
                            event.stopPropagation()
                            void submitGuessFeedback(match, 'incorrect', index + 1)
                          }}
                        >
                          <span aria-hidden="true">💔</span>
                        </button>
                        {feedback ? (
                          <button
                            className="undo-feedback"
                            type="button"
                            aria-label={`Undo feedback for ${match.venue.name}`}
                            disabled={feedback.status === 'saving'}
                            onClick={(event) => {
                              event.stopPropagation()
                              void undoGuessFeedback(match, index + 1)
                            }}
                          >
                            Undo
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <ul className="reason-list">
                      <li className="reason-heading">Why this guess</li>
                      {match.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                      {match.rankingNotes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>

                    {photo.analysis?.webEvidence?.length ? (
                      <div className="evidence-sources" aria-label="Supporting web evidence">
                        <span>Evidence checked</span>
                        {photo.analysis.webEvidence.slice(0, 3).map((page) => (
                          <a key={page.url} href={page.url} target="_blank" rel="noreferrer">
                            {page.searchLabel ? `${page.searchLabel}: ` : ''}
                            {page.source}
                            <ArrowUpRight size={12} />
                          </a>
                        ))}
                      </div>
                    ) : null}

                    <div className="card-links">
                      <a href={match.venue.sourceUrl} target="_blank" rel="noreferrer">
                        Evidence
                        <ArrowUpRight size={14} />
                      </a>
                      <a href={match.venue.mapsUrl} target="_blank" rel="noreferrer">
                        {hasVerifiedCoordinates(match.venue) ? 'Map' : 'Search Maps'}
                        <ArrowUpRight size={14} />
                      </a>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : photo.status === 'reading' ? (
            <section className="analysis-panel" aria-live="polite" aria-label="Analysis in progress">
              <div className="analysis-orbit" aria-hidden="true">
                <Search size={28} />
              </div>
              <h3>Analyzing and searching</h3>
              <p>
                Checking the uploaded image, interior details, public photo pages, and SF web
                evidence. This can take a moment.
              </p>
              <div className="analysis-steps">
                {analysisSteps.map((step) => (
                  <span key={step}>
                    <LoaderCircle size={14} />
                    {step}
                  </span>
                ))}
              </div>
            </section>
          ) : (
            <section className="waiting-results">
              <Camera size={26} />
              <h3>Results will appear here</h3>
              <p>
                Once a photo is analyzed, this area shows ranked venue matches, evidence, source
                links, and the map view.
              </p>
            </section>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
