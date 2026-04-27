# YTDL App — YouTube Downloader Personal

App web local que usa **yt-dlp** para descargar videos y música de YouTube.
Funciona 100% en tu computadora, sin límites de tiempo ni tamaño.

## Requisitos
- [Node.js](https://nodejs.org) (v18 o superior)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/latest) instalado o en carpeta `bin/`

## Uso rápido (Windows)
Doble clic en `setup-y-ejecutar.bat` — instala todo y abre la app.

## Comandos manuales
```
npm install
npm start
```
Abre http://localhost:3000

## Estructura
```
ytdl-app/
├── src/server.js       ← Backend Express
├── public/index.html   ← Frontend
├── bin/yt-dlp.exe      ← yt-dlp (Windows, opcional si está en PATH)
└── package.json
```
