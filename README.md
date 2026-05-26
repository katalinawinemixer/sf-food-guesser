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

For stronger interior/storefront matching, add `SERPAPI_API_KEY`. With that key,
the backend runs an agent-style two-pass flow: describe the uploaded photo,
generate Google/Yelp/review-photo search queries, fetch candidate public photos,
then compare those external photos against the upload before ranking places. You
can also add `EXA_API_KEY` to pull broader web/review-page evidence into the
same comparison step.

## Run

Create a local `.env` first:

```bash
cp .env.example .env
```

Add either `OPENROUTER_API_KEY` or `OPENAI_API_KEY` to `.env`. Add
`SERPAPI_API_KEY` for candidate photo comparison and `EXA_API_KEY` for broader
web/review-page evidence, then run:

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
