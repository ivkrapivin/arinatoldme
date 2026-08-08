#!/usr/bin/env node
/** Локальный просмотр dist/ без зависимостей: node scripts/serve.mjs [порт] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST } from './lib.mjs';

const port = Number(process.argv[2]) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    // Локально сайт живёт в корне, а собран под подпуть GitHub Pages — срезаем префикс.
    const base = process.env.BASE_PATH || '';
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (base && urlPath.startsWith(base)) urlPath = urlPath.slice(base.length) || '/';

    let file = path.join(DIST, urlPath);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Порт ${port} уже занят — скорее всего сайт там уже открыт: http://localhost:${port}/\n` +
          `Другой порт: npm run serve -- ${port + 1}`,
      );
      process.exit(1);
    }
    throw err;
  })
  .listen(port, () => console.log(`http://localhost:${port}/`));
