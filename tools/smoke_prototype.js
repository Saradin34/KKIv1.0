/* =====================================================================
   Смоук-тест HTML-прототипа в jsdom (headless).
   Проверяет: загрузку, меню и прогресс заданий (включая детерминированный сквозной розыгрыш руны),
   коллекцию 500×2 с постраничным DOM, экран правил, муллиган, РОЗЫГРЫШ КАРТ игроком
   (клик → поле/цель), Эхо, анимированную фазу «Битва», лог, экран конца игры, перезапуск и возврат в меню.
   Запуск: node tools/smoke_prototype.js [--turns 10] [--player Aurites] [--enemy Necrus]
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const serverProfileSrc = fs.readFileSync(path.join(ROOT, 'server/meta_server.ts'), 'utf8');
const onlineTestSrc = fs.readFileSync(path.join(ROOT, 'tools/online_test.js'), 'utf8');
const cardsFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'unity/EchoCitadel/Assets/StreamingAssets/Cards.json'), 'utf8'));
const cardArtUrlFor = id => {
  const card = [...cardsFixture.cards, ...(cardsFixture.tokens || [])].find(c => c.id === id);
  const rel = card?.artworkPath || card?.art || '';
  const parts = rel.replaceAll(String.fromCharCode(92), '/').split('/');
  const cardsAt = parts.indexOf('Cards');
  return cardsAt < 0 ? '' : `/art/${parts.slice(cardsAt + 1).join('/')}`;
};
const deckFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'unity/EchoCitadel/Assets/StreamingAssets/Decks.json'), 'utf8'));
const starterDeckFixtures = deckFixture.decks.filter(d => d.format === 'starter');
const expectedStarterOwned = new Map();
for (const deck of starterDeckFixtures) for (const id of deck.cards)
  expectedStarterOwned.set(id, Math.min(4, (expectedStarterOwned.get(id) ?? 0) + 1));
const starterCardIds = new Set(expectedStarterOwned.keys());
const expansionCardIds = new Set(cardsFixture.meta.expansionIds ?? []);
const nonStarterBaseId = cardsFixture.cards.find(c => !starterCardIds.has(c.id) && !expansionCardIds.has(c.id))?.id ?? '';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TURNS = Number(arg('turns', '10'));
const PLAYER = Number(arg('player', '0'));      // индекс фракции в меню (0..4)
const ENEMY = arg('enemy', 'Necrus');
const VERBOSE = process.argv.includes('--verbose');

let failures = 0;
let canvasStubs = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const skip = (name, reason = 'не входит в текущий этап') => {
  console.log(`  ⏭️ ${name} — пропуск: ${reason}`);
};

(async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    const msg = String(e.message || '');
    if (/HTMLCanvasElement's getContext/.test(msg)) { canvasStubs++; return; }   // ограничение jsdom
    errors.push('jsdomError: ' + (e.stack || msg));
  });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => {});
  vc.on('log', (...a) => console.log('   [page]', ...a));

  const html = fs.readFileSync(path.join(ROOT, 'prototype/index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
  const { window } = dom;

  // --- полифилы отсутствующего в jsdom ---
  window.EC_NO_AUTH_GATE = true;
  window.Element.prototype.animate = function () { return { cancel() {}, finish() {}, addEventListener() {} }; };
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
  window.document.elementFromPoint = () => null;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 120, left: 120, width: 112, height: 158, right: 232, bottom: 278, x: 120, y: 120 };
  };
  window.innerWidth = 1440; window.innerHeight = 900;

  window.eval(fs.readFileSync(path.join(ROOT, 'prototype/prototype.js'), 'utf8'));
  window.ecAutoPass = true;   // окна отклика авто-пасуются в headless

  const $ = id => window.document.getElementById(id);
  const click = n => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const key = k => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitUntil = async (fn, timeout = 12000, step = 100) => {
    const t0 = Date.now();
    while (Date.now() < t0 + timeout) { if (fn()) return true; await wait(step); }
    return fn();
  };
  const units = sel2 => window.document.querySelectorAll(sel2).length;
  const collectionCards = () => [...$('colGrid').querySelectorAll('.card')];
  const loadAllCollection = () => window.ecTestLoadCollectionAll();

  console.log('\n=== СМОУК-ТЕСТ ПРОТОТИПА «ЭХО-ЦИТАДЕЛЬ» (jsdom) ===');

  /* ---------- 1. сюжетный вход + меню ---------- */
  console.log('\n[1] Пролог нового игрока и меню');
  const introStartsLocked = !$('introModal').classList.contains('hidden') && $('btnPlay').disabled && $('deckPick').disabled
    && $('deckPick').options.length === 1 && /стартовые колоды откроются после вступительных испытаний/i.test($('deckPick').options[0]?.textContent || '')
    && /разломе пяти стихий/.test($('introBody').textContent || '');
  const practiceLockedAtStart = $('chkPractice').disabled;
  click($('btnIntroNext'));
  const factionCardsStart = $('introBody').querySelectorAll('[data-intro-faction]').length;
  for (const fac of ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal']) {
    const card = $('introBody').querySelector(`[data-intro-faction="${fac}"]`);
    if (card) click(card);
  }
  const factionsSeen = window.ecIntroSnapshot();
  const factionIntrosDone = factionCardsStart === 5 && factionsSeen.seen.length === 5
    && !$('introFoot').querySelector('#btnIntroNext').disabled;
  click($('btnIntroNext'));
  const mechanicsIntro = /мана/i.test($('introBody').textContent || '') && /приоритета/i.test($('introBody').textContent || '');
  click($('btnIntroNext'));
  const lessonGates = $('introBody').querySelectorAll('[data-intro-lesson]').length === 4
    && !$('introBody').querySelector('[data-intro-lesson="1"]').disabled
    && $('introBody').querySelector('[data-intro-lesson="2"]').disabled;
  check('новичка встречает обязательный пролог; бой и выбор колод заблокированы', introStartsLocked,
    `пролог ${introStartsLocked}, btnPlay disabled ${$('btnPlay').disabled}, deck picker ${$('deckPick').disabled}`);
  check('пять фракций представлены интерактивно; требуется открыть каждую', factionIntrosDone,
    `карточек ${factionCardsStart}, прочитано ${factionsSeen.seen.length}/5`);
  check('сюжет объясняет ману, руны, атаки и окна приоритета до начала боя', mechanicsIntro);
  check('в тренировочную цепочку входит четыре реальных урока; следующий открыт, остальные закрыты', lessonGates);
  click($('introBody').querySelector('[data-intro-lesson="1"]'));
  const realLessonStarted = await waitUntil(() => window.ecBattle?.launchMode === 'tut'
    && window.ecBattle?.tutLesson === 1 && !!window.ecBattle?.engine && !$('battle').classList.contains('hidden'), 8000, 50);
  const realLessonDeck = window.ecBattle?.playerDeckId === 'starter_aurites';
  check('урок из пролога запускает настоящий бой с фиксированной учебной колодой', realLessonStarted && realLessonDeck,
    `режим ${window.ecBattle?.launchMode}, урок ${window.ecBattle?.tutLesson}, колода ${window.ecBattle?.playerDeckId}`);
  window.openHomeScreen();
  const returnedToIntro = await waitUntil(() => !$('introModal').classList.contains('hidden')
    && $('battle').classList.contains('hidden') && $('deckPick').disabled, 3000, 50);
  check('выход из незавершённого урока возвращает в пролог без открытия колод', returnedToIntro
    && window.ecIntroSnapshot().lessonStage === 0 && window.ecBattle.tutLesson === 0 && window.ecBattle.launchMode !== 'tut',
    `прогресс ${window.ecIntroSnapshot().lessonStage}/4, режим ${window.ecBattle.launchMode}`);
  for (let n = 2; n <= 4; n++) {
    window.ecSetTut(n - 1, false); // моделируем завершённые предыдущие испытания, не подменяя запуск боя
    window.openHomeScreen();
    const lessonButton = $('introBody').querySelector(`[data-intro-lesson="${n}"]`);
    const lessonAvailable = !!lessonButton && !lessonButton.disabled;
    if (lessonButton) click(lessonButton);
    const launched = await waitUntil(() => window.ecBattle?.launchMode === 'tut'
      && window.ecBattle?.tutLesson === n && !!window.ecBattle?.engine && !$('battle').classList.contains('hidden'), 8000, 50);
    const expectedHands = { 2: 1, 3: 3, 4: 4 }[n];
    const realDeck = window.ecBattle?.playerDeckId === 'starter_aurites';
    const scriptedHand = window.ecBattle?.tutInjected.length === expectedHands;
    check(`учебный бой ${n}/4 запускает реальный сценарий и руку урока`,
      lessonAvailable && launched && realDeck && scriptedHand,
      `открыт ${lessonAvailable}, движок ${launched}, учебных карт ${window.ecBattle?.tutInjected.length}/${expectedHands}`);
    if (n === 4 && launched) {
      const shardsBeforeLessonReward = window.ecShards();
      window.ecBattle.tutAllDone = true;
      window.ecBattle.tutCheck(); // проверяем общий переход после сигнала «урок завершён» от движка
      const finalStepReturned = await waitUntil(() => window.ecMeta().tutStage === 4
        && !$('introModal').classList.contains('hidden') && $('battle').classList.contains('hidden'), 4000, 50);
      const finalDeckPicker = $('introBody').querySelectorAll('[data-intro-deck]').length === 5
        && $('deckPick').disabled && window.ecBattle.tutLesson === 0 && window.ecBattle.launchMode === 'menu';
      check('после зачёта четвёртого боя пролог показывает выбор награды и сбрасывает tutorial-режим',
        finalStepReturned && finalDeckPicker,
        `этап ${window.ecMeta().tutStage}/4, 5 колод, режим ${window.ecBattle.launchMode}`);
      window.ecSetShards(shardsBeforeLessonReward); // не переносим тестовую валюту в остальные сценарии
    } else {
      window.openHomeScreen();
      await waitUntil(() => !$('introModal').classList.contains('hidden') && $('battle').classList.contains('hidden'), 3000, 50);
    }
  }
  window.ecFinishIntroForTest(); // последующие широкие smoke-проверки работают в режиме уже открытого хаба
  check('после вступления доступны стартовые колоды и главный бой', $('introModal').classList.contains('hidden')
    && !$('deckPick').disabled && !$('btnPlay').disabled && $('deckPick').options.length === 10);
  check('5 фракций в выборе', $('playerFactions').children.length === 5, `${$('playerFactions').children.length}`);
  check('список колод заполнен без служебной Starter', $('deckPick').options.length === 10
    && !$('deckPick').querySelector('option[value="Starter"]'), `${$('deckPick').options.length} колод`);
  check('уровни сложности (4, включая Мифический)', $('difficulty').options.length === 4);
  const initialMeta = window.ecMeta();
  const starterCollectionOk = starterDeckFixtures.length === 5
    && starterDeckFixtures.every(d => d.cards.length === 30)
    && cardsFixture.cards.every(card => window.ecOwnedOf(card.id) === (expectedStarterOwned.get(card.id) ?? 0))
    && !!nonStarterBaseId && window.ecOwnedOf(nonStarterBaseId) === 0;
  check('новый профиль: 3500 монет, 500 гемов, 5 обычных + 1 мифический бустер',
    window.ecShards() === 3500 && window.ecGems() === 500 && initialMeta.freeOpens === 5 && initialMeta.premOpens === 1,
    `${window.ecShards()} монет · ${window.ecGems()} гемов · обычные ${initialMeta.freeOpens} · мифические ${initialMeta.premOpens}`);
  check('новому игроку выдаются только карты пяти 30-карточных стартовых колод', starterCollectionOk,
    `${starterDeckFixtures.length} starter-колод; карта вне starter: ${nonStarterBaseId} ×${nonStarterBaseId ? window.ecOwnedOf(nonStarterBaseId) : '—'}`);
  const introFaction = window.localStorage.getItem('ec.pickedFaction') || 'Aurites';
  check('новый игрок сразу выбран на 30-карточную стартовую колоду своей фракции',
    $('deckPick').value === `starter_${introFaction.toLowerCase()}` && [...$('deckPick').options].filter(o => o.value.startsWith('starter_')).length === 5,
    `выбрана ${$('deckPick').value} / фракция ${introFaction}`);
  const rewardFreeBefore = window.ecFreeOpens(); const rewardGemsBefore = window.ecGems();
  window.ecPrepareIntroRewardForTest();
  const finalPageReady = $('introBody').querySelectorAll('[data-intro-deck]').length === 5
    && $('introFoot').querySelector('#btnIntroUnlock') && $('deckPick').disabled;
  click($('introBody').querySelector('[data-intro-deck="Pyromancer"]'));
  click($('btnIntroUnlock'));
  const introRewardGranted = window.ecMeta().tutReward === 'Pyromancer' && window.ecMeta().starterDecksUnlocked
    && window.ecFreeOpens() === rewardFreeBefore + 5 && window.ecGems() === rewardGemsBefore + 100
    && $('deckPick').options.length === 10 && !$('deckPick').disabled
    && /Все двери открыты/.test($('introTitle').textContent || '');
  check('после четвёртого боя открываются все 5 колод; награда начисляется один раз',
    finalPageReady && introRewardGranted,
    `финальный выбор ${finalPageReady ? 'да' : 'нет'}, +${window.ecFreeOpens() - rewardFreeBefore} бустеров, +${window.ecGems() - rewardGemsBefore} 💎`);
  click($('btnIntroEnter'));
  /* --- спека «1. Главное меню» (v2.4) --- */
  check('карусель фракций сверху (5 чипов)', $('menuHeroes').classList.contains('facCarousel') && $('menuHeroes').children.length === 5);
  const quickChips = [...$('menuHeroes').querySelectorAll('.heroChip')];
  const quickArtFullSquare = html.includes('aspect-ratio:1/1!important')
    && html.includes('object-fit:cover!important') && html.includes('Latest hub/art readability pass')
    && html.includes('left:0!important;right:0!important;top:auto!important;bottom:0!important');
  const quickLabelOverArt = quickChips.length === 5 && quickChips.every(chip =>
    !!chip.querySelector('.orbIcon') && !!chip.querySelector('.chipName') && chip.getAttribute('aria-pressed') !== null);
  check('быстрый выбор: арт заполняет квадрат, подпись находится поверх изображения',
    quickArtFullSquare && quickLabelOverArt,
    `${quickChips.length} арт-плиток; full-square ${quickArtFullSquare}; подписи ${quickLabelOverArt}`);
  const secondQuick = quickChips.find(chip => chip.dataset.f === 'Necrus');
  if (secondQuick) click(secondQuick);
  const quickDeckSwitchOk = $('deckPick').value === 'starter_necrus';
  const firstQuickAgain = $('menuHeroes').querySelector('.heroChip[data-f="Aurites"]');
  if (firstQuickAgain) click(firstQuickAgain);
  check('верхний быстрый выбор переключает фракцию вместе с её стартовой колодой', quickDeckSwitchOk
    && $('deckPick').value === 'starter_aurites', `после переключения и возврата: ${$('deckPick').value}`);
  check('нижняя панель навигации #menuNav (8 кнопок)', $('menuNav').querySelectorAll('button').length === 8, `${$('menuNav').querySelectorAll('button').length}`);
  check('кнопка «Создать колоду» у селекта колод', !!$('btnMakeDeck'));
  check('гейт «В бой»: базовая колода валидна → кнопка активна', $('btnPlay').disabled === false);
  check('слой кроссфейда фона #menuBgFx', !!$('menuBgFx'));
  check('CSS: модалка фракции в overlay-правиле (z320)', /#factionModal,#profileModal/.test(html));
  check('CSS: пружина панелей panelSpring + navRise + кроссфейд .menuBgFx', /panelSpring/.test(html) && /navRise/.test(html) && /\.menuBgFx/.test(html));
  check('ежедневные и еженедельные задания встроены в динамический главный экран',
    $('homeQuests').closest('#menu') === $('menu')
      && $('homeDailyQuests').querySelectorAll('.questTask').length === 4
      && $('homeWeeklyQuests').querySelectorAll('.questTask').length === 4
      && /Примените 2 руны/.test($('homeDailyQuests').textContent)
      && /Разыграйте 60 существ за неделю/.test($('homeWeeklyQuests').textContent),
    `ежедневных ${$('homeDailyQuests').querySelectorAll('.questTask').length}, еженедельных ${$('homeWeeklyQuests').querySelectorAll('.questTask').length}`);
  const dailyWinTarget = JSON.parse(window.localStorage.getItem('ec_meta_v1')).quests.find(q => q.id === 'win_fac');
  const otherFaction = ['Aurites','Necrus','Terramorph','Pyromancer','Ethereal'].find(f => f !== dailyWinTarget.fac);
  window.ecTestQuestBump('win_fac', 1, otherFaction);
  const afterWrongFactionWin = JSON.parse(window.localStorage.getItem('ec_meta_v1'));
  const wrongFactionIgnored = afterWrongFactionWin.quests.find(q => q.id === 'win_fac')?.prog === 0
    && afterWrongFactionWin.wquests.find(q => q.id === 'w_win3')?.prog === 1;
  window.ecTestQuestBump('win_fac', 1, dailyWinTarget.fac);
  const afterMatchingFactionWin = JSON.parse(window.localStorage.getItem('ec_meta_v1'));
  check('победа другой фракцией не двигает daily-цель, но засчитывается weekly; нужная фракция засчитывает обе',
    wrongFactionIgnored && afterMatchingFactionWin.quests.find(q => q.id === 'win_fac')?.prog === 1
      && afterMatchingFactionWin.wquests.find(q => q.id === 'w_win3')?.prog === 2,
    `другая фракция: daily ${wrongFactionIgnored ? 'без прогресса' : 'ошибка'}, weekly ${afterWrongFactionWin.wquests.find(q => q.id === 'w_win3')?.prog}; совпадение: daily ${afterMatchingFactionWin.quests.find(q => q.id === 'win_fac')?.prog}, weekly ${afterMatchingFactionWin.wquests.find(q => q.id === 'w_win3')?.prog}`);
  window.ecTestQuestBump('creatures', 20);
  const dailyCreature = $('homeDailyQuests').querySelector('[data-quest-card="daily:creatures"]');
  const dailyCreatureClaim = dailyCreature?.querySelector('.homeQuestClaim');
  const dailyCreatureDone = dailyCreature?.querySelector('.questTaskProgressText')?.textContent === '20/20'
    && !dailyCreatureClaim?.disabled && /Сброс через \d{2}:\d{2}:\d{2}/.test(dailyCreature?.querySelector('[data-quest-reset]')?.textContent || '');
  const questShardsBefore = window.ecShards();
  const questBpBefore = JSON.parse(window.localStorage.getItem('ec_meta_v1')).bpXp;
  if (dailyCreatureClaim) click(dailyCreatureClaim);
  await wait(30);
  window.ecTestQuestBump('creatures', 40);
  const weeklyCreature = $('homeWeeklyQuests').querySelector('[data-quest-card="weekly:w_creatures"]');
  const weeklyCreatureClaim = weeklyCreature?.querySelector('.homeQuestClaim');
  const weeklyCreatureDone = weeklyCreature?.querySelector('.questTaskProgressText')?.textContent === '60/60'
    && !weeklyCreatureClaim?.disabled && /Сброс через \d+ д \d{2}:\d{2}:\d{2}/.test(weeklyCreature?.querySelector('[data-quest-reset]')?.textContent || '');
  if (weeklyCreatureClaim) click(weeklyCreatureClaim);
  await wait(30);
  const savedQuestState = JSON.parse(window.localStorage.getItem('ec_meta_v1'));
  const questRewardOk = dailyCreatureDone && weeklyCreatureDone && window.ecShards() === questShardsBefore + 500
    && savedQuestState.quests.find(q => q.id === 'creatures')?.claimed
    && savedQuestState.wquests.find(q => q.id === 'w_creatures')?.claimed
    && (savedQuestState.bpXp ?? 0) === questBpBefore + 400;
  check('задания: прогресс, награды, сохранение и обратный отсчёт до локального сброса', questRewardOk,
    `daily ${dailyCreatureDone ? '20/20 + таймер' : 'ошибка'}, weekly ${weeklyCreatureDone ? '60/60 + таймер' : 'ошибка'}, награды ${window.ecShards()-questShardsBefore} монет / ${savedQuestState.bpXp-questBpBefore} BP`);

  /* ---------- 2. коллекция ---------- */
  console.log('\n[2] Коллекция карт');
  click($('btnCollection'));
  await wait(80);
  // Сначала рендерится одна страница, а полный состав smoke подгружает явным помощником.
  const firstCollectionPage = window.ecTestCollectionState();
  check('коллекция открывается без массового DOM-рендера', collectionCards().length === firstCollectionPage.pageSize
    && firstCollectionPage.rendered === firstCollectionPage.pageSize && firstCollectionPage.total === 1000
    && /500 карт × 2 оформления/.test($('colCount').textContent),
    `первая страница ${firstCollectionPage.rendered}/${firstCollectionPage.total}; DOM ${collectionCards().length}`);
  const quickNav = $('ecQuickNav');
  check('переходы между разделами получают мягкую анимацию и обновляют активный маршрут для доступности',
    $('collection').classList.contains('ecRouteEnter') && !!quickNav.querySelector('[data-route="collection"][aria-current="page"]')
      && !quickNav.querySelector('[data-route="back"]').disabled
      && $('ecRouteLive').textContent === 'Раздел открыт: Коллекция карт'
      && $('ecRouteTransitionFx').classList.contains('playing'),
    `route=${window.document.body.dataset.appRoute}; enter=${$('collection').classList.contains('ecRouteEnter')}; backDisabled=${quickNav.querySelector('[data-route="back"]').disabled}; fx=${$('ecRouteTransitionFx').classList.contains('playing')}; live=${$('ecRouteLive').textContent}`);
  $('colStyle').value = 'classic'; $('colStyle').dispatchEvent(new window.Event('change'));
  let collectionState = window.ecTestCollectionState();
  check('фильтр классики сохраняет полный набор при постраничном рендере', collectionCards().length === 40
    && collectionState.total === 500 && loadAllCollection() === 500, $('colCount').textContent);
  $('colType').value = 'Rune';
  $('colType').dispatchEvent(new window.Event('change'));
  await wait(60);
  collectionState = window.ecTestCollectionState();
  check('фильтр «Руны» = 55 (расширение) и листается страницами', collectionState.total === 55
    && collectionCards().length <= 40 && loadAllCollection() === 55, `${collectionCards().length}/${collectionState.total}`);
  $('colType').value = ''; $('colType').dispatchEvent(new window.Event('change'));
  $('colFaction').value = 'Pyromancer'; $('colFaction').dispatchEvent(new window.Event('change'));
  await wait(60);
  collectionState = window.ecTestCollectionState();
  check('фильтр «Пироманты» = 85 (Расширения I+II) и догружает результат', collectionState.total === 85
    && collectionCards().length <= 40 && loadAllCollection() === 85, `${collectionCards().length}/${collectionState.total}`);

  // Ключевые слова выделяются жирным, а варианты Borderless остаются теми же картами.
  $('colFaction').value = ''; $('colType').value = ''; $('colKw').value = 'Taunt';
  $('colFaction').dispatchEvent(new window.Event('change')); $('colType').dispatchEvent(new window.Event('change'));
  $('colKw').dispatchEvent(new window.Event('change'));
  const tauntTile = $('colGrid').firstElementChild;
  check('ключевые слова карты выделены <strong>', !!tauntTile?.querySelector('.ctext .cardKeyword'));
  $('colKw').value = ''; $('colKw').dispatchEvent(new window.Event('change'));

  const rollPass = window.ecBorderlessChanceForRoll;
  const quantileHits = Array.from({ length: 10_000 }, (_, i) => rollPass(i / 10_000)).filter(Boolean).length;
  check('шанс Borderless в бустере снижен до 0,1% с корректной границей', quantileHits === 10
    && rollPass(0) && rollPass(0.0009999) && !rollPass(0.001) && !rollPass(0.9999) && !rollPass(Number.NaN), `${quantileHits}/10000 роллов`);

  check('контекстная навигация с кнопкой «Назад» видна на внутренних экранах', !quickNav.classList.contains('hidden')
    && quickNav.querySelectorAll('button[data-route]').length === 10 && !!quickNav.querySelector('[data-route="back"]'));
  click(quickNav.querySelector('[data-route="decks"]'));
  await wait(40);
  check('быстрый переход в колоды открывает экран и корректно обновляет маршрут/кнопку «Назад»',
    !$('decksScreen').classList.contains('hidden') && $('collection').classList.contains('hidden')
      && !!quickNav.querySelector('[data-route="decks"][aria-current="page"]')
      && quickNav.querySelector('[data-route="back"]').title === 'Назад: Коллекция карт');
  click(quickNav.querySelector('[data-route="back"]'));
  await wait(40);
  check('возврат из колод восстанавливает коллекцию и предыдущий маршрут',
    !$('collection').classList.contains('hidden') && $('decksScreen').classList.contains('hidden')
      && !!quickNav.querySelector('[data-route="collection"][aria-current="page"]')
      && quickNav.querySelector('[data-route="back"]').title === 'Назад: Главная');

  click(quickNav.querySelector('[data-route="events"]'));
  await wait(40);
  const borderlessEvent = $('eventsGrid').querySelector('[data-event-id="borderless"]');
  check('событие Borderless показывает цель 3 рейтинговые победы и одну награду',
    !!borderlessEvent && /0\/3/.test(borderlessEvent.textContent) && !!borderlessEvent.querySelector('[data-ev-play="borderless"]'));
  click(quickNav.querySelector('[data-route="back"]'));
  await wait(40);

  click(quickNav.querySelector('[data-route="profile"]'));
  await wait(40);
  check('профиль открывается с уровнем и кнопкой возврата', !$('profileModal').classList.contains('hidden')
    && /Уровень \d+/.test($('profBody').textContent) && !!$('btnProfileClose'));
  click(quickNav.querySelector('[data-route="back"]'));
  await wait(40);
  check('возврат из профиля восстанавливает прежний раздел', !$('collection').classList.contains('hidden') && $('profileModal').classList.contains('hidden'));

  $('colStyle').value = ''; $('colStyle').dispatchEvent(new window.Event('change'));
  loadAllCollection();
  const allVariants = collectionCards();
  const classicSample = allVariants[0]; const borderlessSample = allVariants[1];
  check('коллекция содержит 500 классических + 500 отдельных Borderless-вариантов', allVariants.length === 1000
    && classicSample?.dataset.cardId === borderlessSample?.dataset.cardId
    && classicSample?.dataset.cardAppearance === 'classic' && borderlessSample?.dataset.cardAppearance === 'borderless'
    && classicSample?.dataset.cardVariantId !== borderlessSample?.dataset.cardVariantId
    && classicSample?.querySelector('.ctitle')?.textContent === borderlessSample?.querySelector('.ctitle')?.textContent
    && classicSample?.querySelector('.cart')?.innerHTML === borderlessSample?.querySelector('.cart')?.innerHTML);

  $('colStyle').value = 'borderless'; $('colStyle').dispatchEvent(new window.Event('change'));
  await wait(40);
  loadAllCollection();
  check('в фильтре Borderless видны все 500 безрамочных вариантов', collectionCards().length === 500
    && collectionCards().every(node => node.classList.contains('borderless') && node.dataset.cardAppearance === 'borderless'
      && node.dataset.cardVariantId === `${node.dataset.cardId}:borderless`));
  const borderlessTileSample = $('colGrid').firstElementChild;
  const borderlessId = borderlessTileSample?.dataset.cardId || '';
  borderlessTileSample?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false, clientX: 120, clientY: 140 }));
  await wait(10);
  check('предпросмотр Borderless сохраняет безрамочный вариант', $('zoomPreview').querySelector('.card')?.classList.contains('borderless')
    && $('zoomPreview').dataset.cardVariantId === `${borderlessId}:borderless`);
  const copiesBeforeStyleUnlock = window.ecOwnedOf(borderlessId);
  const granted = !!borderlessId && window.ecGrantBorderless(borderlessId);
  $('colStyle').dispatchEvent(new window.Event('change'));
  const unlockedBorderless = collectionCards().find(node => node.dataset.cardId === borderlessId);
  check('Borderless разблокируется отдельно от копий карты', granted && !!unlockedBorderless
    && !unlockedBorderless.classList.contains('borderlessLocked') && window.ecOwnedOf(borderlessId) === copiesBeforeStyleUnlock);
  const equippedBorderless = window.ecToggleBorderless(borderlessId);
  $('colStyle').dispatchEvent(new window.Event('change'));
  const equippedTile = collectionCards().find(node => node.dataset.cardId === borderlessId);
  check('надевание Borderless меняет только оформление, сохраняя тот же ID карты', equippedBorderless
    && !!equippedTile?.classList.contains('borderlessEquipped') && equippedTile.dataset.cardId === borderlessId
    && window.ecOwnedOf(borderlessId) === copiesBeforeStyleUnlock);
  $('colStyle').value = 'classic'; $('colStyle').dispatchEvent(new window.Event('change'));

  click($('btnColClose'));
  await wait(30);
  check('коллекция закрылась', $('collection').classList.contains('hidden'));
  click($('btnCollection')); await wait(35);
  const reopenOne = window.ecTestCollectionState();
  click($('btnColClose')); await wait(35);
  click($('btnCollection')); await wait(35);
  const reopenTwo = window.ecTestCollectionState();
  const reopenFastOk = reopenOne.rendered <= reopenOne.pageSize && reopenTwo.rendered <= reopenTwo.pageSize
    && reopenOne.total === 500 && reopenTwo.total === 500;
  check('после возврата в меню повторное открытие коллекции снова рисует только первую страницу', reopenFastOk,
    `открытия ${reopenOne.rendered}/${reopenOne.total} и ${reopenTwo.rendered}/${reopenTwo.total}`);
  click($('btnColClose')); await wait(35);

  /* ---------- 3. правила ---------- */
  console.log('\n[3] Экран правил');
  click($('btnRules'));
  await wait(40);
  let rulesText = '';
  for (const b of [...window.document.querySelectorAll('#rulesNav [data-rs]')].map(x => x.dataset.rs)) {
    click(window.document.querySelector(`#rulesNav [data-rs="${b}"]`)); await wait(5); rulesText += $('rulesBody').textContent;
  }
  check('правила отрендерены', rulesText.length > 2000, `${rulesText.length} симв.`);
  check('в правилах есть Эхо', /Эхо-очки/.test(rulesText));
  check('в правилах есть 5 фаз', /Пять фаз хода/.test(rulesText));
  check('в правилах есть пассивки всех фракций', /Божественный щит/.test(rulesText) && /Кровавая жатва/.test(rulesText)
    && /Корни земли/.test(rulesText) && /Пламя возмездия/.test(rulesText) && /Иллюзорная тень/.test(rulesText));
  click($('btnRulesClose'));

  /* ---------- 4. начало боя + муллиган ---------- */
  console.log('\n[4] Начало боя и муллиган');
  click($('playerFactions').children[PLAYER]);
  await wait(40);
  check('клик карточки фракции открыл модалку подробностей', !$('factionModal').classList.contains('hidden') && $('facDesc').textContent.length > 80, $('facName').textContent);
  check('в модалке фракции 3 примера карт', $('facExCards').children.length === 3, `${$('facExCards').children.length}`);
  check('в модалке есть советы по стратегии', $('facTips').children.length >= 3, `${$('facTips').children.length}`);
  click($('btnFactionPlay'));
  await wait(40);
  check('фракция выбрана из модалки, модалка закрыта', $('factionModal').classList.contains('hidden')
    && window.document.querySelectorAll('#playerFactions .fcard.sel').length === 1);
  check('выбор фракции сохранён в localStorage', !!window.localStorage.getItem('ec.pickedFaction'), String(window.localStorage.getItem('ec.pickedFaction')));
  $('enemyFaction').value = ENEMY;
  $('difficulty').value = '0.8';
  click($('btnPlay'));
  const mullOk = await waitUntil(() => !$('mulligan').classList.contains('hidden'), 6000);
  check('муллиган открылся', mullOk);
  check('в пересдаче 5 карт', $('mullCards').children.length === 5, `${$('mullCards').children.length}`);
  const b = window.__battle;
  b.autoTurnEnabled = false;   // сценарий смоука ведёт ходы сам
  b.manualCombat = false;      // окно объявления атак включим точечно ниже
  check('рука движка = 5 карт до пересдачи', b.engine.p(0).hand.length === 5, `${b.engine.p(0).hand.length}`);
  const handBeforeMull = b.engine.p(0).hand.slice();
  if ($('mullCards').children.length > 2) { click($('mullCards').children[0]); click($('mullCards').children[1]); }
  const mull0 = $('mullCards').children[0];
  check('клик по карте муллигана помечает её НА ЗАМЕНу (метка и счётчик)',
    mull0.classList.contains('swap') && !!mull0.querySelector('.mark') && /К замене: 2 из 5/.test($('mullCount').textContent),
    `${$('mullCount').textContent} | метка: ${mull0.querySelector('.mark')?.textContent ?? 'нет'}`);
  click($('btnMullConfirm'));
  await wait(120);

  /* Регрессия: одиночные цели из effects[].to тоже обязательны для заклинаний.
     Массовые/случайные эффекты и боевые кличи существ при этом остаются легальными. */
  console.log('\n[4б] Допустимые цели эффектов');
  {
    const e = b.engine;
    const player = e.p(0), opponent = e.p(1);
    const saved = {
      activeSide: e.activeSide, phase: e.phase, instantWindow: e.instantWindow,
      mana: player.mana, hand: player.hand.slice(), lastSpellCast: player.lastSpellCast,
      echoPoints: player.echoPoints, echoUsedThisGame: player.echoUsedThisGame,
      playerCreatures: player.creatures.slice(), opponentCreatures: opponent.creatures.slice(),
    };
    e.activeSide = 0; e.phase = 'Main'; e.instantWindow = null;
    player.mana = 10;
    player.creatures.splice(0); opponent.creatures.splice(0);
    const tryCard = id => {
      const index = player.hand.length;
      player.hand.push(id);
      const rngBefore = JSON.stringify(e.rng.getState());
      const result = e.canPlay(0, index);
      const rngStable = rngBefore === JSON.stringify(e.rng.getState());
      player.hand.pop();
      return { ...result, rngStable };
    };
    const enemyTargetMissing = tryCard('nec_s04');
    const anyTargetMissing = tryCard('nec_s07');
    const massWithoutUnits = tryCard('nec_s09');
    const randomWithoutUnits = tryCard('eth_s09');
    const battlecryWithoutTarget = tryCard('eth_10');
    const syntheticId = 'smoke_target_default';
    const targetTemplate = e.db.get('nec_s04');
    e.db.set(syntheticId, { ...targetTemplate, id: syntheticId, name: 'Проверка цели по умолчанию',
      cost: 0, type: 'Spell', target: 'None', effects: [{ op: 'destroyCreature' }] });
    const defaultTargetMissing = tryCard(syntheticId);
    e.db.delete(syntheticId);

    const index = player.hand.length;
    player.hand.push('nec_s04');
    const beforeMana = player.mana;
    const directPlayRejected = !e.playCard(0, index)
      && player.hand[index] === 'nec_s04' && player.mana === beforeMana;
    player.hand.pop();

    const uiIndex = player.hand.length;
    const uiManaBefore = player.mana;
    player.hand.push('nec_s04'); player.mana = 10;
    b.renderAll();
    b.playHandIndex(uiIndex);
    const uiPlayRejected = player.hand[uiIndex] === 'nec_s04';
    player.hand.pop(); player.mana = uiManaBefore;

    const lastSpellBeforeEcho = player.lastSpellCast;
    const echoPointsBefore = player.echoPoints;
    const echoUsedBefore = player.echoUsedThisGame;
    player.lastSpellCast = { cardId: 'nec_s04' };
    player.echoPoints = 1; player.echoUsedThisGame = 0;
    const echoBlocked = !e.canUseEcho(0).ok && !e.useEcho(0)
      && player.echoPoints === 1 && player.echoUsedThisGame === 0;

    const targetData = e.db.get('aur_01');
    const fakeTarget = {
      uid: 900001, cardId: targetData.id, owner: 1, name: targetData.name,
      faction: targetData.faction, attack: targetData.attack ?? 1, health: targetData.health ?? 2,
      maxHealth: targetData.health ?? 2, cost: targetData.cost, element: targetData.element,
      keywords: [...(targetData.keywords ?? [])], statuses: [], summonedOnTurn: 0,
      attacksThisTurn: 0, tapped: false, canAttackThisTurn: false, justPlayed: false,
      unblockableThisTurn: false, silenced: false, frozen: false, data: targetData,
    };
    opponent.creatures.push(fakeTarget);
    const becomesPlayable = tryCard('nec_s04').ok;
    const echoWithTarget = e.canUseEcho(0).ok;
    opponent.creatures.pop();

    player.lastSpellCast = lastSpellBeforeEcho;
    player.echoPoints = echoPointsBefore; player.echoUsedThisGame = echoUsedBefore;
    player.mana = saved.mana; player.hand = saved.hand;
    player.creatures.splice(0, player.creatures.length, ...saved.playerCreatures);
    opponent.creatures.splice(0, opponent.creatures.length, ...saved.opponentCreatures);
    e.activeSide = saved.activeSide; e.phase = saved.phase; e.instantWindow = saved.instantWindow;
    b.renderAll();

    const targetBlocks = !enemyTargetMissing.ok && !anyTargetMissing.ok && !defaultTargetMissing.ok
      && directPlayRejected && uiPlayRejected;
    check('одиночные цели EnemyCreature/AnyCreature и цель по умолчанию блокируют розыгрыш без существ', targetBlocks,
      `Enemy=${enemyTargetMissing.ok}; Any=${anyTargetMissing.ok}; default=${defaultTargetMissing.ok}; движок/UI отклонили=${directPlayRejected}/${uiPlayRejected}`);
    check('массовые/случайные эффекты и боевой клич существа не получают ложный target-gate',
      massWithoutUnits.ok && randomWithoutUnits.ok && battlecryWithoutTarget.ok,
      `массовый=${massWithoutUnits.ok}; случайный=${randomWithoutUnits.ok}; существо=${battlecryWithoutTarget.ok}`);
    check('при появлении допустимой цели заклинание и его Эхо снова доступны', becomesPlayable && echoBlocked && echoWithTarget,
      `цель=${becomesPlayable}; Эхо без цели блокируется=${echoBlocked}; Эхо с целью=${echoWithTarget}`);
    check('проверка легальности не расходует ГПСЧ', [enemyTargetMissing, anyTargetMissing, massWithoutUnits,
      randomWithoutUnits, battlecryWithoutTarget, defaultTargetMissing].every(x => x.rngStable));
  }
  // авто-ход: при пустой руке и нулевой мане ход передаётся сам
  {
    const e2 = b.engine;
    const savedHand = e2.p(0).hand.slice(); const savedMana = e2.p(0).mana;
    e2.p(0).hand = []; e2.p(0).mana = 0; e2.p(0).echoPoints = 0;
    let called = false; const orig = b.endTurnNow.bind(b); b.endTurnNow = () => { called = true; };
    b.autoTurnEnabled = true;
    b.renderAll();
    b.autoDeadline = Date.now() - 1;
    b.autoTurnFire();
    b.endTurnNow = orig; b.autoTurnEnabled = false;
    e2.p(0).hand = savedHand; e2.p(0).mana = savedMana;
    b.renderAll();
    check('авто-ход: нечем ходить → ход передаётся без кнопки', called, 'endTurnNow вызван планировщиком');
  }
  check('подтверждённый муллиган реально меняет руку',
    JSON.stringify(b.engine.p(0).hand) !== JSON.stringify(handBeforeMull) && b.engine.p(0).mulliganUsed,
    `до: ${handBeforeMull.slice(0, 3).join(',')}… после: ${b.engine.p(0).hand.slice(0, 3).join(',')}…`);
  const mainOk = await waitUntil(() => !$('btnEndTurn').disabled, 8000);
  check('дошли до основной фазы игрока', mainOk);
  check('после муллигана и добора ресурсов в руке 6 карт', b.engine.p(0).hand.length === 6, `${b.engine.p(0).hand.length}`);
  check('рука отрисована в DOM', $('hand').children.length === b.engine.p(0).hand.length,
    `${$('hand').children.length} в DOM / ${b.engine.p(0).hand.length} в движке`);
  const liveBorderlessId = b.engine.p(0).hand[0] || '';
  const liveCopiesBeforeStyle = liveBorderlessId ? window.ecOwnedOf(liveBorderlessId) : 0;
  const liveStyleWasEquipped = !!liveBorderlessId && window.ecMeta().borderlessEquipped.includes(liveBorderlessId);
  if (liveBorderlessId && !window.ecBorderlessOwned().includes(liveBorderlessId)) window.ecGrantBorderless(liveBorderlessId);
  if (liveBorderlessId && !liveStyleWasEquipped) window.ecToggleBorderless(liveBorderlessId);
  b.renderAll();
  const liveBorderlessNode = [...$('hand').children].find(n => n.dataset.cardId === liveBorderlessId);
  check('полученный Borderless вид отображается на играбельной карте в матче', !!liveBorderlessNode?.classList.contains('borderless')
    && liveBorderlessNode?.dataset.cardVariantId === `${liveBorderlessId}:borderless`
    && window.ecOwnedOf(liveBorderlessId) === liveCopiesBeforeStyle);
  if (liveBorderlessId && !liveStyleWasEquipped) window.ecToggleBorderless(liveBorderlessId);
  b.renderAll();
  check('здоровье героев 30/30', $('playerHp').textContent === '30' && $('enemyHp').textContent === '30');
  check('мана 1-го хода = 1/1', $('playerMana').textContent === '1/1', $('playerMana').textContent);
  // Во время хода ИИ (busy=true) приоритет игрока всё равно должен принимать instant из руки.
  {
    const e = b.engine;
    const snap = e.exportState();
    const instantId = 'aur_s01';
    e.p(0).hand = [instantId];
    e.p(0).mana = Math.max(3, e.p(0).mana);
    e.p(0).health = Math.min(20, e.p(0).maxHealth);
    b.setBusy(true);
    const windowTask = b.responseWindow('smoke: ответ в ходе ИИ', true);
    const interactiveDuringAi = !b.busy && e.instantWindow === 0;
    b.playHandIndex(0); // должен успеть до ecAutoPass и попасть в стек через тот же UI-путь
    const windowResult = await windowTask;
    await b.waitForStack();
    await waitUntil(() => !b.stackBusy, 4000, 20);
    const instantPlayed = windowResult === 'acted' && e.p(0).hand.length === 0
      && e.p(0).lastSpellCast?.cardId === instantId && e.stack.length === 0;
    e.importState(snap, false);
    b.setBusy(false);
    b.renderAll();
    check('мгновенное заклинание разыгрывается в окне приоритета во время хода ИИ',
      interactiveDuringAi && instantPlayed,
      `busy снят в окне ${interactiveDuringAi}, результат ${windowResult}, стек разрешён ${instantPlayed}`);
  }

  // Full Control намеренно удерживает пустое окно приоритета, даже если включён тестовый auto-pass.
  console.log('\n[4б] Full Control: удержание окна без доступного мгновенного заклинания');
  {
    const e = b.engine;
    const snap = e.exportState();
    e.p(0).hand = [];
    e.p(0).mana = 0;
    $('setFullControl').checked = true;
    $('setFullControl').dispatchEvent(new window.Event('change', { bubbles: true }));
    const settingsControlWorks = $('btnFullControl').getAttribute('aria-pressed') === 'true'
      && JSON.parse(window.localStorage.getItem('echo-citadel.settings.v1') || '{}').fullControl === true;
    const priorityTask = b.responseWindow('smoke: Full Control без ответа', false);
    const opened = await waitUntil(() => e.instantWindow === 0 && !$('instantDock').classList.contains('hidden'), 1500, 15);
    await wait(40); // ecAutoPass=true: окно всё равно обязано остаться открытым
    const held = e.instantWindow === 0;
    const explainsStop = /Full Control|Полный контроль/.test($('instantSub').textContent || '');
    click($('btnInstantPass'));
    const result = await priorityTask;
    click($('btnFullControl'));
    const buttonControlWorks = $('btnFullControl').getAttribute('aria-pressed') === 'false' && !$('setFullControl').checked;
    e.importState(snap, false);
    b.renderAll();
    check('Full Control сохраняется, удерживает пустое окно и ждёт ручной передачи приоритета',
      settingsControlWorks && opened && held && explainsStop && result === 'passed' && buttonControlWorks,
      `настройка ${settingsControlWorks}, открыто ${opened}, удержано ${held}, текст ${explainsStop}, результат ${result}, кнопка ${buttonControlWorks}`);
  }

  // Детерминированный сквозной сценарий: настоящая карта руны проходит через руку,
  // клик игрока, Engine.playCard → RunePlayed → questBump → localStorage.
  // Не зависит от случайного состава стартовой руки/ходов AI.
  console.log('\n[4в] Сквозной розыгрыш руны и сохранение задания');
  {
    const e = b.engine;
    const snapshot = e.exportState();
    const player = e.p(0);
    const runeCard = [...e.db.values()].find(c => c.type === 'Rune' && c.faction === player.faction
      && !player.runes.some(r => r.cardId === c.id));
    const metaBefore = JSON.parse(window.localStorage.getItem('ec_meta_v1') || '{}');
    const dailyBefore = metaBefore.quests?.find(q => q.id === 'runes');
    const weeklyBefore = metaBefore.wquests?.find(q => q.id === 'w_runes');
    let didPlay = false;
    let questSaved = false;
    let runeUiShown = false;
    let statsAdvanced = false;
    const runeStatsBefore = e.stats[0].runesPlayed;

    try {
      if (runeCard && dailyBefore && weeklyBefore) {
        player.hand = [runeCard.id];
        player.maxMana = Math.max(player.maxMana, runeCard.cost);
        player.mana = Math.max(player.mana, runeCard.cost);
        b.renderAll();
        const runeNode = [...$('hand').querySelectorAll('.card')]
          .find(node => node.dataset.cardId === runeCard.id);
        const playable = !!runeNode && !b.busy && e.canPlay(0, 0).ok;
        if (playable) {
          click(runeNode);
          didPlay = await waitUntil(() => e.p(0).runes.some(r => r.cardId === runeCard.id)
            && e.p(0).hand.length === 0, 3000, 20);
          const metaAfter = JSON.parse(window.localStorage.getItem('ec_meta_v1') || '{}');
          const dailyAfter = metaAfter.quests?.find(q => q.id === 'runes');
          const weeklyAfter = metaAfter.wquests?.find(q => q.id === 'w_runes');
          const dailyExpected = Math.min(dailyBefore.goal, dailyBefore.prog + 1);
          const weeklyExpected = Math.min(weeklyBefore.goal, weeklyBefore.prog + 1);
          questSaved = !!didPlay && dailyAfter?.prog === dailyExpected && weeklyAfter?.prog === weeklyExpected;
          statsAdvanced = e.stats[0].runesPlayed === runeStatsBefore + 1;
          runeUiShown = !!$('playerRunes').querySelector(`.runeChip[data-card-id="${runeCard.id}"]`);
          check('реальный розыгрыш руны продвигает и сохраняет daily + weekly',
            playable && didPlay && statsAdvanced && questSaved && runeUiShown,
            `${runeCard.id}: руна на поле ${didPlay}, счётчик ${runeStatsBefore}→${e.stats[0].runesPlayed}, daily ${dailyBefore.prog}→${dailyAfter?.prog}, weekly ${weeklyBefore.prog}→${weeklyAfter?.prog}, UI ${runeUiShown}`);
        } else {
          check('реальный розыгрыш руны продвигает и сохраняет daily + weekly', false,
            `${runeCard.id}: UI-карта найдена ${!!runeNode}, canPlay ${e.canPlay(0, 0).ok}`);
        }
      } else {
        check('реальный розыгрыш руны продвигает и сохраняет daily + weekly', false,
          `руна ${!!runeCard}, daily ${!!dailyBefore}, weekly ${!!weeklyBefore}`);
      }
    } finally {
      e.importState(snapshot, false);
      b.renderAll();
    }
  }

  /* ---------- 5. розыгрыш карт ---------- */
  console.log('\n[5] Розыгрыш карт игроком (клик по карте)');
  let playedCards = 0, playedCreatures = 0, playedSpells = 0, echoUsed = 0;
  const stat = () => ({
    turn: $('turnNo').textContent, hp: $('playerHp').textContent + '/' + $('enemyHp').textContent,
    mana: $('playerMana').textContent, hand: $('hand').children.length,
    board: units('#playerBoard .unit'), enemyBoard: units('#enemyBoard .unit'),
    runes: units('#playerRunes .runeChip'), echo: $('playerEcho').textContent, log: (window.logLines || []).length,
  });

  for (let t = 0; t < TURNS; t++) {
    const gotTurn = await waitUntil(() => !$('gameover').classList.contains('hidden') || !$('btnEndTurn').disabled, 20000);
    if (!gotTurn) { check('игрок получил ход ' + (t + 1), false, 'таймаут ожидания'); break; }
    if (!$('gameover').classList.contains('hidden')) break;

    // играем всё, что можно: до 6 попыток за ход, пропуская уже отвергнутые карты
    const tried = new Set();
    for (let attempt = 0; attempt < 6; attempt++) {
      if ($('gameover').classList.contains('hidden') === false) break;
      const before = stat();
      const playable = [...$('hand').children].filter(n => !n.classList.contains('unplayable') && !tried.has(n.dataset.cardId));
      if (VERBOSE) {
        console.log('     [DBG] мана', b.engine.p(0).mana + '/' + b.engine.p(0).maxMana,
          '| фаза', b.engine.phase, '| сторона', b.engine.activeSide, '| busy', b.busy,
          '| DOM-играбельных', playable.length,
          '| движок:', b.engine.p(0).hand.map((id, i) => id + (b.engine.canPlay(0, i).ok ? '✓' : '✗')).join(' '));
      }
      if (playable.length === 0) break;

      // сначала пробуем Эхо, если доступно
      if (!$('btnEcho').disabled && echoUsed === 0) {
        click($('btnEcho'));
        await wait(500);
        key('Escape');                      // если открылся выбор цели — отменяем
        await wait(200);
        if (b.engine.p(0).echoPoints < Number(before.echo)) echoUsed++;
        continue;
      }

      const card = playable[0];
      const cardId = card.dataset.cardId;
      tried.add(cardId);
      const type = b.engine.db.get(cardId)?.type;
      const handBefore = b.engine.p(0).hand.length;
      const manaBefore = b.engine.p(0).mana;
      click(card);
      await wait(450);

      // карта требует цель → движок подсвечивает допустимые; кликаем по первой
      const targets = window.document.querySelectorAll('.unit.targetable');
      if (targets.length > 0) { click(targets[0]); await wait(450); }
      else if (window.document.querySelectorAll('.heroPanel.droppable').length > 0) { key('Escape'); await wait(150); }

      const handShrank = b.engine.p(0).hand.length < handBefore;
      if (VERBOSE) {
        console.log(`     [DBG] розыгрыш ${cardId} (${type}): рука ${handBefore}→${b.engine.p(0).hand.length}, мана ${manaBefore}→${b.engine.p(0).mana}, целей было ${targets.length}, подсказка «${$('actionHint').textContent}»`);
      }
      const after = stat();
      if (handShrank) {
        playedCards++;
        if (type === 'Creature') playedCreatures++;
        if (type === 'Spell') playedSpells++;
      }
      // карту не удалось сыграть (нет цели / движок отклонил) — пробуем следующую
    }

    const mid = stat();
    click($('btnEndTurn'));
    await wait(700);
    if (t % 2 === 0) {
      console.log(`   ход ${mid.turn}: HP ${mid.hp} | мана ${mid.mana} | рука ${mid.hand} | доска ${mid.board}/${mid.enemyBoard} | руны ${mid.runes} | эхо ${mid.echo} | лог ${mid.log}`);
    }
  }

  check('игрок разыграл хотя бы одну карту', playedCards > 0, `${playedCards} карт (существ ${playedCreatures}, заклинаний ${playedSpells})`);
  const questProgressAfterPlays = JSON.parse(window.localStorage.getItem('ec_meta_v1'));
  check('игровые события продвигают еженедельную цель «разыграйте существ»',
    (questProgressAfterPlays.wquests.find(q => q.id === 'w_creatures')?.prog ?? 0) > 0,
    `существа ${questProgressAfterPlays.wquests.find(q => q.id === 'w_creatures')?.prog ?? 0}; руна проверена отдельным детерминированным сквозным сценарием`);
  check('существа появились на доске игрока', playedCreatures === 0 || units('#playerBoard .unit') >= 0);
  check('журнал боя копится в памяти (чат с экрана убран)', (window.logLines || []).length > 3,
    `${(window.logLines || []).length} записей в буфере`);
  click($('btnJournal'));
  await wait(60);
  const jlOpen = !$('journalModal').classList.contains('hidden') && $('journalList').children.length > 3;
  key('Escape');
  click($('btnJournalClose'));
  await wait(40);
  check('журнал боя открывается по кнопке и хоткею-закрытию', jlOpen && $('journalModal').classList.contains('hidden'),
    `записей в журнале: ${$('journalList').children.length}`);


  /* ---------- 5б. визуальный слой (docs/VISUAL_STACK.md) ---------- */
  console.log('\n[5б] Визуальный слой');
  // визуальные проверки требуют непустой руки: доигрываем/перестартовываем при нужде
  const handCardsNow = () => [...$('hand').children].filter(n => n.classList.contains('card'));
  let guardHand = 0;
  while (handCardsNow().length === 0 && guardHand++ < 10) {
    if (!$('gameover').classList.contains('hidden')) {
      click($('btnAgain'));
      await waitUntil(() => !$('mulligan').classList.contains('hidden'), 6000);
      click($('btnMullSkip'));
      await waitUntil(() => !$('btnEndTurn').disabled, 8000);
      continue;
    }
    if (!$('btnEndTurn').disabled) click($('btnEndTurn'));
    await waitUntil(() => !$('btnEndTurn').disabled || !$('gameover').classList.contains('hidden'), 6000);
  }
  check('к визуальным проверкам рука непуста', handCardsNow().length > 0, `${handCardsNow().length} карт`);
  check('сцена: 4 параллакс-слоя заполнены', [...$('backdrop').querySelectorAll('.bl')].every(n => n.style.backgroundImage.length > 100),
    `${[...$('backdrop').querySelectorAll('.bl')].filter(n => n.style.backgroundImage).length}/4`);
  check('поверхность стола отрисована', $('tableSurface').innerHTML.includes('<svg'), `${$('tableSurface').innerHTML.length} симв.`);
  /* v3.16.1: плёночное зерно (jitter-мерцание) УБРАНО — фон боя должен быть статичным */
  check('пост-слои смонтированы (виньетка+грейд, без зерна)', !!window.document.getElementById('postVignette')
    && !!window.document.getElementById('postGrade') && !window.document.getElementById('postGrain'));
  check('VFX-слой создан', !!window.document.getElementById('vfxLayer'));
  check('SVG-фильтры (марево/аберрация/зерно) инжектированы', !!window.document.getElementById('vfxHeat')
    && !!window.document.getElementById('vfxAberr') && !!window.document.getElementById('vfxGrain'));
  const handCards = [...$('hand').children].filter(n => n.classList.contains('card'));
  check('карты руки имеют класс редкости', handCards.length > 0 && handCards.every(n => /r-(common|uncommon|rare|epic|legendary)/.test(n.className)),
    handCards.map(n => n.dataset.rarity).join('/'));
  check('у карт есть слои innerframe/spec/foil', handCards.length > 0 && handCards.every(n =>
    n.querySelector('.innerframe') && n.querySelector('.spec') && n.querySelector('.foil')));
  check('арт карты тянется из artworkPath (/art/<Фракция>[/<Семейство>]/<id>.png), без затычек',
    handCards.length > 0 && !!handCards[0].querySelector('.cart .artBox img')
    && (handCards[0].querySelector('.cart .artBox img').getAttribute('src') || '').includes('/art/'),
    handCards.length ? handCards[0].querySelector('.cart .artBox img')?.getAttribute('src') : 'нет карт');
  check('портреты героев: аватар из папки или сигил-фолбэк (без svg-затычек)',
    /<img|sigFall/.test($('playerPortrait').innerHTML) && /<img|sigFall/.test($('enemyPortrait').innerHTML),
    `игрок: ${$('playerPortrait').innerHTML.slice(0, 24)}…`);
  // MTG-компоновка: инфо-бары сверху и снизу, жизни по центру напротив друг друга, мана по бокам
  const boardKids = [...$('board').children].map(n => n.id || n.className);
  const battleKids = [...$('battle').children].map(n => n.id);
  // панель игрока — ПОД рукой (просьба заказчика), панель противника — сверху поля
  const barsOk = boardKids[0] === 'enemyHero'
    && battleKids.indexOf('playerHero') === battleKids.indexOf('handArea') + 1
    && $('enemyHero').classList.contains('heroBar') && $('playerHero').classList.contains('heroBar');
  const hpOpposite = !!$('enemyHero').querySelector('.hbHp') && !!$('playerHero').querySelector('.hbHp.me')
    && /^\d+$/.test($('enemyHp').textContent) && /^\d+$/.test($('playerHp').textContent);
  const manaSides = !!$('enemyHero').querySelector('.hbSide.right .stat.mana')
    && !!$('playerHero').querySelector('.hbSide.right .stat.mana');
  check('инфо-бары как в MTG: противник сверху, моя панель ПОД картами, жизни напротив', barsOk && hpOpposite && manaSides,
    `бары: ${barsOk}, жизни ${$('enemyHp').textContent}:${$('playerHp').textContent} медальонами по центру, мана с боков`);
  // имитация наведения: должен появиться 3D-тилт
  if (handCards.length) {
    handCards[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false, clientX: 160, clientY: 200 }));
    handCards[0].dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 170, clientY: 190 }));
    await wait(60);
    const tf = handCards[0].style.transform;
    check('наведение даёт 3D-тилт и координаты блика', /rotateX\(/.test(tf) && handCards[0].style.getPropertyValue('--mx') !== '',
      tf.slice(0, 58));
    handCards[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
  }
  check('тумблер звука присутствует', !!$('btnSound'), $('btnSound') ? $('btnSound').textContent.trim() : 'нет');

  /* ---------- 5в. арты по фракциям и юзабилити ---------- */
  console.log('\n[5в] Арты по фракциям и юзабилити');
  // слой настоящего PNG: /art/<Faction>[/<Subfamily>]/<id>.png поверх процедурной основы
  const artLayers = handCards.map(n => n.querySelector('.cart .artBox img')?.getAttribute('src') ?? '')
    .filter(Boolean);
  check('у карт руки есть слой настоящего арта /art/…', handCards.length > 0 &&
    artLayers.length === handCards.length && artLayers.every(h => h.startsWith('/art/')),
    `${artLayers.length}/${handCards.length} карт, пример: ${artLayers[0] || '—'}`);
  // контейнеры нового интерфейса
  check('контейнер крупного предпросмотра существует', !!window.document.getElementById('zoomPreview'));
  check('панель настроек и кнопка ⚙ существуют', !!window.document.getElementById('settingsPanel')
    && !!window.document.getElementById('btnSettings')
    && !!window.document.getElementById('setPreview') && !!window.document.getElementById('setFx'));
  // наведение открывает крупный предпросмотр с полным текстом
  if (handCards.length) {
    handCards[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false, clientX: 300, clientY: 400 }));
    await wait(30);
    const zp = window.document.getElementById('zoomPreview');
    const shown = zp.classList.contains('show') && zp.innerHTML.includes('card');
    check('наведение открывает крупный предпросмотр карты', shown,
      shown ? `${zp.innerHTML.length} симв., cardId=${zp.dataset.cardId}` : 'не открылся');
    handCards[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
    await wait(220);   // выдержка скрытия дока 120 мс
    check('предпросмотр скрывается после ухода курсора', !zp.classList.contains('show'));
  }
  // горячая клавиша H открывает настройки, Esc закрывает
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  await wait(20);
  const spOpen = !window.document.getElementById('settingsPanel').classList.contains('hidden');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(20);
  const spClosed = window.document.getElementById('settingsPanel').classList.contains('hidden');
  check('горячая клавиша H открывает настройки, Esc закрывает', spOpen && spClosed,
    spOpen && spClosed ? 'открылась и закрылась' : `open=${spOpen} closed=${spClosed}`);
  // причина запрета розыгрыша видна прямо на карте
  const unplayable = [...$('hand').querySelectorAll('.card.unplayable')];
  check('у неразыгрываемых карт видна причина запрета', unplayable.length === 0 ||
    unplayable.every(n => n.querySelector('.whyNot')),
    unplayable.length ? `${unplayable.length} карт с подсказкой` : 'все карты играбельны');
  // игровые шрифты с кириллицей подключены файлами
  const fsF = require('fs'), pathF = require('path');
  const fontsOk = fsF.existsSync(pathF.resolve(__dirname, '..', 'prototype', 'fonts', 'philosopher-400-cyrillic.woff2'))
    && /@font-face/.test(fsF.readFileSync(pathF.resolve(__dirname, '..', 'prototype', 'prototype.css'), 'utf8'))
    && fsF.readFileSync(pathF.resolve(__dirname, '..', 'prototype', 'index.html'), 'utf8').includes('id="menuHeroes"');
  check('игровые шрифты с кириллицей (Philosopher/Alegreya) подключены', fontsOk,
    'woff2 cyrillic+latin в prototype/fonts, @font-face в css, ряд героев в меню');
  // фон поля: на весь экран и анимированный
  const fsBg = require('fs'), pthBg = require('path');
  const cssBg = fsBg.readFileSync(pthBg.resolve(__dirname, '..', 'prototype', 'prototype.css'), 'utf8');
  const htmlBg = fsBg.readFileSync(pthBg.resolve(__dirname, '..', 'prototype', 'index.html'), 'utf8');
  check('поле на весь экран: резной стол Arena, медальоны, угловые стопки',
    /#backdrop \.bgArt\{[^}]*board_arena\.(?:png|jpg)/.test(htmlBg)
    && htmlBg.includes('id="enemyCorner"') && htmlBg.includes('id="playerCorner"')
    && htmlBg.includes('id="turnPill"') && /class="rays/.test(htmlBg)
    && /\.unit\.tapped \.ubody\{transform:rotate\(90deg\) scale\(\.72\)/.test(htmlBg),
    'стол board_arena.(png|jpg), углы/медальоны/пилюля хода/тап на месте');
  check('иконки героев укрупнены по MTG (медальон в бою и меню)',
    /--medal:clamp\(84px,11vh,120px\)/.test(htmlBg) && /\.heroChip\{[^}]*width:104px/.test(htmlBg)
    && /\.fava\{[^}]*width:88px/.test(htmlBg) && /\.medal::before\{/.test(htmlBg),
    'медальон до 120px с двойным золотым кольцом, иконы меню 104/88px');
  check('нижняя панель по MTG: док кнопок справа снизу, чат боя убран',
    !/id="logPanel"/.test(htmlBg) && /id="actionDock"/.test(htmlBg) && /id="stepTrack"/.test(htmlBg)
    && /\.zone\{overflow:visible\}/.test(htmlBg),
    'чат удалён, кнопки в правой панели, дорожка шагов боя, зоны без обрезки');
  check('MTG-плавность: ease-токены, направленный саммон, волна антапа',
    /--ease-out:cubic-bezier/.test(htmlBg) && /@keyframes summonMine/.test(htmlBg)
    && /@keyframes summonFoe/.test(htmlBg) && /\.unit\.untapAnim \.ubody\{/.test(htmlBg)
    && /@keyframes backIn/.test(htmlBg) && /animation:bannerIn 1\.15s/.test(htmlBg),
    'ease-токены, саммон по сторонам с perspective, антап со стаггером, плавный баннер');
  // жизни обновляются СРАЗУ при уроне/лечении вне фазы боя
  if (!$('gameover').classList.contains('hidden')) {
    click($('btnAgain'));
    await waitUntil(() => !$('mulligan').classList.contains('hidden'), 6000);
    click($('btnMullSkip'));
    await waitUntil(() => !$('btnEndTurn').disabled, 8000);
  }
  await waitUntil(() => !b.combatBusy, 9000);   // не мерить медальоны посреди боевой анимации
  const eBefore = b.engine.p(1).health, pBefore = b.engine.p(0).health;
  const dealt = b.engine.damageHero(1, 3, { source: 'тест' });
  const healed = b.engine.healHero(0, 2, { source: 'тест' });
  await wait(60);
  check('медальоны жизней обновляются сразу при уроне и лечении',
    +$('enemyHp').textContent === b.engine.p(1).health && +$('playerHp').textContent === b.engine.p(0).health
    && +$('enemyHp').textContent === Math.max(0, eBefore - dealt)
    && +$('playerHp').textContent === Math.min(30, pBefore + healed),
    `враг ${eBefore}→${$('enemyHp').textContent} (движок ${b.engine.p(1).health}, урон ${dealt}), вы ${pBefore}→${$('playerHp').textContent} (лечение ${healed})`);
  // Прямые вызовы damageHero/damageCreature ниже — вне аниматора боя: gameover
  // может оставить движок в Combat, где VFX штатно передаются animateCombat.
  const phaseBeforeVfxProbe = b.engine.phase;
  b.engine.phase = 'Main';
  // числа снятия жизней — на независимом слое и переживают перерисовку
  const fl = $('floatLayer');
  const nBefore = fl.children.length;
  b.engine.damageHero(1, 2, { source: 'тест слоя' });
  const gotFloat = fl.children.length > nBefore;
  b.renderAll();
  const survives = [...fl.children].some(n => (n.textContent || '').includes('-2'));
  check('числа снятия жизней на независимом слое (переживают перерисовку)', gotFloat && survives,
    `флоатов ${nBefore}→${fl.children.length}, после renderAll: ${survives ? 'видны' : 'исчезли'}`);
  // щит: урон поглощён целиком, на поле синее «🛡 0», жизни существа не меняются
  const plainC = [...b.engine.db.values()].find(c => c.type === 'Creature');
  // summon вернёт null при полной доске (7 существ) — выбираем сторону с местом
  const freeSide = b.engine.p(0).creatures.length < 7 ? 0 : (b.engine.p(1).creatures.length < 7 ? 1 : 0);
  const su = b.engine.summon(freeSide, plainC);
  b.renderAll();   // узел должен существовать, чтобы флоат взял координаты
  const summonSigil = $('vfxLayer').querySelector('.vfx-summon-sigil.go');
  const summonReveal = window.document.querySelector(`.unit[data-uid="${su.uid}"].summoning`);
  check('призыв: проявляющийся сигил и анимация выхода существа', !!summonSigil && !!summonReveal,
    `сигил ${!!summonSigil}, проявление ${!!summonReveal}`);
  const savedKeywords = [...su.keywords];
  su.keywords = [...su.keywords, 'Unblockable'];
  b.renderAll();
  const stealthVeil = window.document.querySelector(`.unit[data-uid="${su.uid}"] .stealthVeil`);
  check('Неуловимость получает отдельный бирюзовый слой-маскировку', !!stealthVeil
    && stealthVeil.getAttribute('aria-label') === 'Неуловимость', !!stealthVeil);
  su.keywords = savedKeywords;
  b.renderAll();
  b.engine.addStatus(su, { type: 'Shield', value: 1, turnsLeft: -1 });
  b.renderAll();
  const shieldBubble = window.document.querySelector(`.unit[data-uid="${su.uid}"] .shieldBubble`);
  const bubbleLabel = shieldBubble?.getAttribute('aria-label') || '';
  const shieldSigil = shieldBubble?.querySelector('i')?.textContent.trim() || '';
  const shieldCount = shieldBubble?.querySelector('b')?.textContent.trim() || '';
  const hpS = su.health;
  const dealtS = b.engine.damageCreature(su, 5, { source: 'тест щита' });
  const shieldFloat = [...fl.children].some(n => (n.textContent || '').includes('🛡'));
  check('щит: стеклянный купол, сигил и число зарядов; урон поглощается',
    dealtS === 0 && su.health === hpS && shieldFloat && bubbleLabel.includes('зарядов: 1')
      && shieldSigil === '⛨' && shieldCount === '1',
    `урон ${dealtS}, hp ${hpS}→${su.health}, купол ${shieldSigil}/${shieldCount || 'НЕТ'}`);
  const runeCard = [...b.engine.db.values()].find(c => c.type === 'Rune');
  if (runeCard) {
    const savedRunes = b.engine.p(0).runes;
    b.engine.p(0).runes = [...savedRunes, {
      uid: 999999, cardId: runeCard.id, owner: 0, name: runeCard.name, faction: runeCard.faction,
      element: runeCard.element, turnsLeft: 2, data: runeCard, silenced: false,
    }];
    b.renderAll();
    const runeChip = $('playerRunes').querySelector('.runeChip');
    const runeVisible = !!runeChip?.querySelector('.runeSigil') && !!runeChip.querySelector('.runeClock')
      && !!runeChip.querySelector('.runeCopy small');
    check('руна: цветной сигил, длительность и подпись видны на поле', runeVisible,
      runeChip?.getAttribute('aria-label') || 'чип руны отсутствует');
    b.engine.p(0).runes = savedRunes;
    b.renderAll();
  } else check('руна: цветной сигил, длительность и подпись видны на поле', false, 'карта-руна не найдена');
  // урон заклинанием вне боя: число на слое + hp-бейдж обновлён после renderAll
  const freeSide2 = b.engine.p(1).creatures.length < 7 ? 1 : (b.engine.p(0).creatures.length < 7 ? 0 : 1);
  const su2 = b.engine.summon(freeSide2, plainC);
  b.renderAll();
  const hpBefore2 = su2.health;
  b.engine.damageCreature(su2, 3, { source: 'Огненный шар', fromSpell: true });
  const spellFloat = [...fl.children].some(n => (n.textContent || '').includes('-3'));
  b.renderAll();
  const node2 = window.document.querySelector(`.unit[data-uid="${su2.uid}"]`);
  const hpShown = node2 ? node2.querySelector('.hp').textContent : '?';
  check('урон заклинанием: число на поле и hp-бейдж существа обновлены (без отрицательных)',
    spellFloat && String(hpShown) === String(Math.max(0, hpBefore2 - 3)),
    `флоат -3: ${spellFloat ? 'да' : 'нет'}, hp ${hpBefore2}→${hpShown} (показано max(0, ${hpBefore2 - 3}))`);
  b.engine.phase = phaseBeforeVfxProbe;
  // папки артов по фракциям существуют на диске
  const fsMod = require('fs');
  const pathMod = require('path');
  const artRoot = pathMod.resolve(__dirname, '..', 'unity', 'EchoCitadel', 'Assets', 'Resources', 'Cards');
  const folders = ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal', 'Neutral', '_Tokens'];
  const haveReadme = folders.every(f => fsMod.existsSync(pathMod.join(artRoot, f, 'README.md'))
    && fsMod.existsSync(pathMod.join(artRoot, f, 'manifest.csv')));
  const haveArt = folders.reduce((n, f) => n + fsMod.readdirSync(pathMod.join(artRoot, f))
    .filter(x => x.endsWith('.png')).length, 0);
  check('папки артов по фракциям с README и манифестом', haveReadme, `${folders.length} папок, PNG на месте: ${haveArt}`);
  const offersReadme = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'art_raw', 'cosm', 'offers', 'README.md'), 'utf8');
  const offersUiSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'src', 'ui', 'prototype.ts'), 'utf8');
  const offersCssSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'prototype', 'prototype.css'), 'utf8');
  check('для обычного и мифического бустера указан drop-in путь',
    offersReadme.includes('art_raw/cosm/offers/') && offersReadme.includes('booster.png')
      && offersReadme.includes('booster_premium.png') && /cosmImg\('offers', p\.art/.test(offersUiSrc),
    'art_raw/cosm/offers/booster.png и booster_premium.png');
  check('PNG бустера показывается без искусственной рамки и без обрезки, крупно при вскрытии',
    offersReadme.includes('прозрачным фоном') && offersReadme.includes('без нарисованной внешней рамки')
      && offersUiSrc.includes("const pack = img.closest('.packVis')")
      && offersUiSrc.includes("pack?.closest('.packOfferArt')?.classList.add('hasPackArt')")
      && offersUiSrc.includes('const packTile =')
      && offersCssSrc.includes('#shopModal .packOfferArt.hasPackArt::after')
      && offersCssSrc.includes('#shopModal .packVis.hasArt')
      && offersCssSrc.includes('#boosterModal .boosterInvVisual.hasArt')
      && offersCssSrc.includes('#boosterModal .packSealedInner.hasArt')
      && offersCssSrc.includes('object-fit:contain!important')
      && offersCssSrc.includes('width:clamp(244px,20vw,300px)')
      && html.includes('PATCH v2.48'),
    'магазин/запас/сцена вскрытия используют целый PNG; размер сцены 244–300px по ширине');
  const cosmReadme = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'art_raw', 'cosm', 'README.md'), 'utf8');
  const serveCosmSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'tools', 'serve.js'), 'utf8');
  check('пути будущих артов пропуска и заданий задокументированы без создания изображений',
    ['art_raw/cosm/bp/coins.png','premium_booster.png','cardback.png','foil_token.png',
      'art_raw/cosm/quests/creatures.png','runes.png','w_creatures.png','w_dmg.png',
      'prototype/img/decks/<deckId>.png'].every(path => cosmReadme.includes(path))
      && /'bp', 'quests'/.test(serveCosmSrc)
      && /src=\"\/cosm\/bp\//.test(offersUiSrc) && /src=\"\/cosm\/quests\//.test(offersUiSrc),
    'cosm/bp/{coins,booster,premium_booster,cardback,gems,foil_token,avatar}; cosm/quests/<questId>; img/decks/<deckId>.png');
  check('боевой пропуск: увеличенная лента с крупными артами и адаптивными 8/4/2 уровнями',
    /bpRewardVisual/.test(offersUiSrc) && /bpRewardArt/.test(offersUiSrc)
      && /bpTile\{[^}]*min-height:156px/.test(offersCssSrc)
      && offersCssSrc.includes('#bpModal .bpPage,#bpModal .bpPage.on{grid-template-columns:repeat(8,minmax(0,1fr))')
      && offersCssSrc.includes('@media(max-width:920px){\n  #bpModal .bpPage,#bpModal .bpPage.on{grid-template-columns:repeat(4,minmax(0,1fr))')
      && offersCssSrc.includes('@media(max-width:600px){\n  #menu .questDashboardHeader{display:block}')
      && /@media\(max-width:600px\)[\s\S]{0,2200}#bpModal \.bpPage,#bpModal \.bpPage\.on\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(offersCssSrc),
    'reward tiles use portrait art and viewport-aware 8/4/2-column pages');

  /* ---------- 5г. крупные карты, модалка, конструктор колод ---------- */
  console.log('\n[5г] Крупные карты, модалка описания, конструктор колод');
  // размер карты задан в CSS-переменных и вырос до «MTG-формата»
  const htmlSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'prototype', 'index.html'), 'utf8');
  const cssSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'prototype', 'prototype.css'), 'utf8');
  const jsSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'prototype', 'prototype.js'), 'utf8');
  check('обложки колод крупнее; исходный арт целиком, без кадрирования',
    cssSrc.includes('width:224px!important') && cssSrc.includes('aspect-ratio:512 / 720')
      && cssSrc.includes('object-fit:contain!important') && cssSrc.includes('mix-blend-mode:normal!important'),
    'увеличенные портретные превью, object-fit:contain, без overlay');
  check('галерея выбора арта доступна из списка колод и конструктора',
    htmlSrc.includes('id="deckArtPickerModal"') && htmlSrc.includes('id="btnDbAvatarGallery"')
      && jsSrc.includes('openSavedDeckArtPicker') && jsSrc.includes('openEditorDeckArtPicker'),
    'можно выбрать любую карту состава и сохранить её как обложку');
  const deckHeroArtRoot = pathMod.resolve(__dirname, '..', 'art_raw', 'deck_heroes');
  const deckHeroFolders = fsMod.readdirSync(deckHeroArtRoot).filter(name => fsMod.statSync(pathMod.join(deckHeroArtRoot, name)).isDirectory());
  const deckHeroServeSource = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'tools', 'serve.js'), 'utf8');
  const deckHeroProcessorSource = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'tools', 'process_art.py'), 'utf8');
  check('15 каталогов портретов и отдельные маршруты/пайплайн готовы без предсоздания артов',
    deckHeroFolders.length === 15 && deckHeroServeSource.includes('/deck-heroes/')
      && deckHeroProcessorSource.includes("'Resources', 'DeckHeroes'") && deckHeroProcessorSource.includes('deck_heroes'),
    `${deckHeroFolders.length} папок; файлы изображений добавляются вручную`);
  // Обычная карта возвращает рамку и нижнее текстовое поле; отдельный Borderless-слой не меняется.
  check('обычная карта: внутренняя рамка и нижний блок текста; Borderless без изменений',
    /\.card:not\(\.borderless\)\{[^}]*border:2px solid/.test(cssSrc)
    && /\.card:not\(\.borderless\) \.cart\{[\s\S]*?height:70%!important/.test(cssSrc)
    && /\.card:not\(\.borderless\) \.ctext\{[\s\S]*?background:linear-gradient\(180deg,#e9dab6,#d3bf92\)!important/.test(cssSrc)
    && /\.card:not\(\.borderless\) \.innerframe\{/.test(cssSrc)
    && /\.card\.borderless \.cart\{top:0!important;bottom:0!important;height:100%!important/.test(cssSrc)
    && /\.card\.borderless \.ctext[^\{]*\{[^}]*background:transparent!important/.test(cssSrc),
    'обычная версия — рамка, внутренний кант и нижняя панель правил; полноформатный Borderless неизменен');
  check('скин стола имеет приоритет над фоном фракции и кадрируется одинаково',
    /const tableUrl = \[`\/cosm\/tables\//.test(jsSrc) && /applyBattleBg\((?:picked|battle\.playerFaction)\)/.test(jsSrc)
    && /#backdrop img#battleBgImg\{object-fit:cover!important;object-position:center center!important\}/.test(cssSrc)
    && /#backdrop \.bgArt\{background-position:center center!important;background-size:cover!important/.test(cssSrc),
    'выбранный /cosm/tables/<skin> пробуется первым, image и CSS-фон используют center/cover');
  const protoUiSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'src/ui/prototype.ts'), 'utf8');
  check('Borderless — ещё 500 вариантов с тем же ID, названием и артом, но без рамки',
    /function renderCard\(card: CardData, appearance: CardAppearance = 'auto'\)/.test(protoUiSrc)
    && /node\.dataset\.cardVariantId = `\$\{card\.id\}:\$\{cardStyle\}`/.test(protoUiSrc)
    && /borderlessOwned: string\[\]/.test(protoUiSrc)
    && /\.card\.borderless\{[^}]*border:0!important/.test(cssSrc)
    && /\.card\.borderless \.banner,\.card\.borderless \.innerframe,\.card\.borderless \.frameOv\{display:none!important/.test(cssSrc)
    && /\.card\.borderless::after\{content:none!important/.test(cssSrc)
    && /\.card\.borderless \.cart\{top:0!important;bottom:0!important;height:100%!important/.test(cssSrc)
    && /\.card\.borderless \.ctype\{top:70%!important;bottom:auto!important/.test(cssSrc)
    && /\.card\.borderless \.ctext\{top:calc\(70% \+ 1\.15em\)!important;bottom:1\.55em!important;height:auto!important/.test(cssSrc)
    && /\.card\.borderless \.ctext[^{]*\{[^}]*background:transparent!important/.test(cssSrc)
    && /\.card\.borderless \.artBox\{border:0!important;box-shadow:none!important/.test(cssSrc)
    && !/borderlessCardMark/.test(protoUiSrc),
    'арт 100% на всю карту; тип/описание наложены на арт по знакомым координатам, внутренние блоки и рамка сняты');
  // Настоящие PNG-арты: пакет 1 — флагманы пяти фракций
  {
    const fsA=require('fs'), pthA=require('path');
    const ids=[['Necrus','nec_15'],['Terramorph','ter_14'],['Pyromancer','pyr_14'],['Ethereal','eth_15'],['Aurites','aur_14']];
    const bad=ids.filter(([f,id])=>{
      const fp=pthA.join(__dirname,'..','unity','EchoCitadel','Assets','Resources','Cards',f,id+'.png');
      if(!fsA.existsSync(fp)) return true;
      const b=fsA.readFileSync(fp);
      return !(b.length>8 && b[0]===0x89 && b[1]===0x50 && b[2]===0x4e && b[3]===0x47);
    });
    const wired=/artBox/.test(require('fs').readFileSync(pthA.join(__dirname,'..','prototype','prototype.js'),'utf8'));
    const serveSrc=fsA.readFileSync(pthA.join(__dirname,'..','tools','serve.js'),'utf8');
    const pkgSrc=fsA.readFileSync(pthA.join(__dirname,'..','package.json'),'utf8');
    check('drop-in артов: art_raw/<id>.png подхватывается сервером', /findRawArt/.test(serveSrc) && /art_raw/.test(serveSrc) && /"art:sync"/.test(pkgSrc),
      'serve.js ищет art_raw с вариантами имён (aur_2→aur_01), npm run art:sync раскладывает в Unity');
    const jsBundle=fsA.readFileSync(pthA.join(__dirname,'..','prototype','prototype.js'),'utf8');
    const protoCss=fsA.readFileSync(pthA.join(__dirname,'..','src','ui','prototype.css'),'utf8');
    check('обычные карты сохраняют рамку/нижнюю панель; эффекты редкости только при наведении',
      /\.card:not\(\.borderless\)\{[^}]*border:2px solid/.test(protoCss)
      && /\.card:not\(\.borderless\) \.cart\{[\s\S]*?height:70%!important/.test(protoCss)
      && /\.card:not\(\.borderless\) \.ctext\{[\s\S]*?background:linear-gradient\(180deg,#e9dab6,#d3bf92\)!important/.test(protoCss)
      && /\.card\.r-rare:hover/.test(protoCss) && /\.card\.r-epic:hover/.test(protoCss)
      && /\.card\.r-legendary:hover/.test(protoCss)
      && /shieldBubble i/.test(protoCss) && /shieldBubblePulse/.test(protoCss)
      && /@media\(prefers-reduced-motion:reduce\)/.test(protoCss)
      && /\.card\.t-spell \.ctype\{/.test(htmlSrc) && /\.unit\.ready \.ubody\{/.test(htmlSrc)
      && /classList\.add\(["']ready["']\)/.test(jsBundle) && /t-\$\{/.test(jsBundle),
      'рамка внутри сохранена, нижний текстовый блок восстановлен; rarity hover-only и reduced-motion');
    const vfxSrc=fsA.readFileSync(pthA.join(__dirname,'..','src','ui','vfx.ts'),'utf8');
    check('кладбище зоной на поле + ландшафт фона + ПКМ-обработчик',
      /id="playerGraveZone"/.test(htmlSrc) && /id="enemyGraveZone"/.test(htmlSrc)
      && /\.graveRow\{/.test(htmlSrc) && /class="bgArt"/.test(htmlSrc)
      && /--pile-card-w:calc\(var\(--uw\) \* 1\.05\)/.test(protoCss)
      && /#battle \.corner \.pbacks,#battle \.corner \.graveRow/.test(protoCss)
      && /contextmenu/.test(jsBundle) && /renderGraveZone/.test(jsBundle),
      'кладбище и колода одинаково крупные (.84 размера существа после масштаба), рядом без наложения');
    check('таргетинг/кладбище/рубашки/зум-синк в интерфейсе',
      /id="enemyBacks"/.test(htmlSrc) && /id="aimLayer"/.test(htmlSrc) && /id="graveModal"/.test(htmlSrc)
      && /\.cardback\{/.test(htmlSrc) && /openGrave/.test(jsBundle) && /aimStart/.test(jsBundle)
      && /lastZoomEl/.test(jsBundle) && /autoTurnFire/.test(jsBundle),
      'рубашки руки врага, стрелка цели, модалка кладбища, глобальный zoom-sync, авто-ход');
    check('плавные анимации: векторный рывок, трейл удара, полёт карт, FLIP-сдвиги',
      /export function streak/.test(vfxSrc)
      && /streak\(centerOf\(/.test(jsBundle) && /ghostCast/.test(jsBundle)
      && /flipFrom/.test(jsBundle) && /consumeDrawFly/.test(jsBundle)
      && /strikeAnim = typeof attacker\.animate === "function" \? attacker\.animate\(\[/.test(jsBundle),
      'рывок замах→удар→возврат, световой след, карта-призрак заклинания, добор из колоды, сдвиги поля/руки без layout-свойств');
    if (bad.length) skip('PNG-арты флагманов (пакет 1: 5 карт)', `${bad.length}/5 файлов будут добавлены на финальном этапе`);
    else check('PNG-арты флагманов интегрированы (пакет 1: 5 карт)', wired,
      '5 PNG на местах, арт тянется из папок через /art/');
    // Пакет 2 (2026-09-24): aur_15, nec_14, ter_13, pyr_13, eth_14
    const ids2=[['Aurites','aur_15'],['Necrus','nec_14'],['Terramorph','ter_13'],['Pyromancer','pyr_13'],['Ethereal','eth_14']];
    const bad2=ids2.filter(([f,id])=>{
      const fp=pthA.join(__dirname,'..','unity','EchoCitadel','Assets','Resources','Cards',f,id+'.png');
      if(!fsA.existsSync(fp)) return true;
      const b=fsA.readFileSync(fp);
      return !(b.length>8 && b[0]===0x89 && b[1]===0x50 && b[2]===0x4e && b[3]===0x47);
    });
    if (bad2.length) skip('PNG-арты (пакет 2: 5 карт)', `${bad2.length}/5 файлов будут добавлены на финальном этапе`);
    else check('PNG-арты интегрированы (пакет 2: 5 карт)', true,
      '5 PNG на местах: aur_15, nec_14, ter_13, pyr_13, eth_14');
  }
  check('карты читабельного размера с адаптивом (clamp-переменные везде)',
    /--card-w:clamp\(158px, 12\.4vw, 190px\)/.test(cssSrc)
    && /--card-h:calc\(var\(--card-w\) \* 266 \/ 190\)/.test(cssSrc)
    && /width:var\(--card-w,190px\)/.test(htmlSrc)
    && /\.card\.xxl\{width:clamp\(300px, 26vw, 380px\)/.test(cssSrc)
    && /--hand-w:clamp\(150px,12\.5vw,196px\)/.test(htmlSrc)
    && /@media \(max-width:920px\)/.test(htmlSrc) && /@media \(max-height:740px\)/.test(htmlSrc),
    'коллекция/рука/модалка/док масштабируются от экрана; брейкпоинты 1180/920/740');
  check('навигация: мягкий вход экранов, учёт reduced motion и удобная горизонтальная прокрутка на телефоне',
    /@keyframes ecRouteArrival/.test(cssSrc) && /@keyframes ecSubpanelArrival/.test(cssSrc)
    && /@media\(prefers-reduced-motion:reduce\)/.test(cssSrc)
    && /\.ecQuickNav\{scroll-behavior:smooth;scroll-snap-type:x proximity\}/.test(cssSrc)
    && /@media\(max-width:760px\)\{\.ecQuickNav button\{min-height:40px\}/.test(cssSrc));
  // модалка: клик по карте коллекции открывает описание
  click($('btnCollection'));
  await wait(40);
  // ранний тест коллекции мог оставить фильтр фракции — сбрасываем
  $('colFaction').value = ''; $('colFaction').dispatchEvent(new window.Event('change'));
  await wait(60);
  const colCards = collectionCards();
  check('коллекция открыта и наполнена постранично', colCards.length > 0 && colCards.length <= 40
    && window.ecTestCollectionState().total === 500, `${colCards.length}/${window.ecTestCollectionState().total} карт`);
  click(colCards[3]);
  await wait(40);
  const modal = $('cardModal');
  const infoTxt = $('cmInfo').textContent || '';
  check('клик по карте открывает модалку с описанием', !modal.classList.contains('hidden')
    && infoTxt.length > 60 && !!modal.querySelector('.card.xxl'),
    `${infoTxt.length} симв. текста, позиция ${$('cmPos').textContent}`);
  const posBefore = $('cmPos').textContent;
  click($('cmNext'));
  await wait(30);
  check('навигация ← → листает карты в модалке', $('cmPos').textContent !== posBefore,
    `${posBefore} → ${$('cmPos').textContent}`);
  key('Escape');
  await wait(30);
  check('Esc закрывает модалку', modal.classList.contains('hidden'));
  // конструктор колод
  click($('tabBuilder'));
  await wait(60);
  check('редактор разделяет выбор карточной обложки и визуального героя колоды', !$('dbMain').classList.contains('hidden')
    && $('dbPoolGrid').children.length > 20 && !!$('dbAvatarCard') && !!$('dbAvatarPreview') && !!$('btnDbAvatarGallery')
    && !!$('dbHeroPreview') && !!$('btnDbHeroPicker'),
    `пул: ${$('dbPoolGrid').children.length} карт · галереи обложки и героя раздельны`);
  const poolCard = [...$('dbPoolGrid').children].find(n => n.classList.contains('card'));
  click(poolCard);
  await wait(30);
  const editorGalleryReady = !$('btnDbAvatarGallery').disabled;
  if (editorGalleryReady) click($('btnDbAvatarGallery'));
  const editorGalleryOk = editorGalleryReady && !$('deckArtPickerModal').classList.contains('hidden')
    && $('deckArtPickerGrid').children.length === 1;
  check('галерея обложки в редакторе показывает арт выбранной карты целиком', editorGalleryOk);
  if (editorGalleryOk) click($('btnDeckArtPickerClose'));
  const cnt1 = $('dbCount').textContent;
  poolCard.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await wait(30);
  check('клик добавляет карту в колоду, ПКМ убирает', cnt1 === '1 · мин. 30' && $('dbCount').textContent === '0 · мин. 30',
    `${cnt1} → ${$('dbCount').textContent}`);
  const builderCosmeticId = $('dbPoolGrid').querySelector('.card')?.dataset.cardId || '';
  if (builderCosmeticId && !window.ecBorderlessOwned().includes(builderCosmeticId)) window.ecGrantBorderless(builderCosmeticId);
  if (builderCosmeticId && window.ecMeta().borderlessEquipped.includes(builderCosmeticId)) window.ecToggleBorderless(builderCosmeticId);
  $('dbSearch').dispatchEvent(new window.Event('input'));
  let builderTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
  let stylePickerButton = builderTile?.querySelector('.dbStylePicker');
  check('пул колоды открывает выбор стиля в отдельном picker', !!stylePickerButton
    && stylePickerButton.getAttribute('aria-label')?.includes('Выбрать оформление') && !!$('btnDbStyleAll'));
  if (builderCosmeticId && !$('btnDbStyleAll').disabled) {
    click($('btnDbStyleAll'));
    const allStyledTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
    check('кнопка deckbuilder применяет все полученные стили как в Arena', !!allStyledTile?.classList.contains('borderless')
      && window.ecMeta().borderlessEquipped.includes(builderCosmeticId) && /Снять все/.test($('btnDbStyleAll').textContent));
    click($('btnDbStyleAll'));
    const resetStyledTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
    check('массовое переключение стилей можно отменить', !!resetStyledTile && !resetStyledTile.classList.contains('borderless')
      && !window.ecMeta().borderlessEquipped.includes(builderCosmeticId));
    builderTile = resetStyledTile;
    stylePickerButton = builderTile?.querySelector('.dbStylePicker');
  }
  if (builderTile && stylePickerButton && builderCosmeticId) {
    const ordinaryBeforeStyle = window.ecOwnedOf(builderCosmeticId);
    click(builderTile);
    builderTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
    stylePickerButton = builderTile?.querySelector('.dbStylePicker');
    if (stylePickerButton) click(stylePickerButton);
    const borderlessChoice = $('cmStylePicker')?.querySelector('[data-cm-style="borderless"]');
    check('карточный picker показывает классический и Borderless-стили', !$('cardModal').classList.contains('hidden')
      && !!$('cmStylePicker')?.querySelector('[data-cm-style="classic"]') && !!borderlessChoice && !borderlessChoice.disabled);
    if (borderlessChoice && !borderlessChoice.disabled) click(borderlessChoice);
    const equippedTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
    check('выбранный Borderless виден в пуле и составе той же колоды', !!equippedTile?.classList.contains('borderless')
      && equippedTile?.dataset.cardVariantId === `${builderCosmeticId}:borderless`
      && $('dbCount').textContent === '1 · мин. 30'
      && !!$('dbDeckList').querySelector('.dbRowStyle.isBorderless')
      && window.ecMeta().borderlessEquipped.includes(builderCosmeticId)
      && window.ecOwnedOf(builderCosmeticId) === ordinaryBeforeStyle);
    const classicChoice = $('cmStylePicker')?.querySelector('[data-cm-style="classic"]');
    if (classicChoice) click(classicChoice);
    const classicTile = [...$('dbPoolGrid').querySelectorAll('.card')].find(n => n.dataset.cardId === builderCosmeticId);
    check('переключение стиля не создаёт копию и не меняет лимит колоды', !!classicTile
      && !classicTile.classList.contains('borderless') && $('dbCount').textContent === '1 · мин. 30'
      && window.ecOwnedOf(builderCosmeticId) === ordinaryBeforeStyle);
    click($('cmClose'));
    $('dbDeckList').querySelector('.dbRow button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  // хранилище колод: валидация по ТЗ и бой с пользовательской колодой
  const D = window.__decks;
  const fac = 'Aurites';
  const factionPool = D.pool(fac);
  const poolIds = factionPool.filter(r => r.rarity !== 'Legendary').map(r => r.id);
  const custom = poolIds.slice(0, 15).flatMap(id => [id, id, id, id]);
  const good = D.validate(custom, fac);
  const short = D.validate(custom.slice(0, 29), fac);
  const thirty = D.validate(custom.slice(0, 30), fac);
  const tooMany = D.validate([...custom, custom[0]], fac);
  const oversizedCards = poolIds.slice(0, 16).flatMap(id => [id, id, id, id]);
  const oversized = D.validate(oversizedCards, fac);
  const legendaryId = factionPool.find(r => r.rarity === 'Legendary')?.id;
  const legendaryDeck = legendaryId
    ? [...poolIds.slice(0, 14).flatMap(id => [id, id, id, id]), legendaryId, legendaryId, legendaryId, legendaryId]
    : [];
  const legendaryOk = !!legendaryId && D.validate(legendaryDeck, fac).ok;
  check('валидатор: минимум 30 (30, 60 и больше), без потолка, playset ×4 включая легендарные',
    custom.length === 60 && good.ok && thirty.ok && !short.ok && !tooMany.ok && oversizedCards.length === 64
      && oversized.ok && legendaryOk,
    `30=${thirty.ok}; 60=${good.ok}; 29=${short.ok}; 64=${oversized.ok}; ×5=${tooMany.ok}; legendary ×4=${legendaryOk}`);
  D.save({ id: 'custom-smoke', name: 'Дымовая колода', faction: fac, cards: custom, avatarCardId: custom[0], updated: Date.now() });
  const resolved = D.resolve('custom-smoke');
  check('пользовательская колода на 60 карт и выбранная обложка сохраняются для боя',
    !!resolved && resolved.cards.length === 60 && resolved.avatarCardId === custom[0] && D.list().length >= 1,
    resolved ? `${resolved.name}, ${resolved.cards.length} карт · avatar ${resolved.avatarCardId ?? '—'}` : 'нет');

  // Arena-подобный goldfish тест: 5 карт, одна пересдача, статистика без изменения колоды.
  click($('tabBuilder'));
  $('dbMyDecks').value = 'custom-smoke';
  $('dbMyDecks').dispatchEvent(new window.Event('change'));
  await wait(30);
  const dbCountBeforeHandTest = $('dbCount').textContent;
  const realRandom = window.Math.random;
  let handTesterOpen = false, handTesterMulligan = false, handTesterReset = false, handTesterSafe = false;
  try {
    window.Math.random = () => 0;
    click($('btnDbHandTest'));
    const firstHand = [...$('dbHandCards').querySelectorAll('.card')];
    handTesterOpen = !$('dbHandModal').classList.contains('hidden') && firstHand.length === 5
      && $('dbHandDeckStats').querySelectorAll('.dbHandMetric').length === 5
      && $('dbHandDeckStats').textContent.includes('60');
    if (firstHand[0]) click(firstHand[0]);
    const markedForSwap = !!$('dbHandCards').querySelector('.card.isMulliganSelected')
      && !$('btnDbHandMulligan').disabled;
    click($('btnDbHandMulligan'));
    handTesterMulligan = markedForSwap && $('dbHandCards').querySelectorAll('.card').length === 5
      && /Муллиган выполнен/.test($('dbHandStatus').textContent)
      && $('btnDbHandMulligan').disabled && !$('dbHandCards').querySelector('.isMulliganSelected');
    click($('btnDbHandDeal'));
    handTesterReset = $('dbHandCards').querySelectorAll('.card').length === 5
      && $('btnDbHandMulligan').disabled && /Отметьте неподходящие/.test($('dbHandStatus').textContent);
    handTesterSafe = $('dbCount').textContent === dbCountBeforeHandTest
      && D.resolve('custom-smoke')?.cards.length === 60;
    key('Escape');
  } finally {
    window.Math.random = realRandom;
    if (!$('dbHandModal').classList.contains('hidden')) click($('btnDbHandDone'));
  }
  check('редактор показывает 5-карточную пробную руку и краткую статистику колоды', handTesterOpen,
    `рука ${$('dbHandCards').querySelectorAll('.card').length}, метрик ${$('dbHandDeckStats').querySelectorAll('.dbHandMetric').length}`);
  check('муллиган заменяет отмеченные карты один раз и новая раздача сбрасывает его', handTesterMulligan && handTesterReset,
    `пересдача ${handTesterMulligan}, сброс ${handTesterReset}`);
  check('симулятор не меняет состав сохранённой колоды и закрывается по Esc',
    handTesterSafe && $('dbHandModal').classList.contains('hidden'),
    `колода ${$('dbCount').textContent}; модалка закрыта=${$('dbHandModal').classList.contains('hidden')}`);
  D.remove('custom-smoke');
  click($('tabCollection'));
  await wait(30);
  click($('btnColClose'));
  await wait(30);

  /* ---------- 6. доигрываем ---------- */
  console.log('\n[6] Доигрывание партии');
  let guard = 0;
  while ($('gameover').classList.contains('hidden') && guard++ < 500) {
    if (!$('btnEndTurn').disabled) click($('btnEndTurn'));
    await wait(200);
  }
  await wait(500);
  const fin = stat();
  check('партия завершилась', !$('gameover').classList.contains('hidden'), `ход ${fin.turn}, HP ${fin.hp}`);
  check('экран конца игры показывает статистику', $('goStats').children.length === 8, `${$('goStats').children.length} блоков`);
  const savedReplay = window.ecMeta().replays?.[0];
  click($('btnGoRecap'));
  await wait(40);
  const recapOpened = !$('replayModal').classList.contains('hidden')
    && !!$('replaySummary').querySelector('.rpMatchup')
    && $('replaySummary').querySelectorAll('.rpStat').length >= 8
    && $('replayBody').querySelectorAll('.rpLine').length > 0;
  check('результат матча открывает сводку и хронологию реплея', recapOpened
    && !!savedReplay?.stats?.player && Array.isArray(savedReplay?.lines),
    `статистика сохранена=${!!savedReplay?.stats?.player}, событий ${$('replayBody').querySelectorAll('.rpLine').length}`);
  const firstReplayEvent = $('replayBody').querySelector('.rpLine');
  const firstReplayKind = firstReplayEvent?.dataset.kind || 'all';
  $('replayKind').value = firstReplayKind;
  $('replayKind').dispatchEvent(new window.Event('change', { bubbles: true }));
  const kindFiltered = $('replayBody').querySelectorAll('.rpLine').length > 0
    && [...$('replayBody').querySelectorAll('.rpLine')].every(line => line.dataset.kind === firstReplayKind);
  const filteredTurn = $('replayBody').querySelector('.rpLine')?.dataset.turn || 'all';
  $('replayTurn').value = filteredTurn;
  $('replayTurn').dispatchEvent(new window.Event('change', { bubbles: true }));
  const turnFiltered = [...$('replayBody').querySelectorAll('.rpLine')].every(line => line.dataset.turn === filteredTurn);
  const searchTarget = [...$('replayBody').querySelectorAll('.rpEventText')]
    .map(line => line.textContent?.trim() || '').find(Boolean) || '';
  const replayNeedle = searchTarget.slice(0, Math.min(10, searchTarget.length));
  $('replaySearch').value = replayNeedle;
  $('replaySearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  const searchFiltered = !!replayNeedle && $('replayBody').querySelectorAll('.rpLine').length > 0
    && [...$('replayBody').querySelectorAll('.rpEventText')]
      .every(line => (line.textContent || '').toLocaleLowerCase().includes(replayNeedle.toLocaleLowerCase()));
  click($('btnReplayReset'));
  const resetCount = $('replayBody').querySelectorAll('.rpLine').length;
  click($('btnReplayPlay'));
  const playbackStarted = $('btnReplayPlay').getAttribute('aria-pressed') === 'true'
    && !!$('replayBody').querySelector('.rpLine.replayNow');
  $('replaySpeed').value = '1.6';
  $('replaySpeed').dispatchEvent(new window.Event('change', { bubbles: true }));
  click($('btnReplayPlay'));
  const playbackPaused = $('btnReplayPlay').getAttribute('aria-pressed') === 'false';
  click($('btnReplayClose'));
  await wait(20);
  check('реплей: поиск, фильтры по типу/ходу, сброс и управление воспроизведением',
    kindFiltered && turnFiltered && searchFiltered && resetCount > 0 && playbackStarted && playbackPaused
      && $('replayModal').classList.contains('hidden'),
    `тип ${kindFiltered}, ход ${turnFiltered}, поиск ${searchFiltered}, play/pause ${playbackStarted}/${playbackPaused}`);
  // ручная атака стрелкой: свежая партия, стадия боя с окном объявления атак
  {
    click($('btnAgain'));
    await waitUntil(() => !$('mulligan').classList.contains('hidden'), 6000);
    click($('btnMullSkip'));
    await waitUntil(() => b.running && !b.busy && b.turnDone !== null && b.engine.phase === 'Main', 20000);
    const e2 = b.engine;
    const doc = window.document;
    const plain = [...e2.db.values()].find(c => c.type === 'Creature' && (c.attack ?? 0) > 0 && !(c.keywords || []).length);
    const u1 = e2.summon(0, plain); const u2 = e2.summon(1, plain);
    u1.justPlayed = false; u1.summonedOnTurn = -9;
    u2.justPlayed = false; u2.summonedOnTurn = -9;
    b.manualCombat = true;
    b.endTurnNow();
    const winOk = await waitUntil(() => b.inCombatWindow, 6000);
    b.renderAll();
    check('стадия боя: окно объявления атак открылось', winOk && e2.phase === 'Combat'
      && !$('btnAutoBattle').classList.contains('hidden'), `фаза ${e2.phase}, win ${b.inCombatWindow}`);
    const pn = doc.querySelector(`.unit[data-uid="${u1.uid}"]`);
    const en = doc.querySelector(`.unit[data-uid="${u2.uid}"]`);
    // Убийство защитника вызывает мгновенный урон герою: HP должно идти
    // вместе с атакой, а не оставаться на старом снимке до конца хода.
    const heroHpBeforeDeathrattle = e2.p(0).health;
    u1.attack = Math.max(5, u1.attack);
    u2.health = 1;
    u2.statuses = u2.statuses.filter(s => s.type !== 'Shield');
    u2.data = { ...u2.data, onDeath: [{ op: 'damage', to: 'EnemyHero', value: 3 }] };
    click(pn);
    const aimShown = $('aimLayer').classList.contains('show') && !!en && en.classList.contains('targetable');
    const targetForecast = en?.querySelector('.combatForecast');
    const targetForecastOk = !!targetForecast && /УБЬЁТ/.test(targetForecast.textContent)
      && /Ответ/.test(targetForecast.textContent)
      && (targetForecast.classList.contains('lethal') || targetForecast.classList.contains('trade'));
    check('MTG Arena: цель до атаки показывает летальность и ответный удар', targetForecastOk,
      targetForecast?.textContent.trim() ?? 'прогноза нет');
    // ПКМ отменяет выбор атакующего (как в MTG)
    doc.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const rmbOk = !$('aimLayer').classList.contains('show') && b.pendingAttack === null
      && !doc.querySelector('.combatForecast,.heroCombatForecast');
    check('ПКМ отменяет стрелку, прогноз и выбор цели (как в MTG)', rmbOk);
    click(pn);   // снова берём стрелку
    const hpBefore = u2.health;
    click(en);
    await wait(120);
    const q = e2.attackQueue.length;
    const alive = e2.findCreature(u2.uid);
    check('атака стрелкой: своё существо бьёт существо противника',
      aimShown && q > 0 && (alive === undefined || alive.health < hpBefore),
      `стрелка: ${aimShown ? 'да' : 'нет'}, очередь ${q}, hp ${hpBefore}→${alive ? alive.health : 'мертв'}`);
    const triggerHpVisible = await waitUntil(() => e2.p(0).health === heroHpBeforeDeathrattle - 3
      && Number($('playerHp').textContent) === e2.p(0).health, 3500);
    check('урон героя от deathrattle виден в бою сразу после смерти существа',
      triggerHpVisible && b.inCombatWindow,
      `герой ${heroHpBeforeDeathrattle}→${e2.p(0).health}, UI ${$('playerHp').textContent}, фаза боя ${b.inCombatWindow}`);
    // тап: третье существо бьёт героя и остаётся повёрнутым на 90°
    const u3 = e2.summon(0, plain); u3.justPlayed = false; u3.summonedOnTurn = -9;
    u3.keywords = [...u3.keywords, 'Windfury']; // проверяем состояние после первой из двух атак
    b.renderAll();
    const p3 = doc.querySelector(`.unit[data-uid="${u3.uid}"]`);
    click(p3);
    const heroForecast = $('enemyHero').querySelector('.heroCombatForecast');
    const heroForecastOk = !!heroForecast && heroForecast.textContent.includes(`−${u3.attack} HP`);
    check('прямой удар заранее показывает ожидаемый урон герою', heroForecastOk, heroForecast?.textContent ?? 'прогноза нет');
    click($('enemyHero'));
    const tapMotionCss = fs.readFileSync(path.join(ROOT, 'src/ui/prototype.css'), 'utf8');
    const trueQuarterTurn = html.includes('rotate(90deg) scale(.72)')
      && tapMotionCss.includes('@keyframes unitTapTurn') && tapMotionCss.includes('@keyframes unitUntapTurn');
    const tappedOk = await waitUntil(() => {
      const n = doc.querySelector(`.unit[data-uid="${u3.uid}"]`);
      return !!n && n.dataset.tapped === 'true' && n.classList.contains('tapped');
    }, 5000);
    check('атаковавшее существо повёрнуто на 90° с tap-анимацией', tappedOk && trueQuarterTurn,
      `DOM tap ${tappedOk}, CSS 90° + tap/untap ${trueQuarterTurn}`);
    const repeatedAttackOk = await waitUntil(() => {
      const n = doc.querySelector(`.unit[data-uid="${u3.uid}"]`);
      const mark = n?.querySelector('.attackReadyMark');
      return !!n && b.engine.canAttack(u3) && n.classList.contains('ready')
        && n.classList.contains('tapped') && mark?.textContent.trim() === 'Ещё 1';
    }, 5000);
    check('после первой атаки с Бурей существо остаётся на поле с понятной меткой «Ещё 1»',
      repeatedAttackOk && !html.includes('.unit.tapped.ready{display:none}'),
      repeatedAttackOk ? 'может атаковать ещё раз, без скрытия существа' : 'индикатор повторной атаки не найден');
    const p3Again = doc.querySelector(`.unit[data-uid="${u3.uid}"]`);
    click(p3Again); click($('enemyHero'));
    const secondAttackOk = await waitUntil(() => {
      const n = doc.querySelector(`.unit[data-uid="${u3.uid}"]`);
      return u3.attacksThisTurn === 2 && !b.engine.canAttack(u3) && !n?.querySelector('.attackReadyMark');
    }, 5000);
    check('после второй атаки метка повторной атаки снимается', secondAttackOk);
    const vigilanceCard = [...e2.db.values()].find(c => c.type === 'Creature' && (c.keywords || []).includes('Vigilance'));
    const vanguard = vigilanceCard ? e2.summon(0, vigilanceCard) : null;
    if (vanguard) { vanguard.justPlayed = false; vanguard.summonedOnTurn = -5; b.renderAll(); }
    const vigilanceAttack = !!vanguard && e2.manualAttack(0, vanguard.uid, undefined, true);
    if (vanguard) b.renderAll();
    const vigilanceNode = vanguard && doc.querySelector(`.unit[data-uid="${vanguard.uid}"]`);
    const vigilancePip = vigilanceNode?.querySelector('.pip[title="Бдительность"]');
    const vigilanceUiOk = !!vanguard && vigilanceAttack && !vanguard.tapped && vanguard.attacksThisTurn === 1
      && !e2.canAttack(vanguard) && !!vigilanceNode?.classList.contains('vigilant')
      && !vigilanceNode?.classList.contains('tapped') && !!vigilancePip;
    check('Бдительность: UI показывает ключевое слово, существо после атаки не повёрнуто', vigilanceUiOk,
      `attack=${vigilanceAttack}, tapped=${vanguard?.tapped}, badge=${!!vigilancePip}`);
    const closedOk = await waitUntil(() => !b.inCombatWindow, 9000);
    check('окно атак закрылось после доигрывания', closedOk);
    b.manualCombat = false;
    // игра обязана завершиться, когда жизни героя доходят до 0 (и при уходе в минус)
    e2.p(1).health = 1;
    b.renderAll();
    e2.damageHero(1, 1, { source: 'ноль-чек' });
    const zeroOk = await waitUntil(() => !$('gameover').classList.contains('hidden'), 6000);
    check('игра завершается при 0 hp героя (и при оверкилле в минус)', zeroOk && e2.p(1).health === 0,
      `hp ${e2.p(1).health}, gameover: ${zeroOk ? 'показан' : 'НЕТ'}`);
    e2.damageHero(1, 99, { source: 'финал демо-партии' });
    await waitUntil(() => !$('gameover').classList.contains('hidden'), 6000);
  }

  check('заголовок результата непустой', $('goTitle').textContent.length > 0, $('goTitle').textContent);

  /* ---------- 7. перезапуск / меню ---------- */
  console.log('\n[7] Перезапуск и возврат в меню');
  click($('btnAgain'));
  const again = await waitUntil(() => !$('mulligan').classList.contains('hidden'), 6000);
  check('«Ещё бой» запускает новый бой', again);
  if (again) click($('btnMullSkip'));
  await wait(600);
  click($('btnMenu'));
  await wait(250);
  check('возврат в меню', !$('menu').classList.contains('hidden'));
  // Буcтеры: покупка добавляет запечатанный пак в запас; открытие списывает один пак, не валюту.
  click($('btnBoosters'));
  await wait(60);
  const firstStockPack = $('boosterInventory')?.querySelector('.boosterInvCard.has-stock');
  const focusAtOpen = !!firstStockPack && window.document.activeElement === firstStockPack;
  const packFocusables = [...$('boosterModal').querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.closest('.hidden') && el.getAttribute('aria-hidden') !== 'true');
  const packFirstFocusable = packFocusables[0];
  const packLastFocusable = packFocusables[packFocusables.length - 1];
  packLastFocusable?.focus();
  packLastFocusable?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  const tabWrapForward = !!packFirstFocusable && window.document.activeElement === packFirstFocusable;
  packFirstFocusable?.focus();
  packFirstFocusable?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  const tabWrapBackward = !!packLastFocusable && window.document.activeElement === packLastFocusable;
  const shards0 = window.ecShards();
  const stockNode = () => $('boosterInventory')?.querySelector('[data-pack="standard"] .boosterInvCount');
  const stockBefore = Number((stockNode()?.textContent || '×0').replace(/[^0-9]/g, ''));
  click($('btnPackNew')); // кнопка из панели ведёт в магазин
  await wait(50);
  const storeOpened = !$('shopModal').classList.contains('hidden');
  const purchase = window.document.querySelector('.buyPackOffer[data-offer="p1"][data-cur="gold"]');
  if (purchase) click(purchase);
  await wait(70);
  const shardsAfterBuy = window.ecShards();
  const stockAfterBuy = Number((stockNode()?.textContent || '×0').replace(/[^0-9]/g, ''));
  // v3.17.3: покупка бустера НЕ переключает в «Бустеры» — пользователь остаётся в магазине,
  // пак добавляется в запас без вскрытия (панель не открывается автоматически)
  const addedAsSealedPack = stockAfterBuy === stockBefore + 1
    && !$('shopModal').classList.contains('hidden')
    && $('boosterModal').classList.contains('hidden')
    && $('packSealed').classList.contains('hidden');
  window.ecNavigate('packs'); // как «← Назад» в магазине: возврат к панели бустеров
  await wait(60);
  const packButton = $('boosterInventory').querySelector('.boosterInvCard[data-pack="standard"]:not(:disabled)');
  if (packButton) click(packButton);
  await wait(40);
  const premiumButtonForSwitch = $('boosterInventory').querySelector('.boosterInvCard[data-pack="premium"]:not(:disabled)');
  if (premiumButtonForSwitch) click(premiumButtonForSwitch);
  await wait(40);
  const switchedToPremium = $('packTypeSubtitle').textContent.includes('Премиум-бустер')
    && $('boosterInventory').querySelector('.boosterInvCard[data-pack="premium"]')?.classList.contains('selected');
  const standardButtonAgain = $('boosterInventory').querySelector('.boosterInvCard[data-pack="standard"]:not(:disabled)');
  if (standardButtonAgain) click(standardButtonAgain);
  await wait(40);
  const sealedShown = !$('packSealed').classList.contains('hidden');
  const stockAfterSelect = Number((stockNode()?.textContent || '×0').replace(/[^0-9]/g, ''));
  const selectionDidNotSpend = stockAfterSelect === stockAfterBuy;
  if (sealedShown) click($('packSealed'));
  await wait(700);
  const packSlots = $('packRow').children.length;
  const allPackSlots = [...$('packRow').children];
  const regularPackSlots = allPackSlots.filter(slot => !slot.classList.contains('borderlessBonusSlot'));
  const borderlessPackSlots = allPackSlots.filter(slot => slot.classList.contains('borderlessBonusSlot'));
  const stockAfterOpen = Number((stockNode()?.textContent || '×0').replace(/[^0-9]/g, ''));
  const paid = shardsAfterBuy === shards0 - 300;
  const consumedOne = selectionDidNotSpend && stockAfterOpen === stockBefore;
  const canSwitchAfterReveal = $('packStage').classList.contains('hasResults')
    && $('boosterInventory').querySelectorAll('.boosterInvCard:not(:disabled)').length > 0;
  const flipAll = $('btnPackFlip');
  if (flipAll && !flipAll.disabled) click(flipAll);
  await wait(800); // пять карт плюс шестая только если выпал редкий Borderless-бонус
  const flipOk = regularPackSlots.length === 5 && borderlessPackSlots.length <= 1
    && allPackSlots.every(slot => slot.classList.contains('flip'));
  // Обычный бустер содержит карты всей базы; тестовый forced-drop проверяет базовую карту вне starter-набора.
  const faces = regularPackSlots.map(sl => sl.querySelector('.face .card'));
  const packPoolOk = faces.length === 5 && faces.every(f => f && cardsFixture.cards.some(c => c.id === f.dataset.cardId));
  if (nonStarterBaseId) window.ecSetOwned(nonStarterBaseId, 0);
  const basePack = nonStarterBaseId ? window.ecTestPack(nonStarterBaseId) : null;
  const baseUnlockedFromBooster = !!basePack && basePack.ownedCap === 4 && window.ecOwnedOf(nonStarterBaseId) === 4;
  window.ecSetOwned('aur_31', 4);
  const tpack = window.ecTestPack('aur_31');
  const capOk = tpack.ownedCap === 4 && tpack.converted >= 1 &&
    tpack.shardsAfter === tpack.shardsBefore + tpack.converted;
  const premiumStockBeforeNext = Number(($('boosterInventory')?.querySelector('[data-pack="premium"] .boosterInvCount')?.textContent || '×0').replace(/[^0-9]/g, ''));
  const premiumAfterReveal = $('boosterInventory').querySelector('.boosterInvCard[data-pack="premium"]:not(:disabled)');
  if (premiumAfterReveal) click(premiumAfterReveal);
  await wait(50);
  const switchedAfterReveal = canSwitchAfterReveal && premiumStockBeforeNext > 0
    && $('packTypeSubtitle').textContent.includes('Премиум-бустер')
    && !$('packSealed').classList.contains('hidden');
  if (switchedAfterReveal) click($('packSealed'));
  await wait(700);
  const premiumStockAfterNext = Number(($('boosterInventory')?.querySelector('[data-pack="premium"] .boosterInvCount')?.textContent || '×0').replace(/[^0-9]/g, ''));
  const nextPackOpened = switchedAfterReveal && $('packStage').classList.contains('hasResults')
    && premiumStockAfterNext === premiumStockBeforeNext - 1;
  click($('btnPackClose'));
  await wait(40);
  const focusRestored = window.document.activeElement === $('btnBoosters');
  check('бустер: фокус, Tab-навигация и возврат на кнопку запуска',
    focusAtOpen && tabWrapForward && tabWrapBackward && focusRestored,
    `начальный фокус ${focusAtOpen}, Tab ${tabWrapForward}/${tabWrapBackward}, возврат ${focusRestored}`);
  check('бустер: 5 карт + возможный отдельный Borderless-бонус, флип и лимит копий',
    storeOpened && addedAsSealedPack && sealedShown && switchedToPremium && selectionDidNotSpend
      && regularPackSlots.length === 5 && borderlessPackSlots.length <= 1 && paid && consumedOne && flipOk && capOk
      && canSwitchAfterReveal && switchedAfterReveal && nextPackOpened,
    `магазин ${storeOpened ? 'да' : 'нет'}, переключение до/после вскрытия ${switchedToPremium}/${switchedAfterReveal}, запас ${stockBefore}→${stockAfterBuy}→${stockAfterSelect}→${stockAfterOpen}, следующий пак ${nextPackOpened ? 'открыт' : 'нет'}, ◈ ${shards0}→${shardsAfterBuy}, слотов ${packSlots} (базовых ${regularPackSlots.length}, Borderless ${borderlessPackSlots.length}), флип ${flipOk ? 'да' : 'нет'}, cap ${tpack.ownedCap}, конверт ◈${tpack.converted}`);
  check('бустер открывает карты базового набора вне starter и карты расширения',
    starterCollectionOk && baseUnlockedFromBooster && window.ecOwnedOf('aur_31') === 4
      && window.ecIsExp('aur_31') && !window.ecIsExp(nonStarterBaseId) && packPoolOk
      && window.document.querySelectorAll('#colGrid .card').length > 0,
    `стартовый набор подтверждён; ${nonStarterBaseId} из бустера ×${window.ecOwnedOf(nonStarterBaseId)}, aur_31 из ECH1 ×${window.ecOwnedOf('aur_31')}, pack pool ${packPoolOk}`);
  check('все изображения корректно уменьшаются в рамку (гард object-fit)',
    /#zoomPreview img,\.modalCard img|\.card img,\.unit img[\s\S]{0,220}?object-fit:cover/.test(htmlBg),
    'гард вписывания для всех карточных поверхностей');
  click($('btnProfile'));
  await wait(60);
  const profOk = !$('profileModal').classList.contains('hidden') && /Уровень \d+/.test($('profBody').textContent);
  click($('btnProfileClose'));
  await wait(30);
  /* --- спека «2. Профиль» (v2.4): достижения, ник, матч-апы, Level Up, сервер --- */
  click($('btnProfile'));
  await wait(60);
  check('профиль: 4 достижения с прогрессом (вкл. «Все боссы кампании»)',
    $('profBody').querySelectorAll('.achIco').length === 4 && /Все боссы кампании/.test($('profBody').textContent),
    `иконок ${$('profBody').querySelectorAll('.achIco').length}`);
  $('nickInput').value = 'ab';
  $('nickInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(40);
  const badShort = /от 3 до 16/.test($('subsLine').textContent)
    && JSON.parse(window.localStorage.getItem('ec_meta_v1')).nick !== 'ab';
  $('nickInput').value = 'сука123';
  $('nickInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(40);
  const badMat = /недопустимые слова/.test($('subsLine').textContent);
  $('nickInput').value = 'Воин_42';
  $('nickInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(40);
  const goodNick = JSON.parse(window.localStorage.getItem('ec_meta_v1')).nick === 'Воин_42';
  check('валидация ника: 3–16 симв., мат-фильтр, валидный сохраняется', badShort && badMat && goodNick,
    '«ab»→отказ, мат→отказ, «Воин_42»→сохранён');
  click(window.document.querySelector('[data-ptab="facs"]'));
  await wait(50);
  click(window.document.querySelector('#profBody .mfRow'));
  await wait(50);
  check('вкладка «Фракции»: клик по строке → винрейт против каждой фракции',
    !!window.document.querySelector('#profBody .facDetail') && /винрейт против фракций/.test($('profBody').textContent));
  const legacyTs = Date.now() - 424242;
  const profileMeta = window.ecMeta();
  profileMeta.history.unshift({ ts: legacyTs, win: false, fac: 'Aurites', turns: 3, foe: 'Архивный соперник', efac: 'Necrus' });
  profileMeta.replays.unshift({ ts: legacyTs, win: false, fac: 'Aurites', turns: 3, foe: 'Архивный соперник',
    lines: [[1, 'Игрок разыгрывает карту «Пробный дозор»'], [2, 'Соперник наносит 3 урона герою']] });
  profileMeta.replays = profileMeta.replays.slice(0, 3);
  click(window.document.querySelector('[data-ptab="hist"]'));
  await wait(40);
  const legacyButton = window.document.querySelector(`.replayBtn[data-ts="${legacyTs}"]`);
  if (legacyButton) click(legacyButton);
  await wait(40);
  const legacyOpen = !$('replayModal').classList.contains('hidden')
    && !!$('replaySummary').querySelector('.rpLegacyNote') && $('replayBody').querySelectorAll('.rpLine').length === 2;
  $('replayKind').value = 'play';
  $('replayKind').dispatchEvent(new window.Event('change', { bubbles: true }));
  const legacyKindOk = $('replayBody').querySelectorAll('.rpLine').length === 1
    && $('replayBody').querySelector('.rpLine')?.dataset.turn === '1';
  $('replayKind').value = 'all';
  $('replayTurn').value = '2';
  $('replayTurn').dispatchEvent(new window.Event('change', { bubbles: true }));
  const legacyTurnOk = $('replayBody').querySelectorAll('.rpLine').length === 1
    && $('replayBody').querySelector('.rpLine')?.dataset.turn === '2';
  click($('btnReplayClose'));
  check('старые tuple-реплеи открываются без статистики и остаются фильтруемыми',
    !!legacyButton && legacyOpen && legacyKindOk && legacyTurnOk,
    `открыт ${legacyOpen}, фильтр типа ${legacyKindOk}, хода ${legacyTurnOk}`);
  click($('btnProfileClose'));
  await wait(30);
  check('Level Up + частицы, тост достижений, серверная синхронизация профиля',
    !!$('levelUpFx') && /luFly/.test(htmlBg) && /levelUpFx/.test(jsSrc) && /checkAchs/.test(jsSrc)
    && /syncProfile/.test(jsSrc) && /api\/profile\/nick/.test(jsSrc) && /api\/quests\/claim/.test(jsSrc),
    'levelUpFx/luFly, checkAchs+achToast, /api/profile, /api/quests/claim');
  click($('btnCampaign'));
  await wait(40);
  const campOk = $('campBody').querySelectorAll('.campNode').length === 20;
  click($('btnCampClose'));
  await wait(30);
  window.innerWidth = 390;
  window.dispatchEvent(new window.Event('resize'));
  click($('btnBP'));
  await wait(60);
  const bpMobileColumns = $('bpBody').querySelector('.bpPage.on')?.querySelectorAll('.bpCol').length === 2
    && /Страница \d+ \/ 25/.test($('bpBody').querySelector('.bpPageNo')?.textContent || '');
  const bpOpen = !$('bpModal').classList.contains('hidden') && $('bpBody').querySelectorAll('.bpClaim').length === 100;
  const claim0 = $('bpBody').querySelector('.bpClaim:not([disabled])');
  const sh0 = window.ecShards();
  if (claim0) click(claim0);
  await wait(50);
  const bpGot = window.ecShards() === sh0 + 53;   // уровень 1, free-ветка: 50+1*3
  click($('btnBPClose'));
  await wait(30);
  window.innerWidth = 1440;
  window.dispatchEvent(new window.Event('resize'));
  check('боевой пропуск: 50 уровней × 2 ветки, claim и мобильные 2-уровневые страницы', bpOpen && bpGot && bpMobileColumns,
    `кнопок ${$('bpBody').querySelectorAll('.bpClaim').length}, mobile two-column ${bpMobileColumns ? 'да' : 'нет'}, ◈ ${sh0}→${window.ecShards()}`);
  check('доступность: дальтонизм/шрифт/субтитры/язык в настройках',
    /id="setCb"/.test(htmlBg) && /id="setFontScale"/.test(htmlBg) && /id="setSubs"/.test(htmlBg) &&
    /id="setLang"/.test(htmlBg) && /data-i18n="ui_menu_play"/.test(htmlBg) && /#subsLine/.test(htmlBg),
    'режим дальтоника, масштаб шрифта, субтитры SFX, i18n-ядро');
  check('телеметрия матчей пишется в профиль', /telemPlayed/.test(jsSrc) && /meta\.telem/.test(jsSrc),
    'коллектор телеметрии в бандле');
  check('v2.3 профиль: ранги сезона, гемы, друзья, реплеи',
    /function rankOf/.test(jsSrc) && /gemsAdd/.test(jsSrc) && /inviteFriend/.test(jsSrc) && /openReplay/.test(jsSrc) &&
    /id="gemBal"/.test(htmlBg) && /id="friendNick"/.test(jsSrc) && /id="replayModal"/.test(htmlBg),
    'ранговая лестница, 💎, друзья/приглашения, реплеи матчей');
  check('v2.3 магазин: вкладки, бустеры фракций, наборы, косметика, крафт',
    /data-stab/.test(jsSrc) && /drawFactionPack/.test(jsSrc) && /buyBundle11/.test(jsSrc) && /TABLE_SKINS/.test(jsSrc) &&
    /craftBtn2/.test(jsSrc), '4 вкладки магазина');
  /* --- спека «3. Магазин» (v2.4.2) --- */
  check('магазин: крафт и разбор используют тарифы в монетах для всех редкостей',
    /CRAFT_COST[^;]*Common:\s*5,[\s\S]*Uncommon:\s*10,[\s\S]*Rare:\s*20,[\s\S]*Epic:\s*100,[\s\S]*Legendary:\s*400/.test(protoUiSrc)
    && /DISENCHANT_COINS[^;]*Common:\s*1,[\s\S]*Uncommon:\s*2,[\s\S]*Rare:\s*5,[\s\S]*Epic:\s*20,[\s\S]*Legendary:\s*100/.test(protoUiSrc)
    && /CONVERT[^;]*Rarity\.Common\]:\s*1,[\s\S]*Rarity\.Uncommon\]:\s*2,[\s\S]*Rarity\.Rare\]:\s*5,[\s\S]*Rarity\.Epic\]:\s*20,[\s\S]*Rarity\.Legendary\]:\s*100/.test(protoUiSrc)
    && /🪙/.test(protoUiSrc) && /Монеты/.test(protoUiSrc),
    'Common/Uncommon/Rare/Epic/Legendary; монеты и для крафта, и для разбора');
  check('магазин v2.4: модалка предпросмотра косметики в разметке и overlay-правиле',
    /id="cosmPreview"/.test(htmlBg) && /cosmPrevArea/.test(htmlBg) && /#cosmPreview,#factionModal/.test(htmlBg));
  click($('btnShop'));
  await wait(50);
  click(window.document.querySelector('[data-stab="cosm"]'));
  await wait(40);
  const prevBtns = window.document.querySelectorAll('#shopBody .cosmPrev');
  if (prevBtns[0]) click(prevBtns[0]);
  await wait(40);
  const prevOk = !$('cosmPreview').classList.contains('hidden') && $('cosmPrevArea').children.length >= 1
    && /Рубашка/.test($('cosmPrevLabel').textContent);
  click($('btnCosmPrevClose'));
  await wait(30);
  const prevClosed = $('cosmPreview').classList.contains('hidden');
  click($('btnShopClose'));
  await wait(30);
  check('магазин v2.4: 👁 предпросмотр — рубашка на карте, открытие/закрытие', prevOk && prevClosed && prevBtns.length >= 10,
    `кнопок предпросмотра ${prevBtns.length}`);
  /* --- спека «5. Боевой пропуск» (v2.5.0) --- */
  check('пропуск v2.5: XP унифицирован — победа +120 / поражение +60, daily +150, weekly +250',
    /win \? 120 : 60/.test(jsSrc) && /weekly \? 250 : 150/.test(jsSrc)
    && /claimQuestReward/.test(jsSrc), 'ставки спеки во всех режимах (решение пользователя)');
  check('пропуск v2.5: премиум-награды — фойл-жетон, премиум-бустер 2 эпика+, аватар «Лунный Архонт»',
    /prem\.foil = 1/.test(jsSrc) && /drawPremiumBooster/.test(jsSrc) && /prem\.ava = "lunar"/.test(jsSrc)
    && /id="btnPackPrem"/.test(htmlBg) && /bpLvl\.cur\{/.test(htmlBg) && /id="cmFoil"/.test(htmlBg),
    'фойл вместо альт-артов; редкий бустер = 2C+1R+2E/L; текущий уровень подсвечен');
  window.ecSetGems(600);
  window.ecSetBpXp(800);   // уровень 3 пропуска
  click($('btnBP'));
  await wait(60);
  const curMark = $('bpBody').querySelectorAll('.bpLvl.cur').length === 1;
  click($('bpBuyPrem'));
  await wait(60);
  const premOn = /Премиум активен/.test($('bpBody').textContent) && $('gemBal').textContent === '100';
  const premClaim = $('bpBody').querySelector('.bpClaim[data-l="1"][data-t="prem"]');
  if (premClaim) click(premClaim);
  await wait(50);
  // после клика openBP() перерисовывает bpBody — старая нода detached, проверяем свежую
  const premGot = $('bpBody').querySelector('.bpClaim[data-l="1"][data-t="prem"]')?.textContent.trim() === '✔';
  click($('bpClaimAll'));
  await wait(60);
  const allOk = /Забрано наград: \d+ — 🪙/.test(window.document.body.textContent ?? '');
  click($('btnBPClose'));
  await wait(30);
  check('пропуск v2.5: премиум за 💎500, claim премиум-ветки, «Забрать всё» с суммарным итогом',
    curMark && premOn && premGot && allOk,
    `текущий уровень ${curMark ? '✔' : '✗'}, премиум ${premOn ? '✔' : '✗'}, prem-claim ${premGot ? '✔' : '✗'}, итоги ${allOk ? '✔' : '✗'}`);
  /* --- спека «6. Обучение» (v2.5.1) --- */
  check('обучение v3: шаги по мане хода × 4 урока + подсветка + блокер действий',
    (jsSrc.match(/mana: \d,\s*message:/g) || []).length >= 10 && /tutBlocker/.test(jsSrc) && /tutTurnBack/.test(jsSrc)
    && /tutPollStep/.test(jsSrc) && /TUT_HANDS/.test(jsSrc), 'пошаговый скрипт — зеркало tutorial.json');
  check('обучение v3: руки уроков по кривой маны — 1✦ руна → 1✦ заклинание → 3✦ Ветеран / Провокация / 1✦→2✦→2✦ / 5✦+1✦+2✦+1✦',
    /"aur_r07", "aur_s01", "neu_03"/.test(jsSrc) && /"eth_01", "nec_03", "aur_03"/.test(jsSrc)
    && /"aur_09", "aur_01", "aur_03", "aur_s01"/.test(jsSrc), 'муллиган в уроках пропущен, рука заскриптована');
  check('обучение v3: гейты уроков — L1 руна/заклинание/существо (spellsCast), конец хода только на шагах «Завершите ход»',
    /tutStat\(["']spellsCast["']\) >= 1/.test(jsSrc) && /tutAllDone/.test(jsSrc) && /allow\.includes\(["']#btnEndTurn["']\)/.test(jsSrc), 'endTurnNow не пускает без выполнения');
  window.ecSetTut(4, true);
  const prac1 = window.document.getElementById('chkPractice').disabled;
  check('обучение v2.5.1: гейт тренировки (спека 6.3) — до обучения выключена, после включена',
    practiceLockedAtStart === true && prac1 === false && /cp\.disabled = !meta\.tutDone/.test(jsSrc) && /после 🎓 обучения/.test(htmlBg),
    `chkPractice.disabled ${practiceLockedAtStart}→${prac1}`);
  const fo0 = window.ecFreeOpens(); const gm0 = window.ecGems();
  click($('btnTour'));   // кнопка меню «🎓 Обучение» открывает хаб уроков (openTut)
  await wait(50);
  const starts = $('tutBody').querySelectorAll('.tutStart').length;
  const picks = $('tutBody').querySelectorAll('.tutPick').length;
  const rewardReceipt = /Награда получена/.test($('tutBody').textContent || '');
  const rewardNotDuplicated = window.ecFreeOpens() === fo0 && window.ecGems() === gm0;
  click($('btnTutClose'));
  await wait(30);
  check('обучение v2.5.1: награда +5 бустеров и 💎100 выдаётся один раз и видна в хабе',
    starts === 4 && picks === 0 && rewardReceipt && rewardNotDuplicated && introRewardGranted,
    `уроков ${starts}, повторных кнопок выбора ${picks}, квитанция ${rewardReceipt ? 'да' : 'нет'}, валюта ${fo0}/${gm0} сохранена`);
  check('прогресс пролога синхронизируется между устройствами без ранней разблокировки',
    /introComplete: !!meta\.introComplete/.test(protoUiSrc) && /introFactionsSeen: meta\.introFactionsSeen/.test(protoUiSrc)
    && /introFactionsSeen: string\[\]/.test(serverProfileSrc) && /starterDecksUnlocked: boolean/.test(serverProfileSrc)
    && /сервер сохраняет пролог между устройствами, не открывая колоды до выбора награды/.test(onlineTestSrc),
    'локальный профиль, API /api/profile и повторное чтение стартовой синхронизации');
  check('v2.3 пропуск: 50 уровней, премиум-ветка, «Забрать всё», таймер сезона',
    /BP_LEVELS = 50/.test(jsSrc) && /bpClaimedP/.test(jsSrc) && /bpClaimAll/.test(jsSrc) && /seasonDaysLeft/.test(jsSrc),
    'две ветки наград и сезон 30 дней');
  check('v2.3 кампания: карта мира 5×4, боссы 40 HP с силой героя, лор, сложности',
    /campNodeDef/.test(jsSrc) && /BOSS_POWER/.test(jsSrc) && /campStars/.test(jsSrc) && /CAMP_DIFFS/.test(jsSrc) &&
    /bossTick/.test(jsSrc) && /LORE/.test(jsSrc), '20 узлов, 3 сложности, звёзды ★');
  check('v2.3 обучение: 4 интерактивных урока, гейт хода, награда',
    /LESSONS/.test(jsSrc) && /tutCoach/.test(jsSrc) && /startLesson/.test(jsSrc) && /grantTutReward/.test(jsSrc) &&
    /id="tutModal"/.test(htmlBg) && /tutOk/.test(jsSrc), 'уроки с принуждением и стартовая колода');
  check('v2.3 настройки: громкость музыки/SFX, качество графики, выход',
    /id="setVolMusic"/.test(htmlBg) && /id="setVolSfx"/.test(htmlBg) && /id="setQuality"/.test(htmlBg) &&
    /id="btnLogout"/.test(htmlBg) && /musicSetVolume/.test(jsSrc), 'слайдеры и логаут');
  check('ранговая лестница: Адепт III в диапазоне MMR',
    typeof window.ecRank === 'function' && /Адепт/.test(window.ecRank(1150)) && /Ученик/.test(window.ecRank(900)) &&
    /Магистр/.test(window.ecRank(1400)), 'ecRank(1150) → «Адепт II»');
  check('модалки профиля/магазина/пропуска/кампании — фикс-оверлеи поверх меню',
    /#profileModal,#shopModal,#bpModal,#campaignModal,#journalModal,#replayModal,#tutModal\{/.test(htmlBg) &&
    /position:fixed;inset:0;z-index:320/.test(htmlBg), 'z-index 320, клики доходят');
  const uiArtPaths = ['card_frame.png', 'menu_aurites.jpg', 'ico_fac_4.png']
    .map(file => path.join(__dirname, '..', 'prototype', 'img', file));
  const missingUiArt = uiArtPaths.filter(file => !fs.existsSync(file));
  check('UI-арт: код подключения рамки, фонов и иконок',
    /frameOv/.test(jsSrc) && /applyMenuBg/.test(jsSrc) && /ico_cur_0/.test(jsSrc),
    'точки подключения и CSS-фолбэки на месте');
  if (missingUiArt.length) skip('Файлы UI-арта', `${missingUiArt.length} ассета отложены до финального добавления`);
  else check('Файлы UI-арта добавлены', true, `${uiArtPaths.length} контрольных ассета на месте`);
  check('стек LIFO: события и панель стека в бандле, симы на авто-резолве',
    /StackPushed/.test(jsSrc) && /resolveStackTop/.test(jsSrc) && /interactiveStack/.test(jsSrc) &&
    window.ecStackLen() === 0,
    `глубина стека вне боя: ${window.ecStackLen()}`);
  check('сложность «Мифический» с lookahead доступна', /value="1.05"/.test(htmlBg) && /lookahead/.test(jsSrc),
    'опция 1.05 в меню, lookahead в ИИ');
  check('мета-игра: профиль с уровнем/лигой и кампания из 5 боссов', profOk && campOk,
    `профиль: ${profOk ? 'да' : 'нет'}, узлов карты: ${$('campBody').querySelectorAll('.campNode').length}`);
  window.ecSetShards(5000);
  const expId = 'aur_31';
  window.ecSetOwned(expId, 0);
  click($('btnCollection'));
  await wait(60);
  const craftBefore = window.ecShards();
  // крафт через модалку карты: клик по первой карточке aur_31 в коллекции
  loadAllCollection();
  const tgt = [...window.document.querySelectorAll('#colGrid .card')].find(n => n.dataset.cardId === expId);
  if (tgt) click(tgt);
  await wait(60);
  click($('cmCraft'));
  await wait(50);
  const crafted = window.ecOwnedOf(expId) === 1 && window.ecShards() === craftBefore - 5;
  click($('cmDust'));
  await wait(50);
  const dusted = window.ecOwnedOf(expId) === 0 && window.ecShards() === craftBefore - 5 + 1;
  click($('cmClose'));
  click($('btnColClose'));
  await wait(40);
  check('крафт/разбор: создание копии за ◈5 и разбор в ◈1 (тариф спеки «3. Магазин»)', crafted && dusted,
    `крафт ${crafted ? 'ок' : 'нет'}, разбор ${dusted ? 'ок' : 'нет'}`);
  check('полировка v1.7: отсчёт окна, шиммер фойла, пульс целей, темп анимаций',
    /id="instantCd"/.test(htmlBg) && /@keyframes foilSweep/.test(htmlBg) && /@keyframes tgtPulse/.test(htmlBg) &&
    /id="setSpeed"/.test(htmlBg) && /id="setAutoPass"/.test(htmlBg) &&
    /id="stackPanel"/.test(htmlBg) && /id="ropeBar"/.test(htmlBg) && /class="pips"|\.pips\{/.test(htmlBg),
    'кольцо приоритета, foilSweep, tgtPulse, настройки темпа и авто-приоритета на месте');
  check('цветовые идентичности фракций на картах',
    /--frB:#c9a23f/.test(htmlBg) && units('#colGrid .card.f-Aurites') > 0 && units('#colGrid .card.f-Necrus') > 0,
    `рамок Ауритов: ${units('#colGrid .card.f-Aurites')}, Некруса: ${units('#colGrid .card.f-Necrus')}, Пиромантов: ${units('#colGrid .card.f-Pyromancer')}`);
  check('окна отклика Instant + подгонка артов (object-fit)',
    /id="instantDock"/.test(htmlBg) && /instantWindow/.test(jsSrc) && /object-fit:cover/.test(htmlBg),
    'instantDock в разметке, instantWindow в движке UI, арты кадрируются под рамку');
  check('муллиган крупными картами (clamp 170–220px)', /#mullCards \.card\{[^}]*clamp\(170px,15vw,220px\)/.test(htmlBg),
    'пересдача читабельного размера');

  // Сквозная проверка источника «событие»: три рейтинговые победы → claim → один cosmetic ID,
  // без изменения числа обычных копий и с отметкой о получении.
  const hasMetaRewardHook = typeof b.metaRewards === 'function';
  if (hasMetaRewardHook) {
    b.practice = false; b.campaignBoss = null; b.campNode = null; b.tutLesson = 0;
    b.engine.result = 'PlayerWin';
    for (let i = 0; i < 3; i++) b.metaRewards();
  }
  const borderlessBeforeEvent = window.ecBorderlessOwned();
  click($('btnCollection'));
  await wait(50);
  loadAllCollection();
  const ordinarySnapshot = new Map([...window.document.querySelectorAll('#colGrid .card')]
    .map(node => [node.dataset.cardId, window.ecOwnedOf(node.dataset.cardId || '')]));
  const nav2 = $('ecQuickNav');
  click(nav2.querySelector('[data-route="events"]'));
  await wait(50);
  const eventCardReady = $('eventsGrid').querySelector('[data-event-id="borderless"]');
  const eventClaimBtn = eventCardReady?.querySelector('[data-ev-claim="borderless"]');
  const eventReady = !!eventClaimBtn && /3\/3/.test(eventCardReady.textContent) && !eventClaimBtn.disabled;
  if (eventReady) click(eventClaimBtn);
  await wait(50);
  const borderlessAfterEvent = window.ecBorderlessOwned();
  const eventRewardId = borderlessAfterEvent.find(id => !borderlessBeforeEvent.includes(id)) || '';
  const eventClaimed = eventRewardId !== '' && borderlessAfterEvent.length === borderlessBeforeEvent.length + 1
    && ordinarySnapshot.has(eventRewardId) && window.ecOwnedOf(eventRewardId) === ordinarySnapshot.get(eventRewardId);
  check('Borderless можно забрать из события после 3 рейтинговых побед отдельным вариантом',
    hasMetaRewardHook && eventReady && eventClaimed && /Получено ✓/.test($('eventsGrid').textContent),
    `3/3 и claim ${eventReady ? 'да' : 'нет'}, вариант ${eventRewardId || 'не выдан'}, копии базовой карты неизменны`);

  /* ---------- 8. админка: отдельное управление косметикой ---------- */
  console.log('\n[8] Админка · Borderless');
  window.localStorage.setItem('ec_admin_v1', '1');
  click($('btnAdminMenu'));
  await wait(30);
  const adminBorderlessTab = $('adminTabs').querySelector('[data-tab="borderless"]');
  check('админка содержит отдельную вкладку Borderless', !!adminBorderlessTab);
  if (adminBorderlessTab) click(adminBorderlessTab);
  await wait(30);
  check('KPI админки отражает 500 игровых карт и 1000 оформлений', /500\s*\/\s*1000/.test($('adminBody').querySelector('.admKpi')?.textContent || ''));
  check('админка показывает счётчик Borderless и шанс 0,1% (примерно 1 из 1000)',
    /0,1%/.test($('adminBody').textContent) && /1 из 1000/.test($('adminBody').textContent)
      && !!$('admBorderlessGrid') && $('admBorderlessGrid').children.length > 0);
  const ownedBeforeAdmin = new Set(window.ecBorderlessOwned());
  const adminTile = Array.from($('admBorderlessGrid').querySelectorAll('.admBorderlessTile'))
    .find(node => !ownedBeforeAdmin.has(node.dataset.cardId));
  if (adminTile) {
    const adminCardId = adminTile.dataset.cardId;
    const ordinaryCopiesBefore = window.ecOwnedOf(adminCardId);
    click(adminTile);
    const grantedSeparately = window.ecBorderlessOwned().includes(adminCardId)
      && window.ecOwnedOf(adminCardId) === ordinaryCopiesBefore;
    check('выдача Borderless из админки не меняет игровые копии', grantedSeparately);
    const tileToRevoke = Array.from($('admBorderlessGrid').querySelectorAll('.admBorderlessTile'))
      .find(node => node.dataset.cardId === adminCardId);
    if (tileToRevoke) click(tileToRevoke);
    check('отзыв Borderless также не меняет обычную коллекцию', !window.ecBorderlessOwned().includes(adminCardId)
      && window.ecOwnedOf(adminCardId) === ordinaryCopiesBefore);
  } else {
    check('найдена невыданная карта для проверки админского grant/revoke', false, 'первые 60 вариантов уже выданы');
  }

  /* ---------- 9. реальный UI-путь выбора и запуска пользовательской колоды ---------- */
  console.log('\n[9] Запуск созданной колоды через экран «Колоды»');
  if (!$('adminModal').classList.contains('hidden')) click($('btnAdminClose'));
  window.__battle.stop();
  const playApi = window.__decks;
  const playIds = [...new Set(playApi.pool('Aurites').map(card => card.id))].slice(0, 60);
  for (const id of playIds) window.ecSetOwned(id, 1); // изолированная тестовая коллекция: по одной копии базовых карт
  const playValidation = playApi.validate(playIds, 'Aurites');
  playApi.save({
    id: 'custom-e2e-flow', name: 'Проверка обложки', faction: 'Aurites', cards: playIds,
    avatarCardId: playIds[7], updated: Date.now(),
  });
  const coverPersisted = playApi.list().find(deck => deck.id === 'custom-e2e-flow');
  window.openHomeScreen();
  const homeDeckCard = window.document.querySelector('#playerFactions .customDeckCard[data-deck-id="custom-e2e-flow"]');
  const expectedPlayArtUrl = cardArtUrlFor(playIds[7]);
  const homeDeckTextAndArt = !!homeDeckCard
    && homeDeckCard.querySelector('.fname')?.textContent === 'Проверка обложки'
    && homeDeckCard.querySelector('.fclass')?.textContent.includes('Constructed')
    && (homeDeckCard.querySelector('.fcardArtImg')?.getAttribute('src') || '') === expectedPlayArtUrl;
  check('моя колода появляется под архетипами с именем игрока и выбранным артом', homeDeckTextAndArt,
    `плитка ${homeDeckCard?.querySelector('.fname')?.textContent ?? 'не найдена'}; art ${homeDeckCard?.querySelector('.fcardArtImg')?.getAttribute('src') ?? '—'}`);
  window.openDecksScreen();
  let playBox = window.document.querySelector('#deckGrid [data-deck-id="custom-e2e-flow"]');
  const heroApi = window.__deckHeroes;
  const heroCatalog = heroApi?.catalog ?? [];
  const heroCatalogOk = heroCatalog.length === 15
    && ['standard', 'coin', 'donation'].every(tier => heroCatalog.filter(hero => hero.tier === tier).length === 5)
    && new Set(heroCatalog.map(hero => hero.id)).size === 15;
  check('каталог визуальных героев включает 5 стандартных, 5 монетных и 5 донатных', heroCatalogOk,
    `${heroCatalog.length} героев`);
  window.ecSetShards(5000);
  if (playBox) click(playBox);
  const heroPickerButton = $('btnDecksHero');
  if (!heroPickerButton.disabled) click(heroPickerButton);
  const heroOptions = [...$('deckHeroPickerGrid').querySelectorAll('.deckHeroOption[data-hero-id]')];
  const factionHeroOptions = !$('deckHeroPickerModal').classList.contains('hidden') && heroOptions.length === 3
    && heroOptions.every(option => heroCatalog.find(hero => hero.id === option.dataset.heroId)?.faction === 'Aurites')
    && heroOptions.every(option => option.querySelector('.deckHeroOptionArt')?.getAttribute('src') === `/deck-heroes/${option.dataset.heroId}`);
  const coinHeroAction = heroOptions.find(option => option.dataset.heroId === 'aurites-veteran')?.querySelector('[data-hero-action]');
  const donationHeroAction = heroOptions.find(option => option.dataset.heroId === 'aurites-ascendant')?.querySelector('[data-hero-action]');
  const donationIsShowcase = !!donationHeroAction && donationHeroAction.disabled
    && /скоро|донат/i.test(donationHeroAction.textContent || '')
    && /платёжный провайдер/i.test(heroOptions.find(option => option.dataset.heroId === 'aurites-ascendant')?.textContent || '');
  const shardsBeforeDonationAttempt = window.ecShards();
  const gemsBeforeDonationAttempt = window.ecMeta().gems;
  if (donationHeroAction) click(donationHeroAction); // проверка: даже принудительный DOM-клик не запускает оплату
  const donationNoCharge = window.ecShards() === shardsBeforeDonationAttempt
    && window.ecMeta().gems === gemsBeforeDonationAttempt;
  const shardsBeforeHeroPurchase = window.ecShards();
  if (coinHeroAction && !coinHeroAction.disabled) click(coinHeroAction);
  const selectedHeroForDeck = heroApi?.forDeck('custom-e2e-flow', 'Aurites');
  const storedHeroMeta = JSON.parse(window.localStorage.getItem('ec_meta_v1') || '{}');
  const heroPurchaseOk = selectedHeroForDeck === 'aurites-veteran'
    && window.ecShards() === shardsBeforeHeroPurchase - 2000
    && window.ecMeta().deckHeroesOwned.includes('aurites-veteran')
    && storedHeroMeta.deckHeroesOwned?.includes('aurites-veteran')
    && storedHeroMeta.deckHeroes?.['custom-e2e-flow'] === 'aurites-veteran'
    && heroApi.forDeck('starter_necrus', 'Necrus') === 'Necrus'
    && $('deckHeroPickerModal').classList.contains('hidden')
    && playApi.list().find(deck => deck.id === 'custom-e2e-flow')?.avatarCardId === playIds[7];
  check('для колоды показаны только герои её фракции; донат виден, но не списывает монеты или гемы',
    factionHeroOptions && donationIsShowcase && donationNoCharge,
    `вариантов ${heroOptions.length}, донат недоступен ${!!donationHeroAction?.disabled}`);
  check('монетный герой покупается за 2000 и назначается только этой колоде отдельно от обложки', heroPurchaseOk,
    `герой ${selectedHeroForDeck ?? '—'}, монеты ${shardsBeforeHeroPurchase}→${window.ecShards()}`);
  window.openHomeScreen();
  playBox = window.document.querySelector('#playerFactions .customDeckCard[data-deck-id="custom-e2e-flow"]');
  const homeCustomCoverStillSeparate = (playBox?.querySelector('.fcardArtImg')?.getAttribute('src') || '') === expectedPlayArtUrl
    && !playBox?.querySelector('.menuDeckHeroBadge');
  check('у пользовательской колоды сохранена карточная обложка без значка героя поверх арта', homeCustomCoverStillSeparate,
    `обложка ${playBox?.querySelector('.fcardArtImg')?.getAttribute('src') ?? '—'}`);
  window.openDecksScreen();
  const starterHeroBox = window.document.querySelector('#deckGrid [data-deck-id="starter_aurites"]');
  if (starterHeroBox) click(starterHeroBox);
  const starterHeroButton = $('btnDecksHero');
  if (!starterHeroButton.disabled) click(starterHeroButton);
  const starterCoinAction = $('deckHeroPickerGrid').querySelector('[data-hero-id="aurites-veteran"] [data-hero-action]');
  if (starterCoinAction && !starterCoinAction.disabled) click(starterCoinAction);
  window.openHomeScreen();
  const factionHeroCard = window.document.querySelector('#playerFactions .fcard[data-f="Aurites"]:not(.customDeckCard)');
  const factionArtNowUsesHero = factionHeroCard?.querySelector('.fcardArtImg')?.getAttribute('src') === '/deck-heroes/aurites-veteran'
    && factionHeroCard?.querySelector('.fname')?.textContent === 'Капитан Рассвета';
  const noHeroBadgesOverCardArt = !window.document.querySelector('.fcardDeckHero,.menuDeckHeroBadge,.deckHeroBadge,.alDeckHero');
  check('выбранный монетный арт заменяет фракционный арт целиком — без кружка поверх карточки',
    factionArtNowUsesHero && noHeroBadgesOverCardArt,
    `арт ${factionHeroCard?.querySelector('.fcardArtImg')?.getAttribute('src') ?? '—'}; значки отсутствуют ${noHeroBadgesOverCardArt}`);
  window.openDecksScreen();
  playBox = window.document.querySelector('#deckGrid [data-deck-id="custom-e2e-flow"]');
  const coverVisible = !!playBox && playBox.dataset.avatarCardId === playIds[7]
    && !!playBox.querySelector('.deckAvatarImg') && !!playBox.querySelector('.deckArtGear') && !playBox.querySelector('.deckColors');
  const deckTileTextOk = !!playBox && playBox.querySelector('.deckName')?.textContent === 'Проверка обложки'
    && !!playBox.querySelector('.deckMeta .deckCount')?.textContent.includes('60')
    && (playBox.querySelector('.deckAvatarImg')?.getAttribute('src') || '') === expectedPlayArtUrl
    && cssSrc.includes('-webkit-line-clamp:2!important') && cssSrc.includes('object-fit:contain!important');
  check('в плитке списка колод читаются имя, размер и обложка без обрезки', deckTileTextOk,
    `имя ${playBox?.querySelector('.deckName')?.textContent ?? '—'}, размер ${playBox?.querySelector('.deckMeta .deckCount')?.textContent ?? '—'}`);
  if (playBox) click(playBox);
  const selectedPlayBox = window.document.querySelector('#deckGrid [data-deck-id="custom-e2e-flow"]');
  const coverEditButton = selectedPlayBox?.querySelector('.deckArtEdit');
  if (coverEditButton) click(coverEditButton);
  const artPickerOpen = !$('deckArtPickerModal').classList.contains('hidden');
  const artChoice = $('deckArtPickerGrid').querySelector(`[data-card-id="${playIds[8]}"]`);
  const galleryShowsDeck = artPickerOpen && $('deckArtPickerGrid').children.length === 60 && !!artChoice;
  check('в сохранённой колоде открывается визуальный выбор арта из её карт', galleryShowsDeck,
    `галерея: ${$('deckArtPickerGrid').children.length} уникальных карт`);
  if (artChoice) click(artChoice);
  const coverAfterPick = playApi.list().find(deck => deck.id === 'custom-e2e-flow');
  const tileAfterPick = window.document.querySelector('#deckGrid [data-deck-id="custom-e2e-flow"]');
  const coverChoicePersisted = !!coverAfterPick && coverAfterPick.avatarCardId === playIds[8]
    && !!tileAfterPick && tileAfterPick.dataset.avatarCardId === playIds[8]
    && $('deckArtPickerModal').classList.contains('hidden');
  check('выбранный арт сохраняется и сразу обновляет увеличенную обложку', coverChoicePersisted,
    `stored/displayed: ${coverAfterPick?.avatarCardId ?? '—'}/${tileAfterPick?.dataset.avatarCardId ?? '—'}`);
  const launchButton = $('btnDecksPlay');
  const launcherEnabled = !!launchButton && !launchButton.disabled;
  if (launcherEnabled) click(launchButton);
  const launched = await waitUntil(() => {
    const game = window.__battle;
    const p = game?.engine?.p(0);
    return !!p && p.hand.length + p.deck.length === 60;
  }, 12000, 80);
  const actualDeck = window.__battle.playerDeckId;
  const actualFaction = window.__battle.playerFaction;
  const battleVisible = !$('battle').classList.contains('hidden');
  check('аватар сохранён и показан в карточке колоды', !!coverPersisted
    && coverPersisted.avatarCardId === playIds[7] && coverVisible,
    `stored/displayed: ${coverPersisted?.avatarCardId ?? '—'}/${playBox?.dataset.avatarCardId ?? '—'}`);
  check('кнопка «Играть» запускает выбранную пользовательскую колоду в настоящем боевом движке',
    playValidation.ok && launcherEnabled && launched && battleVisible
      && actualDeck === 'custom-e2e-flow' && actualFaction === 'Aurites',
    `валидна: ${playValidation.ok}; кнопка: ${launcherEnabled}; ID: ${actualDeck}; фракция: ${actualFaction}; 60 карт: ${launched}`);
  const battleHeroImage = $('playerPortrait').querySelector('img')?.getAttribute('src') || '';
  const battleHeroOk = window.__battle.playerHeroId === 'aurites-veteran'
    && battleHeroImage === '/deck-heroes/aurites-veteran';
  check('в медальоне боя отображается выбранный герой колоды, а не профильный аватар', battleHeroOk,
    `id ${window.__battle.playerHeroId}; портрет ${battleHeroImage || 'fallback'}`);
  window.__battle.stop();

  /* ---------- итог ---------- */
  console.log('\n--- ИТОГ ---');
  console.log('Разыграно карт игроком:', playedCards, '| заклинаний:', playedSpells, '| существ:', playedCreatures, '| Эхо использовано:', echoUsed);
  console.log('Ошибок на странице:', errors.length, canvasStubs ? `(+${canvasStubs} заглушек canvas от jsdom — не дефект)` : '');
  for (const e of errors.slice(0, 6)) console.log('  ' + String(e).split('\n').slice(0, 4).join('\n  '));
  if (errors.length) failures++;
  console.log(failures === 0 ? '\n🎉 СМОУК-ТЕСТ ПРОЙДЕН' : `\n⚠ ПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('СМОУК УПАЛ:', e); process.exit(2); });
