import express from 'express'
import cors from 'cors'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { env } from 'node:process'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

const app = express()
app.use(express.json())

const PORT = env.PORT || 8080
const YTDLP_PATH = env.YTDLP_PATH || 'yt-dlp'
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '*').split(',')
const COOKIES_PATH = env.COOKIES_PATH || '/opt/music-api/cookies.txt'
const HAS_COOKIES = existsSync(COOKIES_PATH)

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'))
    }
  },
}

app.use(cors(corsOptions))

async function runYtDlp(args) {
  const { stdout, stderr } = await execFileAsync(YTDLP_PATH, args, {
    env: { ...env },
    maxBuffer: 10 * 1024 * 1024,
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  const results = lines.map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  if (results.length === 0 && stderr) throw new Error(stderr)
  return results
}

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q
    if (!q) return res.status(400).json({ error: 'q obrigatório' })
    const args = [`ytsearch20:${q}`, '-j', '--flat-playlist', '--no-warnings']
    if (HAS_COOKIES) args.push('--cookies', COOKIES_PATH)
    const data = await runYtDlp(args)
    const results = data.map(v => ({
      id: String(v.id),
      title: String(v.title || ''),
      channel: String(v.channel || ''),
      duration: v.duration || 0,
      thumbnail: v.thumbnails?.[0]?.url || '',
      url: v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
    }))
    res.json({ results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/audio', async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'url obrigatória' })
    const args = [url, '-j', '-f', 'bestaudio/best', '--no-warnings']
    if (HAS_COOKIES) args.push('--cookies', COOKIES_PATH)
    const data = await runYtDlp(args)
    if (data.length === 0) return res.status(404).json({ error: 'nenhum resultado' })
    const info = data[0]
    const formats = info.formats || []
    let bestAudio = null
    let bestAbr = 0
    for (const f of formats) {
      if (f.acodec === 'none' || (f.vcodec && f.vcodec !== 'none')) continue
      const abr = f.abr || 0
      if (abr > bestAbr) { bestAbr = abr; bestAudio = f }
    }
    const thumbnails = info.thumbnails || []
    const thumb = thumbnails.length > 0 ? thumbnails.at(-1)?.url || '' : ''
    res.json({
      title: String(info.title || ''),
      channel: String(info.channel || ''),
      duration: info.duration || 0,
      thumbnail: thumb,
      streamUrl: bestAudio?.url || '',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/playlist', async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'url obrigatória' })
    const data = await runYtDlp([url, '-j', '--flat-playlist', '--no-warnings'])
    const items = data.map(v => ({
      id: String(v.id),
      title: String(v.title || ''),
      url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
      duration: v.duration || 0,
    }))
    res.json({ items })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Music API rodando em http://0.0.0.0:${PORT}`)
})
