import { jsonResponse, methodNotAllowed, optionsResponse } from './_shared.js'

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function cleanStringArray(value, maxItems = 8, maxLength = 300) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(String(item), maxLength)).filter(Boolean).slice(0, maxItems)
    : []
}

function cleanCandidate(value = {}) {
  return {
    id: cleanText(value?.id, 160),
    name: cleanText(value?.name, 160),
    category: cleanText(value?.category, 80),
    neighborhood: cleanText(value?.neighborhood, 120),
    address: cleanText(value?.address, 220),
    confidence: Number.isFinite(Number(value?.confidence))
      ? Number(value.confidence)
      : null,
    locationVerified: value?.locationVerified === true,
    evidenceCategories: cleanStringArray(value?.evidenceCategories, 8, 80),
    photoEvidence: cleanStringArray(value?.photoEvidence, 6, 500),
    externalEvidence: cleanStringArray(value?.externalEvidence, 6, 500),
    rankingRules: cleanStringArray(value?.rankingRules, 6, 500),
    reasons: cleanStringArray(value?.reasons, 8, 500),
  }
}

function normalizeFeedback(body) {
  const vote = cleanText(body?.vote, 20)
  if (!['correct', 'incorrect', 'undo', 'suggested_answer'].includes(vote)) {
    throw new Error('Feedback vote must be correct, incorrect, undo, or suggested_answer.')
  }

  return {
    runId: cleanText(body?.runId, 120),
    sessionId: cleanText(body?.sessionId, 120),
    vote,
    rank: Number.isFinite(Number(body?.rank)) ? Number(body.rank) : null,
    candidate: cleanCandidate(body?.candidate),
    lineup: Array.isArray(body?.lineup)
      ? body.lineup
          .map((entry) => ({
            rank: Number.isFinite(Number(entry?.rank)) ? Number(entry.rank) : null,
            candidate: cleanCandidate(entry?.candidate),
          }))
          .slice(0, 5)
      : [],
    suggestedVenue: {
      name: cleanText(body?.suggestedVenue?.name, 160),
      neighborhoodOrAddress: cleanText(body?.suggestedVenue?.neighborhoodOrAddress, 220),
      note: cleanText(body?.suggestedVenue?.note, 500),
      verificationStatus: 'unverified_user_claim',
    },
    analysis: {
      summary: cleanText(body?.analysis?.summary, 1000),
      imageEvidence: cleanStringArray(body?.analysis?.imageEvidence, 12, 500),
      needsMoreEvidence: body?.analysis?.needsMoreEvidence === true,
    },
    providers: body?.providers && typeof body.providers === 'object' ? body.providers : {},
  }
}

export function onRequestOptions() {
  return optionsResponse()
}

export async function onRequestPost({ request, env }) {
  let feedback
  try {
    feedback = normalizeFeedback(await request.json())
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : 'Feedback payload was invalid.',
      },
      400,
    )
  }

  const suggestionKey =
    feedback.vote === 'suggested_answer' && feedback.runId
      ? `feedback-suggestion:${feedback.runId}:${feedback.sessionId || 'anonymous'}`
      : null

  if (suggestionKey && env.SF_FOOD_FEEDBACK_KV?.get) {
    const existingSuggestion = await env.SF_FOOD_FEEDBACK_KV.get(suggestionKey)
    if (existingSuggestion) {
      return jsonResponse({ error: 'A correction was already submitted for this run.' }, 409)
    }
  }

  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    app: 'sf-food-guesser',
    ...feedback,
  }

  if (env.SF_FOOD_FEEDBACK_KV?.put) {
    if (suggestionKey) {
      await env.SF_FOOD_FEEDBACK_KV.put(suggestionKey, record.id)
    }
    await env.SF_FOOD_FEEDBACK_KV.put(`feedback:${record.createdAt}:${record.id}`, JSON.stringify(record))
    return jsonResponse({ ok: true, id: record.id, persisted: true }, 201)
  }

  console.log(JSON.stringify({ event: 'sf-food-guesser-feedback', record }))
  return jsonResponse({ ok: true, id: record.id, persisted: false }, 201)
}

export function onRequest() {
  return methodNotAllowed()
}
