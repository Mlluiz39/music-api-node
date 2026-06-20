import { createApp, getConfig } from './app.js'

const config = getConfig()
const app = createApp({ config })

const server = app.listen(config.port, () => {
  console.log(`Music API rodando em http://0.0.0.0:${config.port}`)
  console.log(`Audio format selector: ${config.audioFormatSelector}`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\nRecebido ${signal}, encerrando servidor...`)
  server.close(() => {
    console.log('Servidor encerrado.')
    process.exit(0)
  })
  // Força a saída se conexões penduradas não fecharem
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
