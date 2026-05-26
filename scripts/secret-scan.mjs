import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const rootDir = process.cwd()
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-ssr',
])
const ignoredFiles = new Set(['.env'])

const patterns = [
  { name: 'OpenRouter key', regex: /sk-or-v1-[A-Za-z0-9]+/g },
  { name: 'OpenAI key assignment', regex: /OPENAI_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+/g },
  { name: 'OpenRouter key assignment', regex: /OPENROUTER_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+/g },
  { name: 'SerpAPI key assignment', regex: /SERPAPI_API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/g },
  { name: 'Exa key assignment', regex: /EXA_API_KEY\s*=\s*[A-Za-z0-9-]{20,}/g },
]

function shouldIgnore(path) {
  if (ignoredFiles.has(path)) return true
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
