#!/usr/bin/env node
/**
 * Превращает сырой транскрипт в читаемую статью: краткое саммари, тезисы,
 * подзаголовки, абзацы с расставленной пунктуацией.
 *
 * Результат кэшируется в data/articles/<id>.json и коммитится в репозиторий,
 * поэтому еженедельный крон платит за обработку только новых видео.
 *
 * Есть ANTHROPIC_API_KEY → редактура через Claude API.
 * Ключа нет → детерминированный fallback: транскрипт бьётся на абзацы по паузам
 * речи. Сайт при этом собирается полностью, просто текст остаётся разговорным.
 *
 * Флаги:
 *   --force        переобработать даже то, что уже в кэше
 *   --only=ID,ID   ограничиться конкретными видео
 *   --limit=N      обработать не больше N видео за прогон
 *   --no-llm       принудительно использовать fallback
 */
import path from 'node:path';
import { ARTICLES, config, ensureDir, listRaw, readJSON, writeJSON, timecode } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const noLlm = args.includes('--no-llm');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || Infinity;

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const USE_LLM = Boolean(API_KEY) && !noLlm;

/** Транскрипт целиком, с таймкодом раз в ~30 секунд — LLM опирается на них при разбивке. */
function transcriptWithMarks(cues, everySec = 30) {
  const out = [];
  let nextMark = 0;
  for (const c of cues) {
    if (c.t >= nextMark) {
      out.push(`\n[${timecode(c.t)}] `);
      nextMark = c.t + everySec;
    }
    out.push(c.text + ' ');
  }
  return out.join('').trim();
}

/** Разбивка на куски по границам таймкодов — длинные лекции не влезают в один ответ. */
function chunkTranscript(cues, maxChars = 14000) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const c of cues) {
    current.push(c);
    size += c.text.length + 1;
    if (size >= maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length) {
    if (current.length < 20 && chunks.length) chunks[chunks.length - 1].push(...current);
    else chunks.push(current);
  }
  return chunks;
}

async function callClaude({ system, messages, maxTokens = 16000 }) {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.content.map((b) => b.text || '').join('');
    }

    const body = await res.text();
    // 429/5xx — перегрузка, имеет смысл подождать; остальное не лечится ретраем.
    if (![429, 500, 502, 503, 529].includes(res.status) || attempt === 5) {
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
    }
    const wait = Math.min(60, 2 ** attempt) * 1000;
    console.warn(`  ⚠ API ${res.status}, повтор через ${wait / 1000}с`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('в ответе модели нет JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

const EDIT_SYSTEM = `Ты — редактор, который превращает автоматическую расшифровку устной лекции в читаемый текст.

Автор — ${config.authorName}, ${config.siteTagline.toLowerCase()}. Речь идёт от первого лица.

ЖЁСТКИЕ ПРАВИЛА:
- Сохраняй смысл, логику и авторский голос дословно. Это редактура, а не пересказ и не сокращение.
- Ничего не добавляй от себя: ни фактов, ни примеров, ни выводов, которых нет в расшифровке.
- Ничего существенного не выбрасывай. Убирать можно только слова-паразиты, оговорки, повторы одного и того же слова подряд и ошибки распознавания речи.
- Исправляй пунктуацию, заглавные буквы и явно неверно распознанные слова (особенно термины психологии и имена).
- Разбивай сплошной поток на абзацы по 3–6 предложений.
- Группируй абзацы в смысловые разделы и давай каждому короткий подзаголовок (3–7 слов), отражающий содержание раздела.
- Сохраняй разговорную интонацию автора: это расшифровка живой речи, а не научная статья.

Отвечай ТОЛЬКО валидным JSON, без пояснений и без markdown-обёртки.`;

async function editChunk(chunk, { title, index, total, tailContext }) {
  const text = transcriptWithMarks(chunk);
  const startTc = timecode(chunk[0].t);
  const prompt = `Видео: «${title}»
Это фрагмент ${index + 1} из ${total}. Он начинается с отметки ${startTc}.${
    tailContext ? `\n\nЧем закончился предыдущий фрагмент (только для связности, переписывать его не надо):\n"…${tailContext}"` : ''
  }

Отредактируй фрагмент по правилам. Верни JSON вида:
{"sections":[{"heading":"Короткий подзаголовок","start":"${startTc}","paragraphs":["Абзац.","Абзац."]}]}

Поле start — таймкод начала раздела, бери ближайшую метку [чч:мм:сс] из расшифровки, без квадратных скобок.
${index > 0 ? 'Не повторяй вводных приветствий: фрагмент идёт в середине текста.' : ''}

Расшифровка:
${text}`;

  const answer = await callClaude({
    system: EDIT_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = extractJSON(answer);
  return (parsed.sections || []).filter((s) => s.paragraphs?.length);
}

async function summarize({ title, description, sections }) {
  const outline = sections
    .map((s) => `## ${s.heading}\n${s.paragraphs.join(' ').slice(0, 700)}`)
    .join('\n\n')
    .slice(0, 60000);

  const answer = await callClaude({
    system: EDIT_SYSTEM,
    maxTokens: 3000,
    messages: [
      {
        role: 'user',
        content: `Видео: «${title}»
${description ? `Описание с YouTube: ${description.slice(0, 800)}\n` : ''}
Ниже отредактированный текст лекции. Составь по нему карточку. Верни JSON:
{
  "summary": "2-4 предложения о том, чему посвящена лекция. Без воды и без фразы 'в этом видео'.",
  "takeaways": ["4-6 тезисов, каждый — законченная мысль из лекции, 1-2 предложения"],
  "topics": ["4-8 ключевых тем и терминов, по 1-3 слова, с маленькой буквы"],
  "seoDescription": "Одно предложение до 160 символов для поисковой выдачи."
}

Текст:
${outline}`,
      },
    ],
  });
  return extractJSON(answer);
}

/**
 * Fallback без LLM: режем поток по длинным паузам между репликами — они почти
 * всегда совпадают с границами мыслей. Подзаголовков тут нет, только абзацы.
 */
function fallbackSections(cues) {
  const paragraphs = [];
  let buf = [];
  let bufStart = cues[0]?.t ?? 0;
  const sections = [];

  const flushParagraph = () => {
    if (!buf.length) return;
    let text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      text = text[0].toUpperCase() + text.slice(1);
      if (!/[.!?…]$/.test(text)) text += '.';
      paragraphs.push(text);
    }
    buf = [];
  };

  const flushSection = () => {
    flushParagraph();
    if (paragraphs.length) {
      sections.push({ heading: null, start: timecode(bufStart), paragraphs: [...paragraphs] });
      paragraphs.length = 0;
    }
  };

  let words = 0;
  let sectionStartT = cues[0]?.t ?? 0;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    buf.push(c.text);
    words += c.text.split(/\s+/).length;
    const next = cues[i + 1];
    const gap = next ? next.t - (c.t + c.d) : 0;
    if (words > 55 && (gap > 0.6 || words > 110)) {
      flushParagraph();
      words = 0;
    }
    // Раздел — примерно каждые 5 минут, чтобы страница делилась на обозримые блоки.
    if (next && next.t - sectionStartT > 300 && !buf.length) {
      bufStart = sectionStartT;
      flushSection();
      sectionStartT = next.t;
      bufStart = next.t;
    }
  }
  bufStart = sectionStartT;
  flushSection();
  return sections;
}

function fallbackCard(video, sections) {
  const first = sections[0]?.paragraphs[0] || '';
  return {
    summary: (video.description.split('\n').find((l) => l.trim().length > 60) || first).slice(0, 400),
    takeaways: [],
    topics: (video.tags || []).slice(0, 8),
    seoDescription: (video.description.replace(/\s+/g, ' ').trim() || first).slice(0, 157),
  };
}

async function processVideo(video) {
  if (!video.cues?.length) {
    return {
      id: video.id,
      quality: 'none',
      sections: [],
      summary: video.description.slice(0, 400),
      takeaways: [],
      topics: video.tags?.slice(0, 8) || [],
      seoDescription: video.description.replace(/\s+/g, ' ').slice(0, 157),
      generatedAt: new Date().toISOString(),
    };
  }

  if (!USE_LLM) {
    const sections = fallbackSections(video.cues);
    return {
      id: video.id,
      quality: 'raw',
      sections,
      ...fallbackCard(video, sections),
      generatedAt: new Date().toISOString(),
    };
  }

  const chunks = chunkTranscript(video.cues);
  const sections = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  фрагмент ${i + 1}/${chunks.length}… `);
    const tail = sections.at(-1)?.paragraphs.at(-1)?.slice(-300) || '';
    const part = await editChunk(chunks[i], {
      title: video.title,
      index: i,
      total: chunks.length,
      tailContext: tail,
    });
    sections.push(...part);
    console.log(`+${part.length} разделов`);
  }

  process.stdout.write('  саммари… ');
  const card = await summarize({
    title: video.title,
    description: video.description,
    sections,
  });
  console.log('ок');

  return {
    id: video.id,
    quality: 'edited',
    model: MODEL,
    sections,
    summary: card.summary || '',
    takeaways: card.takeaways || [],
    topics: card.topics || [],
    seoDescription: card.seoDescription || '',
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  ensureDir(ARTICLES);
  let videos = listRaw();
  if (only.length) videos = videos.filter((v) => only.includes(v.id));

  console.log(
    USE_LLM
      ? `Режим: LLM-редактура (${MODEL})`
      : 'Режим: без LLM (нет ANTHROPIC_API_KEY) — абзацы по паузам речи',
  );

  let done = 0;
  let skipped = 0;
  for (const video of videos) {
    const dest = path.join(ARTICLES, `${video.id}.json`);
    const existing = readJSON(dest);
    // Готовую LLM-редактуру не перетираем fallback-версией при прогоне без ключа.
    const goodEnough =
      existing && (existing.quality === 'edited' || (!USE_LLM && existing.quality === 'raw'));
    if (!force && goodEnough) {
      skipped++;
      continue;
    }
    if (done >= limit) break;

    console.log(`→ ${video.id}: ${video.title}`);
    try {
      writeJSON(dest, await processVideo(video));
      done++;
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      // Без обработанной статьи страница просто не появится — остальные не страдают.
    }
  }

  console.log(`\nГотово: обработано ${done}, пропущено ${skipped}`);
}

main();
