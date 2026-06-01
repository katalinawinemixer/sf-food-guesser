# SF Food Guesser

An AI-assisted learning prototype for identifying likely San Francisco
restaurants, cafes, bakeries, and late-night counters from uploaded food photos.

**Live demo:** https://spotted-in-sf.com

This is a portfolio/showcase project, not a commercial product or a publicly
supported service. I built it to practice shipping a real full-stack AI app:
React/Vite UI work, local and serverless APIs, provider integration,
privacy-aware upload handling, tests, deployment checks, and adversarial review.

## Portfolio Notes

- **What I owned:** product requirements, architecture, provider selection,
  privacy decisions, tests, deployment, and debugging. I used AI coding tools as
  implementation accelerators, but kept responsibility for the product behavior,
  edge cases, and release criteria.
- **Core product problem:** food-photo recognition is noisy, location-dependent,
  and easy to overclaim. The app is designed to rank likely venues with visible
  uncertainty instead of pretending the model always knows the answer.
- **Privacy posture:** uploads are handled as transient analysis inputs;
  embedded image metadata is stripped before provider analysis. If GPS EXIF is
  present, the browser extracts coordinates locally and sends only coordinates
  as an optional ranking signal.
- **Public data boundary:** benchmark photos, local feedback records, run logs,
  and real API keys are intentionally git-ignored and are not part of the
  repository.
- **Current verification:** tests, lint, production build, npm audit,
  production health checks, and the custom secret scan pass locally.

The app uses uploaded image analysis, optional local GPS EXIF extraction, a
source-backed seed venue dataset in `shared/venues.js`, and provider-backed web
search to find likely venues beyond the local seed list. It intentionally avoids
live-hours and reservation claims because those change frequently.

The repository only includes placeholder environment variables. Real keys stay
in your local `.env`, which is ignored by git. Cloudflare runtime secrets are set
in the Pages project or backend host environment, never in source control.

No license is currently included, so the code is visible for review and learning
but is not granted for reuse unless a license is added later.

## What This Demonstrates

- Building a working AI-assisted web app from idea to deployed prototype.
- Separating frontend display logic from server-owned ranking and seed data.
- Handling uploaded images with metadata stripping before provider analysis.
- Adding rate limiting, admin-token protection, CORS rules, and secret scanning.
- Writing focused tests around API behavior, upload handling, and UI ranking.
- Keeping changing or unrelated experiments out of the repo scope.

## Current Limits

- Accuracy is exploratory and depends on provider responses, public source
  coverage, and the quality of the uploaded photo.
- Benchmark photos are intentionally git-ignored; local benchmark runs require
  adding your own images under `benchmarks/images/`.
- Feedback records in local development are file-backed and ignored by git.
- This is not advertised as a hosted product for general public use.

## Repository Layout

```text
frontend/          React/Vite app, browser tests
backend/           Local Express API, provider wiring, API tests
functions/api/     Cloudflare Pages Functions for the production same-origin API
docs/              Product and deployment notes
scripts/           Secret scan and production health checks
data/              Ignored local run logs and feedback records
```

`functions/` stays at the repo root because Cloudflare Pages expects that
convention for Pages Functions.

For stronger interior/storefront matching, add optional provider keys locally.
`GOOGLE_PLACES_API_KEY` enables the official Google Places photo provider and
takes priority when configured. `HASDATA_API_KEY` is the cost-optimized Google
Maps/customer-photo provider used when Google Places is not configured.
`SERPAPI_API_KEY` is still supported as a legacy Google Maps/photo fallback when
neither Google Places nor HasData is configured. `CERAMIC_API_KEY` is the
low-cost broad web-search provider for review pages, social/photo pages, and
local food coverage. `EXA_API_KEY` can still add structured article discovery
for sources such as Infatuation, Eater, SF Standard, SFGATE, Chronicle, and
other local food coverage.

## Run

Create a local `.env` first:

```bash
cp .env.example .env
```

Replace `your_openrouter_api_key_here` with your real OpenRouter key in `.env`.
Optional keys are intentionally blank unless you have your own credentials for
those providers. If you are using free OpenRouter vision models, set
`OPENROUTER_FALLBACK_MODELS` to a comma-separated list of model ids to try when
the primary model is rate-limited. Then run:

```bash
npm install
npm run dev
```

The React app runs on `http://127.0.0.1:5173/` and the local API runs on
`http://127.0.0.1:5174/`.

## Build

```bash
npm run build
```

## Cloudflare Pages

The React frontend and same-origin Pages Functions API are ready for Cloudflare
Pages:

```bash
npm run deploy:cloudflare
```

The deployed API lives under `/api` through `functions/api/`, so
`VITE_API_BASE_URL` should stay blank for the normal Cloudflare deployment.
Cloudflare runtime secrets are set on the Pages project, not committed to the
repo. The Pages Function uses OpenRouter for vision, Exa for parallel
photo-derived evidence searches when `EXA_API_KEY` is configured, Google Places
photos when `GOOGLE_PLACES_API_KEY` is configured, and HasData for Google
Maps/customer photo evidence when `HASDATA_API_KEY` is configured and Google
Places is not configured.
Production feedback records use the `SF_FOOD_FEEDBACK_KV` binding.
Optional abuse protection uses the `SF_FOOD_RATE_LIMIT_KV` binding name for
IP/session rate limits; this config currently points it at the same KV namespace
as feedback with separate key prefixes. If `TURNSTILE_SECRET_KEY` is present, rate-limit
responses also tell the frontend that Turnstile can be required for suspicious
traffic.
Optional provider search caching uses the `SF_FOOD_SEARCH_CACHE_KV` binding with
separate cache key prefixes. The checked-in `wrangler.toml` contains my current
Cloudflare project name and KV namespace IDs; forked deployments should replace
those with their own project and binding IDs.

Target production domains are `https://spotted-in-sf.com` and
`https://www.spotted-in-sf.com`; both should serve the same Cloudflare Pages
project after DNS validation completes. The active Pages project is
`spotted-in-sf`, connected to the GitHub repo `katalinawinemixer/sf-food-guesser`
on the `main` branch.

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

Before changing the GitHub repository visibility to public, use
[docs/PUBLIC_RELEASE_CHECKLIST.md](./docs/PUBLIC_RELEASE_CHECKLIST.md).

## Build Checklist

See [PROJECT_CHECKLIST.md](./PROJECT_CHECKLIST.md) for the ordered product,
accuracy, security, and deployment checklist.

The product promise and accuracy rules are in
[docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md).

## Accuracy Benchmarks

Known-case benchmark metadata lives in `benchmarks/manifest.json`. Put local
test photos in `benchmarks/images/` when you want to run it; that directory is
git-ignored so benchmark runs do not store uploaded images in the repo.

```bash
npm run benchmark
```

The runner writes JSON reports to `data/benchmark-runs/` with whether the
expected venue was rank 1, present lower-ranked, missing, skipped, or uncertain.

The source-backed seed venue database can be audited with:

```bash
npm run review:venues
```

That writes `data/venue-database-report.json`, including source domains,
coverage counts for visual/menu/non-inference clues, and records that need
more source-backed evidence.
