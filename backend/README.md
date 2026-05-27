# Backend

Local Node/Express API and backend tests for SF Food Guesser.

## Contents

- `server.mjs` - local `/api/health`, `/api/analyze-photo`, and `/api/feedback`
  server
- `providers.mjs` - provider selection for OpenRouter/OpenAI, Exa, HasData,
  Ceramic, and SerpAPI
- `server.test.mjs` - local API and search pipeline tests
- `functions.test.mjs` - Cloudflare Pages Function tests

Production uses Cloudflare Pages Functions from the root `functions/api/`
directory. That directory intentionally stays at the repository root for
Cloudflare compatibility.

## Commands

Run these from the repository root:

```bash
npm run dev:api
npm test
```

Local feedback and run logs are written to the ignored root `data/` directory.
