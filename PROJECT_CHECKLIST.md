# SF Food Guesser Build Checklist

This checklist is ordered by how the product should be built, even when some
items were completed earlier out of order.

## 1. Product Goal And Success Criteria

- [x] Define the core user promise: upload a gatekept SF food/interior photo and get the most likely venue.
- [x] Define the first supported geography: San Francisco only.
- [x] Define supported venue types: restaurants, cafes, bakeries, counters, bars, dessert shops.
- [x] Define what counts as a correct answer: exact venue name, address, and supporting evidence.
- [x] Define accuracy standards before claiming certainty.
- [x] Define uncertainty behavior: when confidence is low, show candidates and evidence instead of pretending certainty.

## 2. Security And Repo Hygiene

- [x] Create a private GitHub repo.
- [x] Keep real API keys in local `.env`.
- [x] Add `.env` to `.gitignore`.
- [x] Commit only `.env.example` with obvious placeholders.
- [x] Run secret scans before pushing code.
- [x] Push code to GitHub without committed API keys.
- [x] Add a pre-commit or CI secret scan so future commits are checked automatically.

## 3. Local App Foundation

- [x] Build a React/Vite frontend.
- [x] Build a local Express backend.
- [x] Add image upload and file picker support.
- [x] Add drag-and-drop image upload support.
- [x] Add preview and analysis state for uploaded photos.
- [x] Add a visible analyzing/loading state so the UI does not look frozen.
- [x] Add local API health checks.
- [x] Add basic tests, lint, server syntax check, and production build.

## 4. Vision Model Layer

- [x] Add OpenRouter vision support.
- [x] Keep optional direct OpenAI fallback placeholder clear in `.env.example`.
- [x] Send uploaded images to the backend for model analysis.
- [x] Prompt the model to inspect food, signage, interiors, packaging, decor, menus, street clues, and storefront clues.
- [x] Force structured JSON output for candidates and evidence.
- [ ] Add model/provider timeout handling and clearer retry messaging.
- [ ] Log anonymized analysis steps locally for debugging without storing user photos.

## 5. Search And Evidence Pipeline

- [x] Add OpenRouter web search tool configuration for broad SF-specific search.
- [x] Add Exa API key locally only.
- [x] Add `exa-js`.
- [x] Wire Exa deep search with `type: "deep"` and `contents: { highlights: true }`.
- [x] Add Exa tests that verify the deep/highlights search configuration.
- [x] Surface web evidence in the returned analysis payload.
- [x] Defer SerpAPI unless Exa/OpenRouter evidence is not enough.
- [x] Add optional Google Maps customer/review photo search through SerpAPI and compare candidate public images visually against the upload.
- [x] Add source-specific search query generation for Yelp photos, restaurant sites, local blogs, Instagram/TikTok captions, Eater, Infatuation, and other public pages where available.
- [ ] Avoid unsupported scraping; use provider APIs or publicly accessible search results.
- [ ] Add a durable provider interface so Exa, OpenRouter search, SerpAPI, and future providers are isolated.

## 6. Matching And Ranking

- [x] Return multiple ranked candidates instead of only one guess.
- [x] Include confidence scores and evidence reasons.
- [x] Include source URLs and map queries when available.
- [x] Prefer interior/storefront/photo evidence over generic dish similarity in the prompt.
- [x] Implement deterministic reranking after the model response, using evidence strength and source quality.
- [x] Penalize generic food-only matches unless there is strong supporting venue evidence.
- [x] Add internal evidence categories: exact text match, interior match, storefront match, packaging/logo match, dish match, GPS match, web-source match.
- [x] Add confidence calibration rules so scores are consistent across runs.

## 7. User Experience

- [x] Make upload photo the main workflow.
- [x] Remove the need for users to manually enter dish/sign/street/decor clues.
- [x] Show analysis progress visually.
- [x] Show detected visual evidence.
- [x] Show candidate venues with confidence and reasons.
- [x] Show a search trail when web/photo evidence exists.
- [x] Add a clear “why this guess” evidence view for each candidate.
- [x] Keep evidence categories out of the user workflow; translate them into plain-language reasons.
- [x] Add mobile layout QA for upload, preview, loading, and results.

## 8. Reliability And Error Handling

- [x] Show missing-key/offline API health states.
- [x] Reject requests without photos.
- [x] Reject invalid venue payloads.
- [x] Add provider-specific error messages for OpenRouter, Exa, and photo-search providers.
- [x] Add graceful behavior when one provider fails but others work.
- [ ] Add request size and file type messaging in the UI.
- [ ] Add rate-limit messaging.

## 9. Deployment Readiness

- [ ] Choose deployment target.
- [ ] Move API keys into deployment environment variables.
- [ ] Keep GitHub free of real secrets.
- [ ] Add production CORS/origin rules.
- [ ] Add deployment README steps.
- [x] Add CI for test, lint, build, and secret scan.
- [ ] Decide whether uploaded photos are processed transiently only or stored with explicit consent.

## 10. Future Accuracy Improvements

- [ ] Add Google Places/Maps-compatible venue lookup if a compliant provider key is available.
- [ ] Build a richer SF venue database from source-backed public pages.
- [ ] Cache search results by query to reduce cost and latency.
- [ ] Add image embedding comparison if a suitable provider is chosen.
