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
const DEFAULT_AUDIO_YTDLP_TIMEOUT_MS = 90_000  // áudio demora mais para resolver formatos
const DEFAULT_AUDIO_FORMAT_SELECTOR = 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=mp3]/bestaudio[ext=ogg]'
const MAX_QUERY_LENGTH = 200
const MAX_URL_LENGTH = 2_048
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_RATE_LIMIT_MAX = 60

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
const PLAYLIST_TTL_MS = 10 * 60 * 1000 // 10 minutos

const searchCache = new TtlCache(SEARCH_TTL_MS)
const audioCache  = new TtlCache(AUDIO_TTL_MS)
const playlistCache = new TtlCache(PLAYLIST_TTL_MS)

// Limpa entradas expiradas a cada 10 minutos para não acumular memória
setInterval(() => { searchCache.purge(); audioCache.purge(); playlistCache.purge() }, 10 * 60 * 1000).unref()

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
])

const ALLOWED_STREAM_HOSTS = [
  'googlevideo.com',
  'ytimg.com',
  'youtube.com',
]

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
    audioYtdlpTimeoutMs: Number(environment.AUDIO_YTDLP_TIMEOUT_MS || DEFAULT_AUDIO_YTDLP_TIMEOUT_MS),
    audioFormatSelector: environment.AUDIO_FORMAT_SELECTOR || DEFAULT_AUDIO_FORMAT_SELECTOR,
    rateLimitWindowMs: Number(environment.RATE_LIMIT_WINDOW_MS || DEFAULT_RATE_LIMIT_WINDOW_MS),
    rateLimitMax: Number(environment.RATE_LIMIT_MAX || DEFAULT_RATE_LIMIT_MAX),
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
    exposedHeaders: ['X-Cache', 'Content-Range', 'Content-Length', 'Accept-Ranges'],
  }
}

function resolveAccessControlAllowOrigin(origin, allowedOrigins) {
  if (allowedOrigins.includes('*')) return '*'
  if (origin && allowedOrigins.includes(origin)) return origin
  return null
}

function createRateLimiter({ windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS, max = DEFAULT_RATE_LIMIT_MAX } = {}) {
  const hits = new Map()
  setInterval(() => hits.clear(), windowMs).unref()

  return function rateLimiter(req, res, next) {
    const ip = req.socket?.remoteAddress || 'unknown'
    const count = (hits.get(ip) || 0) + 1
    hits.set(ip, count)

    if (count > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
      res.status(429).json({ error: 'muitas requisições, tente novamente mais tarde' })
      return
    }

    next()
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

export function isAllowedStreamUrl(value) {
  const normalized = normalizeQueryParam(value)

  if (!normalized || normalized.length > MAX_URL_LENGTH) return false

  try {
    const url = new URL(normalized)
    if (!['http:', 'https:'].includes(url.protocol)) return false

    return ALLOWED_STREAM_HOSTS.some(host => (
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    ))
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

function getVideoWatchUrl(video) {
  if (video.webpage_url) return video.webpage_url
  if (video.id) return `https://www.youtube.com/watch?v=${video.id}`
  return normalizeQueryParam(video.url)
}

function getUrlMimeType(url) {
  try {
    return decodeURIComponent(new URL(url).searchParams.get('mime') || '').toLowerCase()
  } catch {
    return ''
  }
}

function getAllowedAudioKind(format = {}) {
  const ext = String(format.ext || format.audio_ext || '').toLowerCase()
  const acodec = String(format.acodec || '').toLowerCase()
  const mimeType = String(format.mimeType || format.mimetype || '').split(';')[0].trim().toLowerCase()
  const urlMimeType = getUrlMimeType(format.url).split(';')[0].trim()
  const mime = mimeType || urlMimeType

  if (ext === 'mp3' || mime === 'audio/mpeg' || mime === 'audio/mp3') return 'mp3'
  if (ext === 'ogg' || ext === 'oga' || mime === 'audio/ogg' || mime === 'application/ogg') return 'ogg'
  if (
    ext === 'aac' ||
    ext === 'acc' ||
    ext === 'm4a' ||
    mime === 'audio/aac' ||
    mime === 'audio/aacp' ||
    mime === 'audio/mp4' ||
    acodec.startsWith('mp4a') ||
    acodec.includes('aac')
  ) {
    return 'aac'
  }

  return null
}

function findBestAudioFormat(formats = []) {
  const allowedFormats = formats.filter(format => {
    if (format.acodec === 'none' || (format.vcodec && format.vcodec !== 'none')) return false
    return Boolean(getAllowedAudioKind(format))
  })

  return allowedFormats.reduce((best, format) => {
    const abr = format.abr || 0
    if (!best || abr > (best.abr || 0)) return format

    return best
  }, null)
}

function findSelectedAudioFormat(info = {}) {
  const selectedFormats = [
    ...(info.requested_downloads || []),
    ...(info.requested_formats || []),
  ]

  const selectedAudio = selectedFormats.find(format => {
    if (!format?.url) return false
    if (format.acodec === 'none' || (format.vcodec && format.vcodec !== 'none')) return false
    return Boolean(getAllowedAudioKind(format))
  })

  if (selectedAudio) return selectedAudio
  if (info.url && getAllowedAudioKind(info)) return info
  return findBestAudioFormat(info.formats || [])
}

export function createYtDlpRunner(config = getConfig()) {
  return async function runYtDlp(args, { timeoutMs } = {}) {
    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileAsync(config.ytdlpPath, args, {
        env: { ...env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs ?? config.ytdlpTimeoutMs,
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

  app.use(cors(createCorsOptions(config.allowedOrigins)))
  app.use('/api', createRateLimiter({
    windowMs: config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    max: config.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
  }))

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

      const args = addCookiesArg(
        [`ytsearch20:${q}`, '-j', '--flat-playlist', '--no-warnings', '--socket-timeout', '30'],
        config,
      )
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

      const args = addCookiesArg(
        [url, '-j', '-f', config.audioFormatSelector, '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '2'],
        config,
      )
      const data = await runYtDlp(args, { timeoutMs: config.audioYtdlpTimeoutMs })
      if (data.length === 0) return res.status(404).json({ error: 'nenhum resultado' })

      const info = data[0]
      const bestAudio = findSelectedAudioFormat(info)
      if (!bestAudio?.url) return res.status(404).json({ error: 'nenhum formato de áudio' })

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

  function handleStreamRequest(req, res, headOnly) {
    try {
      const streamUrl = normalizeQueryParam(req.query.url)
      if (!streamUrl) return res.status(400).json({ error: 'url obrigatória' })

      try {
        new URL(streamUrl)
      } catch {
        return res.status(400).json({ error: 'url inválida' })
      }

      if (!isAllowedStreamUrl(streamUrl)) {
        return res.status(403).json({ error: 'host não permitido' })
      }

      function proxyRequest(url, redirectCount = 0) {
        if (!isAllowedStreamUrl(url)) {
          if (!res.headersSent) res.status(403).json({ error: 'host não permitido' })
          return
        }

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
            proxyRes.destroy()
            const next = new URL(proxyRes.headers.location, url).href
            proxyRequest(next, redirectCount + 1)
            return
          }

          const acao = resolveAccessControlAllowOrigin(req.headers.origin, config.allowedOrigins)
          const resHeaders = {
            'Content-Type': proxyRes.headers['content-type'] || getUrlMimeType(url) || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            'Cache-Control': 'no-cache', // Evita cache parcial no navegador que causa cancelamentos
          }
          if (acao) resHeaders['Access-Control-Allow-Origin'] = acao
          if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length']
          if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range']

          res.writeHead(proxyRes.statusCode, resHeaders)

          if (headOnly) {
            proxyRes.destroy()
            res.end()
            return
          }

          proxyRes.pipe(res)

          // Cleanup on client disconnect (res 'close' = conexão encerrada antes do fim)
          const onClientClose = () => {
            proxyReq.destroy()
            proxyRes.destroy()
          }
          res.on('close', onClientClose)

          proxyRes.on('end', () => res.removeListener('close', onClientClose))
        })

        // Apenas timeout de conexão (antes de receber os headers), não de inatividade da stream
        proxyReq.on('socket', (socket) => {
          socket.setTimeout(10000)
          socket.on('timeout', () => {
            if (!res.headersSent) {
              proxyReq.destroy()
              res.status(504).json({ error: 'timeout ao conectar na stream' })
            }
          })
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
  }

  app.get('/api/stream', (req, res) => handleStreamRequest(req, res, false))
  app.head('/api/stream', (req, res) => handleStreamRequest(req, res, true))

  app.get('/api/playlist', async (req, res) => {
    try {
      if (!isAllowedYouTubeUrl(req.query.url)) {
        return res.status(400).json({ error: 'url inválida ou não permitida' })
      }

      const url = normalizeQueryParam(req.query.url)

      const cached = playlistCache.get(url)
      if (cached) {
        res.setHeader('X-Cache', 'HIT')
        return res.json({ items: cached })
      }

      const args = addCookiesArg([url, '-j', '--flat-playlist', '--no-warnings'], config)
      const data = await runYtDlp(args)
      const items = data.map(video => ({
        id: String(video.id),
        title: String(video.title || ''),
        url: getVideoWatchUrl(video),
        duration: video.duration || 0,
      }))

      playlistCache.set(url, items)
      res.setHeader('X-Cache', 'MISS')
      res.json({ items })
    } catch (err) {
      handleInternalError(res, err)
    }
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'rota não encontrada' })
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
