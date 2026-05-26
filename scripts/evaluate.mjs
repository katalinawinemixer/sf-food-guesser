import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import request from 'supertest'
import ts from 'typescript'
import { createApp } from '../server.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultDatasetPath = resolve(rootDir, 'evaluation/labeled-photos.json')
const datasetPath = resolve(rootDir, process.argv[2] ?? defaultDatasetPath)

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['&.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function loadVenues() {
  const venueSourcePath = resolve(rootDir, 'src/venues.ts')
  const source = readFileSync(venueSourcePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    transpiled.outputText,
    'utf8',
  ).toString('base64')}`
  const module = await import(moduleUrl)
  return module.venues
}

function loadDataset() {
  if (!existsSync(datasetPath)) {
    throw new Error(
      `Missing dataset at ${datasetPath}. Copy evaluation/labeled-photos.example.json to evaluation/labeled-photos.json and add private labeled cases.`,
    )
  }

  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'))
  const cases = Array.isArray(dataset) ? dataset : dataset.cases
  if (!Array.isArray(cases)) {
    throw new Error('Evaluation dataset must be an array or an object with a cases array.')
  }
  return cases
}

function candidateMatches(candidate, expected) {
  const expectedNames = [expected.name, ...(expected.aliases ?? [])].map(normalize).filter(Boolean)
  const candidateName = normalize(candidate.name)
  return (
    (expected.id && candidate.id === expected.id) ||
    expectedNames.includes(candidateName)
  )
}

function summarizeCase(testCase, body) {
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const topCandidates = candidates.slice(0, 3)
  const top1 = topCandidates[0] ? candidateMatches(topCandidates[0], testCase.expected) : false
  const top3 = topCandidates.some((candidate) => candidateMatches(candidate, testCase.expected))

  return {
    id: testCase.id,
    expected: testCase.expected,
    top1,
    top3,
    needsMoreEvidence: Boolean(body.needsMoreEvidence),
    summary: body.summary ?? '',
    candidates: topCandidates.map((candidate) => ({
      id: candidate.id ?? '',
      name: candidate.name ?? '',
      confidence: candidate.confidence ?? null,
      evidenceType: candidate.evidenceType ?? '',
      reasons: candidate.reasons ?? [],
    })),
  }
}

async function run() {
  const cases = loadDataset()
  const venues = await loadVenues()
  const app = createApp()
  const results = []

  for (const testCase of cases) {
    const imagePath = resolve(rootDir, testCase.imagePath)
    if (!existsSync(imagePath)) {
      results.push({
        id: testCase.id,
        skipped: true,
        reason: `Missing image: ${testCase.imagePath}`,
      })
      continue
    }

    const response = await request(app)
      .post('/api/analyze-photo')
      .attach('photo', imagePath)
      .field('venues', JSON.stringify(venues))

    if (response.status !== 200) {
      results.push({
        id: testCase.id,
        skipped: true,
        reason: `API returned ${response.status}: ${response.body?.error ?? response.text}`,
      })
      continue
    }

    results.push(summarizeCase(testCase, response.body))
  }

  const runnable = results.filter((result) => !result.skipped)
  const top1 = runnable.filter((result) => result.top1).length
  const top3 = runnable.filter((result) => result.top3).length
  const needsMoreEvidence = runnable.filter((result) => result.needsMoreEvidence).length

  const report = {
    dataset: pathToFileURL(datasetPath).pathname,
    totalCases: cases.length,
    runnableCases: runnable.length,
    skippedCases: results.length - runnable.length,
    top1Accuracy: runnable.length ? top1 / runnable.length : 0,
    top3Accuracy: runnable.length ? top3 / runnable.length : 0,
    needsMoreEvidenceRate: runnable.length ? needsMoreEvidence / runnable.length : 0,
    results,
  }

  console.log(JSON.stringify(report, null, 2))

  const outputArgIndex = process.argv.indexOf('--out')
  if (outputArgIndex !== -1 && process.argv[outputArgIndex + 1]) {
    const outPath = resolve(rootDir, process.argv[outputArgIndex + 1])
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  }

  if (runnable.length === 0) {
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
