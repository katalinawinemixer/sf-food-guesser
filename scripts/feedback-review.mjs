import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const feedbackPath = resolve(process.cwd(), process.argv[2] || 'data/feedback.jsonl')

function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`Could not parse ${path}:${index + 1}: ${error.message}`)
      }
    })
}

function candidateName(record) {
  return record?.candidate?.name || record?.suggestedVenue?.name || 'Unknown'
}

function classifyRun(records) {
  const activeRecords = records.filter((record) => record.vote !== 'undo')
  const correct = activeRecords.filter((record) => record.vote === 'correct')
  const incorrect = activeRecords.filter((record) => record.vote === 'incorrect')
  const suggestions = activeRecords.filter((record) => record.vote === 'suggested_answer')
  const lineup = activeRecords.find((record) => Array.isArray(record.lineup) && record.lineup.length)?.lineup ?? []
  const lineupSize = lineup.length || new Set(activeRecords.map((record) => record.candidate?.id || record.candidate?.name).filter(Boolean)).size

  if (suggestions.length > 0) {
    return {
      type: 'missing_candidate_suggested',
      summary: `User suggested ${suggestions.map((record) => record.suggestedVenue?.name).filter(Boolean).join(', ') || 'a missing venue'}.`,
    }
  }

  if (correct.length > 0) {
    const bestCorrectRank = Math.min(...correct.map((record) => Number(record.rank || Infinity)))
    const lowerRankWrong = incorrect.some((record) => Number(record.rank || Infinity) < bestCorrectRank)
    if (bestCorrectRank > 1 || lowerRankWrong) {
      return {
        type: 'ranking_calibration_failure',
        summary: `${candidateName(correct[0])} was correct at rank ${bestCorrectRank}; a higher-ranked guess was wrong.`,
      }
    }
    return {
      type: 'confirmed_top_match',
      summary: `${candidateName(correct[0])} was confirmed at rank 1.`,
    }
  }

  if (lineupSize > 0 && incorrect.length >= lineupSize) {
    return {
      type: 'all_wrong_no_suggestion',
      summary: 'All visible candidates were marked incorrect, but no correction was submitted.',
    }
  }

  if (incorrect.length > 0) {
    return {
      type: 'partial_negative_feedback',
      summary: `${incorrect.length} candidate(s) were marked incorrect.`,
    }
  }

  return {
    type: 'unclassified',
    summary: 'No actionable saved feedback.',
  }
}

function groupByRun(records) {
  const groups = new Map()
  const orderedRecords = [...records].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  let missingRunCluster = 0
  let previousMissingRunTime = 0

  for (const record of orderedRecords) {
    let runId = record.runId
    if (!runId) {
      const createdAtMs = Date.parse(record.createdAt || '')
      const isNewCluster =
        !previousMissingRunTime ||
        !Number.isFinite(createdAtMs) ||
        createdAtMs - previousMissingRunTime > 30_000
      if (isNewCluster) missingRunCluster += 1
      previousMissingRunTime = Number.isFinite(createdAtMs) ? createdAtMs : previousMissingRunTime
      runId = `missing-run-id:${missingRunCluster}`
    }

    if (!groups.has(runId)) groups.set(runId, [])
    groups.get(runId).push(record)
  }
  return [...groups.entries()].map(([runId, runRecords]) => ({
    runId,
    records: runRecords.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  }))
}

const records = readJsonl(feedbackPath)
const reviewedRuns = groupByRun(records).map((run) => ({
  ...run,
  classification: classifyRun(run.records),
}))
const counts = reviewedRuns.reduce((state, run) => {
  state[run.classification.type] = (state[run.classification.type] ?? 0) + 1
  return state
}, {})

const actionableRuns = reviewedRuns
  .filter((run) => !['confirmed_top_match', 'unclassified'].includes(run.classification.type))
  .slice(-12)
  .reverse()

console.log(`Feedback review: ${records.length} record(s), ${reviewedRuns.length} run(s)`)
console.log('')
console.log('Run classifications:')
for (const [type, count] of Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`- ${type}: ${count}`)
}

if (actionableRuns.length > 0) {
  console.log('')
  console.log('Recent actionable runs:')
  for (const run of actionableRuns) {
    const lastRecord = run.records.at(-1)
    console.log(`- ${run.classification.type}: ${run.runId}`)
    console.log(`  ${run.classification.summary}`)
    console.log(`  Last feedback: ${lastRecord?.vote ?? 'unknown'} ${candidateName(lastRecord)}`)
  }
}
