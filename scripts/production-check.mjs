import { createHash } from 'node:crypto'
import { lookup, Resolver } from 'node:dns/promises'
import https from 'node:https'

const pagesUrl = normalizeUrl(process.env.SF_FOOD_PAGES_URL || 'https://spotted-in-sf.pages.dev')
const domainUrls = (process.env.SF_FOOD_PRODUCTION_URLS || 'https://spotted-in-sf.com,https://www.spotted-in-sf.com')
  .split(',')
  .map((url) => normalizeUrl(url.trim()))
  .filter(Boolean)
const allUrls = [pagesUrl, ...domainUrls]

const requiredHeaders = {
  'strict-transport-security': /max-age=\d+/i,
  'content-security-policy': /default-src/i,
  'cross-origin-opener-policy': /^same-origin$/i,
  'permissions-policy': /camera=\(\)/i,
  'referrer-policy': /strict-origin-when-cross-origin/i,
  'x-content-type-options': /^nosniff$/i,
  'x-frame-options': /^DENY$/i,
}

const failures = []
const results = []
const resolver = new Resolver()
resolver.setServers(['1.1.1.1'])
const resolvedHosts = new Map()

for (const url of allUrls) {
  const host = new URL(url).hostname
  try {
    const addresses = await resolveHost(host)
    resolvedHosts.set(host, addresses)
    if (url !== pagesUrl) results.push(`DNS ${host}: ${addresses.map((address) => address.address).join(', ')}`)
  } catch (error) {
    failures.push(`DNS ${host}: ${error.code || error.message}`)
    continue
  }

  try {
    const app = await fetchApp(url, resolvedHosts.get(host))
    const health = await fetchHealth(url, resolvedHosts.get(host))
    results.push(`${url}: app ${app.status}, api ${health.status}`)

    if (!app.html.includes('<div id="root"></div>')) {
      failures.push(`${url}: app HTML does not look like the Vite app shell`)
    }
    for (const [header, pattern] of Object.entries(requiredHeaders)) {
      const value = app.headers.get(header) || health.headers.get(header) || ''
      if (!pattern.test(value)) failures.push(`${url}: missing or invalid ${header}`)
    }
    if (!health.body.ok) failures.push(`${url}/api/health: ok was not true`)
    if (!health.body.visionEnabled) failures.push(`${url}/api/health: vision is not enabled`)
    if (health.body.provider !== 'openrouter') {
      failures.push(`${url}/api/health: OpenRouter provider is not active`)
    }
    if (!health.body.webSearchEnabled) {
      failures.push(`${url}/api/health: OpenRouter web search is not enabled`)
    }
    if (!health.body.articleSearchEnabled) {
      failures.push(`${url}/api/health: Exa article/evidence search is not enabled`)
    }
    if (!health.body.photoSearchEnabled) {
      failures.push(`${url}/api/health: HasData Google Maps/photo evidence search is not enabled`)
    }
    if (health.body.photoSearchProvider !== 'hasdata-google-maps-photos') {
      failures.push(`${url}/api/health: HasData photo provider is not active`)
    }
    app.fingerprint = fingerprintAssets(app.html)
    results.push(`${url}: fingerprint ${app.fingerprint}`)
  } catch (error) {
    failures.push(`${url}: ${error.message}`)
  }
}

const fingerprints = results
  .filter((line) => line.includes(': fingerprint '))
  .map((line) => line.split(': fingerprint ')[1])
if (fingerprints.length === allUrls.length && new Set(fingerprints).size > 1) {
  failures.push('Production URLs do not serve the same app asset fingerprint')
}

for (const result of results) console.log(result)

if (failures.length) {
  console.error('\nProduction check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error('\nExpected DNS once the custom domains are ready:')
  console.error('- spotted-in-sf.com should resolve to the Cloudflare Pages project')
  console.error('- www.spotted-in-sf.com should resolve to the same Cloudflare Pages project')
  process.exitCode = 1
} else {
  console.log('\nProduction check passed.')
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, '')
}

async function fetchApp(url, addresses) {
  const response = await requestText(url, addresses)
  if (response.status < 200 || response.status >= 300) throw new Error(`app returned HTTP ${response.status}`)
  return { status: response.status, headers: response.headers, html: response.body }
}

async function fetchHealth(url, addresses) {
  const response = await requestText(`${url}/api/health`, addresses)
  const body = JSON.parse(response.body || '{}')
  if (response.status < 200 || response.status >= 300) throw new Error(`/api/health returned HTTP ${response.status}`)
  return { status: response.status, headers: response.headers, body }
}

function fingerprintAssets(html) {
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
    .map((match) => match[1])
    .sort()
  return createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
}

async function resolveHost(host) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ipv4 = await resolver.resolve4(host).catch(() => [])
    const addresses = ipv4.map((address) => ({ address, family: 4 }))
    if (addresses.length) return normalizeAddresses(addresses)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  try {
    const addresses = (await lookup(host, { all: true })).filter((address) => address.family === 4)
    if (addresses.length) return normalizeAddresses(addresses)
  } catch {
    // Keep the stable public-DNS error below. The system resolver can lag custom-domain changes.
  }

  const error = new Error('public DNS returned no A records')
  error.code = 'ENODATA'
  throw error
}

function requestText(url, addresses, redirectsRemaining = 5) {
  const target = new URL(url)
  const selected = addresses.find((address) => address.family === 4) ?? addresses[0]

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: 15000,
        headers: { 'accept-encoding': 'identity' },
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [{ address: selected.address, family: selected.family }])
            return
          }
          callback(null, selected.address, selected.family)
        },
      },
      (response) => {
        const location = response.headers.location
        if (
          location &&
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          redirectsRemaining > 0
        ) {
          response.resume()
          resolve(requestText(new URL(location, target).toString(), addresses, redirectsRemaining - 1))
          return
        }

        response.setEncoding('utf8')
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get(name) {
                const value = response.headers[name.toLowerCase()]
                return Array.isArray(value) ? value.join(', ') : value
              },
            },
            body,
          })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error(`${target.hostname}: request timed out`)))
    request.on('error', reject)
    request.end()
  })
}

function normalizeAddresses(addresses) {
  return addresses.map((address) => ({
    address: address.address,
    family: Number(address.family),
  }))
}
