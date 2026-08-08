#!/usr/bin/env node
/**
 * Собирает статический сайт в dist/ из data/raw + data/articles.
 *
 * Для каждого видео генерируются две версии одной страницы:
 *   /v/<slug>/          — HTML для людей (embed + транскрипт + разметка Schema.org)
 *   /v/<slug>.md        — тот же текст в markdown, чтобы LLM забирала его без парсинга
 *
 * Плюс index.html, sitemap.xml, robots.txt, rss.xml и llms.txt.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTICLES, DIST, ROOT, config, ensureDir, escapeHtml, formatDate, formatDuration,
  listRaw, readJSON, readingTime, slugify, timecode,
} from './lib.mjs';

const BASE = config.baseUrl.replace(/\/$/, '');

/** "1:23:45" или "12:30" → секунды, для ссылок вида ?t=NNN. */
function tcToSeconds(tc) {
  if (!tc) return 0;
  const parts = String(tc).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function layout({ title, description, canonical, head = '', body, wide = false }) {
  return `<!doctype html>
<html lang="${config.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="${BASE}/styles.css">
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.siteTitle)}" href="${BASE}/rss.xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(config.siteTitle)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
${head}
</head>
<body>
<a class="skip-link" href="#main">К содержанию</a>
<header class="site-header">
  <div class="wrap${wide ? ' wrap--wide' : ''} site-header__inner">
    <p class="site-header__title"><a href="${BASE}/">${escapeHtml(config.siteTitle)}</a></p>
    <nav>
      <a href="${BASE}/">Все лекции</a>
      <a href="https://www.youtube.com/@${config.channelHandle}" rel="me noopener">YouTube</a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap${wide ? ' wrap--wide' : ''}">
    <p>© ${new Date().getFullYear()} ${escapeHtml(config.authorName)}</p>
    <p>Тексты — расшифровки видео с <a href="https://www.youtube.com/@${config.channelHandle}" rel="noopener">YouTube-канала автора</a>.</p>
    <p><a href="${BASE}/rss.xml">RSS</a> · <a href="${BASE}/llms.txt">llms.txt</a></p>
  </div>
</footer>
</body>
</html>
`;
}

function renderCard(v, a) {
  const summary = a?.summary || v.description.split('\n')[0] || '';
  return `<li class="card">
  <a class="card__thumb" href="${BASE}/v/${v.slug}/">
    <img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" width="480" height="270">
    ${v.duration ? `<span class="card__duration">${formatDuration(v.duration)}</span>` : ''}
  </a>
  <div>
    <h2 class="card__title"><a href="${BASE}/v/${v.slug}/">${escapeHtml(v.title)}</a></h2>
    <p class="card__summary">${escapeHtml(summary.slice(0, 260))}${summary.length > 260 ? '…' : ''}</p>
    <ul class="meta">
      ${v.publishedAt ? `<li>${formatDate(v.publishedAt)}</li>` : ''}
      ${v.duration ? `<li>видео ${formatDuration(v.duration)}</li>` : ''}
      ${a?.sections?.length ? `<li>расшифровка есть</li>` : ''}
    </ul>
  </div>
</li>`;
}

function renderIndex(items) {
  const body = `<div class="wrap wrap--wide">
  <div class="hero">
    <h1>${escapeHtml(config.siteTitle)}</h1>
    <p>${escapeHtml(config.siteTagline)}</p>
  </div>
  <p class="meta" style="margin-bottom:2rem"><span>${items.length} лекций · каждая с полной текстовой расшифровкой</span></p>
  <ul class="video-list">
${items.map(({ video, article }) => renderCard(video, article)).join('\n')}
  </ul>
</div>`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: config.authorName,
      description: config.siteTagline,
      url: BASE + '/',
      sameAs: [`https://www.youtube.com/@${config.channelHandle}`],
    },
  };

  return layout({
    title: `${config.siteTitle} — лекции и расшифровки`,
    description: config.siteDescription,
    canonical: BASE + '/',
    wide: true,
    head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    body,
  });
}

function renderTranscript(video, article) {
  const out = [];
  article.sections.forEach((section, i) => {
    const seconds = tcToSeconds(section.start);
    const anchor = `t-${i + 1}`;
    if (section.heading) {
      out.push(
        `<h2 id="${anchor}">${escapeHtml(section.heading)}` +
          `<a class="stamp" href="${video.url}&t=${seconds}s" rel="noopener" title="Открыть этот момент на YouTube">${section.start}</a></h2>`,
      );
    } else if (section.start) {
      out.push(
        `<h2 id="${anchor}" class="visually-plain">${section.start}` +
          `<a class="stamp" href="${video.url}&t=${seconds}s" rel="noopener">смотреть</a></h2>`,
      );
    }
    for (const p of section.paragraphs) out.push(`<p>${escapeHtml(p)}</p>`);
  });
  return out.join('\n');
}

function renderVideoPage(video, article) {
  const plainText = article.sections.flatMap((s) => s.paragraphs).join(' ');
  const desc =
    article.seoDescription ||
    article.summary?.slice(0, 157) ||
    video.description.replace(/\s+/g, ' ').slice(0, 157);
  const canonical = `${BASE}/v/${video.slug}/`;

  const toc = article.sections.filter((s) => s.heading);
  const hasText = Boolean(plainText.trim());

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description: article.summary || video.description.slice(0, 500),
    thumbnailUrl: [video.thumbnail],
    uploadDate: video.publishedAt,
    duration: video.duration ? `PT${Math.floor(video.duration / 60)}M${video.duration % 60}S` : undefined,
    embedUrl: `https://www.youtube.com/embed/${video.id}`,
    contentUrl: video.url,
    url: canonical,
    inLanguage: config.lang,
    author: { '@type': 'Person', name: config.authorName },
    publisher: { '@type': 'Person', name: config.authorName },
    transcript: hasText ? plainText.slice(0, 5000) : undefined,
  };

  const body = `<article class="article">
<div class="wrap">
  <h1>${escapeHtml(video.title)}</h1>
  <ul class="meta">
    ${video.publishedAt ? `<li>${formatDate(video.publishedAt)}</li>` : ''}
    ${video.duration ? `<li>видео ${formatDuration(video.duration)}</li>` : ''}
    ${hasText ? `<li>чтение ~${readingTime(plainText)} мин</li>` : ''}
  </ul>
</div>

<div class="wrap">
  <div class="player">
    <button type="button" data-video="${video.id}" aria-label="Смотреть видео на YouTube">
      <img src="${escapeHtml(video.thumbnail)}" alt="" width="1280" height="720">
    </button>
  </div>

  ${
    article.summary
      ? `<div class="callout">
    <h2>О чём эта лекция</h2>
    <p>${escapeHtml(article.summary)}</p>
  </div>`
      : ''
  }

  ${
    article.takeaways?.length
      ? `<div class="callout">
    <h2>Главные мысли</h2>
    <ul>${article.takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  </div>`
      : ''
  }

  ${
    toc.length > 2
      ? `<details class="toc">
    <summary>Содержание расшифровки (${toc.length})</summary>
    <ol>${article.sections
      .map((s, i) => (s.heading ? `<li><a href="#t-${i + 1}">${escapeHtml(s.heading)}</a></li>` : ''))
      .join('')}</ol>
  </details>`
      : ''
  }

  ${
    hasText
      ? `<div class="transcript">
    <h2 id="transcript" style="margin-top:3rem">Полная расшифровка</h2>
    ${
      article.quality === 'raw'
        ? `<p class="section-note">Текст получен из автоматических субтитров YouTube и разбит на абзацы по паузам речи — возможны неточности распознавания.</p>`
        : `<p class="section-note">Текст — литературная редактура автоматической расшифровки: пунктуация и абзацы восстановлены, содержание и формулировки автора сохранены.</p>`
    }
    ${renderTranscript(video, article)}
  </div>`
      : `<p class="section-note">Для этого видео расшифровка пока недоступна.</p>`
  }

  ${
    article.topics?.length
      ? `<ul class="topics">${article.topics.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : ''
  }

  <p class="meta" style="margin-top:2.5rem">
    <a href="${video.url}" rel="noopener">Смотреть на YouTube</a> ·
    <a href="${BASE}/v/${video.slug}.md">Версия в markdown</a> ·
    <a href="${BASE}/">Все лекции</a>
  </p>
</div>
</article>

<script>
// Ленивый плеер: iframe и куки YouTube появляются только после клика.
document.querySelectorAll('.player button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var f = document.createElement('iframe');
    f.src = 'https://www.youtube-nocookie.com/embed/' + btn.dataset.video + '?autoplay=1&rel=0';
    f.title = ${JSON.stringify(video.title)};
    f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture';
    f.allowFullscreen = true;
    btn.replaceWith(f);
  });
});
</script>`;

  return layout({
    title: `${video.title} — ${config.siteTitle}`,
    description: desc,
    canonical,
    head:
      `<meta property="og:image" content="${escapeHtml(video.thumbnail)}">\n` +
      `<link rel="alternate" type="text/markdown" href="${BASE}/v/${video.slug}.md">\n` +
      `<script type="application/ld+json">${JSON.stringify(ld, (k, v) => (v === undefined ? undefined : v))}</script>`,
    body,
  });
}

/** Markdown-двойник страницы: то, что удобно скормить модели или скачать. */
function renderMarkdown(video, article) {
  const lines = [
    `# ${video.title}`,
    '',
    `- Автор: ${config.authorName}`,
    video.publishedAt ? `- Опубликовано: ${formatDate(video.publishedAt)}` : null,
    video.duration ? `- Длительность видео: ${formatDuration(video.duration)}` : null,
    `- Видео: ${video.url}`,
    `- Страница: ${BASE}/v/${video.slug}/`,
    `- Источник текста: ${article.quality === 'edited' ? 'литературная редактура автоматической расшифровки' : 'автоматические субтитры YouTube'}`,
    '',
  ].filter((l) => l !== null);

  if (article.summary) lines.push('## Кратко', '', article.summary, '');
  if (article.takeaways?.length) {
    lines.push('## Главные мысли', '', ...article.takeaways.map((t) => `- ${t}`), '');
  }
  if (article.topics?.length) lines.push(`**Темы:** ${article.topics.join(', ')}`, '');

  lines.push('## Расшифровка', '');
  for (const s of article.sections) {
    if (s.heading) lines.push(`### ${s.heading}${s.start ? ` (${s.start})` : ''}`, '');
    else if (s.start) lines.push(`### ${s.start}`, '');
    for (const p of s.paragraphs) lines.push(p, '');
  }
  return lines.join('\n');
}

function renderSitemap(items) {
  const urls = [
    { loc: BASE + '/', lastmod: new Date().toISOString() },
    ...items.map(({ video, article }) => ({
      loc: `${BASE}/v/${video.slug}/`,
      lastmod: article.generatedAt || video.fetchedAt,
    })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${(u.lastmod || '').slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`;
}

function renderRss(items) {
  const entries = items
    .slice(0, 30)
    .map(({ video, article }) => {
      const link = `${BASE}/v/${video.slug}/`;
      return `  <item>
    <title>${escapeHtml(video.title)}</title>
    <link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    ${video.publishedAt ? `<pubDate>${new Date(video.publishedAt).toUTCString()}</pubDate>` : ''}
    <description>${escapeHtml(article.summary || video.description.slice(0, 400))}</description>
  </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${escapeHtml(config.siteTitle)}</title>
  <link>${BASE}/</link>
  <description>${escapeHtml(config.siteDescription)}</description>
  <language>${config.lang}</language>
${entries}
</channel></rss>
`;
}

/** llms.txt — карта сайта для языковых моделей: что тут лежит и где брать текст. */
function renderLlmsTxt(items) {
  return `# ${config.siteTitle}

> ${config.siteDescription}

Каждая страница — видеолекция с YouTube-канала автора вместе с полной текстовой
расшифровкой на русском языке. У любой страницы есть markdown-версия: тот же
адрес без завершающего слэша плюс расширение .md.

## Лекции

${items
  .map(
    ({ video, article }) =>
      `- [${video.title}](${BASE}/v/${video.slug}.md): ${(article.summary || video.description.split('\n')[0] || '').replace(/\s+/g, ' ').slice(0, 200)}`,
  )
  .join('\n')}

## Прочее

- [Лента RSS](${BASE}/rss.xml)
- [YouTube-канал](https://www.youtube.com/@${config.channelHandle})
`;
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  ensureDir(DIST);

  const items = listRaw()
    // slug считаем при сборке, а не берём из raw: правила транслитерации могут
    // поменяться, и тогда адреса обновятся без повторной выкачки с YouTube.
    .map((video) => ({ ...video, slug: slugify(video.title || video.id, video.id) }))
    .map((video) => ({ video, article: readJSON(path.join(ARTICLES, `${video.id}.json`)) }))
    .filter((it) => {
      if (!it.article) {
        console.warn(`  ⚠ ${it.video.id}: нет обработанной статьи, пропускаю (запусти npm run polish)`);
        return false;
      }
      return true;
    });

  if (!items.length) {
    console.error('Нет данных для сборки. Сначала: npm run fetch && npm run polish');
    process.exit(1);
  }

  fs.writeFileSync(path.join(DIST, 'index.html'), renderIndex(items));
  fs.copyFileSync(path.join(ROOT, 'site', 'styles.css'), path.join(DIST, 'styles.css'));

  for (const { video, article } of items) {
    const dir = path.join(DIST, 'v', video.slug);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), renderVideoPage(video, article));
    fs.writeFileSync(path.join(DIST, 'v', `${video.slug}.md`), renderMarkdown(video, article));
  }

  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), renderSitemap(items));
  fs.writeFileSync(path.join(DIST, 'rss.xml'), renderRss(items));
  fs.writeFileSync(path.join(DIST, 'llms.txt'), renderLlmsTxt(items));
  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`,
  );
  // GitHub Pages иначе прогоняет вывод через Jekyll и съедает часть файлов.
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

  const edited = items.filter((i) => i.article.quality === 'edited').length;
  console.log(`Собрано страниц: ${items.length} (из них с LLM-редактурой: ${edited})`);
  console.log(`Каталог: ${DIST}`);
}

main();
