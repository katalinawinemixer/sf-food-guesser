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
import { categoryOptions, venues, type VenueCategory } from './venues'

type VisionCandidate = {
  id: string
  name?: string
  category?: VenueCategory | string
  neighborhood?: string
  address?: string
  confidence: number
  evidenceType?: string
  reasons: string[]
  sourceUrls?: string[]
  mapsQuery?: string
  searchQueries?: string[]
}

type VisionAnalysis = {
  summary: string
  imageEvidence: string[]
  candidates: VisionCandidate[]
  needsMoreEvidence: boolean
  searchProvider?: string | null
  webSearchProvider?: string | null
  photoEvidence?: Array<{
    title: string
    source: string
    pageUrl?: string
    thumbnailUrl?: string
    query?: string
  }>
  webEvidence?: Array<{
    title: string
    source: string
    url: string
    snippet?: string
    query?: string
    searchLabel?: string
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

type ApiHealth = {
  status: 'checking' | 'ready' | 'missing-key' | 'offline'
  model?: string
  message?: string
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
        venue,
        distanceMeters: distance,
        score: proximityScore,
        confidence: distanceConfidence,
        reasons: [`Photo GPS is ${formatDistance(distance)} from this venue.`],
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
        venue,
        distanceMeters: distance,
        score: (candidate?.confidence ?? 0) * 2 + gpsBoost,
        confidence,
        reasons: [
          ...visionReasons,
          ...(distance !== undefined ? [`Photo GPS is ${formatDistance(distance)} away.`] : []),
        ].slice(0, 4),
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
          lat: 37.7749,
          lng: -122.4194,
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
        reasons: candidate.reasons.slice(0, 4),
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

const analysisSteps = [
  'Reading image details',
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

  const response = await fetch('/api/analyze-photo', {
    method: 'POST',
    body: payload,
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.error ?? 'Photo analysis failed.')
  }

  return {
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
            confidence: Number(candidate.confidence ?? 0),
            evidenceType: candidate.evidenceType ? String(candidate.evidenceType) : undefined,
            reasons: Array.isArray(candidate.reasons)
              ? candidate.reasons.map(String).slice(0, 4)
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
    photoEvidence: Array.isArray(result.photoEvidence)
      ? result.photoEvidence
          .map((photo: Record<string, unknown>) => ({
            title: String(photo.title ?? 'Candidate photo'),
            source: String(photo.source ?? 'Photo search'),
            pageUrl: photo.pageUrl ? String(photo.pageUrl) : undefined,
            thumbnailUrl: photo.thumbnailUrl ? String(photo.thumbnailUrl) : undefined,
            query: photo.query ? String(photo.query) : undefined,
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
  }
}

function App() {
  const [category, setCategory] = useState<'All' | VenueCategory>('All')
  const [activeVenueId, setActiveVenueId] = useState<string | null>(null)
  const [photo, setPhoto] = useState<PhotoState>({ status: 'empty' })
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false)
  const [apiHealth, setApiHealth] = useState<ApiHealth>({ status: 'checking' })

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
        const response = await fetch('/api/health')
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

    const previewUrl = URL.createObjectURL(file)
    setPhotoFile(file)
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
    const file = Array.from(event.dataTransfer.files).find((droppedFile) =>
      droppedFile.type.startsWith('image/'),
    )
    handlePhotoFile(file)
  }

  async function submitPhoto() {
    if (!photoFile || !photo.previewUrl) return

    setPhoto({
      status: 'reading',
      name: photoFile.name,
      previewUrl: photo.previewUrl,
      message: 'Analyzing this photo for image evidence...',
    })

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
              className={`upload-zone ${photo.previewUrl ? 'has-image' : ''} ${
                isDraggingPhoto ? 'dragging' : ''
              }`}
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

            {photo.analysis && (photo.analysis.webEvidence?.length || photo.analysis.photoEvidence?.length) ? (
              <div className="search-trail" aria-label="Search evidence trail">
                <div className="search-trail-head">
                  <Search size={15} />
                  <span>Search trail</span>
                </div>
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
                  Maps
                </a>
                <a href={activeMatch.venue.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} />
                  Source
                </a>
              </div>
            </section>
          ) : (
            <section className="active-card empty-active" aria-live="polite">
              <div className="active-meta">
                <span>Ready</span>
              </div>
              <h2>Upload a photo</h2>
              <p>The app will analyze the image, search broadly for matching SF food spots, and return likely restaurants, cafes, bakeries, or counters.</p>
            </section>
          )}
        </aside>

        <section className="main-panel">
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
              {matches.map((match) => (
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
              ))}
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
              <span className="eyebrow">Photo results</span>
              <h2>
                {photo.analysis
                  ? `${matches.length} photo candidates`
                  : photo.coords
                  ? `${matches.length} nearby candidates`
                  : 'Upload a photo to start'}
              </h2>
            </div>
            <span className="freshness">
              {photo.analysis
                ? 'Vision-ranked with live web discovery'
                : photo.coords
                  ? 'GPS-ranked against verified venues'
                  : 'Photo-only identification'}
            </span>
          </div>

          {matches.length ? (
            <div className="results-grid">
              {matches.map((match) => (
              <article
                className={`result-card ${
                  match.venue.id === activeMatch?.venue.id ? 'active' : ''
                }`}
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
                  {match.venue.address} · {match.venue.neighborhood}
                </p>

                <div className="signature-list">
                  {match.venue.signature.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>

                <ul className="reason-list">
                  <li className="reason-heading">Why this guess</li>
                  {match.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
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
                    Map
                    <ArrowUpRight size={14} />
                  </a>
                </div>
              </article>
              ))}
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
            <section className="empty-results">
              <Camera size={26} />
              <h3>Drop in a food photo</h3>
              <p>
                The app analyzes the image itself, checks any embedded GPS metadata, and returns
                the most likely venue from live web discovery and the verified SF seed dataset.
              </p>
            </section>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
