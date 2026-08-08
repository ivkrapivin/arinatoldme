import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const RAW = path.join(DATA, 'raw');
export const ARTICLES = path.join(DATA, 'articles');
export const DIST = path.join(ROOT, 'dist');

export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Локальный просмотр и превью-сборки: SITE_BASE_URL=http://localhost:4321 npm run build
if (process.env.SITE_BASE_URL) config.baseUrl = process.env.SITE_BASE_URL;

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(p, value) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

/** Список id всех скачанных видео, свежие сначала. */
export function listRaw() {
  if (!fs.existsSync(RAW)) return [];
  return fs
    .readdirSync(RAW)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(RAW, f)))
    .filter(Boolean)
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/** Транслитерированный slug: читаемый в URL и дружелюбный к поиску. */
export function slugify(title, id) {
  const base = [...title.toLowerCase()]
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 9)
    .join('-');
  // id вроде "-kE_-0fBbUw" содержит дефисы и подчёркивания — в хвосте slug они дают мусор.
  const suffix = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return base ? `${base}-${suffix}` : suffix || 'video';
}

export function formatDuration(sec) {
  const s = Math.round(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  return `${m} мин`;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function timecode(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, '0');
  const s2 = String(ss).padStart(2, '0');
  return h ? `${h}:${mm}:${s2}` : `${m}:${s2}`;
}

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function readingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 160));
}
