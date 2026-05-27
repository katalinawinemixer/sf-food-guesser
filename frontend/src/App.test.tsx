import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('exifr', () => ({
  gps: vi.fn(async () => undefined),
}))

describe('SF Food Guesser photo flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders as a photo-first app without typed text-entry UI', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Spotted in SF' })).toBeVisible()
    expect(screen.getByText('Drop a food photo here')).toBeVisible()
    expect(screen.queryByText('No results yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Results will appear here')).not.toBeInTheDocument()
    expect(screen.queryByText('Upload a photo to start')).not.toBeInTheDocument()
    expect(screen.queryByText('Drop in a food photo')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Identify restaurant' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Start with typed text/i)).not.toBeInTheDocument()
  })

  it('shows clear upload validation messages before submitting to the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(<App />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const textFile = new File(['not a photo'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(fileInput, {
      target: { files: [textFile] },
    })

    expect(await screen.findByText(/Unsupported image type/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Identify restaurant' })).toBeDisabled()

    const largeFile = new File([new Uint8Array(12 * 1024 * 1024 + 1)], 'large.jpg', {
      type: 'image/jpeg',
    })
    fireEvent.change(fileInput, {
      target: { files: [largeFile] },
    })

    expect(await screen.findByText(/Upload an image under 12 MB/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows rate-limit messages returned by the analysis API', async () => {
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
            error:
              'OpenRouter is rate limiting photo analysis. Wait a bit, then try the upload again.',
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    render(<App />)

    const file = new File(['fake image bytes'], 'latte.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Identify restaurant' }))

    expect(await screen.findByText(/rate limiting photo analysis/i)).toBeVisible()
  })

  it('transcodes AVIF uploads to JPEG before sending them to analysis', async () => {
    const closeBitmap = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 12, height: 8, close: closeBitmap })),
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      fillRect: vi.fn(),
      fillStyle: '#ffffff',
      filter: 'none',
      restore: vi.fn(),
      save: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback: BlobCallback) => {
        callback(new Blob(['jpeg bytes'], { type: 'image/jpeg' }))
      },
    )
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
            runId: 'run-avif',
            summary: 'A Souvla tray with blue-rim plates.',
            imageEvidence: ['blue-rim plates'],
            candidates: [
              {
                id: '',
                name: 'Souvla',
                confidence: 82,
                reasons: ['The plates and food match Souvla.'],
              },
            ],
            needsMoreEvidence: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    render(<App />)

    const file = new File(['avif bytes'], 'souvla.jpg.avif', { type: 'image/avif' })
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
      target: { files: [file] },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Identify restaurant' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Souvla', level: 3 })).toBeVisible()
    })

    const photoRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined
    const photoForm = photoRequest?.body as FormData
    const uploadedPhoto = photoForm.get('photo') as File
    const ocrPhoto = photoForm.get('ocrPhoto') as File
    expect(uploadedPhoto.name).toBe('souvla.jpg')
    expect(uploadedPhoto.type).toBe('image/jpeg')
    expect(ocrPhoto.name).toBe('souvla-ocr-contact-sheet.jpg')
    expect(ocrPhoto.type).toBe('image/jpeg')
    expect(drawImage).toHaveBeenCalled()
    expect(closeBitmap).toHaveBeenCalled()
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
            runId: 'run-1',
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, id: 'feedback-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, id: 'feedback-2' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    render(<App />)

    const file = new File(['fake image bytes'], 'pizza.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
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
    expect(photoRequest?.credentials).toBe('include')
    const photoForm = photoRequest?.body as FormData
    expect(photoForm.has('photo')).toBe(true)
    expect(photoForm.has('venues')).toBe(true)
    expect(photoForm.has('clue')).toBe(false)
    expect(photoForm.has('text')).toBe(false)
    expect(photoForm.has('description')).toBe(false)
    const sentVenues = JSON.parse(String(photoForm.get('venues')))
    expect(sentVenues.find((venue: { id: string }) => venue.id === 'souvla')).toMatchObject({
      visualClues: expect.arrayContaining(['readable Souvla text']),
      menuClues: expect.arrayContaining(['souvlaki']),
      doNotInferFrom: expect.arrayContaining(['generic Greek food alone']),
      multiLocation: true,
      sourceConfidence: 'source-backed',
    })

    expect(screen.getByText(/Analyzed photo: A square slice/i)).toBeVisible()
    expect(screen.getAllByText('Best supported match')[0]).toBeVisible()
    expect(screen.getByText('square pizza')).toBeVisible()
    expect(screen.getAllByText('91%')[0]).toBeVisible()
    expect(screen.getByText(/The image shows a square focaccia-style pizza slice/i)).toBeVisible()

    fireEvent.click(screen.getByLabelText('Mark Golden Boy Pizza correct'))

    await waitFor(() => {
      expect(screen.getByText('Marked correct')).toBeVisible()
    })

    const feedbackRequest = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/feedback')
    expect(feedbackRequest?.method).toBe('POST')
    expect(JSON.parse(String(feedbackRequest?.body))).toMatchObject({
      runId: 'run-1',
      vote: 'correct',
      rank: 1,
      candidate: {
        id: 'golden-boy',
        name: 'Golden Boy Pizza',
        confidence: 91,
      },
      analysis: {
        summary: 'A square slice of clam pizza on a paper plate.',
      },
    })

    const wrongButton = screen.getByLabelText('Mark Golden Boy Pizza incorrect')
    fireEvent.click(wrongButton)

    await waitFor(() => {
      expect(screen.getByText('Marked incorrect')).toBeVisible()
    })
    expect(wrongButton).toHaveClass('broken')
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toMatchObject({
      vote: 'incorrect',
      rank: 1,
      candidate: {
        name: 'Golden Boy Pizza',
      },
    })
  })

  it('allows another photo analysis after a completed run', async () => {
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
            runId: 'run-1',
            summary: 'An iced matcha in a cafe.',
            imageEvidence: ['iced matcha'],
            candidates: [
              {
                id: 'kissaten-hifi',
                confidence: 88,
                reasons: ['The drink and interior match.'],
              },
            ],
            needsMoreEvidence: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-2',
            summary: 'A second iced matcha in the same cafe.',
            imageEvidence: ['iced matcha', 'espresso bar'],
            candidates: [
              {
                id: 'kissaten-hifi',
                confidence: 91,
                reasons: ['The drink and espresso bar match.'],
              },
            ],
            needsMoreEvidence: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    render(<App />)

    const file = new File(['fake image bytes'], 'matcha.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
      target: { files: [file] },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Identify restaurant' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Kissaten HiFi', level: 3 })).toBeVisible()
    })
    expect(screen.getByText(/Analyzed photo: An iced matcha/i)).toBeVisible()
    expect(screen.queryByText(/limit reached/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Identify restaurant' }))

    expect(await screen.findByText(/Analyzed photo: A second iced matcha/i)).toBeVisible()
    expect(screen.queryByText(/one photo analysis/i)).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
    const uploadZone = screen.getByText(/Drop a food photo here/i).closest('label')
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

  it('marks sibling guesses incorrect when one guess is confirmed and supports undo', async () => {
    const feedbackBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === '/api/health') {
        return new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (input === '/api/analyze-photo') {
        return new Response(
          JSON.stringify({
            runId: 'run-cascade',
            summary: 'A burger and fries on a scalloped plate.',
            imageEvidence: ['burger', 'scalloped plate'],
            candidates: [
              {
                id: '',
                name: 'RT Bistro',
                category: 'Restaurant',
                neighborhood: 'Hayes Valley',
                address: '205 Oak St',
                confidence: 72,
                reasons: ['Burger and plate match.'],
                sourceUrls: ['https://example.com/rt-bistro'],
              },
              {
                id: '',
                name: 'Maillards',
                category: 'Restaurant',
                neighborhood: 'Outer Sunset',
                address: '3821 Noriega St',
                confidence: 68,
                reasons: ['Burger and fries match.'],
                sourceUrls: ['https://example.com/maillards'],
              },
              {
                id: '',
                name: 'Goldenette',
                category: 'Restaurant',
                neighborhood: 'San Francisco',
                address: 'Address not confirmed',
                confidence: 58,
                reasons: ['Diner-style burger match.'],
                sourceUrls: ['https://example.com/goldenette'],
              },
            ],
            needsMoreEvidence: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (input === '/api/feedback') {
        feedbackBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ ok: true, id: `feedback-${feedbackBodies.length}` }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected request: ${String(input)}`)
    })

    render(<App />)

    const file = new File(['fake image bytes'], 'burger.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
      target: { files: [file] },
    })

    const identifyButton = screen.getByRole('button', { name: 'Identify restaurant' })
    await waitFor(() => {
      expect(identifyButton).toBeEnabled()
    })
    fireEvent.click(identifyButton)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'RT Bistro', level: 3 })).toBeVisible()
    })

    fireEvent.click(screen.getByLabelText('Mark RT Bistro correct'))

    await waitFor(() => {
      expect(screen.getByText('Marked correct')).toBeVisible()
      expect(screen.getAllByText('Auto-marked incorrect')).toHaveLength(2)
    })
    expect(feedbackBodies.slice(0, 3).map((body) => body.vote)).toEqual([
      'correct',
      'incorrect',
      'incorrect',
    ])
    expect(feedbackBodies[0]).toMatchObject({ runId: 'run-cascade', rank: 1 })
    expect(feedbackBodies[1]).toMatchObject({ runId: 'run-cascade', rank: 2 })
    expect(feedbackBodies[2]).toMatchObject({ runId: 'run-cascade', rank: 3 })

    fireEvent.click(screen.getByLabelText('Undo feedback for RT Bistro'))

    await waitFor(() => {
      expect(screen.getAllByText('Was this it?')).toHaveLength(3)
    })
    expect(feedbackBodies.slice(3).map((body) => body.vote)).toEqual(['undo', 'undo', 'undo'])
  })

  it('does not crown a top match on tied guesses and records unverified correction suggestions', async () => {
    const feedbackBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === '/api/health') {
        return new Response(JSON.stringify({ ok: true, visionEnabled: true, model: 'test-model' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (input === '/api/analyze-photo') {
        return new Response(
          JSON.stringify({
            runId: 'run-tied',
            summary: 'A matcha drink in a cafe with no readable text.',
            imageEvidence: ['matcha drink', 'brown aprons'],
            candidates: [
              {
                id: '',
                name: 'Wrong Cafe One',
                category: 'Cafe',
                neighborhood: 'Mission',
                address: 'Address not confirmed',
                confidence: 78,
                reasons: ['General matcha visual match.'],
              },
              {
                id: '',
                name: 'Wrong Cafe Two',
                category: 'Cafe',
                neighborhood: 'Richmond',
                address: 'Address not confirmed',
                confidence: 78,
                reasons: ['General interior visual match.'],
              },
              {
                id: '',
                name: 'Wrong Cafe Three',
                category: 'Cafe',
                neighborhood: 'SoMa',
                address: 'Address not confirmed',
                confidence: 78,
                reasons: ['General cafe visual match.'],
              },
            ],
            needsMoreEvidence: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (input === '/api/feedback') {
        feedbackBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ ok: true, id: `feedback-${feedbackBodies.length}` }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected request: ${String(input)}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
      target: { files: [new File(['fake image bytes'], 'matcha.png', { type: 'image/png' })] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Identify restaurant' }))

    expect(await screen.findByText(/too close to call/i)).toBeVisible()
    expect(screen.queryByText('Top match')).not.toBeInTheDocument()
    expect(screen.getAllByText('Needs confirmation')).toHaveLength(4)
    expect(screen.queryByText('Identity clue')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Mark Wrong Cafe One incorrect'))
    fireEvent.click(screen.getByLabelText('Mark Wrong Cafe Two incorrect'))
    fireEvent.click(screen.getByLabelText('Mark Wrong Cafe Three incorrect'))

    expect(await screen.findByRole('heading', { name: 'Add the correct place' })).toBeVisible()
    fireEvent.change(screen.getByLabelText('Place name'), {
      target: { value: 'Kissaten Hi-Fi' },
    })
    fireEvent.change(screen.getByLabelText('Neighborhood or address'), {
      target: { value: '189 6th Ave' },
    })
    fireEvent.change(screen.getByLabelText('Anything that proves it'), {
      target: { value: 'The interior and cups match public photos.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit correction' }))

    await waitFor(() => {
      expect(screen.getByText(/Saved as an unverified correction/i)).toBeVisible()
    })
    const correction = feedbackBodies.at(-1)
    expect(correction).toMatchObject({
      runId: 'run-tied',
      vote: 'suggested_answer',
      suggestedVenue: {
        name: 'Kissaten Hi-Fi',
        neighborhoodOrAddress: '189 6th Ave',
      },
    })
    expect(correction?.lineup).toHaveLength(3)
    expect(JSON.stringify(correction)).not.toContain('fake image bytes')
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
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
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
                photoEvidence: ['The uploaded photo shows a blue cup beside a pastry case.'],
                externalEvidence: ['Web search matched the blue cup and pastry case.'],
                rankingRules: ['No readable venue name was visible, so this still needs confirmation.'],
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
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
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

    expect(screen.getAllByText(/123 Valencia St · Mission · Unverified location/)[0]).toBeVisible()
    expect(screen.queryByTestId('circle-marker')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Search Maps/i })[0]).toBeVisible()
    expect(screen.getByText('interior evidence')).toBeVisible()
    expect(screen.getByText('Interior')).toBeVisible()
    expect(screen.getByText('Article')).toBeVisible()
    expect(screen.getByText('Web-discovered match')).toBeVisible()
    expect(screen.getAllByText('Needs confirmation')[0]).toBeVisible()
    expect(screen.queryByText('Identity clue')).not.toBeInTheDocument()
    expect(screen.getByText('From the uploaded photo')).toBeVisible()
    expect(screen.getByText('The uploaded photo shows a blue cup beside a pastry case.')).toBeVisible()
    expect(screen.getByText('External support')).toBeVisible()
    expect(screen.getByText(/Web search matched/)).toBeVisible()
    expect(screen.getByText('Ranking notes')).toBeVisible()
    expect(screen.getByText(/No readable venue name/)).toBeVisible()
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
    fireEvent.change(screen.getByLabelText(/Drop a food photo here/i), {
      target: { files: [file] },
    })

    expect(screen.getByRole('button', { name: 'Identify restaurant' })).toBeDisabled()
  })
})
