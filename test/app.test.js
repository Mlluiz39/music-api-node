import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, isAllowedStreamUrl, isAllowedYouTubeUrl } from '../src/app.js'

function createTestServer(runYtDlp) {
  return createTestServerWithConfig(runYtDlp)
}

function createTestServerWithConfig(runYtDlp, configOverrides = {}) {
  const app = createApp({
    config: {
      allowedOrigins: ['*'],
      hasCookies: false,
      cookiesPath: '/tmp/cookies.txt',
      ytdlpPath: 'yt-dlp',
      ytdlpTimeoutMs: 30_000,
      audioYtdlpTimeoutMs: 90_000,
      ...configOverrides,
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

test('GET /api/search valida tamanho máximo da busca', async () => {
  const server = createTestServer(async () => [])
  const query = 'a'.repeat(201)

  try {
    const response = await fetch(`${server.baseUrl}/api/search?q=${query}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'q deve ter no máximo 200 caracteres' })
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

test('GET /api/search usa cache para a mesma busca', async () => {
  let calls = 0
  const server = createTestServer(async () => {
    calls += 1
    return [{
      id: 'cached',
      title: 'Cache teste',
      thumbnails: [],
    }]
  })

  try {
    const first = await fetch(`${server.baseUrl}/api/search?q=cache-user-flow`)
    const second = await fetch(`${server.baseUrl}/api/search?q=cache-user-flow`)

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.headers.get('x-cache'), 'MISS')
    assert.equal(second.headers.get('x-cache'), 'HIT')
    assert.equal(calls, 1)
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

test('GET /api/audio força vídeo único mesmo com URL de playlist', async () => {
  const playlistVideoUrl = 'https://www.youtube.com/watch?v=selected&list=PL123&index=2'
  const server = createTestServer(async args => {
    assert.deepEqual(args, [
      playlistVideoUrl,
      '-j',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      '30',
      '--retries',
      '2',
    ])

    return [{
      title: 'Selecionada',
      formats: [
        { acodec: 'opus', vcodec: 'none', abr: 128, url: 'selected-audio' },
      ],
    }]
  })

  try {
    const response = await fetch(`${server.baseUrl}/api/audio?url=${encodeURIComponent(playlistVideoUrl)}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      title: 'Selecionada',
      channel: '',
      duration: 0,
      thumbnail: '',
      streamUrl: 'selected-audio',
    })
  } finally {
    await server.close()
  }
})

test('GET /api/audio retorna melhor stream de áudio', async () => {
  const server = createTestServer(async args => {
    assert.deepEqual(args, [
      'https://www.youtube.com/watch?v=abc',
      '-j',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      '30',
      '--retries',
      '2',
    ])

    return [{
      title: 'Música teste',
      channel: 'Canal',
      duration: 200,
      thumbnails: [{ url: 'thumb' }],
      formats: [
        { acodec: 'none', vcodec: 'avc1', abr: 0, url: 'video' },
        { acodec: 'opus', vcodec: 'none', abr: 70, url: 'audio-low' },
        { acodec: 'opus', vcodec: 'none', abr: 160, url: 'audio-high' },
      ],
    }]
  })

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

test('GET /api/audio usa cache para a mesma URL', async () => {
  let calls = 0
  const url = 'https://www.youtube.com/watch?v=cacheaudio'
  const server = createTestServer(async () => {
    calls += 1
    return [{
      title: 'Audio cache',
      formats: [
        { acodec: 'opus', vcodec: 'none', abr: 128, url: 'cached-audio' },
      ],
    }]
  })

  try {
    const first = await fetch(`${server.baseUrl}/api/audio?url=${encodeURIComponent(url)}`)
    const second = await fetch(`${server.baseUrl}/api/audio?url=${encodeURIComponent(url)}`)

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.headers.get('x-cache'), 'MISS')
    assert.equal(second.headers.get('x-cache'), 'HIT')
    assert.equal(calls, 1)
  } finally {
    await server.close()
  }
})

test('GET /api/playlist retorna URLs de vídeo por id', async () => {
  const server = createTestServer(async args => {
    assert.deepEqual(args, [
      'https://www.youtube.com/playlist?list=PL123',
      '-j',
      '--flat-playlist',
      '--no-warnings',
    ])

    return [
      { id: 'first', title: 'Primeira', url: 'first' },
      { id: 'last', title: 'Última', url: 'last' },
    ]
  })

  try {
    const response = await fetch(`${server.baseUrl}/api/playlist?url=https://www.youtube.com/playlist?list=PL123`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      items: [
        {
          id: 'first',
          title: 'Primeira',
          url: 'https://www.youtube.com/watch?v=first',
          duration: 0,
        },
        {
          id: 'last',
          title: 'Última',
          url: 'https://www.youtube.com/watch?v=last',
          duration: 0,
        },
      ],
    })
  } finally {
    await server.close()
  }
})

test('GET /api/playlist rejeita URL não permitida', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/playlist?url=https://example.com/playlist`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'url inválida ou não permitida' })
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

test('GET /api/stream valida url obrigatória', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/stream`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'url obrigatória' })
  } finally {
    await server.close()
  }
})

test('GET /api/stream valida url inválida', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/stream?url=not-a-url`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'url inválida' })
  } finally {
    await server.close()
  }
})

test('GET /api/stream bloqueia host não permitido', async () => {
  const server = createTestServer(async () => [])

  try {
    const response = await fetch(`${server.baseUrl}/api/stream?url=https://example.com/audio.webm`)
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'host não permitido' })
  } finally {
    await server.close()
  }
})

test('bloqueia origem CORS não permitida', async () => {
  const server = createTestServerWithConfig(async () => [], {
    allowedOrigins: ['https://app.example.com'],
  })

  try {
    const response = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'origem não permitida pelo CORS' })
  } finally {
    await server.close()
  }
})
