#!/usr/bin/env node
/**
 * Забирает с YouTube список видео канала, метаданные и авто-субтитры,
 * складывая по одному JSON на видео в data/raw/.
 *
 * Инкрементально: видео, для которого уже есть raw-файл с транскриптом,
 * повторно не скачивается. Так еженедельный крон обрабатывает только новинки.
 *
 * Флаги:
 *   --force        перекачать всё заново
 *   --only=ID,ID   ограничиться конкретными видео
 *   --limit=N      обработать не больше N новых видео за прогон
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RAW, config, ensureDir, readJSON, writeJSON, slugify } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || Infinity;

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

function ytdlp(extraArgs, { json = false } = {}) {
  const out = execFileSync(YTDLP, extraArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!json) return out;
  return out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
}

/** Плоский список видео канала (без обращения к каждому видео отдельно). */
function listChannelVideos() {
  const url = `https://www.youtube.com/@${config.channelHandle}/videos`;
  console.log(`→ читаю список видео: ${url}`);
  return ytdlp(['--flat-playlist', '--dump-json', '--ignore-errors', url], { json: true });
}

/**
 * json3-субтитры YouTube → массив реплик {t, d, text}.
 * Отбрасываем служебные события без текста и склеиваем сегменты внутри реплики.
 */
function parseJson3(raw) {
  const data = JSON.parse(raw);
  const cues = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text === '\n') continue;
    cues.push({
      t: Math.round((ev.tStartMs || 0) / 100) / 10,
      d: Math.round((ev.dDurationMs || 0) / 100) / 10,
      text,
    });
  }
  return cues;
}

/** Метаданные + субтитры одного видео. */
function fetchVideo(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arina-sub-'));
  try {
    const [meta] = ytdlp(
      [
        '--skip-download',
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs', 'ru,ru-RU,ru-orig',
        '--sub-format', 'json3',
        '--dump-json',
        // --dump-json включает simulate, а он отменяет запись файлов субтитров
        '--no-simulate',
        '--no-warnings',
        '-o', path.join(tmp, '%(id)s.%(ext)s'),
        url,
      ],
      { json: true },
    );

    // yt-dlp кладёт файл как <id>.<lang>.json3. Дорожка "ru" приходит с пунктуацией
    // и заглавными, "ru-orig" — сырой ASR-поток, поэтому порядок предпочтений важен.
    const available = fs.readdirSync(tmp).filter((f) => f.endsWith('.json3'));
    const preference = [`${id}.ru.json3`, `${id}.ru-RU.json3`, `${id}.ru-orig.json3`];
    const subFile =
      preference.find((name) => available.includes(name)) ||
      available.find((f) => /\.ru[.-]/.test(f)) ||
      available[0];

    let cues = [];
    let subtitleSource = null;
    if (subFile) {
      cues = parseJson3(fs.readFileSync(path.join(tmp, subFile), 'utf8'));
      subtitleSource = subFile.replace(/^.*?\./, '').replace(/\.json3$/, '');
    }

    const publishedAt =
      meta.release_timestamp || meta.timestamp
        ? new Date((meta.release_timestamp || meta.timestamp) * 1000).toISOString()
        : meta.upload_date
          ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}T00:00:00.000Z`
          : null;

    return {
      id,
      url,
      title: meta.title,
      slug: slugify(meta.title || id, id),
      description: (meta.description || '').trim(),
      publishedAt,
      duration: meta.duration || 0,
      thumbnail:
        (meta.thumbnails || []).filter((t) => t.url && !t.url.includes('.webp')).at(-1)?.url ||
        `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      tags: meta.tags || [],
      subtitleSource,
      cues,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  ensureDir(RAW);
  let videos = listChannelVideos();
  if (only.length) videos = videos.filter((v) => only.includes(v.id));
  if (config.minDurationSec) {
    videos = videos.filter((v) => (v.duration || 0) >= config.minDurationSec);
  }
  console.log(`  найдено видео: ${videos.length}`);

  let added = 0;
  let skipped = 0;
  const failures = [];

  for (const v of videos) {
    const dest = path.join(RAW, `${v.id}.json`);
    const existing = readJSON(dest);
    if (!force && existing && existing.cues?.length) {
      skipped++;
      continue;
    }
    if (added >= limit) break;

    console.log(`→ скачиваю ${v.id}: ${v.title}`);
    try {
      const data = fetchVideo(v.id);
      if (!data.cues.length) {
        console.warn(`  ⚠ нет русских субтитров у ${v.id}, сохраняю только метаданные`);
      }
      writeJSON(dest, data);
      added++;
    } catch (err) {
      console.error(`  ✗ ${v.id}: ${err.message}`);
      failures.push(v.id);
    }
  }

  console.log(`\nГотово: новых ${added}, уже было ${skipped}, ошибок ${failures.length}`);
  if (failures.length) {
    console.error(`Не удалось: ${failures.join(', ')}`);
    // Не валим прогон целиком: остальные видео уже сохранены и попадут на сайт.
  }
}

main();
