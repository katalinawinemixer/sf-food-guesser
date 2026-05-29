import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'

const rootDir = process.cwd()
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-ssr',
])
const ignoredFiles = new Set(['.env'])
const trackedFiles = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean),
)

const patterns = [
  { name: 'OpenRouter key', regex: /sk-or-v1-[A-Za-z0-9]+/g },
  { name: 'OpenAI key assignment', regex: /OPENAI_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+/g },
  { name: 'OpenRouter key assignment', regex: /OPENROUTER_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+/g },
  { name: 'Google Places key assignment', regex: /GOOGLE_PLACES_API_KEY\s*=\s*AIza[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', regex: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'HasData key assignment', regex: /HASDATA_API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/g },
  { name: 'Ceramic key assignment', regex: /CERAMIC_API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/g },
  { name: 'SerpAPI key assignment', regex: /SERPAPI_API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/g },
  { name: 'Exa key assignment', regex: /EXA_API_KEY\s*=\s*[A-Za-z0-9-]{20,}/g },
]

function shouldIgnore(path) {
  if (ignoredFiles.has(path) && !trackedFiles.has(path)) return true
  return [...ignoredDirs].some((dir) => path === dir || path.startsWith(`${dir}/`))
}

function listFiles(dir = rootDir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry)
    const relativePath = relative(rootDir, absolutePath)
    if (shouldIgnore(relativePath)) continue

    const stats = statSync(absolutePath)
    if (stats.isDirectory()) {
      files.push(...listFiles(absolutePath))
    } else if (stats.isFile()) {
      files.push({ absolutePath, relativePath })
    }
  }
  return files
}

const findings = []

for (const file of listFiles()) {
  let content = ''
  try {
    content = readFileSync(file.absolutePath, 'utf8')
  } catch {
    continue
  }

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      const line = content.slice(0, match.index).split('\n').length
      findings.push(`${file.relativePath}:${line} ${pattern.name}`)
    }
  }
}

if (findings.length) {
  console.error('Potential secrets found:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log('No committed secret patterns found.')
}
