# SF Food Guesser

A local React app for identifying likely SF restaurants, cafes, bakeries, and
late-night counters from uploaded food photos.

The app uses uploaded image analysis, optional local GPS EXIF extraction, a
source-backed seed venue dataset in `shared/venues.js`, and OpenRouter web search
to find likely venues beyond the local seed list. It intentionally avoids
live-hours and reservation claims because those change frequently.

Submitting a photo strips embedded image metadata before sending it to the API,
which uses a vision model to extract image evidence, search broadly for San
Francisco-specific matches, and rank likely venues. If the original image has
GPS EXIF metadata, the browser extracts coordinates locally and sends only the
coordinates as an extra ranking signal.

The repository only includes placeholder environment variables. Real keys stay
in your local `.env`, which is ignored by git.

## Repository Layout

```text
frontend/          React/Vite app, venue seed data, browser tests
backend/           Local Express API, provider wiring, API tests
functions/api/     Cloudflare Pages Functions for the production same-origin API
docs/              Product and deployment notes
scripts/           Secret scan and production health checks
evaluation/        Evaluation photos and accuracy results
data/              Ignored local run logs and feedback records
```

`functions/` stays at the repo root because Cloudflare Pages expects that
convention for Pages Functions.

For stronger interior/storefront matching, add optional provider keys locally.
`HASDATA_API_KEY` is the cost-optimized Google Maps/photo provider: the backend
uses it to search Google Maps places and fetch customer/review photos before
asking the vision model to compare those images against the upload.
`CERAMIC_API_KEY` is the low-cost broad web-search provider for review pages,
social/photo pages, and local food coverage. `EXA_API_KEY` can still add
structured article discovery for sources such as Infatuation, Eater, SF
Standard, SFGATE, Chronicle, and other local food coverage. `SERPAPI_API_KEY`
is still supported as a legacy Google Maps/photo fallback when HasData is not
configured.

## Run

Create a local `.env` first:

```bash
cp .env.example .env
```

Replace `PASTE_YOUR_OPENROUTER_API_KEY_HERE` with your real OpenRouter key in
`.env`. Optional keys are intentionally blank unless you have your own
credentials for those providers. If you are using free OpenRouter vision models,
set `OPENROUTER_FALLBACK_MODELS` to a comma-separated list of model ids to try
when the primary model is rate-limited. Then run:

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
photo-derived evidence searches when `EXA_API_KEY` is configured, and HasData
for Google Maps/customer photo evidence when `HASDATA_API_KEY` is configured.
Production feedback records use the `SF_FOOD_FEEDBACK_KV` binding.
Optional abuse protection uses the `SF_FOOD_RATE_LIMIT_KV` binding name for
IP/session rate limits; this config currently points it at the same KV namespace
as feedback with separate key prefixes. If `TURNSTILE_SECRET_KEY` is present, rate-limit
responses also tell the frontend that Turnstile can be required for suspicious
traffic.

Target production domains are `https://spotted-in-sf.com` and
`https://www.spotted-in-sf.com`; both should serve the same Cloudflare Pages
project after DNS validation completes. The active Pages project is
`spotted-in-sf`, connected to the private GitHub repo
`katalinawinemixer/sf-food-guesser` on the `main` branch.

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

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
