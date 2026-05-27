# Deployment

## Current Target

The first deploy target is Cloudflare Pages for the React/Vite frontend plus
same-origin Pages Functions for the production API.

Local development still uses the Node/Express API in `backend/server.mjs`
because it has the richer local debugging and run-log flow. Production Pages
Functions live in `functions/api/` and provide the deployed `/api/health`,
`/api/analyze-photo`, and `/api/feedback` endpoints without putting API keys in
the frontend build.

## Cloudflare Pages Frontend

Build command:

```bash
npm run build
```

Build output directory:

```text
frontend/dist
```

Direct upload:

```bash
npm run deploy:cloudflare
```

The project includes `wrangler.toml` with
`pages_build_output_dir = "frontend/dist"`.

Production domains:

- `https://spotted-in-sf.com`
- `https://www.spotted-in-sf.com`

Both domains are attached to the same `spotted-in-sf` Cloudflare Pages project
so they serve the same app and same `/api` functions. If either custom domain is
still pending in Cloudflare, verify that DNS records exist in the
`spotted-in-sf.com` zone and point to the Pages project.

Security headers are defined in `frontend/public/_headers` for static assets
and in `functions/api/_shared.js` for API responses.

The active Cloudflare Pages project is `spotted-in-sf`. It is connected to the
private GitHub repository `katalinawinemixer/sf-food-guesser` and builds from
the `main` branch with:

```text
npm run build
```

The output directory is:

```text
frontend/dist
```

Local Cloudflare preview:

```bash
npm run dev:cloudflare
```

## API URL

Local Node development uses Vite's `/api` proxy to `http://127.0.0.1:5174`.

For Cloudflare Pages, set this build environment variable if the API is hosted
on a different origin:

```text
VITE_API_BASE_URL=https://your-api-host.example.com
```

Leave it blank when the frontend and API are served from the same Cloudflare
Pages origin, which is the default now that Pages Functions are present.

## API Origins

When a separate backend host is used instead of Pages Functions, set this
variable in that backend host environment:

```text
SF_FOOD_GUESSER_ALLOWED_ORIGINS=https://spotted-in-sf.com,https://www.spotted-in-sf.com
```

Use a comma-separated list when adding a custom domain. The local Vite origins
`http://127.0.0.1:5173` and `http://localhost:5173` are allowed automatically.
Unknown browser origins receive a `403` JSON response.

## Required Runtime Secrets

Set secrets only in the Cloudflare Pages project or backend host environment,
never in the frontend code or `.env.example`:

- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY` if using direct OpenAI instead of OpenRouter
- `HASDATA_API_KEY` for Google Maps/customer photo evidence in local Node and
  Cloudflare Pages
- `CERAMIC_API_KEY` for the local Node API broad web provider
- `EXA_API_KEY` for local Node article discovery and Cloudflare Pages Exa
  evidence search
- `SERPAPI_API_KEY` if using the legacy local Node API Google Maps fallback

The Cloudflare Pages project needs `OPENROUTER_API_KEY`, `EXA_API_KEY`, and
`HASDATA_API_KEY` uploaded as Pages secrets. `OPENROUTER_VISION_MODEL`,
`OPENROUTER_FALLBACK_MODELS`, and optional Exa tuning vars are non-secret model
or search settings in `wrangler.toml`.

On Cloudflare Pages, the analysis flow is:

1. Ask the vision model to create a photo-derived search plan.
2. Run generated Exa searches and optional HasData Google Maps/photo searches in
   parallel.
3. Send the uploaded photo, seed venues, search plan, Exa evidence, and public
   venue photos to the final vision call for ranking.

## Feedback Storage

Production feedback uses the `SF_FOOD_FEEDBACK_KV` KV binding configured in
`wrangler.toml`. The Pages Function stores normalized feedback records without
uploaded image data. If the KV binding is missing, feedback is accepted but only
logged to Cloudflare logs with `persisted: false`.

Cloudflare Pages Functions reject browser requests with unknown `Origin` values.
Add any new production frontend origins to `SF_FOOD_GUESSER_ALLOWED_ORIGINS`.

Provider selection for local development is centralized in
`backend/providers.mjs`. The backend chooses the vision provider, fallback
models, photo-search provider, web-search provider, and article-search provider
from environment variables at startup, then passes those provider wrappers into
the request flow.

## Before Deploying

Run:

```bash
npm test
npm run secret-scan
npm run check:production
```

The local `data/` directory stores feedback and run logs and is intentionally
ignored by git. A production deployment should move that data to a durable store
before relying on it for long-term learning.

`npm run check:production` verifies the Pages URL, the custom domains, public
DNS, security headers, `/api/health`, and whether all production URLs serve the
same app asset fingerprint. It is expected to fail while custom-domain DNS is
still pending.
