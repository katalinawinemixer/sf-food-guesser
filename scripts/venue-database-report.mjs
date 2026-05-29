import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { venues } from '../shared/venues.js'

const root = process.cwd()
const outputPath = resolve(root, process.argv[2] || 'data/venue-database-report.json')

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function venueHealth(venue) {
  const issues = []
  if (!venue.sourceUrl || !/^https:\/\//.test(venue.sourceUrl)) issues.push('missing_https_source')
  if (!venue.mapsUrl || !/^https:\/\/www\.google\.com\/maps/.test(venue.mapsUrl)) issues.push('missing_maps_url')
  if (!Array.isArray(venue.signature) || venue.signature.length < 2) issues.push('thin_signature')
  if (!Array.isArray(venue.imageEvidenceHints) || venue.imageEvidenceHints.length < 4) {
    issues.push('thin_image_hints')
  }
  if (venue.multiLocation === true && !String(venue.note || '').match(/confirm|branch|GPS|neighborhood/i)) {
    issues.push('multi_location_without_branch_warning')
  }

  return issues
}

const records = venues.map((venue) => ({
  id: venue.id,
  name: venue.name,
  category: venue.category,
  neighborhood: venue.neighborhood,
  address: venue.address,
  sourceUrl: venue.sourceUrl,
  sourceDomain: sourceDomain(venue.sourceUrl),
  mapsUrl: venue.mapsUrl,
  signatureCount: venue.signature?.length ?? 0,
  imageEvidenceHintCount: venue.imageEvidenceHints?.length ?? 0,
  visualClueCount: venue.visualClues?.length ?? 0,
  menuClueCount: venue.menuClues?.length ?? 0,
  doNotInferFromCount: venue.doNotInferFrom?.length ?? 0,
  multiLocation: venue.multiLocation === true,
  sourceConfidence: venue.sourceConfidence ?? (venue.sourceUrl ? 'source-backed' : 'needs-review'),
  issues: venueHealth(venue),
}))
const sourceDomains = records.reduce((state, record) => {
  if (record.sourceDomain) state[record.sourceDomain] = (state[record.sourceDomain] ?? 0) + 1
  return state
}, {})
const report = {
  generatedAt: new Date().toISOString(),
  venueCount: records.length,
  sourceDomains,
  issueCount: records.reduce((count, record) => count + record.issues.length, 0),
  records,
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)

console.log(`Venue database report written to ${outputPath}`)
console.log(`${report.venueCount} venue(s), ${report.issueCount} issue(s)`)
if (report.issueCount) {
  for (const record of records.filter((entry) => entry.issues.length)) {
    console.log(`- ${record.id}: ${record.issues.join(', ')}`)
  }
}
