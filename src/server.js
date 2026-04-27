const express = require('express');
const cors = require('cors');
const path = require('path');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Estado de descargas en progreso
const downloadProgress = {};

// Detectar ruta de yt-dlp
function getYtDlpPath() {
  const candidates = [
    path.join(__dirname, '../bin/yt-dlp'),
    path.join(__dirname, '../bin/yt-dlp.exe'),
    'yt-dlp',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp'; // espera que esté en PATH
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

function formatFileSize(bytes) {
  if (!bytes) return 'Desconocido';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// GET /api/info?url=...
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  try {
    let raw;
    let info;

    // Intentar primero con extractor args
    try {
      raw = await ytdlp([
        '--dump-json',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=web',
        url,
      ]);
      info = JSON.parse(raw);
    } catch (err) {
      console.warn('[info warn] Fallback 1: intentando sin extractor-args');
      // Intentar sin extractor-args
      try {
        raw = await ytdlp([
          '--dump-json',
          '--no-playlist',
          url,
        ]);
        info = JSON.parse(raw);
      } catch (err2) {
        console.warn('[info warn] Fallback 2: intentando con --skip-unavailable-fragments');
        // Último intento
        raw = await ytdlp([
          '--dump-json',
          '--no-playlist',
          '--skip-unavailable-fragments',
          url,
        ]);
        info = JSON.parse(raw);
      }
    }

    const seen = new Set();
    const formats = (info.formats || [])
      .filter(f => {
        if (!f.ext || f.ext === 'mhtml') return false;
        if (f.format_note === 'storyboard') return false;
        // No requerir f.url ya que a veces falta
        return true;
      })
      .map(f => {
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        const height = f.height || 0;
        const resolution = height ? `${height}p` : (f.format_note || f.format_id);
        const filesize = f.filesize || f.filesize_approx || null;
        return {
          format_id: f.format_id,
          ext: f.ext,
          quality: f.format_note || '',
          resolution,
          filesize: filesize,
          filesize_readable: formatFileSize(filesize),
          vcodec: f.vcodec || 'none',
          acodec: f.acodec || 'none',
          tbr: f.tbr || 0,
          height,
          hasVideo,
          hasAudio,
        };
      })
      .filter(f => {
        // Solo incluir formatos con video+audio, solo video, o solo audio
        if (!f.hasVideo && !f.hasAudio) return false;
        const key = `${f.resolution}-${f.ext}-${f.hasVideo}-${f.hasAudio}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter(f => {
        // Solo mostrar mp4 y mp3
        return f.ext === 'mp4' || f.ext === 'mp3';
      })
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));

    res.json({
      title: info.title || 'Video',
      author: info.uploader || info.channel || 'Desconocido',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      views: info.view_count || 0,
      formats: formats.length > 0 ? formats : [
        { format_id: 'best', ext: 'mp4', quality: 'Mejor disponible', resolution: 'Auto', filesize: null, vcodec: 'h264', acodec: 'aac', tbr: 0, height: 0, hasVideo: true, hasAudio: true }
      ],
    });
  } catch (err) {
    console.error('[info error]', err.message);
    res.status(500).json({ 
      error: 'No se pudo obtener info del video. ' + err.message,
      suggestion: 'Verifica que la URL sea válida y que yt-dlp esté actualizado.'
    });
  }
});

// GET /api/download?url=...&format_id=...&filename=...
app.get('/api/download', async (req, res) => {
  const { url, format_id, filename = 'video', ext = 'mp4' } = req.query;
  if (!url || !format_id) return res.status(400).json({ error: 'Parámetros faltantes' });

  const safeFilename = (filename + '.' + ext)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .substring(0, 200);

  const tmpBase = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const tmpTemplate = tmpBase + '.%(ext)s';

  // Estrategias de descarga progresivas
  const strategies = [
    { format: format_id, mergeFormat: null, label: `Formato específico: ${format_id}` },
    { format: format_id, mergeFormat: 'mp4', label: `${format_id} + merge mp4` },
    { format: 'bestvideo+bestaudio/best', mergeFormat: 'mp4', label: 'best(video)+best(audio)+merge' },
    { format: 'best[ext=mp4]', mergeFormat: null, label: 'best[mp4]' },
    { format: 'best', mergeFormat: null, label: 'best' },
  ];

  let lastError = null;
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    try {
      console.log(`[download] Intento ${i + 1}/${strategies.length}: ${strategy.label}`);

      const args = [
        '-f', strategy.format,
        '--no-playlist',
        '--skip-unavailable-fragments',
        '-o', tmpTemplate,
      ];

      if (strategy.mergeFormat) {
        args.push('--merge-output-format', strategy.mergeFormat);
      }

      args.push(url);

      await ytdlp(args);

      // Si llegamos aquí, funcionó
      const dir = os.tmpdir();
      const base = path.basename(tmpBase);
      const found = fs.readdirSync(dir).find(f => f.startsWith(base));
      if (!found) throw new Error('Archivo no encontrado tras la descarga');

      const actualFile = path.join(dir, found);
      const actualExt = path.extname(found).slice(1) || ext;

      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
      res.setHeader('Content-Type', getContentType(actualExt));

      const stream = fs.createReadStream(actualFile);
      stream.pipe(res);
      stream.on('end', () => fs.unlink(actualFile, () => {}));
      stream.on('error', (e) => {
        console.error('[stream error]', e);
        fs.unlink(actualFile, () => {});
        if (!res.headersSent) res.status(500).json({ error: 'Error al enviar archivo' });
      });
      return; // Salir exitosamente
    } catch (err) {
      lastError = err.message;
      console.warn(`[download] Estrategia ${i + 1} falló: ${err.message}`);
      continue;
    }
  }

  // Si llegamos aquí, todas las estrategias fallaron
  console.error('[download] Todas las estrategias fallaron:', lastError);
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'No se pudo descargar con ninguna estrategia',
      lastError: lastError
    });
  }
});

// GET /api/download-best
app.get('/api/download-best', async (req, res) => {
  const { url, type, filename = 'video' } = req.query;
  if (!url || !type) return res.status(400).json({ error: 'Parámetros faltantes' });

  const isAudio = type === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';

  const safeFilename = (filename + '.' + ext)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .substring(0, 200);

  const tmpBase = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const tmpTemplate = tmpBase + '.%(ext)s';

  // Estrategias de descarga progresivas
  const downloadStrategies = isAudio ? [
    { format: 'bestaudio/best', args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'], label: 'bestaudio + mp3' },
    { format: 'bestaudio', args: ['-x', '--audio-format', 'mp3'], label: 'bestaudio (sin quality)' },
    { format: 'best', args: ['-x', '--audio-format', 'mp3'], label: 'best + mp3' },
    { format: 'best', args: [], label: 'best (sin conversión)' },
  ] : [
    { format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best', args: ['--merge-output-format', 'mp4'], label: 'best(mp4)+audio+merge' },
    { format: 'bestvideo+bestaudio/best', args: ['--merge-output-format', 'mp4'], label: 'best(video)+best(audio)+merge' },
    { format: 'best[ext=mp4]', args: [], label: 'best[mp4]' },
    { format: 'best', args: [], label: 'best' },
  ];

  let lastError = null;
  for (let i = 0; i < downloadStrategies.length; i++) {
    const strategy = downloadStrategies[i];
    try {
      console.log(`[best download] Intento ${i + 1}/${downloadStrategies.length}: ${strategy.label}`);

      const args = [
        '--no-playlist',
        '--skip-unavailable-fragments',
        '-f', strategy.format,
        '-o', tmpTemplate,
        ...strategy.args,
        url,
      ];

      await ytdlp(args);

      // Si llegamos aquí, funcionó
      const dir = os.tmpdir();
      const base = path.basename(tmpBase);
      const found = fs.readdirSync(dir).find(f => f.startsWith(base));
      if (!found) throw new Error('Archivo no encontrado tras descarga');

      const actualFile = path.join(dir, found);
      const actualExt = path.extname(found).slice(1) || ext;

      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
      res.setHeader('Content-Type', getContentType(actualExt));

      const stream = fs.createReadStream(actualFile);
      stream.pipe(res);
      stream.on('end', () => fs.unlink(actualFile, () => {}));
      stream.on('error', () => {
        fs.unlink(actualFile, () => {});
        if (!res.headersSent) res.status(500).end();
      });
      return; // Salir exitosamente
    } catch (err) {
      lastError = err.message;
      console.warn(`[best download] Estrategia ${i + 1} falló: ${err.message}`);
      continue;
    }
  }

  // Si llegamos aquí, todas las estrategias fallaron
  console.error('[best download] Todas las estrategias fallaron:', lastError);
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'No se pudo descargar el video con ninguna estrategia',
      lastError: lastError,
      suggestion: 'El video podría tener restricciones de región o estar protegido'
    });
  }
});

// GET /api/download-with-progress?url=...&format_id=...&filename=...&type=...
// Server-Sent Events para mostrar progreso de descarga
app.get('/api/download-with-progress', async (req, res) => {
  const { url, format_id, filename = 'video', type = 'video' } = req.query;
  
  if (!url || !format_id) return res.status(400).json({ error: 'Parámetros faltantes' });

  const isAudio = type === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';

  const safeFilename = (filename + '.' + ext)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .substring(0, 200);

  const downloadId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  downloadProgress[downloadId] = { status: 'iniciando', percent: 0, size: 'Calculando...' };

  const tmpBase = path.join(os.tmpdir(), `ytdl_${downloadId}`);
  const tmpTemplate = tmpBase + '.%(ext)s';

  // Configurar SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (event, data) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  // Estrategias de descarga
  const strategies = isAudio ? [
    { format: format_id, args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'], label: 'Audio específico' },
    { format: 'bestaudio/best', args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'], label: 'Mejor audio + mp3' },
    { format: 'best', args: ['-x', '--audio-format', 'mp3'], label: 'Mejor disponible' },
  ] : [
    { format: format_id, args: [], label: 'Formato específico' },
    { format: 'bestvideo+bestaudio/best', args: ['--merge-output-format', 'mp4'], label: 'Mejor video + audio' },
    { format: 'best[ext=mp4]', args: [], label: 'Mejor mp4' },
    { format: 'best', args: [], label: 'Mejor disponible' },
  ];

  let lastError = null;
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const bin = getYtDlpPath();

    try {
      downloadProgress[downloadId].status = `Intento ${i + 1}/${strategies.length}: ${strategy.label}`;
      downloadProgress[downloadId].percent = (i / strategies.length) * 50;
      sendEvent('progress', { 
        message: downloadProgress[downloadId].status,
        percent: downloadProgress[downloadId].percent 
      });

      const args = [
        '-f', strategy.format,
        '--no-playlist',
        '--skip-unavailable-fragments',
        '--progress-template', '%(progress)s',
        '-o', tmpTemplate,
        ...strategy.args,
        url,
      ];

      await new Promise((resolve, reject) => {
        const child = exec(`"${bin}" ${args.map(a => `"${a}"`).join(' ')}`, 
          { maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout);
          }
        );

        // Capturar salida en tiempo real
        child.stdout?.on('data', (data) => {
          const output = data.toString();
          if (output.includes('%')) {
            const match = output.match(/(\d+\.?\d*)%/);
            if (match) {
              const percent = Math.min(95, parseFloat(match[1]));
              downloadProgress[downloadId].percent = 50 + (percent / 100) * 45;
              sendEvent('progress', { 
                message: `Descargando: ${percent.toFixed(1)}%`,
                percent: downloadProgress[downloadId].percent 
              });
            }
          }
        });

        child.stderr?.on('data', (data) => {
          console.log('[download]', data.toString());
        });
      });

      // Buscar archivo
      const dir = os.tmpdir();
      const base = path.basename(tmpBase);
      const found = fs.readdirSync(dir).find(f => f.startsWith(base));
      if (!found) throw new Error('Archivo no encontrado');

      const actualFile = path.join(dir, found);
      const stat = fs.statSync(actualFile);
      const filesize = formatFileSize(stat.size);

      downloadProgress[downloadId].status = 'Completado';
      downloadProgress[downloadId].percent = 100;
      downloadProgress[downloadId].tempFile = actualFile;
      downloadProgress[downloadId].safeFilename = safeFilename;
      sendEvent('progress', {
        message: `Completado - Tamaño: ${filesize}`,
        percent: 100,
        file: path.basename(actualFile),
        filesize: filesize,
        downloadId: downloadId
      });

      // Borrar archivo temporal después de 30 segundos
      setTimeout(() => {
        if (downloadProgress[downloadId]) {
          const tempFile = downloadProgress[downloadId].tempFile;
          if (tempFile && fs.existsSync(tempFile)) {
            fs.unlink(tempFile, () => {});
          }
          delete downloadProgress[downloadId];
        }
      }, 30000);

      // Cerrar conexión SSE
      res.end();
      return;
    } catch (err) {
      lastError = err.message;
      console.warn(`[download-progress] Estrategia ${i + 1} falló: ${err.message}`);
      continue;
    }
  }

  // Todas fallaron
  downloadProgress[downloadId].status = 'Error';
  downloadProgress[downloadId].percent = 0;
  sendEvent('error', { 
    message: 'No se pudo descargar con ninguna estrategia',
    error: lastError 
  });
  delete downloadProgress[downloadId];
  res.end();
});

// GET /api/progress - Obtener estado de descargas
app.get('/api/progress', (req, res) => {
  res.json(downloadProgress);
});

// GET /api/download-file?downloadId=... - Descargar archivo temporal
app.get('/api/download-file', (req, res) => {
  const { downloadId } = req.query;
  if (!downloadId || !downloadProgress[downloadId]) {
    return res.status(404).json({ error: 'Archivo no encontrado o expirado' });
  }

  const { tempFile, safeFilename } = downloadProgress[downloadId];
  if (!tempFile || !fs.existsSync(tempFile)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }

  const ext = path.extname(tempFile).slice(1) || 'mp4';
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  res.setHeader('Content-Type', getContentType(ext));

  const stream = fs.createReadStream(tempFile);
  stream.pipe(res);
  stream.on('error', (e) => {
    console.error('[download-file error]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Error al enviar archivo' });
  });
});

// GET /api/debug/formats?url=... - Ver todos los formatos disponibles (DEBUG)
app.get('/api/debug/formats', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  try {
    const raw = await ytdlp([
      '--dump-json',
      '--no-playlist',
      '--skip-unavailable-fragments',
      url,
    ]);

    const info = JSON.parse(raw);
    const formats = info.formats || [];

    res.json({
      total_formats: formats.length,
      title: info.title,
      formats: formats.map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        format_note: f.format_note,
        vcodec: f.vcodec,
        acodec: f.acodec,
        height: f.height,
        width: f.width,
        tbr: f.tbr,
        filesize: f.filesize,
      })),
    });
  } catch (err) {
    console.error('[debug error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function getContentType(ext) {
  const map = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

// Iniciar servidor (funciona en local y en Render)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ YTDL App corriendo en → http://localhost:${PORT}\n`);
});

module.exports = app;
