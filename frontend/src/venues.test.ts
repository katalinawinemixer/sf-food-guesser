import { describe, expect, it } from 'vitest'
import { venues } from './venues'

describe('verified seed venues', () => {
  it('keeps recently confirmed SF venues in the seed list', () => {
    expect(venues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kissaten-hifi',
          name: 'Kissaten HiFi',
          address: '189 6th Ave',
          imageEvidenceHints: expect.arrayContaining(['matcha', 'vinyl', 'brown coffee bags']),
          visualClues: expect.arrayContaining(['brown coffee bags on shelves', 'tan aprons']),
          menuClues: expect.arrayContaining(['iced matcha', 'mango lassi matcha']),
          doNotInferFrom: expect.arrayContaining(['generic matcha alone']),
          multiLocation: false,
          sourceConfidence: 'source-backed',
        }),
        expect.objectContaining({
          id: 'rt-bistro',
          name: 'RT Bistro',
          address: '205 Oak St',
          imageEvidenceHints: expect.arrayContaining(['caviar', 'burger', 'rich table']),
          menuClues: expect.arrayContaining(['bistro burger', 'caviar']),
          doNotInferFrom: expect.arrayContaining(['caviar word alone', 'generic burger alone']),
        }),
        expect.objectContaining({
          id: 'souvla',
          name: 'Souvla',
          address: 'Multiple San Francisco locations',
          imageEvidenceHints: expect.arrayContaining(['souvla', 'greek key', 'blue rim']),
          visualClues: expect.arrayContaining(['readable Souvla text', 'Greek key tray liner']),
          doNotInferFrom: expect.arrayContaining(['blue-rim plates without visible Souvla text']),
          multiLocation: true,
        }),
      ]),
    )
  })

  it('does not include excluded broad-chain guesses as seed venues', () => {
    expect(venues.some((venue) => /blue bottle/i.test(venue.name))).toBe(false)
  })
})
