# Public Release Checklist

Use this before changing the GitHub repository visibility from private to public.

## Already verified in the current public-readiness pass

- [x] `.env.example` contains placeholders only; no real API keys or credentials.
- [x] `.env` is ignored by git.
- [x] Cloudflare project and KV namespace identifiers in `wrangler.toml` are documented as non-secret maintainer deployment IDs.
- [x] Runtime secrets are documented as Cloudflare Pages or backend host environment variables, not source-controlled values.
- [x] Benchmark photos are ignored under `benchmarks/images/`.
- [x] Local feedback records and run logs are ignored under `data/`.
- [x] README explains the project as a portfolio/showcase app, not a public commercial service.
- [x] README explains AI-assisted development ownership: requirements, architecture, debugging, tests, deployment, and release criteria.
- [x] README keeps the no-license boundary: visible for review and learning, not granted for reuse unless a license is added later.

## Required checks before flipping visibility

Run these from the repo root:

```bash
npm ci
npm run secret-scan
npm audit
npm test
npm run check:production
```

Then inspect tracked files that could accidentally contain uploads, feedback, or local data:

```bash
git ls-files | grep -Ei '\.(png|jpe?g|heic|webp|gif|mp4|mov|sqlite|db|csv|json)$'
```

Expected tracked data-like files are limited to config, test fixtures, package lock files, and the benchmark manifest. Do not make the repo public if real uploaded photos, local feedback exports, run logs, database files, or credentials are tracked.

## Visibility flip command

Do not run this until the owner explicitly approves making the repository public:

```bash
gh repo edit katalinawinemixer/sf-food-guesser --visibility public
```

Verify after flipping:

```bash
gh repo view katalinawinemixer/sf-food-guesser --json visibility,url,homepageUrl
```
