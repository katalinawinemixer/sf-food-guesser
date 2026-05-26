# SF Food Guesser

A local React app for identifying likely SF restaurants, cafes, bakeries, and
late-night counters from uploaded food photos.

The app uses uploaded image analysis, optional GPS EXIF metadata, a
source-backed seed venue dataset in `src/venues.ts`, and OpenRouter web search
to find likely venues beyond the local seed list. It intentionally avoids
live-hours and reservation claims because those change frequently.

Submitting a photo sends it to the local API, which uses a vision model to
extract image evidence, search broadly for San Francisco-specific matches, and
rank likely venues. If the image still has GPS EXIF metadata, that is used as an
extra ranking signal.

The repository only includes placeholder environment variables. Real keys stay
in your local `.env`, which is ignored by git.

For stronger interior/storefront matching, you can optionally add your own
`SERPAPI_API_KEY`. With that key, the backend runs an agent-style two-pass flow:
describe the uploaded photo, search Google Maps places, fetch Google Maps
customer/review photos for candidate listings, then compare those external
photos against the upload before ranking places. You can also optionally add
your own `EXA_API_KEY`; the backend uses `exa-js` with `type: "deep"` and
`contents: { highlights: true }` to pull broader web/review-page evidence into
the same comparison step.

## Run

Create a local `.env` first:

```bash
cp .env.example .env
```

Replace `PASTE_YOUR_OPENROUTER_API_KEY_HERE` with your real OpenRouter key in
`.env`. Optional keys are intentionally blank unless you have your own
credentials for those providers. Then run:

If you are using free OpenRouter vision models, set
`OPENROUTER_FALLBACK_MODELS` to a comma-separated list of other vision model ids
you want the backend to try when the primary model is rate-limited.

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

## Build Checklist

See [PROJECT_CHECKLIST.md](./PROJECT_CHECKLIST.md) for the ordered product,
accuracy, security, and deployment checklist.

The product promise and accuracy rules are in
[docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md).
