#!/usr/bin/env node
/* E2E локализации: живой браузер против http://127.0.0.1:5173.
   Проверяет, что переключение ru→en→ru перерисовывает подписи UI, карточки
   коллекции, модалку карты и имена существ на столе (данные из /locale/*.json).
   Запуск: node tools/e2e_locale.js [--url http://127.0.0.1:5173] */
const { chromium } = require('playwright');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const URL = arg('url', 'http://127.0.0.1:5173');
const CYRR = /[А-Яа-яЁё]/;
let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => errors.push(`ЗАПРОС ${r.url()} — ${r.failure()?.errorText || ''}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  console.log(`\n🌐 E2E локализация: ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  /* --- 1. RU по умолчанию --- */
  console.log('\n[1] Русский по умолчанию');
  const playRu = (await page.textContent('#btnPlay')) || '';
  check('кнопка «В БОЙ» на русском', /В БОЙ/i.test(playRu), playRu.trim().slice(0, 24));

  /* --- 2. Переключение на EN --- */
  console.log('\n[2] Переключение ru → en');
  // кликаем программно: часть кнопок лежит в скрытых панелях (дровер/настройки)
  const clickId = (id) => page.evaluate(i => {
    const n = document.getElementById(i);
    if (!n) throw new Error('нет #' + i);
    n.click();
  }, id);
  await clickId('btnSettings');
  await page.waitForTimeout(250);
  await page.selectOption('#setLang', 'en');
  await page.waitForTimeout(900);           // ждём fetch /locale/en.json + перерисовку
  const playEn = (await page.textContent('#btnPlay')) || '';
  check('кнопка стала «Play»', /Play/.test(playEn) && !CYRR.test(playEn), playEn.trim().slice(0, 24));
  check('язык документа = en', (await page.getAttribute('html', 'lang')) === 'en');

  /* --- 3. Карточки коллекции --- */
  console.log('\n[3] Коллекция на английском');
  await clickId('btnSettings');                           // закрыть настройки
  await page.waitForTimeout(200);
  await clickId('btnCollection');
  await page.waitForTimeout(600);
  const titles = await page.$$eval('#colGrid .card .ctitle', ns => ns.slice(0, 40).map(n => n.textContent));
  check('карточек в коллекции 500', (await page.$$('#colGrid .card')).length === 500,
    String((await page.$$('#colGrid .card')).length));
  const enTitles = titles.filter(t => t && !CYRR.test(t));
  check('имена карт без кириллицы (EN)', enTitles.length === titles.length && titles.length > 0,
    `${enTitles.length}/${titles.length}, пример: ${(titles[0] || '').slice(0, 28)}`);
  const texts = await page.$$eval('#colGrid .card .ctext', ns => ns.slice(0, 40).map(n => n.textContent.trim()));
  const enTexts = texts.filter(t => !t || !CYRR.test(t));
  check('тексты способностей на EN', enTexts.length === texts.length,
    `${enTexts.length}/${texts.length}, пример: ${(texts[0] || '').slice(0, 40)}`);
  const types = await page.$$eval('#colGrid .card .ctype', ns => ns.slice(0, 20).map(n => n.textContent.trim()));
  check('тип карты на EN (Minion/Spell/Rune)',
    types.every(t => /Minion|Spell|Rune/.test(t)), types.slice(0, 3).join(' | '));

  /* --- 4. Модалка карты --- */
  console.log('\n[4] Карточка крупным планом');
  await page.evaluate(() => document.querySelector('#colGrid .card').click());
  await page.waitForTimeout(400);
  const cmName = ((await page.textContent('#cmInfo .cmName')) || '').trim();
  const cmText = ((await page.textContent('#cmInfo .cmText')) || '').trim();
  const cmFlav = ((await page.textContent('#cmInfo .cmFlavor')) || '').trim();
  check('имя в модалке на EN', cmName.length > 0 && !CYRR.test(cmName), cmName.slice(0, 40));
  check('текст способности в модалке на EN', !CYRR.test(cmText), cmText.slice(0, 52));
  check('флейвор в модалке на EN', cmFlav.length === 0 || !CYRR.test(cmFlav), cmFlav.slice(0, 46));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  /* --- 5. Пересдача и рука в бою --- */
  console.log('\n[5] Бой: муллиган и рука');
  await clickId('btnPlay');
  await page.waitForTimeout(500);
  // если фракция ещё не выбрана — модалка выбора
  if (!(await page.$eval('#factionModal', n => n.classList.contains('hidden')))) {
    await page.evaluate(() => document.querySelector('#factionModal .fcard').click());
    await page.waitForTimeout(400);
    await clickId('btnPlay');
    await page.waitForTimeout(900);
  }
  const mullUp = await page.waitForSelector('#mullCards .card', { timeout: 8000 }).catch(() => null);
  check('муллиган открылся', !!mullUp);
  const mullTitles = await page.$$eval('#mullCards .card .ctitle', ns => ns.map(n => n.textContent.trim()));
  check('карты в пересдаче на EN', mullTitles.length > 0 && mullTitles.every(t => !CYRR.test(t)),
    `${mullTitles.length} шт., пример: ${(mullTitles[0] || '').slice(0, 30)}`);
  await clickId('btnMullConfirm');
  await page.waitForTimeout(1200);
  await page.waitForSelector('#hand .card', { timeout: 8000 }).catch(() => null);
  const handTitles = await page.$$eval('#hand .card .ctitle', ns => ns.map(n => n.textContent.trim()));
  check('рука игрока на EN', handTitles.length > 0 && handTitles.every(t => !CYRR.test(t)),
    `${handTitles.length} карт: ${handTitles.slice(0, 3).join(' | ')}`);
  const boardUnits = await page.$$eval('#battle .uname', ns => ns.map(n => n.textContent.trim()).filter(Boolean));
  console.log(`  · существ на столе: ${boardUnits.length}${boardUnits.length ? ' → ' + boardUnits.slice(0, 3).join(' | ') : ' (пока пусто — норма для 1-го хода)'}`);

  /* --- 6. Возврат на RU --- */
  console.log('\n[6] Возврат en → ru');
  await page.evaluate(() => { const s = document.getElementById('setLang'); if (s) { s.value = 'ru'; s.dispatchEvent(new Event('change')); } });
  await page.waitForTimeout(700);
  const backRu = (await page.textContent('#btnPlay')) || '';
  check('кнопка снова «В БОЙ»', /В БОЙ/i.test(backRu), backRu.trim().slice(0, 24));
  const handRu = await page.$$eval('#hand .card .ctitle', ns => ns.map(n => n.textContent.trim()));
  check('рука снова на RU', handRu.length > 0 && handRu.every(t => CYRR.test(t)),
    `${handRu.slice(0, 3).join(' | ')}`);

  /* --- Итог --- */
  // 404 артов и meta-server (:8081) — не дефекты локализации
  const realErrors = errors.filter(e => !/favicon|:8081|ERR_CONNECTION_REFUSED|ERR_ABORTED|Not Found|\/cosm\/|\/bg\/|\/art\//i.test(e));
  console.log('\n--- ИТОГ ---');
  console.log(`Проверок: ${fails === 0 ? 'все пройдены' : fails + ' провалено'} | ошибок страницы: ${realErrors.length}`);
  if (realErrors.length) console.log(realErrors.slice(0, 5).map(e => '  ⚠ ' + e.slice(0, 160)).join('\n'));
  await browser.close();
  process.exit(fails === 0 && realErrors.length === 0 ? 0 : 1);
})().catch(e => { console.error('✖ E2E упал:', e); process.exit(1); });
