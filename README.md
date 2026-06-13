# 🎵 Music API

API leve para extrair áudio e informações do YouTube, feita em **Node.js**. Usa [yt-dlp](https://github.com/yt-dlp/yt-dlp) como backend.

## Endpoints

| Método | Rota | Parâmetro | Descrição |
|--------|------|-----------|-----------|
| GET | `/api/search` | `q` | Busca vídeos no YouTube (até 20 resultados) |
| GET | `/api/audio` | `url` | Retorna URL direta do melhor stream de áudio |
| GET | `/api/playlist` | `url` | Lista faixas de uma playlist |

## Exemplos

```bash
# Buscar
curl "http://localhost:3000/api/search?q=mc+torugo"

# Pegar stream de áudio
curl "http://localhost:3000/api/audio?url=https://www.youtube.com/watch?v=Y50HSJQuwNU"

# Listar playlist
curl "http://localhost:3000/api/playlist?url=https://www.youtube.com/playlist?list=..."
```

## Requisitos

- Node.js 18+
- npm
- yt-dlp instalado e no PATH
- (opcional) cookies do YouTube para contornar restrições

---

## Setup local

```bash
# Instalar yt-dlp
pip install yt-dlp

# Ou via binário standalone
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

# Instalar dependências
npm install

# Configurar variáveis
cp .env.example .env  # edite se necessário

# Iniciar servidor
npm start
```

Servidor sobe em `http://0.0.0.0:3000`.

---

## Deploy na VPS (guia completo)

### 1. Provisionar VPS

- SO: Ubuntu 22.04 ou superior
- Portas abertas no firewall: **22** (SSH), **3000** (API)
- Se usar Cloudflare Tunnel ou proxy reverso, abrir apenas 22 e 443

### 2. Instalar Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # 22.x
```

### 3. Instalar yt-dlp

```bash
# Via pip (recomendado)
sudo apt install -y python3-pip ffmpeg
pip install yt-dlp

# Confirme que funciona
yt-dlp --version
```

### 4. Abrir porta no firewall

```bash
# ufw
sudo ufw allow 3000/tcp
sudo ufw reload

# Se usa iptables direto:
# sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

Se estiver atrás de Cloudflare/nginx, **não** exponha a 3000 — configure proxy reverso.

### 5. Criar usuário e diretório da aplicação

```bash
sudo useradd -r -s /bin/false music-api
sudo mkdir -p /opt/music-api
sudo chown music-api:music-api /opt/music-api
```

### 6. Criar arquivo de ambiente

```bash
sudo tee /opt/music-api/.env <<EOF
PORT=8080
ALLOWED_ORIGINS=*
YTDLP_PATH=yt-dlp
EOF
```

### 7. Configurar systemd

Criar `/etc/systemd/system/music-api.service`:

```ini
[Unit]
Description=Music API (Node.js)
After=network.target

[Service]
Type=simple
User=music-api
Group=music-api
WorkingDirectory=/opt/music-api
ExecStart=/usr/bin/node /opt/music-api/src/app.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/music-api/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable music-api
sudo systemctl start music-api
sudo systemctl status music-api
```

### 8. Deploy automático

O script `deploy.sh` envia os fontes, instala dependências e reinicia o serviço:

```bash
# Local — edite o host no script ou passe via env
VPS_HOST=root@seu-ip bash deploy.sh
```

### 9. Cookies do YouTube (opcional, mas recomendado)

Para evitar bloqueios (403/restrição de idade):

1. Instale extensão [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) no Chrome
2. Faça login no YouTube
3. Exporte os cookies para `cookies.txt`
4. Envie para a VPS: `scp cookies.txt root@seu-ip:/opt/music-api/cookies.txt`
5. Adicione ao `EnvironmentFile`: `COOKIES_PATH=/opt/music-api/cookies.txt`
6. Reinicie: `sudo systemctl restart music-api`

### 10. Verificar que tudo funciona

```bash
curl "http://seu-ip:3000/api/search?q=test"
curl "http://seu-ip:3000/api/audio?url=https://www.youtube.com/watch?v=VIDEO_ID"
```

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3000` | Porta do servidor |
| `ALLOWED_ORIGINS` | `*` | Origens CORS permitidas (separadas por vírgula) |
| `YTDLP_PATH` | `yt-dlp` | Caminho do binário yt-dlp |
| `COOKIES_PATH` | `/opt/music-api/cookies.txt` | Caminho do arquivo de cookies |

---

## Estrutura do projeto

```
music-api/
├── src/
│   └── app.js          # Servidor Express, handlers, chamada ao yt-dlp
├── deploy.sh           # Script de deploy: rsync → npm install → systemd restart
├── package.json
├── .env                 # Variáveis de ambiente (não versionado)
└── README.md
```

---

## License

ISC
