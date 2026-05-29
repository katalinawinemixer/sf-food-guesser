import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

Object.defineProperty(URL, 'createObjectURL', {
  value: vi.fn(() => 'blob:test-photo'),
  writable: true,
})

Object.defineProperty(URL, 'revokeObjectURL', {
  value: vi.fn(),
  writable: true,
})

Object.defineProperty(globalThis, 'createImageBitmap', {
  value: vi.fn(async () => ({
    width: 24,
    height: 24,
    close: vi.fn(),
  })),
  configurable: true,
  writable: true,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: vi.fn(() => ({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    set fillStyle(_value: string) {},
    set filter(_value: string) {},
  })),
  configurable: true,
  writable: true,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  value: vi.fn((callback: BlobCallback) => {
    callback(new Blob(['mock jpeg bytes'], { type: 'image/jpeg' }))
  }),
  configurable: true,
  writable: true,
})
