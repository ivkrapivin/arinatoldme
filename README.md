# Сайт лекций Арины Крапивиной

Статический сайт: видео с YouTube-канала [@arinatoldme](https://www.youtube.com/@arinatoldme)
вместе с полными текстовыми расшифровками — для людей и для языковых моделей.

## Как это устроено

Три независимых шага, каждый со своим кэшем, поэтому еженедельный прогон
обрабатывает только новые видео.

| Шаг | Скрипт | Что делает | Куда пишет |
|---|---|---|---|
| 1 | `npm run fetch` | yt-dlp: список видео канала, метаданные, русские субтитры | `data/raw/<id>.json` |
| 2 | `npm run polish` | Claude API: пунктуация, абзацы, подзаголовки, саммари, тезисы | `data/articles/<id>.json` |
| 3 | `npm run build` | Генерация HTML, markdown, sitemap, RSS, llms.txt | `dist/` |

`data/` коммитится в репозиторий — это кэш, который бережёт и трафик, и деньги на API.

## Локально

```bash
npm run all && npm run serve
```

Чтобы ссылки на локальной сборке вели на localhost, а не на боевой домен:

```bash
SITE_BASE_URL=http://localhost:4321 npm run build
```

Полезные флаги для `fetch.mjs` и `polish.mjs`: `--force` (переделать заново),
`--only=ID,ID` (конкретные видео), `--limit=N` (не больше N за прогон).
У `polish.mjs` есть ещё `--no-llm`.

## Ключ Anthropic

Без `ANTHROPIC_API_KEY` шаг 2 не падает, а переключается на запасной режим: текст
бьётся на абзацы по паузам речи. Сайт собирается полностью, но текст остаётся
разговорным потоком без подзаголовков и саммари.

С ключом получается литературная редактура: пунктуация, абзацы, смысловые разделы,
краткое содержание и тезисы. Готовую редактуру запасной режим не перетирает.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run polish
```

В GitHub Actions ключ берётся из секрета `ANTHROPIC_API_KEY`
(Settings → Secrets and variables → Actions).

## Публикация

`.github/workflows/update.yml` каждый понедельник в 06:00 UTC забирает новые видео,
редактирует их, коммитит транскрипты и деплоит сайт на GitHub Pages. Тот же workflow
можно запустить руками через кнопку Run workflow.

Перед первым запуском:

1. Создать репозиторий и запушить в него эту папку.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → добавить `ANTHROPIC_API_KEY`.
4. Поправить `baseUrl` в `config.json` под реальный адрес сайта.

## Что отдаётся машинам

- `/v/<slug>.md` — та же страница в markdown, без разметки и скриптов
- `/llms.txt` — карта сайта для языковых моделей со списком всех лекций
- `Schema.org VideoObject` с полем `transcript` на каждой странице
- `/sitemap.xml`, `/rss.xml`, `/robots.txt`

## Английская версия

Пока не включена. Задел под неё: `locales` в `config.json` и разделение
данных по языку в `data/articles/`.
