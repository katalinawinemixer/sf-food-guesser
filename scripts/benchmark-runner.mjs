import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const root = process.cwd()
const args = new Set(process.argv.slice(2))
const manifestPath = resolve(root, process.argv.find((arg) => arg.endsWith('.json')) || 'benchmarks/manifest.json')
const apiBaseArg = process.argv.find((arg) => arg.startsWith('--api='))
const apiBaseUrl = (apiBaseArg?.split('=')[1] || process.env.SF_FOOD_BENCHMARK_API || 'http://127.0.0.1:5174').replace(/\/$/, '')
const strict = args.has('--strict')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function extractVenues() {
  const source = readFileSync(resolve(root, 'frontend/src/venues.ts'), 'utf8')
  const start = source.indexOf('export const venues')
  const equals = source.indexOf('=', start)
  const arrayStart = source.indexOf('[', equals)
  let depth = 0
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
    if (depth === 0) {
      const literal = source.slice(arrayStart, index + 1)
      return Function(`"use strict"; return (${literal});`)()
    }
  }
  throw new Error('Could not extract venues from frontend/src/venues.ts')
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

async function fileFromPath(path) {
  const bytes = readFileSync(path)
  return new File([bytes], basename(path), { type: 'image/jpeg' })
}

async function runCase(testCase, venues) {
  const imagePath = resolve(root, testCase.imagePath)
  if (!existsSync(imagePath)) {
    return {
      id: testCase.id,
      expectedVenue: testCase.expectedVenue,
      status: 'skipped_missing_image',
      imagePath: testCase.imagePath,
    }
  }

  const payload = new FormData()
  payload.append('photo', await fileFromPath(imagePath))
  payload.append('venues', JSON.stringify(venues))

  const response = await fetch(`${apiBaseUrl}/api/analyze-photo`, {
    method: 'POST',
    body: payload,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    return {
      id: testCase.id,
      expectedVenue: testCase.expectedVenue,
      status: 'failed_request',
      error: body.error || response.statusText,
    }
  }

  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const expectedName = normalizeName(testCase.expectedVenue)
  const foundIndex = expectedName
    ? candidates.findIndex((candidate) => normalizeName(candidate.name).includes(expectedName))
    : -1
  const status = expectedName
    ? foundIndex === 0
      ? 'rank_1'
      : foundIndex > 0
        ? 'present_lower_rank'
        : 'missing'
    : body.needsMoreEvidence
      ? 'uncertain_as_expected'
      : 'negative_control_needs_review'

  return {
    id: testCase.id,
    expectedVenue: testCase.expectedVenue,
    status,
    rank: foundIndex >= 0 ? foundIndex + 1 : null,
    topCandidate: candidates[0]?.name || null,
    topConfidence: candidates[0]?.confidence ?? null,
    candidates: candidates.slice(0, 3).map((candidate, index) => ({
      rank: index + 1,
      name: candidate.name,
      confidence: candidate.confidence,
      evidenceCategories: candidate.evidenceCategories ?? [],
    })),
    needsMoreEvidence: body.needsMoreEvidence === true,
  }
}

const manifest = readJson(manifestPath)
const venues = extractVenues()
const startedAt = new Date().toISOString()
const results = []

for (const testCase of manifest.cases ?? []) {
  results.push(await runCase(testCase, venues))
}

const summary = results.reduce((state, result) => {
  state[result.status] = (state[result.status] || 0) + 1
  return state
}, {})
const report = {
  startedAt,
  apiBaseUrl,
  manifest: manifestPath,
  summary,
  results,
}
const outputPath = resolve(root, 'data/benchmark-runs', `${startedAt.replace(/[:.]/g, '-')}.json`)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(`Benchmark report written to ${outputPath}`)
console.log(JSON.stringify(summary, null, 2))

const failures = results.filter((result) => ['missing', 'failed_request'].includes(result.status))
if (strict && failures.length) {
  process.exitCode = 1
}
