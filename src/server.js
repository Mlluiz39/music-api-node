import { createApp, getConfig } from './app.js'

const config = getConfig()
const app = createApp({ config })

app.listen(config.port, () => {
  console.log(`Music API rodando em http://0.0.0.0:${config.port}`)
})
