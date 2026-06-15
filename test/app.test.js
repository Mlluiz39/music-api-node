import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, isAllowedStreamUrl, isAllowedYouTubeUrl } from '../src/app.js'

function createTestServer(runYtDlp) {
  const app = createApp({
    config: {
      allowedOrigins: ['*'],
      hasCookies: false,
      cookiesPath: '/tmp/cookies.txt',
      ytdlpPath: 'yt-dlp',
      ytdlpTimeoutMs: 30_000,
    },
    runYtDlp,
  })

  const server = app.listen(0)
  const { port } = server.address()

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('valida URLs permitidas do YouTube', () => {
  assert.equal(isAllowedYouTubeUrl('https://www.youtube.com/watch?v=abc'), true)
  assert.equal(isAllowedYouTubeUrl('https://youtu.be/abc'), true)
  assert.equal(isAllowedYouTubeUrl('https://example.com/video'), false)
  assert.equal(isAllowedYouTubeUrl('file:///tmp/test'), false)
})

test('valida URLs permitidas para proxy de stream', () => {
  assert.equal(isAllowedStreamUrl('https://rr1---sn.googlevideo.com/videoplayback?id=abc'), true)
  assert.equal(isAllowedStreamUrl('https://i.ytimg.com/vi/abc/default.jpg'), true)
  assert.equal(isAllowedStreamUrl('https://www.youtube.com/watch?v=abc'), true)
  assert.equal(isAllowedStreamUrl('https://evilgooglevideo.com/videoplayback'), false)
  assert.equal(isAllowedStreamUrl('https://youtube.com.evil.test/watch?v=abc'), false)
  assert.equal(isAllowedStreamUrl('ftp://rr1---sn.googlevideo.com/videoplayback'), false)
})

test('GET /health retorna status ok', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  } finally {
    await server.close()
  }
})

test('GET /api/search valida q obrigatório', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/search`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'q obrigatório' })
  } finally {
    await server.close()
  }
})

test('GET /api/search normaliza resultados', async () => {
  const server = createTestServer(async args => {
    assert.deepEqual(args, ['ytsearch20:test', '-j', '--flat-playlist', '--no-warnings', '--socket-timeout', '30'])
    return [{
      id: 'abc123',
      title: 'Vídeo teste',
      channel: 'Canal',
      duration: 123,
      thumbnails: [{ url: 'thumb-small' }, { url: 'thumb-large' }],
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
    }]
  })

  try {
    const response = await fetch(`${server.baseUrl}/api/search?q=test`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      results: [{
        id: 'abc123',
        title: 'Vídeo teste',
        channel: 'Canal',
        duration: 123,
        thumbnail: 'thumb-large',
        url: 'https://www.youtube.com/watch?v=abc123',
      }],
    })
  } finally {
    await server.close()
  }
})

test('GET /api/audio rejeita URL não permitida', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/audio?url=https://example.com/video`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'url inválida ou não permitida' })
  } finally {
    await server.close()
  }
})

test('GET /api/audio retorna melhor stream de áudio', async () => {
  const server = createTestServer(async () => [{
    title: 'Música teste',
    channel: 'Canal',
    duration: 200,
    thumbnails: [{ url: 'thumb' }],
    formats: [
      { acodec: 'none', vcodec: 'avc1', abr: 0, url: 'video' },
      { acodec: 'opus', vcodec: 'none', abr: 70, url: 'audio-low' },
      { acodec: 'opus', vcodec: 'none', abr: 160, url: 'audio-high' },
    ],
  }])

  try {
    const response = await fetch(`${server.baseUrl}/api/audio?url=https://www.youtube.com/watch?v=abc`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      title: 'Música teste',
      channel: 'Canal',
      duration: 200,
      thumbnail: 'thumb',
      streamUrl: 'audio-high',
    })
  } finally {
    await server.close()
  }
})

test('GET /api/audio retorna 404 quando não há formato de áudio', async () => {
  const server = createTestServer(async () => [{
    title: 'Sem áudio',
    formats: [
      { acodec: 'none', vcodec: 'avc1', abr: 0, url: 'video' },
      { acodec: 'none', vcodec: 'none', abr: 0 },
    ],
  }])

  try {
    const response = await fetch(`${server.baseUrl}/api/audio?url=https://www.youtube.com/watch?v=noaudio`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'nenhum formato de áudio' })
  } finally {
    await server.close()
  }
})
