import { jsonResponse, methodNotAllowed, optionsResponse } from './_shared.js'

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function cleanStringArray(value, maxItems = 8, maxLength = 300) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(String(item), maxLength)).filter(Boolean).slice(0, maxItems)
    : []
}

function normalizeFeedback(body) {
  const vote = cleanText(body?.vote, 20)
  if (!['correct', 'incorrect', 'undo'].includes(vote)) {
    throw new Error('Feedback vote must be correct, incorrect, or undo.')
  }

  return {
    runId: cleanText(body?.runId, 120),
    vote,
    rank: Number.isFinite(Number(body?.rank)) ? Number(body.rank) : null,
    candidate: {
      id: cleanText(body?.candidate?.id, 160),
      name: cleanText(body?.candidate?.name, 160),
      category: cleanText(body?.candidate?.category, 80),
      neighborhood: cleanText(body?.candidate?.neighborhood, 120),
      address: cleanText(body?.candidate?.address, 220),
      confidence: Number.isFinite(Number(body?.candidate?.confidence))
        ? Number(body.candidate.confidence)
        : null,
      locationVerified: body?.candidate?.locationVerified === true,
      evidenceCategories: cleanStringArray(body?.candidate?.evidenceCategories, 8, 80),
      reasons: cleanStringArray(body?.candidate?.reasons, 8, 500),
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

  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    app: 'sf-food-guesser',
    ...feedback,
  }

  if (env.SF_FOOD_FEEDBACK_KV?.put) {
    await env.SF_FOOD_FEEDBACK_KV.put(`feedback:${record.createdAt}:${record.id}`, JSON.stringify(record))
    return jsonResponse({ ok: true, id: record.id, persisted: true }, 201)
  }

  console.log(JSON.stringify({ event: 'sf-food-guesser-feedback', record }))
  return jsonResponse({ ok: true, id: record.id, persisted: false }, 201)
}

export function onRequest() {
  return methodNotAllowed()
}
