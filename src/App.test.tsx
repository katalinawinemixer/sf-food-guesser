import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('exifr', () => ({
  gps: vi.fn(async () => undefined),
}))

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }: { children?: ReactNode }) => (
    <div data-testid="circle-marker">{children}</div>
  ),
  MapContainer: ({ children }: { children?: ReactNode }) => (
    <div aria-label="Venue map">{children}</div>
  ),
  Popup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
}))

describe('SF Food Guesser photo flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders as a photo-first app without typed text-entry UI', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Find the place from a photo' })).toBeVisible()
    expect(screen.getByText('Drop image here or choose')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Identify restaurant' })).toBeDisabled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Start with typed text/i)).not.toBeInTheDocument()
  })

  it('enables identification after selecting an image and renders vision-ranked results', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: 'A square slice of clam pizza on a paper plate.',
            imageEvidence: ['square pizza', 'clam slice', 'counter service'],
            candidates: [
              {
                id: 'golden-boy',
                confidence: 91,
                reasons: ['The image shows a square focaccia-style pizza slice.'],
              },
            ],
            needsMoreEvidence: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    render(<App />)

    const file = new File(['fake image bytes'], 'pizza.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop image here or choose/i), {
      target: { files: [file] },
    })

    const identifyButton = screen.getByRole('button', { name: 'Identify restaurant' })
    await waitFor(() => {
      expect(identifyButton).toBeEnabled()
    })
    fireEvent.click(identifyButton)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Golden Boy Pizza', level: 3 })).toBeVisible()
    })

    const photoRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined
    expect(photoRequest?.body).toBeInstanceOf(FormData)
    const photoForm = photoRequest?.body as FormData
    expect(photoForm.has('photo')).toBe(true)
    expect(photoForm.has('venues')).toBe(true)
    expect(photoForm.has('clue')).toBe(false)
    expect(photoForm.has('text')).toBe(false)
    expect(photoForm.has('description')).toBe(false)

    expect(screen.getByText(/Analyzed photo: A square slice/i)).toBeVisible()
    expect(screen.getByText('square pizza')).toBeVisible()
    expect(screen.getAllByText('91%')[0]).toBeVisible()
    expect(screen.getByText(/The image shows a square focaccia-style pizza slice/i)).toBeVisible()
  })

  it('accepts an image dropped directly onto the upload zone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    const file = new File(['fake image bytes'], 'latte.png', { type: 'image/png' })
    const uploadZone = screen.getByText(/Drop image here or choose/i).closest('label')
    expect(uploadZone).not.toBeNull()

    fireEvent.drop(uploadZone as HTMLLabelElement, {
      dataTransfer: {
        files: [file],
      },
    })

    expect(screen.getByAltText('latte.png')).toBeVisible()
    expect(screen.getByText(/Photo loaded/i)).toBeVisible()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identify restaurant' })).toBeEnabled()
    })
  })

  it('shows visible analysis progress while the photo request is running', async () => {
    let resolveAnalysis: (response: Response) => void = () => {}
    const analysisResponse = new Promise<Response>((resolve) => {
      resolveAnalysis = resolve
    })

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockReturnValueOnce(analysisResponse)

    render(<App />)

    const file = new File(['fake image bytes'], 'interior.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop image here or choose/i), {
      target: { files: [file] },
    })

    const identifyButton = screen.getByRole('button', { name: 'Identify restaurant' })
    await waitFor(() => {
      expect(identifyButton).toBeEnabled()
    })
    fireEvent.click(identifyButton)

    expect(await screen.findByLabelText('Analyzing uploaded photo')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Identifying...' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: 'Analyzing and searching' })).toBeVisible()
    expect(screen.getByText('Searching interiors and photo pages')).toBeVisible()

    resolveAnalysis(
      new Response(
        JSON.stringify({
          summary: 'A room with tile and a pastry case.',
          imageEvidence: ['tile wall', 'pastry case'],
          candidates: [
            {
              id: '',
              name: 'Hidden Tile Cafe',
              category: 'Cafe',
              neighborhood: 'Mission',
              address: '123 Valencia St',
              confidence: 81,
              evidenceType: 'interior',
              reasons: ['Interior photo evidence matched the tile wall.'],
              sourceUrls: ['https://example.com/hidden-tile-cafe'],
            },
          ],
          needsMoreEvidence: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hidden Tile Cafe', level: 3 })).toBeVisible()
    })
  })

  it('renders web-discovered candidates that are not in the seed venue list', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: 'A tiny cafe counter with a blue cup and pastry case.',
            imageEvidence: ['blue cup', 'pastry case'],
            candidates: [
              {
                id: '',
                name: 'Hidden Blue Cup Cafe',
                category: 'Cafe',
                neighborhood: 'Mission',
                address: '123 Valencia St',
                confidence: 83,
                evidenceType: 'interior',
                reasons: ['Web search matched the blue cup and pastry case.'],
                sourceUrls: ['https://example.com/hidden-blue-cup'],
                mapsQuery: 'Hidden Blue Cup Cafe 123 Valencia St San Francisco',
                searchQueries: ['San Francisco cafe blue cup pastry case interior'],
              },
            ],
            needsMoreEvidence: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    render(<App />)

    const file = new File(['fake image bytes'], 'cafe.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop image here or choose/i), {
      target: { files: [file] },
    })

    const identifyButton = screen.getByRole('button', { name: 'Identify restaurant' })
    await waitFor(() => {
      expect(identifyButton).toBeEnabled()
    })
    fireEvent.click(identifyButton)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hidden Blue Cup Cafe', level: 3 })).toBeVisible()
    })

    expect(screen.getAllByText('123 Valencia St · Mission')[0]).toBeVisible()
    expect(screen.getByText('interior evidence')).toBeVisible()
    expect(screen.getByText('Web-discovered match')).toBeVisible()
    expect(screen.getByText(/Web search matched/)).toBeVisible()
  })

  it('keeps identification disabled when the OpenAI key is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, visionEnabled: false, model: 'test-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    expect(await screen.findByText(/needs OPENROUTER_API_KEY or OPENAI_API_KEY/i)).toBeVisible()

    const file = new File(['fake image bytes'], 'latte.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop image here or choose/i), {
      target: { files: [file] },
    })

    expect(screen.getByRole('button', { name: 'Identify restaurant' })).toBeDisabled()
  })
})
