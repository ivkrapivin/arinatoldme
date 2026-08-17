#!/usr/bin/env node
/**
 * Ручное обновление: забрать новые видео с YouTube и отправить в репозиторий.
 *
 * Нужен потому, что YouTube блокирует запросы с серверов GitHub, а с домашнего
 * интернета они проходят. Всё остальное — редактуру, сборку и публикацию —
 * делает GitHub Actions после пуша, поэтому ключ Anthropic локально не нужен.
 *
 * Запуск: npm run sync
 */
import { execFileSync } from 'node:child_process';
import { ROOT, listRaw } from './lib.mjs';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });

const step = (msg) => console.log(`\n▸ ${msg}`);

try {
  step('Подтягиваю изменения из репозитория');
  const dirty = run('git', ['status', '--porcelain', '--', 'data']).trim();
  if (dirty) {
    console.log('  в data/ есть несохранённые правки, оставляю как есть');
  }
  run('git', ['pull', '--rebase', '--autostash', 'origin', 'main']);
  console.log('  готово');

  const before = listRaw().length;

  step('Забираю новые видео с YouTube');
  // Вывод показываем как есть: там видно, что скачивается и что пошло не так.
  execFileSync('node', ['scripts/fetch.mjs', ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const after = listRaw().length;
  const added = after - before;

  step('Отправляю в репозиторий');
  run('git', ['add', 'data']);
  const staged = run('git', ['diff', '--staged', '--name-only']).trim();

  if (!staged) {
    console.log('  новых видео нет — всё уже на сайте');
    console.log('\nГотово: обновлять нечего.');
    process.exit(0);
  }

  run('git', ['commit', '-m', `Новые лекции: ${added > 0 ? added : 'обновление'} (${new Date().toISOString().slice(0, 10)})`]);
  run('git', ['push', 'origin', 'main']);
  console.log('  отправлено');

  console.log(
    `\nГотово: новых лекций ${added}.\n` +
      'GitHub Actions сейчас отредактирует расшифровки и опубликует сайт — обычно 5–15 минут.\n' +
      'Следить: gh run watch --repo ivkrapivin/arinatoldme',
  );
} catch (err) {
  const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
  console.error(`\n✗ Не получилось: ${err.message}`);
  if (detail) console.error(detail);
  console.error(
    '\nЕсли YouTube ругается на проверку «не робот» — повторите через несколько минут\n' +
      'или проверьте, что интернет не идёт через VPN с серверным адресом.',
  );
  process.exit(1);
}
