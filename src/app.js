import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import { env } from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_PORT = 8081
const DEFAULT_YTDLP_PATH = 'yt-dlp'
const DEFAULT_COOKIES_PATH = '/opt/music-api/cookies.txt'
const DEFAULT_YTDLP_TIMEOUT_MS = 45_000
const MAX_QUERY_LENGTH = 200
const MAX_URL_LENGTH = 2_048

// ---------------------------------------------------------------------------
// TTL Cache — evita chamar yt-dlp repetidamente para a mesma query / URL
// ---------------------------------------------------------------------------
class TtlCache {
  #store = new Map()

  /** @param {number} defaultTtlMs tempo de vida padrão em ms */
  constructor(defaultTtlMs) {
    this.defaultTtlMs = defaultTtlMs
  }

  get(key) {
    const entry = this.#store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.#store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  /** Remove entradas expiradas (pode ser chamado periodicamente) */
  purge() {
    const now = Date.now()
    for (const [k, v] of this.#store) {
      if (now > v.expiresAt) this.#store.delete(k)
    }
  }
}

const SEARCH_TTL_MS = 5 * 60 * 1000   // 5 minutos
const AUDIO_TTL_MS  = 3 * 60 * 1000   // 3 minutos (URLs do YouTube expiram)

const searchCache = new TtlCache(SEARCH_TTL_MS)
const audioCache  = new TtlCache(AUDIO_TTL_MS)

// Limpa entradas expiradas a cada 10 minutos para não acumular memória
setInterval(() => { searchCache.purge(); audioCache.purge() }, 10 * 60 * 1000).unref()

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
])

export function getConfig(environment = env) {
  const cookiesPath = environment.COOKIES_PATH || DEFAULT_COOKIES_PATH

  return {
    port: Number(environment.PORT || DEFAULT_PORT),
    ytdlpPath: environment.YTDLP_PATH || DEFAULT_YTDLP_PATH,
    allowedOrigins: (environment.ALLOWED_ORIGINS || '*')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
    cookiesPath,
    hasCookies: existsSync(cookiesPath),
    ytdlpTimeoutMs: Number(environment.YTDLP_TIMEOUT_MS || DEFAULT_YTDLP_TIMEOUT_MS),
  }
}

function createCorsOptions(allowedOrigins) {
  return {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        cb(null, true)
        return
      }

      cb(new Error('Not allowed by CORS'))
    },
  }
}

function normalizeQueryParam(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim()
  return String(value || '').trim()
}

function validateRequiredText(value, fieldName, maxLength) {
  const normalized = normalizeQueryParam(value)

  if (!normalized) return `${fieldName} obrigatório`
  if (normalized.length > maxLength) return `${fieldName} deve ter no máximo ${maxLength} caracteres`

  return null
}

export function isAllowedYouTubeUrl(value) {
  const normalized = normalizeQueryParam(value)

  if (!normalized || normalized.length > MAX_URL_LENGTH) return false

  try {
    const url = new URL(normalized)
    return ['http:', 'https:'].includes(url.protocol) && ALLOWED_YOUTUBE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function getBestThumbnail(thumbnails = []) {
  return thumbnails.at(-1)?.url || thumbnails[0]?.url || ''
}

function addCookiesArg(args, config) {
  if (config.hasCookies) args.push('--cookies', config.cookiesPath)
  return args
}

function normalizeVideoResult(video) {
  return {
    id: String(video.id),
    title: String(video.title || ''),
    channel: String(video.channel || ''),
    duration: video.duration || 0,
    thumbnail: getBestThumbnail(video.thumbnails || []),
    url: video.webpage_url || `https://www.youtube.com/watch?v=${video.id}`,
  }
}

function findBestAudioFormat(formats = []) {
  return formats.reduce((best, format) => {
    if (format.acodec === 'none' || (format.vcodec && format.vcodec !== 'none')) return best

    const abr = format.abr || 0
    if (!best || abr > (best.abr || 0)) return format

    return best
  }, null)
}

export function createYtDlpRunner(config = getConfig()) {
  return async function runYtDlp(args) {
    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileAsync(config.ytdlpPath, args, {
        env: { ...env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: config.ytdlpTimeoutMs,
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      // yt-dlp sometimes exits non-zero with warnings but still has valid stdout
      if (err.stdout) {
        stdout = err.stdout
        stderr = err.stderr || ''
      } else {
        throw err
      }
    }

    const lines = stdout.trim().split('\n').filter(Boolean)
    const results = lines
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)

    if (results.length === 0 && stderr) throw new Error(stderr)

    return results
  }
}

function handleInternalError(res, err) {
  console.error(err)

  if (err?.killed || err?.signal === 'SIGTERM') {
    res.status(504).json({ error: 'tempo limite ao consultar o yt-dlp' })
    return
  }

  res.status(500).json({ error: 'erro interno ao processar solicitação' })
}

export function createApp({ config = getConfig(), runYtDlp = createYtDlpRunner(config) } = {}) {
  const app = express()

  app.use(express.json({ limit: '50kb' }))
  app.use(cors(createCorsOptions(config.allowedOrigins)))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/api/search', async (req, res) => {
    try {
      const validationError = validateRequiredText(req.query.q, 'q', MAX_QUERY_LENGTH)
      if (validationError) return res.status(400).json({ error: validationError })

      const q = normalizeQueryParam(req.query.q)

      const cached = searchCache.get(q)
      if (cached) {
        res.setHeader('X-Cache', 'HIT')
        return res.json({ results: cached })
      }

      const args = addCookiesArg([`ytsearch20:${q}`, '-j', '--flat-playlist', '--no-warnings'], config)
      const data = await runYtDlp(args)
      const results = data.map(normalizeVideoResult)

      searchCache.set(q, results)
      res.setHeader('X-Cache', 'MISS')
      res.json({ results })
    } catch (err) {
      handleInternalError(res, err)
    }
  })

  app.get('/api/audio', async (req, res) => {
    try {
      if (!isAllowedYouTubeUrl(req.query.url)) {
        return res.status(400).json({ error: 'url inválida ou não permitida' })
      }

      const url = normalizeQueryParam(req.query.url)

      const cached = audioCache.get(url)
      if (cached) {
        res.setHeader('X-Cache', 'HIT')
        return res.json(cached)
      }

      const args = addCookiesArg([url, '-j', '-f', 'bestaudio/best', '--no-warnings'], config)
      const data = await runYtDlp(args)
      if (data.length === 0) return res.status(404).json({ error: 'nenhum resultado' })

      const info = data[0]
      const bestAudio = findBestAudioFormat(info.formats || [])

      const payload = {
        title: String(info.title || ''),
        channel: String(info.channel || ''),
        duration: info.duration || 0,
        thumbnail: getBestThumbnail(info.thumbnails || []),
        streamUrl: bestAudio?.url || '',
      }

      audioCache.set(url, payload)
      res.setHeader('X-Cache', 'MISS')
      res.json(payload)
    } catch (err) {
      handleInternalError(res, err)
    }
  })

  app.get('/api/stream', async (req, res) => {
    try {
      const streamUrl = normalizeQueryParam(req.query.url)
      if (!streamUrl) return res.status(400).json({ error: 'url obrigatória' })

      let parsedUrl
      try {
        parsedUrl = new URL(streamUrl)
      } catch {
        return res.status(400).json({ error: 'url inválida' })
      }

      const allowedHosts = ['googlevideo.com', 'ytimg.com', 'youtube.com']
      if (!allowedHosts.some(h => parsedUrl.hostname.endsWith(h))) {
        return res.status(403).json({ error: 'host não permitido' })
      }

      function proxyRequest(url, redirectCount = 0) {
        if (redirectCount > 5) {
          if (!res.headersSent) res.status(502).json({ error: 'muitos redirects' })
          return
        }

        const parsed = new URL(url)
        const getFn = parsed.protocol === 'https:' ? httpsGet : httpGet

        const headers = { 'User-Agent': 'Mozilla/5.0' }
        const range = req.headers.range
        if (range) headers['Range'] = range

        const proxyReq = getFn(url, { headers }, (proxyRes) => {
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            const next = new URL(proxyRes.headers.location, url).href
            proxyRequest(next, redirectCount + 1)
            return
          }

          const resHeaders = {
            'Content-Type': proxyRes.headers['content-type'] || 'audio/webm',
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
          }
          if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length']
          if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range']

          res.writeHead(proxyRes.statusCode, resHeaders)
          proxyRes.pipe(res)

          // Cleanup on client disconnect
          req.on('close', () => {
            proxyRes.destroy()
          })
        })

        proxyReq.setTimeout(15000, () => {
          proxyReq.destroy()
          if (!res.headersSent) res.status(504).json({ error: 'timeout ao buscar stream' })
        })

        proxyReq.on('error', (err) => {
          if (err.code !== 'ECONNRESET') {
            console.error('Stream proxy error:', err.message)
          }
          if (!res.headersSent) res.status(502).json({ error: 'falha ao buscar stream' })
        })
      }

      proxyRequest(streamUrl)
    } catch (err) {
      handleInternalError(res, err)
    }
  })

  app.get('/api/playlist', async (req, res) => {
    try {
      if (!isAllowedYouTubeUrl(req.query.url)) {
        return res.status(400).json({ error: 'url inválida ou não permitida' })
      }

      const url = normalizeQueryParam(req.query.url)
      const args = addCookiesArg([url, '-j', '--flat-playlist', '--no-warnings'], config)
      const data = await runYtDlp(args)
      const items = data.map(video => ({
        id: String(video.id),
        title: String(video.title || ''),
        url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration || 0,
      }))

      res.json({ items })
    } catch (err) {
      handleInternalError(res, err)
    }
  })

  app.use((err, _req, res, _next) => {
    if (err.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'origem não permitida pelo CORS' })
      return
    }

    handleInternalError(res, err)
  })

  return app
}
