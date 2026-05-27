# Frontend

React/Vite client for SF Food Guesser.

## Contents

- `src/App.tsx` - main upload, analysis, map, results, and feedback UI
- `src/venues.ts` - source-backed seed venue records
- `src/*.test.tsx` and `src/*.test.ts` - frontend and venue tests
- `public/_headers` - Cloudflare Pages static security headers

## Commands

Run these from the repository root:

```bash
npm run dev:web
npm run build
npm run preview
```

The local dev server proxies `/api` requests to the local backend at
`http://127.0.0.1:5174`.
