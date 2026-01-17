const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  port: 3000,
  imgurBaseUrl: 'https://i.imgur.com',
  cacheDir: './cache',
  maxCacheBytes: 1024 * 1024 * 1024,
  maxDownloadBytes: 10 * 1024 * 1024,
  failureImage: {
    width: 640,
    height: 360,
    background: '#1d1d1d',
    textColor: '#ffffff',
    accentColor: '#ff4d4d'
  }
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (error) {
    console.warn('Using default config. Failed to read config.json:', error.message);
    return { ...DEFAULT_CONFIG };
  }
}

const config = loadConfig();
const cacheDir = path.resolve(__dirname, config.cacheDir);

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapText(text, maxLength) {
  const words = text.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    if ((line + word).length > maxLength) {
      lines.push(line.trim());
      line = `${word} `;
    } else {
      line += `${word} `;
    }
  }

  if (line.trim()) {
    lines.push(line.trim());
  }

  return lines;
}

function renderFailureSvg(reason) {
  const { width, height, background, textColor, accentColor } = config.failureImage;
  const safeReason = escapeXml(reason);
  const lines = wrapText(safeReason, 42);
  const lineHeight = 26;
  const startY = height / 2 - (lines.length * lineHeight) / 2;
  const textSpans = lines
    .map((line, index) => {
      const y = startY + index * lineHeight;
      return `<text x="${width / 2}" y="${y}" text-anchor="middle">${line}</text>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${background}" />
  <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="24" fill="#2a2a2a" stroke="${accentColor}" stroke-width="3" />
  <text x="${width / 2}" y="${height / 2 - 60}" text-anchor="middle" fill="${accentColor}" font-family="Arial, sans-serif" font-size="26" font-weight="bold">FineImgur</text>
  <g fill="${textColor}" font-family="Arial, sans-serif" font-size="18">
    ${textSpans}
  </g>
</svg>`;
}

function sendFailure(res, reason, statusCode = 413) {
  const svg = renderFailureSvg(reason);
  res.writeHead(statusCode, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(svg)
  });
  res.end(svg);
}

function cacheKeyFromPath(requestPath) {
  const hash = crypto.createHash('sha256').update(requestPath).digest('hex');
  const extension = path.extname(requestPath) || '';
  return `${hash}${extension}`;
}

function metadataPathFor(cacheFile) {
  return `${cacheFile}.json`;
}

function readMetadata(cacheFile) {
  try {
    const raw = fs.readFileSync(metadataPathFor(cacheFile), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function writeMetadata(cacheFile, metadata) {
  fs.writeFileSync(metadataPathFor(cacheFile), JSON.stringify(metadata, null, 2));
}

function enforceCacheLimit() {
  const files = fs.readdirSync(cacheDir)
    .filter((file) => !file.endsWith('.json'))
    .map((file) => {
      const fullPath = path.join(cacheDir, file);
      const stats = fs.statSync(fullPath);
      return { file, fullPath, size: stats.size, mtime: stats.mtimeMs };
    });

  const totalSize = files.reduce((sum, item) => sum + item.size, 0);
  if (totalSize <= config.maxCacheBytes) {
    return;
  }

  files.sort((a, b) => a.mtime - b.mtime);
  let currentSize = totalSize;

  for (const entry of files) {
    if (currentSize <= config.maxCacheBytes) {
      break;
    }
    try {
      fs.unlinkSync(entry.fullPath);
      const metaPath = metadataPathFor(entry.fullPath);
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }
      currentSize -= entry.size;
    } catch (error) {
      console.warn('Failed to evict cache file:', entry.fullPath, error.message);
    }
  }
}

function serveCached(cacheFile, res) {
  const metadata = readMetadata(cacheFile);
  if (!metadata) {
    return false;
  }

  try {
    const stats = fs.statSync(cacheFile);
    res.writeHead(200, {
      'Content-Type': metadata.contentType || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=86400'
    });

    fs.utimesSync(cacheFile, new Date(), new Date());
    fs.createReadStream(cacheFile).pipe(res);
    return true;
  } catch (error) {
    return false;
  }
}

function proxyRequest(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Only GET supported');
    return;
  }

  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('FineImgur relay is running.');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(req.url, config.imgurBaseUrl);
  } catch (error) {
    sendFailure(res, 'Invalid request URL.');
    return;
  }

  const cacheKey = cacheKeyFromPath(targetUrl.pathname + targetUrl.search);
  const cacheFile = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cacheFile)) {
    const served = serveCached(cacheFile, res);
    if (served) {
      return;
    }
  }

  const requestOptions = {
    method: 'GET',
    headers: {
      'User-Agent': 'FineImgur Relay'
    }
  };

  const client = targetUrl.protocol === 'http:' ? http : https;
  const proxyReq = client.request(targetUrl, requestOptions, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      sendFailure(res, `Imgur responded with status ${proxyRes.statusCode}.`, proxyRes.statusCode || 502);
      proxyRes.resume();
      return;
    }

    const contentType = proxyRes.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      sendFailure(res, 'Imgur response was not an image.');
      proxyRes.resume();
      return;
    }

    const contentLengthHeader = proxyRes.headers['content-length'];
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > config.maxDownloadBytes) {
        sendFailure(res, 'Image exceeds maximum download size.');
        proxyRes.resume();
        return;
      }
    }

    const tempFile = `${cacheFile}.tmp`;
    const fileStream = fs.createWriteStream(tempFile);
    let downloaded = 0;
    let aborted = false;

    proxyRes.on('data', (chunk) => {
      downloaded += chunk.length;
      if (downloaded > config.maxDownloadBytes && !aborted) {
        aborted = true;
        proxyRes.destroy();
        fileStream.destroy();
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        sendFailure(res, 'Image exceeds maximum download size.');
        return;
      }

      if (!aborted) {
        fileStream.write(chunk);
      }
    });

    proxyRes.on('end', () => {
      if (aborted) {
        return;
      }
      fileStream.end();
      fs.renameSync(tempFile, cacheFile);
      writeMetadata(cacheFile, {
        contentType,
        size: downloaded,
        cachedAt: new Date().toISOString()
      });
      enforceCacheLimit();

      const stats = fs.statSync(cacheFile);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(cacheFile).pipe(res);
    });

    proxyRes.on('error', (error) => {
      if (aborted) {
        return;
      }
      fileStream.destroy();
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      sendFailure(res, `Proxy error: ${error.message}`);
    });
  });

  proxyReq.on('error', (error) => {
    sendFailure(res, `Request failed: ${error.message}`);
  });

  proxyReq.end();
}

const server = http.createServer(proxyRequest);

server.listen(config.port, () => {
  console.log(`FineImgur relay listening on http://localhost:${config.port}`);
});
