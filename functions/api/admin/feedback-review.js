import {
  enforceCloudflareRateLimit,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from '../_shared.js'

function candidateName(record) {
  return record?.candidate?.name || record?.suggestedVenue?.name || 'Unknown'
}

function classifyRun(records = []) {
  const activeRecords = records.filter((record) => record.vote !== 'undo')
  const correct = activeRecords.filter((record) => record.vote === 'correct')
  const incorrect = activeRecords.filter((record) => record.vote === 'incorrect')
  const suggestions = activeRecords.filter((record) => record.vote === 'suggested_answer')
  const lineup = activeRecords.find((record) => Array.isArray(record.lineup) && record.lineup.length)?.lineup ?? []
  const lineupSize =
    lineup.length ||
    new Set(activeRecords.map((record) => record.candidate?.id || record.candidate?.name).filter(Boolean)).size

  if (suggestions.length) {
    return {
      type: 'missing_candidate_suggested',
      summary: `User suggested ${suggestions.map((record) => record.suggestedVenue?.name).filter(Boolean).join(', ') || 'a missing venue'}.`,
    }
  }
  if (correct.length) {
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
  if (incorrect.length) {
    return {
      type: 'partial_negative_feedback',
      summary: `${incorrect.length} candidate(s) were marked incorrect.`,
    }
  }
  return { type: 'unclassified', summary: 'No actionable saved feedback.' }
}

function groupByRun(records = []) {
  const groups = new Map()
  for (const record of records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const runId = record.runId || `missing-run:${record.id || record.createdAt}`
    if (!groups.has(runId)) groups.set(runId, [])
    groups.get(runId).push(record)
  }
  return [...groups.entries()].map(([runId, runRecords]) => {
    const classification = classifyRun(runRecords)
    const lastRecord = runRecords.at(-1)
    return {
      runId,
      classification,
      recordCount: runRecords.length,
      lastFeedbackAt: lastRecord?.createdAt ?? null,
      lastVote: lastRecord?.vote ?? null,
      lastCandidate: candidateName(lastRecord),
      lineup: Array.isArray(lastRecord?.lineup) ? lastRecord.lineup.slice(0, 5) : [],
    }
  })
}

async function readKvFeedback(env) {
  const store = env.SF_FOOD_FEEDBACK_KV
  if (!store?.list || !store?.get) return []
  const records = []
  let cursor
  do {
    const page = await store.list({ prefix: 'feedback:', cursor, limit: 100 })
    cursor = page.cursor
    for (const key of page.keys ?? []) {
      const value = await store.get(key.name)
      if (!value) continue
      try {
        records.push(JSON.parse(value))
      } catch {
        // Skip corrupt rows instead of failing the whole admin page.
      }
    }
    if (records.length >= 500) break
  } while (cursor)
  return records
}

export function onRequestOptions() {
  return optionsResponse()
}

export async function onRequestGet({ request, env }) {
  const rateLimitResponse = await enforceCloudflareRateLimit({
    request,
    env,
    scope: 'admin-feedback-review',
    limit: Number(env.SF_FOOD_ADMIN_REVIEW_RATE_LIMIT || 20),
    windowSeconds: Number(env.SF_FOOD_ADMIN_REVIEW_RATE_WINDOW_SECONDS || 3600),
  })
  if (rateLimitResponse) return rateLimitResponse

  if (!env.SF_FOOD_ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.SF_FOOD_ADMIN_TOKEN) {
    return jsonResponse({ error: 'Admin token required.' }, 401)
  }

  const records = await readKvFeedback(env)
  const runs = groupByRun(records)
  const counts = runs.reduce((state, run) => {
    state[run.classification.type] = (state[run.classification.type] ?? 0) + 1
    return state
  }, {})

  return jsonResponse({
    ok: true,
    recordCount: records.length,
    runCount: runs.length,
    counts,
    runs: runs.slice(-50).reverse(),
  })
}

export function onRequest() {
  return methodNotAllowed()
}
