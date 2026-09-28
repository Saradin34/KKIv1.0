/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — играбельный HTML-прототип (ТЗ разделы 4 и 6)
   ---------------------------------------------------------------------
   Работает на ТОМ ЖЕ движке правил (src/engine), который портируется в
   Unity (C#). Назначение прототипа:
     1) руками проверить ощущение от пяти фаз, рун, Эха и пассивок;
     2) зафиксировать UX-решения до переноса в Unity UI;
     3) показать заказчику игру без установки Unity.
   Арты — процедурная SVG-заглушка в палитре фракции; в Cards.json у каждой
   карты уже прописан путь будущего PNG (Resources/Cards/<id>.png).
   ===================================================================== */

import {
  CardData, CardType, EntityCreature, Element, Faction, FACTION_COLORS, FACTION_RU,
  GameEvent, GameEventType, GameResult, Keyword, Phase, PHASE_ORDER, PHASE_RU,
  RARITY_COLORS, Rarity, Side, SpellSubtype, StatusType, TargetKind, DEFAULT_CONFIG,
} from '../engine/types';
import { GameEngine } from '../engine/engine';
import { AIController, AI_PROFILES } from '../engine/ai';
import { buildDatabase, CardsFile, DeckFile } from '../engine/db';
import cardsRaw from '../../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';
import factionsRaw from '../../unity/EchoCitadel/Assets/StreamingAssets/factions.json';
import decksRaw from '../../unity/EchoCitadel/Assets/StreamingAssets/Decks.json';
import * as Vfx from './vfx';
import { Audio_ as Sfx, audioUnlock, audioSetEnabled, audioSetVolume, musicSetVolume, musicStart } from './audio';
import { vfxSetReducedMotion } from './vfx';
import {tableBackdrop, tableSurface, paletteOf} from './art';
import {
  CustomDeck, DeckLike, MIN_DECK_SIZE, MAX_COPIES, MAX_LEGENDARY_COPIES,
  loadCustomDecks, saveCustomDecks, upsertCustomDeck, deleteCustomDeck, validateDeck, validateDeckSize, resolveDeck, deckSummary,
} from './deckstore';

const cardsJson = cardsRaw as unknown as CardsFile;
const decksJson = decksRaw as unknown as DeckFile;

/* ---------------------------------------------------------------------- */
/*  Утилиты                                                                */
/* ---------------------------------------------------------------------- */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;
const sel = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;
let animSpd = 1;   // множитель темпа анимаций из настроек (0.6 / 1 / 1.4)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms * animSpd));
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (tag: string, cls?: string, html?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

type AppRoute = 'home' | 'collection' | 'decks' | 'store' | 'profile' | 'events' | 'packs' | 'mastery' | 'battle';
let appRoute: AppRoute = 'home';
const routeHistory: AppRoute[] = [];
let suppressRouteHistory = false;
function setAppRoute(next: AppRoute): void {
  if (next !== appRoute) {
    if (next === 'home' && !suppressRouteHistory) routeHistory.length = 0;
    else if (!suppressRouteHistory) routeHistory.push(appRoute);
    if (routeHistory.length > 24) routeHistory.shift();
    appRoute = next;
  }
  document.body.dataset.appRoute = next;
  const dock = document.getElementById('ecQuickNav');
  const show = next !== 'home' && next !== 'battle';
  dock?.classList.toggle('hidden', !show);
  dock?.setAttribute('aria-hidden', show ? 'false' : 'true');
  dock?.querySelectorAll<HTMLElement>('[data-route]').forEach(item => {
    const active = item.dataset.route === next;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
}
function navigateApp(next: AppRoute | 'back'): void {
  if (next === 'back') {
    const previous = routeHistory.pop() ?? 'home';
    if (previous === appRoute) return;
    suppressRouteHistory = true;
    navigateApp(previous);
    suppressRouteHistory = false;
    return;
  }
  switch (next) {
    case 'home': openHomeScreen(); break;
    case 'collection': openCollectionScreen(); break;
    case 'decks': openDecksScreen(); break;
    case 'store': openShop(); break;
    case 'profile': openProfile(); break;
    case 'events': openEventsScreen(); break;
    case 'packs': openBoosterPanel(); break;
    case 'mastery': openBP(); break;
    case 'battle':
      setAppRoute('battle');
      $('menu').classList.add('hidden');
      for (const id of ['collection','decksScreen','eventsScreen','profileModal','shopModal','bpModal','boosterModal','campaignModal'])
        document.getElementById(id)?.classList.add('hidden');
      $('battle').classList.remove('hidden');
      break;
  }
}
document.getElementById('ecQuickNav')?.addEventListener('click', ev => {
  const route = (ev.target as HTMLElement | null)?.closest?.('[data-route]') as HTMLElement | null;
  const value = route?.dataset.route;
  if (value && ['back','home','collection','decks','store','profile','events','packs','mastery'].includes(value)) {
    Sfx.uiClick();
    navigateApp(value as AppRoute | 'back');
  }
});
const FACTION_IDS: Faction[] = [Faction.Aurites, Faction.Necrus, Faction.Terramorph, Faction.Pyromancer, Faction.Ethereal];
const FACTION_SIGIL: Record<string, string> = {
  Aurites: '✵', Necrus: '☠', Terramorph: '⛰', Pyromancer: '🜂', Ethereal: '☁', Neutral: '◈',
};
const PASSIVE_TEXT: Record<string, string> = {
  Aurites: '<b>Божественный щит</b> — существо стоимостью ≥2 выходит на поле со Щитом (1 заряд, +1 заряд при стоимости ≥4). Щит поглощает первое повреждение.',
  Necrus: '<b>Кровавая жатва</b> — когда ваше существо стоимостью ≥2 умирает, вы берёте карту и восстанавливаете 2 здоровья. Смерть токенов и одно-мановых существ даёт только здоровье.',
  Terramorph: '<b>Корни земли</b> — +1 к максимуму маны сверх обычного прироста каждый ход; в первые 3 своих хода ваши существа не могут атаковать.',
  Pyromancer: '<b>Пламя возмездия</b> — ваши заклинания наносят на 1 урона больше (стоимость 1–2) или на 2 больше (стоимость ≥3), но вы теряете 1 здоровье за каждое разыгранное заклинание.',
  Ethereal: '<b>Иллюзорная тень</b> — в начале хода одно ваше существо с наименьшей атакой с вероятностью 50% становится неуловимым.',
};

/* Данные фракций из единого источника factions.json (StreamingAssets — тот же файл
   читает Unity; спека «1. Главное меню» п.1.2). При нехватке полей — фолбэк PASSIVE_TEXT. */
interface FactionInfo {
  id: string; name: string; tagline: string; sigil: string; icon: string;
  color: { primary: string; secondary: string; accent: string };
  description: string; mechanics: string; tips: string[];
}
const FACTION_INFO: Record<string, FactionInfo> = Object.fromEntries(
  (factionsRaw as unknown as { factions: FactionInfo[] }).factions.map(f => [f.id, f]));
/* ── Хаб главного меню (макет): сферы фракций, карточки героев, активный вызов ── */
const HUB_ELEM_RU: Record<string, string> = {
  Aurites: 'Свет', Necrus: 'Тьма', Terramorph: 'Земля', Pyromancer: 'Огонь', Ethereal: 'Воздух',
};
const HUB_CARD: Record<string, { name: string; cls: string; atk: number; hp: number; lvl: number }> = {
  Aurites:    { name: 'Стражи Света',    cls: 'Паладин · Свет',   atk: 5, hp: 15, lvl: 15 },
  Necrus:     { name: 'Культ Тени',      cls: 'Некромант · Тьма', atk: 3, hp: 18, lvl: 18 },
  Terramorph: { name: 'Древний Конклав', cls: 'Друид · Земля',    atk: 3, hp: 12, lvl: 13 },
  Pyromancer: { name: 'Легион Пламени',  cls: 'Маг · Огонь',      atk: 2, hp: 16, lvl: 16 },
  Ethereal:   { name: 'Духи Ветра',      cls: 'Маг · Воздух',     atk: 3, hp: 14, lvl: 14 },
};
const HUB_FOE: Record<string, { name: string; rank: string; lvl: number }> = {
  Aurites:    { name: 'Дравен Валерий',   rank: 'Магистр II',  lvl: 45 },
  Necrus:     { name: 'Моргрим Костяной', rank: 'Архимаг I',   lvl: 48 },
  Terramorph: { name: 'Торн Древний',     rank: 'Магистр I',   lvl: 41 },
  Pyromancer: { name: 'Карс Пеплокрыл',   rank: 'Архимаг III', lvl: 44 },
  Ethereal:   { name: 'Эол Тихий',        rank: 'Магистр III', lvl: 43 },
};
/** Флагман-арты фракций — основной портрет карточек и соперника (drop-in /heroes приоритетнее). */
const HUB_ART: Record<string, string> = {
  Aurites: 'aur_14', Necrus: 'nec_15', Terramorph: 'ter_14', Pyromancer: 'pyr_14', Ethereal: 'eth_15',
};
const fmtNum = (n: number): string => n.toLocaleString('ru-RU');

/** Цепочка арта с фолбэками: drop-in героя → флагман → сцена фракции → градиент. */
function artChain(img: HTMLImageElement | null, urls: string[]): void {
  if (!img) return;
  const list = urls.filter(u => !!u);
  let i = 0;
  img.style.opacity = '';
  img.onerror = () => {
    i += 1;
    if (i < list.length) img.src = list[i]!;
    else img.style.opacity = '0';
  };
  i = 0;
  img.src = list[0]!;
}

function hubArtUrls(f: string): string[] {
  return [`/heroes/${f}`, `/art/${f}/${HUB_ART[f]}.png`, `img/menu_${f.toLowerCase()}.jpg`];
}

/** Панель «Активный вызов»: соперник, режим, прогресс сундучка, подпись PLAY. */
const TYPE_RU: Record<string, string> = { Creature: 'Существо', Spell: 'Заклинание', Rune: 'Руна' };
const PHASE_HINT: Record<string, string> = {
  Start: 'Стадия начала: добора карты и срабатывания «в начале хода»',
  Resource: 'Стадия ресурса: +1 к максимуму маны, кристаллы пополняются',
  Main: 'Главная стадия: розыгрыш карт и Эхо; далее — объявление атак',
  Combat: 'Стадия боя: ваши атаки объявляются стрелкой, остальные доигрывает авто-бой',
  End: 'Стадия конца: срабатывания «в конце хода», проверка размера руки',
};
const ELEM_RU: Record<string, string> = { None: '—', Fire: 'Огонь', Water: 'Вода', Earth: 'Земля', Air: 'Воздух', Chaos: 'Хаос' };
const RARITY_RU: Record<string, string> = { Common: 'Обычная', Uncommon: 'Необычная', Rare: 'Редкая', Epic: 'Эпическая', Legendary: 'Легендарная' };
const KW_RU: Record<string, string> = {
  Taunt: 'Провокация', Lifesteal: 'Вампиризм', Deathrattle: 'Предсмертный хрип', Battlecry: 'Боевой клич',
  Rush: 'Рывок', Windfury: 'Буря', Unblockable: 'Неуловимость', Trample: 'Прорыв', SpellDamage: 'Урон заклинаний +1',
  DivineShield: 'Божественный щит', Poisonous: 'Ядовитый', Freezing: 'Ледяное касание',
};
const KW_BADGE: Record<string, { ico: string; title: string }> = {
  Taunt: { ico: '⛨', title: 'Провокация: авто-атака противника обязана бить это существо' },
  Lifesteal: { ico: '🩸', title: 'Вампиризм: нанесённый урон лечит вашего героя' },
  Windfury: { ico: '🌀', title: 'Буря: две атаки за ход' },
  Trample: { ico: '➤', title: 'Прорыв: избыточный урон уходит в героя' },
  Rush: { ico: '⚡', title: 'Рывок: может атаковать в ход призыва' },
  Unblockable: { ico: '👁', title: 'Неуловимость: нельзя выбрать целью' },
  SpellDamage: { ico: '✦', title: 'Урон заклинаний +1' },
  Deathrattle: { ico: '✝', title: 'Предсмертный хрип: эффект при смерти' },
  DivineShield: { ico: '🛡', title: 'Божественный щит: входит со Щитом, поглощает первый урон' },
  Poisonous: { ico: '☠', title: 'Ядовитый: наносит Яд при уроне существу (любая рана смертельна)' },
  Freezing: { ico: '❄', title: 'Ледяное касание: замораживает цель на 1 ход при уроне' },
};
const STATUS_BADGE: Record<string, { ico: string; cls: string; title: string }> = {
  Shield: { ico: '🛡', cls: 'shield', title: 'Щит: поглощает первое повреждение' },
  Burn: { ico: '🔥', cls: 'burn', title: 'Горение: урон в начале хода владельца' },
  Poison: { ico: '☣', cls: 'poison', title: 'Яд: любое повреждение убивает' },
  Freeze: { ico: '❄', cls: 'freeze', title: 'Заморозка: существо не атакует' },
  Fury: { ico: '💢', cls: 'fury', title: 'Ярость: может атаковать в ход призыва' },
  Silence: { ico: '🤐', cls: 'silence', title: 'Немота: способности отключены' },
};

const colorOf = (f: string): { primary: string; secondary: string; accent: string } =>
  FACTION_COLORS[(f as string) in FACTION_COLORS ? (f as Faction) : Faction.Neutral];

/* ---------------------------------------------------------------------- */
/*  Процедурный арт (SVG) — заглушка до готовности PNG                     */
/* ---------------------------------------------------------------------- */

const MOTIFS: Record<string, string> = {
  Creature: 'M50 18 L62 40 L86 44 L68 60 L74 84 L50 71 L26 84 L32 60 L14 44 L38 40 Z',
  Spell: 'M50 12 C64 34 84 42 84 60 A34 34 0 0 1 16 60 C16 42 36 34 50 12 Z',
  Rune: 'M50 10 L82 32 L70 78 L30 78 L18 32 Z',
};

/** Арт карты — ТОЛЬКО из папок художника: /art/<Фракция>/<id>.png
 *  (serve.js: art_raw/<id>.png → Resources/Cards/<Фракция>/<id>.png).
 *  Пока файл не дропнут — чистый фракционный фон с сигилом, без изображений-затычек. */
function artSvg(card: CardData, w: number, h: number): string {
  void w; void h;
  const p = paletteOf(card.faction as Faction);
  const sig = FACTION_SIGIL[card.faction as Faction] ?? '✦';
  return `<div class="artBox" style="--fa:${p.primary};--fb:${p.secondary}" data-sigil="${sig}">`
    + `<img src="/art/${encodeURIComponent(card.faction as string)}/${encodeURIComponent(card.id)}.png" alt="" loading="lazy" onerror="this.classList.add('miss')">`
    + `</div>`;
}

/* ---------------------------------------------------------------------- */
/*  Данные                                                                 */
/* ---------------------------------------------------------------------- */

const { db } = buildDatabase(cardsJson);
type BuiltinDeck = { id: string; name: string; faction: string; cards: string[]; format?: string };
const deckList = decksJson.decks as BuiltinDeck[];
const deckById = new Map<string, BuiltinDeck>(deckList.map(d => [d.id, d]));
const STARTER_DECK_FORMAT = 'starter';
const starterDeckForFaction = (faction: string): BuiltinDeck | undefined =>
  deckList.find(d => d.format === STARTER_DECK_FORMAT && d.faction === faction);
const isStarterDeckId = (id: string): boolean => deckById.get(id)?.format === STARTER_DECK_FORMAT;
const STARTER_CARD_IDS = new Set(deckList.filter(d => d.format === STARTER_DECK_FORMAT).flatMap(d => d.cards));
const ALL_CARDS: CardData[] = cardsJson.cards as CardData[]; // v2.12.1: все 500 карт, включая 70 нейтральных (раньше 430 без Neutral)

/** Коэффициенты силы пассивок, подобранные решателем (вшиты генератором в Cards.json). */
function readPassiveMul(): Record<string, number> {
  const fc = (cardsJson.meta as { factionCoefficients?: Record<string, { passiveMul?: number }> }).factionCoefficients;
  const out: Record<string, number> = {};
  if (fc) for (const [k, v] of Object.entries(fc)) if (v && typeof v.passiveMul === 'number') out[k] = v.passiveMul;
  return out;
}
const PASSIVE_MUL = readPassiveMul();

/* ---------------------------------------------------------------------- */
/*  Рендер карты                                                           */
/* ---------------------------------------------------------------------- */

/* v2.6: автоподгон текста карты под окно рамки — ничего не ползёт и не обрезается:
   пошагово уменьшаем кегль, пока блок переполнен (в jsdom scrollHeight=0 → no-op). */
function fitText(node: HTMLElement | null, min = 6.2): void {
  if (!node) return;
  node.style.fontSize = '';
  for (let i = 0; i < 7 && node.scrollHeight > node.clientHeight + 1; i++) {
    const fs = (parseFloat(getComputedStyle(node).fontSize) || 10) - 0.55;
    if (fs < min) break;
    node.style.fontSize = `${fs.toFixed(2)}px`;
    node.style.lineHeight = '1.22';
  }
}

function keywordsLine(card: CardData): string {
  const kws = (card.keywords ?? []).map(k => kwName(k));
  if (card.type === CardType.Spell && card.subtype === SpellSubtype.Ritual) kws.unshift(bi('◷ Ритуал', '◷ Ritual'));
  else if (card.type === CardType.Spell && card.subtype === SpellSubtype.Instant) kws.unshift(bi('⚡ Мгновенное', '⚡ Instant'));
  return kws.length ? `<span class="kw">${kws.map(k => `<strong class="cardKeyword">${esc(k)}</strong>`).join(' · ')}</span><br>` : '';
}

type CardAppearance = 'auto' | 'classic' | 'borderless';
function resolvedAppearance(card: CardData, appearance: CardAppearance): 'classic' | 'borderless' {
  return appearance === 'auto' ? (isBorderlessEquipped(card.id) ? 'borderless' : 'classic') : appearance;
}
function renderCard(card: CardData, appearance: CardAppearance = 'auto'): HTMLElement {
  const col = colorOf(card.faction);
  const rarCol = RARITY_COLORS[card.rarity as Rarity] ?? '#cfd6dd';
  const cardStyle = resolvedAppearance(card, appearance);
  const FAC_ICO: Record<string, string> = { Aurites: '✦', Necrus: '☠', Terramorph: '⛰', Pyromancer: '♨', Ethereal: '☾', Neutral: '◈' };
  const node = el('div', `card f-${card.faction} r-${(card.rarity as string).toLowerCase()} t-${(card.type as string).toLowerCase()}${cardStyle === 'borderless' ? ' borderless' : ''}`);
  node.insertAdjacentHTML('afterbegin', `<span class="facIco" title="${FACTION_RU[card.faction]}">${FAC_ICO[card.faction] ?? '◈'}</span>`);
  node.insertAdjacentHTML('afterbegin', '<img class="frameOv" src="img/card_frame.png" alt="" draggable="false" onerror="this.remove()">');
  node.dataset.cardId = card.id;
  node.dataset.rarity = card.rarity as string;
  const ability = highlightCardKeywords(cardText(card));
  node.innerHTML = `
    <div class="banner" style="background:linear-gradient(90deg,${col.primary},${col.accent})"></div>
    <div class="innerframe"></div>
    <div class="spec"></div>
    <div class="foil"></div>
    <div class="holo"></div>
    <div class="frame">
      <div class="chead">
        <div class="ctitle">${cardName(card)}</div>
        <div class="cost" title="Стоимость розыгрыша">${card.cost}</div>
      </div>
      <div class="ctype">${typeName(card.type)}${card.element !== Element.None ? ' · ' + elemName(card.element) : ''}</div>
      <div class="cart">${artSvg(card, 200, 190)}</div>
      <div class="ctext">${keywordsLine(card)}${ability}</div>
      <div class="cfoot">
        <span class="rar" style="background:${rarCol};color:${rarCol}" title="${RARITY_RU[card.rarity]}"></span>
        <span class="cstats">${card.type === CardType.Creature
          ? `<span class="catk">${card.attack ?? 0}</span><span class="chp">${card.health ?? 0}</span>`
          : `<span style="color:#767c8e">${FACTION_SIGIL[card.faction]}</span>`}</span>
      </div>
    </div>`;
  node.dataset.cardAppearance = cardStyle;
  // Отдельный коллекционный ID варианта; игровой cardId остаётся исходным.
  node.dataset.cardVariantId = `${card.id}:${cardStyle}`;
  const ctNode = node.querySelector('.ctext') as HTMLElement | null;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fitText(ctNode)); // v2.6: автоподгон
  else fitText(ctNode);   // jsdom без rAF
  return node;
}

/* ---------------------------------------------------------------------- */
/*  Подсказка карты                                                        */
/* ---------------------------------------------------------------------- */

const tooltip = $('tooltip');
function showTooltip(card: CardData, x: number, y: number): void {
  const col = colorOf(card.faction);
  tooltip.innerHTML = `
    <div class="ttName" style="color:${col.primary}">${cardName(card)}</div>
    <div class="ttType">${typeName(card.type)} · ${factionName(card.faction)} · ${rarityName(card.rarity)} · ${card.cost} ${bi('маны', 'Mana')}${card.element !== Element.None ? ' · ' + elemName(card.element) : ''}</div>
    ${card.type === CardType.Creature ? `<div style="color:#ffd98a;font-size:.92rem">⚔ ${card.attack ?? 0} &nbsp; ❤ ${card.health ?? 0}</div>` : ''}
    <div class="ttText">${highlightCardKeywords(cardText(card)) || '—'}</div>
    ${cardFlavor(card) ? `<div class="ttFlavor">${cardFlavor(card)}</div>` : ''}`;
  tooltip.classList.add('show');
  const w = 238;
  const h = tooltip.offsetHeight || 160;
  tooltip.style.left = Math.max(8, Math.min(window.innerWidth - w - 10, x + 18)) + 'px';
  tooltip.style.top = Math.max(8, Math.min(window.innerHeight - h - 10, y - h / 2)) + 'px';
}
function hideTooltip(): void { tooltip.classList.remove('show'); }

/* ---------------------------------------------------------------------- */
/*  Настройки интерфейса (сохраняются в localStorage)                      */
/* ---------------------------------------------------------------------- */

interface UISettings { preview: boolean; fxLite: boolean; sound: boolean; hints: boolean; animSpeed: number; autoPass: boolean; rope: boolean; cbMode: boolean; fontScale: number; subs: boolean; lang: string; volMusic: number; volSfx: number; quality: string }

const SETTINGS_KEY = 'echo-citadel.settings.v1';
const SETTINGS_DEFAULT: UISettings = { preview: true, fxLite: false, sound: true, hints: true, animSpeed: 1, autoPass: false, rope: true, cbMode: false, fontScale: 1, subs: true, lang: 'ru', volMusic: 60, volSfx: 80, quality: 'high' };

function loadSettings(): UISettings {
  try {
    const raw = window.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return { ...SETTINGS_DEFAULT };
    const parsed = JSON.parse(raw) as Partial<UISettings>;
    return { ...SETTINGS_DEFAULT, ...parsed };
  } catch { return { ...SETTINGS_DEFAULT }; }
}

let settings: UISettings = loadSettings();

function saveSettings(): void {
  try { window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* приватный режим */ }
}

/* v2.5.3: надетые пользовательские арты (art_raw/cosm) → игра: рубашки карт в руке и
   руке противника, фон стола #board, фон чипов рун. HEAD-проба: файла нет → правило не
   вставляется, CSS-фолбэк остаётся. В jsdom нет fetch — молча пропускаем. */
async function applyCosmArt(): Promise<void> {
  if (typeof fetch !== 'function' || typeof meta === 'undefined') return;
  let st = document.getElementById('cosmArtStyle') as HTMLStyleElement | null;
  if (!st) { st = document.createElement('style'); st.id = 'cosmArtStyle'; document.head.appendChild(st); }
  const probe = async (kind: string, id: string): Promise<string> => {
    const url = `/cosm/${kind}/${id}`;
    try { const r = await fetch(url, { method: 'HEAD' }); return r.ok ? url : ''; } catch { return ''; }
  };
  const [b0, tb, r] = await Promise.all([
    probe('backs', meta.backEq || 'classic'),
    probe('tables', meta.tableSkin || 'classic'),
    probe('runes', meta.runeSkin || 'classic'),
  ]);
  // алиас: если «Классика» файлом не положена, пробуем cardback.png (слоты бустеров используют те же ключи)
  let b = b0;
  if (!b && (meta.backEq || 'classic') === 'classic') b = await probe('backs', 'cardback');
  const rules: string[] = [];
  const ts = Date.now();
  /* v2.5.5: рубашка — ВСЕ боевые поверхности (#hand, #enemyBacks, стопы .pbacks обоих
     игроков); !important побеждает темовые правила body[data-back=…] (выше специфичность).
     Стил-свотчи магазина (.cardback.mini/.big вне этих контейнеров) не затрагиваются. */
  if (b) rules.push(`#hand .cardback,#enemyBacks .cardback,.pbacks .cardback{background:url("${b}?t=${ts}") center/cover no-repeat !important;border-color:rgba(255,216,122,.35) !important}`);
  /* Стол — это полноэкранный #backdrop .bgArt, а не #board: иначе арт покрывал только
     верхние зоны и оставался шов на панели руки (репорт v2.5.4). */
  if (tb) rules.push(`#backdrop .bgArt{background-image:url("${tb}?t=${ts}")!important;background-position:center center!important;background-size:cover!important;background-repeat:no-repeat!important}`);
  if (r) rules.push(`.runeChip{background-image:url("${r}?t=${ts}");background-size:cover;background-position:center}`);
  st.textContent = rules.join('\n');
}

function applySettings(): void {
  document.body.classList.toggle('fxLite', settings.fxLite);
  document.body.classList.toggle('noHints', !settings.hints);
  vfxSetReducedMotion(settings.fxLite);
  audioSetEnabled(settings.sound);
  animSpd = settings.fxLite ? 0.6 : (settings.animSpeed || 1);
  const sp = document.getElementById('setSpeed') as HTMLSelectElement | null;
  if (sp) sp.value = String(settings.animSpeed ?? 1);
  const ap = document.getElementById('setAutoPass') as HTMLInputElement | null;
  if (ap) ap.checked = !!settings.autoPass;
  const rp = document.getElementById('setRope') as HTMLInputElement | null;
  if (rp) rp.checked = !!settings.rope;
  document.body.dataset.cb = settings.cbMode ? '1' : '0';
  document.documentElement.style.setProperty('--fs', String(settings.fontScale || 1));
  const cb = document.getElementById('setCb') as HTMLInputElement | null;
  if (cb) cb.checked = !!settings.cbMode;
  const fsel = document.getElementById('setFontScale') as HTMLSelectElement | null;
  if (fsel) fsel.value = String(settings.fontScale ?? 1);
  const subs = document.getElementById('setSubs') as HTMLInputElement | null;
  if (subs) subs.checked = !!settings.subs;
  const lang = document.getElementById('setLang') as HTMLSelectElement | null;
  if (lang) lang.value = settings.lang || 'ru';
  document.body.dataset.q = settings.quality ?? 'high';
  document.body.dataset.table = meta.tableSkin || 'classic';
  document.body.dataset.rune = meta.runeSkin || 'classic';
  void applyCosmArt();
  audioSetVolume((settings.volSfx ?? 80) / 100);
  musicSetVolume((settings.volMusic ?? 60) / 100);
  const vm = document.getElementById('setVolMusic') as HTMLInputElement | null;
  if (vm) vm.value = String(settings.volMusic ?? 60);
  const vs = document.getElementById('setVolSfx') as HTMLInputElement | null;
  if (vs) vs.value = String(settings.volSfx ?? 80);
  const ql = document.getElementById('setQuality') as HTMLSelectElement | null;
  if (ql) ql.value = settings.quality ?? 'high';
  void applyLocale();
  audioOn = settings.sound;
  const sb = $('btnSound');
  if (sb) sb.textContent = settings.sound ? '🔊 Звук' : '🔇 Звук';
  const setSound2 = $('setSound2') as HTMLInputElement | null;
  if (setSound2) setSound2.checked = settings.sound;
  if (!settings.preview) hideZoom();
  const hint = $('actionHint');
  if (hint) hint.style.display = settings.hints ? '' : 'none';
}

function toggleSettings(force?: boolean): void {
  const p = $('settingsPanel');
  const show = force ?? p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  $('settingsScrim')?.classList.toggle('hidden', !show);
  if (show) {
    ($('setPreview') as HTMLInputElement).checked = settings.preview;
    ($('setFx') as HTMLInputElement).checked = settings.fxLite;
    ($('setSound2') as HTMLInputElement).checked = settings.sound;
    ($('setHints') as HTMLInputElement).checked = settings.hints;
    syncAccountRow();
    Sfx.uiClick();
  }
}

/* ---------------------------------------------------------------------- */
/*  Крупный предпросмотр карты (юзабилити: полный арт и текст)             */
/* ---------------------------------------------------------------------- */

const zoomPreview = $('zoomPreview');
let zoomHideTimer: number | null = null;

/** Карта целиком: арт, полный текст способности, flavor, тип/редкость/стоимость. */
function renderCardLarge(card: CardData, size: 'xl' | 'xxl' = 'xl', appearance: CardAppearance = 'auto'): HTMLElement {
  const col = colorOf(card.faction);
  const rarCol = RARITY_COLORS[card.rarity as Rarity] ?? '#cfd6dd';
  const cardStyle = resolvedAppearance(card, appearance);
  const FAC_ICO2: Record<string, string> = { Aurites: '✦', Necrus: '☠', Terramorph: '⛰', Pyromancer: '♨', Ethereal: '☾', Neutral: '◈' };
  const node = el('div', `card f-${card.faction} r-${(card.rarity as string).toLowerCase()} t-${(card.type as string).toLowerCase()} ${size}${cardStyle === 'borderless' ? ' borderless' : ''}`);
  node.insertAdjacentHTML('afterbegin', `<span class="facIco" title="${FACTION_RU[card.faction]}">${FAC_ICO2[card.faction] ?? '◈'}</span>`);
  node.insertAdjacentHTML('afterbegin', '<img class="frameOv" src="img/card_frame.png" alt="" draggable="false" onerror="this.remove()">');
  node.dataset.cardId = card.id;
  node.innerHTML = `
    <div class="banner" style="background:linear-gradient(90deg,${col.primary},${col.accent})"></div>
    <div class="innerframe"></div>
    <div class="frame">
      <div class="chead">
        <div class="ctitle">${cardName(card)}</div>
        <div class="cost" title="Стоимость розыгрыша">${card.cost}</div>
      </div>
      <div class="ctype">${typeName(card.type)}${card.element !== Element.None ? ' · ' + elemName(card.element) : ''}</div>
      <div class="cart">${artSvg(card, size === 'xxl' ? 340 : 300, size === 'xxl' ? 330 : 290)}</div>
      <div class="ctext">${keywordsLine(card)}${highlightCardKeywords(cardText(card)) || '—'}${
        card.flavor ? `<div class="zflavor">${card.flavor}</div>` : ''}</div>
      <div class="cfoot">
        <span class="rar" style="background:${rarCol};color:${rarCol}" title="${RARITY_RU[card.rarity]}"></span>
        <span class="cstats">${card.type === CardType.Creature
          ? `<span class="catk">${card.attack ?? 0}</span><span class="chp">${card.health ?? 0}</span>`
          : `<span style="color:#767c8e">${FACTION_SIGIL[card.faction]}</span>`}</span>
      </div>
      <div class="zmeta">${FACTION_RU[card.faction]} · ${RARITY_RU[card.rarity]}${
        card.type === CardType.Spell && card.subtype === SpellSubtype.Instant ? ' · ⚡ мгновенное' : card.type === CardType.Spell && card.subtype === SpellSubtype.Ritual ? ' · ◷ ритуал' : ''}</div>
    </div>`;
  node.dataset.cardAppearance = cardStyle;
  node.dataset.cardVariantId = `${card.id}:${cardStyle}`;
  return node;
}

/**
 * Показать крупный предпросмотр рядом с курсором.
 * Для карт в руке — справа (слева, если не влезает), чтобы не закрывать веер;
 * для существ на доске — со стороны курсора.
 */
function showZoom(card: CardData, x: number, y: number, place: 'right' | 'left' | 'auto' = 'auto', appearance: CardAppearance = 'auto'): void {
  if (!settings.preview) return;
  if (zoomHideTimer !== null) { window.clearTimeout(zoomHideTimer); zoomHideTimer = null; }
  const previewStyle = resolvedAppearance(card, appearance);
  const prevVariantId = zoomPreview.dataset.cardVariantId;
  if (prevVariantId !== `${card.id}:${previewStyle}`) {
    zoomPreview.innerHTML = '';
    zoomPreview.appendChild(renderCardLarge(card, 'xxl', appearance));
    fitText(zoomPreview.querySelector('.ctext') as HTMLElement | null, 8); // v2.6: и в превью ничего не ползёт
    zoomPreview.dataset.cardId = card.id;
    zoomPreview.dataset.cardAppearance = previewStyle;
    zoomPreview.dataset.cardVariantId = `${card.id}:${previewStyle}`;
  }
  zoomPreview.classList.add('show');

  // MTG-док: превью справа (как в руке/библиотеке), но если курсор у правого края — показываем слева, чтобы не накрывать выбранную карту
  const vw = window.innerWidth;
  const nearRight = x > vw - 360;
  const nearLeft = x < 360;
  let side: 'right' | 'left' = 'right';
  if (place === 'left') side = 'left';
  else if (place === 'right') side = 'right';
  else side = nearRight ? 'left' : 'right';
  // если карта на правой половине стола — тоже слева
  if (nearRight && place === 'right') side = 'left';
  if (nearLeft && place === 'left') side = 'right';
  zoomPreview.style.left = side === 'left' ? '10px' : 'auto';
  zoomPreview.style.right = side === 'right' ? '10px' : 'auto';
  zoomPreview.style.top = '50%';
  zoomPreview.style.bottom = 'auto';
  zoomPreview.style.transform = side === 'right' ? 'translateY(-50%) translateX(0)' : 'translateY(-50%) translateX(0)';
  void y;
}

/** Спрятать с небольшой задержкой, чтобы не мигало при переходе между картами. */
function hideZoom(): void {
  if (zoomHideTimer !== null) window.clearTimeout(zoomHideTimer);
  zoomHideTimer = window.setTimeout(() => {
    zoomPreview.classList.remove('show');
    delete zoomPreview.dataset.cardId;
    delete zoomPreview.dataset.cardAppearance;
    delete zoomPreview.dataset.cardVariantId;
    zoomHideTimer = null;
  }, 120);
}

/* Глобальная синхронизация зума: превью видно ТОЛЬКО пока курсор над картой/юнитом.
   Лечение «залипания»: узел пересоздали под курсором → следующий mousemove снова
   откроет превью; узел умер без движения → renderAll скроет по isConnected. */
let lastZoomEl: HTMLElement | null = null;
document.addEventListener('mousemove', ev => {
  const host = (ev.target as HTMLElement | null)?.closest?.('.card,.unit') as HTMLElement | null;
  if (host && host.dataset.cardId) {
    lastZoomEl = host;
    const c = db.get(host.dataset.cardId);
    if (c) {
      const place = host.classList.contains('unit') ? 'right' : 'auto'; // v2.6: юниты — как рука, справа
      const appearance = host.dataset.cardAppearance === 'borderless' || host.dataset.cardAppearance === 'classic'
        ? host.dataset.cardAppearance as CardAppearance : 'auto';
      showZoom(c, ev.clientX, ev.clientY, place, appearance);
    }
    if (battle.pendingTarget && battle.aimFrom) battle.updateAim(ev, host);
  } else {
    lastZoomEl = null;
    // v2.5.2: лечение «залипания» превью на панели: курсор ушёл с карты без mouseleave
    // (узел пересоздан/перемещён) — прячем с той же выдержкой 120 мс, межкарточные
    // переходы не мигают: showZoom сбрасывает таймер при наведении следующей карты.
    if (zoomPreview.classList.contains('show')) hideZoom();
    if (battle.pendingTarget && battle.aimFrom) battle.updateAim(ev, null);
  }
}, { passive: true });
document.addEventListener('dragstart', () => hideZoom());   // v2.5.2: превью не висит во время drag&drop

/* ---------------------------------------------------------------------- */
/*  Лог (ТЗ п.4.5)                                                         */
/* ---------------------------------------------------------------------- */

/** Журнал боя: чат на экране убран по требованию — буфер в памяти (статистика/отладка). */
interface LogRec { t: string; cls: string }
const logBuffer: LogRec[] = [];
(window as unknown as { logLines: LogRec[] }).logLines = logBuffer;
function pushLog(text: string, cls = ''): void {
  logBuffer.push({ t: text, cls });
  while (logBuffer.length > 240) logBuffer.shift();
}
const KW_GLOSS: Record<string, string> = {
  'Провокация': 'Провокация: авто-атаки противника обязаны выбирать это существо первой целью.',
  'Рывок': 'Рывок: может атаковать в ход призыва (игнорирует болезнь призыва).',
  'Прорыв': 'Прорыв: избыточный урон от атаки проходит в героя защищающегося.',
  'Вампиризм': 'Вампиризм: урон этого существа лечит вашего героя на ту же величину.',
  'Буря': 'Буря: существо атакует дважды за ход.',
  'Неуклонность': 'Неуклонность: не может быть выбрано целью авто-атаки противника.',
  'Хрип': 'Предсмертный хрип: способность срабатывает при гибели существа.',
  'Клич': 'Боевой клич: способность срабатывает при выходе существа на поле.',
  'Щит': 'Щит: поглощает первое полученное повреждение.',
  'Горение': 'Горение: N урона в начале хода владельца, стек уменьшается.',
  'Яд': 'Яд: любое полученное повреждение убивает существо.',
  'Заморозка': 'Заморозка: существо не атакует, стек тает.',
  'Немота': 'Немота: способности и статусы отключены перманентно.',
  'Ярость': 'Ярость: игнорирует болезнь призыва.',
};
function showTextTip(html: string, x: number, y: number): void {
  const tt = $('tooltip');
  if (!tt) return;
  tt.innerHTML = html;
  tt.classList.add('on');
  tt.style.left = `${Math.min(window.innerWidth - 260, Math.max(8, x + 14))}px`;
  tt.style.top = `${Math.min(window.innerHeight - 90, Math.max(8, y + 12))}px`;
}
document.addEventListener('mouseover', ev => {
  const t = ev.target as HTMLElement | null;
  if (!t || !(t.classList.contains('kw') || t.classList.contains('badge'))) return;
  const key = (t.textContent ?? '').trim().split(/[:\s]/)[0];
  const full = KW_GLOSS[key] ?? Object.values(KW_GLOSS).find(g => g.startsWith(key));
  if (full && settings.hints) showTextTip(`<div class="ttName">${esc(key)}</div><div class="ttType">${esc(full.split(': ').slice(1).join(': '))}</div>`, ev.clientX, ev.clientY);
});
document.addEventListener('mouseout', ev => {
  const t = ev.target as HTMLElement | null;
  if (t && (t.classList.contains('kw') || t.classList.contains('badge'))) hideTooltip();
});

/* --- локализация: ядро-подписи из data/locale/<lang>.json (ключи ui_*) --- */
let localeCache: Record<string, string> | null = null;
let localeLang = '';
async function applyLocale(): Promise<void> {
  const lang = settings.lang || 'ru';
  if (lang === localeLang && localeCache) return;
  try {
    const r = await fetch(`/locale/${lang}.json`);
    localeCache = (await r.json()) as Record<string, string>;
    localeLang = lang;
  } catch { localeCache = null; return; }
  document.querySelectorAll('[data-i18n]').forEach(n => {
    const key = (n as HTMLElement).dataset.i18n ?? '';
    const v = localeCache?.[key];
    if (!v) return;
    if ((n as HTMLElement).children.length === 0) {
      (n as HTMLElement).textContent = v;
    } else {
      // сохраняем вложенные элементы (например, <span id="ecPlayMode"> у #btnPlay)
      n.childNodes.forEach(cd => { if (cd.nodeType === 3) cd.textContent = ''; });
      n.insertBefore(document.createTextNode(v), n.firstChild);
    }
  });
}
/* --- перевод карточек: имя/текст/флейвор + служебные названия.
      RU — всегда из Cards.json (источник истины), EN — из /locale/en.json
      (кэш applyLocale). Нет ключа или не EN — молча отдаём русский оригинал. --- */
const KW_EN: Record<string, string> = {
  Taunt: 'Taunt', Lifesteal: 'Lifesteal', Deathrattle: 'Deathrattle', Battlecry: 'Battlecry',
  Rush: 'Rush', Windfury: 'Windfury', Unblockable: 'Unblockable', Trample: 'Trample',
  SpellDamage: 'Spell Damage +1', DivineShield: 'Divine Shield', Poisonous: 'Poisonous', Freezing: 'Freezing',
};
const TYPE_EN: Record<string, string> = { Creature: 'Minion', Spell: 'Spell', Rune: 'Rune' };
const RARITY_EN: Record<string, string> = { Common: 'Common', Rare: 'Rare', Epic: 'Epic', Legendary: 'Legendary' };
const ELEM_EN: Record<string, string> = { None: '—', Fire: 'Fire', Water: 'Water', Earth: 'Earth', Air: 'Air', Chaos: 'Chaos' };
const FACTION_EN: Record<string, string> = {
  Aurites: 'Aurites', Necrus: 'Necrus', Terramorph: 'Terramorph',
  Pyromancer: 'Pyromancer', Ethereal: 'Ethereal', Neutral: 'Neutral',
};

function isEN(): boolean { return (settings.lang || 'ru') === 'en'; }
/** Двуязычная строка интерфейса: bi('Руна', 'Rune'). */
function bi(ru: string, en: string): string { return isEN() ? en : ru; }
function kwName(k: string): string { return isEN() ? (KW_EN[k] ?? k) : (KW_RU[k] ?? k); }
function typeName(t: string): string { return isEN() ? (TYPE_EN[t] ?? t) : (TYPE_RU[t] ?? t); }
function rarityName(r: string): string { return isEN() ? (RARITY_EN[r] ?? r) : (RARITY_RU[r] ?? r); }
function elemName(e: string): string { return isEN() ? (ELEM_EN[e] ?? e) : (ELEM_RU[e] ?? e); }
function factionName(f: string): string {
  const k = f as Faction;
  return isEN() ? (FACTION_EN[k] ?? f) : (FACTION_RU[k] ?? f);
}
function cardName(c: CardData): string {
  return isEN() ? (localeCache?.[`card_${c.id}_name`] || c.name) : c.name;
}
function cardText(c: CardData): string {
  const ru = c.abilityText ?? '';
  return isEN() ? (localeCache?.[`card_${c.id}_text`] || ru) : ru;
}
function highlightCardKeywords(text: string): string {
  let html = esc(text);
  const terms = [...new Set(Object.values(isEN() ? KW_EN : KW_RU))].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    html = html.replace(re, '$1<strong class="cardKeyword">$2</strong>');
  }
  return html;
}
function cardFlavor(c: CardData): string {
  const ru = c.flavor ?? '';
  return isEN() ? (localeCache?.[`card_${c.id}_flavor`] || ru) : ru;
}
/** Перерисовать видимое после смены языка (сборка DOM всегда из актуальных строк). */
function refreshLocalizedUI(): void {
  try { if (!$('collection')?.classList.contains('hidden')) renderCollection(); } catch { /* экран закрыт */ }
  try { if (!$('cardModal')?.classList.contains('hidden')) renderCardModal(); } catch { /* модалка закрыта */ }
  try { if (!$('battle')?.classList.contains('hidden')) battle.renderAll(); } catch { /* боя нет */ }
  try { renderDeckGrid(); } catch { /* сетки колод нет */ }
}
/** Смена языка: настройки + перезагрузка словаря + перерисовка открытого. */
async function switchLang(lang: string): Promise<void> {
  settings.lang = lang;
  localeLang = '';
  saveSettings();
  const sel = document.getElementById('setLang') as HTMLSelectElement | null;
  if (sel) sel.value = lang;
  document.documentElement.lang = lang;
  applySettings();
  await applyLocale();
  refreshLocalizedUI();
}

const SUBS_RU: Array<[string, string]> = [
  ['melee', '⚔ звук удара существа'], ['spell', '✨ звук заклинания'], ['death', '☠ существо погибло'],
  ['heal', '❤ лечение'], ['heroHit', '💥 урон герою'], ['summon', '⛺ призыв существа'], ['status', '✦ статус наложен или снят'],
];
let subsTimer = 0;
function caption(text: string): void {
  if (!settings.subs) return;
  const n = $('subsLine');
  if (!n) return;
  n.textContent = text;
  n.classList.add('on');
  if (subsTimer) window.clearTimeout(subsTimer);
  subsTimer = window.setTimeout(() => n.classList.remove('on'), 1600);
}
function captionFor(kind: string): void {
  const hit = SUBS_RU.find(([k]) => k === kind);
  if (hit) caption(hit[1]);
}

function openJournal(): void {
  const list = $('journalList');
  if (!list) return;
  list.innerHTML = logBuffer.map(r =>
    `<div class="jl ${r.cls}">${esc(r.t)}</div>`).join('') || '<div class="jl">Журнал пуст</div>';
  list.scrollTop = list.scrollHeight;
  $('journalModal').classList.remove('hidden');
}

/* ---------------------------------------------------------------------- */
/*  Контроллер боя                                                         */
/* ---------------------------------------------------------------------- */

class Battle {
  engine: GameEngine | null = null;
  ai: AIController | null = null;
  playerFaction: Faction = Faction.Aurites;
  playerDeckId: string = 'Aurites';
  enemyFaction: Faction = Faction.Necrus;
  difficulty = 0.8;

  running = false;
  busy = false;
  /** uid существа -> DOM-узел. Пересобирается целиком при каждом renderAll(). */
  unitNodes = new Map<number, HTMLElement>();
  /** Узлы существ, проигрывающих анимацию смерти (уже не в движке). */
  private dyingUnits = new Map<number, HTMLElement>();
  /** метки свежих уронных вспышек: hp-бейдж мигает и после перерисовки */
  private dmgFlash = new Map<number, number>();
  handNodes: HTMLElement[] = [];
  pendingTarget: ((uid: number | null, side: Side | null) => void) | null = null;
  manualCombat = true;
  inCombatWindow = false;
  pendingAttack: number | null = null;
  private combatWindowDone: (() => void) | null = null;
  private turnDone: (() => void) | null = null;
  /** Существа, призванные с прошлого рендера: им показываем анимацию выхода. */
  private summonedUids = new Set<number>();
  /** VFX призыва ждут рендера: событие приходит раньше DOM-узла существа. */
  private pendingSummonFx = new Map<number, { side: Side; faction: Faction }>();
  /** Статусные события привязаны к узлу после рендера или к шагу соответствующей атаки. */
  private pendingStatusFx: Array<{ uid: number; status: string; text?: string; expired?: boolean }> = [];
  /** было ли существо тапнутым в прошлом рендере — для волны антапа */
  private prevTapped = new Map<number, boolean>();
  private pendingDraw: { cardId: string | null; at: DOMRect | null } | null = null;
  aimFrom: { x: number; y: number } | null = null;
  autoTurnEnabled = true;
  private autoToken = '';
  private autoDeadline = 0;
  private autoTimer: number | null = null;
  private combatAnim: ((queue: GameEngine['attackQueue']) => Promise<void>) | null = null;
  /** Пока идёт анимация «Битвы», цифры жизней берём из снапшота, а не из движка:
      движок разрешает бой синхронно, и без этого HP «прыгал» вперёд анимации. */
  private combatBusy = false;
  private combatSnap: { hp: Record<number, number>; units: Map<number, number> } | null = null;
  private overShown = false;

  /* ------------------------------ запуск ------------------------------ */

  async start(): Promise<void> {
    this.running = true; this.busy = false; this.overShown = false;
    this.combatBusy = false; this.combatSnap = null;
    this.unitNodes.clear(); this.dyingUnits.clear(); this.pendingSummonFx.clear(); this.pendingStatusFx = []; logBuffer.length = 0;

    // v2.6: преконстракт-колоды (Decks.json) играбельны всегда, как базовые колоды
    // в Hearthstone; гейт владения — только для пользовательских колод.
    const pDef = resolveDeck(this.playerDeckId, deckList as unknown as DeckLike[])
      ?? starterDeckForFaction(this.playerFaction)
      ?? deckById.get(this.playerFaction)!;
    const pDeck = pDef.cards.slice();
    if (!isStarterDeckId(pDef.id)) {
      const unowned = pDeck.filter(id => ownedCount(id) === 0);
      if (unowned.length > 0) {
        this.running = false;
        pushLog(`⛔ В колоде ${unowned.length} карт, которых пока нет в коллекции: откройте бустеры, события или боевой пропуск.`, 'big');
        this.setWho('Колода недоступна');
        this.renderAll();
        return;
      }
    }
    // В учебном режиме используем зеркало стартовой колоды соперника — 30 против 30.
    const enemyDef = isStarterDeckId(pDef.id)
      ? starterDeckForFaction(this.enemyFaction) ?? deckById.get(this.enemyFaction)!
      : deckById.get(this.enemyFaction)!;
    const eDeck = enemyDef.cards.slice();

    this.engine = new GameEngine(db, [pDeck, eDeck], {
      factions: [this.playerFaction, this.enemyFaction],
      names: ['Вы', this.friendFoe ?? (this.bossPower ? `БОСС · ${FACTION_RU[this.enemyFaction]}` : FACTION_RU[this.enemyFaction])],
      seed: (Date.now() % 99991) + 7,
      config: { ...DEFAULT_CONFIG, passiveMul: PASSIVE_MUL, combatMode: 'manual' },
      hooks: { onEvent: (e: GameEvent) => this.onEvent(e) },
    });
    // анимации фазы «Битва»: движок отдаёт очередь атак, UI проигрывает их по одной
    // даже если анимация боя упадёт — снапшот сбрасывается и цифры не «залипают»
    this.combatAnim = (q) => this.animateCombat(q)
      .catch(err => { reportFatal('combat-anim', err); })
      .finally(() => { this.combatBusy = false; this.combatSnap = null; this.renderStats(); });
    this.engine.onBeforeCombatEnd = this.combatAnim;
    this.engine.interactiveStack = true;
    this.matchStart = Date.now();
    this.telemPlayed = [];
    this.bossLastTurn = -1;
    if (this.bossPower && this.bossHp > 0) {
      const op = this.engine.p(Side.Opponent);
      op.health = this.bossHp; op.maxHealth = this.bossHp;
    }
    this.tutInjected = [];
    if (this.tutLesson) {
      // спека «6. Обучение»: у каждого урока своя заскриптованная рука (зеркало tutorial.json для Unity)
      const inj = TUT_HANDS[this.tutLesson] ?? [];
      const ph = this.engine.p(Side.Player);
      for (const id of inj) if (ph.hand.length < 10 && db.has(id)) ph.hand.push(id);
      this.tutInjected = inj.filter(id => db.has(id));
      this.tutStartLesson();
    } else tutCoachHide();

    const prof = AI_PROFILES[this.enemyFaction] ?? AI_PROFILES[Faction.Neutral];
    this.ai = new AIController(this.engine, Side.Opponent, {
      ...prof,
      skill: this.difficulty,
      blunderRate: Math.max(0.02, Math.round((1 - this.difficulty) * 0.5 * 100) / 100),
      lookahead: this.difficulty >= 1,
    });

    setAppRoute('battle');
    $('menu').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('battle').classList.remove('hidden');
    this.setupScene();
    const pPass = `${FACTION_RU[this.playerFaction]} · ${PASSIVE_TEXT[this.playerFaction].replace(/<[^>]+>/g, '')}`;
    const ePass = `${FACTION_RU[this.enemyFaction]} · ${PASSIVE_TEXT[this.enemyFaction].replace(/<[^>]+>/g, '')}`;
    $('playerFac').textContent = pPass; $('playerFac').title = pPass;
    $('enemyFac').textContent = ePass; $('enemyFac').title = ePass;
    this.setPortrait('playerPortrait', this.playerFaction);
    this.setPortrait('enemyPortrait', this.enemyFaction);

    this.engine.setup();
    pushLog(`⚔ ${FACTION_RU[this.playerFaction]} против ${FACTION_RU[this.enemyFaction]}`, 'big');
    this.renderAll();
    await this.showMulligan();

    this.engine.activeSide = Side.Player;
    this.engine.turn = 0;
    await this.loop();
  }

  /**
   * Сцена боя: 4 параллакс-слоя фона в палитре фракции игрока, каменная
   * поверхность стола, пост-слои (виньетка/грейн/грейдинг), ambient-частицы.
   * Соответствие Unity — docs/VISUAL_STACK.md, разделы 1, 2, 4.
   */
  private setupScene(): void {
    const layers = tableBackdrop(this.playerFaction);
    const bd = $('backdrop');
    if (bd) [...bd.querySelectorAll<HTMLElement>('.bl')].forEach((n, i) => {
      if (layers[i]) n.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(layers[i])}")`;
    });
    const ts = $('tableSurface');
    if (ts && !ts.dataset.ready) { ts.innerHTML = tableSurface(); ts.dataset.ready = '1'; }
    Vfx.vfxInit($('battle'));
    Vfx.mountPostLayers(document.body);
    Vfx.startAmbient(paletteOf(this.playerFaction).secondary, 70);
    Vfx.setAmbientColor(paletteOf(this.playerFaction).secondary);
    Vfx.startParallax([...(bd?.querySelectorAll<HTMLElement>('.bl') ?? [])]);
    if (!this.candleTimer) this.candleTimer = window.setInterval(() => Vfx.candleFlicker(bd ?? document.body), 2600);
  }
  private candleTimer: number | null = null;

  stop(): void { this.running = false; this.turnDone?.(); }

  /* --------------------------- главный цикл --------------------------- */

  private async loop(): Promise<void> {
    const e = this.engine!;
    try {
    while (this.running && e.result === GameResult.Ongoing) {
      if (e.activeSide === Side.Player) await this.humanTurn();
      else await this.aiTurn();
      if (e.result === GameResult.Ongoing && e.turn > e.config.maxTurns) e.result = GameResult.Draw;
      this.renderAll();
    }
    this.renderAll();
    await sleep(340);
    this.showGameOver();
    } catch (err) { reportFatal('loop', err); this.running = false; this.setBusy(false); }
  }

  /** Ход игрока: Start/Resource исполняет движок, Main ждёт «Завершить ход». */
  private async humanTurn(): Promise<void> {
    const e = this.engine!;
    this.setBusy(false);
    this.setWho('Ваш ход');
    e.runTurn();                                   // → фаза Main
    this.ropeStart();
    await this.playPhaseBanners([Phase.Start, Phase.Resource]);
    this.renderAll();

    await new Promise<void>(res => { this.turnDone = res; });
    this.turnDone = null;
    if (!this.running) return;

    this.aiInstantResponse('перед вашей атакой');
    this.setWho('Битва');
    if (this.manualCombat) {
      e.enterCombatPhase();
      await this.combatWindow();
      if (!this.running) return;
    }
    await e.finishMainPhase();                     // бой полностью проигрывается до конца хода
    this.aiInstantResponse('в конец вашего хода');
    this.renderAll();
  }

  /** Ход ИИ: пауза 1–2 с (ТЗ п.5.1), «неидеальность» через blunderRate. */
  /** Окно отклика для игрока во время хода ИИ (MTG: приоритет оппонента). */
  private instantPassResolve: (() => void) | null = null;
  private instantTimer = 0;
  private async responseWindow(label: string, force = false): Promise<void> {
    const e = this.engine!;
    if (e.result !== GameResult.Ongoing || !this.running) return;
    const hand = e.p(Side.Player).hand.map(id => e.db.get(id)).filter(Boolean) as CardData[];
    const mana = e.p(Side.Player).mana;
    if (!force && !hand.some(c => c.type === CardType.Spell && c.subtype === SpellSubtype.Instant && c.cost <= mana)) return;
    e.openInstantWindow(Side.Player);
    this.instantLabel = label;
    this.renderAll();
    if ((window as unknown as { ecAutoPass?: boolean }).ecAutoPass || settings.autoPass) {
      window.setTimeout(() => this.passInstant(), 0);   // headless-режим смоука / авто-приоритет
    }
    this.cdLeft = 20;
    if (this.cdTimer) window.clearInterval(this.cdTimer);
    this.cdTimer = window.setInterval(() => {
      this.cdLeft -= 0.2;
      const cd = $('instantCd');
      if (cd) {
        cd.textContent = `${Math.max(0, Math.ceil(this.cdLeft))} с`;
        (cd.parentElement as HTMLElement | null)?.style.setProperty('--cd', `${Math.max(0, this.cdLeft / 20) * 100}%`);
      }
    }, 200);
    await new Promise<void>(res => {
      this.instantPassResolve = res;
      this.instantTimer = window.setTimeout(() => this.passInstant(), 20000);
    });
  }
  private prevMana = -1;
  private ropeTimer = 0;
  private ropeLeft = 75;
  ropeStart(): void {
    this.ropeStop();
    if (!settings.rope) { $('ropeBar')?.classList.add('hidden'); return; }
    $('ropeBar')?.classList.remove('hidden');
    this.ropeLeft = 75;
    this.ropeTimer = window.setInterval(() => {
      if (this.busy || this.combatBusy || this.engine?.instantWindow !== null ||
          this.engine?.result !== GameResult.Ongoing) return;
      this.ropeLeft -= 0.25;
      const f = $('ropeFill');
      if (f) {
        f.style.width = `${Math.max(0, (this.ropeLeft / 75) * 100)}%`;
        f.style.background = this.ropeLeft < 15 ? '#e05545' : this.ropeLeft < 35 ? '#e0a545' : '#7ac060';
      }
      if (this.ropeLeft <= 0) { this.ropeStop(); this.endTurnNow(); }
    }, 250);
  }
  ropeStop(): void { if (this.ropeTimer) { window.clearInterval(this.ropeTimer); this.ropeTimer = 0; } }

  private matchStart = 0;
  private telemPlayed: Array<[string, number]> = [];

  campaignBoss: string | null = null;
  launchMode: 'menu' | 'campaign' | 'friend' | 'tut' = 'menu';
  practice = false;
  matchId: string | null = null;   // из POST /api/match/start (спека п.1.4); null — офлайн/локальный бой
  friendFoe: string | null = null;
  tutLesson = 0;
  tutStepId = 0;              // текущий шаг урока (TUT_STEPS, спека «6.1»: 20 шагов × 4 урока)
  private tutPollId = 0;      // поллер выполнения шага
  tutMark = 0;                // метка хода на входе в шаг (читают предикаты TUT_STEPS)
  tutMarkCards = 0;           // метка cardsPlayed
  tutMarkDmg = 0;             // метка damageDealt
  private tutTap = false;     // клик по подсвеченной карте (урок 4: «нельзя сыграть 5✦ рано»)
  private tutLastBlock = 0;   // троттл тоста блокера
  tutInjected: string[] = [];
  bossPower: string | null = null;
  bossHp = 0;
  campNode: { id: string; mult: number; diff: number; kind: string } | null = null;
  private bossLastTurn = -1;

  /** Награды и прогресс мета-игры за матч. */
  private metaRewards(): void {
    const e = this.engine;
    if (!e || e.result === GameResult.Ongoing) return;
    const win = e.result === GameResult.PlayerWin;
    const fac = this.playerFaction as string;
    const unranked = this.practice || !!this.campaignBoss || this.tutLesson > 0;
    const lvlBefore = Math.floor(meta.xp / 500) + 1;
    if (win) { meta.wins += 1; meta.facW[fac] = (meta.facW[fac] ?? 0) + 1;
      if (!unranked) {
        meta.mmr += 12;
        if (!meta.borderlessEventClaimed) meta.borderlessEventWins = Math.min(BORDERLESS_EVENT_WINS, (meta.borderlessEventWins ?? 0) + 1);
      }
      meta.xp += 80 + e.turn * 2; questBump('win_fac', 1, fac); }
    else { meta.losses += 1; meta.facL[fac] = (meta.facL[fac] ?? 0) + 1;
      if (!unranked) meta.mmr = Math.max(800, meta.mmr - 10);
      meta.xp += 20 + e.turn; }
    meta.bestMmr = Math.max(meta.bestMmr ?? meta.mmr, meta.mmr);
    meta.bpXp = (meta.bpXp ?? 0) + (win ? 120 : 60);   // спека «5. Боевой пропуск»: единые 120/60 во всех режимах (решение пользователя)
    questBump('dmg', e.stats[Side.Player].damageDealt);
    checkAchs();                                   // спека 2.5: достижения, тост, награда
    const lvlAfter = Math.floor(meta.xp / 500) + 1;
    if (lvlAfter > lvlBefore) levelUpFx(lvlAfter); // спека 2.1: анимация Level Up с частицами
    let reward = 0;
    let gemReward = 0;
    if (this.campNode) {
      const cn = this.campNode;
      if (win) {
        const fac = cn.id.split('_')[0];
        meta.campStars = meta.campStars ?? {};
        meta.campStars[cn.id] = (meta.campStars[cn.id] ?? 0) | cn.diff;
        if (!(meta.loreRead ?? []).includes(cn.id)) meta.loreRead = [...(meta.loreRead ?? []), cn.id];
        reward += Math.round((cn.kind === 'boss' ? 250 : cn.kind === 'elite' ? 160 : 110) * cn.mult);
        if (cn.kind === 'boss') {
          meta.campaign[fac] = true;
          gemReward += 30;
          if (cn.diff !== 1) meta.freeOpens = (meta.freeOpens ?? 0) + 1;
        }
      }
      this.campNode = null;
    }
    if (this.campaignBoss && win && !meta.campaign[this.campaignBoss]) {
      meta.campaign[this.campaignBoss] = true; reward += 250;
    }
    this.campaignBoss = null;
    const tsNow = Date.now();
    const foeName = this.friendFoe ?? `ИИ ${FACTION_RU[this.enemyFaction]}`;
    meta.history.unshift({ ts: tsNow, win, fac, turns: e.turn, foe: foeName,
      efac: this.enemyFaction as string, practice: unranked || undefined });
    meta.telem = meta.telem ?? [];
    meta.telem.unshift({
      ts: tsNow, fac, win, turns: e.turn,
      secs: Math.round((tsNow - this.matchStart) / 1000),
      played: this.telemPlayed.slice(0, 60),
      stuck: e.p(Side.Player).hand.slice(0, 10),
      matchId: this.matchId,
    });
    while (meta.telem.length > 40) meta.telem.pop();
    apiSend('/api/telemetry', { e: meta.telem[0] });   // LAUNCH_PLAN: телеметрия на сервер (best-effort)
    meta.replays = meta.replays ?? [];
    meta.replays.unshift({
      ts: tsNow, win, fac, turns: e.turn, foe: foeName,
      lines: e.log.filter(v => !!v.text).slice(-140).map(v => [v.turn ?? 0, v.text ?? ''] as [number, string]),
    });
    while (meta.replays.length > 3) meta.replays.pop();
    while (meta.history.length > 20) meta.history.pop();
    metaSave();
    this.friendFoe = null;
    const go = $('goStats');
    if (go) {
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:.5rem;color:#ffe9b0;font-family:Philosopher,serif;font-size:.9rem';
      line.textContent = `Награды: +${win ? 80 + e.turn * 2 : 20 + e.turn} опыта, +${win ? (unranked ? 60 : 120) : (unranked ? 25 : 60)} опыта пропуска` +
        (unranked ? ' (матч без рейтинга)' : `, рейтинг ${meta.mmr} — ${rankOf(meta.mmr).title}`) +
        (reward ? `, 🪙${reward}${gemReward ? ` и 💎${gemReward}` : ''} за кампанию` : '');
      go.appendChild(line);
    }
    if (reward) shardsAdd(reward);
    if (gemReward) gemsAdd(gemReward);
  }

  private stackBusy = false;

  /** Насос стека: поочерёдные окна ответа до опустошения LIFO-стека. */
  private async stackPump(): Promise<void> {
    const e = this.engine!;
    let guard = 0;
    while (e.stack.length > 0 && this.running && guard++ < 24) {
      const top = e.stack[e.stack.length - 1];
      const responder = top.side === Side.Player ? Side.Opponent : Side.Player;
      if (responder === Side.Opponent) {
        await sleep(260);
        const before = e.stack.length;
        this.aiInstantResponse('ответ в стеке');
        if (e.stack.length === before) e.passStack(Side.Opponent);
        this.renderStack();
      } else {
        await this.responseWindow(`стек: ответ на «${top.card.name}»`, true);
        if (!this.running) return;
      }
    }
    this.renderStack();
  }

  private renderStack(): void {
    const e = this.engine;
    const panel = $('stackPanel');
    const list = $('stackList');
    if (!panel || !list || !e) return;
    if (e.stack.length === 0) { panel.classList.add('hidden'); list.innerHTML = ''; return; }
    panel.classList.remove('hidden');
    list.innerHTML = e.stack.map((en, i) =>
      `<div class="stItem ${en.side === Side.Player ? 'me' : 'foe'}">${i === e.stack.length - 1 ? '▶ ' : ''}${
        en.side === Side.Player ? 'Вы' : 'Противник'}: ${esc(en.card.name)}</div>`).join('');
  }

  private instantLabel = '';
  private cdTimer = 0;
  private cdLeft = 20;
  passInstant(): void {
    if (this.cdTimer) { window.clearInterval(this.cdTimer); this.cdTimer = 0; }
    if (this.instantTimer) { window.clearTimeout(this.instantTimer); this.instantTimer = 0; }
    this.engine?.passStack(Side.Player);
    this.renderStack();
    const res = this.instantPassResolve;
    this.instantPassResolve = null;
    this.engine?.closeInstantWindow();
    this.renderAll();
    if (res) res();
  }
  /** ИИ отвечает мгновенными заклинаниями в ваш ход (эвристика). */
  private aiInstantResponse(label: string): void {
    const e = this.engine!;
    if (e.result !== GameResult.Ongoing) return;
    const pl = e.p(Side.Opponent);
    e.openInstantWindow(Side.Opponent);
    for (let i = pl.hand.length - 1; i >= 0; i--) {
      const c = e.db.get(pl.hand[i]);
      if (!c || c.type !== CardType.Spell || c.subtype !== SpellSubtype.Instant || c.cost > pl.mana) continue;
      const ops = (c.effects ?? []).map(f => f.op);
      const myBoard = e.p(Side.Player).creatures;
      const want =
        (ops.includes('damageAllEnemyCreatures') || ops.includes('burnAllEnemies')) && myBoard.length >= 2 ||
        (ops.includes('heal')) && pl.health <= 14 ||
        (ops.includes('freezeAllEnemies')) && myBoard.some(u => u.attack >= 4) ||
        (ops.includes('damage')) && myBoard.some(u => u.health <= ((c.effects ?? [])[0]?.value ?? 0));
      if (!want) continue;
      const tgt = ops.includes('damage') ? myBoard.find(u => u.health <= ((c.effects ?? [])[0]?.value ?? 0)) : undefined;
      e.playCard(Side.Opponent, i, tgt?.uid, tgt ? Side.Player : undefined);
      this.setWho(`⚡ Ответ противника: ${label}`);
      this.renderAll();
      break;
    }
    e.closeInstantWindow();
  }

  private async aiTurn(): Promise<void> {
    const e = this.engine!;
    this.setBusy(true);
    this.setWho('Ход противника');
    e.runTurn();
    await this.playPhaseBanners([Phase.Start, Phase.Resource]);
    this.renderAll();
    await this.responseWindow('основная фаза противника');
    await sleep(500 + Math.random() * 700);

    let guard = 0;
    while (e.phase === Phase.Main && e.result === GameResult.Ongoing && guard++ < 26 && this.running) {
      let act = this.ai!.chooseBestAction();
      if (!act || act.score <= 0) break;
      if (e.rng.chance(this.ai!.profile.blunderRate * (1 - this.ai!.profile.skill))) {
        const alt = this.ai!.chooseSecondBest();
        if (alt && alt.score > 0 && alt.action.type !== 'endTurn') act = alt;
      }
      if (act.action.type === 'endTurn') break;
      const ok = e.playAIFallback(act.action, Side.Opponent);
      this.renderAll();
      await sleep(420 + Math.random() * 220);
      if (!ok) break;
    }

    await this.responseWindow('перед атакой противника');
    if (!this.running) return;
    await e.finishMainPhase();
    await this.responseWindow('конец хода противника');
    this.setBusy(false);
    this.renderAll();
  }

  /* ------------------------- фазы / баннеры ------------------------- */

  private async playPhaseBanners(phases: Phase[]): Promise<void> {
    for (const p of phases) {
      this.renderPhaseTrack(p);
      await this.banner(PHASE_RU[p]);
      await sleep(140);
    }
    this.renderPhaseTrack(Phase.Main);
  }

  private async banner(text: string): Promise<void> {
    Vfx.phaseFx(text);
    if (text === PHASE_RU[Phase.Combat]) Sfx.phaseCombat();
    const b = $('phaseBanner');
    b.textContent = text;
    b.style.setProperty('--bc', paletteOf(this.engine?.p(this.engine.activeSide).faction ?? Faction.Neutral).primary);
    b.classList.remove('show');
    void b.offsetWidth;                            // перезапуск CSS-анимации
    b.classList.add('show');
    await sleep(640);   // MTG-темп: баннер фазы дышит, а не мигает
  }

  private renderPhaseTrack(current: Phase): void {
    const track = $('phaseTrack');
    track.innerHTML = '';
    const ci = PHASE_ORDER.indexOf(current);
    PHASE_ORDER.forEach((p, i) => {
      const d = el('div', 'pstep' + (i === ci ? ' active' : i < ci ? ' done' : ''), PHASE_RU[p]);
      d.title = PHASE_HINT[p] ?? '';
      track.appendChild(d);
    });
    $('turnNo').textContent = String(Math.max(1, this.engine?.turn ?? 1));
  }

  private setBusy(v: boolean): void {
    this.busy = v;
    $('busy').classList.toggle('show', v);
    this.updateButtons();
  }
  private setWho(t: string): void {
    $('whoTurn').textContent = t;
    const pill = $('turnPill');
    if (pill) {
      const mine = t.indexOf('Ваш') === 0 || t === 'Битва';
      pill.textContent = t === 'Битва' ? 'Ваш ход · битва' : (mine ? 'Ваш ход' : t);
      pill.classList.toggle('mine', mine);
    }
  }

  /** Дорожка шагов боя в духе MTG: подсветка текущего шага, прошедшие — приглушены. */
  private setCombatStep(i: number): void {
    const tr = $('stepTrack');
    if (!tr) return;
    tr.classList.remove('hidden');
    const steps = tr.querySelectorAll('.step');
    steps.forEach((n, idx) => {
      n.classList.toggle('on', idx === i);
      n.classList.toggle('done', idx < i);
    });
  }
  private hideCombatSteps(): void {
    const tr = $('stepTrack');
    if (tr) tr.classList.add('hidden');
  }

  /** Золотая дуга атаки в стиле Arena: атакующий → цель, живёт ~1 c. */
  private combatArc(from: HTMLElement, to: HTMLElement | null, mine: boolean): void {
    const layer = document.getElementById('aimLayer');
    if (!layer) return;
    const a = Vfx.centerOf(from);
    const b = to ? Vfx.centerOf(to, 0.42) : { x: a.x, y: a.y + (mine ? -140 : 140) };
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.min(96, dist * 0.3);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
    path.setAttribute('class', 'combatArc' + (mine ? ' mine' : ' foe'));
    layer.appendChild(path);
    layer.classList.add('show');
    const len = Math.round(dist * 1.25) + 60;
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    const anim = (path as unknown as { animate?: (k: Keyframe[], o: KeyframeAnimationOptions) => Animation }).animate;
    if (typeof anim === 'function') {
      anim.call(path, [{ strokeDashoffset: String(len) }, { strokeDashoffset: '0' }],
        { duration: 240, easing: 'ease-out', fill: 'forwards' });
    } else {
      path.style.strokeDashoffset = '0';
    }
    window.setTimeout(() => { path.style.transition = 'opacity .35s'; path.style.opacity = '0'; }, 640);
    window.setTimeout(() => {
      path.remove();
      if (!layer.querySelector('path')) layer.classList.remove('show');
    }, 1080);
  }

  /* --------------------- анимация фазы «Битва» --------------------- */

  private async animateCombat(queue: GameEngine['attackQueue']): Promise<void> {
    this.renderPhaseTrack(Phase.Combat);
    await this.banner(PHASE_RU[Phase.Combat]);
    this.setCombatStep(1);
    if (queue.length === 0) {
      this.hideCombatSteps();
      pushLog('Битва: атак не было', 'phase');
      await sleep(200);
      this.combatBusy = false; this.combatSnap = null;
      this.flushPendingStatusFx();
      this.renderStats();
      return;
    }
    await this.combatCore(queue);
    this.setCombatStep(4);   // MTG: end of combat
    setTimeout(() => this.hideCombatSteps(), 900);
    this.combatBusy = false; this.combatSnap = null;
    this.renderAll();
    this.flushPendingStatusFx();
    await sleep(160);
  }

  /** Ядро проигрывания очереди атак: авто-бой и ручные атаки стрелкой. */
  private async combatCore(queue: GameEngine['attackQueue']): Promise<void> {
    this.setCombatStep(2);
    let damageShown = false;
    for (const rec of queue) {
      const attacker = this.unitNodes.get(rec.attackerUid);
      const defender = rec.defenderUid !== undefined ? this.unitNodes.get(rec.defenderUid) : null;
      const heroPanel = rec.hitHero ? (rec.attackerSide === Side.Player ? $('enemyHero') : $('playerHero')) : null;

      // Плавный векторный рывок: замах → удар в цель → возврат (только transform)
      let strikeAnim: Animation | null = null;
      if (attacker) {
        attacker.classList.add('attacking');
        const target: HTMLElement | null = defender ?? heroPanel;
        const a = Vfx.centerOf(attacker);
        const b = target ? Vfx.centerOf(target, 0.42) : { x: a.x, y: a.y + (rec.attackerSide === Side.Player ? -120 : 120) };
        let vx = b.x - a.x, vy = b.y - a.y;
        const dist = Math.hypot(vx, vy) || 1;
        const reach = Math.min(96, dist * 0.55);
        vx = vx / dist * reach; vy = vy / dist * reach;
        strikeAnim = typeof attacker.animate === 'function' ? attacker.animate([
          { transform: 'translate(0,0) scale(1)' },
          { transform: `translate(${(-vx * 0.14).toFixed(1)}px,${(-vy * 0.14).toFixed(1)}px) scale(1.02)`, offset: 0.2 },
          { transform: `translate(${vx.toFixed(1)}px,${vy.toFixed(1)}px) scale(1.09)`, offset: 0.55 },
          { transform: `translate(${(vx * 0.12).toFixed(1)}px,${(vy * 0.12).toFixed(1)}px) scale(1.03)`, offset: 0.78 },
          { transform: 'translate(0,0) scale(1)' },
        ], { duration: 560, easing: 'cubic-bezier(.32,.72,.28,1)' }) : null;
        this.combatArc(attacker, target, rec.attackerSide === Side.Player);
        if (!damageShown) { damageShown = true; this.setCombatStep(3); }   // MTG: combat damage
        await sleep(300); // пик рывка = момент удара
      }
      // вспышка попадания
      if (defender) {
        defender.animate?.(hurtKeys(), { duration: 380 });
        this.floatUnit(rec.defenderUid!, `-${rec.defenderDamage}`, false);
        if (attacker) Vfx.streak(Vfx.centerOf(attacker), Vfx.centerOf(defender), '#fff1cf', 260);
        this.popEl(defender.querySelector('.hp') as HTMLElement | null);
        await Vfx.meleeImpact(Vfx.centerOf(defender), rec.attackerSide === Side.Player ? -90 : 90,
          Math.min(2, 0.7 + rec.defenderDamage * 0.16));
        Sfx.melee(Math.min(2, 0.7 + rec.defenderDamage * 0.16));
        captionFor('melee');
        pushLog(`⚔ «${rec.attackerName}» бьёт «${rec.defenderName}» на ${rec.defenderDamage}`, 'dmg');
      }
      if (heroPanel) {
        heroPanel.classList.remove('hurt'); void heroPanel.offsetWidth; heroPanel.classList.add('hurt');
        setTimeout(() => heroPanel.classList.remove('hurt'), 420);
        if (attacker) Vfx.streak(Vfx.centerOf(attacker), Vfx.centerOf(heroPanel, 0.42), '#ffd08a', 280);
        this.popEl(heroPanel.querySelector('.hbHp') as HTMLElement | null);
        this.floatHero(rec.attackerSide === Side.Player ? Side.Opponent : Side.Player, `-${rec.heroDamage}`, false);
        await Vfx.meleeImpact(Vfx.centerOf(heroPanel), rec.attackerSide === Side.Player ? -90 : 90,
          Math.min(2.4, 0.9 + rec.heroDamage * 0.2));
        Sfx.melee(Math.min(2, 0.8 + rec.heroDamage * 0.18));
        captionFor('heroHit');
        Vfx.vignettePulse(rec.attackerSide === Side.Player ? '#7a3a12' : '#d64545', Math.min(0.8, 0.28 + rec.heroDamage * 0.05));
        pushLog(`⚔ «${rec.attackerName}» наносит ${rec.heroDamage} урона герою`, 'dmg');
      }
      // снапшот шагает вместе с анимацией: HP меняются ровно в момент удара
      if (this.combatSnap) {
        if (rec.defenderUid !== undefined && rec.defenderAfter) {
          this.combatSnap.units.set(rec.defenderUid, rec.defenderAfter.hp);
        }
        if (rec.attackerAfter) this.combatSnap.units.set(rec.attackerUid, rec.attackerAfter.hp);
        if (rec.hitHero) {
          const target = rec.attackerSide === Side.Player ? Side.Opponent : Side.Player;
          this.combatSnap.hp[target] = Math.max(0, this.combatSnap.hp[target] - rec.heroDamage);
        }
        // вампиризм: нанесённый урон лечит героя атакующего в тот же момент
        const healed = rec.lifestealAmount ?? 0;
        if (rec.lifesteal && healed > 0) {
          const cap0 = this.engine!.p(rec.attackerSide).maxHealth;
          this.combatSnap.hp[rec.attackerSide] = Math.min(cap0, this.combatSnap.hp[rec.attackerSide] + healed);
          this.floatHero(rec.attackerSide, `+${healed}`, true);
          Vfx.healFx(Vfx.centerOf(rec.attackerSide === Side.Player ? $('playerHero') : $('enemyHero'), 0.4));
          Sfx.heal();
        }
      }
      if (rec.attackerDamage > 0 && attacker) this.floatUnit(rec.attackerUid, `-${rec.attackerDamage}`, false);
      if (strikeAnim) {
        const fin = (strikeAnim as Animation & { finished?: Promise<Animation> }).finished;
        if (fin && typeof fin.catch === 'function') await fin.catch(() => undefined);
        else await sleep(260);
        strikeAnim.cancel?.();
      } else await sleep(140);
      if (attacker) attacker.classList.remove('attacking');
      if (rec.defenderUid !== undefined) this.flushPendingStatusFx(rec.defenderUid);
      this.flushPendingStatusFx(rec.attackerUid);
      this.renderAll();
      await sleep(70);
    }
  }

  /* ------------------- окно объявления атак (стрелка) ------------------- */
  private beginCombatSnap(): void {
    const e0 = this.engine!;
    this.combatBusy = true;
    this.combatSnap = {
      hp: { [Side.Player]: e0.p(Side.Player).health, [Side.Opponent]: e0.p(Side.Opponent).health },
      units: new Map<number, number>(),
    };
    for (const sd of [Side.Player, Side.Opponent]) {
      for (const c of e0.p(sd).creatures) this.combatSnap.units.set(c.uid, c.health);
    }
  }
  private anyReadyAttacker(): boolean {
    const e = this.engine!;
    return e.p(Side.Player).creatures.some(c => e.canAttack(c));
  }
  private async combatWindow(): Promise<void> {
    this.inCombatWindow = true;
    this.setCombatStep(1);   // MTG: declare attackers
    this.renderPhaseTrack(Phase.Combat);
    await this.banner(PHASE_RU[Phase.Combat]);
    this.beginCombatSnap();
    this.renderAll();
    if (this.anyReadyAttacker()) {
      pushLog('⚔ Фаза боя: клик по своему существу → цель стрелкой (Space или «Авто-бой» — доиграть остальных)', 'phase');
    } else {
      pushLog('Битва: нечем атаковать — стадия пройдёт сама', 'phase');
    }
    this.scheduleWindowAutoClose();
    await new Promise<void>(res => { this.combatWindowDone = res; });
    this.combatWindowDone = null;
    this.cancelAttack();
    this.inCombatWindow = false;
    this.combatBusy = false; this.combatSnap = null;
    this.renderAll();
  }
  private scheduleWindowAutoClose(): void {
    if (!this.anyReadyAttacker()) setTimeout(() => this.closeCombatWindow(), 1100);
  }
  closeCombatWindow(): void { this.setCombatStep(2); this.combatWindowDone?.(); }   // MTG: declare blockers
  /** Пропустить бой без атак — как «не бить» в MTG, остаётся на усмотрение игрока. */
  skipCombat(): void {
    const e = this.engine;
    if (!e || !this.inCombatWindow) return;
    e.manualCombatSkip = true;
    this.cancelAttack();
    this.flashHint('Бой пропущен — ход завершается без атак');
    this.closeCombatWindow();
  }
  cancelAttack(): void {
    if (this.pendingAttack === null) return;
    const n = this.unitNodes.get(this.pendingAttack);
    if (n) n.classList.remove('attacking');
    this.pendingAttack = null;
    this.clearHighlights();
  }
  private attackTargetsFor(uid: number): { uids: number[]; hero: boolean } {
    const e = this.engine!;
    const en = e.p(Side.Opponent);
    const c = e.findCreature(uid);
    const taunts = en.creatures.filter(c => !c.silenced && (c.keywords ?? []).includes(Keyword.Taunt));
    const mustHit = !!(c as any)?.data?.mustHitCreature;
    // герой доступен только если нет провокации и нет спец-правила «бьёт только существо»
    const heroAllowed = taunts.length === 0 && !mustHit;
    const pool = taunts.length ? taunts : en.creatures;
    return { uids: pool.map(c => c.uid), hero: heroAllowed };
  }
  private beginAttack(uid: number): void {
    const e = this.engine!;
    const c = e.findCreature(uid);
    if (!c || c.owner !== Side.Player || !e.canAttack(c)) {
      if (c && c.owner === Side.Player) this.flashHint('Это существо ещё не может атаковать');
      return;
    }
    this.pendingAttack = uid;
    const t = this.attackTargetsFor(uid);
    for (const tu of t.uids) this.unitNodes.get(tu)?.classList.add('targetable');
    if (t.hero) $('enemyHero').classList.add('droppable');
    const node = this.unitNodes.get(uid);
    node?.classList.add('attacking');
    this.aimStart(Vfx.centerOf(node ?? $('playerHero'), 0.5));
    // v2.12.3: явно подсказываем что героя можно бить даже при наличии существ без Провокации
    if (t.hero) {
      this.flashHint(t.uids.length === 0
        ? 'Бейте героя напрямую — клик по портрету противника (ПКМ — отмена)'
        : 'Можете бить героя напрямую даже при существах без Провокации — клик по портрету, или выберите существо (Esc/ПКМ — отмена)');
    } else {
      this.flashHint('Провокация! Обязаны бить существо с ⛨ (герой недоступен) — выберите цель (Esc/ПКМ — отмена)');
    }
  }
  async resolveManualAttack(targetUid?: number, targetHero?: boolean): Promise<void> {
    const e = this.engine!;
    const uid = this.pendingAttack;
    if (uid === null) return;
    this.pendingAttack = null;
    this.clearHighlights();
    const node = this.unitNodes.get(uid);
    if (node) node.classList.remove('attacking');
    const q0 = e.attackQueue.length;
    const ok = e.manualAttack(Side.Player, uid, targetUid, !!targetHero);
    if (!ok) { this.flashHint('Атака отклонена движком'); return; }
    const recs = e.attackQueue.slice(q0);
    await this.combatCore(recs);
    this.renderAll();
    this.scheduleWindowAutoClose();
  }

  /* ------------------- события движка → визуал/лог ------------------- */

  private onEvent(e: GameEvent): void {
    if (this.bossPower && e.type === GameEventType.PhaseChanged && this.engine
      && this.engine.activeSide === Side.Opponent && (e as { phase?: Phase }).phase === Phase.Main
      && this.engine.turn !== this.bossLastTurn && this.engine.result === GameResult.Ongoing) {
      this.bossLastTurn = this.engine.turn;
      this.bossTick();
    }
    if (this.tutLesson) this.tutCheck();
    if (e.type === GameEventType.PhaseChanged && (e as { phase?: Phase }).phase === Phase.Combat) {
      this.beginCombatSnap();
      hideZoom();
    }
    switch (e.type) {
      case GameEventType.CardPlayed:
        if (e.side === Side.Player) this.telemPlayed.push([e.cardId ?? '', e.turn ?? 0]);
        break;
      case GameEventType.Log:
        if (e.text) pushLog(e.text, e.side === Side.Player ? 'you' : e.side === Side.Opponent ? 'foe' : '');
        break;
      case GameEventType.PlayerDamage: {
        const amount = e.value ?? 0;
        if (!this.inCombat()) {
          this.floatHero(e.side!, `-${amount}`, false);
          if (e.text) pushLog(e.text, e.side === Side.Player ? 'you' : 'foe');
        }
        // урон герою — самая тяжёлая обратная связь (VISUAL_STACK, раздел 6, №26)
        Vfx.heroDamageFx(e.side === Side.Player ? 'player' : 'enemy', amount);
        if (e.fromSpell) Vfx.spellImpact(Vfx.centerOf(e.side === Side.Player ? $('playerHero') : $('enemyHero'), 0.4), e.sourceElement as string ?? 'None', Math.min(2, 0.7 + amount * 0.14));
        Sfx.heroHit(amount);
        break;
      }
      case GameEventType.PlayerHeal:
        // во время боя числа лечения рисует animateCombat в момент вампиризма
        if (!this.inCombat()) {
          this.floatHero(e.side!, `+${e.value ?? 0}`, true);
          Vfx.healFx(Vfx.centerOf(e.side === Side.Player ? $('playerHero') : $('enemyHero'), 0.4));
          Sfx.heal();
        }
        break;
      case GameEventType.CreatureDamaged: {
        const node = this.unitNodes.get(e.uid!);
        if (e.absorbed) {
          // щит поглотил удар целиком: синее «🛡 0» вместо красного числа (логика damageCreature)
          if (node) Vfx.shieldFx(Vfx.centerOf(node));
          Sfx.shield();
          this.floatUnit(e.uid!, '🛡 0', false, true);
          if (e.text) pushLog(e.text, 'dmg');
          break;
        }
        if (!this.inCombat()) {
          this.floatUnit(e.uid!, `-${e.value ?? 0}`, false);
          if (e.text) pushLog(e.text, 'dmg');
        }
        if (e.fromSpell && !this.inCombat()) {
          void Vfx.spellImpact(Vfx.centerOf(node), e.sourceElement as string ?? 'None', Math.min(2, 0.7 + (e.value ?? 0) * 0.14));
          Sfx.spell(e.sourceElement as string ?? 'None', this.engine?.db.get(e.sourceCardId ?? '')?.cost ?? 3);
        }
        break;
      }
      case GameEventType.CreatureHealed:
        this.floatUnit(e.uid!, `+${e.value ?? 0}`, true);
        Vfx.motes(Vfx.centerOf(this.unitNodes.get(e.uid!)), '#7fe0a0', 12, 70);
        Sfx.heal();
        break;
      case GameEventType.StatusApplied: {
        const status = String(e.data?.status ?? '');
        if (e.uid !== undefined) {
          this.pendingStatusFx.push({ uid: e.uid, status, text: e.text });
          if (!this.combatBusy) this.flushPendingStatusFx(e.uid);
        }
        if (e.text) pushLog(e.text, 'status');
        captionFor('status');
        break;
      }
      case GameEventType.StatusExpired: {
        const status = String(e.data?.status ?? '');
        if (e.uid !== undefined) {
          this.pendingStatusFx.push({ uid: e.uid, status, text: e.text, expired: true });
          if (!this.combatBusy) this.flushPendingStatusFx(e.uid);
        }
        if (e.text) pushLog(e.text, 'status');
        break;
      }
      case GameEventType.CreatureDeath:
        this.killUnit(e.uid!, e.cardName);
        break;
      case GameEventType.CreatureSummoned: {
        const side = e.side ?? Side.Player;
        if (side === Side.Player) questBump('creatures');
        this.summonedUids.add(e.uid!);
        this.pendingSummonFx.set(e.uid!, {
          side, faction: this.engine?.db.get(e.cardId ?? '')?.faction
            ?? this.engine?.p(side).faction ?? Faction.Neutral,
        });
        Sfx.summon();
        captionFor('summon');
        break;
      }
      case GameEventType.StackPushed:
        this.renderStack();
        if (!this.stackBusy) {
          this.stackBusy = true;
          void this.stackPump().finally(() => { this.stackBusy = false; });
        }
        break;
      case GameEventType.StackResolved:
        this.renderStack();
        break;
      case GameEventType.SpellCast: {
        const card0 = this.engine?.db.get(e.cardId ?? '');
        const card = card0;
        const from = Vfx.centerOf(e.side === Side.Player ? $('playerHero') : $('enemyHero'), 0.42);
        const toNode = e.targetUid !== undefined ? this.unitNodes.get(e.targetUid) : null;
        const to = toNode ? Vfx.centerOf(toNode)
          : Vfx.centerOf(e.side === Side.Player ? $('enemyHero') : $('playerHero'), 0.42);
        this.flashHero(e.side!, false);
        this.ghostCast(e.side!, card, to);
        if (card?.target && card.target !== TargetKind.None) void Vfx.projectile(from, to, Vfx.ELEMENT_VFX[(card.element as string) ?? 'None'] ?? '#d8b45a', 1450);
        Sfx.spell((card?.element as string) ?? 'None', card?.cost ?? 3);
        break;
      }
      case GameEventType.SpellCopied: {
        const card = this.engine?.db.get(e.cardId ?? '');
        const hero = e.side === Side.Player ? $('playerHero') : $('enemyHero');
        this.flashHero(e.side!, true);
        Vfx.echoFx(Vfx.centerOf(hero, 0.42));
        Sfx.echo();
        void card;
        break;
      }
      case GameEventType.RunePlayed: {
        if (e.side === Side.Player) questBump('runes');
        const chip = [...(e.side === Side.Player ? $('playerRunes') : $('enemyRunes')).children].pop() as HTMLElement | undefined;
        Vfx.runeFx(Vfx.centerOf(chip ?? (e.side === Side.Player ? $('playerHero') : $('enemyHero')), 0.5));
        Sfx.rune();
        break;
      }
      case GameEventType.RitualPlaced:
        Vfx.groundDecal(Vfx.centerOf(e.side === Side.Player ? $('playerBoard') : $('enemyBoard')), '#b06cf0', 170, 2200);
        Sfx.ritual();
        break;
      case GameEventType.RitualResolved:
        Vfx.screenFlash('#b06cf0', 0.2, 300);
        Sfx.ritual();
        break;
      case GameEventType.EchoGained:
        pushLog('◈ ' + (e.text ?? 'Получено Эхо-очко'), 'big');
        Vfx.ripple(Vfx.centerOf(e.side === Side.Player ? $('playerHero') : $('enemyHero'), 0.42), '#b06cf0', 2, 130);
        break;
      case GameEventType.EchoSpent:
        pushLog('◈ ' + (e.text ?? 'Эхо-очко потрачено'), 'big');
        Sfx.echo();
        break;
      case GameEventType.CardDrawn:
        if (e.side === Side.Player) {
          Sfx.cardTake();
          const chip = document.getElementById('playerDeck')?.closest('.stat') ?? null;
          this.popEl(chip as HTMLElement | null);
          this.pendingDraw = { cardId: (e as { cardId?: string }).cardId ?? null, at: chip ? chip.getBoundingClientRect() : null };
        } else this.popEl(document.getElementById('enemyDeck')?.closest('.stat'));
        break;
      case GameEventType.CardBurned:
        Sfx.fatigue();
        Vfx.screenFlash('#d64545', 0.16, 260);
        break;
      case GameEventType.TurnStarted:
        this.renderPhaseTrack(Phase.Start);
        break;
      default:
        break;
    }
    if (!this.combatBusy) this.renderStats();
  }

  /** Во время «Битвы» числа урона рисует animateCombat — не дублируем. */
  private inCombat(): boolean { return this.engine?.phase === Phase.Combat; }

  /** Число урона/лечения на независимом слое: переживает перерисовку доски и гибель карты. */
  private floatAt(x: number, y: number, text: string, cls: string): void {
    const layer = $('floatLayer');
    if (!layer) return;
    const f = el('div', ('dmgFloat ' + cls).trim(), text);
    f.style.left = x.toFixed(0) + 'px';
    f.style.top = y.toFixed(0) + 'px';
    layer.appendChild(f);
    setTimeout(() => f.remove(), 900);
  }

  private floatHero(side: Side, text: string, heal: boolean): void {
    const panel = side === Side.Player ? $('playerHero') : $('enemyHero');
    if (!panel) return;
    if (heal) { panel.classList.add('healed'); setTimeout(() => panel.classList.remove('healed'), 520); }
    else { panel.classList.remove('hurt'); void panel.offsetWidth; panel.classList.add('hurt'); setTimeout(() => panel.classList.remove('hurt'), 420); }
    const medal = (panel.querySelector('.medal') ?? panel) as HTMLElement;
    const at = Vfx.centerOf(medal);
    this.floatAt(at.x, at.y - 10, text, (heal ? 'healFloat' : '') + ' heroFloat');
  }

  private floatUnit(uid: number, text: string, heal: boolean, shield = false): void {
    const node = this.unitNodes.get(uid) ?? this.dyingUnits.get(uid);
    if (!node) return;
    const at = Vfx.centerOf(node);
    this.floatAt(at.x, at.y - 6, text, shield ? 'shieldFloat' : heal ? 'healFloat' : '');
    this.dmgFlash.set(uid, Date.now());
    if (!heal && !shield) {
      const hpEl = node.querySelector('.hp');
      hpEl?.classList.add('damaged');
      setTimeout(() => hpEl?.classList.remove('damaged'), 430);
    }
  }

  private flushPendingSummonFx(): void {
    for (const [uid, info] of this.pendingSummonFx) {
      const node = this.unitNodes.get(uid);
      const zone = info.side === Side.Player ? $('playerBoard') : $('enemyBoard');
      Vfx.summonFx(Vfx.centerOf(node ?? zone), paletteOf(info.faction).primary);
      this.pendingSummonFx.delete(uid);
    }
  }

  private flushPendingStatusFx(onlyUid?: number): void {
    const colors: Record<string, string> = {
      Burn: '#ff793c', Poison: '#7be36c', Freeze: '#7bdcff', Shield: '#8ecbff',
      Fury: '#ffd66e', Silence: '#c6a8ed',
    };
    const remain: typeof this.pendingStatusFx = [];
    for (const info of this.pendingStatusFx) {
      if (onlyUid !== undefined && info.uid !== onlyUid) { remain.push(info); continue; }
      const node = this.unitNodes.get(info.uid) ?? this.dyingUnits.get(info.uid);
      if (!node) {
        if (this.engine?.findCreature(info.uid)) remain.push(info);
        continue;
      }
      const at = Vfx.centerOf(node);
      const color = info.expired ? '#b7b7c4' : (colors[info.status] ?? '#d8b45a');
      Vfx.ripple(at, color, info.expired ? 1 : 2, 135);
      if (!info.expired) Vfx.motes(at, color, 8, 42);
      if (this.fxOk()) node.animate?.([
        { filter: 'brightness(1) saturate(1)' },
        { filter: `brightness(1.45) saturate(1.35) drop-shadow(0 0 9px ${color})` },
        { filter: 'brightness(1) saturate(1)' },
      ], { duration: 440, easing: 'ease-out' });
    }
    this.pendingStatusFx = remain;
  }

  private killUnit(uid: number, name?: string): void {
    const node = this.unitNodes.get(uid) ?? this.dyingUnits.get(uid);
    pushLog(`✝ «${name ?? node?.querySelector('.uname')?.textContent ?? 'существо'}» погибает`, 'dmg');
    if (!node) { this.pendingSummonFx.delete(uid); return; }
    if (this.dyingUnits.has(uid)) return;

    // Поле перерисовывается сразу после SBA, поэтому растворяем фиксированную
    // копию карты на независимом слое, а не DOM-узел, который renderBoard удалит.
    const rect = node.getBoundingClientRect();
    const corpse = node.cloneNode(true) as HTMLElement;
    corpse.classList.remove('attacking', 'targetable');
    corpse.classList.add('deathGhost');
    Object.assign(corpse.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, margin: '0',
      zIndex: '2', pointerEvents: 'none', transformOrigin: 'center center',
    });
    const layer = $('floatLayer') ?? document.body;
    layer.appendChild(corpse);
    node.style.visibility = 'hidden';
    this.dyingUnits.set(uid, corpse);

    const c = this.engine?.findCreature(uid);
    const card = this.engine?.db.get(node.dataset.cardId ?? '');
    const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const ownerSide = node.dataset.side === String(Side.Player) ? Side.Player : Side.Opponent;
    const hero = Vfx.centerOf(ownerSide === Side.Player ? $('playerHero') : $('enemyHero'), 0.42);
    // «Кровавая жатва» Некрусов: душа летит к герою владельца (VISUAL_STACK №14–15)
    Vfx.deathFx(at, hero, paletteOf((c?.faction ?? card?.faction) ?? Faction.Neutral).primary);
    Sfx.death();
    captionFor('death');
    Vfx.dissolve(corpse, 620);
    setTimeout(() => { if (this.dyingUnits.get(uid) === corpse) this.dyingUnits.delete(uid); }, 700);
  }

  private flashHero(side: Side, echo: boolean): void {
    const panel = side === Side.Player ? $('playerHero') : $('enemyHero');
    panel?.animate?.(
      [{ filter: 'brightness(1)' }, { filter: `brightness(${echo ? 2.2 : 1.75}) saturate(1.5)` }, { filter: 'brightness(1)' }],
      { duration: 460 },
    );
  }

  /* ------------------------------ рендер ------------------------------ */

  /* ------- плавное движение: FLIP-сдвиги поля/руки + полёт добора ------- */
  private fxOk(): boolean {
    if (document.body.classList.contains('fxLite')) return false;
    const mm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    return !(mm && mm.matches);
  }
  private popEl(el: HTMLElement | null | undefined): void {
    if (!el || !this.fxOk()) return;
    el.animate?.(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.45)', offset: .35 }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'cubic-bezier(.3,.8,.3,1)' });
  }
  private rectSnap(): Map<string, DOMRect> {
    const m = new Map<string, DOMRect>();
    for (const [uid, n] of this.unitNodes) if (!n.classList.contains('attacking')) m.set('u' + uid, n.getBoundingClientRect());
    const occ: Record<string, number> = {};
    for (const c of Array.from($('hand').children)) {
      const el = c as HTMLElement; const cid = el.dataset.cardId ?? '?';
      m.set('h:' + cid + ':' + (occ[cid] = (occ[cid] ?? 0) + 1), el.getBoundingClientRect());
    }
    return m;
  }
  private flipFrom(prev: Map<string, DOMRect>): void {
    const move = (el: HTMLElement, key: string, base: string) => {
      if (el.classList.contains('attacking') || el.classList.contains('summoning') || el.dataset.fly) return;
      if (base === '' && el.style.transform) return;
      const o = prev.get(key); if (!o) return;
      const n = el.getBoundingClientRect();
      const dx = o.left - n.left, dy = o.top - n.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      if (typeof el.animate !== 'function') return;
      el.animate([
        { transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) ${base}`.trim() },
        { transform: base || 'translate(0,0)' },
      ], { duration: 260, easing: 'cubic-bezier(.22,.9,.32,1)' });
    };
    for (const [uid, n] of this.unitNodes) move(n, 'u' + uid, '');
    const occ: Record<string, number> = {};
    for (const c of Array.from($('hand').children)) {
      const el = c as HTMLElement; const cid = el.dataset.cardId ?? '?';
      move(el, 'h:' + cid + ':' + (occ[cid] = (occ[cid] ?? 0) + 1), el.style.transform || '');
    }
  }
  private consumeDrawFly(): void {
    const pd = this.pendingDraw; this.pendingDraw = null;
    if (!pd || !pd.at || !this.fxOk()) return;
    const matches = Array.from($('hand').children)
      .filter(c => !pd.cardId || (c as HTMLElement).dataset.cardId === pd.cardId);
    const node = matches[matches.length - 1] as HTMLElement | undefined;
    if (!node || node.dataset.fly || typeof node.animate !== 'function') return;
    node.dataset.fly = '1';
    const n = node.getBoundingClientRect();
    const dx = pd.at.left + pd.at.width / 2 - (n.left + n.width / 2);
    const dy = pd.at.top + pd.at.height / 2 - (n.top + n.height / 2);
    const base = node.style.transform || '';
    node.animate([
      { transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.5) rotate(9deg) rotateX(30deg) ${base}`.trim(), opacity: .25 },
      { transform: `translate(${(dx * 0.28).toFixed(1)}px,${(dy * 0.28).toFixed(1)}px) scale(.86) rotate(3deg) rotateX(10deg) ${base}`.trim(), opacity: .9, offset: .62 },
      { transform: base || 'translate(0,0) scale(1)', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.22,.9,.28,1)' });
    setTimeout(() => { delete node.dataset.fly; }, 570);
  }
  private ghostCast(side: Side, card: CardData | undefined, to: { x: number; y: number }): void {
    if (!this.fxOk() || !card) return;
    const host = document.getElementById('vfxLayer') ?? document.body;
    const col = colorOf(card.faction);
    const from = Vfx.centerOf(side === Side.Player ? $('hand') : $('enemyHero'), side === Side.Player ? 0.5 : 0.42);
    const g = document.createElement('div');
    g.style.cssText = `position:fixed;left:0;top:0;width:74px;height:104px;margin:-52px 0 0 -37px;border-radius:6px;
      pointer-events:none;background:linear-gradient(160deg,${col.primary},#12141d 70%);border:1px solid ${col.accent};
      box-shadow:0 6px 18px rgba(0,0,0,.5);transform:translate(${from.x}px,${from.y}px) scale(.8)`;
    g.innerHTML = `<div style="position:absolute;inset:6px;border:1px solid ${col.secondary}55;border-radius:4px;display:flex;
      align-items:center;justify-content:center;font-size:1.4rem;color:${col.secondary}">${FACTION_SIGIL[card.faction] ?? '✦'}</div>`;
    host.appendChild(g);
    if (typeof g.animate !== 'function') { g.remove(); return; }
    const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 70 };
    g.animate([
      { transform: `translate(${from.x}px,${from.y}px) scale(.8) rotate(${side === Side.Player ? -6 : 6}deg)`, opacity: .95 },
      { transform: `translate(${mid.x}px,${mid.y}px) scale(1.05) rotate(0deg)`, opacity: 1, offset: .5 },
      { transform: `translate(${to.x}px,${to.y}px) scale(.55)`, opacity: 0 },
    ], { duration: 520, easing: 'cubic-bezier(.35,.6,.25,1)' }).onfinish = () => g.remove();
  }

  private renderInstantDock(): void {
    const e = this.engine;
    const dock = $('instantDock');
    if (!dock || !e) return;
    const open = e.instantWindow === Side.Player;
    dock.classList.toggle('hidden', !open);
    if (open) {
      const lbl = dock.querySelector('#instantLabel');
      if (lbl) lbl.textContent = this.instantLabel || 'ход противника';
    }
  }

  renderAll(): void {
    if (!this.engine) return;
    if (lastZoomEl && !lastZoomEl.isConnected) hideZoom();
    const prev = this.fxOk() ? this.rectSnap() : null;
    try {
      this.unitNodes = new Map<number, HTMLElement>();
      this.renderStats();
    this.renderBoard(Side.Opponent, $('enemyBoard'), 'войска противника');
    this.renderBoard(Side.Player, $('playerBoard'), 'ваши войска');
    this.flushPendingSummonFx();
    if (!this.combatBusy) this.flushPendingStatusFx();
    this.renderRunes(Side.Opponent, $('enemyRunes'));
    this.renderRunes(Side.Player, $('playerRunes'));
    this.renderHand();
      this.renderPhaseTrack(this.engine.phase);
      this.updateButtons();
      this.renderInstantDock();
      if (prev) { this.flipFrom(prev); this.consumeDrawFly(); }
    } catch (err) { reportFatal('render', err); }
  }

  private renderStats(): void {
    const e = this.engine!;
    const p = e.p(Side.Player), o = e.p(Side.Opponent);
    const cap = (x: number): string => String(Math.min(10, x));
    const snapHp = this.combatBusy && this.combatSnap ? this.combatSnap.hp : null;
    $('playerHp').textContent = String(snapHp ? snapHp[Side.Player] : p.health);
    $('playerMana').textContent = `${p.mana}/${cap(p.maxMana + p.bonusMana)}`;
    if (p.mana > this.prevMana) {
      const st = $('playerMana').closest('.stat') as HTMLElement | null;
      if (st) { st.classList.remove('manaUp'); void st.offsetWidth; st.classList.add('manaUp');
        setTimeout(() => st.classList.remove('manaUp'), 620); }
    }
    this.prevMana = p.mana;
    $('playerDeck').textContent = String(p.deck.length);
    $('playerEcho').textContent = String(p.echoPoints);
    $('playerGrave').textContent = String(p.graveyard.length);
    this.renderGraveZone(Side.Player, $('playerGraveZone'), p.graveyard.length);
    $('enemyHp').textContent = String(snapHp ? snapHp[Side.Opponent] : o.health);
    $('enemyMana').textContent = `${o.mana}/${cap(o.maxMana + o.bonusMana)}`;
    $('enemyHand').textContent = String(o.hand.length);
    const backs = $('enemyBacks');
    const want = Math.min(12, o.hand.length);
    if (backs.children.length !== want) {
      backs.innerHTML = '';
      for (let i = 0; i < want; i++) backs.appendChild(el('div', 'cardback'));
    }
    $('enemyDeck').textContent = String(o.deck.length);
    $('enemyGrave').textContent = String(o.graveyard.length);
    this.renderGraveZone(Side.Opponent, $('enemyGraveZone'), o.graveyard.length);
    $('enemyEcho').textContent = String(o.echoPoints);
    $('turnNo').textContent = String(Math.max(1, e.turn));
  }

  private renderBoard(side: Side, host: HTMLElement, label: string): void {
    host.innerHTML = `<span class="zoneLabel">${label}</span>`;
    const pl = this.engine!.p(side);
    for (const c of pl.creatures) {
      const node = this.renderUnit(c, pl.creatures.indexOf(c));
      host.appendChild(node);
      this.unitNodes.set(c.uid, node);
      if (this.summonedUids.has(c.uid)) { node.classList.add('summoning'); this.summonedUids.delete(c.uid); }
    }
    if (pl.creatures.length === 0) {
      host.appendChild(el('span', '', '<span style="font-size:.66rem;color:#3f4457;letter-spacing:.14em">пусто</span>'));
    }
  }

  /** HP юнита для отрисовки: во время анимации боя — из снапшота по шагам атак. */
  private displayHpOf(uid: number, fallback: number): number {
    if (this.combatBusy && this.combatSnap && this.combatSnap.units.has(uid)) {
      return this.combatSnap.units.get(uid)!;
    }
    return fallback;
  }

  private renderUnit(c: EntityCreature, idx = 0): HTMLElement {
    const card = c.data;
    const node = el('div', 'unit f-' + c.faction);
    node.dataset.uid = String(c.uid);
    node.dataset.cardId = c.cardId; // FIX v2.7: полевая карта участвует в глобальном zoom-ховере справа (как рука/библиотека)
    {
      const PIPS: Record<string, string> = { Taunt: '⛨', Lifesteal: '♥', Trample: '⇉', Windfury: '≋', Unblockable: '◌' };
      const card = this.engine?.db.get(c.cardId);
      const pips = (card?.keywords ?? []).map(k => PIPS[k] ? `<span class="pip" title="${kwName(k)}">${PIPS[k]}</span>` : '').join('');
      if (pips) node.insertAdjacentHTML('beforeend', `<div class="pips">${pips}</div>`);
      const FICO: Record<string, string> = { Aurites: '✦', Necrus: '☠', Terramorph: '⛰', Pyromancer: '♨', Ethereal: '☾', Neutral: '◈' };
      node.insertAdjacentHTML('afterbegin', `<span class="facIco" title="${factionName(c.faction as string)}">${FICO[c.faction as string] ?? '◈'}</span>`);
    }
    node.dataset.side = String(c.owner);
    const mine = c.owner === Side.Player;
    const canAtk = mine && this.engine!.canAttack(c);
    const maxAttacks = c.keywords.includes(Keyword.Windfury) ? 2 : 1;
    const attacksRemaining = Math.max(0, maxAttacks - c.attacksThisTurn);
    const attackMarkTitle = c.attacksThisTurn > 0
      ? `Буря: может атаковать ещё ${attacksRemaining} раз`
      : 'Готово к атаке';
    const attackMark = canAtk
      ? `<span class="attackReadyMark${c.attacksThisTurn > 0 ? ' again' : ''}" title="${esc(attackMarkTitle)}" aria-label="${esc(attackMarkTitle)}">${
        c.attacksThisTurn > 0 ? `Ещё ${attacksRemaining}` : '⚔'
      }</span>`
      : '';
    if (canAtk) node.classList.add('ready');
    if (mine && !canAtk) node.classList.add('exhausted');
    if (c.attacksThisTurn > 0) node.classList.add('tapped');   // как в MTG: атаковало — тапнуто
    const nowTap = c.attacksThisTurn > 0;
    const wasTap = this.prevTapped.get(c.uid);
    if (wasTap === true && !nowTap) {
      // волна антапа в шаг Untap: задержка по индексу, как разворот земель в MTG
      node.classList.add('untapAnim');
      const ub = node.querySelector('.ubody') as HTMLElement | null;
      if (ub) {
        ub.style.transitionDelay = `${(idx % 7) * 45}ms`;
        setTimeout(() => { ub.style.transitionDelay = ''; }, 720);
      }
    } else if (wasTap === false && nowTap) {
      node.classList.add('tapAnim');
    }
    this.prevTapped.set(c.uid, nowTap);
    if (c.frozen) node.classList.add('frozenUnit');
    if (c.unblockableThisTurn) node.classList.add('unblockable');
    if (c.statuses.some(st => st.type === StatusType.Shield)) node.classList.add('shielded');
    if ((card.keywords ?? []).includes(Keyword.Taunt)) node.classList.add('taunt');

    const badges: string[] = [];
    for (const s of c.statuses) {
      const b = STATUS_BADGE[s.type as StatusType];
      if (!b) continue;
      const duration = s.turnsLeft < 0 ? 'постоянно' : `${s.turnsLeft} ход.`;
      badges.push(`<span class="badge ${b.cls}" title="${b.title} · ${duration}">${b.ico}${s.value > 1 ? s.value : ''}</span>`);
    }
    for (const kw of c.keywords ?? []) {
      const b = KW_BADGE[kw as Keyword];
      if (b) badges.push(`<span class="badge kw" title="${b.title}">${b.ico}</span>`);
    }

    node.innerHTML = `
      <div class="badges">${badges.join('')}</div>
      <div class="ubody">
        <div class="uart">${artSvg(card, 104, 134)}</div>
        <div class="uname">${cardName(card)}</div>
        <div class="stats"><span class="atk">${c.attack}</span><span class="hp${c.health <= 0 ? ' lethal' : ''}">${Math.max(0, this.displayHpOf(c.uid, c.health))}</span></div>
      </div>${attackMark}`;
    const ft = this.dmgFlash.get(c.uid);
    if (ft && Date.now() - ft < 500) {
      const hpEl = node.querySelector('.hp');
      hpEl?.classList.add('damaged');
      setTimeout(() => hpEl?.classList.remove('damaged'), 430);
    }
    // как в Arena: описание карты поля — в доке справа, без тултипа у курсора
    node.addEventListener('mouseenter', ev => {
      showZoom(card, ev.clientX, ev.clientY, 'right'); // v2.6: обе стороны стола — справа, как рука
    });
    node.addEventListener('mouseleave', () => { hideZoom(); });
    node.addEventListener('click', () => this.onUnitClick(c.uid, c.owner));
    return node;
  }

  private renderRunes(side: Side, host: HTMLElement): void {
    host.innerHTML = '';
    const pl = this.engine!.p(side);
    for (const r of pl.runes) {
      const chip = el('div', 'runeChip');
      chip.innerHTML = `<span class="sig">${FACTION_SIGIL[r.faction]}</span><span>${r.name}</span>` +
        (r.turnsLeft > 0 ? `<span style="color:var(--muted)">· ${r.turnsLeft}⌛</span>` : '<span style="color:var(--gold-dim)">· ∞</span>');
      chip.addEventListener('mouseenter', ev => showTooltip(r.data, ev.clientX, ev.clientY));
      chip.addEventListener('mouseleave', hideTooltip);
      host.appendChild(chip);
    }
    for (const rt of pl.rituals) {
      const chip = el('div', 'runeChip ritualChip');
      chip.innerHTML = `<span class="sig">⧗</span><span>${rt.name}</span><span style="color:var(--muted)">· ритуал ${rt.turnsLeft}⌛</span>`;
      chip.addEventListener('mouseenter', ev => showTooltip(rt.data, ev.clientX, ev.clientY));
      chip.addEventListener('mouseleave', hideTooltip);
      host.appendChild(chip);
    }
    if (pl.runes.length === 0 && pl.rituals.length === 0) {
      host.appendChild(el('span', '', '<span style="font-size:.6rem;color:#3f4457;letter-spacing:.14em">руны не установлены</span>'));
    }
  }

  /* --------------------- рука: веер + drag&drop --------------------- */

  private renderHand(): void {
    const host = $('hand');
    host.innerHTML = '';
    this.handNodes = [];
    const e = this.engine!;
    const pl = e.p(Side.Player);
    const n = pl.hand.length;
    if (n === 0) {
      host.appendChild(el('div', '', '<span style="font-size:.7rem;color:#3f4457;letter-spacing:.14em">рука пуста</span>'));
      return;
    }
    const myMain = e.activeSide === Side.Player && e.phase === Phase.Main && !this.busy && this.running;
    const maxAngle = Math.min(12, n * 2.1);
    // шаг веера масштабируется от фактической ширины карты (адаптив)
    const cw = Math.min(196, Math.max(118, window.innerWidth * 0.125));
    const overlap = Math.round(Math.max(-cw * 0.44, cw * 0.8 - n * cw * 0.12));
    pl.hand.forEach((cid: string, i: number) => {
      const card = db.get(cid);
      if (!card) return;
      const node = renderCard(card);
      const t = n === 1 ? 0.5 : i / (n - 1);
      const angle = (t - 0.5) * maxAngle;
      const lift = -Math.cos((t - 0.5) * Math.PI) * 10;
      const base = `rotate(${angle.toFixed(2)}deg) translateY(${lift.toFixed(1)}px)`;
      node.style.transform = base;
      node.style.marginLeft = i === 0 ? '0' : `${overlap}px`;
      node.style.zIndex = String(10 + i);
      const chk = e.canPlay(Side.Player, i);
      const isInstant = card.type === CardType.Spell && card.subtype === SpellSubtype.Instant;
      // MTG: мгновенные подсвечиваются даже в ход противника, если хватает маны
      const playable = chk.ok;
      if (!playable) {
        node.classList.add('unplayable');
        const why = chk.reason ?? (isInstant ? 'Недостаточно маны' : (!myMain ? 'Не ваша основная фаза' : 'Нельзя разыграть'));
        node.appendChild(el('div', 'whyNot', why));
        node.title = why;
      } else if (isInstant && !myMain) {
        node.classList.add('instantReady');
        node.title = '⚡ Мгновенное — можно разыграть в любой момент (приоритет)';
      }
      node.dataset.handIndex = String(i);
      node.addEventListener('mouseenter', ev => {
        if (node.classList.contains('dragging')) return;
        node.style.zIndex = '60';
        node.classList.add('tilting');
        this.tiltCard(node, ev);
        showZoom(card, ev.clientX, ev.clientY, 'right');
        Sfx.uiHover();
      });
      node.addEventListener('mousemove', ev => {
        if (!node.classList.contains('dragging')) this.tiltCard(node, ev);
      });
      node.addEventListener('mouseleave', () => {
        hideZoom();
        node.classList.remove('tilting');
        node.style.setProperty('--rx', '0deg');
        node.style.setProperty('--ry', '0deg');
        if (!node.classList.contains('dragging')) { node.style.transform = base; node.style.zIndex = String(10 + i); }
      });
      this.attachDrag(node, i, card, base, chk.reason ?? '');
      host.appendChild(node);
      this.handNodes.push(node);
    });
  }

  /**
   * 3D-наклон карты и спекулярный блик, следующий за курсором.
   * В Unity это All In 1 Sprite Shader: specular highlight + hover-поворот
   * (docs/VISUAL_STACK.md, раздел 5).
   */
  private tiltCard(node: HTMLElement, ev: MouseEvent): void {
    const r = node.getBoundingClientRect();
    if (!r.width) return;
    const px = (ev.clientX - r.left) / r.width;
    const py = (ev.clientY - r.top) / r.height;
    const ry = ((px - 0.5) * 20).toFixed(2);
    const rx = ((0.5 - py) * 15).toFixed(2);
    node.style.setProperty('--rx', rx + 'deg');
    node.style.setProperty('--ry', ry + 'deg');
    node.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
    node.style.setProperty('--my', (py * 100).toFixed(1) + '%');
    node.style.transform = `perspective(760px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-32px) scale(1.22)`;
  }

  private attachDrag(node: HTMLElement, index: number, card: CardData, base: string, reason: string): void {
    let sx = 0, sy = 0, dragging = false;
    const ghost = el('div', 'card flying');

    const onMove = (ev: PointerEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 10) return;
      if (!dragging) {
        dragging = true;
        hideTooltip();
        hideZoom();
        node.classList.add('dragging');
        node.style.transform = base;
        ghost.innerHTML = node.innerHTML;
        ghost.style.width = '152px'; ghost.style.height = '213px';
        document.body.appendChild(ghost);
        this.highlightTargets(card);
        this.aimStart(Vfx.centerOf(node));
      }
      ghost.style.left = (ev.clientX - 56) + 'px';
      ghost.style.top = (ev.clientY - 79) + 'px';
      ghost.style.transform = 'rotate(-3deg) scale(1.06)';
    };

    const onUp = async (ev: PointerEvent): Promise<void> => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      if (!dragging) return;                       // это был «тап» — его обработает слушатель click
      dragging = false;
      ghost.remove();
      node.classList.remove('dragging');
      this.clearHighlights();
      const drop = this.resolveDrop(ev.clientX, ev.clientY, card);
      if (drop.ok) await this.playCard(index, drop.uid, drop.side);
      else this.flashHint(drop.reason ?? 'Недопустимая цель — карта вернулась в руку');
      this.renderAll();
    };

    // Тап/клик по карте = розыгрыш (или переход в режим выбора цели). MTG: мгновенные — в любой момент.
    node.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      if (this.busy || !this.running) return;
      const e0 = this.engine!;
      const isInstant0 = card.type === CardType.Spell && card.subtype === SpellSubtype.Instant;
      if (!isInstant0 && (e0.activeSide !== Side.Player || e0.phase !== Phase.Main)) return;
      if (!isInstant0 && e0.instantWindow !== null && e0.instantWindow !== Side.Player) return;
      // если это был настоящий перенос (указатель уехал далеко) — клик не разыгрываем
      if (sx || sy) {
        const moved = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (moved > 12) { sx = 0; sy = 0; return; }
      }
      void this.onClickCard(index, card, reason);
    });

    node.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (this.busy || !this.running) return;
      const e = this.engine!;
      const isInstantDown = card.type === CardType.Spell && card.subtype === SpellSubtype.Instant;
      if (!isInstantDown && (e.activeSide !== Side.Player || e.phase !== Phase.Main)) return;
      if (!isInstantDown && e.instantWindow !== null && e.instantWindow !== Side.Player) return;
      const chk = e.canPlay(Side.Player, index);
      if (!chk.ok) { this.flashHint(chk.reason ?? reason ?? 'Нельзя разыграть'); this.manaDeny(chk.reason); return; }
      sx = ev.clientX; sy = ev.clientY; dragging = false;
      node.setPointerCapture(ev.pointerId);
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }

  aimStart(from: { x: number; y: number }): void {
    this.aimFrom = from;
    $('aimLayer').classList.add('show');
  }
  aimStop(): void {
    this.aimFrom = null;
    const l = $('aimLayer');
    l.classList.remove('show');
    l.querySelector('path[marker-end]')?.setAttribute('d', '');
  }
  updateAim(ev: MouseEvent, host: HTMLElement | null): void {
    if (!this.aimFrom) return;
    const snap = (ev.target as HTMLElement | null)?.closest?.('.unit.targetable, .heroBar.droppable') as HTMLElement | null;
    const to = snap
      ? Vfx.centerOf(snap, snap.classList.contains('heroBar') ? 0.42 : 0.5)
      : (host && (host.classList.contains('targetable')) ? Vfx.centerOf(host) : { x: ev.clientX, y: ev.clientY });
    const from = this.aimFrom;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (from.x + to.x) / 2 - dy / len * 42;
    const cy = (from.y + to.y) / 2 + dx / len * 42;
    $('aimLayer').querySelector('path[marker-end]')?.setAttribute('d',
      `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`);
  }

  /* Авто-ход: если в Main нечем ходить — ход передаётся сам (ТЗ: фазы без лишних кликов) */
  private autoTurnPlan(): void {
    const e = this.engine; if (!e) return;
    if (!this.autoTurnEnabled) {
      if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
      this.autoToken = '';
      return;
    }
    const myMain = this.running && !this.busy && e.activeSide === Side.Player
      && e.phase === Phase.Main && !this.pendingTarget;
    let idle = false;
    if (myMain) {
      const pl = e.p(Side.Player);
      idle = !e.canUseEcho(Side.Player).ok && pl.hand.every((id, i) => !e.canPlay(Side.Player, i).ok);
    }
    if (!idle) { this.autoToken = ''; this.autoDeadline = 0; return; }
    const pl = e.p(Side.Player);
    const token = `${pl.hand.join(',')}|${pl.mana}|${e.turn}`;
    if (token !== this.autoToken) { this.autoToken = token; this.autoDeadline = Date.now() + 2600; }
    if (this.autoTimer === null) this.autoTimer = window.setInterval(() => this.autoTurnFire(), 400);
  }
  private autoTurnFire(): void {
    const e = this.engine;
    const myMain = e && this.running && !this.busy && e.activeSide === Side.Player
      && e.phase === Phase.Main && !this.pendingTarget;
    if (!myMain || !this.autoToken) {
      if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
      return;
    }
    const left = this.autoDeadline - Date.now();
    if (left > 0) {
      const h = $('actionHint');
      if (!h.style.color) h.textContent = `Нечего делать — ход завершится сам через ${Math.ceil(left / 1000)} с…`;
      return;
    }
    if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
    this.autoToken = '';
    pushLog('↻ Авто: нет действий — ход передан', 'phase');
    this.endTurnNow();
  }

  /** Аватар героя из папки художника art_raw/heroes/<Faction>/: тянется и масштабируется оттуда. */
  private setPortrait(hostId: string, faction: Faction): void {
    const host = $(hostId);
    if (!host) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = `/heroes/${encodeURIComponent(faction)}`;
    img.addEventListener('error', () => { host.innerHTML = `<span class="sigFall">${FACTION_SIGIL[faction] ?? '✦'}</span>`; });
    host.innerHTML = '';
    host.appendChild(img);
  }

  private renderGraveZone(side: Side, host: HTMLElement, count: number): void {
    // стопка рубашек вверх в размер карты, как в MTG: толщина растёт до 3 слоёв
    const want = Math.min(3, count);
    if (host.querySelectorAll('.cardback').length !== want) {
      host.innerHTML = Array.from({ length: want }, () => '<div class="cardback"></div>').join('')
        + `<span class="gcount">${count}</span>`;
    } else {
      const gc = host.querySelector('.gcount');
      if (gc) gc.textContent = String(count);
    }
  }

  openGrave(side: Side): void {
    const e = this.engine; if (!e) return;
    hideZoom(); hideTooltip();
    const ids = e.p(side).graveyard;
    $('graveTitle').textContent = `${side === Side.Player ? 'Ваше кладбище' : 'Кладбище противника'} · ${ids.length}`;
    const list = $('graveList'); list.innerHTML = '';
    if (ids.length === 0) list.innerHTML = '<span style="color:var(--muted)">Пусто. Ещё никто не погиб.</span>';
    for (const id of ids) {
      const c = db.get(id); if (!c) continue;
      const clean = renderCard(c).cloneNode(true) as HTMLElement;   // без drag-слушателей
      clean.addEventListener('mouseenter', ev => showTooltip(c, ev.clientX, ev.clientY));
      clean.addEventListener('mouseleave', hideTooltip);
      list.appendChild(clean);
    }
    $('graveModal').classList.remove('hidden');
  }

  private highlightTargets(card: CardData): void {
    const e = this.engine!;
    if (card.target === TargetKind.None) {
      if (card.type === CardType.Spell) $('enemyBoard').classList.add('droppable');
      else $('playerBoard').classList.add('droppable');
      return;
    }
    for (const t of e.validTargets(Side.Player, card)) {
      if (t.uid !== undefined) this.unitNodes.get(t.uid)?.classList.add('targetable');
      else if (t.side !== undefined) (t.side === Side.Player ? $('playerHero') : $('enemyHero')).classList.add('droppable');
    }
  }

  private clearHighlights(): void {
    this.aimStop();
    document.querySelectorAll('.targetable').forEach(x => x.classList.remove('targetable'));
    document.querySelectorAll('.droppable').forEach(x => x.classList.remove('droppable'));
    document.querySelectorAll('.unit').forEach(x => ((x as HTMLElement).style.outline = ''));
  }

  private resolveDrop(x: number, y: number, card: CardData): { ok: boolean; uid?: number; side?: Side; reason?: string } {
    const e = this.engine!;
    document.querySelectorAll('.unit').forEach(u => ((u as HTMLElement).style.outline = ''));
    const under = document.elementFromPoint(x, y);
    if (card.target === TargetKind.None) return { ok: true };

    const unit = under?.closest?.('.unit') as HTMLElement | null;
    if (unit && unit.classList.contains('targetable')) {
      unit.style.outline = '2px solid var(--ok)';
      return { ok: true, uid: Number(unit.dataset.uid), side: Number(unit.dataset.side) as Side };
    }
    const hero = under?.closest?.('.heroPanel') as HTMLElement | null;
    if (hero && hero.classList.contains('droppable')) {
      return { ok: true, side: hero.id === 'playerHero' ? Side.Player : Side.Opponent };
    }
    const valid = e.validTargets(Side.Player, card);
    if (valid.length === 0) return { ok: false, reason: 'Нет допустимых целей' };
    return { ok: false, reason: `Нужна цель: ${valid.slice(0, 3).map(v => v.label).join(', ')}${valid.length > 3 ? '…' : ''}` };
  }

  /**
   * Разыграть карту из руки по индексу — тот же путь, что и клик мышью
   * (нужен для горячих клавиш 1–9 и для автоматизации).
   */
  playHandIndex(index: number): void {
    const e = this.engine;
    if (!e || !this.running || this.busy) return;
    const cardPeek = db.get(e.p(Side.Player).hand[index] ?? '');
    const isInstantKey = !!cardPeek && cardPeek.type === CardType.Spell && cardPeek.subtype === SpellSubtype.Instant;
    if (!isInstantKey && (e.activeSide !== Side.Player || e.phase !== Phase.Main)) {
      this.flashHint('Сейчас не ваша основная фаза — мгновенные (⚡) можно играть в любой момент');
      return;
    }
    const pl = e.p(Side.Player);
    if (index < 0 || index >= pl.hand.length) return;
    const card = db.get(pl.hand[index]);
    if (!card) return;
    const node = this.handNodes[index];
    if (node) {
      hideZoom();
      hideTooltip();
      // короткая подсветка: видно, какую карту взяла горячая клавиша
      node.classList.add('tilting');
      node.style.zIndex = '60';
      window.setTimeout(() => { node.classList.remove('tilting'); node.style.zIndex = ''; }, 260);
    }
    const chk = e.canPlay(Side.Player, index);
    void this.onClickCard(index, card, chk.reason ?? '');
  }

  private async onClickCard(index: number, card: CardData, reason: string): Promise<void> {
    const e = this.engine!;
    const chk = e.canPlay(Side.Player, index);
    if (!chk.ok) { this.flashHint(chk.reason ?? reason ?? 'Нельзя разыграть'); return; }
    if (card.target === TargetKind.None || !chk.needsTarget) { await this.playCard(index); return; }

    const valid = e.validTargets(Side.Player, card);
    if (valid.length === 0) { await this.playCard(index); return; }
    this.flashHint(`Выберите цель для «${card.name}»… (Esc / ПКМ — отмена, цель — своя или чужая)`);
    this.highlightTargets(card);
    this.aimStart(this.handNodes[index] ? Vfx.centerOf(this.handNodes[index]) : Vfx.centerOf($('playerHero'), 0.42));
    const pick = await new Promise<{ uid?: number; side?: Side } | null>(resolve => {
      const done = (uid: number | null, side: Side | null): void => {
        document.removeEventListener('keydown', onKey);
        resolve(uid === null && side === null ? null : { uid: uid ?? undefined, side: side ?? undefined });
      };
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') done(null, null); };
      document.addEventListener('keydown', onKey);
      this.pendingTarget = done;
      setTimeout(() => { if (this.pendingTarget === done) this.pendingTarget = null; }, 60000);
    });
    this.pendingTarget = null;
    this.clearHighlights();
    this.aimStop();
    if (!pick) { this.flashHint('Розыгрыш отменён'); return; }
    await this.playCard(index, pick.uid, pick.side);
  }

  private onUnitClick(uid: number, side: Side): void {
    if (this.pendingTarget) {
      const node = this.unitNodes.get(uid);
      if (node?.classList.contains('targetable')) this.pendingTarget(uid, side);
      return;
    }
    if (this.pendingAttack !== null) {
      if (side === Side.Opponent && this.unitNodes.get(uid)?.classList.contains('targetable')) {
        void this.resolveManualAttack(uid, false);
      } else if (uid === this.pendingAttack) {
        this.cancelAttack();
      }
      return;
    }
    if (this.inCombatWindow && side === Side.Player) this.beginAttack(uid);
  }

  private async playCard(index: number, uid?: number, side?: Side): Promise<void> {
    const e = this.engine!;
    const pl = e.p(Side.Player);
    const card = db.get(pl.hand[index]);
    const node = this.handNodes[index];
    if (node && card) {
      const r = node.getBoundingClientRect();
      const ghost = el('div', 'card flying');
      ghost.innerHTML = node.innerHTML;
      ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
      ghost.style.left = r.left + 'px'; ghost.style.top = r.top + 'px';
      document.body.appendChild(ghost);
      node.style.opacity = '0';
      const dest = (card.type === CardType.Creature || card.type === CardType.Rune ? $('playerBoard') : $('enemyBoard')).getBoundingClientRect();
      await sleep(16);
      ghost.style.transform = `translate(${dest.left + dest.width / 2 - (r.left + r.width / 2)}px, ${dest.top + 26 - r.top}px) scale(.5) rotate(-5deg)`;
      ghost.style.opacity = '0.1';
      setTimeout(() => ghost.remove(), 330);
    }
    const played = e.playCard(Side.Player, index, uid, side);
    if (!played) this.flashHint('Движок отклонил розыгрыш');
    else {
      Sfx.cardPlay(card?.cost ?? 3);
      const zone = card && (card.type === CardType.Creature || card.type === CardType.Rune) ? $('playerBoard') : $('enemyBoard');
      Vfx.screenFlash(paletteOf((card?.faction as string) ?? Faction.Neutral).primary, 0.1, 200);
      Vfx.impactRing(Vfx.centerOf(zone), paletteOf((card?.faction as string) ?? Faction.Neutral).secondary, 120);
    }
    this.renderAll();
    await sleep(280);
  }

  private manaDeny(reason?: string): void {
    if (!reason || !/ман/i.test(reason)) return;
    const st = $('playerMana')?.closest('.stat') as HTMLElement | null;
    if (!st || typeof st.animate !== 'function') return;
    st.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' },
      { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
      { duration: 300, easing: 'ease-in-out' });
    st.classList.remove('manaDeny'); void st.offsetWidth; st.classList.add('manaDeny');
    setTimeout(() => st.classList.remove('manaDeny'), 460);
  }

  private flashHint(text: string): void {
    const h = $('actionHint');
    h.textContent = text;
    h.style.color = 'var(--warn)';
    setTimeout(() => { h.style.color = ''; this.updateButtons(); }, 1900);
  }

  /* ------------------------------ кнопки ------------------------------ */

  private updateButtons(): void {
    const e = this.engine;
    if (!e) return;
    this.autoTurnPlan();
    const myMain = this.running && !this.busy && e.activeSide === Side.Player && e.phase === Phase.Main;
    btn('btnEndTurn').disabled = !myMain;
    btn('btnSkip').disabled = !myMain;
    const echo = e.canUseEcho(Side.Player);
    btn('btnEcho').disabled = !(myMain && echo.ok);
    btn('btnEcho').textContent = echo.ok
      ? `◈ Эхо: повторить «${(echo.card as CardData).name}» (очков ${e.p(Side.Player).echoPoints})`
      : '◈ Использовать Эхо';
    btn('btnEcho').title = echo.reason ?? 'Бесплатно повторить последнее разыгранное заклинание (один раз за игру)';
    const ab = btn('btnAutoBattle');
    ab.classList.toggle('hidden', !this.inCombatWindow);
    ab.disabled = !this.inCombatWindow;
    const sc = btn('btnSkipCombat');
    sc.classList.toggle('hidden', !this.inCombatWindow);
    sc.disabled = !this.inCombatWindow;
    if (this.inCombatWindow) {
      const n = this.engine ? this.engine.p(this.engine.activeSide).creatures.filter(c=> this.engine!.canAttack(c)).length : 0;
      $('actionHint').textContent = n > 0
        ? `⚔ Фаза боя: ${n} готовых к атаке подсвечены золотом · клик по своему → цель стрелкой · «Авто-бой» — доиграть, «Пропустить бой» — не бить`
        : 'Фаза боя: нечем атаковать — нажмите «Пропустить бой» или Space';
      return;
    }
    if ($('actionHint').style.color) return;
    $('actionHint').textContent = myMain
      ? 'Перетащите карту на поле или на цель · Пробел — завершить ход · E — Эхо'
      : 'Ожидание…';
  }

  /** Публичный «завершить ход» для обработчика кнопки. */
  endTurnNow(): void {
    if (this.tutLesson && !this.tutOk()) {
      showToast(`🎓 ${LESSONS[this.tutLesson - 1].ru}: сначала ${LESSONS[this.tutLesson - 1].need.toLowerCase()}`);
      return;
    }
    this.ropeStop();
    const e = this.engine;
    if (!e || this.busy || e.activeSide !== Side.Player || e.phase !== Phase.Main) return;
    this.turnDone?.();
  }

  /* ------------------------ обучение: уроки ------------------------ */

  /** Условие выполнения текущего урока. */
  private tutOk(): boolean {
    const e = this.engine;
    if (!e) return true;
    const st = e.stats[Side.Player];
    switch (this.tutLesson) {
      case 1: return st.runesPlayed >= 1 && st.creaturesSummoned >= 1 && st.spellsCast >= 1;
      case 2: return st.damageDealt > 0;
      case 3: return this.tutInjected.length > 0 && this.tutInjected.every(id => this.tutPlayed(id));
      case 4: return e.turn >= 3 && st.cardsPlayed >= 3;
      default: return true;
    }
  }

  /** Урок выполнен: снимаем гейт, начисляем награду (однократно), обновляем стадию. */
  private tutCheck(): void {
    if (!this.tutLesson || !this.tutOk()) return;
    const n = this.tutLesson;
    this.tutLesson = 0;
    this.tutCleanup();
    tutCoachHide();
    meta.tutStage = Math.max(meta.tutStage ?? 0, n);
    meta.tutDone = true;
    const rw = n === 3 ? 150 : 100;
    const first = !(meta.tutClaims ?? []).includes(n);
    if (first) {
      shardsAdd(rw);
      meta.tutClaims = [...(meta.tutClaims ?? []), n];
    }
    metaSave();
    tutGatePractice();
    showToast(`🎓 ${LESSONS[n - 1].ru} выполнен!${first ? ` +🪙${rw}` : ''}` +
      (n >= 4 && !meta.tutReward ? ' · Заберите награду в меню «🎓 Обучение»' : ''));
  }

  /* -------- спека «6. Обучение»: пошаговые уроки (20 шагов, зеркало tutorial.json) -------- */

  /** Карта урока сыграна (телеметрия или кладбище) — для шагов «разыграйте X». */
  private tutPlayed(id: string): boolean {
    const e = this.engine;
    if (!e) return false;
    return this.telemPlayed.some(pp => pp[0] === id) || e.p(Side.Player).graveyard.includes(id);
  }

  /* Публичные обёртки — предикаты шагов TUT_STEPS живут на уровне модуля. */
  tutPlayedPub(id: string): boolean { return this.tutPlayed(id); }
  tutTapPub(): boolean { return this.tutTap; }

  /** Старт урока: первый шаг, поллер и блокер посторонних действий (Промпт 1 п.4). */
  private tutStartLesson(): void {
    this.tutCleanup();
    this.tutStepId = TUT_STEP_FIRST[this.tutLesson] ?? 0;
    this.tutApplyStep();
    if (!this.tutPollId) this.tutPollId = window.setInterval(() => this.tutPollStep(), 350);
    document.addEventListener('click', this.tutBlocker, true);
    document.addEventListener('dragstart', this.tutBlocker, true);
  }

  /** Снять поллер/блокеры/подсветку (урок пройден или выход в меню). */
  tutCleanup(): void {
    if (this.tutPollId) { window.clearInterval(this.tutPollId); this.tutPollId = 0; }
    document.removeEventListener('click', this.tutBlocker, true);
    document.removeEventListener('dragstart', this.tutBlocker, true);
    document.querySelectorAll('.tourHi').forEach(x => x.classList.remove('tourHi'));
    this.tutStepId = 0;
  }

  private tutStep(): TutStep | undefined { return TUT_STEPS.find(s => s.id === this.tutStepId); }

  /** Подсветка нужной карты/кнопки + текст подсказки (Промпт 1 п.2). */
  private tutApplyStep(): void {
    document.querySelectorAll('.tourHi').forEach(x => x.classList.remove('tourHi'));
    const st = this.tutStep();
    if (!st) { tutCoachHide(); return; }
    const e = this.engine;
    this.tutMark = e?.turn ?? 0;
    this.tutMarkCards = e?.stats[Side.Player].cardsPlayed ?? 0;
    this.tutMarkDmg = e?.stats[Side.Player].damageDealt ?? 0;
    this.tutTap = false;
    tutCoach(`${LESSONS[st.lesson - 1].ru} · шаг ${st.id}/20 — ${st.message}`);
    st.hi()?.classList.add('tourHi');
  }

  /** Ждём выполнения действия игроком, затем следующий шаг (Промпт 1 п.3). */
  private tutPollStep(): void {
    if (!this.tutLesson || !this.tutStepId) return;
    const st = this.tutStep();
    if (!st) return;
    // подсветка могла исчезнуть после перерисовки — возвращаем
    const hi = st.hi();
    if (hi && !hi.classList.contains('tourHi')) {
      document.querySelectorAll('.tourHi').forEach(x => x.classList.remove('tourHi'));
      hi.classList.add('tourHi');
    }
    if (!st.ok()) return;
    const next = TUT_STEPS.find(s => s.id === st.id + 1);
    if (!next || next.lesson !== st.lesson) { this.tutCheck(); return; }   // урок завершён → награда
    this.tutStepId = next.id;
    this.tutApplyStep();
  }

  /** Блокируем всё, кроме требуемого действия (Промпт 1 п.4); «Меню» и тренер — всегда можно. */
  private tutBlocker = (ev: Event): void => {
    if (!this.tutLesson || !this.tutStepId) return;
    const st = this.tutStep();
    const tgt = ev.target as HTMLElement | null;
    if (!st || !tgt?.closest) return;
    const ALWAYS = '#btnMenu,#tutCoach,.toast,.toasts,#mulligan';
    if (tgt.closest(ALWAYS)) return;
    if (tgt.closest(st.allow.join(','))) {
      const hi = st.hi();
      if (hi && (tgt === hi || hi.contains(tgt))) this.tutTap = true;   // урок 4: клик по дорогой карте
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.type === 'click' && Date.now() - this.tutLastBlock > 1400) {
      this.tutLastBlock = Date.now();
      showToast('🎓 Сначала выполните подсвеченное действие — остальное заблокировано');
    }
  };

  /* ------------------------ кампания: сила босса ------------------------ */

  private bossTick(): void {
    const e = this.engine;
    if (!e || !this.bossPower || e.result !== GameResult.Ongoing) return;
    if (this.bossPower === 'heal') {
      e.healHero(Side.Opponent, 2, { source: 'Сила босса' });
    } else if (this.bossPower === 'drain') {
      e.damageHero(Side.Player, 1, { source: 'Сила босса: похищение', ignoreReduction: true });
      e.healHero(Side.Opponent, 1, { source: 'Сила босса' });
    } else if (this.bossPower === 'burn') {
      e.damageHero(Side.Player, 1, { source: 'Сила босса: ожог', ignoreReduction: true });
    }
  }

  /** Публичное использование Эха. */
  async useEchoNow(): Promise<void> {
    const e = this.engine;
    if (!e || this.busy || e.activeSide !== Side.Player || e.phase !== Phase.Main) return;
    const chk = e.canUseEcho(Side.Player);
    if (!chk.ok) { this.flashHint(chk.reason ?? 'Эхо недоступно'); return; }
    const card = chk.card as CardData;
    let uid: number | undefined; let side: Side | undefined;
    if (card && card.target !== TargetKind.None) {
      const valid = e.validTargets(Side.Player, card);
      if (valid.length === 0) { this.flashHint('Эхо: нет допустимых целей'); return; }
      if (valid.length === 1) { uid = valid[0].uid; side = valid[0].side; }
      else {
        this.flashHint(`Эхо: выберите цель для «${card.name}»… (Esc — отмена)`);
        this.highlightTargets(card);
        this.aimStart(Vfx.centerOf($('playerHero'), 0.42));
        const pick = await new Promise<{ uid?: number; side?: Side } | null>(resolve => {
          const done = (u: number | null, s: Side | null): void => {
            document.removeEventListener('keydown', onKey);
            resolve(u === null && s === null ? null : { uid: u ?? undefined, side: s ?? undefined });
          };
          const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') done(null, null); };
          document.addEventListener('keydown', onKey);
          this.pendingTarget = done;
        });
        this.pendingTarget = null;
        this.clearHighlights();
        if (!pick) { this.flashHint('Эхо отменено'); return; }
        uid = pick.uid; side = pick.side;
      }
    }
    if (e.useEcho(Side.Player, uid, side)) {
      pushLog(`◈ Эхо повторило «${card?.name ?? 'заклинание'}»`, 'big');
      Sfx.echo();
      Vfx.echoFx(Vfx.centerOf($('playerHero'), 0.42));
    }
    this.renderAll();
    await sleep(320);
  }

  /* ------------------------------ муллиган ------------------------------ */

  private showMulligan(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.tutLesson) { resolve(); return; }   // спека «6. Обучение»: в уроках рука заскриптована — муллиган пропускаем
      const e = this.engine!;
      const pl = e.p(Side.Player);
      const host = $('mullCards');
      host.innerHTML = '';
      // модель как в Hearthstone: по умолчанию вся рука остаётся, клик помечает карту НА ЗАМЕНУ
      const swap = new Set<number>();
      const counter = $('mullCount');
      const updateCount = (): void => {
        counter.textContent = swap.size
          ? `К замене: ${swap.size} из ${pl.hand.length}`
          : 'Замен нет — рука остаётся как есть';
      };
      updateCount();
      pl.hand.forEach((cid: string, i: number) => {
        const card = db.get(cid);
        if (!card) return;
        const node = renderCard(card);
        node.addEventListener('click', () => {
          if (swap.has(i)) { swap.delete(i); node.classList.remove('swap'); node.querySelector('.mark')?.remove(); }
          else {
            swap.add(i); node.classList.add('swap');
            const mark = el('div', 'mark', 'ЗАМЕНИТЬ');
            mark.style.color = 'var(--muted)';
            node.appendChild(mark);
          }
          updateCount();
          Sfx.uiClick();
        });
        host.appendChild(node);
      });
      $('mulligan').classList.remove('hidden');
      hideZoom();
      const finish = (): void => {
        const keepIdx = pl.hand.map((_: string, i: number) => i).filter(i => !swap.has(i));
        e.mulligan(Side.Player, keepIdx);
        $('mulligan').classList.add('hidden');
        btn('btnMullConfirm').removeEventListener('click', onConfirm);
        btn('btnMullSkip').removeEventListener('click', onSkip);
        this.renderAll();
        resolve();
      };
      const onConfirm = (): void => finish();
      const onSkip = (): void => { swap.clear(); finish(); };
      btn('btnMullConfirm').addEventListener('click', onConfirm);
      btn('btnMullSkip').addEventListener('click', onSkip);
    });
  }

  /* ---------------------------- конец игры ---------------------------- */

  private showGameOver(): void {
    tutCoachHide();
    Vfx.screenFlash('#ffd87a', 0.4, 620);
    Vfx.shake(9, undefined, 420);
    Vfx.vignettePulse('#d8b45a', 0.5);
    this.metaRewards();
    if (this.overShown || !this.engine) return;
    this.overShown = true;
    this.running = false;
    const e = this.engine;
    const win = e.result === GameResult.PlayerWin;
    const draw = e.result === GameResult.Draw;
    const title = $('goTitle');
    title.textContent = draw ? 'Ничья' : win ? 'Победа' : 'Поражение';
    title.className = draw ? '' : win ? 'win' : 'lose';
    const s = e.stats[Side.Player], o = e.stats[Side.Opponent];
    $('goStats').innerHTML = `
      <div><b>${e.turn}</b>ходов</div>
      <div><b>${s.damageDealt}</b>урона нанесено</div>
      <div><b>${s.healingDone}</b>лечения</div>
      <div><b>${s.cardsPlayed}</b>карт сыграно</div>
      <div><b>${s.spellsCast}</b>заклинаний</div>
      <div><b>${s.runesPlayed}</b>рун</div>
      <div><b>${s.echoGained}/${s.echoUsed}</b>Эхо (получено/использовано)</div>
      <div><b>${o.damageDealt}</b>урона вам нанесли</div>`;
    pushLog(draw ? 'Ничья: лимит ходов' : win ? '🏆 Победа!' : '☠ Поражение', 'big');
    if (win) { Vfx.screenFlash('#ffe9a8', 0.42, 620); Vfx.pillar({ x: window.innerWidth / 2, y: window.innerHeight * 0.55 }, '#ffd98a', 520, 190); Sfx.victory(); }
    else if (draw) { Vfx.screenFlash('#9aa3ad', 0.2, 420); }
    else { Vfx.vignettePulse('#d64545', 0.9); Vfx.screenFlash('#3a0d0d', 0.34, 700); Sfx.defeat(); }
    $('whoTurn').textContent = draw ? 'Ничья' : win ? 'Победа' : 'Поражение';
    $('gameover').classList.remove('hidden');
    hideZoom();
  }
}

/** Любая ошибка контроллера должна быть видна, а не «проглочена» промисом. */
function reportFatal(where: string, err: unknown): void {
  const e = err as Error;
  console.error(`[FATAL:${where}]`, e?.message ?? err);
  console.error(e?.stack ?? '');
  const hint = $('actionHint');
  if (hint) { hint.textContent = `Ошибка (${where}): ${e?.message ?? err}`; hint.style.color = 'var(--bad)'; }
}

function hurtKeys(): Keyframe[] {
  return [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-7px) rotate(-2deg)' },
    { transform: 'translateX(6px) rotate(2deg)' },
    { transform: 'translateX(-3px)' },
    { transform: 'translateX(0)' },
  ];
}

/* ---------------------------------------------------------------------- */
/*  Меню / коллекция / правила                                             */
/* ---------------------------------------------------------------------- */

const battle = new Battle();
/* Выбор фракции сохраняется между запусками (спека п.1.1; в Unity — PlayerPrefs "ec.faction"). */
const PICK_KEY = 'ec.pickedFaction';
const MENU_DECK_KEY = 'ec.menuSelectedDeckId';
let picked: Faction = Faction.Aurites;
let menuSelectedDeckId: string | null = null;
try {
  const savedPick = window.localStorage?.getItem(PICK_KEY) as Faction | null;
  if (savedPick && (FACTION_IDS as string[]).includes(savedPick)) picked = savedPick;
  menuSelectedDeckId = window.localStorage?.getItem(MENU_DECK_KEY) || null;
} catch { /* приватный режим браузера */ }
const savePicked = (): void => { try { window.localStorage?.setItem(PICK_KEY, picked); } catch { void 0; } };
const saveMenuDeck = (): void => {
  try { if (menuSelectedDeckId) window.localStorage?.setItem(MENU_DECK_KEY, menuSelectedDeckId); else window.localStorage?.removeItem(MENU_DECK_KEY); }
  catch { void 0; }
};
let audioOn = true;
// звук в браузере разрешён только после жеста пользователя
const unlockAudio = (): void => { audioUnlock(); window.removeEventListener('pointerdown', unlockAudio); };
window.addEventListener('pointerdown', unlockAudio);

/* ---------------------------------------------------------------------- */
/*  Коллекция: новые игроки получают только копии карт пяти starter-колод; */
/*  остальные карты открываются из бустеров, пропуска и событий.           */
/* ---------------------------------------------------------------------- */
/* ---------------------------------------------------------------------- */
/*  Мета-игра: профиль, XP/лиги, дейлики, кампания, рубашки, история       */
/* ---------------------------------------------------------------------- */
interface Quest { id: string; prog: number; goal: number; claimed: boolean; fac?: string }
interface MetaState {
  xp: number; wins: number; losses: number; mmr: number; packs: number;
  facW: Record<string, number>; facL: Record<string, number>;
  history: Array<{ ts: number; win: boolean; fac: string; turns: number; foe?: string; efac?: string; practice?: boolean }>;
  tutDone: boolean; campaign: Record<string, boolean>; starter: boolean;
  backsOwned: string[]; backEq: string;
  questDate: string; quests: Quest[]; ach: Record<string, boolean>; bpClaimed: number[];
  telem?: Array<{ ts: number; fac: string; win: boolean; turns: number; secs: number;
    played: Array<[string, number]>; stuck: string[]; matchId?: string | null }>;
  nick: string; avatarFac: string; frame: string; gems: number; signedIn: boolean; pid: string;
  bpXp: number; bpClaimedP: number[]; bpPremium: boolean; seasonStart: number; bestMmr: number;
  foilTokens: number; premOpens: number;   // спека «5»: фойл-жетоны и премиум-бустеры из пропуска
  freeOpens: number; bundles: string[]; tableSkin: string; runeSkin: string; avatarsOwned: string[];
  borderlessOwned: string[]; borderlessEquipped: string[]; borderlessEventWins: number; borderlessEventClaimed: boolean;
  tablesOwned: string[]; runesOwned: string[];
  friends: Array<{ nick: string; ts: number }>;
  campStars: Record<string, number>; loreRead: string[]; tutStage: number; tutReward: string; tutClaims: number[];
  wquestWeek: string; wquests: Quest[];
  replays: Array<{ ts: number; win: boolean; fac: string; turns: number; foe: string; lines: Array<[number, string]> }>;
}
const META_KEY = 'ec_meta_v1';
const DAILY_REWARD: Record<string, number> = { win_fac: 200, creatures: 200, runes: 120, pack: 80 };
const QUEST_RU: Record<string, (q: Quest) => string> = {
  win_fac: q => `Выиграйте ${q.goal} матча фракцией ${FACTION_RU[(q.fac ?? 'Aurites') as Faction]}`,
  creatures: q => `Разыграйте ${q.goal} существ`,
  runes: q => `Примените ${q.goal} руны`,
  pack: q => `Откройте ${q.goal} бустер`,
};
function todayStr(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function freshQuests(): Quest[] {
  const fac = FACTION_IDS[new Date().getDate() % FACTION_IDS.length];
  return [
    { id: 'win_fac', prog: 0, goal: 2, claimed: false, fac },
    { id: 'creatures', prog: 0, goal: 20, claimed: false },
    { id: 'runes', prog: 0, goal: 2, claimed: false },
    { id: 'pack', prog: 0, goal: 1, claimed: false },
  ];
}
const SEASON_MS = 30 * 24 * 3600 * 1000;   // сезон боевого пропуска: 30 дней
function weekStr(date = new Date()): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return todayStr(monday); // локальная неделя: понедельник 00:00 → понедельник 00:00
}
function nextDailyResetMs(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}
function nextWeeklyResetMs(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = ((8 - next.getDay()) % 7) || 7;
  next.setDate(next.getDate() + days);
  return next.getTime();
}
function formatQuestCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return days ? `${days} д ${clock}` : clock;
}
function freshWQuests(): Quest[] {
  return [
    { id: 'w_win3', prog: 0, goal: 3, claimed: false },
    { id: 'w_runes', prog: 0, goal: 15, claimed: false },
    { id: 'w_creatures', prog: 0, goal: 60, claimed: false },
    { id: 'w_dmg', prog: 0, goal: 300, claimed: false },
  ];
}
const WEEK_REWARD: Record<string, number> = { w_win3: 300, w_runes: 250, w_creatures: 300, w_dmg: 350 };
const WQUEST_RU: Record<string, string> = {
  w_win3: 'Выиграйте 3 матча за неделю', w_runes: 'Разыграйте 15 рун за неделю',
  w_creatures: 'Разыграйте 60 существ за неделю', w_dmg: 'Нанесите 300 урона за неделю',
};

const META_DEFAULT: MetaState = {
  xp: 0, wins: 0, losses: 0, mmr: 1000, packs: 0, facW: {}, facL: {}, history: [],
  tutDone: false, campaign: {}, starter: false, backsOwned: ['classic'], backEq: 'classic',
  questDate: todayStr(), quests: freshQuests(), ach: {}, bpClaimed: [],
  nick: 'Гость', avatarFac: 'Aurites', frame: 'bronze', gems: 500, signedIn: false, pid: '',
  bpXp: 0, bpClaimedP: [], bpPremium: false, seasonStart: 0, bestMmr: 1000,
  foilTokens: 0, premOpens: 1,
  freeOpens: 5, bundles: [], tableSkin: 'classic', runeSkin: 'classic', avatarsOwned: [],
  borderlessOwned: [], borderlessEquipped: [], borderlessEventWins: 0, borderlessEventClaimed: false,
  tablesOwned: [], runesOwned: [],
  friends: [], campStars: {}, loreRead: [], tutStage: 0, tutReward: '', tutClaims: [],
  wquestWeek: '', wquests: [], replays: [],
};
let meta: MetaState = META_DEFAULT;
function normalizeQuestSet(existing: Quest[] | null | undefined, templates: Quest[]): Quest[] {
  const previous = Array.isArray(existing) ? existing : [];
  return templates.map(template => {
    const saved = previous.find(q => q?.id === template.id);
    if (!saved) return { ...template };
    const prog = Number.isFinite(Number(saved.prog)) ? Number(saved.prog) : 0;
    return {
      ...template, ...saved, goal: template.goal,
      prog: Math.max(0, Math.min(template.goal, prog)), claimed: !!saved.claimed,
      fac: saved.fac ?? template.fac,
    };
  });
}
function metaLoad(): void {
  const freshMeta = (): MetaState => JSON.parse(JSON.stringify(META_DEFAULT)) as MetaState;
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<MetaState>;
      meta = { ...freshMeta(), ...saved };
      // Старые аккаунты не получают повторный стартовый грант из новых defaults.
      if (saved.gems == null) meta.gems = 100;
      if (saved.freeOpens == null) meta.freeOpens = 0;
      if (saved.premOpens == null) meta.premOpens = 0;
    } else {
      // Только чистый профиль получает стартовый набор: 3500 монет, 500 гемов,
      // 5 обычных и 1 мифический бустер.
      meta = freshMeta();
    }
  } catch { meta = freshMeta(); }
  const today = todayStr();
  if (meta.questDate !== today) { meta.questDate = today; meta.quests = freshQuests(); }
  else meta.quests = normalizeQuestSet(meta.quests, freshQuests());
  if (!meta.seasonStart) meta.seasonStart = Date.now();
  if (!meta.bestMmr) meta.bestMmr = meta.mmr;
  if (meta.bpXp == null) meta.bpXp = meta.xp ?? 0;
  if (meta.foilTokens == null) meta.foilTokens = 0;
  if (meta.premOpens == null) meta.premOpens = 0;
  if (!meta.tutClaims) meta.tutClaims = [];
  if (!Array.isArray(meta.borderlessOwned)) meta.borderlessOwned = [];
  if (!Array.isArray(meta.borderlessEquipped)) meta.borderlessEquipped = [];
  if (!Number.isFinite(meta.borderlessEventWins)) meta.borderlessEventWins = 0;
  if (typeof meta.borderlessEventClaimed !== 'boolean') meta.borderlessEventClaimed = false;
  if (Date.now() > meta.seasonStart + SEASON_MS) {
    // новый сезон: сброс веток пропуска (косметика и купленный премиум-статус сезона обнуляются)
    meta.seasonStart = Date.now(); meta.bpXp = 0; meta.bpClaimed = []; meta.bpClaimedP = []; meta.bpPremium = false;
  }
  const currentWeek = weekStr();
  if (meta.wquestWeek !== currentWeek) { meta.wquestWeek = currentWeek; meta.wquests = freshWQuests(); }
  else meta.wquests = normalizeQuestSet(meta.wquests, freshWQuests());
  if (!meta.pid) {
    // Постоянный id игрока для серверного профиля (спека «2. Профиль»: сохранение на сервере).
    meta.pid = `ec-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    try { window.localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { void 0; }
  }
}
function metaSave(): void { try { window.localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { void 0; } scheduleSync(); }
function syncQuestPeriods(): boolean {
  let changed = false;
  const today = todayStr();
  const currentWeek = weekStr();
  if (meta.questDate !== today) { meta.questDate = today; meta.quests = freshQuests(); changed = true; }
  if (meta.wquestWeek !== currentWeek) { meta.wquestWeek = currentWeek; meta.wquests = freshWQuests(); changed = true; }
  if (changed) metaSave();
  return changed;
}
metaLoad();

/* Borderless — только альтернативный внешний вид тех же карт: id, правила,
   стоимость, владение обычной копией и колоды не меняются. */
const BORDERLESS_BOOSTER_CHANCE = 0.001;
const BORDERLESS_EVENT_WINS = 3;
function hasBorderless(id: string): boolean { return (meta.borderlessOwned ?? []).includes(id); }
function isBorderlessEquipped(id: string): boolean { return (meta.borderlessEquipped ?? []).includes(id); }
function unlockBorderless(id: string): boolean {
  if (!ALL_CARDS.some(card => card.id === id) || hasBorderless(id)) return false;
  meta.borderlessOwned.push(id);
  return true;
}
function grantRandomBorderless(): CardData | null {
  const candidates = ALL_CARDS.filter(card => !hasBorderless(card.id));
  if (!candidates.length) return null;
  const card = candidates[Math.floor(Math.random() * candidates.length)];
  return unlockBorderless(card.id) ? card : null;
}
function borderlessRollIsBonus(roll: number): boolean {
  return Number.isFinite(roll) && roll >= 0 && roll < BORDERLESS_BOOSTER_CHANCE;
}
function maybeBorderlessPackBonus(): CardData | null {
  if (!borderlessRollIsBonus(Math.random())) return null;
  return grantRandomBorderless();
}
// Чистая граница ролла доступна smoke-тесту: интервал [0, 0.001) = ровно 0,1% Math.random().
(window as any).ecBorderlessChanceForRoll = (roll: number): boolean => borderlessRollIsBonus(roll);
function setBorderlessEquipped(id: string, equip: boolean): boolean {
  if (!ALL_CARDS.some(card => card.id === id) || (equip && !hasBorderless(id))) return false;
  const equipped = new Set(meta.borderlessEquipped ?? []);
  const wasEquipped = equipped.has(id);
  if (wasEquipped === equip) return equip;
  if (equip) equipped.add(id); else equipped.delete(id);
  meta.borderlessEquipped = [...equipped];
  metaSave();
  return equip;
}
function toggleBorderless(id: string): boolean {
  if (!hasBorderless(id)) return false;
  return setBorderlessEquipped(id, !isBorderlessEquipped(id));
}
(window as any).ecGrantBorderless = (id: string): boolean => { const ok = unlockBorderless(id); if (ok) metaSave(); return ok; };
(window as any).ecToggleBorderless = (id: string): boolean => toggleBorderless(id);
(window as any).ecBorderlessOwned = (): string[] => [...(meta.borderlessOwned ?? [])];

/* ---- Синхронизация с сервером (спека «2. Профиль»): meta_server :8081, best-effort.
   localStorage остаётся источником истины (офлайн-игра); сервер — зеркало профиля,
   реестр никнеймов и клеймы квестов. Троттлинг 1.5с: metaSave() вызывается часто. ---- */
const META_API = (): string => `http://${window.location.hostname}:8081`;
let syncTimer = 0;
function scheduleSync(): void {
  if (syncTimer) return;
  syncTimer = window.setTimeout(() => { syncTimer = 0; syncProfile(); }, 1500);
}
function syncProfile(): void {
  try {
    if (typeof window.fetch !== 'function' || !meta.pid) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 800);
    void window.fetch(`${META_API()}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({
        pid: meta.pid, nick: meta.nick, level: Math.floor(meta.xp / 500) + 1, xp: meta.xp,
        mmr: meta.mmr, bestMmr: meta.bestMmr ?? meta.mmr, wins: meta.wins, losses: meta.losses,
        avatarFac: meta.avatarFac, frame: meta.frame, ach: meta.ach,
        shards: shardsGet(), gems: gemsGet(), freeOpens: meta.freeOpens ?? 0,
        bundles: meta.bundles ?? [],
        bpXp: meta.bpXp ?? 0, bpPremium: !!meta.bpPremium,
        bpClaimed: meta.bpClaimed ?? [], bpClaimedP: meta.bpClaimedP ?? [],
        foilTokens: meta.foilTokens ?? 0, premOpens: meta.premOpens ?? 0,
        avatarsOwned: meta.avatarsOwned ?? [],
        tutStage: meta.tutStage ?? 0, tutDone: !!meta.tutDone,
        tutReward: meta.tutReward ?? '', tutClaims: meta.tutClaims ?? [],
        cosmetics: { backs: meta.backsOwned ?? [], tables: meta.tablesOwned ?? [], runes: meta.runesOwned ?? [],
          backEq: meta.backEq ?? 'classic', tableSkin: meta.tableSkin ?? 'classic', runeSkin: meta.runeSkin ?? 'classic' },
        questDate: meta.questDate, wquestWeek: meta.wquestWeek,
        quests: {
          daily: (meta.quests ?? []).map(q => ({ id: q.id, prog: q.prog, goal: q.goal, claimed: q.claimed, fac: q.fac })),
          weekly: (meta.wquests ?? []).map(q => ({ id: q.id, prog: q.prog, goal: q.goal, claimed: q.claimed })),
        },
        history: (meta.history ?? []).slice(0, 20),
      }),
    }).then(() => window.clearTimeout(t), () => window.clearTimeout(t));
  } catch { /* сервер недоступен — полностью локальная игра */ }
}
function apiSend(path: string, body: unknown): void {
  try {
    if (typeof window.fetch !== 'function' || !meta.pid) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 800);
    void window.fetch(META_API() + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ pid: meta.pid, ...body as object }),
    }).then(() => window.clearTimeout(t), () => window.clearTimeout(t));
  } catch { void 0; }
}
function questBump(id: string, n = 1, faction?: string): void {
  if (!(n > 0)) return;
  let changed = false;
  const q = meta.quests.find(x => x.id === id);
  const matchesQuestFaction = id !== 'win_fac' || !faction || q?.fac === faction;
  if (q && !q.claimed && matchesQuestFaction) { q.prog = Math.min(q.goal, q.prog + n); changed = true; }
  const WMAP: Record<string, string> = {
    win_fac: 'w_win3', runes: 'w_runes', creatures: 'w_creatures', dmg: 'w_dmg',
  };
  const wid = WMAP[id];
  if (wid) {
    const wq = (meta.wquests ?? []).find(x => x.id === wid);
    if (wq && !wq.claimed) { wq.prog = Math.min(wq.goal, wq.prog + n); changed = true; }
  }
  if (changed) {
    metaSave();
    if (!document.getElementById('menu')?.classList.contains('hidden')) renderHomeQuests();
  }
}
(window as any).ecTestQuestBump = (id: string, n = 1, faction?: string): void => questBump(id, n, faction);

function updateQuestCountdowns(): void {
  const now = new Date();
  document.querySelectorAll<HTMLElement>('[data-quest-reset="daily"],[data-quest-reset="weekly"]').forEach(node => {
    const resetAt = node.dataset.questReset === 'weekly' ? nextWeeklyResetMs(now) : nextDailyResetMs(now);
    const prefix = node.dataset.resetPrefix ?? 'Сброс через';
    node.textContent = `${prefix} ${formatQuestCountdown(resetAt - now.getTime())}`;
    node.setAttribute('aria-label', `${prefix} ${formatQuestCountdown(resetAt - now.getTime())}`);
  });
}
function questGlyph(id: string): string {
  if (id.includes('win')) return '⚔';
  if (id.includes('creature')) return '♟';
  if (id.includes('rune')) return '◇';
  if (id.includes('pack')) return '▣';
  if (id.includes('dmg')) return '✦';
  return '◆';
}
function renderQuestTask(q: Quest, kind: 'daily' | 'weekly'): string {
  const weekly = kind === 'weekly';
  const done = q.prog >= q.goal;
  const claimed = !!q.claimed;
  const reward = weekly ? (WEEK_REWARD[q.id] ?? 0) : (DAILY_REWARD[q.id] ?? 0);
  const bp = weekly ? 250 : 150;
  const label = QUEST_RU[q.id]?.(q) ?? WQUEST_RU[q.id] ?? q.id;
  const progress = Math.max(0, Math.min(q.goal || 0, Number(q.prog) || 0));
  const percent = q.goal > 0 ? Math.round(progress / q.goal * 100) : 0;
  const canClaim = done && !claimed;
  const icon = questGlyph(q.id);
  const artId = encodeURIComponent(q.id);
  const status = claimed ? 'questTaskClaimed' : done ? 'questTaskDone' : '';
  const reset = done
    ? `<span class="questTaskReset questReset" data-quest-reset="${kind}" data-reset-prefix="Сброс через">—</span>`
    : '';
  const buttonLabel = claimed ? 'Получено ✓' : canClaim ? 'Забрать' : `🪙${reward}`;
  return `<article class="questTask ${status}" data-quest-card="${kind}:${esc(q.id)}" role="listitem">
    <span class="questTaskIcon" aria-hidden="true"><b>${icon}</b><img src="/cosm/quests/${artId}?t=${Date.now()}" alt="" loading="lazy" onload="this.closest('.questTaskIcon')?.classList.add('hasArt')" onerror="this.remove()"></span>
    <div class="questTaskMain">
      <strong class="questTaskTitle">${esc(label)}</strong>
      <div class="questTaskProgressLine">
        <span class="questTaskProgressText">${progress}/${q.goal}</span>
        <div class="questTaskProgressBar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${q.goal}" aria-valuenow="${progress}"><i style="width:${percent}%"></i></div>
      </div>
      <span class="questTaskReward">Награда · 🪙${reward} <i>+${bp} BP</i></span>
      ${reset}
    </div>
    <button type="button" class="btn homeQuestClaim" data-kind="${kind}" data-q="${esc(q.id)}" ${canClaim ? '' : 'disabled'} aria-label="${canClaim ? `Забрать награду за задание: ${esc(label)}` : claimed ? `Награда за задание получена: ${esc(label)}` : `Задание ${esc(label)}, ${progress} из ${q.goal}`}" title="${canClaim ? 'Забрать награду' : claimed ? 'Уже получено' : 'Выполняйте цель в матчах'}">${buttonLabel}</button>
  </article>`;
}
function renderHomeQuests(): void {
  const daily = document.getElementById('homeDailyQuests');
  const weekly = document.getElementById('homeWeeklyQuests');
  if (!daily || !weekly) return;
  daily.innerHTML = (meta.quests ?? []).map(q => renderQuestTask(q, 'daily')).join('');
  weekly.innerHTML = (meta.wquests ?? []).map(q => renderQuestTask(q, 'weekly')).join('');
  updateQuestCountdowns();
}
function claimQuestReward(kind: 'daily' | 'weekly', id: string, keepHome = false): boolean {
  const weekly = kind === 'weekly';
  const q = (weekly ? meta.wquests : meta.quests).find(x => x.id === id);
  if (!q || q.claimed || q.prog < q.goal) return false;
  q.claimed = true;
  const reward = weekly ? (WEEK_REWARD[q.id] ?? 0) : (DAILY_REWARD[q.id] ?? 0);
  const bpReward = weekly ? 250 : 150;
  shardsAdd(reward);
  meta.bpXp = (meta.bpXp ?? 0) + bpReward;
  metaSave(); renderShards();
  apiSend('/api/quests/claim', { id: q.id, kind, prog: q.prog, goal: q.goal });
  if (keepHome) {
    renderHomeQuests();
    [...document.querySelectorAll<HTMLButtonElement>('.homeQuestClaim')]
      .find(button => button.dataset.kind === kind && button.dataset.q === id)?.focus();
  } else if (!document.getElementById('profileModal')?.classList.contains('hidden')) openProfile();
  else if (!document.getElementById('menu')?.classList.contains('hidden')) renderHomeQuests();
  showToast(`${weekly ? 'Недельное задание' : 'Задание'}: 🪙${reward} и +${bpReward} опыта пропуска`);
  return true;
}
document.addEventListener('click', ev => {
  const button = (ev.target as HTMLElement | null)?.closest?.('.homeQuestClaim') as HTMLButtonElement | null;
  if (!button || button.disabled) return;
  const kind = button.dataset.kind === 'weekly' ? 'weekly' : 'daily';
  if (button.dataset.q) claimQuestReward(kind, button.dataset.q, true);
});
window.setInterval(() => {
  const reset = syncQuestPeriods();
  if (reset) {
    if (!document.getElementById('menu')?.classList.contains('hidden')) renderHomeQuests();
    if (!document.getElementById('profileModal')?.classList.contains('hidden')) openProfile();
  }
  updateQuestCountdowns();
}, 1000);
function leagueOf(mmr: number): string {
  return mmr < 1050 ? 'Бронза' : mmr < 1200 ? 'Серебро' : mmr < 1400 ? 'Золото'
    : mmr < 1600 ? 'Платина' : 'Алмаз';
}

/* --- ранговая лестница сезона: тир + дивизион (ТЗ: «Адепт III») --- */
const RANKS: Array<{ n: string; min: number; div: number }> = [
  { n: 'Ученик', min: 800, div: 1 },
  { n: 'Адепт', min: 1000, div: 3 },
  { n: 'Магистр', min: 1300, div: 3 },
  { n: 'Архимаг', min: 1600, div: 3 },
  { n: 'Легенда', min: 1900, div: 1 },
];
const ROMAN = ['I', 'II', 'III'];
function rankOf(mmr: number): { title: string; next: string; prog: number } {
  let i = 0;
  for (let k = RANKS.length - 1; k >= 0; k--) { if (mmr >= RANKS[k].min) { i = k; break; } }
  const r = RANKS[i]; const nxt = RANKS[i + 1];
  if (!nxt) return { title: r.n, next: '—', prog: 1 };
  const p = Math.max(0, Math.min(1, (mmr - r.min) / (nxt.min - r.min)));
  const divIdx = r.div > 1 ? Math.min(r.div - 1, Math.floor(p * r.div)) : 0;
  return { title: `${r.n}${r.div > 1 ? ' ' + ROMAN[divIdx] : ''}`, next: `${nxt.n}${nxt.div > 1 ? ' I' : ''}`, prog: p };
}
(window as unknown as { ecRank: (m: number) => string }).ecRank = m => rankOf(m).title;

/* --- гемы (премиум-валюта) и тосты --- */
function gemsGet(): number { return meta.gems ?? 0; }
function gemsAdd(n: number): void { meta.gems = Math.max(0, gemsGet() + n); metaSave(); renderShards(); }
let toastTimer = 0;
function showToast(text: string): void {
  const n = $('subsLine');
  if (!n) return;
  n.textContent = text;
  n.classList.add('on');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => n.classList.remove('on'), 2400);
}
/* Экономика в монетах: создание 5/10/20/100/400, разбор 1/2/5/20/100; дубликаты сверх playset конвертируются в монеты. */
const CRAFT_COST: Record<string, number> = { Common: 5, Uncommon: 10, Rare: 20, Epic: 100, Legendary: 400 };
const DISENCHANT_COINS: Record<string, number> = { Common: 1, Uncommon: 2, Rare: 5, Epic: 20, Legendary: 100 };
(window as unknown as { ecMeta: () => MetaState }).ecMeta = () => meta;
(window as unknown as { ecSetShards: (n: number) => void }).ecSetShards = n => shardsSet(n);
/* тестовые хуки спеки «5. Боевой пропуск» (смоук): гемы и опыт пропуска */
(window as unknown as { ecSetGems: (n: number) => void }).ecSetGems = n => gemsAdd(n - gemsGet());
(window as unknown as { ecSetBpXp: (n: number) => void }).ecSetBpXp = n => { meta.bpXp = n; metaSave(); };

const OWNED_KEY = 'ec_owned_v2';   // сохранён прежний ключ; новые аккаунты получают только карты 5 стартовых колод
/** Карты расширения: доступны через бустеры/пропуск/события, стартовые колоды состоят из базовых карт. */
const EXPANSION_IDS: Set<string> = new Set(
  ((cardsJson as unknown as { meta?: { expansionIds?: string[] } }).meta?.expansionIds) ?? []);
function isExpansionId(id: string): boolean {
  return EXPANSION_IDS.size > 0 ? EXPANSION_IDS.has(id)
    : /_(3[1-9]|4[0-4])$|_s1[1-9]$|_r0[7-9]$|_r1[0-1]$/.test(id);
}
const owned = new Map<string, number>();
function ownedLoad(): void {
  owned.clear();
  try {
    let raw = window.localStorage.getItem(OWNED_KEY);
    if (!raw) {
      // Миграция со старого ключа ec_owned_v1 (docs/EXPANSION.md §2 и подсказка в админке
      // раньше рекламовали v1): если v2 ещё нет, но легаси-сохранение есть — переезжаем.
      const legacy = window.localStorage.getItem('ec_owned_v1');
      if (legacy) {
        raw = legacy;
        try { window.localStorage.setItem(OWNED_KEY, legacy); } catch { void 0; }
      }
    }
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) owned.set(k, v);
  } catch { /* приватный режим — работаем в памяти */ }
  if (owned.size === 0) {
    const starters = deckList.filter(d => d.format === STARTER_DECK_FORMAT);
    if (starters.length) {
      // Коллекция новичка = копии, реально входящие в 5 стартовых колод (общий playset capped at 4).
      for (const deck of starters) for (const id of deck.cards) {
        owned.set(id, Math.min(4, (owned.get(id) ?? 0) + 1));
      }
    } else {
      // Совместимость со старым Decks.json: не блокируем запуск, пока данные не обновлены.
      for (const c of db.values()) if (!isExpansionId(c.id)) owned.set(c.id, 1);
    }
    ownedSave();
  }
}
function ownedSave(): void {
  try { window.localStorage.setItem(OWNED_KEY, JSON.stringify(Object.fromEntries(owned))); } catch { void 0; }
}
/** Копия карты владения для админ-панели и экспорта/импорта (раньше функции отсутствовали — вкладка «Коллекция» падала). */
function getOwnedMap(): Map<string, number> { return new Map(owned); }
function setOwnedMap(next: Map<string, number>): void {
  owned.clear();
  for (const [k, v] of next) owned.set(k, v);
  ownedSave();
}
function ownedCount(id: string): number { return owned.get(id) ?? 0; }
ownedLoad();
(window as unknown as { ecOwnedOf: (id: string) => number }).ecOwnedOf = id => ownedCount(id);
(window as unknown as { ecIsExp: (id: string) => boolean }).ecIsExp = id => isExpansionId(id);
(window as unknown as { ecStackLen: () => number }).ecStackLen = () => battle.engine?.stack.length ?? 0;
(window as unknown as { ecOwnedTotal: () => number }).ecOwnedTotal =
  () => [...owned.values()].reduce((a, b) => a + b, 0);

/** Шансы редкостей бустера по ТЗ: 60/25/10/5. */
const PACK_ODDS: Array<[Rarity, number]> = [
  [Rarity.Common, 0.60], [Rarity.Rare, 0.25], [Rarity.Epic, 0.10], [Rarity.Legendary, 0.05],
];
const PACK_PRICE = 300;
const PLAYSET = 4;                                   // MTG: максимум 4 копии карты
const CONVERT: Record<Rarity, number> = { [Rarity.Common]: 1, [Rarity.Uncommon]: 2, [Rarity.Rare]: 5, [Rarity.Epic]: 20, [Rarity.Legendary]: 100 };
const SHARD_KEY = 'ec_shards_v1';
const FOIL_KEY = 'ec_foil_v1';
const foils = new Map<string, number>();
function shardsGet(): number {
  try { const v = window.localStorage.getItem(SHARD_KEY); if (v !== null) return Number(v) || 0; } catch { void 0; }
  shardsSet(3500);                                   // стартовый грант нового игрока: 3500 монет
  return 3500;
}
function shardsSet(n: number): void { try { window.localStorage.setItem(SHARD_KEY, String(n)); } catch { void 0; } }
function shardsAdd(n: number): void { shardsSet(shardsGet() + n); }
function foilLoad(): void {
  foils.clear();
  try { const raw = window.localStorage.getItem(FOIL_KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) foils.set(k, v); } catch { void 0; }
}
function foilSave(): void { try { window.localStorage.setItem(FOIL_KEY, JSON.stringify(Object.fromEntries(foils))); } catch { void 0; } }
foilLoad();
(window as unknown as { ecShards: () => number }).ecShards = () => shardsGet();
(window as unknown as { ecSetOwned: (id: string, n: number) => void }).ecSetOwned = (id, n) => { owned.set(id, n); ownedSave(); };

interface PackSlotData { card: CardData; foil: boolean; converted: number; borderless?: boolean; bonus?: boolean }
/** MTG-состав бустера: 3 обычных, 1 «редкая» (uncommon), 1 эпическая/легендарная (1/8).
 *  comp — переопределение состава (премиум-бустер спеки «5»: 2C+1R+2E/L).
 *  Дополнительно: отдельный косметический Borderless-дроп с шансом 0,1% на бустер. */
function drawBooster(forcedId?: string, comp?: Rarity[], allowBorderless = true): PackSlotData[] {
  // Бустеры открывают весь набор: нестартерные базовые карты и карты расширений.
  const pool = [...db.values()];
  const compList: Rarity[] = comp ?? [Rarity.Common, Rarity.Common, Rarity.Common, Rarity.Rare,
    Math.random() < 0.125 ? Rarity.Legendary : Rarity.Epic];
  const foilIdx = Math.random() < 0.2 ? Math.floor(Math.random() * 5) : -1;
  const out: PackSlotData[] = [];
  compList.forEach((rar, i) => {
    const cand = pool.filter(c => c.rarity === rar);
    const c = forcedId ? (db.get(forcedId) ?? pool[0]) : (cand[Math.floor(Math.random() * cand.length)] ?? pool[0]);
    let converted = 0;
    const have = owned.get(c.id) ?? 0;
    if (have < PLAYSET) owned.set(c.id, have + 1);
    else converted += CONVERT[c.rarity] ?? 20;        // копии сверх 4 → монеты
    let foil = i === foilIdx;
    if (foil) {
      const fh = foils.get(c.id) ?? 0;
      if (fh < PLAYSET) foils.set(c.id, fh + 1);
      else { converted += Math.round((CONVERT[c.rarity] ?? 20) / 2); foil = false; }
    }
    if (converted > 0) shardsAdd(converted);
    out.push({ card: c, foil, converted });
  });
  if (allowBorderless) {
    const bonus = maybeBorderlessPackBonus();
    if (bonus) out.push({ card: bonus, foil: false, converted: 0, borderless: true, bonus: true });
  }
  ownedSave(); foilSave();
  meta.packs += 1; questBump('pack'); checkAchs(); metaSave();
  return out;
}
interface PackTestResult { converted: number; shardsBefore: number; shardsAfter: number; ownedCap: number }
(window as unknown as { ecTestPack: (forcedId: string) => PackTestResult }).ecTestPack = (forcedId) => {
  const before = shardsGet();
  const slots = drawBooster(forcedId, undefined, false);
  return { converted: slots.reduce((a, b) => a + b.converted, 0), shardsBefore: before,
    shardsAfter: shardsGet(), ownedCap: owned.get(forcedId) ?? 0 };
};
let pendingPack: PackSlotData[] | null = null;
let pendingPackKind: string | null = null;
let boosterReturnFocus: HTMLElement | null = null;

function packTypeTitle(kind: string): string {
  if (kind === 'booster_premium') return 'Премиум-бустер';
  if (kind.startsWith('pack_')) return `Фракционный бустер · ${FACTION_RU[kind.slice(5) as Faction] ?? 'фракция'}`;
  return 'Обычный бустер · Эхо-Цитадель';
}
function showSealedPack(slots: PackSlotData[] | null, kind: string = 'booster'): void {
  pendingPack = slots;
  pendingPackKind = kind;
  const st = document.getElementById('packStage') as HTMLElement | null;
  const sealed = document.getElementById('packSealed') as HTMLElement | null;
  const row = document.getElementById('packRow') as HTMLElement | null;
  if (!st || !sealed || !row) { if (slots) renderPackSlots(slots); return; }
  row.innerHTML = '';
  st.classList.remove('hasResults','opening');
  st.classList.add('hasSealed');
  const title = packTypeTitle(kind);
  const status = document.getElementById('packStageStatus');
  if (status) status.textContent = `Выбрано · ${title} · запас не списан`;
  const subtitle = document.getElementById('packTypeSubtitle');
  if (subtitle) subtitle.textContent = `${title} · 5 карт в наборе`;
  sealed.setAttribute('aria-label', `Вскрыть: ${title}`);
  const top = sealed.querySelector('.psTop'); if (top) top.textContent = kind === 'booster_premium' ? 'MYTHIC' : kind.startsWith('pack_') ? 'FACTION' : 'ECH I';
  const bottom = sealed.querySelector('.psBot'); if (bottom) bottom.textContent = kind === 'booster_premium' ? 'МИФИЧЕСКИЙ БУСТЕР' : kind.startsWith('pack_') ? (FACTION_RU[kind.slice(5) as Faction] ?? 'БУСТЕР ФРАКЦИИ') : 'ЭХО-ЦИТАДЕЛЬ';
  const flipAll = document.getElementById('btnPackFlip') as HTMLButtonElement | null;
  if (flipAll) flipAll.disabled = true;
  sealed.classList.remove('hidden','cracking');
  void sealed.offsetWidth;
  sealed.focus();
  try { attachVolumetric(sealed); } catch {}
  // арт пачки: art_raw/cosm/offers/<kind> → offers/booster → процедурный сигил (как был)
  setPackArt(sealed.querySelector('.packSealedArtImg') as HTMLImageElement | null, kind);
}

/** Арт пачки в окне вскрытия (v2.23): цепочка /cosm/offers/<kind> → booster → процедурный щиток */
function setPackArt(img: HTMLImageElement | null, kind: string): void {
  if (!img) return;
  const inner = img.closest('.packSealedInner') as HTMLElement | null;
  if (inner) { inner.classList.remove('hasArt'); inner.style.removeProperty('--pack-art'); }
  const procedural = img.parentElement?.querySelector('.packSealedArt');
  procedural?.classList.remove('gone');
  img.classList.remove('artOn');
  img.style.removeProperty('display');
  const chain = [`/cosm/offers/${kind}?t=${Date.now()}`];
  if (kind !== 'booster') chain.push(`/cosm/offers/booster?t=${Date.now()}`);
  let i = 0;
  img.onload = () => {
    const inner = img.closest('.packSealedInner') as HTMLElement | null;
    if (inner) {
      inner.classList.add('hasArt');
      inner.style.setProperty('--pack-art', `url("${img.currentSrc || img.src}")`);
    }
    const proc = img.parentElement?.querySelector('.packSealedArt');
    if (proc) proc.classList.add('gone');
    // НЕ инлайн- opacity: inline перебил бы opacity:0 в фазе разрыва (.cracking)
    img.classList.add('artOn');
  };
  img.onerror = () => {
    i += 1;
    if (i < chain.length) { img.src = chain[i]; return; }
    img.style.display = 'none';
  };
  img.src = chain[0];
}

function hideSealedInstant(): void {
  const st = document.getElementById('packStage') as HTMLElement | null;
  const sealed = document.getElementById('packSealed') as HTMLElement | null;
  if (st) st.classList.remove('hasSealed','opening');
  if (sealed) { sealed.classList.add('hidden'); sealed.classList.remove('cracking'); }
  pendingPack = null;
  pendingPackKind = null;
}

function openBoosterPanel(returnFocusTo?: HTMLElement): void {
  if ($('battle').classList.contains('hidden')) setAppRoute('packs');
  $('menu').classList.add('hidden');
  for (const id of ['homeScreen','eventsScreen','decksScreen','collection','shopModal','bpModal','profileModal','campaignModal'])
    document.getElementById(id)?.classList.add('hidden');
  const modal = $('boosterModal');
  if (modal.classList.contains('hidden')) {
    const active = document.activeElement;
    boosterReturnFocus = returnFocusTo ?? (active instanceof HTMLElement ? active : null);
  }
  $('shopModal').classList.add('hidden');
  if (!pendingPack && !pendingPackKind) {
    hideSealedInstant();
    const row = document.getElementById('packRow');
    if (row) row.innerHTML = '';
    const stage = document.getElementById('packStage');
    stage?.classList.remove('hasResults','hasSealed','opening');
    const status = document.getElementById('packStageStatus');
    if (status) status.textContent = 'Выберите бустер слева';
    const flipAll = document.getElementById('btnPackFlip') as HTMLButtonElement | null;
    if (flipAll) flipAll.disabled = true;
  }
  modal.classList.remove('hidden');
  renderShards();
  window.requestAnimationFrame(() => {
    const first = document.querySelector<HTMLButtonElement>('.boosterInvCard.has-stock');
    (first ?? document.getElementById('btnPackNew') as HTMLButtonElement | null)?.focus();
  });
}

function closeBoosterPanel(renderCards = false): void {
  const stage = document.getElementById('packStage');
  if (!pendingPack && stage?.classList.contains('hasResults')) {
    stage.classList.remove('hasResults','hasSealed','opening');
    const row = document.getElementById('packRow'); if (row) row.innerHTML = '';
    const status = document.getElementById('packStageStatus'); if (status) status.textContent = 'Выберите бустер слева';
    const subtitle = document.getElementById('packTypeSubtitle'); if (subtitle) subtitle.textContent = 'Выберите тип · 5 карт в наборе';
    pendingPackKind = null;
    renderShards();
  }
  $('boosterModal').classList.add('hidden');
  if (renderCards) renderCollection();
  const target = boosterReturnFocus;
  boosterReturnFocus = null;
  if (target?.isConnected && !target.closest('.hidden')) target.focus();
  else document.getElementById('btnBoosters')?.focus();
}

function revealPack(): void {
  let slots = pendingPack;
  if (!slots) {
    const kind = pendingPackKind;
    if (!kind) return;
    if (kind === 'booster' || kind === 'booster_premium') {
      const available = kind === 'booster' ? (meta.freeOpens ?? 0) : (meta.premOpens ?? 0);
      if (available <= 0) {
        showToast('Этот тип бустера закончился — выберите другой');
        pendingPackKind = null;
        hideSealedInstant();
        renderShards();
        return;
      }
      if (kind === 'booster') meta.freeOpens = available - 1;
      else meta.premOpens = available - 1;
      metaSave();
      slots = kind === 'booster_premium' ? drawPremiumBooster() : drawBooster();
      pendingPack = slots;
      renderShards();
    } else {
      return;
    }
  }
  const st = document.getElementById('packStage') as HTMLElement | null;
  const sealed = document.getElementById('packSealed') as HTMLElement | null;
  if (!sealed || !st) { renderPackSlots(slots); pendingPack=null; return; }
  if (sealed.classList.contains('cracking')) return;
  st.classList.add('opening');
  sealed.classList.add('cracking');
  // вспышка под пачкой + ударные волны от разрыва (MTG)
  const burst = document.createElement('div');
  burst.className = 'packSealedBurst';
  sealed.parentElement?.appendChild(burst);
  void burst.offsetWidth; burst.classList.add('go');
  window.setTimeout(()=> burst.remove(), 800);
  ['packShockRing', 'packShockRing r2'].forEach((cls) => {
    const ring = document.createElement('div');
    ring.className = cls;
    sealed.parentElement?.appendChild(ring);
    void ring.offsetWidth; ring.classList.add('go');
    window.setTimeout(() => ring.remove(), 950);
  });
  try { Sfx.uiClick(); } catch {}
  // через треск — показываем карты как будто вылетели из пачки
  window.setTimeout(() => {
    sealed.classList.add('hidden');
    sealed.classList.remove('cracking');
    st.classList.remove('hasSealed','opening');
    renderPackSlots(slots);
    pendingPack = null;
  }, 560);
}

// ── объёмные объекты как в MTG: наклон от мыши + блик (рубашки, фоны, бустеры — art_raw вставишь сам) ──
function attachVolumetric(root: ParentNode = document): void {
  const selector = '.boosterInvCard, .packOffer, .ofCard, .bpTile, .packSealedInner, .cardback, .packSlot .back, .packSlot .face .card, .ofArt';
  const list = Array.from(root.querySelectorAll<HTMLElement>(selector));
  list.forEach(el => {
    if ((el as HTMLElement).dataset.volAttached) return;
    (el as HTMLElement).dataset.volAttached = '1';
    if (!el.querySelector(':scope > .volGlare')) {
      const g = document.createElement('div');
      g.className = 'volGlare';
      g.setAttribute('aria-hidden','true');
      el.appendChild(g);
    }
    if (getComputedStyle(el).position === 'static') (el as HTMLElement).style.position = 'relative';
    el.addEventListener('mousemove', (ev: Event) => {
      const e = ev as MouseEvent;
      const r = (el as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const rx = (0.5 - y) * 10;
      const ry = (x - 0.5) * 12;
      (el as HTMLElement).style.setProperty('--rx', rx.toFixed(2)+'deg');
      (el as HTMLElement).style.setProperty('--ry', ry.toFixed(2)+'deg');
      (el as HTMLElement).style.setProperty('--mx', (x*100).toFixed(1)+'%');
      (el as HTMLElement).style.setProperty('--my', (y*100).toFixed(1)+'%');
      el.classList.add('volTilt');
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('volTilt');
      (el as HTMLElement).style.removeProperty('--rx');
      (el as HTMLElement).style.removeProperty('--ry');
    });
  });
}


function renderPackSlots(slots: PackSlotData[]): void {
  const row = $('packRow');
  if (!row) return;
  const stage = document.getElementById('packStage');
  if (stage) { stage.classList.remove('hasSealed','opening'); stage.classList.add('hasResults'); }
  const status = document.getElementById('packStageStatus');
  if (status) status.textContent = slots.some(slot => slot.borderless)
    ? '◇ Borderless-вариант получен · косметика, правила карты не меняются'
    : 'Карты вскрыты · нажмите на каждую, чтобы перевернуть';
  const flipAll = document.getElementById('btnPackFlip') as HTMLButtonElement | null;
  if (flipAll) flipAll.disabled = slots.length === 0;
  row.innerHTML = '';
  // MTG-анимация: тряска при вскрытии
  row.classList.remove('crack'); void (row as HTMLElement).offsetWidth; row.classList.add('crack');
  setTimeout(()=> row.classList.remove('crack'), 520);
  for (let idx = 0; idx < slots.length; idx++) {
    const sl = slots[idx];
    const rarLc = String(sl.card.rarity).toLowerCase();
    const slot = el('div', 'packSlot dealIn' + (sl.foil ? ' foil' : '') + ' r-' + rarLc);
    (slot as HTMLElement).dataset.rarity = String(sl.card.rarity);
    (slot as HTMLElement).style.animationDelay = (idx * 90) + 'ms';
    slot.innerHTML = '<div class="back"><img class="backImg" alt="" loading="lazy"><div class="backSigil">✦</div><div class="backLabel">ЭХО</div></div><div class="face"></div>';
    // рубашка с пользовательским артом (art_raw/cosm/backs/classic|cardback) — иначе процедурный сигил
    {
      const bimg = slot.querySelector('.backImg') as HTMLImageElement | null;
      if (bimg) {
        const bq = `?t=${Date.now()}`;
        const bchain = [`/cosm/backs/classic${bq}`, `/cosm/backs/cardback${bq}`];
        let bi = 0;
        bimg.onload = () => bimg.classList.add('on');
        bimg.onerror = () => {
          bi++;
          if (bi < bchain.length) bimg.src = bchain[bi];
          else bimg.remove();
        };
        bimg.src = bchain[0];
      }
    }
    const face = slot.querySelector('.face') as HTMLElement;
    if (sl.borderless) slot.classList.add('borderlessBonusSlot');
    // Никаких дополнительных надписей на лице: тот же арт/текст, только Borderless-рамка снята.
    face.appendChild(renderCard(sl.card, sl.borderless ? 'borderless' : 'auto'));
    if (sl.converted > 0) face.appendChild(el('div', 'convNote', `дубликат → 🪙${sl.converted}`));
    if (sl.foil) face.appendChild(el('div', 'foilNote', '✦ фойл'));
    const doFlip = (): void => {
      if (slot.classList.contains('flip')) return;
      slot.classList.add('flip');
      // MTG: более редкие — с эффектом (rare-синяя, epic-фиолетовая, legendary-золотая вспышка)
      const rarLc2 = String(sl.card.rarity).toLowerCase();
      if (rarLc2 === 'rare' || rarLc2 === 'epic' || rarLc2 === 'legendary') {
        slot.classList.add('burst');
        setTimeout(()=> slot.classList.remove('burst'), 900);
        // лёгкая вибрация/звук для редких
        try { navigator.vibrate?.(rarLc2==='legendary'?[30,20,40]:rarLc2==='epic'?[22]:[14]); } catch {}
      }
      try { (window as unknown as { Sfx?: { uiClick: ()=>void }}).Sfx?.uiClick?.(); } catch {}
      try { Sfx.uiClick(); } catch {}
    };
    slot.addEventListener('click', doFlip);
    // клавиатура: Enter/Space тоже переворачивает
    slot.setAttribute('role','button'); slot.setAttribute('tabindex','0');
    slot.addEventListener('keydown', (ev: KeyboardEvent) => { if (ev.key==='Enter'||ev.key===' ') { ev.preventDefault(); doFlip(); } });
    row.appendChild(slot);
    // вылет из центра — оттуда, где стояла пачка (как в MTG Arena)
    {
      const rc = (row as HTMLElement).clientWidth / 2;
      const sc = (slot as HTMLElement).offsetLeft + (slot as HTMLElement).offsetWidth / 2;
      (slot as HTMLElement).style.setProperty('--dx', Math.round(rc - sc) + 'px');
      (slot as HTMLElement).style.setProperty('--dy', '-54px');
    }
  }
  try { attachVolumetric(row); } catch {}
}
function selectStoredBooster(kind: 'booster' | 'booster_premium'): boolean {
  if (pendingPack || document.getElementById('packStage')?.classList.contains('hasResults')) {
    showToast('Тип бустера нельзя менять после вскрытия карт'); return false;
  }
  const available = kind === 'booster' ? (meta.freeOpens ?? 0) : (meta.premOpens ?? 0);
  if (available <= 0) { showToast('Этого типа бустера нет в запасе'); return false; }
  if (pendingPackKind === kind && document.getElementById('packStage')?.classList.contains('hasSealed')) return true;
  showSealedPack(null, kind);
  renderPackInventory();
  return true;
}
function newPack(): boolean { return selectStoredBooster('booster'); }
/** Премиум-бустер (награда пропуска 15 ур.; решение пользователя «редкий бустер»):
 *  5 карт = 2 обычных + 1 редкая + 2 эпических+, каждая с шансом 12.5% стать легендарной. */
function drawPremiumBooster(): PackSlotData[] {
  const ep = (): Rarity => (Math.random() < 0.125 ? Rarity.Legendary : Rarity.Epic);
  return drawBooster(undefined, [Rarity.Common, Rarity.Common, Rarity.Rare, ep(), ep()]);
}
function newPremPack(): boolean { return selectStoredBooster('booster_premium'); }
function renderPackInventory(): void {
  const host = document.getElementById('boosterInventory');
  if (!host) return;
  const standard = Math.max(0, Number(meta.freeOpens ?? 0) || 0);
  const premium = Math.max(0, Number(meta.premOpens ?? 0) || 0);
  const packs = [
    { kind: 'standard', packKind: 'booster', art: 'booster', title: 'Бустер «Эхо-Цитадель»', sub: '5 карт · 0,1% шанс на Borderless-бонус', count: standard, mark: 'ECH I', sigil: '✦' },
    { kind: 'premium', packKind: 'booster_premium', art: 'booster_premium', title: 'Мифический бустер', sub: '5 карт · 0,1% шанс на Borderless-бонус', count: premium, mark: 'MYTHIC', sigil: '✦' },
  ];
  const total = standard + premium;
  const packStage = document.getElementById('packStage');
  const selectionLocked = !!pendingPack || !!packStage?.classList.contains('opening') || !!packStage?.classList.contains('hasResults');
  const totalNode = document.getElementById('boosterCountTotal');
  if (totalNode) totalNode.textContent = String(total);
  host.innerHTML = packs.map(p => `<button type="button" class="boosterInvCard${p.count > 0 ? ' has-stock' : ''}${pendingPackKind === p.packKind ? ' selected' : ''}" data-pack="${p.kind}" ${p.count <= 0 || selectionLocked ? 'disabled' : ''}
      aria-pressed="${pendingPackKind === p.packKind}" aria-label="${selectionLocked ? 'Сначала закройте просмотр уже вскрытых карт' : p.count > 0 ? `Выбрать ${p.title}, в запасе ${p.count}; списание при вскрытии` : `${p.title}, нет в запасе`}">
      <span class="boosterInvVisual">
        <span class="boosterInvFallback" aria-hidden="true"><b>${p.sigil}</b><small>${p.mark}</small></span>
        ${cosmImg('offers', p.art, 'boosterInvArt')}
        <span class="boosterInvCount">×${p.count}</span>
      </span>
      <span class="boosterInvCopy"><strong>${p.title}</strong><small>${p.sub}</small>
        <span class="boosterInvOpen">${p.count > 0 ? (pendingPackKind === p.packKind ? 'Выбрано · нажмите пачку для вскрытия' : 'Выбрать · запас спишется при вскрытии →') : 'Нет в запасе'}</span></span>
    </button>`).join('');
  host.querySelectorAll<HTMLImageElement>('.boosterInvArt').forEach(img => {
    const markArt = (): void => img.closest('.boosterInvVisual')?.classList.add('hasArt');
    img.addEventListener('load', markArt, { once: true });
    if (img.complete && img.naturalWidth > 0) markArt();
  });
  host.querySelectorAll<HTMLButtonElement>('.boosterInvCard').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.pack === 'standard') newPack();
      else if (button.dataset.pack === 'premium') newPremPack();
    });
  });
  try { attachVolumetric(host); } catch {}
}
/** Бустер фракции использует весь набор карт этой фракции, кроме Neutral как отдельного пула. */
function drawFactionPack(fac: string): PackSlotData[] {
  const all = [...db.values()];
  let pool = all.filter(c => c.faction === fac);
  if (pool.length < 8) pool = all;
  const comp: Rarity[] = [Rarity.Common, Rarity.Common, Rarity.Common, Rarity.Rare,
    Math.random() < 0.125 ? Rarity.Legendary : Rarity.Epic];
  const foilIdx = Math.random() < 0.2 ? Math.floor(Math.random() * 5) : -1;
  const out: PackSlotData[] = [];
  comp.forEach((rar, i) => {
    const cand = pool.filter(c => c.rarity === rar);
    const src = cand.length ? cand : pool;
    const c = src[Math.floor(Math.random() * src.length)];
    let converted = 0;
    const have = owned.get(c.id) ?? 0;
    if (have < PLAYSET) owned.set(c.id, have + 1);
    else converted += CONVERT[c.rarity] ?? 20;
    const foil = i === foilIdx;
    if (foil) { const fh = foils.get(c.id) ?? 0; if (fh < PLAYSET) foils.set(c.id, fh + 1); }
    if (converted > 0) shardsAdd(converted);
    out.push({ card: c, foil, converted });
  });
  const bonus = maybeBorderlessPackBonus();
  if (bonus) out.push({ card: bonus, foil: false, converted: 0, borderless: true, bonus: true });
  meta.packs += 1; questBump('pack'); checkAchs(); metaSave();
  return out;
}
function craftCard(id: string): string {
  const c = db.get(id);
  if (!c) return 'Карта не найдена';
  const have = ownedCount(id);
  const cost = CRAFT_COST[c.rarity] ?? 100;
  if (have >= PLAYSET) return 'Достигнут предел 4 копий';
  if (shardsGet() < cost) return `Нужно ${cost} монет`;
  shardsAdd(-cost);
  owned.set(id, have + 1); ownedSave(); renderShards();
  return `Создано за ${cost} монет`;
}
function disenchantCard(id: string): string {
  const c = db.get(id);
  if (!c) return 'Карта не найдена';
  const have = ownedCount(id);
  const min = STARTER_CARD_IDS.has(id) ? 1 : 0; // оставить одну копию из бесплатного стартового набора
  if (have <= min) return min === 1 ? 'Последнюю стартовую копию нельзя разобрать' : 'Нет копий';
  owned.set(id, have - 1); ownedSave();
  const coins = DISENCHANT_COINS[c.rarity] ?? 20;
  shardsAdd(coins); renderShards();
  return `Разобрано: +${coins} монет`;
}

function renderShards(): void {
  const b = $('shardBal');
  if (b) b.textContent = String(shardsGet());
  const g = $('gemBal');
  if (g) g.textContent = String(gemsGet());
  const boosterShards = document.getElementById('boosterShardBal');
  if (boosterShards) boosterShards.textContent = String(shardsGet());
  const boosterGems = document.getElementById('boosterGemBal');
  if (boosterGems) boosterGems.textContent = String(gemsGet());
  renderPackInventory();
  const bb = $('btnPackNew') as HTMLButtonElement | null;
  if (bb) { bb.disabled = false; bb.textContent = 'Магазин бустеров'; bb.title = 'Перейти к наборам и купить бустеры'; }
  const bpr = $('btnPackPrem') as HTMLButtonElement | null;
  if (bpr) {
    const stage = document.getElementById('packStage');
    bpr.disabled = (meta.premOpens ?? 0) <= 0 || !!pendingPack || !!stage?.classList.contains('opening') || !!stage?.classList.contains('hasResults');
    bpr.textContent = `🌟 Премиум-бустер · ×${meta.premOpens ?? 0}`;
  }
  const bc = $('btnCollection');
  if (bc) {
    const lbl = bc.querySelector('.ecLbl');
    if (lbl) lbl.textContent = `Коллекция (${ALL_CARDS.length} карт)`;
    else bc.textContent = `Коллекция (${ALL_CARDS.length} карт)`;
  }
  const bp = $('btnBP');
  if (bp) {
    const days = seasonDaysLeft();
    bp.title = `Боевой пропуск сезона: 50 уровней, две ветки наград · до конца сезона ${days} дн.`;
  }
}
function seasonDaysLeft(): number {
  return Math.max(0, Math.ceil((meta.seasonStart + SEASON_MS - Date.now()) / 86400000));
}

/** Выбор фракции (спека п.1.1): сохранение между запусками, клик+whoosh, кроссфейд фона. */
function pickFaction(f: Faction): void {
  const changed = f !== picked;
  picked = f;
  menuSelectedDeckId = starterDeckForFaction(f)?.id ?? f;
  saveMenuDeck();
  savePicked();
  Sfx.uiClick();
  if (changed) Sfx.whoosh();
  buildMenu();               // перерисовать сферы/карточки и синхронизировать выбор
  updateChallengePanel();
}

/* ── PATCH v2.13.0: MTG Arena гибрид — экран колод + верхняя навигация ── */
let decksSelectedId: string | null = null;
let decksFilterQ = "";
let decksSort: string = "modified";
let decksFormat: string = "all";

function syncTopWallet(): void {
  const s = document.getElementById('topShardBal') as HTMLElement | null;
  const g = document.getElementById('topGemBal') as HTMLElement | null;
  if (s) s.textContent = fmtNum(shardsGet());
  if (g) g.textContent = fmtNum(gemsGet());
  const oldS = document.getElementById('shardBal') as HTMLElement | null;
  const oldG = document.getElementById('gemBal') as HTMLElement | null;
  if (oldS) oldS.textContent = String(shardsGet());
  if (oldG) oldG.textContent = String(gemsGet());
  updateEcProfile();
  updateChallengePanel();
}
// wrap renderShards to also sync top
const _origRenderShards = (typeof renderShards !== 'undefined' ? renderShards : null) as any;
if (_origRenderShards) {
  // monkey patch after definition; we will redefine renderShards wrapper later
}

function getAllDecksForGrid(): Array<{ id: string; name: string; faction: string; cards: string[]; format?: string; avatarCardId?: string; updated: number; isPrecon: boolean }> {
  const all: Array<{ id: string; name: string; faction: string; cards: string[]; format?: string; avatarCardId?: string; updated: number; isPrecon: boolean }> = [];
  for (const d of deckList) {
    if (d.id === 'Starter') continue; // служебная смешанная колода не является выбором игрока
    all.push({ id: d.id, name: d.name, faction: d.faction, cards: d.cards.slice(), format: d.format, updated: 0, isPrecon: true });
  }
  for (const c of loadCustomDecks()) {
    all.push({
      id: c.id, name: c.name, faction: c.faction, cards: c.cards.slice(),
      avatarCardId: c.avatarCardId, updated: c.updated ?? 0, isPrecon: false,
    });
  }
  return all;
}

/** Для обложки выбираем выразительную карту: сначала редкость, затем существо и стоимость. */
function deckArtCards(cardIds: string[]): CardData[] {
  const rarityRank: Record<string, number> = {
    [Rarity.Legendary]: 4, [Rarity.Epic]: 3, [Rarity.Rare]: 2, [Rarity.Uncommon]: 1, [Rarity.Common]: 0,
  };
  return [...new Set(cardIds)]
    .map(id => db.get(id))
    .filter((card): card is CardData => !!card)
    .sort((a, b) =>
      (rarityRank[b.rarity] ?? 0) - (rarityRank[a.rarity] ?? 0)
      || Number(b.type === CardType.Creature) - Number(a.type === CardType.Creature)
      || b.cost - a.cost
      || cardName(a).localeCompare(cardName(b), 'ru'));
}

function suggestedDeckArt(cardIds: string[]): CardData | undefined {
  return deckArtCards(cardIds)[0];
}

function deckColorIcon(faction: string): string {
  const sig: Record<string,string> = { Aurites:'✵', Necrus:'☠', Terramorph:'⛰', Pyromancer:'🜂', Ethereal:'☁', Neutral:'◈' };
  const bg: Record<string,string> = {
    Aurites:'radial-gradient(circle at 30% 30%,#f5d76e,#b89a2a)',
    Necrus:'radial-gradient(circle at 30% 30%,#a855c9,#5a2a7a)',
    Terramorph:'radial-gradient(circle at 30% 30%,#5aa648,#2c4a20)',
    Pyromancer:'radial-gradient(circle at 30% 30%,#ff7a18,#a33a0a)',
    Ethereal:'radial-gradient(circle at 30% 30%,#3fd6c8,#1a5a56)',
    Neutral:'radial-gradient(circle at 30% 30%,#9aa3ad,#4a4e56)',
  };
  return `<span class="deckCIcon" style="background:${bg[faction] ?? bg.Neutral}" title="${FACTION_RU[faction as Faction] ?? faction}">${sig[faction] ?? '◈'}</span>`;
}

function renderDeckGrid(): void {
  const grid = document.getElementById('deckGrid') as HTMLElement | null;
  const countEl = document.getElementById('decksCount') as HTMLElement | null;
  if (!grid) return;
  const q = decksFilterQ.trim().toLowerCase();
  const activeColors = new Set<string>();
  document.querySelectorAll('#decksColorFilters .colorDot.on').forEach(el => {
    const f = (el as HTMLElement).dataset.f;
    if (f) activeColors.add(f);
  });
  // if Neutral is on, it means show all; but we treat it as wildcard: if all 6 are on, show all
  const allColorsOn = document.querySelectorAll('#decksColorFilters .colorDot').length === document.querySelectorAll('#decksColorFilters .colorDot.on').length;
  let all = getAllDecksForGrid();
  // filter
  all = all.filter(d => {
    if (q && !d.name.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q)) return false;
    if (!allColorsOn) {
      if (!activeColors.has(d.faction) && !(d.faction==='Neutral' && activeColors.has('Neutral'))) {
        // if faction not in active, hide
        // but for Neutral filter, we still show? simplfy: require faction in set
        return false;
      }
    }
    if (decksFormat === 'standard' && d.isPrecon && d.id==='Starter') return false; // example
    return true;
  });
  // sort
  if (decksSort === 'name') all.sort((a,b)=> a.name.localeCompare(b.name,'ru'));
  else if (decksSort === 'faction') all.sort((a,b)=> a.faction.localeCompare(b.faction));
  else {
    // modified: customs by updated desc, then precon order
    all.sort((a,b)=> (b.updated||0)-(a.updated||0));
  }
  grid.innerHTML = '';
  // addBox first
  const addBox = document.createElement('button');
  addBox.type = 'button';
  addBox.className = 'deckBox addBox';
  addBox.title = 'Создать новую колоду';
  addBox.setAttribute('aria-label', 'Создать новую колоду');
  addBox.innerHTML = `<div class="deckAddIcon">+</div><div class="deckAddLabel">Новая колода</div>`;
  addBox.addEventListener('click', () => {
    Sfx.uiClick();
    // create new deck flow: open builder with new editing
    const fac = (document.getElementById('dbFaction') as HTMLSelectElement | null)?.value as Faction || picked as Faction;
    editing = newEditing(fac);
    // open collection builder
    openCollectionScreen();
    // switch to builder tab
    const tabB = document.getElementById('tabBuilder') as HTMLButtonElement | null;
    if (tabB) tabB.click();
    else {
      // fallback direct
      (window as any).setTab?.(true);
    }
  });
  grid.appendChild(addBox);
  for (const d of all) {
    const isSel = decksSelectedId === d.id;
    const box = document.createElement('div');
    box.className = 'deckBox' + (isSel ? ' sel' : '');
    box.dataset.deckId = d.id;
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Колода «${d.name}», ${FACTION_RU[d.faction as Faction] ?? d.faction}, ${d.cards.length} карт. Нажмите Enter, чтобы выбрать.`);
    // Для пользовательской колоды используем выбранную карту; для старых колод
    // подбираем выразительную обложку автоматически. Пути img/decks/<id>.png для
    // ручных артов преконструктов сохраняются, а card-art служит их резервом.
    const firstCard = d.cards[0] ? db.get(d.cards[0]) : null;
    const chosenAvatar = d.avatarCardId && d.cards.includes(d.avatarCardId) ? db.get(d.avatarCardId) : null;
    const suggestedAvatar = suggestedDeckArt(d.cards) ?? firstCard ?? null;
    const avatarCard = chosenAvatar ?? (!d.isPrecon ? suggestedAvatar : null);
    const artCard = avatarCard ?? suggestedAvatar;
    const artFaction = artCard?.faction ?? d.faction;
    const artId = artCard?.id ?? d.id;
    const cardArtUrl = `/art/${encodeURIComponent(artFaction)}/${encodeURIComponent(artId)}.png`;
    const fallbackSig = FACTION_SIGIL[d.faction as Faction] ?? '✦';
    const deckArtUrl = `img/decks/${encodeURIComponent(d.id)}.png`;
    const artHtml = avatarCard
      ? `<img class="deckAvatarImg" src="${cardArtUrl}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
      : `<img class="deckPresetArt" src="${deckArtUrl}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='block'"><img class="deckCardArtFallback" src="${cardArtUrl}" alt="" loading="lazy" decoding="async" style="display:none" onerror="this.style.display='none'">`;
    const avatarTag = avatarCard
      ? `<span class="deckAvatarTag" title="Обложка: ${esc(cardName(avatarCard))}">🎴 ${esc(cardName(avatarCard))}</span>`
      : '';
    const artEdit = !d.isPrecon
      ? `<button class="deckArtEdit" type="button" title="Выбрать арт из карт этой колоды" aria-label="Выбрать арт для колоды «${esc(d.name)}»" data-deck-art-edit="${esc(d.id)}"><span aria-hidden="true">✦</span> Изменить арт</button>`
      : '';
    box.dataset.avatarCardId = avatarCard?.id ?? '';
    box.title = avatarCard ? `${d.name} · обложка: ${cardName(avatarCard)}` : d.name;
    const deckArtClass = `deckArt f-${d.faction}`;
    // deck colors: show faction icon(s) — for now single faction + minor splashes?
    // compute secondary factions from cards
    const facSet = new Set<string>();
    facSet.add(d.faction);
    for (const cid of d.cards.slice(0,12)) {
      const c = db.get(cid);
      if (c && c.faction !== d.faction && c.faction !== 'Neutral') facSet.add(c.faction);
      if (facSet.size >= 3) break;
    }
    const colorsHtml = Array.from(facSet).slice(0,3).map(f=> deckColorIcon(f)).join('');
    box.innerHTML = `
      <div class="${deckArtClass}">${artHtml}<span class="deckArtFallback" aria-hidden="true">${fallbackSig}</span>${avatarTag}</div>
      <div class="deckLabel">
        <div class="deckName" title="${esc(d.name)}">${esc(d.name)}</div>
        <div class="deckMeta"><div class="deckColors">${colorsHtml}</div><span class="deckCount">${d.format === STARTER_DECK_FORMAT ? 'Стартовая · 30 карт' : `${d.cards.length} карт`}</span></div>
        ${artEdit}
      </div>
      <span class="selCheck">✓</span>
    `;
    box.addEventListener('click', () => {
      Sfx.uiClick();
      decksSelectedId = d.id;
      renderDeckGrid();
      updateDecksFooter();
    });
    box.addEventListener('keydown', ev => {
      if (ev.target !== box || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault(); box.click();
    });
    const artButton = box.querySelector('.deckArtEdit') as HTMLButtonElement | null;
    artButton?.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      Sfx.uiClick();
      decksSelectedId = d.id;
      document.querySelectorAll<HTMLElement>('#deckGrid .deckBox[data-deck-id]').forEach(tile => {
        tile.classList.toggle('sel', tile.dataset.deckId === d.id);
      });
      updateDecksFooter();
      openSavedDeckArtPicker(d.id);
    });
    box.addEventListener('dblclick', () => {
      decksSelectedId = d.id;
      // double click = edit
      const btn = document.getElementById('btnDecksEdit') as HTMLButtonElement | null;
      if (btn && !btn.disabled) btn.click();
    });
    grid.appendChild(box);
  }
  if (countEl) {
    const n = all.length;
    const n10 = n % 10; const n100 = n % 100;
    const w = (n10 === 1 && n100 !== 11) ? 'колода' : (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) ? 'колоды' : 'колод';
    countEl.textContent = `${n} ${w}`;
  }
  updateDecksFooter();
  syncTopWallet();
}

let deckArtReturnFocus: HTMLElement | null = null;
let deckArtReturnDeckId: string | null = null;

function closeDeckArtPicker(): void {
  const modal = document.getElementById('deckArtPickerModal');
  modal?.classList.add('hidden');
  const focus = deckArtReturnFocus;
  const deckId = deckArtReturnDeckId;
  deckArtReturnFocus = null;
  deckArtReturnDeckId = null;
  if (focus?.isConnected) focus.focus();
  else if (deckId) {
    const replacement = [...document.querySelectorAll<HTMLButtonElement>('.deckArtEdit')]
      .find(button => button.dataset.deckArtEdit === deckId);
    replacement?.focus();
  }
}

function renderDeckArtPicker(
  cardIds: string[], selectedId: string | null, deckName: string,
  onPick: (card: CardData) => void, returnDeckId: string | null,
): void {
  const modal = document.getElementById('deckArtPickerModal');
  const grid = document.getElementById('deckArtPickerGrid');
  const title = document.getElementById('deckArtPickerTitle');
  const hint = document.getElementById('deckArtPickerHint');
  if (!modal || !grid || !title || !hint) return;

  deckArtReturnFocus = document.activeElement as HTMLElement | null;
  deckArtReturnDeckId = returnDeckId;
  title.textContent = 'Выберите арт колоды';
  hint.textContent = `${deckName ? `«${deckName}» · ` : ''}Выберите карту из состава. Арт будет показан целиком, без обрезки.`;
  grid.replaceChildren();

  const options = deckArtCards(cardIds);
  if (!options.length) {
    const empty = el('div', 'deckArtPickerEmpty');
    empty.textContent = 'Добавьте карты в колоду, чтобы выбрать обложку.';
    grid.appendChild(empty);
  }
  for (const card of options) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'deckArtChoice' + (card.id === selectedId ? ' isSelected' : '');
    choice.dataset.cardId = card.id;
    choice.setAttribute('aria-pressed', card.id === selectedId ? 'true' : 'false');
    choice.setAttribute('aria-label', `Выбрать арт карты «${cardName(card)}»`);
    choice.title = cardName(card);

    const media = el('span', 'deckArtChoiceMedia');
    media.setAttribute('aria-hidden', 'true');
    const fallback = el('span', 'deckArtChoiceFallback', FACTION_SIGIL[card.faction] ?? '◇');
    media.appendChild(fallback);
    const image = document.createElement('img');
    image.src = `/art/${encodeURIComponent(card.faction)}/${encodeURIComponent(card.id)}.png`;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.onerror = () => image.remove();
    media.appendChild(image);

    const info = el('span', 'deckArtChoiceInfo');
    const name = el('span', 'deckArtChoiceName');
    name.textContent = cardName(card);
    const detail = el('span', 'deckArtChoiceDetail');
    detail.textContent = `${RARITY_RU[card.rarity] ?? card.rarity} · ${card.cost} маны`;
    const selected = el('span', 'deckArtChoiceSelected', '✓ На обложке');
    info.append(name, detail, selected);
    choice.append(media, info);
    choice.addEventListener('click', () => { onPick(card); closeDeckArtPicker(); });
    grid.appendChild(choice);
  }
  modal.classList.remove('hidden');
  (document.getElementById('btnDeckArtPickerClose') as HTMLButtonElement | null)?.focus();
}

function openSavedDeckArtPicker(deckId: string): void {
  const deck = loadCustomDecks().find(item => item.id === deckId);
  if (!deck) { showToast('Сохранённая колода не найдена'); return; }
  const current = deck.avatarCardId && deck.cards.includes(deck.avatarCardId)
    ? deck.avatarCardId : suggestedDeckArt(deck.cards)?.id ?? null;
  renderDeckArtPicker(deck.cards, current, deck.name, card => {
    const latest = loadCustomDecks().find(item => item.id === deckId);
    if (!latest || !latest.cards.includes(card.id)) { showToast('Карта больше не входит в эту колоду'); return; }
    upsertCustomDeck({ ...latest, avatarCardId: card.id, updated: Date.now() });
    renderDeckGrid();
    showToast(`Обложка «${cardName(card)}» сохранена`);
  }, deckId);
}

function openEditorDeckArtPicker(): void {
  if (!editing) return;
  renderDeckArtPicker(editingCards(), editing.avatarCardId, editing.name, card => {
    if (!editing?.counts.has(card.id)) return;
    editing.avatarCardId = card.id;
    const avatarSelect = document.getElementById('dbAvatarCard') as HTMLSelectElement | null;
    if (avatarSelect) avatarSelect.value = card.id;
    renderDeckAvatarPreview();
  }, null);
}

function deckPlayProblem(deck: DeckLike): string | null {
  const minimum = isStarterDeckId(deck.id) ? 30 : 60;
  const sizeCheck = validateDeckSize(deck.cards, dbLookup, minimum);
  if (!sizeCheck.ok) return sizeCheck.problems[0] ?? 'колода не собрана';
  if (!isStarterDeckId(deck.id)) {
    if (!deckById.has(deck.id)) {
      const factionCheck = validateDeck(deck.cards, deck.faction, dbLookup);
      if (!factionCheck.ok) return factionCheck.problems[0] ?? 'состав колоды некорректен';
    }
    const counts = new Map<string, number>();
    for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const have = ownedCount(id);
      if (count > have) return `«${dbLookup(id)?.name ?? id}»: в коллекции ${have} из ${count} нужных копий`;
    }
  }
  return null;
}

function launchDeckForBattle(deckId: string): boolean {
  const deck = resolveDeck(deckId, deckList as unknown as DeckLike[]);
  if (!deck) { showToast('Колода не найдена'); return false; }
  const problem = deckPlayProblem(deck);
  if (problem) { showToast(`Нельзя начать бой: ${problem}`); return false; }

  // Фракция пользовательской колоды определяет пассивку и сторону игрока.
  if (FACTION_IDS.includes(deck.faction as Faction)) picked = deck.faction as Faction;
  menuSelectedDeckId = deck.id;
  saveMenuDeck();
  savePicked();
  buildMenu();
  sel('deckPick').value = deck.id;
  updatePlayGate();
  if (btn('btnPlay').disabled) {
    showToast(btn('btnPlay').title || 'Эта колода пока недоступна');
    return false;
  }
  const enemySelect = sel('enemyFaction');
  if (enemySelect.value === picked) {
    enemySelect.value = FACTION_IDS.find(f => f !== picked) ?? '__random';
  }
  battle.playerDeckId = deck.id;
  battle.playerFaction = picked;
  battle.launchMode = 'menu';
  openHomeScreen();
  btn('btnPlay').click();
  return true;
}

function updateDecksFooter(): void {
  const selId = decksSelectedId;
  const sel = selId ? getAllDecksForGrid().find(d=> d.id===selId) : null;
  const info = document.getElementById('decksSelInfo') as HTMLElement | null;
  const btnEdit = document.getElementById('btnDecksEdit') as HTMLButtonElement | null;
  const btnPlayDeck = document.getElementById('btnDecksPlay') as HTMLButtonElement | null;
  const btnExp = document.getElementById('btnDecksExport') as HTMLButtonElement | null;
  const btnClone = document.getElementById('btnDecksClone') as HTMLButtonElement | null;
  const btnDel = document.getElementById('btnDecksDelete') as HTMLButtonElement | null;
  if (info) info.textContent = sel ? `${sel.name} · ${FACTION_RU[sel.faction as Faction] ?? sel.faction} · ${sel.cards.length} карт` : 'Выберите колоду';
  if (btnEdit) btnEdit.disabled = !sel;
  if (btnPlayDeck) {
    const problem = sel ? deckPlayProblem(sel) : null;
    btnPlayDeck.disabled = !sel || !!problem;
    btnPlayDeck.title = problem ? `Нельзя начать бой: ${problem}` : 'Начать бой выбранной колодой';
  }
  if (btnExp) btnExp.disabled = !sel;
  if (btnClone) btnClone.disabled = !sel;
  if (btnDel) {
    const isCustom = sel ? !sel.isPrecon : false;
    btnDel.disabled = !isCustom;
    btnDel.title = isCustom ? 'Удалить пользовательскую колоду' : sel ? 'Преконструкт нельзя удалить' : '';
  }
  // also update deckPick main menu
  if (sel) {
    const dp = document.getElementById('deckPick') as HTMLSelectElement | null;
    if (dp) {
      dp.value = sel.id;
      updatePlayGate();
    }
  }
}

function openDecksScreen(): void {
  setAppRoute('decks');
  $('menu').classList.add('hidden');
  $('homeScreen')?.classList.add('hidden');
  $('eventsScreen')?.classList.add('hidden');
  Sfx.uiClick();
  // hide other modals
  $('collection').classList.add('hidden');
  $('shopModal').classList.add('hidden');
  $('bpModal').classList.add('hidden');
  $('profileModal').classList.add('hidden');
  $('campaignModal').classList.add('hidden');
  $('boosterModal').classList.add('hidden');
  const ds = document.getElementById('decksScreen') as HTMLElement | null;
  if (ds) ds.classList.remove('hidden');
  // update top tabs
  document.querySelectorAll('.topTab').forEach(el=> el.classList.toggle('active', (el as HTMLElement).dataset.tab==='decks'));
  renderDeckGrid();
}

function closeDecksScreen(): void {
  const ds = document.getElementById('decksScreen') as HTMLElement | null;
  if (ds) ds.classList.add('hidden');
  document.querySelectorAll('.topTab').forEach(el=> el.classList.toggle('active', (el as HTMLElement).dataset.tab==='home'));
}

// wire top nav
document.querySelectorAll('.topTab').forEach(el=>{
  (el as HTMLElement).addEventListener('click', ()=>{
    const tab = (el as HTMLElement).dataset.tab;
    if (tab==='home') {
      Sfx.uiClick();
      closeDecksScreen();
      $('collection').classList.add('hidden');
      $('shopModal').classList.add('hidden');
      $('bpModal').classList.add('hidden');
      $('profileModal').classList.add('hidden');
      $('campaignModal').classList.add('hidden');
      $('boosterModal').classList.add('hidden');
      document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='home'));
    } else if (tab==='profile') {
      Sfx.uiClick();
      closeDecksScreen();
      openProfile();
      document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='profile'));
    } else if (tab==='decks') {
      openDecksScreen();
    } else if (tab==='packs') {
      Sfx.uiClick();
      closeDecksScreen();
      $('shopModal').classList.add('hidden');
      $('boosterModal').classList.remove('hidden');
      // show booster packs? open shop packs tab? For now boosterModal
      document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='packs'));
    } else if (tab==='store') {
      Sfx.uiClick();
      closeDecksScreen();
      openShop();
      document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='store'));
    } else if (tab==='mastery') {
      Sfx.uiClick();
      closeDecksScreen();
      openBP();
      document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='mastery'));
    }
  });
});

// top wallet settings
document.getElementById('btnTopSettings')?.addEventListener('click', ()=> {
  toggleSettings(); // единый вход: панель + скрим + синхронизация значений
});

// decks filters
document.getElementById('decksSearch')?.addEventListener('input', (ev)=>{
  decksFilterQ = (ev.target as HTMLInputElement).value;
  renderDeckGrid();
});
document.getElementById('decksSearchClear')?.addEventListener('click', ()=>{
  decksFilterQ = "";
  const inp = document.getElementById('decksSearch') as HTMLInputElement | null;
  if (inp) inp.value = "";
  renderDeckGrid();
});
document.getElementById('decksSort')?.addEventListener('change', (ev)=>{
  decksSort = (ev.target as HTMLSelectElement).value;
  renderDeckGrid();
});
document.getElementById('decksFormat')?.addEventListener('change', (ev)=>{
  decksFormat = (ev.target as HTMLSelectElement).value;
  renderDeckGrid();
});
document.querySelectorAll<HTMLButtonElement>('#decksColorFilters .colorDot').forEach(el=>{
  el.addEventListener('click', () => {
    const on = el.classList.toggle('on');
    el.setAttribute('aria-pressed', String(on));
    renderDeckGrid();
  });
});

// Deck-art picker: close on button or backdrop click; keyboard focus returns to the opener.
document.getElementById('btnDeckArtPickerClose')?.addEventListener('click', closeDeckArtPicker);
document.getElementById('btnDeckArtPickerDone')?.addEventListener('click', closeDeckArtPicker);
document.getElementById('deckArtPickerModal')?.addEventListener('click', ev => {
  if (ev.target === document.getElementById('deckArtPickerModal')) closeDeckArtPicker();
});

// decks footer buttons
document.getElementById('btnDecksClose')?.addEventListener('click', ()=>{ Sfx.uiClick(); navigateApp('back'); });
document.getElementById('btnDecksPlay')?.addEventListener('click', ()=>{
  if (decksSelectedId) launchDeckForBattle(decksSelectedId);
});
document.getElementById('btnDecksCollection')?.addEventListener('click', ()=>{
  Sfx.uiClick();
  openCollectionScreen();
});
document.getElementById('btnDecksImport')?.addEventListener('click', ()=>{
  Sfx.uiClick();
  const code = window.prompt('Вставьте код колоды:');
  if (!code) return;
  try {
    const ids = window.atob(code.trim()).split(',').filter(Boolean);
    const fac = db.get(ids[0])?.faction ?? 'Aurites';
    const check = validateDeck(ids, fac as Faction, ((id: string) => db.get(id)) as any);
    if (!check.ok) { showToast(`Импорт: ${check.problems.slice(0,2).join('; ')}`); return; }
    // check owned
    const unowned = ids.filter(id=> ownedCount(id)===0);
    if (unowned.length) { showToast(`Не получены карты (${unowned.length}) — сначала бустеры/крафт`); return; }
    const newId = `custom-${Date.now().toString(36)}`;
    const deck = { id: newId, name: `Импорт ${new Date().toLocaleDateString('ru-RU')}`, faction: fac, cards: ids, avatarCardId: suggestedDeckArt(ids)?.id ?? ids[0], updated: Date.now() } as any;
    upsertCustomDeck(deck);
    decksSelectedId = newId;
    renderDeckGrid();
    showToast(`Колода импортирована: ${deck.name}`);
  } catch { showToast('Некорректный код'); }
});
document.getElementById('btnDecksExport')?.addEventListener('click', ()=>{
  if (!decksSelectedId) return;
  const d = getAllDecksForGrid().find(x=> x.id===decksSelectedId);
  if (!d) return;
  const code = window.btoa(d.cards.join(','));
  try { navigator.clipboard?.writeText(code); } catch {}
  // show in prompt as fallback
  window.prompt(`Код колоды «${d.name}»:`, code);
  showToast('Код скопирован');
});
document.getElementById('btnDecksClone')?.addEventListener('click', ()=>{
  if (!decksSelectedId) return;
  const src = getAllDecksForGrid().find(x=> x.id===decksSelectedId);
  if (!src) return;
  const newId = `custom-${Date.now().toString(36)}`;
  const copy = { id: newId, name: `${src.name} (копия)`, faction: src.faction, cards: src.cards.slice(), avatarCardId: src.avatarCardId ?? suggestedDeckArt(src.cards)?.id ?? src.cards[0], updated: Date.now() } as any;
  upsertCustomDeck(copy);
  decksSelectedId = newId;
  renderDeckGrid();
  showToast(`Клон: ${copy.name}`);
});
document.getElementById('btnDecksDelete')?.addEventListener('click', ()=>{
  if (!decksSelectedId) return;
  const sel = getAllDecksForGrid().find(x=> x.id===decksSelectedId);
  if (!sel || sel.isPrecon) { showToast('Преконструкт нельзя удалить'); return; }
  if (!window.confirm(`Удалить колоду «${sel.name}»?`)) return;
  deleteCustomDeck(sel.id);
  decksSelectedId = null;
  renderDeckGrid();
  showToast('Колода удалена');
});
document.getElementById('btnDecksEdit')?.addEventListener('click', ()=>{
  if (!decksSelectedId) return;
  const sel = getAllDecksForGrid().find(x=> x.id===decksSelectedId);
  if (!sel) return;
  // open builder with this deck
  const counts = new Map<string,number>();
  for (const id of sel.cards) counts.set(id, (counts.get(id)??0)+1);
  editing = {
    id: sel.isPrecon ? null : sel.id,
    name: sel.name,
    faction: sel.faction as Faction,
    counts,
    avatarCardId: sel.avatarCardId ?? null,
  };
  openCollectionScreen();
  const tabB = document.getElementById('tabBuilder') as HTMLElement | null;
  if (tabB) tabB.click();
  // ensure deck faction selected
  const selFac = document.getElementById('dbFaction') as HTMLSelectElement | null;
  if (selFac) selFac.value = sel.faction;
  // render
  setTimeout(()=> { try { (window as any).renderEditor?.(); } catch {} }, 50);
  Sfx.uiClick();
});

// also patch initial wallet sync after load
setTimeout(syncTopWallet, 300);
setInterval(syncTopWallet, 1500);

// expose for smoke
(window as any).openDecksScreen = openDecksScreen;
(window as any).closeDecksScreen = closeDecksScreen;
(window as any).renderDeckGrid = renderDeckGrid;


/* ── PATCH v2.14.0: Home + Events + Store Featured (скрины 3,4,5,8) ── */
function openHomeScreen(): void {
  if (!$('battle').classList.contains('hidden')) {
    battle.tutCleanup();
    battle.stop();
    $('battle').classList.add('hidden');
  }
  $('gameover').classList.add('hidden');
  setAppRoute('home');
  Sfx.uiClick();
  // Хаб — само главное меню (новый макет): закрываем все поверхности и возвращаемся на hub.
  // Перестраиваем витрину при каждом возврате, чтобы импортированные/сохранённые колоды
  // сразу появлялись под карточками архетипов.
  buildMenu(false);
  $('decksScreen')?.classList.add('hidden');
  $('collection').classList.add('hidden');
  $('shopModal').classList.add('hidden');
  $('bpModal').classList.add('hidden');
  $('profileModal').classList.add('hidden');
  $('campaignModal').classList.add('hidden');
  $('boosterModal').classList.add('hidden');
  document.getElementById('eventsScreen')?.classList.add('hidden');
  document.getElementById('homeScreen')?.classList.add('hidden');
  $('menu').classList.remove('hidden');
  document.querySelectorAll('.topTab').forEach(el=> el.classList.toggle('active', (el as HTMLElement).dataset.tab==='home'));
  syncTopWallet();
}
function closeHomeScreen(): void {
  document.getElementById('homeScreen')?.classList.add('hidden');
  document.querySelectorAll('.topTab').forEach(el=> el.classList.toggle('active', (el as HTMLElement).dataset.tab==='home'));
}
function openEventsScreen(): void {
  setAppRoute('events');
  $('menu').classList.add('hidden');
  $('homeScreen')?.classList.add('hidden');
  Sfx.uiClick();
  $('decksScreen')?.classList.add('hidden');
  document.getElementById('homeScreen')?.classList.add('hidden');
  $('collection').classList.add('hidden');
  $('shopModal').classList.add('hidden');
  $('bpModal').classList.add('hidden');
  $('profileModal').classList.add('hidden');
  $('boosterModal').classList.add('hidden');
  $('campaignModal')?.classList.add('hidden');
  const es = document.getElementById('eventsScreen') as HTMLElement | null;
  if (es) es.classList.remove('hidden');
  // render grid like Arena events (screenshot 4)
  const grid = document.getElementById('eventsGrid') as HTMLElement | null;
  if (grid) {
    const borderlessProgress = Math.min(BORDERLESS_EVENT_WINS, meta.borderlessEventWins ?? 0);
    const canClaimBorderless = borderlessProgress >= BORDERLESS_EVENT_WINS && !meta.borderlessEventClaimed;
    const events: Array<{ title: string; sub: string; art: string; borderless?: boolean }> = [
      { title:'Галерея без границ', sub:'Событие · Borderless', art:'/art/Ethereal/eth_03.png', borderless:true },
      { title:'Премьер-драфт', sub:'Лимит', art:'/art/Pyromancer/pyr_01.png' },
      { title:'Быстрый старт', sub:'В быструю игру', art:'/art/Aurites/aur_01.png' },
      { title:'Испытание стихий', sub:'Обучение', art:'/art/Ethereal/eth_01.png' },
      { title:'Событие недели: Стандарт', sub:'Регистрация открыта', art:'/art/Terramorph/ter_01.png' },
      { title:'Неоновая аркада', sub:'Событие', art:'/art/Necrus/nec_01.png' },
      { title:'Классический драфт', sub:'Лимит', art:'/art/Aurites/aur_03.png' },
      { title:'Быстрый драфт', sub:'Лимит', art:'/art/Neutral/neu_01.png' },
      { title:'Турнир сборных колод', sub:'Конструктед', art:'/art/Ethereal/eth_03.png' },
      { title:'Классический драфт', sub:'Лимит', art:'/art/Ethereal/eth_03.png' },
      { title:'Классический турнир', sub:'Конструктед', art:'/art/Pyromancer/pyr_03.png' },
    ];
    grid.innerHTML = events.map(ev=> `
      <div class="draftCard${ev.borderless ? ' borderlessEventCard' : ''}" data-event-id="${ev.borderless ? 'borderless' : ''}" style="height:${ev.borderless ? '172px' : '118px'};flex-direction:column;align-items:stretch;padding:0;border-radius:8px;overflow:hidden">
        <div class="draftArt" style="position:absolute;inset:0"><img src="${ev.art}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
        <div class="eventArtShade"></div>
        <div class="eventCardCopy">
          <div class="eventCardTitle">${ev.title}</div>
          <div class="eventCardSub">${ev.sub}</div>
          ${ev.borderless ? `<div class="eventRewardBox">
            <div class="eventProgressLabel"><span>Рейтинговые победы</span><b>${borderlessProgress}/${BORDERLESS_EVENT_WINS}</b></div>
            <div class="eventProgressTrack"><i style="width:${borderlessProgress / BORDERLESS_EVENT_WINS * 100}%"></i></div>
            <button type="button" class="eventRewardClaim" data-borderless-claim ${canClaimBorderless ? '' : 'disabled'}>
              ${meta.borderlessEventClaimed ? 'Получено ✓' : canClaimBorderless ? 'Забрать Borderless награду' : `Ещё ${BORDERLESS_EVENT_WINS - borderlessProgress} победы`}
            </button>
            <small>1 косметический вариант карты · баланс не меняется</small>
          </div>` : ''}
        </div>
        ${ev.borderless ? '<span class="eventBorderlessTag">◇ BORDERLESS</span>' : ''}
      </div>
    `).join('');
    grid.onclick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const claim = target?.closest?.('[data-borderless-claim]') as HTMLButtonElement | null;
      if (claim) {
        ev.stopPropagation();
        if (claim.disabled || meta.borderlessEventClaimed) return;
        const reward = grantRandomBorderless();
        if (!reward) { showToast('Все Borderless-варианты уже собраны'); return; }
        meta.borderlessEventClaimed = true;
        metaSave();
        showToast(`◇ Получен Borderless-вариант: «${cardName(reward)}»`);
        openEventsScreen();
        return;
      }
      const tile = target?.closest?.('.draftCard') as HTMLElement | null;
      if (tile && tile.dataset.eventId !== 'borderless') showToast('Событие скоро откроется');
    };
    // сетка сама центрируется по max-width — мёртвый отступ справа не нужен
    (grid as any).style.marginRight = '';
  }
  syncTopWallet();
}
function closeEventsScreen(): void {
  document.getElementById('eventsScreen')?.classList.add('hidden');
}
// wire home/events buttons
document.getElementById('homePlayBtn')?.addEventListener('click', ()=>{
  Sfx.uiClick();
  closeHomeScreen();
  // launch battle with current deck
  const btnPlay = document.getElementById('btnPlay') as HTMLButtonElement | null;
  if (btnPlay) btnPlay.click();
});
document.querySelectorAll('.draftCard').forEach(el=>{
  (el as HTMLElement).addEventListener('click', ()=>{
    const d = (el as HTMLElement).dataset.draft;
    if (d) { Sfx.uiClick(); showToast(`Event: ${d} — скоро`); }
  });
});
document.getElementById('btnEventsClose')?.addEventListener('click', ()=>{
  Sfx.uiClick();
  navigateApp('back');
});

// patch topTab home/events handling: override previous listeners to route correctly
// remove old listeners by cloning topTabs
(function patchTopTabs2(){
  const tabs = document.querySelectorAll('.topTab');
  tabs.forEach(tab=>{
    const clone = (tab as HTMLElement).cloneNode(true) as HTMLElement;
    (tab as HTMLElement).parentNode?.replaceChild(clone, tab as HTMLElement);
  });
  document.querySelectorAll('.topTab').forEach(el=>{
    (el as HTMLElement).addEventListener('click', ()=>{
      const t = (el as HTMLElement).dataset.tab;
      if (t==='home') openHomeScreen();
      else if (t==='profile') { Sfx.uiClick(); document.getElementById('homeScreen')?.classList.add('hidden'); document.getElementById('eventsScreen')?.classList.add('hidden'); $('decksScreen')?.classList.add('hidden'); openProfile(); document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='profile')); }
      else if (t==='decks') { document.getElementById('homeScreen')?.classList.add('hidden'); document.getElementById('eventsScreen')?.classList.add('hidden'); openDecksScreen(); }
      else if (t==='packs') { openBoosterPanel(); document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='packs')); }
      else if (t==='store') { Sfx.uiClick(); document.getElementById('homeScreen')?.classList.add('hidden'); document.getElementById('eventsScreen')?.classList.add('hidden'); $('decksScreen')?.classList.add('hidden'); openShop(); document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='store')); }
      else if (t==='mastery') { Sfx.uiClick(); document.getElementById('homeScreen')?.classList.add('hidden'); document.getElementById('eventsScreen')?.classList.add('hidden'); $('decksScreen')?.classList.add('hidden'); openBP(); document.querySelectorAll('.topTab').forEach(x=> x.classList.toggle('active', (x as HTMLElement).dataset.tab==='mastery')); }
    });
  });
})();

// хаб — само главное меню; homeScreen (старый Arena-хаб) больше не открывается сам
setTimeout(()=>{ document.getElementById('homeScreen')?.classList.add('hidden'); syncTopWallet(); }, 250);

// Expose
(window as any).openHomeScreen = openHomeScreen;
(window as any).openEventsScreen = openEventsScreen;

// инициализация меню — buildMenu() вызывается в конце модуля (после dbLookup и меты)

/* ---- Модалка фракции (спека п.1.2): описание, механика, советы, примеры карт ---- */
let facModalFaction: Faction = Faction.Aurites;

function openFactionModal(f: Faction): void {
  facModalFaction = f;
  const info = FACTION_INFO[f as string];
  const col = colorOf(f);
  const m = $('factionModal');
  m.style.setProperty('--fac', col.primary);
  $('facSigil').textContent = FACTION_SIGIL[f] ?? '✦';
  ($('facSigil') as HTMLElement).style.color = col.primary;
  $('facName').textContent = info?.name ?? FACTION_RU[f];
  $('facTagline').textContent = info?.tagline ?? '';
  $('facDesc').textContent = info?.description ?? '';
  $('facMech').innerHTML = info?.mechanics ? esc(info.mechanics) : (PASSIVE_TEXT[f] ?? '');
  const tips = $('facTips');
  tips.innerHTML = '';
  for (const t of info?.tips ?? []) { const li = el('li'); li.textContent = t; tips.appendChild(li); }
  const ex = $('facExCards');
  ex.innerHTML = '';
  const examples = ALL_CARDS.filter(c => c.faction === f).sort((a, b) => a.cost - b.cost).slice(0, 3);
  for (const c of examples) ex.appendChild(renderCard(c));
  btn('btnFactionPlay').textContent = f === picked
    ? 'Выбрана ✓'
    : `Играть за «${info?.name ?? FACTION_RU[f]}»`;
  m.classList.remove('hidden');
}

function closeFactionModal(): void { $('factionModal').classList.add('hidden'); }

btn('btnFactionPlay').addEventListener('click', () => { pickFaction(facModalFaction); closeFactionModal(); });
btn('btnFactionClose').addEventListener('click', closeFactionModal);
btn('btnFactionClose2').addEventListener('click', closeFactionModal);
$('factionModal').addEventListener('click', ev => { if (ev.target === $('factionModal')) closeFactionModal(); });

/* ── Хаб меню v3: бургер-drawer, панель вызова, нижняя навигация, профиль ── */
function ecDrawer(open?: boolean): void {
  const nav = document.getElementById('arenaTopNav') as HTMLElement | null;
  if (!nav) return;
  const burger = document.getElementById('btnBurger') as HTMLElement | null;
  const should = open ?? !nav.classList.contains('ecOpen');
  nav.classList.toggle('ecOpen', should);
  burger?.setAttribute('aria-expanded', should ? 'true' : 'false');
}
document.getElementById('btnBurger')?.addEventListener('click', () => { Sfx.uiClick(); ecDrawer(); });
document.getElementById('ecScrim')?.addEventListener('click', () => ecDrawer(false));
document.getElementById('arenaTopNav')?.addEventListener('click', ev => {
  if ((ev.target as HTMLElement | null)?.closest?.('.topTab, .ecDrawerBtn')) ecDrawer(false);
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    const nav = document.getElementById('arenaTopNav');
    if (nav?.classList.contains('ecOpen')) ecDrawer(false);
  }
});
document.getElementById('enemyFaction')?.addEventListener('change', () => { Sfx.uiClick(); updateChallengePanel(); });
document.getElementById('chkPractice')?.addEventListener('change', () => { Sfx.uiClick(); updateChallengePanel(); });
document.getElementById('ecProfile')?.addEventListener('click', () => {
  Sfx.uiClick();
  document.querySelectorAll('.topTab').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.tab === 'profile'));
  openProfile();
});
document.getElementById('ecProfile')?.addEventListener('keydown', ev => {
  if ((ev as KeyboardEvent).key === 'Enter') (ev.currentTarget as HTMLElement).click();
});
document.getElementById('btnNavHome')?.addEventListener('click', () => openHomeScreen());
document.getElementById('btnNavDecks')?.addEventListener('click', () => openDecksScreen());
document.getElementById('btnNavQuests')?.addEventListener('click', () => {
  Sfx.uiClick();
  document.querySelectorAll('.topTab').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.tab === 'profile'));
  openProfile();
});
document.getElementById('btnNavMulti')?.addEventListener('click', () => openEventsScreen());
document.getElementById('btnNavPlay')?.addEventListener('click', () => btn('btnPlay').click());
document.getElementById('btnNavExit')?.addEventListener('click', () => {
  Sfx.uiClick();
  showToast('Выход из прототипа — просто закройте вкладку браузера');
  ecDrawer(false);
});
// активная кнопка нижней навигации
document.getElementById('menuNav')?.addEventListener('click', ev => {
  const b = (ev.target as HTMLElement | null)?.closest?.('.ecNavBtn') as HTMLElement | null;
  if (!b) return;
  document.querySelectorAll('#menuNav .ecNavBtn').forEach(x => x.classList.toggle('active', x === b));
});

function updateChallengePanel(): void {
  const evSel = document.getElementById('enemyFaction') as HTMLSelectElement | null;
  const ev = evSel ? evSel.value : '__random';
  const isRnd = ev === '__random';
  const foeFac = isRnd ? String(picked) : ev;
  const foe = HUB_FOE[foeFac];
  const nameEl = document.getElementById('ecOppName');
  const rankEl = document.getElementById('ecOppRank');
  const lvlEl = document.getElementById('ecOppLvl');
  if (nameEl) nameEl.textContent = isRnd ? 'Таинственный соперник' : (foe ? foe.name : 'Соперник');
  if (rankEl) rankEl.textContent = isRnd ? 'скрыт' : (foe ? foe.rank : '—');
  if (lvlEl) lvlEl.textContent = isRnd ? 'Ур. ??' : (foe ? `Ур. ${foe.lvl}` : '—');
  const avaEl = document.getElementById('ecOppAva') as HTMLElement | null;
  const oppImg = document.getElementById('ecOppImg') as HTMLImageElement | null;
  if (oppImg && avaEl) {
    const key = isRnd ? 'mystery' : foeFac;
    if (avaEl.dataset.k !== key) {
      avaEl.dataset.k = key;
      avaEl.dataset.fac = foeFac;
      const fb = avaEl.querySelector('.ecOppFallback') as HTMLElement | null;
      if (fb) fb.textContent = isRnd ? '?' : (FACTION_SIGIL[foeFac as Faction] ?? '?');
      if (isRnd) oppImg.style.opacity = '0';
      else artChain(oppImg, [`/art/${foeFac}/${HUB_ART[foeFac]}.png`, `img/menu_${foeFac.toLowerCase()}.jpg`]);
    }
  }
  const practice = !!(document.getElementById('chkPractice') as HTMLInputElement | null)?.checked;
  const modeEl = document.getElementById('ecModeText');
  if (modeEl) modeEl.textContent = practice ? 'Тренировка · без рейтинга' : 'Рейтинговая лестница · Сезон 4';
  const pm = document.getElementById('ecPlayMode');
  if (pm) pm.textContent = practice ? bi('(Тренировка)', '(Practice)') : bi('(Рейтинг)', '(Ranked)');
  // Прогресс: каждые 5 побед в рейтинге — сундук с наградой
  const wins = meta.wins ?? 0;
  const step = wins % 5;
  const ready = wins > 0 && step === 0;
  const fill = document.getElementById('ecProgFill');
  const txt = document.getElementById('ecProgTxt');
  if (fill) fill.style.width = ready ? '100%' : `${(step / 5) * 100}%`;
  if (txt) txt.textContent = ready ? 'Сундук готов!' : `${step}/5 побед`;
  document.getElementById('ecProgress')?.classList.toggle('ready', ready);
}

/** Профиль в верхней панели: ник, ранг, уровень, аватар. */
function updateEcProfile(): void {
  const nick = document.getElementById('ecProfNick');
  if (nick) nick.textContent = meta.nick || 'Гость';
  const rank = rankOf(meta.mmr ?? 1000);
  const rk = document.getElementById('ecProfRank');
  if (rk) rk.textContent = rank.title;
  const lvl = Math.floor((meta.xp ?? 0) / 500) + 1;
  const lv = document.getElementById('ecProfLvl');
  if (lv) lv.textContent = String(lvl);
  const elo = document.getElementById('topMmr');
  if (elo) elo.textContent = fmtNum(meta.mmr ?? 1000);
  const ava = document.querySelector('#ecProfile .ecProfAva') as HTMLElement | null;
  const img = document.getElementById('ecProfImg') as HTMLImageElement | null;
  const fac = (meta.avatarFac as string) || 'Aurites';
  if (ava && ava.dataset.fac !== fac) {
    ava.dataset.fac = fac;
    const fb = document.getElementById('ecAvaFallback');
    if (fb) fb.textContent = FACTION_SIGIL[fac as Faction] ?? '✵';
    artChain(img, [`/heroes/${fac}`, `img/menu_${fac.toLowerCase()}.jpg`]);
  }
}

function buildMenu(showTour = true): void {
  const customs = loadCustomDecks();
  const validSelected = menuSelectedDeckId
    && (deckById.has(menuSelectedDeckId) || customs.some(d => d.id === menuSelectedDeckId));
  if (!validSelected) {
    menuSelectedDeckId = starterDeckForFaction(picked)?.id ?? picked;
    saveMenuDeck();
  }

  const mh = $('menuHeroes');
  if (mh) {
    mh.innerHTML = FACTION_IDS.map(f =>
      `<div class="heroChip${f === picked ? ' sel' : ''}" data-f="${f}" role="button" tabindex="0"
        aria-label="Быстрый выбор фракции: ${FACTION_RU[f]}" aria-pressed="${f === picked}"
        title="${FACTION_RU[f]} (${HUB_ELEM_RU[f] ?? ''}) — быстро выбрать фракцию">
        <span class="orbCore"><img class="orbIcon" src="" alt="" loading="lazy" decoding="async"></span>
        <span class="chipName">${HUB_ELEM_RU[f] ?? FACTION_RU[f]}</span>
      </div>`).join('');
    mh.querySelectorAll<HTMLElement>('.heroChip').forEach(chip => {
      const f = chip.dataset.f as Faction | undefined;
      const i = f ? FACTION_IDS.indexOf(f) : -1;
      if (f && i >= 0) artChain(chip.querySelector('.orbIcon') as HTMLImageElement | null,
        [`/heroes/${f}`, `img/ico_fac_${i}.png`]);
    });
  }

  const host = $('playerFactions');
  host.innerHTML = '';
  for (let i = 0; i < FACTION_IDS.length; i++) {
    const f = FACTION_IDS[i]!;
    const hub = HUB_CARD[f] ?? { name: FACTION_RU[f], cls: '', atk: 5, hp: 15, lvl: 1 };
    const lvl = hub.lvl + Math.floor((meta.facW[f] ?? 0) / 10);
    const node = el('div', 'fcard' + (f === picked ? ' sel' : ''));
    node.setAttribute('data-f', f);
    node.setAttribute('data-sigil', FACTION_SIGIL[f] ?? '◈');
    node.setAttribute('data-faction', f);
    node.innerHTML =
      `<div class="fcardArt">
        <span class="fcardArtPh" aria-hidden="true"><img src="img/ico_fac_${i}.png" alt="" onerror="this.style.display='none'"></span>
        <img class="fcardArtImg" src="" alt="" loading="lazy">
        <div class="fcardArtGrad"></div>
        <div class="fcardFacBadge"><img src="img/ico_fac_${i}.png" alt="${HUB_ELEM_RU[f] ?? ''}" onerror="this.style.display='none'"></div>
        <span class="fcardLvl">Ур. ${lvl}</span>
      </div>
      <div class="fcardBody">
        <div class="fname">${esc(hub.name)}</div>
        <div class="fclass">${esc(hub.cls)}</div>
        <div class="fcardSig"><img src="img/ico_fac_${i}.png" alt="" onerror="this.style.display='none'"></div>
      </div>
      <div class="fcardStats"><span class="fsAtk" title="Условная атака архетипа">${hub.atk}</span><span class="fsHp" title="Условное здоровье архетипа">${hub.hp}</span></div>
      <span class="fcardCheck" title="Ваша фракция">✓</span>`;
    node.title = 'Клик — подробности о фракции (описание, механика, советы, примеры карт)';
    node.addEventListener('click', () => { Sfx.uiClick(); openFactionModal(f); });
    host.appendChild(node);
    artChain(node.querySelector('.fcardArtImg') as HTMLImageElement | null, hubArtUrls(f));
  }

  if (customs.length) {
    const label = el('div', 'menuDeckSectionTitle', 'МОИ КОЛОДЫ · ВЫБЕРИТЕ СОХРАНЁННУЮ КОЛОДУ');
    host.appendChild(label);
    for (const deck of customs) {
      const f = deck.faction;
      const avatar = deck.avatarCardId && deck.cards.includes(deck.avatarCardId)
        ? db.get(deck.avatarCardId) : undefined;
      const artCard = avatar ?? suggestedDeckArt(deck.cards);
      const artUrls = artCard
        ? [`/art/${encodeURIComponent(artCard.faction)}/${encodeURIComponent(artCard.id)}.png`, `/heroes/${encodeURIComponent(f)}`]
        : [`/heroes/${encodeURIComponent(f)}`, `img/menu_${f.toLowerCase()}.jpg`];
      const node = el('div', 'fcard customDeckCard' + (deck.id === menuSelectedDeckId ? ' sel' : ''));
      node.dataset.deckId = deck.id;
      node.dataset.f = f;
      node.dataset.faction = f;
      node.dataset.format = 'constructed';
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', `Выбрать колоду «${deck.name}», ${deck.cards.length} карт`);
      node.innerHTML = `<div class="fcardArt">
          <span class="fcardArtPh" aria-hidden="true"><img src="" alt=""></span>
          <img class="fcardArtImg" src="" alt="" loading="lazy" decoding="async">
          <div class="fcardArtGrad"></div>
          <span class="fcardLvl customDeckRibbon">МОЯ КОЛОДА</span>
        </div>
        <div class="fcardBody">
          <div class="fname" title="${esc(deck.name)}">${esc(deck.name)}</div>
          <div class="fclass">${esc(FACTION_RU[f as Faction] ?? f)} · Constructed</div>
        </div>
        <div class="fcardStats customDeckStats"><span>${deck.cards.length} карт</span><span>ВЫБРАТЬ</span></div>
        <span class="fcardCheck" title="Выбрана колода">✓</span>`;
      const ph = node.querySelector('.fcardArtPh img') as HTMLImageElement | null;
      artChain(ph, [`/heroes/${encodeURIComponent(f)}`, `img/ico_fac_${FACTION_IDS.indexOf(f as Faction)}.png`]);
      artChain(node.querySelector('.fcardArtImg') as HTMLImageElement | null, artUrls);
      node.title = `Выбрать колоду «${deck.name}» · ${deck.cards.length} карт`;
      node.addEventListener('click', () => selectMainMenuDeck(deck.id));
      node.addEventListener('keydown', ev => {
        const key = (ev as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') { ev.preventDefault(); node.click(); }
      });
      host.appendChild(node);
    }
  }

  sel('enemyFaction').innerHTML =
    FACTION_IDS.filter(f => f !== picked).map(f => `<option value="${f}">${FACTION_RU[f]}</option>`).join('') +
    '<option value="__random">Случайная фракция</option>';
  const mh2 = $('menuHeroes');
  if (mh2 && !(mh2 as unknown as { ecBound?: boolean }).ecBound) {
    (mh2 as unknown as { ecBound?: boolean }).ecBound = true;
    mh2.addEventListener('click', ev => {
      const chip = (ev.target as HTMLElement | null)?.closest?.('.heroChip') as HTMLElement | null;
      const f = chip?.dataset.f;
      if (!f) return;
      pickFaction(f as Faction);
    });
    mh2.addEventListener('keydown', ev => {
      const key = (ev as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
      const chip = (ev.target as HTMLElement | null)?.closest?.('.heroChip') as HTMLElement | null;
      if (!chip) return;
      ev.preventDefault();
      chip.click();
    });
  }
  renderShards();
  tutGatePractice();   // спека 6.3: тренировка заблокирована до прохождения обучения
  if (showTour && !meta.tutDone) window.setTimeout(() => tourShow(), 400);
  const cnt = $('menuCardCount');
  if (cnt) cnt.textContent = String(ALL_CARDS.length);
  sel('deckPick').innerHTML = deckList
    .filter(d => d.id !== 'Starter') // служебная колода — только для тестов/совместимости
    .map(d => `<option value="${esc(d.id)}">${esc(d.name)} · ${d.format === STARTER_DECK_FORMAT ? 'стартовая' : 'Constructed'} (${d.cards.length})</option>`).join('') +
    (customs.length
      ? `<optgroup label="Мои колоды">${customs
        .map(d => `<option value="${esc(d.id)}">${esc(d.name)} (${d.cards.length} карт)</option>`).join('')}</optgroup>`
      : '');
  sel('deckPick').value = menuSelectedDeckId ?? '';
  if (!sel('deckPick').value) {
    menuSelectedDeckId = starterDeckForFaction(picked)?.id ?? picked;
    sel('deckPick').value = menuSelectedDeckId;
  }
  applyMenuBg();
  updatePlayGate();
  updateChallengePanel();
  updateEcProfile();
  renderHomeQuests();
}

function selectMainMenuDeck(deckId: string): void {
  const deck = resolveDeck(deckId, deckList as unknown as DeckLike[]);
  if (!deck) return;
  menuSelectedDeckId = deckId;
  saveMenuDeck();
  if (FACTION_IDS.includes(deck.faction as Faction)) {
    const changed = picked !== deck.faction;
    picked = deck.faction as Faction;
    savePicked();
    if (changed) Sfx.whoosh();
  }
  Sfx.uiClick();
  buildMenu();
  sel('deckPick').value = deckId;
  updatePlayGate();
}

/** Фон главного меню по фракции: кроссфейд 0.5с (спека п.1.1) + палитра UI в --fac/--fac2. */
function applyMenuBg(): void {
  const bg = document.querySelector('.menuBg:not(.menuBgFx)') as HTMLElement | null;
  const menu = $('menu');
  const col = colorOf(picked);
  if (menu) { menu.style.setProperty('--fac', col.primary); menu.style.setProperty('--fac2', col.accent); }
  if (!bg) return;
  // v2.20.0: drop-in фоны из /bg/ (поддержка видео + per-фракция)
  const fac = String(picked).toLowerCase();
  const imgEl = document.getElementById('menuBgImg') as HTMLImageElement | null;
  const vidEl = document.getElementById('menuBgVideo') as HTMLVideoElement | null;
  const tryBg = (urls: string[], isVideo: boolean, cb: (ok:boolean)=>void) => {
    if (!urls.length) return cb(false);
    const url = urls[0];
    if (isVideo && vidEl) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true;
      v.oncanplay = () => { cb(true); };
      v.onerror = () => { tryBg(urls.slice(1), isVideo, cb); };
      v.src = url;
      // таймаут 900мс на пробу
      window.setTimeout(() => { if (v.readyState < 2) tryBg(urls.slice(1), isVideo, cb); }, 900);
    } else {
      const probe = new Image();
      probe.onload = () => cb(true);
      probe.onerror = () => tryBg(urls.slice(1), isVideo, cb);
      probe.src = url;
    }
  };
  const imgUrls = [`/bg/menu/menu_${fac}`, `/bg/menu/menu`, `img/menu_${fac}.jpg`];
  const vidUrls = [`/bg/animated/menu/menu_${fac}`, `/bg/animated/menu/menu`, `/bg/menu/menu_${fac}`, `/bg/menu/menu`];
  // сначала пробуем видео (если есть — показываем видео, скрываем картинку)
  tryBg(vidUrls, true, okVideo => {
    if (okVideo && vidEl) {
      const vSrc = vidUrls.find(u => {
        // проверяем какой именно сработал — упростим: берём первый существующий через fetch HEAD
        return true;
      });
      // фактически загрузим первый успешный через tryBg — передадим url
      // для простоты: если okVideo, грузим первый из списка который отдал canplay
      // здесь уже внутри tryBg мы знаем url, поэтому пробросим
    }
  });
  // упрощённый фолбэк: последовательно пробуем img, затем video через элементы
  const loadImgBg = (idx:number) => {
    if (idx >= imgUrls.length) {
      if (imgEl) { imgEl.classList.remove('show'); imgEl.style.opacity='0'; }
      bg.style.backgroundImage = '';
      bg.classList.remove('hasCustomBg');
      // пробуем видео как последний шанс
      loadVidBg(0);
      return;
    }
    const url = imgUrls[idx];
    const probe = new Image();
    probe.onload = () => {
      if (imgEl) {
        imgEl.src = url;
        imgEl.classList.add('show');
        imgEl.style.opacity='1';
        imgEl.style.display='block';
      }
      bg.classList.add('hasCustomBg');
      if (vidEl) { vidEl.classList.remove('show'); vidEl.style.display='none'; vidEl.pause(); }
      // кроссфейд через fx
      let fx = $('menuBgFx') as HTMLElement | null;
      if (!fx) { fx = el('div', 'menuBg menuBgFx'); fx.id = 'menuBgFx'; bg.parentElement?.insertBefore(fx, bg.nextSibling); }
      fx.style.backgroundImage = `url('${url}')`;
      void fx.offsetWidth;
      fx.classList.add('show');
      window.setTimeout(() => { bg.style.backgroundImage = `url('${url}')`; fx?.classList.remove('show'); }, 560);
    };
    probe.onerror = () => loadImgBg(idx+1);
    probe.src = url;
  };
  const loadVidBg = (idx:number) => {
    if (!vidEl || idx >= vidUrls.length) return;
    const url = vidUrls[idx];
    const test = document.createElement('video');
    test.muted = true;
    test.oncanplay = () => {
      vidEl.src = url;
      vidEl.style.display='block';
      vidEl.classList.add('show');
      vidEl.style.opacity='0.92';
      vidEl.play().catch(()=>{});
      bg.classList.add('hasCustomBg');
      if (imgEl) { imgEl.classList.remove('show'); imgEl.style.opacity='0'; }
    };
    test.onerror = () => loadVidBg(idx+1);
    test.src = url;
    window.setTimeout(() => { if (test.readyState < 2) loadVidBg(idx+1); }, 800);
  };
  // приоритет: видео если файл существует — иначе картинка
  // быстро проверяем наличие видео через HEAD (fetch)
  // для простоты: пробуем картинку, если не найдена — видео
  loadImgBg(0);
}



/* ── Админка v2.21.0 ── */
const ADMIN_KEY = 'ec_admin_v1';
const ADMIN_USERS_KEY = 'ec_admin_users_v1';
type AdminUser = { pid:string; nick:string; avatarFac:string; frame:string; level:number; mmr:number; wins:number; losses:number; shards:number; gems:number; banned:boolean; lastSeen:string; };
function isAdmin(): boolean {
  try { return window.localStorage.getItem(ADMIN_KEY) === '1'; } catch { return false; }
}
function setAdmin(v:boolean): void { try { window.localStorage.setItem(ADMIN_KEY, v?'1':'0'); } catch {} updateAdminBtns(); }
function updateAdminBtns(): void {
  const a = isAdmin();
  const b1 = document.getElementById('btnAdmin') as HTMLElement | null;
  const b2 = document.getElementById('btnAdminMenu') as HTMLElement | null;
  if (b1) b1.style.display = a ? '' : 'none';
  if (b2) b2.style.display = a ? '' : 'none';
  if (!a && b2) { b2.style.display = ''; b2.textContent = '🛡 Админка'; }
}
function ensureAdminUsers(): AdminUser[] {
  try {
    const raw = window.localStorage.getItem(ADMIN_USERS_KEY);
    if (raw) return JSON.parse(raw) as AdminUser[];
  } catch {}
  const facs: Faction[] = ['Aurites','Necrus','Terramorph','Pyromancer','Ethereal'] as Faction[];
  const frames = ['bronze','silver','gold','crystal','mythic'];
  const mocks: AdminUser[] = [];
  mocks.push({ pid: meta.pid || 'me', nick: meta.nick || 'Гость', avatarFac: meta.avatarFac as string || 'Aurites', frame: meta.frame || 'bronze', level: Math.floor((meta.xp||0)/500)+1, mmr: meta.mmr||1000, wins: meta.wins||0, losses: meta.losses||0, shards: shardsGet(), gems: gemsGet(), banned:false, lastSeen: new Date().toISOString().slice(0,10) });
  const names = ['AetherWolf','ShadowMage','GroveKeeper','EmberLord','FrostWitch','IronBastion','StormCaller','VoidWalker'];
  for (let i=0;i<7;i++) {
    const f = facs[i%facs.length];
    mocks.push({ pid: `ec-demo-${i+1}`, nick: names[i], avatarFac: f, frame: frames[i%frames.length], level: 5+Math.floor(Math.random()*40), mmr: 900+Math.floor(Math.random()*800), wins: Math.floor(Math.random()*120), losses: Math.floor(Math.random()*100), shards: 400+Math.floor(Math.random()*3000), gems: 20+Math.floor(Math.random()*500), banned: Math.random()<0.12, lastSeen: new Date(Date.now()-Math.floor(Math.random()*14)*86400000).toISOString().slice(0,10) });
  }
  try { window.localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(mocks)); } catch {}
  return mocks;
}
function saveAdminUsers(arr:AdminUser[]): void { try { window.localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(arr)); } catch {} }
let adminTab: string = 'me';
function openAdmin(): void {
  if (!isAdmin()) { openAdminLogin(); return; }
  const m = $('adminModal') as HTMLElement; m.classList.remove('hidden');
  renderAdmin();
}
function closeAdmin(): void { $('adminModal').classList.add('hidden'); }
function openAdminLogin(): void { const l = $('adminLogin') as HTMLElement; l.classList.remove('hidden'); ($('adminPass') as HTMLInputElement).value=''; ($('adminPass') as HTMLInputElement).focus(); ($('adminLoginErr') as HTMLElement).textContent=''; }
function closeAdminLogin(): void { $('adminLogin').classList.add('hidden'); }
function renderAdmin(): void {
  updateAdminBtns();
  const body = $('adminBody') as HTMLElement;
  body.innerHTML = '';
  document.querySelectorAll('#adminTabs .admTab').forEach(el => {
    const b = el as HTMLElement;
    b.classList.toggle('sel', b.dataset.tab === adminTab);
  });
  if (adminTab === 'me') renderAdminMe(body);
  else if (adminTab === 'users') renderAdminUsers(body);
  else if (adminTab === 'economy') renderAdminEconomy(body);
  else if (adminTab === 'cards') renderAdminCards(body);
  else if (adminTab === 'borderless') renderAdminBorderless(body);
  else if (adminTab === 'decks') renderAdminDecks(body);
  else if (adminTab === 'system') renderAdminSystem(body);
  // KPI-полоса сверху — ПОСЛЕ рендера вкладки (renderX переписывает innerHTML)
  let usersN = 6;
  try { const u = JSON.parse(window.localStorage?.getItem(ADMIN_USERS_KEY) || 'null'); if (Array.isArray(u) && u.length) usersN = u.length; } catch { /* нет данных */ }
  body.insertAdjacentHTML('afterbegin', `<div class="admKpi" aria-label="Ключевые показатели">
    <div class="admKpiChip"><span class="k">🎯 Матчей</span><span class="v">${(meta.wins ?? 0) + (meta.losses ?? 0)}</span></div>
    <div class="admKpiChip"><span class="k">👥 Игроков</span><span class="v">${usersN}</span></div>
    <div class="admKpiChip" title="${ALL_CARDS.length} игровых карт, каждая может иметь классическое и Borderless-оформление"><span class="k">🎴 Карты / варианты</span><span class="v">${ALL_CARDS.length} / ${ALL_CARDS.length * 2}</span></div>
    <div class="admKpiChip"><span class="k">💎 Самоцветов</span><span class="v">${gemsGet()}</span></div>
  </div>`);
}
function renderAdminMe(host:HTMLElement): void {
  const lvl = Math.floor((meta.xp||0)/500)+1;
  const xpPct = ((meta.xp||0)%500)/5;
  host.innerHTML = `<div class="admGrid">
    <div class="admCard">
      <h4>👤 Мой профиль</h4>
      <div class="admField"><label>Ник</label><input id="admNick" value="${esc(meta.nick)}"></div>
      <div class="admField"><label>Фракция</label><select id="admFac">${(['Aurites','Necrus','Terramorph','Pyromancer','Ethereal'] as string[]).map(f=>`<option value="${f}" ${f===meta.avatarFac?'selected':''}>${FACTION_RU[f as Faction]}</option>`).join('')}</select></div>
      <div class="admField"><label>Рамка</label><select id="admFrame"><option value="bronze" ${meta.frame==='bronze'?'selected':''}>Бронза</option><option value="silver" ${meta.frame==='silver'?'selected':''}>Серебро</option><option value="gold" ${meta.frame==='gold'?'selected':''}>Золото</option><option value="crystal" ${meta.frame==='crystal'?'selected':''}>Кристалл</option><option value="mythic" ${meta.frame==='mythic'?'selected':''}>Мифик</option></select></div>
      <div class="admField"><label>PID</label><input value="${esc(meta.pid||'')}" disabled></div>
      <div style="display:flex;gap:.4rem;margin-top:.6rem"><button class="btn primary" id="admSaveMe">Сохранить</button><button class="btn" id="admResetMe">Сбросить прогресс</button></div>
    </div>
    <div class="admCard">
      <h4>📊 Прогресс</h4>
      <div class="admField"><label>Уровень</label><input id="admLevel" type="number" min="1" max="100" value="${lvl}"><span style="font-size:.66rem;color:#8b93ab">XP ${meta.xp||0}</span></div>
      <div style="height:8px;background:rgba(255,255,255,.08);border-radius:5px;overflow:hidden;margin:.3rem 0"><div style="height:100%;width:${xpPct}%;background:linear-gradient(90deg,#2a9a90,#ffd87a)"></div></div>
      <div class="admField"><label>MMR</label><input id="admMmr" type="number" min="400" max="3000" value="${meta.mmr||1000}"></div>
      <div class="admField"><label>Побед</label><input id="admWins" type="number" min="0" value="${meta.wins||0}"></div>
      <div class="admField"><label>Поражений</label><input id="admLoss" type="number" min="0" value="${meta.losses||0}"></div>
      <div class="admField"><label>Сыграно</label><span style="font-size:.74rem;color:#e6d6ac">${(meta.wins||0)+(meta.losses||0)} · винрейт ${(((meta.wins||0)/Math.max(1,(meta.wins||0)+(meta.losses||0)))*100).toFixed(1)}%</span></div>
    </div>
    <div class="admCard">
      <h4>💰 Валюта</h4>
      <div class="admField"><label>🪙 Монеты</label><input id="admShards" type="number" min="0" value="${shardsGet()}"></div>
      <div class="admField"><label>💎 Гемы</label><input id="admGems" type="number" min="0" value="${gemsGet()}"></div>
      <div class="admField"><label>Бустеров</label><input id="admPacks" type="number" min="0" value="${meta.freeOpens||0}"></div>
      <div class="admField"><label>BP XP</label><input id="admBpXp" type="number" min="0" value="${meta.bpXp||0}"></div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn" data-give="shard500">+500 🪙</button><button class="btn" data-give="shard2000">+2000 🪙</button><button class="btn" data-give="gem100">+100 💎</button><button class="btn" data-give="pack1">+1 бустер</button></div>
    </div>
    <div class="admCard">
      <h4>🎯 Квесты и пропуск</h4>
      <div style="font-size:.72rem;color:#cbb98a;margin:.3rem 0">Ежедневные: ${(meta.quests||[]).length}, еженедельные: ${(meta.wquests||[]).length}, BP уровень ${Math.floor((meta.bpXp||0)/260)+1}</div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem"><button class="btn" id="admResetQuests">Сбросить квесты</button><button class="btn" id="admGiveBp">+500 BP XP</button><button class="btn" id="admTogglePremium">${meta.bpPremium?'Отключить премиум':'Включить премиум'}</button></div>
      <div style="font-size:.62rem;color:#8b93ab;margin-top:.5rem">В проде: POST /api/admin/grant с pid и payload</div>
    </div>
  </div>
  <div class="admCard" style="margin-top:.6rem">
    <h4>🔑 Доступ</h4>
    <div style="font-size:.72rem;color:#cbb98a">Админка видна только тебе (localStorage ec_admin_v1=1). Для прода — замени пароль на POST /api/admin/login с JWT и role: admin.</div>
    <div style="display:flex;gap:.4rem;margin-top:.5rem"><button class="btn danger" id="admLogout">Выйти из админки</button><span style="font-size:.62rem;color:#8b93ab;align-self:center">Скрывает кнопки 🛡</span></div>
  </div>`;
  host.querySelector('#admSaveMe')?.addEventListener('click', ()=>{
    const nick = (host.querySelector('#admNick') as HTMLInputElement).value.trim() || 'Гость';
    const fac = (host.querySelector('#admFac') as HTMLSelectElement).value as Faction;
    const frame = (host.querySelector('#admFrame') as HTMLSelectElement).value;
    meta.nick = nick; meta.avatarFac = fac; meta.frame = frame; metaSave(); showToast('Профиль сохранён'); renderAdmin(); renderShards();
  });
  host.querySelector('#admResetMe')?.addEventListener('click', ()=>{
    if(!confirm('Сбросить весь прогресс? (уровень, MMR, история)')) return;
    meta.xp=0; meta.wins=0; meta.losses=0; meta.mmr=1000; meta.history=[]; meta.replays=[]; meta.telem=[]; metaSave(); showToast('Прогресс сброшен'); renderAdmin();
  });
  ['admLevel','admMmr','admWins','admLoss'].forEach(id=>{
    host.querySelector('#'+id)?.addEventListener('change', ()=>{
      const lvl = parseInt((host.querySelector('#admLevel') as HTMLInputElement).value)||1;
      meta.xp = (lvl-1)*500 + ((meta.xp||0)%500);
      meta.mmr = parseInt((host.querySelector('#admMmr') as HTMLInputElement).value)||1000;
      meta.wins = parseInt((host.querySelector('#admWins') as HTMLInputElement).value)||0;
      meta.losses = parseInt((host.querySelector('#admLoss') as HTMLInputElement).value)||0;
      metaSave(); showToast('Сохранено');
    });
  });
  host.querySelector('#admShards')?.addEventListener('change', ()=>{ const v=parseInt((host.querySelector('#admShards') as HTMLInputElement).value)||0; const d=v-shardsGet(); shardsAdd(d); metaSave(); });
  host.querySelector('#admGems')?.addEventListener('change', ()=>{ const v=parseInt((host.querySelector('#admGems') as HTMLInputElement).value)||0; const d=v-gemsGet(); gemsAdd(d); });
  host.querySelector('#admPacks')?.addEventListener('change', ()=>{ meta.freeOpens = parseInt((host.querySelector('#admPacks') as HTMLInputElement).value)||0; metaSave(); });
  host.querySelector('#admBpXp')?.addEventListener('change', ()=>{ meta.bpXp = parseInt((host.querySelector('#admBpXp') as HTMLInputElement).value)||0; metaSave(); });
  host.querySelectorAll('[data-give]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const k=(b as HTMLElement).dataset.give;
      if(k==='shard500') shardsAdd(500);
      if(k==='shard2000') shardsAdd(2000);
      if(k==='gem100') gemsAdd(100);
      if(k==='pack1') { meta.freeOpens=(meta.freeOpens||0)+1; metaSave(); }
      showToast('Выдано'); renderAdmin();
    });
  });
  host.querySelector('#admResetQuests')?.addEventListener('click', ()=>{ meta.quests = freshQuests(); meta.wquests = freshWQuests(); meta.questDate = todayStr(); meta.wquestWeek = weekStr(); metaSave(); showToast('Квесты сброшены'); renderAdmin(); });
  host.querySelector('#admGiveBp')?.addEventListener('click', ()=>{ meta.bpXp=(meta.bpXp||0)+500; metaSave(); showToast('+500 BP'); renderAdmin(); });
  host.querySelector('#admTogglePremium')?.addEventListener('click', ()=>{ meta.bpPremium=!meta.bpPremium; metaSave(); showToast(meta.bpPremium?'Премиум включён':'Премиум выключен'); renderAdmin(); });
  host.querySelector('#admLogout')?.addEventListener('click', ()=>{ setAdmin(false); closeAdmin(); showToast('Вышел из админки'); });
}
function renderAdminUsers(host:HTMLElement): void {
  const users = ensureAdminUsers();
  users[0] = { pid: meta.pid||'me', nick: meta.nick, avatarFac: meta.avatarFac as string, frame: meta.frame, level: Math.floor((meta.xp||0)/500)+1, mmr: meta.mmr||1000, wins: meta.wins||0, losses: meta.losses||0, shards: shardsGet(), gems: gemsGet(), banned:false, lastSeen: new Date().toISOString().slice(0,10) };
  saveAdminUsers(users);
  host.innerHTML = `<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem">
    <input id="admUserSearch" placeholder="Поиск по нику / PID..." style="flex:1;min-width:180px;background:#14161f;border:1px solid var(--line);color:var(--text);padding:.42rem .5rem;border-radius:6px">
    <select id="admUserFilter" style="background:#14161f;border:1px solid var(--line);color:var(--text);padding:.42rem;border-radius:6px"><option value="">Все</option><option value="banned">Забанены</option><option value="top">Топ по MMR</option></select>
    <button class="btn" id="admUserAdd">＋ Добавить игрока</button>
    <button class="btn" id="admUserExport">Экспорт CSV</button>
  </div>
  <div style="overflow:auto;max-height:52vh;border:1px solid rgba(255,255,255,.06);border-radius:8px">
    <table class="admTable"><thead><tr><th>Игрок</th><th>Ур / MMR</th><th>W-L</th><th>🪙 / 💎</th><th>Статус</th><th>Действия</th></tr></thead><tbody id="admUserTbody"></tbody></table>
  </div>
  <div style="font-size:.62rem;color:#8b93ab;margin-top:.4rem">Всего ${users.length} · в проде подмени localStorage на GET /api/admin/users?search=&filter=</div>`;
  const tbody = host.querySelector('#admUserTbody') as HTMLElement;
  const search = host.querySelector('#admUserSearch') as HTMLInputElement;
  const filter = host.querySelector('#admUserFilter') as HTMLSelectElement;
  const render = ()=>{
    const q = (search.value||'').toLowerCase();
    let list = users.slice();
    if (filter.value==='banned') list = list.filter(u=>u.banned);
    if (filter.value==='top') list.sort((a,b)=>b.mmr-a.mmr);
    if (q) list = list.filter(u=>u.nick.toLowerCase().includes(q)||u.pid.toLowerCase().includes(q));
    tbody.innerHTML = list.map(u=>`<tr>
      <td><div style="display:flex;align-items:center;gap:.45rem"><span style="width:28px;height:28px;border-radius:50%;background:var(--panel);border:1px solid rgba(255,216,122,.18);display:flex;align-items:center;justify-content:center;font-size:.72rem">${FACTION_SIGIL[u.avatarFac as Faction]||'◈'}</span><div><div style="font-size:.78rem;color:#ffe9b0">${esc(u.nick)} ${u.pid===meta.pid?'<span class="admBadge">вы</span>':''}</div><div style="font-size:.62rem;color:#8b93ab">${esc(u.pid)} · ${esc(FACTION_RU[u.avatarFac as Faction]||u.avatarFac)} · ${u.frame}</div></div></div></td>
      <td><b>${u.level}</b> <span style="color:#8b93ab">/ ${u.mmr}</span></td>
      <td>${u.wins}-${u.losses} <span style="color:#8b93ab">${((u.wins/Math.max(1,u.wins+u.losses))*100).toFixed(0)}%</span></td>
      <td>🪙${u.shards} · 💎${u.gems}</td>
      <td>${u.banned?'<span class="admBadge" style="border-color:#7c3a34;background:rgba(124,58,52,.12);color:#ffb3a6">бан</span>':'<span class="admBadge">активен</span>'} · ${u.lastSeen}</td>
      <td><div class="admActions"><button class="btn" data-act="edit" data-pid="${u.pid}">✎</button><button class="btn" data-act="give" data-pid="${u.pid}">🪙</button><button class="btn" data-act="ban" data-pid="${u.pid}">${u.banned?'✓':'⛔'}</button><button class="btn danger" data-act="del" data-pid="${u.pid}">✕</button></div></td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-act]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const act=(b as HTMLElement).dataset.act; const pid=(b as HTMLElement).dataset.pid!;
        const idx=users.findIndex(x=>x.pid===pid); if(idx<0) return;
        if(act==='edit'){
          const nu=prompt('Новый ник', users[idx].nick); if(nu===null) return;
          const nm=parseInt(prompt('MMR', String(users[idx].mmr))||String(users[idx].mmr))||users[idx].mmr;
          users[idx].nick=nu.trim()||users[idx].nick; users[idx].mmr=nm;
          if(pid===meta.pid){ meta.nick=users[idx].nick; meta.mmr=nm; metaSave(); }
          saveAdminUsers(users); render(); showToast('Сохранено');
        } else if(act==='give'){
          const sh=parseInt(prompt('Выдать монеты', '500')||'0')||0;
          const ge=parseInt(prompt('Выдать 💎', '50')||'0')||0;
          users[idx].shards+=sh; users[idx].gems+=ge;
          if(pid===meta.pid){ shardsAdd(sh); gemsAdd(ge); }
          saveAdminUsers(users); render(); showToast('Выдано 🪙'+sh+' 💎'+ge);
        } else if(act==='ban'){
          users[idx].banned=!users[idx].banned;
          saveAdminUsers(users); render(); showToast(users[idx].banned?'Забанен':'Разбанен');
        } else if(act==='del'){
          if(!confirm('Удалить '+users[idx].nick+'?')) return;
          if(pid===meta.pid){ alert('Свой аккаунт удалить нельзя — очисти localStorage'); return; }
          users.splice(idx,1); saveAdminUsers(users); render(); showToast('Удалён');
        }
      });
    });
  };
  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  host.querySelector('#admUserAdd')?.addEventListener('click', ()=>{
    const nick=prompt('Ник нового игрока','NewPlayer');
    if(!nick) return;
    users.push({ pid: `ec-`+Math.random().toString(36).slice(2,7), nick: nick.trim(), avatarFac: 'Aurites', frame:'bronze', level:1, mmr:1000, wins:0, losses:0, shards:1200, gems:100, banned:false, lastSeen: new Date().toISOString().slice(0,10) });
    saveAdminUsers(users); render(); showToast('Игрок создан');
  });
  host.querySelector('#admUserExport')?.addEventListener('click', ()=>{
    const csv = 'pid,nick,mmr,level,wins,losses,shards,gems,banned\n' + users.map(u=>`${u.pid},${u.nick},${u.mmr},${u.level},${u.wins},${u.losses},${u.shards},${u.gems},${u.banned}`).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='users.csv'; a.click(); URL.revokeObjectURL(a.href);
  });
  render();
}
function renderAdminEconomy(host:HTMLElement): void {
  host.innerHTML = `<div class="admGrid">
    <div class="admCard"><h4>💰 Баланс (мой)</h4>
      <div class="admField"><label>🪙 Монеты</label><input id="admEcoSh" type="number" value="${shardsGet()}"><button class="btn" data-eco="sh+500">+500</button></div>
      <div class="admField"><label>💎 Гемы</label><input id="admEcoGe" type="number" value="${gemsGet()}"><button class="btn" data-eco="ge+100">+100</button></div>
      <div class="admField"><label>Бустеры</label><input id="admEcoPk" type="number" value="${meta.freeOpens||0}"><button class="btn" data-eco="pk+1">+1</button></div>
      <div class="admField"><label>BP XP</label><input id="admEcoBp" type="number" value="${meta.bpXp||0}"><button class="btn" data-eco="bp+260">+уровень</button></div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn primary" id="admEcoSave">Сохранить</button><button class="btn" id="admEcoReset">Сбросить к 1200/100</button></div>
    </div>
    <div class="admCard"><h4>🎁 Выдать набор</h4>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0">
        <button class="btn" data-kit="starter">Стартовый: 5 паков + 2500 💎</button>
        <button class="btn" data-kit="daily">Дейлик: 500 🪙</button>
        <button class="btn" data-kit="bp">BP бустер</button>
        <button class="btn" data-kit="foil">1 фойл-жетон</button>
      </div>
      <div style="font-size:.62rem;color:#8b93ab">В проде: POST /api/admin/grant {pid, shards, gems, packs}</div>
      <div class="admField" style="margin-top:.6rem"><label>Цена пака</label><span style="font-size:.74rem;color:#e6d6ac">300 монет · лимит 4 копии, дубликаты → монеты (1/2/5/20/100)</span></div>
    </div>
    <div class="admCard"><h4>📈 Курсы</h4>
      <div class="admField"><label>Создание Common</label><span>5 монет</span><label>Разбор Common</label><span>+1 монета</span></div>
      <div class="admField"><label>Rare</label><span>20 / 5</span><label>Epic 100 / 20</label></div>
      <div class="admField"><label>Legendary</label><span>400 / 100</span></div>
      <div style="font-size:.62rem;color:#8b93ab;margin-top:.4rem">Меняется в src/balance.ts · админка только выдаёт валюту, не меняет курсы без деплоя</div>
    </div>
    <div class="admCard"><h4>🔍 Лог выдач</h4><div id="admEcoLog" style="max-height:120px;overflow:auto;font-size:.68rem;color:#cbb98a;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:.4rem .5rem">— пока пусто —</div></div>
  </div>`;
  host.querySelector('#admEcoSave')?.addEventListener('click', ()=>{
    const sh=parseInt((host.querySelector('#admEcoSh') as HTMLInputElement).value)||0;
    const ge=parseInt((host.querySelector('#admEcoGe') as HTMLInputElement).value)||0;
    const pk=parseInt((host.querySelector('#admEcoPk') as HTMLInputElement).value)||0;
    const bp=parseInt((host.querySelector('#admEcoBp') as HTMLInputElement).value)||0;
    shardsSet(sh); meta.gems=ge; meta.freeOpens=pk; meta.bpXp=bp; metaSave(); renderShards(); showToast('Сохранено');
    const log=host.querySelector('#admEcoLog') as HTMLElement; if(log) log.textContent = '['+new Date().toLocaleTimeString()+'] set 🪙'+sh+' 💎'+ge+' pk'+pk+' bp'+bp+'\n' + log.textContent;
  });
  host.querySelectorAll('[data-eco]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const k=(b as HTMLElement).dataset.eco;
      if(k==='sh+500') shardsAdd(500);
      if(k==='ge+100') gemsAdd(100);
      if(k==='pk+1') { meta.freeOpens=(meta.freeOpens||0)+1; metaSave(); }
      if(k==='bp+260') { meta.bpXp=(meta.bpXp||0)+260; metaSave(); }
      (host.querySelector('#admEcoSh') as HTMLInputElement).value=String(shardsGet());
      (host.querySelector('#admEcoGe') as HTMLInputElement).value=String(gemsGet());
      (host.querySelector('#admEcoPk') as HTMLInputElement).value=String(meta.freeOpens||0);
      (host.querySelector('#admEcoBp') as HTMLInputElement).value=String(meta.bpXp||0);
      showToast('Выдано');
    });
  });
  host.querySelector('#admEcoReset')?.addEventListener('click', ()=>{ shardsSet(1200); meta.gems=100; meta.freeOpens=0; metaSave(); renderShards(); showToast('Сброшено'); renderAdmin(); });
  host.querySelectorAll('[data-kit]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const k=(b as HTMLElement).dataset.kit;
      if(k==='starter'){ shardsAdd(0); gemsAdd(2500); meta.freeOpens=(meta.freeOpens||0)+5; metaSave(); }
      if(k==='daily') shardsAdd(500);
      if(k==='bp') { meta.premOpens=(meta.premOpens||0)+1; metaSave(); }
      if(k==='foil') { meta.foilTokens=(meta.foilTokens||0)+1; metaSave(); }
      renderShards(); showToast('Набор выдан');
    });
  });
}
function renderAdminCards(host:HTMLElement): void {
  const q = (host as HTMLElement & { _q?:string })._q || '';
  host.innerHTML = `<div class="admCollectionHint"><b>Игровая коллекция · ${ALL_CARDS.length} карт</b><span>Управляет только обычными копиями для колод. Borderless — косметический вид тех же карт, без изменений баланса; выдача отдельно во вкладке <b>Borderless</b>.</span><span class="admCollectionTotal">${ALL_CARDS.length} игровых карт · ${ALL_CARDS.length * 2} представлений</span></div>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem">
    <input id="admCardSearch" placeholder="Поиск карты..." value="${esc(q)}" style="flex:1;min-width:180px;background:#14161f;border:1px solid var(--line);color:var(--text);padding:.42rem .5rem;border-radius:6px">
    <select id="admCardFac" style="background:#14161f;border:1px solid var(--line);color:var(--text);padding:.42rem;border-radius:6px"><option value="">Все фракции</option>${(['Aurites','Necrus','Terramorph','Pyromancer','Ethereal','Neutral'] as string[]).map(f=>`<option value="${f}">${FACTION_RU[f as Faction]||f}</option>`).join('')}</select>
    <button class="btn" id="admCardGive5">＋5 случайных</button>
    <button class="btn primary" id="admCardGiveAll">📚 Выдать все ${ALL_CARDS.length} ×4</button>
    <button class="btn danger" id="admCardWipe">♻ Сброс коллекции</button>
  </div>
  <div id="admCardGrid" style="display:flex;gap:.6rem;flex-wrap:wrap;max-height:52vh;overflow:auto;padding:.2rem"></div>
  <div style="font-size:.62rem;color:#8b93ab;margin-top:.4rem">Клик по карте — выдать ×1 (до 4), правый клик — забрать, двойной клик — описание. «Выдать все» назначает полный плейсет всех ${ALL_CARDS.length} игровых карт; Borderless-варианты не затрагиваются. В проде: POST /api/admin/cards {pid, cardId, delta}</div>`;
  const grid = host.querySelector('#admCardGrid') as HTMLElement;
  const facSel = host.querySelector('#admCardFac') as HTMLSelectElement;
  const search = host.querySelector('#admCardSearch') as HTMLInputElement;
  const render = ()=>{
    const qq=(search.value||'').toLowerCase();
    const fac=facSel.value;
    const owned = getOwnedMap();
    let list = (ALL_CARDS as unknown as CardData[]).slice();
    if(fac) list = list.filter(c=>c.faction===fac);
    if(qq) list = list.filter(c=>c.name.toLowerCase().includes(qq)||c.id.toLowerCase().includes(qq));
    list = list.slice(0,60);
    grid.innerHTML='';
    for(const c of list){
      const cnt = owned.get(c.id)||0;
      const node = renderCard(c);
      const badge = document.createElement('div');
      badge.style.cssText='position:absolute;top:4px;right:4px;z-index:5;padding:.12rem .38rem;border-radius:999px;background:rgba(10,12,18,.88);border:1px solid rgba(255,216,122,.22);color:#ffe9b0;font-size:.66rem';
      badge.textContent = '×'+cnt;
      node.style.position='relative';
      node.appendChild(badge);
      node.title = c.name+' — '+cnt+'/4 — клик выдать';
      node.addEventListener('click', ()=>{ const m=getOwnedMap(); const cur=m.get(c.id)||0; if(cur>=4){ showToast('Уже 4 копии'); return; } const nm=new Map(m); nm.set(c.id, cur+1); setOwnedMap(nm); badge.textContent='×'+(cur+1); showToast('Выдано '+c.name); });
      node.addEventListener('contextmenu', e=>{ e.preventDefault(); const m=getOwnedMap(); const cur=m.get(c.id)||0; if(cur<=0){ showToast('Нет копий'); return; } const nm=new Map(m); if(cur===1) nm.delete(c.id); else nm.set(c.id, cur-1); setOwnedMap(nm); badge.textContent='×'+Math.max(0,cur-1); showToast('Забрано '+c.name); });
      node.addEventListener('dblclick', ()=>{ openCardModal(c, list); });
      grid.appendChild(node);
    }
    (host as HTMLElement & { _q?:string })._q = qq;
  };
  search.addEventListener('input', render);
  facSel.addEventListener('change', render);
  host.querySelector('#admCardGive5')?.addEventListener('click', ()=>{
    const m=getOwnedMap(); const nm=new Map(m);
    for(let i=0;i<5;i++){ const c=ALL_CARDS[Math.floor(Math.random()*ALL_CARDS.length)] as unknown as CardData; const cur=nm.get(c.id)||0; if(cur<PLAYSET) nm.set(c.id, cur+1); }
    setOwnedMap(nm); showToast('+5 карт'); render();
  });
  host.querySelector('#admCardGiveAll')?.addEventListener('click', ()=>{
    if(!confirm(`Выдать ВСЕ ${ALL_CARDS.length} карт по ${PLAYSET} копии (полный плейсет)?`)) return;
    const nm=new Map<string, number>();
    for(const c of ALL_CARDS) nm.set(c.id, PLAYSET);
    setOwnedMap(nm); showToast(`📚 Выданы все ${ALL_CARDS.length} карт ×${PLAYSET}`); render();
  });
  host.querySelector('#admCardWipe')?.addEventListener('click', ()=>{
    const baseIds = (ALL_CARDS as unknown as CardData[]).filter(c=>!isExpansionId(c.id)).map(c=>c.id);
    if(!confirm(`Сбросить коллекцию до базы (${baseIds.length} карт)?`)) return;
    const nm=new Map<string,number>(); baseIds.forEach(id=>nm.set(id, 1));
    setOwnedMap(nm); showToast('Коллекция сброшена'); render();
  });
  render();
}
function renderAdminBorderless(host:HTMLElement): void {
  const state = host as HTMLElement & { _borderlessQ?: string; _borderlessFac?: string };
  const ownedIds = new Set((meta.borderlessOwned ?? []).filter(id => ALL_CARDS.some(card => card.id === id)));
  const owned = ownedIds.size;
  const chancePercent = (BORDERLESS_BOOSTER_CHANCE * 100).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  const chanceOneIn = Math.max(1, Math.round(1 / BORDERLESS_BOOSTER_CHANCE));
  host.innerHTML = `<div class="admCard admBorderlessOverview">
    <div class="admBorderlessIntro"><div><div class="admBorderlessEyebrow">КОСМЕТИКА · ИГРОВОЙ БАЛАНС НЕ МЕНЯЕТСЯ</div>
      <h3>Borderless · ${ALL_CARDS.length} вариантов</h3>
      <p>Те же карты, названия и арт. Меняется только оформление: Borderless — без рамки, с полноформатным артом. Выдача здесь не добавляет игровые копии.</p></div>
      <div class="admBorderlessMetrics"><div><span>Выдано</span><b>${owned} / ${ALL_CARDS.length}</b></div>
        <div><span>Шанс из бустера</span><b>${chancePercent}%</b></div>
        <div><span>Частота</span><b>≈ 1 из ${chanceOneIn}</b></div></div>
    </div>
    <div class="admBorderlessProgress" role="progressbar" aria-label="Выданные Borderless-варианты" aria-valuemin="0" aria-valuemax="${ALL_CARDS.length}" aria-valuenow="${owned}"><i style="width:${owned / Math.max(1, ALL_CARDS.length) * 100}%"></i></div>
    <div class="admBorderlessChanceNote">Шанс относится к отдельному бонусу на бустер; игровая часть пака не меняется. Значение задано в коде: <code>BORDERLESS_BOOSTER_CHANCE</code>.</div>
  </div>
  <div class="admCard admBorderlessManage">
    <div class="admBorderlessTools">
      <input id="admBorderlessSearch" placeholder="Найти карту по названию или ID…" value="${esc(state._borderlessQ ?? '')}" aria-label="Поиск Borderless-карты">
      <select id="admBorderlessFac" aria-label="Фильтр Borderless по фракции"><option value="">Все фракции</option>${(['Aurites','Necrus','Terramorph','Pyromancer','Ethereal','Neutral'] as string[]).map(f=>`<option value="${f}" ${f === state._borderlessFac ? 'selected' : ''}>${FACTION_RU[f as Faction] || f}</option>`).join('')}</select>
      <button class="btn" id="admBorderlessRandom" ${owned >= ALL_CARDS.length ? 'disabled' : ''}>＋1 случайный</button>
      <button class="btn primary" id="admBorderlessAll" ${owned >= ALL_CARDS.length ? 'disabled' : ''}>◇ Выдать все ${ALL_CARDS.length}</button>
      <button class="btn danger" id="admBorderlessReset" ${owned === 0 ? 'disabled' : ''}>Сбросить Borderless</button>
    </div>
    <div id="admBorderlessResults" class="admBorderlessResults" aria-live="polite"></div>
    <div id="admBorderlessGrid" class="admBorderlessGrid"></div>
    <div class="admBorderlessHelp">Нажмите на карту, чтобы выдать или забрать только её Borderless-оформление. Снятие косметики также снимает её экипировку; обычные копии остаются без изменений. Поиск показывает до 60 совпадений.</div>
  </div>`;
  const search = host.querySelector('#admBorderlessSearch') as HTMLInputElement;
  const faction = host.querySelector('#admBorderlessFac') as HTMLSelectElement;
  const results = host.querySelector('#admBorderlessResults') as HTMLElement;
  const grid = host.querySelector('#admBorderlessGrid') as HTMLElement;
  const render = (): void => {
    const qq = (search.value || '').trim().toLocaleLowerCase();
    const fac = faction.value;
    state._borderlessQ = search.value;
    state._borderlessFac = fac;
    let list = (ALL_CARDS as unknown as CardData[]).slice();
    if (fac) list = list.filter(card => card.faction === fac);
    if (qq) list = list.filter(card => cardName(card).toLocaleLowerCase().includes(qq) || card.id.toLocaleLowerCase().includes(qq));
    const matches = list.length;
    list = list.slice(0, 60);
    results.textContent = `Показано ${list.length} из ${matches} совпадений · получено ${ownedIds.size} из ${ALL_CARDS.length}`;
    grid.innerHTML = '';
    for (const card of list) {
      const unlocked = hasBorderless(card.id);
      const node = renderCard(card, 'borderless');
      node.classList.add('admBorderlessTile');
      node.classList.toggle('admBorderlessLocked', !unlocked);
      node.style.position = 'relative';
      const badge = document.createElement('span');
      badge.className = `admBorderlessBadge${unlocked ? ' isOwned' : ''}`;
      badge.textContent = unlocked ? '◇ ЕСТЬ' : '＋ ВЫДАТЬ';
      node.appendChild(badge);
      node.title = `${cardName(card)} · ${unlocked ? 'Borderless получен — нажмите, чтобы забрать' : 'Borderless не получен — нажмите, чтобы выдать'}`;
      node.addEventListener('click', () => {
        if (hasBorderless(card.id)) {
          meta.borderlessOwned = (meta.borderlessOwned ?? []).filter(id => id !== card.id);
          meta.borderlessEquipped = (meta.borderlessEquipped ?? []).filter(id => id !== card.id);
          showToast(`Borderless снят: ${cardName(card)}`);
        } else {
          unlockBorderless(card.id);
          showToast(`Выдан Borderless: ${cardName(card)}`);
        }
        metaSave();
        renderAdmin();
      });
      grid.appendChild(node);
    }
  };
  search.addEventListener('input', render);
  faction.addEventListener('change', render);
  host.querySelector('#admBorderlessRandom')?.addEventListener('click', () => {
    const card = grantRandomBorderless();
    if (!card) { showToast('Все Borderless-варианты уже выданы'); return; }
    metaSave(); showToast(`Выдан Borderless: ${cardName(card)}`); renderAdmin();
  });
  host.querySelector('#admBorderlessAll')?.addEventListener('click', () => {
    if (!confirm(`Выдать все ${ALL_CARDS.length} Borderless-вариантов? Обычные копии карт не изменятся.`)) return;
    meta.borderlessOwned = Array.from(new Set([...(meta.borderlessOwned ?? []), ...ALL_CARDS.map(card => card.id)]));
    metaSave(); showToast(`Выданы все ${ALL_CARDS.length} Borderless-вариантов`); renderAdmin();
  });
  host.querySelector('#admBorderlessReset')?.addEventListener('click', () => {
    if (!confirm('Забрать все Borderless-варианты и снять их экипировку? Обычные копии карт останутся.')) return;
    meta.borderlessOwned = []; meta.borderlessEquipped = [];
    metaSave(); showToast('Borderless-коллекция сброшена'); renderAdmin();
  });
  render();
}
function renderAdminDecks(host:HTMLElement): void {
  const customs = loadCustomDecks();
  const all = getAllDecksForGrid();
  host.innerHTML = `<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem">
    <span style="font-size:.72rem;color:#cbb98a">Всего колод: <b style="color:#ffe9b0">${all.length}</b> · кастомных ${customs.length} · преконов ${all.length-customs.length}</span>
    <span style="flex:1"></span>
    <button class="btn" id="admDeckNew">＋ Создать</button>
    <button class="btn" id="admDeckExport">Экспорт всех</button>
    <button class="btn danger" id="admDeckWipe">Удалить кастомные</button>
  </div>
  <div style="overflow:auto;max-height:52vh;border:1px solid rgba(255,255,255,.06);border-radius:8px">
    <table class="admTable"><thead><tr><th>Колода</th><th>Фракция</th><th>Карт</th><th>Обнова</th><th>Действия</th></tr></thead><tbody id="admDeckTbody"></tbody></table>
  </div>`;
  const tbody = host.querySelector('#admDeckTbody') as HTMLElement;
  const render = ()=>{
    tbody.innerHTML = all.map(d=>`<tr>
      <td><b style="color:#ffe9b0">${esc(d.name)}</b> ${d.isPrecon?'<span class="admBadge">precon</span>':'<span class="admBadge" style="border-color:#5fc77a;background:rgba(95,199,122,.12);color:#b8f0c4">custom</span>'}<div style="font-size:.62rem;color:#8b93ab">${esc(d.id)}</div></td>
      <td>${FACTION_RU[d.faction as Faction]||d.faction}</td>
      <td>${d.cards.length}</td>
      <td style="font-size:.62rem;color:#8b93ab">${d.updated?new Date(d.updated).toLocaleDateString('ru-RU'):'—'}</td>
      <td><div class="admActions"><button class="btn" data-act="edit" data-id="${d.id}">✎</button><button class="btn" data-act="dup" data-id="${d.id}">⧉</button><button class="btn danger" data-act="del" data-id="${d.id}" ${d.isPrecon?'disabled':''}>✕</button></div></td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-act]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const act=(b as HTMLElement).dataset.act; const id=(b as HTMLElement).dataset.id!;
        if(act==='edit'){ closeAdmin(); $('collection').classList.remove('hidden'); renderCollection(); ($('tabBuilder') as HTMLElement).click(); const sel=document.getElementById('dbMyDecks') as HTMLSelectElement; if(sel){ sel.value=id; sel.dispatchEvent(new Event('change')); } showToast('Открыт конструктор'); }
        else if(act==='dup'){
          const src = all.find(x=>x.id===id); if(!src) return;
          const copy = { id: `adm-`+Date.now(), name: src.name+' (копия)', faction: src.faction, cards: src.cards.slice(), updated: Date.now() } as unknown as CustomDeck;
          const arr = loadCustomDecks(); arr.push(copy); saveCustomDecks(arr); showToast('Скопировано'); renderAdmin();
        } else if(act==='del'){
          if(!confirm('Удалить колоду?')) return;
          const arr = loadCustomDecks().filter(x=>x.id!==id); saveCustomDecks(arr); showToast('Удалена'); renderAdmin();
        }
      });
    });
  };
  host.querySelector('#admDeckNew')?.addEventListener('click', ()=>{ closeAdmin(); $('collection').classList.remove('hidden'); renderCollection(); (document.getElementById('btnDbNew') as HTMLElement)?.click(); });
  host.querySelector('#admDeckExport')?.addEventListener('click', ()=>{
    const data = JSON.stringify(loadCustomDecks(), null, 2);
    const blob=new Blob([data],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='decks.json'; a.click(); URL.revokeObjectURL(a.href);
  });
  host.querySelector('#admDeckWipe')?.addEventListener('click', ()=>{
    if(!confirm('Удалить ВСЕ кастомные колоды?')) return;
    saveCustomDecks([]); showToast('Очищено'); renderAdmin();
  });
  render();
}
function renderAdminSystem(host:HTMLElement): void {
  host.innerHTML = `<div class="admGrid">
    <div class="admCard"><h4>💾 Сохранения</h4>
      <div style="font-size:.72rem;color:#cbb98a">localStorage: <b style="color:#ffe9b0">${Object.keys(window.localStorage).filter(k=>k.startsWith('ec_')).length}</b> ключей · ${Math.round(JSON.stringify(window.localStorage).length/1024)} KB</div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn" id="admSysExport">Экспорт JSON</button><button class="btn" id="admSysImport">Импорт</button><button class="btn danger" id="admSysClear">Очистить всё</button></div>
      <div style="font-size:.62rem;color:#8b93ab;margin-top:.4rem">Экспорт = ec_meta_v1 + ec_shards_v1 + ec_owned_v2 + echo-citadel.decks.v1 — в проде храни в БД</div>
    </div>
    <div class="admCard"><h4>🎨 Фоны</h4>
      <div style="font-size:.72rem;color:#cbb98a">Кидай файлы в <b style="color:#ffe9b0">art_raw/backgrounds/&lt;menu|battle&gt;/</b> и <b style="color:#ffe9b0">backgrounds_animated</b> — роут /bg/... уже работает</div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn" id="admSysBgTest">Проверить /bg/menu/menu</button><button class="btn" id="admSysBgClear">Сбросить фоны</button></div>
      <div id="admSysBgLog" style="font-size:.66rem;color:#8b93ab;margin-top:.4rem;max-height:60px;overflow:auto;background:rgba(0,0,0,.18);padding:.3rem .4rem;border-radius:6px">—</div>
    </div>
    <div class="admCard"><h4>📜 Логи</h4>
      <div style="font-size:.72rem;color:#cbb98a">Последние 20 матчей: ${(meta.history||[]).length} · телеметрия: ${(meta.telem||[]).length}</div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn" id="admSysLogClear">Очистить логи</button><button class="btn" id="admSysLogExport">Экспорт логов</button></div>
    </div>
    <div class="admCard"><h4>⚙️ Настройки</h4>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.2rem">
        <button class="btn" id="admSysFx">Переключить FX</button>
        <button class="btn" id="admSysSound">Звук вкл/выкл</button>
        <button class="btn" id="admSysLang">RU ↔ EN</button>
      </div>
      <div style="font-size:.62rem;color:#8b93ab;margin-top:.4rem">Клиентские настройки в ec_settings_v1</div>
    </div>
  </div>
  <div class="admCard" style="margin-top:.6rem"><h4>🔐 Безопасность</h4><div style="font-size:.72rem;color:#cbb98a">Пароль прототипа admin хранится только в браузере. Для прода: <code style="background:rgba(0,0,0,.3);padding:.1rem .3rem;border-radius:4px">POST /api/admin/login → JWT role:admin</code> + проверка Authorization: Bearer на /api/admin/*.</div></div>`;
  host.querySelector('#admSysExport')?.addEventListener('click', ()=>{
    const data = { meta, shards: shardsGet(), gems: gemsGet(), owned: Array.from(getOwnedMap().entries()), decks: loadCustomDecks() };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='echo-admin-'+new Date().toISOString().slice(0,10)+'.json'; a.click(); URL.revokeObjectURL(a.href);
  });
  host.querySelector('#admSysImport')?.addEventListener('click', ()=>{
    const inp=document.createElement('input'); inp.type='file'; inp.accept='.json';
    inp.onchange=()=>{ const f=inp.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ try{ const j=JSON.parse(r.result as string); if(j.meta) { meta=j.meta; metaSave(); } if(j.shards!=null) shardsSet(j.shards); if(j.gems!=null) { meta.gems=j.gems; metaSave(); } if(j.owned) setOwnedMap(new Map(j.owned)); if(j.decks) saveCustomDecks(j.decks); showToast('Импортировано'); renderAdmin(); }catch(e){ alert('Ошибка: '+e); } }; r.readAsText(f); };
    inp.click();
  });
  host.querySelector('#admSysClear')?.addEventListener('click', ()=>{
    if(!confirm('Очистить ВСЁ (localStorage ec_*)?')) return;
    Object.keys(window.localStorage).filter(k=>k.startsWith('ec_')).forEach(k=>window.localStorage.removeItem(k));
    location.reload();
  });
  host.querySelector('#admSysBgTest')?.addEventListener('click', async ()=>{
    const log=host.querySelector('#admSysBgLog') as HTMLElement;
    log.textContent='Проверка...';
    const urls=['/bg/menu/menu','/bg/battle/battle','/bg/animated/menu/menu'];
    let out='';
    for(const u of urls){
      try{ const r=await fetch(u, {method:'HEAD'}); out+=u+' → '+r.status+' '+(r.headers.get('content-type')||'')+'\n'; }catch(e){ out+=u+' → error '+e+'\n'; }
    }
    log.textContent=out;
  });
  host.querySelector('#admSysBgClear')?.addEventListener('click', ()=>{ showToast('Фоны — файлы на диске, очисти art_raw/backgrounds/ вручную'); });
  host.querySelector('#admSysLogClear')?.addEventListener('click', ()=>{ meta.history=[]; meta.telem=[]; metaSave(); showToast('Логи очищены'); renderAdmin(); });
  host.querySelector('#admSysLogExport')?.addEventListener('click', ()=>{
    const blob=new Blob([JSON.stringify({history:meta.history, telem:meta.telem},null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='logs.json'; a.click(); URL.revokeObjectURL(a.href);
  });
  host.querySelector('#admSysFx')?.addEventListener('click', ()=>{ const cur=document.body.classList.contains('fxLite'); document.body.classList.toggle('fxLite', !cur); showToast(!cur?'FX выкл':'FX вкл'); });
  host.querySelector('#admSysSound')?.addEventListener('click', ()=>{ const cur=(window as unknown as { _soundOn?:boolean })._soundOn; (window as unknown as { _soundOn?:boolean })._soundOn=!cur; showToast(!cur?'Звук вкл':'Звук выкл'); });
  host.querySelector('#admSysLang')?.addEventListener('click', ()=>{
    const cur=(document.documentElement.lang||'ru'); const next=cur==='ru'?'en':'ru'; void switchLang(next); showToast(bi('Язык ','Language ')+next);
  });
}
document.addEventListener('DOMContentLoaded', ()=>{ updateAdminBtns(); });
($('btnAdmin') as HTMLElement | null)?.addEventListener('click', openAdmin);
($('btnAdminMenu') as HTMLElement | null)?.addEventListener('click', openAdmin);
($('btnAdminClose') as HTMLElement | null)?.addEventListener('click', closeAdmin);
($('btnAdminClose2') as HTMLElement | null)?.addEventListener('click', closeAdmin);
($('adminModal') as HTMLElement | null)?.addEventListener('click', e=>{ if(e.target===$('adminModal')) closeAdmin(); });
($('adminLogin') as HTMLElement | null)?.addEventListener('click', e=>{ if(e.target===$('adminLogin')) closeAdminLogin(); });
($('btnAdminLoginCancel') as HTMLElement | null)?.addEventListener('click', closeAdminLogin);
($('btnAdminLogin') as HTMLElement | null)?.addEventListener('click', ()=>{
  const v=(($('adminPass') as HTMLInputElement).value||'').trim();
  if(v==='admin'){ setAdmin(true); closeAdminLogin(); openAdmin(); showToast('Админка открыта'); }
  else { ($('adminLoginErr') as HTMLElement).textContent='Неверный пароль'; }
});
($('btnAdminSave') as HTMLElement | null)?.addEventListener('click', ()=>{ showToast('Сохранено'); renderAdmin(); });
document.querySelectorAll('#adminTabs .admTab').forEach(el=>{
  el.addEventListener('click', ()=>{ adminTab=(el as HTMLElement).dataset.tab||'me'; renderAdmin(); });
});
document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='a'){ e.preventDefault(); openAdmin(); }
});

/* ---- Гейт «В БОЙ»: минимум 60 карт, без верхнего лимита, до 4 копий любой карты ---- */
function updatePlayGate(): void {
  const b = btn('btnPlay');
  const id = sel('deckPick').value;
  const deck = resolveDeck(id, deckList as unknown as DeckLike[]);
  const problem = deck ? deckPlayProblem(deck) : 'колода не найдена';
  const problems = problem ? [problem] : [];
  b.disabled = problems.length > 0;
  b.title = problems.length > 0 ? `Колода не собрана: ${problems[0]}` : 'Начать бой';
  // видимая подсказка гейта (не только title) — юзабилити главного экрана
  const ph = document.getElementById('playHint') as HTMLElement | null;
  if (ph) {
    if (problems.length > 0) { ph.hidden = false; ph.textContent = `⚠ Колода не собрана: ${problems[0]}`; }
    else { ph.hidden = true; ph.textContent = ''; }
  }
}
sel('deckPick').addEventListener('change', () => {
  Sfx.uiClick();
  const id = sel('deckPick').value;
  const deck = resolveDeck(id, deckList as unknown as DeckLike[]);
  menuSelectedDeckId = id || null;
  saveMenuDeck();
  if (deck && FACTION_IDS.includes(deck.faction as Faction) && deck.faction !== picked) {
    picked = deck.faction as Faction;
    savePicked();
  }
  buildMenu();
});

/* «Создать колоду» → Коллекция · вкладка «Конструктор колод» (спека п.1.3). */
btn('btnMakeDeck').addEventListener('click', () => {
  Sfx.uiClick();
  openCollectionScreen();
  btn('tabBuilder').click();
  if (loadCustomDecks().length === 0) btn('btnDbNew').click();
});

/* Создание матча на сервере (спека п.1.4): POST /api/match/start → match_id (телеметрия/реплеи).
   Сервер недоступен — локальный бой как прежде (matchId = null), таймаут 700 мс. */
async function requestMatchStart(): Promise<string | null> {
  try {
    if (typeof window.fetch !== 'function') return null;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 700);
    const r = await window.fetch(`http://${window.location.hostname}:8080/api/match/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        playerFaction: picked, enemyFaction: battle.enemyFaction, difficulty: battle.difficulty,
        deckId: battle.playerDeckId, practice: battle.practice, mmr: meta.mmr,
      }),
    });
    window.clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json() as { match_id?: string };
    return j.match_id ?? null;
  } catch { return null; }
}

function applyBattleBg(playerFaction: Faction = picked): void {
  // Получаем выбранную фракцию аргументом: вызывающий код не должен полагаться на
  // battle.playerFaction, который до старта матча может содержать значение прошлого боя.
  const fac = String(playerFaction || picked).toLowerCase();
  const imgEl = document.getElementById('battleBgImg') as HTMLImageElement | null;
  const vidEl = document.getElementById('battleBgVideo') as HTMLVideoElement | null;
  const backdrop = document.getElementById('backdrop') as HTMLElement | null;
  if (!backdrop) return;
  const tableSkin = String(meta.tableSkin || 'classic');
  const tableUrl = [`/cosm/tables/${encodeURIComponent(tableSkin)}`];
  const imgUrls = [...tableUrl, `/bg/battle/battle_${fac}`, `/bg/battle/battle`, `img/board_arena.png`];
  const vidUrls = [`/bg/animated/battle/battle_${fac}`, `/bg/animated/battle/battle`];
  const loadImg = (idx:number) => {
    if (idx >= imgUrls.length) {
      if (imgEl) imgEl.classList.remove('show');
      backdrop.classList.remove('hasCustomBg');
      loadVid(0);
      return;
    }
    const url = imgUrls[idx];
    const probe = new Image();
    probe.onload = () => {
      if (imgEl) { imgEl.src = url; imgEl.classList.add('show'); (imgEl.style as any).opacity='0.92'; }
      backdrop.classList.add('hasCustomBg');
      if (vidEl) { vidEl.classList.remove('show'); vidEl.style.display='none'; vidEl.pause(); }
    };
    probe.onerror = () => loadImg(idx+1);
    probe.src = url;
  };
  const loadVid = (idx:number) => {
    if (!vidEl || idx >= vidUrls.length) return;
    const url = vidUrls[idx];
    const test = document.createElement('video');
    test.muted = true;
    test.oncanplay = () => {
      vidEl.src = url; vidEl.style.display='block'; vidEl.classList.add('show'); (vidEl.style as any).opacity='0.92'; vidEl.play().catch(()=>{});
      backdrop.classList.add('hasCustomBg');
      if (imgEl) imgEl.classList.remove('show');
    };
    test.onerror = () => loadVid(idx+1);
    test.src = url;
    window.setTimeout(()=>{ if(test.readyState<2) loadVid(idx+1); }, 800);
  };
  loadImg(0);
}
btn('btnPlay').addEventListener('click', () => {
  audioUnlock(); musicStart(); Sfx.uiClick();
  applyBattleBg(picked);
  battle.playerFaction = picked;
  battle.playerDeckId = sel('deckPick').value;
  const fromMenu = battle.launchMode === 'menu';
  if (fromMenu) {
    const ev = sel('enemyFaction').value;
    battle.enemyFaction = ev === '__random'
      ? FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)]
      : (ev as Faction);
    battle.difficulty = parseFloat(sel('difficulty').value);
    battle.practice = !!(document.getElementById('chkPractice') as HTMLInputElement | null)?.checked;
    battle.friendFoe = null; battle.bossPower = null; battle.bossHp = 0; battle.tutLesson = 0; battle.campNode = null;
  }
  battle.launchMode = 'menu';
  void (async () => {
    battle.matchId = fromMenu ? await requestMatchStart() : null;
    battle.start().catch(err => reportFatal('start', err));
  })();
});
btn('btnEndTurn').addEventListener('click', () => battle.endTurnNow());
for (const [hid, sd] of [['playerHero', Side.Player], ['enemyHero', Side.Opponent]] as [string, Side][]) {
  $(hid).addEventListener('click', () => {
    if (battle.pendingTarget && $(hid).classList.contains('droppable')) { battle.pendingTarget(null, sd); return; }
    if (battle.pendingAttack !== null && sd === Side.Opponent && $(hid).classList.contains('droppable')) {
      void battle.resolveManualAttack(undefined, true);
    }
  });
}
$('playerGrave').closest('.stat')?.addEventListener('click', () => battle.openGrave(Side.Player));
$('playerGraveZone').addEventListener('click', () => battle.openGrave(Side.Player));
$('enemyGraveZone').addEventListener('click', () => battle.openGrave(Side.Opponent));
$('enemyGrave').closest('.stat')?.addEventListener('click', () => battle.openGrave(Side.Opponent));
$('graveClose').addEventListener('click', () => $('graveModal').classList.add('hidden'));
$('graveModal').addEventListener('click', ev => { if (ev.target === $('graveModal')) $('graveModal').classList.add('hidden'); });
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && !$('factionModal').classList.contains('hidden')) { closeFactionModal(); return; }
  if (ev.key === 'Escape' && !$('graveModal').classList.contains('hidden')) { $('graveModal').classList.add('hidden'); return; }
  if (ev.key === 'Escape') battle.cancelAttack();
});
// ПКМ — отмена выбора цели/атаки, как в MTG
document.addEventListener('contextmenu', ev => {
  if (battle.pendingTarget) { ev.preventDefault(); battle.pendingTarget(null, null); return; }
  if (battle.pendingAttack !== null) { ev.preventDefault(); battle.cancelAttack(); }
});
btn('btnSkip').addEventListener('click', () => battle.endTurnNow());
btn('btnAutoBattle').addEventListener('click', () => battle.closeCombatWindow());
btn('btnSkipCombat').addEventListener('click', () => battle.skipCombat());
btn('btnBoosters').addEventListener('click', () => openBoosterPanel(btn('btnBoosters')));
btn('btnProfile').addEventListener('click', () => openProfile());
btn('btnProfileClose').addEventListener('click', () => navigateApp('back'));
btn('btnShop').addEventListener('click', () => openShop());
btn('btnShopClose').addEventListener('click', () => navigateApp('back'));
btn('btnCampaign').addEventListener('click', () => openCampaign());
btn('btnCampClose').addEventListener('click', () => $('campaignModal').classList.add('hidden'));
btn('btnTour').addEventListener('click', () => openTut());
btn('btnBP').addEventListener('click', () => openBP());
btn('btnBPClose').addEventListener('click', () => navigateApp('back'));
btn('btnPackNew').addEventListener('click', () => { shopTab = 'boosters'; openShop(); });
btn('btnPackPrem').addEventListener('click', () => { newPremPack(); });
btn('btnPackClose').addEventListener('click', () => { closeBoosterPanel(true); navigateApp('back'); });
(() => {
  const panel = document.getElementById('boosterModal');
  panel?.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Tab' || panel.classList.contains('hidden')) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(el => !el.closest('.hidden') && el.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { ev.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !panel.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (active === last || !panel.contains(active))) { ev.preventDefault(); first.focus(); }
  });
  const sealed = document.getElementById('packSealed');
  if (sealed) {
    sealed.addEventListener('click', () => revealPack());
    sealed.addEventListener('keydown', (ev: KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); revealPack(); } });
  }
})();
btn('btnInstantPass').addEventListener('click', () => battle.passInstant());
btn('btnJournal').addEventListener('click', () => openJournal());
btn('btnJournalClose').addEventListener('click', () => $('journalModal').classList.add('hidden'));
btn('cmCraft').addEventListener('click', () => {
  const c = modalList[modalIdx]; if (!c) return;
  const msg = craftCard(c.id); renderCardModal(); renderCollection();
  btn('cmCraft').title = msg;
});
btn('cmDust').addEventListener('click', () => {
  const c = modalList[modalIdx]; if (!c) return;
  const msg = disenchantCard(c.id); renderCardModal(); renderCollection();
  btn('cmDust').title = msg;
});
btn('cmFoil').addEventListener('click', () => {
  const c = modalList[modalIdx]; if (!c) return;
  if ((meta.foilTokens ?? 0) <= 0) { showToast('Нет фойл-жетонов — награда пропуска (премиум, 5 уровень)'); return; }
  if ((foils.get(c.id) ?? 0) >= PLAYSET) { showToast('Уже максимум фойл-копий этой карты'); return; }
  meta.foilTokens = (meta.foilTokens ?? 0) - 1;
  foils.set(c.id, (foils.get(c.id) ?? 0) + 1);
  foilSave(); metaSave();
  showToast(`🌟 «${c.name}» — фойл-версия создана!`);
  renderCardModal(); renderCollection();
});
btn('cmBorderless').addEventListener('click', () => {
  const c = modalList[modalIdx]; if (!c || !hasBorderless(c.id)) return;
  const equipped = toggleBorderless(c.id);
  modalStyles[modalIdx] = 'auto';
  renderCardModal();
  if (!$('collection').classList.contains('hidden')) {
    if (!$('dbMain').classList.contains('hidden')) renderEditor();
    else renderCollection();
  }
  showToast(equipped ? `◇ Borderless надет: «${cardName(c)}»` : `Классический стиль включён: «${cardName(c)}»`);
});
let profTab = 'gen';
const FRAME_DEFS: Array<{ id: string; ru: string; req: () => boolean }> = [
  { id: 'bronze', ru: 'Бронза', req: () => true },
  { id: 'silver', ru: 'Серебро · 10 побед', req: () => !!meta.ach.win10 },
  { id: 'gold', ru: 'Золото · 10 бустеров', req: () => !!meta.ach.packs10 },
  { id: 'crystal', ru: 'Кристалл · пропуск 45 ур.', req: () => (meta.bpClaimedP ?? []).includes(45) },
  { id: 'mythic', ru: 'Мифический · все боссы', req: () => FACTION_IDS.every(f => meta.campaign[f]) },
];
const PREMIUM_AVATARS: Record<string, { ru: string; glyph: string; req: () => boolean }> = {
  arch: { ru: 'Архонт', glyph: '✧', req: () => (meta.avatarsOwned ?? []).includes('arch') },
  lich: { ru: 'Лич', glyph: '💀', req: () => !!meta.ach.packs10 },
  lunar: { ru: 'Лунный Архонт', glyph: '☾', req: () => (meta.avatarsOwned ?? []).includes('lunar') },   // пропуск 40 ур. (премиум)
};
function avaGlyph(): string {
  const pa = PREMIUM_AVATARS[meta.avatarFac];
  return pa ? pa.glyph : (FACTION_SIGIL[meta.avatarFac] ?? '✦');
}
/* ---- Достижения (спека 2.5): единый список, прогресс, тост с иконкой и звуком, награда ---- */
interface AchDef {
  id: string; ru: string; ico: number; rewardRu: string;
  prog: () => [number, number]; check: () => boolean; grant: () => void;
}
const ACH_DEFS: AchDef[] = [
  { id: 'first_win', ru: 'Первая победа', ico: 0, rewardRu: '🪙100',
    prog: () => [Math.min(meta.wins, 1), 1], check: () => meta.wins >= 1,
    grant: () => shardsAdd(100) },
  { id: 'win10', ru: '10 побед', ico: 4, rewardRu: '🪙200 + рамка «Серебро»',
    prog: () => [Math.min(meta.wins, 10), 10], check: () => meta.wins >= 10,
    grant: () => shardsAdd(200) },
  { id: 'packs10', ru: '10 бустеров открыто', ico: 2, rewardRu: '🪙200 + аватар «Лич»',
    prog: () => [Math.min(meta.packs, 10), 10], check: () => meta.packs >= 10,
    grant: () => shardsAdd(200) },
  { id: 'mythic', ru: 'Все боссы кампании побеждены', ico: 5, rewardRu: '🪙500 + 💎50',
    prog: () => [FACTION_IDS.filter(f => meta.campaign[f]).length, FACTION_IDS.length],
    check: () => FACTION_IDS.every(f => meta.campaign[f]),
    grant: () => { shardsAdd(500); gemsAdd(50); } },
];
function checkAchs(): void {
  let unlocked = false;
  for (const a of ACH_DEFS) {
    if (meta.ach[a.id] || !a.check()) continue;
    meta.ach[a.id] = true;
    a.grant();
    achToast(a);
    unlocked = true;
  }
  if (unlocked) { metaSave(); renderShards(); }
}
function achToast(a: AchDef): void {
  Sfx.achievement();
  const n = $('subsLine');
  if (!n) return;
  n.innerHTML = `<img class="achIco" src="img/ico_ach_${a.ico}.png" alt="" onerror="this.remove()"> ` +
    `🏆 Достижение: ${esc(a.ru)} — награда ${a.rewardRu}`;
  n.classList.add('on');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { n.classList.remove('on'); n.textContent = ''; }, 3600);
}

/* ---- Level Up (спека 2.1): оверлей-анимация с частицами ---- */
function levelUpFx(lvl: number): void {
  const fx = $('levelUpFx');
  if (!fx) return;
  Sfx.levelUp();
  const txt = fx.querySelector('.luText');
  if (txt) txt.textContent = `Уровень ${lvl}!`;
  const parts = fx.querySelector('.luParts') as HTMLElement | null;
  if (parts) {
    parts.innerHTML = '';
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('span');
      s.className = 'luP';
      s.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 340)}px`);
      s.style.setProperty('--dy', `${Math.round(-60 - Math.random() * 240)}px`);
      s.style.animationDelay = `${(i % 8) * 45}ms`;
      s.style.background = i % 3 === 0 ? '#ffd87a' : i % 3 === 1 ? '#fff3d1' : '#b98f3e';
      parts.appendChild(s);
    }
  }
  fx.classList.add('on');
  window.setTimeout(() => fx.classList.remove('on'), 2600);
}

/* ---- Никнейм (спека 2.1): 3–16 символов, без мата, уникальность проверяется на сервере ---- */
const NICK_OK = /^[\wА-Яа-яЁё .-]{3,16}$/u;
const NICK_BAD = /(ху[йяюеи]|пизд|еб[а-яу]|бля|сук[аи]|муд[ао]к|говн|дроч|fuck|shit|bitch|asshole)/iu;
function invalidNick(v: string): string | null {
  if (v.length < 3 || v.length > 16) return 'Никнейм: от 3 до 16 символов';
  if (!NICK_OK.test(v)) return 'Никнейм: только буквы, цифры, пробел, точка, дефис, подчёркивание';
  if (NICK_BAD.test(v)) return 'Никнейм: недопустимые слова';
  return null;
}
async function checkNickFree(v: string, prev: string): Promise<void> {
  try {
    if (typeof window.fetch !== 'function') return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 800);
    const r = await window.fetch(
      `${META_API()}/api/profile/nick?nick=${encodeURIComponent(v)}&pid=${encodeURIComponent(meta.pid)}`,
      { signal: ctl.signal });
    window.clearTimeout(t);
    if (!r.ok) return;
    const j = await r.json() as { free?: boolean };
    if (j.free === false && meta.nick === v) {
      meta.nick = prev;
      meta.signedIn = prev !== 'Гость';
      metaSave();
      showToast(`Никнейм «${v}» занят другим игроком`);
      if (!$('profileModal').classList.contains('hidden')) openProfile();
    }
  } catch { /* сервер недоступен — ник остаётся локальным */ }
}
document.addEventListener('change', ev => {
  const t = ev.target as HTMLElement | null;
  if (t?.id !== 'nickInput') return;
  const v = ((t as HTMLInputElement).value || '').trim();
  const prev = meta.nick ?? 'Гость';
  if (!v || v === prev) { openProfile(); return; }
  const bad = invalidNick(v);
  if (bad) { showToast(bad); openProfile(); return; }
  meta.nick = v;
  meta.signedIn = v !== 'Гость';
  metaSave();
  showToast(meta.signedIn ? `Ник сохранён: ${v}` : 'Вы играете как Гость');
  openProfile();
  void checkNickFree(v, prev);
});

/* ---- Вкладка «Фракции»: клик по строке → винрейт против каждой фракции (спека 2.2) ---- */
let facDetail: string | null = null;
function facDetailHtml(): string {
  if (!facDetail) return '';
  const rows = FACTION_IDS.filter(x => x !== facDetail).map(en => {
    const hs = meta.history.filter(h => h.fac === facDetail && h.efac === en);
    const w = hs.filter(h => h.win).length;
    const l = hs.length - w;
    const wr = hs.length ? Math.round((w / hs.length) * 100) : 0;
    return `<div class="jl">vs ${FACTION_RU[en as Faction]}: ${w}–${l}${hs.length ? ` · <b>${wr}%</b>` : ' · матчей не было'}</div>`;
  }).join('');
  return `<div class="facDetail">
    <div class="jl you" data-mf="${facDetail}" style="cursor:pointer" title="Клик — свернуть">▾ ${FACTION_RU[facDetail as Faction]} — винрейт против фракций</div>
    ${rows}</div>`;
}
document.addEventListener('click', ev => {
  const mf = (ev.target as HTMLElement | null)?.closest?.('[data-mf]') as HTMLElement | null;
  if (!mf?.dataset.mf) return;
  if ($('profileModal').classList.contains('hidden')) return;
  facDetail = facDetail === mf.dataset.mf ? null : mf.dataset.mf;
  openProfile();
});

function openProfile(): void {
  setAppRoute('profile');
  $('menu').classList.add('hidden');
  for (const id of ['homeScreen','eventsScreen','decksScreen','collection','shopModal','bpModal','boosterModal','campaignModal'])
    document.getElementById(id)?.classList.add('hidden');
  const lvl = Math.floor(meta.xp / 500) + 1;
  const into = meta.xp % 500;
  const rank = rankOf(meta.mmr);
  const best = rankOf(meta.bestMmr ?? meta.mmr);
  const totalMatches = meta.wins + meta.losses;
  const winRate = totalMatches ? Math.round(meta.wins / totalMatches * 100) : 0;
  const ownedBorderless = meta.borderlessOwned?.length ?? 0;
  const head = `
    <section class="profileHero">
      <div class="prfHead">
        <div class="fava avaBig frame-${meta.frame || 'bronze'}">${avaGlyph()}${
          PREMIUM_AVATARS[meta.avatarFac] ? '' : `<img src="/heroes/${encodeURIComponent(meta.avatarFac)}" alt="" onerror="this.remove()">`}</div>
        <div class="profileIdentity">
          <div class="profileNameRow">
            <input id="nickInput" maxlength="16" value="${esc(meta.nick ?? 'Гость')}" aria-label="Никнейм" title="3–16 символов; уникальность проверяется на сервере">
            <span class="profileAccountTag">${meta.signedIn ? 'АККАУНТ' : 'ГОСТЬ'}</span>
          </div>
          <div class="profileRankLine"><span class="profileRankMark">✦</span><b>${rank.title}</b><span>Лучший ранг: ${best.title}</span></div>
          <div class="profileMeterLabel"><span>Уровень ${lvl} · опыт</span><span>${into}/500</span></div>
          <div class="profileMeter"><i class="xpMeter" style="width:${(into / 500) * 100}%"></i></div>
          <div class="profileMeterLabel rankMeterLabel"><span>Прогресс к рангу ${rank.next}</span><span>${Math.round(rank.prog * 100)}%</span></div>
          <div class="profileMeter rankMeter"><i class="rankMeterFill" style="width:${rank.prog * 100}%"></i></div>
        </div>
      </div>
      <div class="profileStatsRow">
        <div class="profileStat"><small>РЕЙТИНГ</small><b>${fmtNum(meta.mmr)}</b><span>MMR</span></div>
        <div class="profileStat"><small>ПОБЕДЫ</small><b>${fmtNum(meta.wins)}</b><span>${winRate}% побед</span></div>
        <div class="profileStat"><small>КОЛЛЕКЦИЯ</small><b>${ownedBorderless}<em> / ${ALL_CARDS.length}</em></b><span>Borderless</span></div>
      </div>
    </section>
    <div class="ptabs profileTabs">
      ${([['gen', 'Обзор'], ['ranked', 'Ранг'], ['cosm', 'Косметика'], ['facs', 'Фракции'], ['hist', 'История'], ['fr', 'Друзья']] as Array<[string, string]>).map(([id, ru]) =>
        `<button class="btn ptab${profTab === id ? ' sel' : ''}" data-ptab="${id}">${ru}</button>`).join('')}
    </div>`;
  let bodyHtml = '';
  if (profTab === 'gen') {
    const total = meta.wins + meta.losses;
    const wrAll = total ? Math.round((meta.wins / total) * 100) : 0;
    let fav = '—'; let favN = -1;
    for (const f of FACTION_IDS) if ((meta.facW[f] ?? 0) > favN) { favN = meta.facW[f] ?? 0; fav = favN > 0 ? FACTION_RU[f as Faction] : '—'; }
    const t = meta.telem ?? [];
    const avgT = t.length ? Math.round(t.reduce((a, b) => a + b.turns, 0) / t.length) : 0;
    const avgS = t.length ? Math.round(t.reduce((a, b) => a + b.secs, 0) / t.length) : 0;
    const stuckC = new Map<string, number>();
    for (const m of t) for (const id of m.stuck) stuckC.set(id, (stuckC.get(id) ?? 0) + 1);
    const topStuck = [...stuckC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => `${db.get(id)?.name ?? id} ×${n}`).join(', ') || '—';
    const qs = meta.quests.map(q => {
      const done = q.prog >= q.goal;
      return `<div class="setRow profileQuestRow" style="margin:0">
        <div class="profileQuestText">${esc(QUEST_RU[q.id]?.(q) ?? q.id)} — ${q.prog}/${q.goal}${done ? '<small class="questInlineReset questReset" data-quest-reset="daily" data-reset-prefix="Сброс через">—</small>' : ''}</div>
        <button class="btn qClaim" data-q="${esc(q.id)}" ${done && !q.claimed ? '' : 'disabled'}>
          ${q.claimed ? 'Получено' : `🪙${DAILY_REWARD[q.id] ?? 0}`}</button></div>`;
    }).join('');
    const wqs = (meta.wquests ?? []).map(q => {
      const done = q.prog >= q.goal;
      return `<div class="setRow profileQuestRow" style="margin:0">
        <div class="profileQuestText profileWeeklyQuestText">${esc(WQUEST_RU[q.id] ?? q.id)} — ${q.prog}/${q.goal}${done ? '<small class="questInlineReset questReset" data-quest-reset="weekly" data-reset-prefix="Сброс через">—</small>' : ''}</div>
        <button class="btn wqClaim" data-q="${esc(q.id)}" ${done && !q.claimed ? '' : 'disabled'}>
          ${q.claimed ? 'Получено' : `🪙${WEEK_REWARD[q.id] ?? 0} +250 BP`}</button></div>`;
    }).join('');
    const achs = ACH_DEFS.map(a => {
      const [p, g] = a.prog();
      return `<div class="jl ${meta.ach[a.id] ? 'you' : ''}" title="Награда: ${a.rewardRu}">
      <img class="achIco" src="img/ico_ach_${a.ico}.png" alt="" onerror="this.remove()">${meta.ach[a.id] ? '🏆' : '🔒'} ${a.ru} — <b>${p}/${g}</b></div>`;
    }).join('');
    const avas = FACTION_IDS.map(f =>
      `<button class="btn avaBtn${meta.avatarFac === f ? ' sel' : ''}" data-f="${f}" title="${FACTION_RU[f as Faction]}">${FACTION_SIGIL[f]}</button>`).join('')
      + Object.entries(PREMIUM_AVATARS).map(([id, a]) =>
        `<button class="btn avaBtn${meta.avatarFac === id ? ' sel' : ''}" data-f="${id}" ${a.req() ? '' : 'disabled'} title="${a.ru}">${a.req() ? a.glyph : '🔒'}</button>`).join('');
    const frames = FRAME_DEFS.map(fr =>
      `<button class="btn frameBtn${meta.frame === fr.id ? ' sel' : ''}" data-fr="${fr.id}" title="${fr.ru}">${fr.req() ? '◆' : '🔒'} ${fr.ru}</button>`).join('');
    bodyHtml = `
      <div class="profileOverviewGrid">
        <section class="profilePanel profileSummaryPanel">
          <h3 class="profilePanelTitle">Статистика сезона</h3>
          <div class="profileMetricGrid">
            <div class="profileMetric"><small>МАТЧИ</small><b>${total}</b><span>всего</span></div>
            <div class="profileMetric"><small>ВИНРЕЙТ</small><b>${wrAll}%</b><span>побед</span></div>
            <div class="profileMetric"><small>ЛЮБИМАЯ ФРАКЦИЯ</small><b class="profileMetricText">${fav}</b><span>по победам</span></div>
          </div>
          <div class="profileDetailLine">Средняя длина: <b>${avgT ? `${avgT} ходов / ${avgS} с` : '—'}</b></div>
          <div class="profileDetailLine">Чаще застревают: <b>${esc(topStuck)}</b></div>
          <div class="profileCurrencyLine">🪙 <b>${shardsGet()}</b><span>монет</span> · 💎 <b>${gemsGet()}</b><span>гемов</span> · 🎁 <b>${meta.freeOpens ?? 0}</b><span>бустеров</span></div>
        </section>
        <section class="profilePanel profileCustomizationPanel">
          <h3 class="profilePanelTitle">Персонализация</h3>
          <h4 class="shopH">Аватар · 5 фракций + премиум</h4><div class="ptabs profileChoiceGrid">${avas}</div>
          <h4 class="shopH">Рамка · награды достижений</h4><div class="ptabs profileChoiceGrid">${frames}</div>
        </section>
      </div>
      <section class="profilePanel profileTasksPanel"><h3 class="profilePanelTitle">Задания дня</h3>${qs}</section>
      <section class="profilePanel profileTasksPanel"><h3 class="profilePanelTitle">Задания недели</h3>${wqs}</section>
      <section class="profilePanel profileTasksPanel"><h3 class="profilePanelTitle">Достижения</h3>${achs}</section>`;
  }

  if (profTab === 'ranked') {
    const days = seasonDaysLeft();
    const r = rankOf(meta.mmr);
    const best = rankOf(meta.bestMmr ?? meta.mmr);
    const rewards = [
      { name:'Награда Бронзы', sub:'1 бустер', packs:1, gold:0 },
      { name:'Награда Серебра', sub:'1 бустер · 🪙500', packs:1, gold:500 },
      { name:'Награда Золота', sub:'2 бустера · 🪙1000', packs:2, gold:1000 },
      { name:'Награда Платины', sub:'3 бустера · 🪙1000', packs:3, gold:1000 },
      { name:'Награда Алмаза', sub:'4 бустера · 🪙1000', packs:4, gold:1000 },
      { name:'Награда Мифика', sub:'5 бустеров · 🪙1000', packs:5, gold:1000 },
    ];
    const rows = rewards.map(rw=> `
      <div class="rewardRow">
        <div class="rewardName">${rw.name}<span>${rw.sub.replace('\n',' · ')}</span></div>
        <div class="rewardPacks">${Array.from({length:rw.packs}, (_,i)=> `<div class="rewardPack">◈</div>`).join('')}</div>
        <div class="rewardGold">${rw.gold? `<i>🪙</i> ${rw.gold}`:''}</div>
      </div>
    `).join('');
    bodyHtml = `
      <div class="rankedTop">
        <div class="rankedLeft">
          <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem">
            <span style="color:#8b93ab">◀</span>
            <div style="flex:1">
              <div style="font-family:Philosopher,serif;color:#ffe9b0;font-size:1.05rem">${esc(meta.nick ?? 'WotC_Lee#00736')}</div>
              <div style="font-size:.62rem;color:#8b93ab">Season Rewards (Season ends in ${days} days)</div>
            </div>
            <button class="btn" style="padding:.2rem .6rem;font-size:.68rem;background:${r.title.includes('Bronze')? 'linear-gradient(180deg,#8a5a12,#4a3208)': 'linear-gradient(180deg,#2e3a5a,#1a233a)'};color:#ffe9b0">Constructed</button>
            <button class="btn" style="padding:.2rem .6rem;font-size:.68rem;opacity:.55">Limited</button>
          </div>
          <div class="seasonRewards">${rows}</div>
        </div>
        <div class="rankedRight">
          <div style="font-family:Philosopher,serif;color:#ffe9b0;font-size:.82rem">Current Ranks</div>
          <div class="rankEmblem">${r.title.includes('Mythic')?'◆': r.title.includes('Diamond')?'◈': r.title.includes('Platinum')?'⬢': r.title.includes('Gold')?'⬣': '⬥'}</div>
          <div class="rankTitle">${r.title}</div>
          <div class="rankSub">Constructed Rank</div>
          <div class="rankEmblem" style="width:64px;height:64px;font-size:1.2rem;opacity:.75">${best.title.includes('Mythic')?'◆':'⬥'}</div>
          <div class="rankTitle" style="font-size:.82rem">${best.title}</div>
          <div class="rankSub">Limited Rank</div>
        </div>
      </div>
      <div class="jl" style="opacity:.65">Ранг обновляется после каждого рейтингового матча (не в тренировке/кампании). Награды в конце сезона — паки + золото.</div>
    `;
  }
  if (profTab === 'cosm') {
    const sleeves = [
      { id:'classic', name:'Эхо-Цитадель', owned:true },
      { id:'arena', name:'Арена', owned:true },
      { id:'sky', name:'Небесные острова', owned:true },
      { id:'arena2', name:'Арена Вита', owned:true },
      { id:'stained', name:'Витраж', owned:true },
      { id:'forest', name:'Лесной разведчик', owned:true },
      { id:'mage', name:'Синий маг', owned:true },
      { id:'locked1', name:'Космическое море', owned:false },
      { id:'locked2', name:'Горный дракон', owned:false },
      { id:'lotus', name:'Чёрный лотос', owned:false },
      { id:'locked3', name:'Болотный ритуал', owned:false },
      { id:'locked4', name:'Морозный ветер', owned:false },
    ];
    const grid = sleeves.map(s=> `
      <div class="sleeveCard ${meta.backEq===s.id?'sel':''}" data-sleeve="${s.id}" title="${s.name}">
        <img src="/art/${s.id==='lotus'? 'Neutral/lotus' : 'Neutral/neu_01'}.png" alt="" loading="lazy" onerror="this.style.display='none'">
        ${!s.owned? '<div class="lock">🔒</div>':''}
        <div class="sleeveName">${s.name}</div>
      </div>
    `).join('');
    const borderlessProgress = Math.min(BORDERLESS_EVENT_WINS, meta.borderlessEventWins ?? 0);
    const borderlessPanel = `<section class="borderlessProfilePanel">
      <div class="borderlessProfileHead"><div><span class="profileEyebrow">ТЕ ЖЕ КАРТЫ · ТОЛЬКО БЕЗ РАМОК</span>
        <h3>Borderless <b>${ownedBorderless}<i> / ${ALL_CARDS.length}</i></b></h3></div>
        <span class="borderlessGem" aria-hidden="true">◇</span></div>
      <div class="profileMeter borderlessMeter"><i style="width:${ownedBorderless / ALL_CARDS.length * 100}%"></i></div>
      <p>Ещё ${ALL_CARDS.length} коллекционных вариантов: те же названия и арт, но без стандартной рамки. Правила и характеристики не меняются. Получение: событие или шанс <b>0,1% на бустер</b>.</p>
      <div class="borderlessEventMini">Событие «Галерея без границ» · рейтинговые победы: <b>${borderlessProgress}/${BORDERLESS_EVENT_WINS}</b></div>
      <button type="button" class="btn borderlessBrowse" id="btnProfileBorderlessCollection">Открыть Borderless в коллекции →</button>
    </section>`;
    bodyHtml = borderlessPanel + `
      <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
        <div class="sleeveGrid">${grid}</div>
        <div class="sleevePreview">
          <img src="/art/Neutral/neu_01.png" alt="Black Lotus" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.92" onerror="this.style.display='none'">
          <div style="position:absolute;inset:0;background:radial-gradient(60% 50% at 50% 50%,rgba(120,40,255,.18),transparent 70%)"></div>
          <div style="position:relative;z-index:1;text-align:center;color:#ffe9b0;font-family:Philosopher,serif">
            <div style="font-size:2.6rem">🌸</div>
            <div style="font-size:.78rem">Black Lotus</div>
            <div style="font-size:.62rem;color:#cbb98a">Премиум стиль — из пропуска</div>
          </div>
          <div style="position:absolute;right:8px;bottom:8px;display:flex;gap:6px;z-index:1">
            <span style="width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#3fd6c8,#1a5a56);border:1px solid #1a5a56"></span>
            <span style="width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#ffd87a,#8a5a12);border:1px solid #8a5a12"></span>
            <span style="width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#ff7a18,#a33a0a);border:1px solid #a33a0a"></span>
          </div>
        </div>
      </div>
      <div class="jl" style="opacity:.65">Стили карт — рубашки и скины. 🔒 открываются в магазине и пропуске. Клик по стилю — предпросмотр (как на скрине 7).</div>
      <div style="display:flex;justify-content:flex-end;margin-top:.6rem"><button class="btn" id="btnSleeveDefault" style="background:linear-gradient(180deg,#ff9c2a,#e05a0a);color:#fff;border:none;border-radius:999px;padding:.45rem 1.1rem">Set Default</button></div>
    `;
  }

  if (profTab === 'facs') {
    const tot = Math.max(1, FACTION_IDS.reduce((a, f) => a + (meta.facW[f] ?? 0), 0));
    let acc = 0;
    const stops = FACTION_IDS.map(f => {
      const c = colorOf(f).primary; const s0 = (acc / tot) * 360; acc += meta.facW[f] ?? 0;
      return `${c} ${s0.toFixed(1)}deg ${((acc / tot) * 360).toFixed(1)}deg`;
    }).join(', ');
    const rows = FACTION_IDS.map(f => {
      const w = meta.facW[f] ?? 0, l = meta.facL[f] ?? 0;
      const wr = w + l > 0 ? Math.round((w / (w + l)) * 100) : 0;
      return `<div class="jl mfRow${facDetail === f ? ' you' : ''}" data-mf="${f}" style="cursor:pointer" title="Клик — винрейт против каждой фракции"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorOf(f).primary};margin-right:.4rem"></span>
        ${FACTION_RU[f as Faction]}: ${w}–${l} · <b>${wr}%</b>
        <span style="display:inline-block;width:120px;height:6px;border-radius:3px;background:rgba(255,255,255,.1);vertical-align:middle;margin-left:.4rem">
          <span style="display:block;height:100%;width:${wr}%;border-radius:3px;background:${colorOf(f).primary}"></span></span></div>`;
    }).join('');
    bodyHtml = `<div class="donut" style="background:conic-gradient(${stops})"><div class="donutHole">${meta.wins}</div></div>
      <div class="jl" style="text-align:center;opacity:.8">Победы по фракциям (круговая диаграмма) · клик по фракции — винрейт против каждой</div>${rows}${facDetailHtml()}`;
  }
  if (profTab === 'hist') {
    bodyHtml = meta.history.slice(0, 20).map(h => {
      const rp = (meta.replays ?? []).some(r => r.ts === h.ts);
      return `<div class="jl ${h.win ? 'you' : 'foe'}">${h.win ? '✔ Победа' : '✘ Поражение'} · за ${FACTION_RU[h.fac as Faction]}
        · vs ${esc(h.foe ?? 'ИИ')}${h.efac ? ` (${FACTION_RU[h.efac as Faction]})` : ''} · ${h.turns} х.
        · ${new Date(h.ts).toLocaleDateString('ru-RU')}${h.practice ? ' · тренировка' : ''}
        ${rp ? `<button class="btn replayBtn" data-ts="${h.ts}" style="padding:.1rem .5rem;font-size:.64rem;margin-left:.4rem">▶ Реплей</button>` : ''}</div>`;
    }).join('') || '<div class="jl">Матчей ещё не было</div>';
    bodyHtml += '<div class="jl" style="opacity:.7">Реплеи хранятся локально (3 последних): лог событий движка с разбивкой по ходам.</div>';
  }
  if (profTab === 'fr') {
    const rows = (meta.friends ?? []).map(f => {
      const online = (f.nick.charCodeAt(0) + new Date().getHours()) % 3 !== 0;
      return `<div class="setRow" style="margin:0"><span class="${online ? 'onDot' : 'offDot'}"></span>
        <div style="flex:1;font-size:.76rem;color:#e6d6ac">${esc(f.nick)}
          <span style="color:#7a7264;font-size:.68rem">${online ? '· в сети' : '· не в сети'}</span></div>
        <button class="btn frInvite" data-n="${esc(f.nick)}" style="padding:.2rem .6rem;font-size:.68rem">Пригласить в лобби</button>
        <button class="btn frDel" data-n="${esc(f.nick)}" style="padding:.2rem .5rem;font-size:.68rem">✕</button></div>`;
    }).join('') || '<div class="jl">Друзей пока нет — добавьте по никнейму или ID</div>';
    bodyHtml = `${rows}
      <div class="setRow" style="margin:.4rem 0 0">
        <input id="friendNick" maxlength="20" placeholder="Никнейм друга" style="flex:1;background:#14161f;border:1px solid var(--line);color:var(--text);border-radius:4px;padding:.3rem .5rem">
        <button class="btn" id="btnFriendAdd">Добавить в друзья</button></div>
      <div class="jl" style="opacity:.7">Приглашение запускает товарищеский матч без влияния на рейтинг (лобби-сервер — roadmap match-server).</div>`;
  }
  $('profBody').innerHTML = head + bodyHtml;
  updateQuestCountdowns();
  syncProfile();   // спека 2.1–2.4: профиль/задания сохраняются на сервере (best-effort)
  $('profileModal').classList.remove('hidden');
}

// sleeve selection in profile cosm tab
document.addEventListener('click', ev=>{
  const target = ev.target as HTMLElement | null;
  if (target?.closest?.('#btnProfileBorderlessCollection')) {
    openCollectionScreen();
    const style = document.getElementById('colStyle') as HTMLSelectElement | null;
    if (style) { style.value = 'borderless'; style.dispatchEvent(new Event('change', { bubbles: true })); }
    return;
  }
  const sc = target?.closest?.('.sleeveCard') as HTMLElement | null;
  if (sc?.dataset.sleeve && !sc.querySelector('.lock')) {
    Sfx.uiClick();
    meta.backEq = sc.dataset.sleeve;
    metaSave();
    document.body.dataset.back = meta.backEq;
    void applyCosmArt();
    openProfile();
    showToast(`Стиль \u00ab${sc.dataset.sleeve}\u00bb выбран`);
  }
  if ((ev.target as HTMLElement | null)?.id === 'btnSleeveDefault') {
    Sfx.uiClick();
    showToast('Стиль по умолчанию сохранён');
  }
});

function openReplay(ts: number): void {
  const r = (meta.replays ?? []).find(x => x.ts === ts);
  if (!r) { showToast('Реплей не найден'); return; }
  $('replayTitle').textContent = `▶ Реплей: ${r.foe} · ${r.win ? 'победа' : 'поражение'} · ${r.turns} х.`;
  $('replayBody').innerHTML = r.lines.map((l, i) =>
    `<div class="jl rpLine" data-i="${i}">[ход ${l[0]}] ${esc(l[1])}</div>`).join('') || '<div class="jl">Лог пуст</div>';
  $('replayModal').classList.remove('hidden');
}
let replayTimer = 0;
function replayPlay(): void {
  if (replayTimer) { window.clearInterval(replayTimer); replayTimer = 0; return; }
  const lines = Array.from(document.querySelectorAll('#replayBody .rpLine')) as HTMLElement[];
  let i = 0;
  replayTimer = window.setInterval(() => {
    if (i >= lines.length) { window.clearInterval(replayTimer); replayTimer = 0; return; }
    lines.forEach(l => l.classList.remove('you'));
    lines[i].classList.add('you');
    lines[i].scrollIntoView({ block: 'nearest' });
    i += 1;
  }, 110);
}
function inviteFriend(nick: string): void {
  battle.launchMode = 'friend';
  battle.friendFoe = nick;
  battle.practice = true;
  battle.enemyFaction = FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)];
  $('profileModal').classList.add('hidden');
  btn('btnPlay').click();
}
document.addEventListener('click', ev => {
  const t = (ev.target as HTMLElement | null)?.closest?.('.qClaim') as HTMLElement | null;
  if (!t || t.hasAttribute('disabled') || !t.dataset.q) return;
  claimQuestReward('daily', t.dataset.q);
});

const SHOP_BACKS: Record<string, { ru: string; price: number; bpOnly?: boolean }> = {
  classic: { ru: 'Классика (золото)', price: 0 },
  runes: { ru: 'Руны Citadeli', price: 300 },
  ember: { ru: 'Угли Пиромантов', price: 500 },
  abyss: { ru: 'Бездна', price: 0, bpOnly: true },
  verdant: { ru: 'Вердант', price: 0, bpOnly: true },
};
const TABLE_SKINS: Record<string, { ru: string; price: number; cur: 'sh' | 'gem' }> = {
  classic: { ru: 'Классический стол', price: 0, cur: 'sh' },
  terra: { ru: 'Стол Терраморфов (мох и камень)', price: 600, cur: 'sh' },
  necro: { ru: 'Стол Некрусов (кость и тень)', price: 200, cur: 'gem' },
};
const RUNE_SKINS: Record<string, { ru: string; price: number; cur: 'sh' | 'gem' }> = {
  classic: { ru: 'Классические руны', price: 0, cur: 'sh' },
  flame: { ru: 'Руны «Пламя» (анимация)', price: 150, cur: 'gem' },
};
const BUNDLES = FACTION_IDS.map(f => ({ fac: f, price: 400 }));
let shopTab = 'boosters';

/* v2.5.3: пользовательский арт косметики/наборов из art_raw/cosm/<kind>/ отдаётся как
   /cosm/<kind>/<id>. img кладётся поверх CSS-фолбэка; пока файла нет — 404 → onerror
   удаляет img, и остаётся градиент/сигил/веер (правило «никаких заглушек»). */
function cosmImg(kind: 'backs' | 'tables' | 'runes' | 'offers' | 'bundles', id: string, cls: string): string {
  return `<img class="${cls}" src="/cosm/${kind}/${id}?t=${Date.now()}" alt="" loading="lazy" onerror="this.remove()">`;
}

/* ---- Предпросмотр косметики (спека «3. Магазин» п.4.3): рубашка на карте, стол, руны ---- */
function openCosmPreview(kind: string, id: string): void {
  const m = $('cosmPreview');
  const area = $('cosmPrevArea');
  const label = $('cosmPrevLabel');
  if (!m || !area || !label) return;
  area.innerHTML = '';
  if (kind === 'back') {
    const b = SHOP_BACKS[id];
    label.textContent = `Рубашка «${b?.ru ?? id}» — задняя сторона карты`;
    const big = el('div', `cardback big back-${id}`);
    big.innerHTML = cosmImg('backs', id, 'cbArt');
    area.appendChild(big);
    const row = el('div', 'cosmRow');
    row.appendChild(el('span', undefined, 'в стопке руки:'));
    for (let i = 0; i < 3; i++) row.appendChild(el('div', `cardback back-${id}`));
    area.appendChild(row);
  } else if (kind === 'table') {
    const k = TABLE_SKINS[id];
    label.textContent = `Скин стола «${k?.ru ?? id}» — фрагмент игрового поля`;
    const grad = id === 'terra'
      ? 'radial-gradient(120% 90% at 50% 0%,#1d2a1c 0%,#121a12 55%,#0b0f0b 100%)'
      : id === 'necro'
        ? 'radial-gradient(120% 90% at 50% 0%,#241a2c 0%,#150f1a 55%,#0b080e 100%)'
        : 'radial-gradient(120% 90% at 50% 0%,#20242e 0%,#14161f 55%,#0a0c12 100%)';
    const p = el('div', 'tablePrev');
    p.style.background = grad;
    p.insertAdjacentHTML('afterbegin', cosmImg('tables', id, 'tpImg'));
    p.appendChild(el('div', 'jl', 'Ваша зона существ'));
    area.appendChild(p);
  } else if (kind === 'rune') {
    const k = RUNE_SKINS[id];
    label.textContent = `Анимация рун «${k?.ru ?? id}»`;
    const p = el('div', 'runePrev' + (id === 'flame' ? ' flame' : ''));
    for (let i = 0; i < 3; i++) {
      const ch = el('span', 'runeChip');
      ch.innerHTML = `${cosmImg('runes', id, 'rcImg')}✦`;
      p.appendChild(ch);
    }
    area.appendChild(p);
  }
  m.classList.remove('hidden');
}
btn('btnCosmPrevClose').addEventListener('click', () => { Sfx.uiClick(); $('cosmPreview').classList.add('hidden'); });
$('cosmPreview').addEventListener('click', ev => { if (ev.target === $('cosmPreview')) $('cosmPreview').classList.add('hidden'); });

/* --- v2.5.2: магазин в манере магазина MTG Arena (скрин 2): заголовок-витрина,
     горизонтальная лента оффер-карточек, градиентные цены (💎 гемы / 🪙 монеты),
     вкладки-табы внизу. Все id/классы покупок сохранены (buyPack/buyFacPack/buyBundle11/
     btnStarter/buyBundle/backBtn/tableBtn/runeBtn/craftBtn2/cosmPrev + data-stab). --- */
function ofCard(artCls: string, artInner: string, name: string, sub: string, btnHtml: string): string {
  const hl = artCls.includes(' hl') ? ' hl' : '';
  const cls = artCls.replace(' hl','');
  return `<div class="ofCard${hl}"><div class="ofArt ${cls}">${artInner}</div>
    <div class="ofName">${name}</div><div class="ofSub">${sub}</div><div class="ofBuy">${btnHtml}</div></div>`;
}
const OF_FAN = '<span class="ofFan"><i></i><i></i><i></i></span>';
function openShop(): void {
  setAppRoute('store');
  $('menu').classList.add('hidden');
  for (const id of ['homeScreen','eventsScreen','decksScreen','collection','profileModal','bpModal','boosterModal','campaignModal'])
    document.getElementById(id)?.classList.add('hidden');
  void applyCosmArt(); // v2.5.4: свежий дроп арта подхватывается при каждом открытии магазина
  const wallet = `
    <span class="shardPill" title="Монеты: бустеры, создание и разбор карт; дубликаты сверх 4 копий дают монеты"><img class="curIco" src="img/ico_cur_0.png" alt="🪙" onerror="this.outerHTML='🪙 '"> <b>${shardsGet()}</b></span>
    <span class="shardPill" title="Гемы: премиум-валюта (достижения, пропуск, кампания)"><img class="curIco" src="img/ico_cur_1.png" alt="💎" onerror="this.outerHTML='💎 '"> <b>${gemsGet()}</b></span>
    ${(meta.freeOpens ?? 0) > 0 ? `<span class="shardPill" title="Бесплатные бустеры из наборов и пропуска">🎁 <b>${meta.freeOpens}</b></span>` : ''}`;
  const TABS: Array<[string, string]> = [['boosters', 'Предложения'], ['bundles', 'Наборы'], ['cosm', 'Косметика'], ['craft', 'Крафт']];
  const title = (TABS.find(t => t[0] === shopTab) ?? TABS[0])[1];
  let h = `<div class="shTop"><div class="shTitle">${title}</div><div class="shWallet">${wallet}</div></div>`;
  if (shopTab === 'boosters') {
    // Packs витрина как на скрине MTG New Capenna — в тёплой палитре (5 карточек, два прайса)
    type PackOffer = { id:string; ru:string; gem:number; gold:number; qty:number; kind:'pack'|'mythic'; hl?:boolean };
    const PACK_OFFERS: PackOffer[] = [
      { id:'p1',  ru:'1 Бустер',        gem:200,  gold:300,  qty:1,  kind:'pack' },
      { id:'p15', ru:'15 Бустеров',     gem:3000, gold:3900, qty:15, kind:'pack', hl:true },
      { id:'m1',  ru:'1 Мифический',    gem:260,  gold:400,  qty:1,  kind:'mythic' },
      { id:'m10', ru:'10 Мифических',   gem:2600, gold:3600, qty:10, kind:'mythic' },
      { id:'p1b', ru:'1 Бустер',        gem:200,  gold:300,  qty:1,  kind:'pack' },
    ];
    const packVisHtml = (kind:string, qty:number): string => {
      // art_raw/cosm/offers/<id> — если вставишь PNG, он покажется объёмно поверх фолбэка
      const artMyth = cosmImg('offers', 'booster_premium', 'packOfferArtImg');
      const artBooster = cosmImg('offers', 'booster', 'packOfferArtImg');
      const packTile = (packArt: string, theme: 'standard' | 'mythic', layer: 'v1' | 'v2' | 'v3', label: string): string =>
        `<div class="packVis ${theme === 'mythic' ? 'mythic ' : ''}${layer}">${packArt}<span class="pvSig">✦</span><span class="pvLbl">${label}</span></div>`;
      if (kind === 'mythic') {
        if (qty >= 10) return `<div class="packVisWrap">${packTile(cosmImg('offers', 'booster_premium', 'packOfferArtImg'), 'mythic', 'v1', 'Mythic')}${packTile(artMyth, 'mythic', 'v2', 'Mythic')}${packTile(cosmImg('offers', 'booster_premium', 'packOfferArtImg'), 'mythic', 'v3', 'Mythic')}</div>`;
        return `<div class="packVisWrap"><div class="packVis mythic v2" style="position:relative;left:auto;transform:none">${artMyth}<span class="pvSig" style="font-size:28px">✦</span><span class="pvLbl">Mythic</span></div></div>`;
      }
      if (qty >= 15) return `<div class="packVisWrap">${packTile(cosmImg('offers', 'booster', 'packOfferArtImg'), 'standard', 'v1', 'ECH I')}${packTile(artBooster, 'standard', 'v2', 'ECH I')}${packTile(cosmImg('offers', 'booster', 'packOfferArtImg'), 'standard', 'v3', 'ECH I')}</div>`;
      return `<div class="packVisWrap"><div class="packVis v2" style="position:relative;left:auto;transform:none">${artBooster}<span class="pvSig" style="font-size:26px">✦</span><span class="pvLbl">ECH I</span></div></div>`;
    };
    const freeInfo = (meta.freeOpens ?? 0) > 0 ? `<span style="color:#ffd87a;font-weight:700"> · бесплатных: ${meta.freeOpens}</span>` : '';
    h += `<div class="packStoreHead"><div class="psBrand"><span class="psIco">◈</span><span class="psLogo">ЭХО-ЦИТАДЕЛЬ <i>▾</i></span></div><div class="psInfo">1:8 Легендарная в паку · <a href="#" onclick="event.preventDefault();showToast('Шансы: 3 обычных + 1 редкая + 1 эпическая (12.5% → легендарная) · фойл 20%')">Details and More Pack Information</a></div></div>`;
    h += `<div class="packStoreRow">` + PACK_OFFERS.map(o => `
      <div class="packOffer ${o.hl ? 'hl' : ''}">
        <div class="packOfferArt">${o.hl ? '<span class="packBadge">★ Best Value</span>' : ''}${packVisHtml(o.kind, o.qty)}</div>
        <div class="packOfferTitle">${o.ru}${o.qty>1?` · ${o.qty}×`:''}${freeInfo && o.id==='p1' ? freeInfo : ''}</div>
        <div class="packOfferPrices">
          <button class="priceBtn gem buyPackOffer" data-offer="${o.id}" data-cur="gem"><span class="ico">💎</span> ${o.gem.toLocaleString('ru-RU')}</button>
          <button class="priceBtn gold buyPackOffer" data-offer="${o.id}" data-cur="gold"><span class="ico">🪙</span> ${o.gold.toLocaleString('ru-RU')}</button>
        </div>
      </div>`).join('') + `</div>`;
    // сохраняем старые быстрые покупки фракционных как скрытый ряд (для совместимости)
    h += `<details style="margin:.4rem 0 0"><summary style="cursor:pointer;font-size:.68rem;color:#a99a7a;letter-spacing:.04em">Фракционные наборы · 🪙350</summary><div class="ofRow" style="padding-top:.5rem">` +
      FACTION_IDS.map(f => ofCard(`a-fac f-${f}`, cosmImg('offers', 'pack_' + f, 'ofArtImg') + `<span class="ofSig">${FACTION_SIGIL[f]}</span>`,
        `Набор ${FACTION_RU[f as Faction]}`, '5 карт одной фракции',
        `<button class="btn price gold buyFacPack" data-f="${f}">🪙350</button>`)).join('') + `</div></details>`;
    h += `<div class="shopNavBottom"><span class="navItem">Featured</span><span class="navItem">Gems</span><span class="navItem sel">Packs</span><span class="navItem">Daily Deals</span><span class="navItem" data-goto="bundles">Bundles</span><span class="navItem">Avatars</span><span class="navItem">Sleeves</span><span class="navItem">Pets</span></div>`;
    h += `<div class="packStoreFoot">Дубликаты сверх 4 копий превращаются в монеты (1/2/5/20/100). Оплата 💎 — гемы, 🪙 — монеты. Бустеры копятся и открываются в разделе «Бустеры».</div>`;
  }
  if (shopTab === 'bundles') {
    h += `<div class="ofRow">` +
      ofCard('a-starter', cosmImg('bundles', 'starter', 'ofArtImg') + '<span class="ofBig">🃏</span>', 'Набор новичка',
        '10 карт базы (кривая 1–3, по 2 на фракцию) · одна покупка на аккаунт',
        `<button class="btn price gold" id="btnStarter" ${meta.starter ? 'disabled' : ''}>${meta.starter ? 'Куплен' : '🪙800'}</button>`) +
      BUNDLES.map(b => {
        const bought = (meta.bundles ?? []).includes(b.fac);
        return ofCard(`a-fac f-${b.fac}`, cosmImg('bundles', b.fac, 'ofArtImg') + `<span class="ofSig">${FACTION_SIGIL[b.fac as Faction]}</span>`,
          `Набор «${FACTION_RU[b.fac as Faction]}»`,
          '10 бустеров + 🪙500 + эксклюзивный аватар «Архонт» ✧ · разовая покупка',
          `<button class="btn price gem buyBundle" data-f="${b.fac}" ${bought ? 'disabled' : ''}>${bought ? 'Куплен' : `💎${b.price}`}</button>`);
      }).join('') +
      `</div><div class="jl" style="opacity:.75">В релизе стартовые наборы покупаются за реальные деньги; в прототипе — за гемы 💎.</div>`;
  }
  if (shopTab === 'cosm') {
    const tile = (art: string, name: string, sub: string, prev: string, buy: string): string =>
      `<div class="ofCard sm"><div class="ofArt a-cosm">${art}</div><div class="ofName">${name}</div>
        <div class="ofSub">${sub}</div><div class="ofBuy">${prev}${buy}</div></div>`;
    const prevBtn = (kind: string, id: string, ttl: string): string =>
      `<button class="btn cosmPrev" data-kind="${kind}" data-id="${id}" title="${ttl}">👁</button>`;
    const backs = Object.entries(SHOP_BACKS).map(([id, b]) => {
      const ownedB = meta.backsOwned.includes(id);
      const eq = meta.backEq === id;
      const locked = !!b.bpOnly && !ownedB;
      return tile(`<i class="cardback mini back-${id}">${cosmImg('backs', id, 'cbArt')}</i>`, `Рубашка «${b.ru}»`,
        locked ? 'награда боевого пропуска' : ownedB ? (eq ? 'надета' : 'в коллекции') : `🪙${b.price}`,
        prevBtn('back', id, 'Предпросмотр: как рубашка выглядит на карте'),
        `<button class="btn price gold smBtn backBtn" data-b="${id}" ${ownedB ? (eq ? 'disabled' : '') : locked ? 'disabled' : `data-price="${b.price}"`}>${ownedB ? (eq ? 'Надета' : 'Надеть') : locked ? '🔒' : `🪙${b.price}`}</button>`);
    }).join('');
    const tables = Object.entries(TABLE_SKINS).map(([id, k]) => {
      const ownedT = id === 'classic' || (meta.tablesOwned ?? []).includes(id);
      const eq = (meta.tableSkin || 'classic') === id;
      return tile(`<i class="ofSw t-${id}">${cosmImg('tables', id, 'ofSwImg')}</i>`, `Стол «${k.ru}»`,
        ownedT ? (eq ? 'надет' : 'в коллекции') : k.cur === 'gem' ? `💎${k.price}` : `🪙${k.price}`,
        prevBtn('table', id, 'Предпросмотр: фрагмент игрового стола'),
        `<button class="btn price ${k.cur === 'gem' ? 'gem' : 'gold'} smBtn tableBtn" data-id="${id}" ${ownedT && eq ? 'disabled' : ''}>${ownedT ? (eq ? 'Надет' : 'Надеть') : k.cur === 'gem' ? `💎${k.price}` : `🪙${k.price}`}</button>`);
    }).join('');
    const runes = Object.entries(RUNE_SKINS).map(([id, k]) => {
      const ownedR = id === 'classic' || (meta.runesOwned ?? []).includes(id);
      const eq = (meta.runeSkin || 'classic') === id;
      return tile(`<i class="ofSw r-${id}">${cosmImg('runes', id, 'rcImg')}✦</i>`, `Руны «${k.ru}»`,
        ownedR ? (eq ? 'надеты' : 'в коллекции') : k.cur === 'gem' ? `💎${k.price}` : `🪙${k.price}`,
        prevBtn('rune', id, 'Предпросмотр: анимация рун'),
        `<button class="btn price ${k.cur === 'gem' ? 'gem' : 'gold'} smBtn runeBtn" data-id="${id}" ${ownedR && eq ? 'disabled' : ''}>${ownedR ? (eq ? 'Надета' : 'Надеть') : k.cur === 'gem' ? `💎${k.price}` : `🪙${k.price}`}</button>`);
    }).join('');
    h += `<div class="ofGrid"><div class="ofGroup">Рубашки карт</div>${backs}
      <div class="ofGroup">Скины игрового стола</div>${tables}
      <div class="ofGroup">Анимации рун</div>${runes}</div>
      <div class="jl" style="opacity:.75">Аватары и рамки — в профиле, вкладка «Общая»: 5 фракционных бесплатно,
      премиум-аватары за достижения и стартовые наборы, рамки — за достижения и пропуск.</div>`;
  }
  if (shopTab === 'craft') {
    const craftable = [...db.values()].filter(c => !STARTER_CARD_IDS.has(c.id) && ownedCount(c.id) < PLAYSET)
      .sort((a, b) => (CRAFT_COST[a.rarity] ?? 0) - (CRAFT_COST[b.rarity] ?? 0)).slice(0, 14);
    h += `<div class="jl">Монеты: разбор дубликатов выдаёт 1/2/5/20/100 монет по редкости;
      создание карты стоит 5/10/20/100/400 монет. Точечное создание любой карты — в коллекции (клик по карте).</div>
      <div class="ofGroup">Быстрое создание: карты вне стартовых колод</div>` +
      (craftable.map(c => `<div class="cfRow"><div class="cfName">${esc(c.name)} · ${RARITY_RU[c.rarity]} · ${c.cost} маны
        <span class="setHint">${ownedCount(c.id)}/4 копии</span></div>
        <button class="btn price gold craftBtn2" data-id="${c.id}">🪙${CRAFT_COST[c.rarity] ?? 100}</button></div>`).join('')
        || '<div class="jl">Все карты вне стартовых колод собраны 🏆</div>');
  }
  h += `<div class="shTabs">${TABS.map(([id, ru]) =>
    `<button class="btn shTab stab${shopTab === id ? ' sel' : ''}" data-stab="${id}">${ru}</button>`).join('')}</div>`;
  $('shopBody').innerHTML = h;
  $('shopModal').classList.remove('hidden');
  // Когда загружен PNG самого пакета, убираем процедурный корпус/значки с его контейнера.
  document.querySelectorAll<HTMLImageElement>('#shopBody .packOfferArtImg').forEach(img => {
    const markArt = (): void => {
      const pack = img.closest('.packVis');
      pack?.classList.add('hasArt');
      pack?.closest('.packOfferArt')?.classList.add('hasPackArt');
    };
    img.addEventListener('load', markArt, { once: true });
    if (img.complete && img.naturalWidth > 0) markArt();
  });
  // объём как в MTG — после рендера витрины цепляем 3D-блик
  try { attachVolumetric(document.getElementById('shopBody')!); } catch {}
  try { const _sealed = document.getElementById('packSealed'); if (_sealed) attachVolumetric(_sealed.parentElement!); } catch {}
}
document.addEventListener('click', ev => {
  const t = ev.target as HTMLElement | null;
  const st = t?.closest?.('.stab') as HTMLElement | null;
  if (st?.dataset.stab) { shopTab = st.dataset.stab; openShop(); return; }
  const cp = t?.closest?.('.cosmPrev') as HTMLElement | null;
  if (cp?.dataset.kind) { Sfx.uiClick(); openCosmPreview(cp.dataset.kind, cp.dataset.id ?? ''); return; }
  if (t?.id === 'buyPack') {
    if (shardsGet() < PACK_PRICE) { showToast('Недостаточно монет'); return; }
    shardsAdd(-PACK_PRICE);
    meta.freeOpens = (meta.freeOpens ?? 0) + 1;
    metaSave();
    openBoosterPanel();
    showToast('Бустер добавлен в коллекцию паков — выберите его, чтобы вскрыть');
    return;
  }
  const fp = t?.closest?.('.buyFacPack') as HTMLElement | null;
  if (fp?.dataset.f) {
    if (pendingPack) { showToast('Сначала вскройте выбранный бустер'); return; }
    if (shardsGet() < 350) { showToast('Нужно 350 монет'); return; }
    shardsAdd(-350);
    openBoosterPanel();
    const slots = drawFactionPack(fp.dataset.f);
    renderShards();
    showSealedPack(slots, 'pack_' + fp.dataset.f);
    return;
  }
  const po = t?.closest?.('.buyPackOffer') as HTMLElement | null;
  if (po?.dataset.offer) {
    const id = po.dataset.offer; const cur = po.dataset.cur;
    const MAP: Record<string,{gem:number;gold:number;qty:number;kind:'pack'|'mythic'}> = {
      p1:{gem:200,gold:300,qty:1,kind:'pack'},
      p15:{gem:3000,gold:3900,qty:15,kind:'pack'},
      m1:{gem:260,gold:400,qty:1,kind:'mythic'},
      m10:{gem:2600,gold:3600,qty:10,kind:'mythic'},
      p1b:{gem:200,gold:300,qty:1,kind:'pack'},
    };
    const o = MAP[id]; if (!o) return;
    if (cur === 'gem') {
      if (gemsGet() < o.gem) { showToast(`Нужно 💎${o.gem}`); return; }
      gemsAdd(-o.gem);
    } else {
      if (shardsGet() < o.gold) { showToast(`Нужно ${o.gold} монет`); return; }
      shardsAdd(-o.gold);
    }
    if (o.kind === 'mythic') {
      meta.premOpens = (meta.premOpens ?? 0) + o.qty;
      metaSave();
      openBoosterPanel();
      showToast(`✦ ${o.qty} премиум-бустеров добавлено в коллекцию паков`);
    } else {
      meta.freeOpens = (meta.freeOpens ?? 0) + o.qty;
      metaSave();
      openBoosterPanel();
      showToast(`🎁 ${o.qty} бустеров добавлено в коллекцию паков`);
    }
    return;
  }
  const navGo = (t?.closest?.('.navItem[data-goto]') as HTMLElement | null)?.dataset.goto;
  if (navGo) { shopTab = navGo; openShop(); return; }
  if (t?.id === 'buyBundle11') {
    if (shardsGet() < 2700) { showToast('Нужно 2700 монет'); return; }
    shardsAdd(-2700);
    meta.freeOpens = (meta.freeOpens ?? 0) + 11;
    metaSave();
    openBoosterPanel();
    showToast('🎁 Набор «10+1»: 11 бустеров добавлены в коллекцию паков');
    return;
  }
  const bb = t?.closest?.('.backBtn') as HTMLElement | null;
  if (bb) {
    const id = bb.dataset.b ?? 'classic';
    if (!meta.backsOwned.includes(id)) {
      const price = Number(bb.dataset.price ?? 0);
      if (shardsGet() < price) { showToast('Недостаточно монет'); return; }
      shardsAdd(-price); meta.backsOwned.push(id); renderShards();
    }
    meta.backEq = id; metaSave();
    document.body.dataset.back = id;
    void applyCosmArt();
    openShop();
    return;
  }
  const tb = t?.closest?.('.tableBtn') as HTMLElement | null;
  if (tb?.dataset.id) {
    const id = tb.dataset.id; const k = TABLE_SKINS[id];
    if (!k) return;
    meta.tablesOwned = meta.tablesOwned ?? [];
    if (id !== 'classic' && !meta.tablesOwned.includes(id)) {
      if (k.cur === 'gem') { if (gemsGet() < k.price) { showToast(`Нужно 💎${k.price}`); return; } gemsAdd(-k.price); }
      else { if (shardsGet() < k.price) { showToast(`Нужно ${k.price} монет`); return; } shardsAdd(-k.price); }
      meta.tablesOwned.push(id);
    }
    meta.tableSkin = id; metaSave(); applySettings();
    if (!$('battle').classList.contains('hidden')) applyBattleBg(battle.playerFaction);
    void applyCosmArt();
    openShop();
    return;
  }
  const rb = t?.closest?.('.runeBtn') as HTMLElement | null;
  if (rb?.dataset.id) {
    const id = rb.dataset.id; const k = RUNE_SKINS[id];
    if (!k) return;
    meta.runesOwned = meta.runesOwned ?? [];
    if (id !== 'classic' && !meta.runesOwned.includes(id)) {
      if (k.cur === 'gem') { if (gemsGet() < k.price) { showToast(`Нужно 💎${k.price}`); return; } gemsAdd(-k.price); }
      else { if (shardsGet() < k.price) { showToast(`Нужно ${k.price} монет`); return; } shardsAdd(-k.price); }
      meta.runesOwned.push(id);
    }
    meta.runeSkin = id; metaSave(); applySettings(); openShop();
    return;
  }
  const cb = t?.closest?.('.craftBtn2') as HTMLElement | null;
  if (cb?.dataset.id) {
    const msg = craftCard(cb.dataset.id);
    showToast(msg); metaSave(); renderShards(); openShop(); renderCollection();
    return;
  }
  if (t?.id === 'btnStarter' && !meta.starter) {
    if (shardsGet() < 800) return;
    shardsAdd(-800); meta.starter = true; metaSave(); renderShards();
    for (const f of FACTION_IDS) {
      const cheap = [...db.values()].filter(c => c.faction === f && c.cost <= 3 && !isExpansionId(c.id))
        .sort((a, b) => a.cost - b.cost).slice(0, 2);
      for (const c of cheap) owned.set(c.id, Math.min(PLAYSET, (owned.get(c.id) ?? 0) + 1));
    }
    ownedSave(); openShop();
    return;
  }
  const bu = t?.closest?.('.buyBundle') as HTMLElement | null;
  if (bu?.dataset.f) {
    const fac = bu.dataset.f;
    if ((meta.bundles ?? []).includes(fac)) return;
    const b = BUNDLES.find(x => x.fac === fac);
    if (!b) return;
    if (gemsGet() < b.price) { showToast(`Нужно 💎${b.price}`); return; }
    gemsAdd(-b.price);
    meta.bundles = [...(meta.bundles ?? []), fac];
    meta.freeOpens = (meta.freeOpens ?? 0) + 10;
    if (!meta.avatarsOwned.includes('arch')) meta.avatarsOwned.push('arch');
    shardsAdd(500);
    metaSave();
    openBoosterPanel();
    showToast(`🎁 Набор «${FACTION_RU[fac as Faction]}»: 10 бустеров добавлены в коллекцию паков`);
  }
});
document.body.dataset.back = meta.backEq || 'classic';

/* --- вкладки профиля, ник, аватары/рамки, друзья, реплеи, недельные задания --- */
document.addEventListener('click', ev => {
  const t0 = ev.target as HTMLElement | null;
  const ptab = t0?.closest?.('.ptab:not(.stab)') as HTMLElement | null;
  if (ptab?.dataset.ptab) { profTab = ptab.dataset.ptab; openProfile(); return; }
  const ava = t0?.closest?.('.avaBtn') as HTMLElement | null;
  if (ava?.dataset.f) {
    const id = ava.dataset.f;
    const pa = PREMIUM_AVATARS[id];
    if (pa && !pa.req()) { showToast('Премиум-аватар ещё не открыт'); return; }
    meta.avatarFac = id; metaSave(); openProfile(); return;
  }
  const fr = t0?.closest?.('.frameBtn') as HTMLElement | null;
  if (fr?.dataset.fr) {
    const d = FRAME_DEFS.find(x => x.id === fr.dataset.fr);
    if (d?.req()) { meta.frame = d.id; metaSave(); openProfile(); }
    else showToast('Рамка открывается за достижения');
    return;
  }
  const rp = t0?.closest?.('.replayBtn') as HTMLElement | null;
  if (rp?.dataset.ts) { openReplay(Number(rp.dataset.ts)); return; }
  const fi = t0?.closest?.('.frInvite') as HTMLElement | null;
  if (fi?.dataset.n) { inviteFriend(fi.dataset.n); return; }
  const fd = t0?.closest?.('.frDel') as HTMLElement | null;
  if (fd?.dataset.n) {
    meta.friends = (meta.friends ?? []).filter(x => x.nick !== fd.dataset.n);
    metaSave(); openProfile(); return;
  }
  if (t0?.id === 'btnFriendAdd') {
    const inp = document.getElementById('friendNick') as HTMLInputElement | null;
    const nick = (inp?.value ?? '').trim().slice(0, 20);
    if (!nick) { showToast('Введите никнейм'); return; }
    meta.friends = meta.friends ?? [];
    if (meta.friends.some(x => x.nick === nick)) { showToast('Уже в друзьях'); return; }
    if (meta.friends.length >= 20) { showToast('Максимум 20 друзей'); return; }
    meta.friends.push({ nick, ts: Date.now() }); metaSave(); openProfile();
    showToast(`👥 ${nick} добавлен(а) в друзья`);
    return;
  }
  const wq = t0?.closest?.('.wqClaim') as HTMLElement | null;
  if (wq) {
    if (!wq.hasAttribute('disabled') && wq.dataset.q) claimQuestReward('weekly', wq.dataset.q);
    return;
  }
  if (t0?.id === 'btnReplayPlay') { replayPlay(); return; }
  if (t0?.id === 'btnReplayClose') {
    if (replayTimer) { window.clearInterval(replayTimer); replayTimer = 0; }
    $('replayModal').classList.add('hidden');
  }
});
document.addEventListener('change', ev => {
  const t0 = ev.target as HTMLElement | null;
  // Никнейм сохраняется по событию change (валидация 3–16/мат/уникальность — см. invalidNick).
});

/* --- боевой пропуск сезона: 50 уровней, бесплатная + премиум-ветка (💎500) --- */
const BP_LEVELS = 50;
const BP_STEP = 400;   // опыта пропуска на уровень
interface BpRw { ru: string; shards?: number; pack?: number; premPack?: number; back?: string; gems?: number; foil?: number; ava?: string }
/* Таблица наград v2.5.0 (спека «5. Боевой пропуск»):
   free — монеты и обычные бустеры;
   prem — рубашки, фойл-жетоны (решение пользователя вместо альт-артов),
   премиум-бустеры 2 эпика+ (решение пользователя), гемы, аватар. */
function bpReward(lvl: number): { free: BpRw; prem: BpRw } {
  const free: BpRw = { ru: `🪙${50 + lvl * 3}`, shards: 50 + lvl * 3 };
  if (lvl % 10 === 0) { free.ru = 'Бустер ECH1'; free.pack = 1; free.shards = 0; }
  if (lvl === 50) { free.ru = 'Бустер ECH1 ×2'; free.pack = 2; free.shards = 0; }
  const prem: BpRw = { ru: `🪙${90 + lvl * 5} монет`, shards: 90 + lvl * 5 };
  if (lvl === 5) { prem.ru = '🌟 Фойл-жетон'; prem.foil = 1; prem.shards = 0; }
  if (lvl === 10) { prem.ru = '💎 30 гемов'; prem.gems = 30; prem.shards = 0; }
  if (lvl === 15) { prem.ru = '🌟 Премиум-бустер (2 эпика+)'; prem.premPack = 1; prem.shards = 0; }
  if (lvl === 20) { prem.ru = 'Бустер ECH1'; prem.pack = 1; prem.shards = 0; }
  if (lvl === 25) { prem.ru = 'Рубашка «Бездна»'; prem.back = 'abyss'; prem.shards = 0; }
  if (lvl === 30) { prem.ru = '💎 50 гемов'; prem.gems = 50; prem.shards = 0; }
  if (lvl === 35) { prem.ru = 'Рубашка «Вердант»'; prem.back = 'verdant'; prem.shards = 0; }
  if (lvl === 40) { prem.ru = '☾ Аватар «Лунный Архонт»'; prem.ava = 'lunar'; prem.shards = 0; }
  if (lvl === 45) { prem.ru = '💎 120 + рамка «Кристалл»'; prem.gems = 120; prem.shards = 0; }
  if (lvl === 50) { prem.ru = 'Бустер ×2 + 💎 200'; prem.pack = 2; prem.gems = 200; prem.shards = 0; }
  return { free, prem };
}
function bpLevel(): number { return Math.min(BP_LEVELS, Math.floor((meta.bpXp ?? 0) / BP_STEP) + 1); }
/** Сводка выданного — для тоста «Забрать всё» (спека 5.4: суммарное количество). */
interface BpSum { shards: number; gems: number; packs: number; premPacks: number; foils: number; backs: number; avas: number }
const BP_SUM0 = (): BpSum => ({ shards: 0, gems: 0, packs: 0, premPacks: 0, foils: 0, backs: 0, avas: 0 });
function bpGrant(rw: BpRw): BpSum {
  const s = BP_SUM0();
  if (rw.shards) { shardsAdd(rw.shards); s.shards += rw.shards; }
  if (rw.gems) { gemsAdd(rw.gems); s.gems += rw.gems; }
  if (rw.back && !meta.backsOwned.includes(rw.back)) { meta.backsOwned.push(rw.back); s.backs += 1; }
  if (rw.pack) { meta.freeOpens = (meta.freeOpens ?? 0) + rw.pack; s.packs += rw.pack; }
  if (rw.premPack) { meta.premOpens = (meta.premOpens ?? 0) + rw.premPack; s.premPacks += rw.premPack; }
  if (rw.foil) { meta.foilTokens = (meta.foilTokens ?? 0) + rw.foil; s.foils += rw.foil; }
  if (rw.ava && !(meta.avatarsOwned ?? []).includes(rw.ava)) {
    meta.avatarsOwned = [...(meta.avatarsOwned ?? []), rw.ava]; s.avas += 1;
  }
  return s;
}
/* --- v2.5.2: лента пропуска в манере MTG Arena Mastery (скрин 1): страницы по 8 уровней,
     плитки free/prem, замки/галочки, стрелки и точки страниц, градиентные кнопки низа --- */
function bpPerPageForViewport(): number {
  return window.innerWidth <= 600 ? 2 : window.innerWidth <= 920 ? 4 : 8;
}
let BP_PER_PAGE = bpPerPageForViewport();
let BP_PAGES = Math.ceil(BP_LEVELS / BP_PER_PAGE);
let bpPage = 0;
window.addEventListener('resize', () => {
  const currentLevel = bpLevel();
  const next = bpPerPageForViewport();
  if (next === BP_PER_PAGE) return;
  BP_PER_PAGE = next;
  BP_PAGES = Math.ceil(BP_LEVELS / BP_PER_PAGE);
  bpPage = Math.min(BP_PAGES - 1, Math.floor((currentLevel - 1) / BP_PER_PAGE));
  if (!document.getElementById('bpModal')?.classList.contains('hidden')) openBP();
});
function bpGlyph(rw: BpRw): string {
  if (rw.back) return '🂠';
  if (rw.ava) return '☾';
  if (rw.foil) return '✦';
  if (rw.premPack) return '🌟';
  if (rw.pack) return '🎁';
  if (rw.gems) return '💎';
  return '◈';
}
function bpAssetId(rw: BpRw): string {
  if (rw.premPack) return 'premium_booster';
  if (rw.pack) return 'booster';
  if (rw.back) return 'cardback';
  if (rw.gems) return 'gems';
  if (rw.foil) return 'foil_token';
  if (rw.ava) return 'avatar';
  return 'coins';
}
function bpTileInner(rw: BpRw): string {
  const art = bpAssetId(rw);
  return `<span class="bpRewardVisual" aria-hidden="true"><img class="bpRewardArt" src="/cosm/bp/${art}" alt="" loading="lazy" onload="this.closest('.bpRewardVisual')?.classList.add('hasArt')" onerror="this.remove()"><span class="bpIco">${bpGlyph(rw)}</span></span><span class="bpLbl">${rw.ru}</span>`;
}
function openBP(): void {
  setAppRoute('mastery');
  $('menu').classList.add('hidden');
  for (const id of ['homeScreen','eventsScreen','decksScreen','collection','shopModal','profileModal','boosterModal','campaignModal'])
    document.getElementById(id)?.classList.add('hidden');
  const days = seasonDaysLeft();
  const lvlNow = bpLevel();
  if (bpPage < 0 || bpPage >= BP_PAGES) bpPage = Math.min(BP_PAGES - 1, Math.floor((lvlNow - 1) / BP_PER_PAGE));
  const cols = Array.from({ length: BP_LEVELS }, (_, i) => i + 1).map(lv => {
    const r = bpReward(lv);
    const reached = lvlNow >= lv;
    const cF = (meta.bpClaimed ?? []).includes(lv);
    const cP = (meta.bpClaimedP ?? []).includes(lv);
    const page = Math.floor((lv - 1) / BP_PER_PAGE);
    return `<div class="bpCol${lv === lvlNow ? ' curCol' : ''}" data-page="${page}">
      <div class="bpColHead">${lv === lvlNow ? '<span class="bpArrow" title="Текущий уровень">▼</span>' : ''}<div class="bpLvl${reached ? ' on' : ''}${lv === lvlNow ? ' cur' : ''}" title="${lv === lvlNow ? 'Текущий уровень' : reached ? 'Достигнут' : 'Заблокирован'}">${lv}</div></div>
      <button class="bpTile free bpClaim${cF ? ' got' : ''}" data-l="${lv}" data-t="free" aria-label="${esc(r.free.ru)} · уровень ${lv} · бесплатная награда" ${reached && !cF ? '' : 'disabled'}>${cF ? '✔' : bpTileInner(r.free)}</button>
      <button class="bpTile prem bpClaim${cP ? ' got' : ''}" data-l="${lv}" data-t="prem" aria-label="${esc(r.prem.ru)} · уровень ${lv} · премиум-награда" ${meta.bpPremium && reached && !cP ? '' : 'disabled'}>${cP ? '✔' : (meta.bpPremium ? '' : '<span class="bpLock">🔒</span>') + bpTileInner(r.prem)}</button>
    </div>`;
  });
  const pages = Array.from({ length: BP_PAGES }, (_, p) =>
    `<div class="bpPage${p === bpPage ? ' on' : ''}">${cols.filter((_, i) => Math.floor(i / BP_PER_PAGE) === p).join('')}</div>`).join('');
  $('bpBody').innerHTML = `
    <div class="bpTop">
      <div class="bpEmblem">🎖</div>
      <div class="bpTitle">Боевой пропуск «Эхо-Цитадель I»<span class="bpSub">сезон · до конца: <b>${days} дн.</b></span></div>
      <button class="btn bpPill" id="bpToCur" title="Перемотать ленту к текущему уровню">Текущий уровень</button>
      <div class="bpPageNo">Страница ${bpPage + 1} / ${BP_PAGES}</div>
    </div>
    <div class="bpMid">
      <button class="btn bpNav" id="bpPrev" ${bpPage === 0 ? 'disabled' : ''} title="Предыдущая страница">‹</button>
      <div class="bpPages">${pages}</div>
      <button class="btn bpNav" id="bpNext" ${bpPage >= BP_PAGES - 1 ? 'disabled' : ''} title="Следующая страница">›</button>
    </div>
    <div class="bpDots">${Array.from({ length: BP_PAGES }, (_, p) =>
      `<button class="bpDot${p === bpPage ? ' on' : ''}" data-p="${p}" title="Страница ${p + 1}">◆</button>`).join('')}</div>
    <div class="bpBottom">
      <div class="bpXpBox">
        <div class="bpXpLine">Уровень <b>${lvlNow}</b>/${BP_LEVELS} · опыт ${meta.bpXp ?? 0}
          ${lvlNow >= BP_LEVELS ? '· <b>максимум</b>' : `· до следующего: <b>${(meta.bpXp ?? 0) % BP_STEP}/${BP_STEP}</b>`}</div>
        <div class="bpBar"><div style="width:${lvlNow >= BP_LEVELS ? 100 : (((meta.bpXp ?? 0) % BP_STEP) / BP_STEP) * 100}%"></div></div>
        <div class="bpRates">XP: победа +120 · поражение +60 · ежедневное +150 · недельное +250 · премиум-бустер: 2C+1R+2 эпика+</div>
      </div>
      <button class="btn bpGold" id="bpClaimAll" title="Собрать все доступные награды одним кликом (спека 5.4)">Забрать всё</button>
      ${meta.bpPremium
        ? '<div class="bpPremOn">💎 Премиум активен</div>'
        : '<button class="btn bpGem" id="bpBuyPrem">Открыть премиум-ветку · 💎500</button>'}
    </div>`;
  $('bpModal').classList.remove('hidden');
  try { attachVolumetric(document.getElementById('bpBody')!); } catch {}
}
document.addEventListener('click', ev => {
  const t0 = ev.target as HTMLElement | null;
  if (t0?.id === 'bpPrev') { bpPage = Math.max(0, bpPage - 1); openBP(); return; }
  if (t0?.id === 'bpNext') { bpPage = Math.min(BP_PAGES - 1, bpPage + 1); openBP(); return; }
  if (t0?.id === 'bpToCur') { bpPage = Math.min(BP_PAGES - 1, Math.floor((bpLevel() - 1) / BP_PER_PAGE)); openBP(); return; }
  const bpDot = t0?.closest?.('.bpDot') as HTMLElement | null;
  if (bpDot?.dataset.p != null) { bpPage = Number(bpDot.dataset.p); openBP(); return; }
  if (t0?.id === 'bpBuyPrem') {
    if (gemsGet() < 500) { showToast('Нужно 💎500 гемов'); return; }
    gemsAdd(-500); meta.bpPremium = true; metaSave(); openBP();
    showToast('💎 Премиум-ветка пропуска активирована!');
    return;
  }
  if (t0?.id === 'bpClaimAll') {
    let n = 0;
    const tot = BP_SUM0();
    const add = (s: BpSum): void => { tot.shards += s.shards; tot.gems += s.gems; tot.packs += s.packs;
      tot.premPacks += s.premPacks; tot.foils += s.foils; tot.backs += s.backs; tot.avas += s.avas; };
    for (let lv = 1; lv <= bpLevel(); lv++) {
      const r = bpReward(lv);
      if (!(meta.bpClaimed ?? []).includes(lv)) { meta.bpClaimed = [...(meta.bpClaimed ?? []), lv]; add(bpGrant(r.free)); n += 1; }
      if (meta.bpPremium && !(meta.bpClaimedP ?? []).includes(lv)) {
        meta.bpClaimedP = [...(meta.bpClaimedP ?? []), lv]; add(bpGrant(r.prem)); n += 1;
      }
    }
    metaSave(); renderShards(); openBP();
    if (!n) { showToast('Нет доступных наград'); return; }
    const parts: string[] = [];
    if (tot.shards) parts.push(`🪙${tot.shards}`);
    if (tot.gems) parts.push(`💎${tot.gems}`);
    if (tot.packs) parts.push(`бустеры ×${tot.packs}`);
    if (tot.premPacks) parts.push(`🌟 премиум-бустеры ×${tot.premPacks}`);
    if (tot.foils) parts.push(`фойл-жетоны ×${tot.foils}`);
    if (tot.backs) parts.push(`рубашки ×${tot.backs}`);
    if (tot.avas) parts.push(`аватары ×${tot.avas}`);
    showToast(`Забрано наград: ${n} — ${parts.join(' · ')}`);   // спека 5.4: суммарное количество
    return;
  }
  const t = t0?.closest?.('.bpClaim') as HTMLElement | null;
  if (!t || t.hasAttribute('disabled')) return;
  const lvl = Number(t.dataset.l ?? 0);
  const track = t.dataset.t ?? 'free';
  if (!lvl) return;
  if (track === 'prem' && !meta.bpPremium) return;
  if (track === 'prem') {
    meta.bpClaimedP = meta.bpClaimedP ?? [];
    if (meta.bpClaimedP.includes(lvl)) return;
    meta.bpClaimedP.push(lvl);
    bpGrant(bpReward(lvl).prem);
  } else {
    if ((meta.bpClaimed ?? []).includes(lvl)) return;
    meta.bpClaimed = [...(meta.bpClaimed ?? []), lvl];
    bpGrant(bpReward(lvl).free);
  }
  metaSave(); renderShards(); openBP();
});

/* --- кампания: карта мира Цитадели, 5 регионов × 4 узла, лор, 3 сложности --- */
type CampKind = 'battle' | 'elite' | 'boss';
const BOSS_NAME: Record<string, string> = {
  Aurites: 'Серафим Зари', Necrus: 'Владыка Кровавой Жатвы', Terramorph: 'Колосс Корней',
  Pyromancer: 'Джинн Испепелитель', Ethereal: 'Вестник Пустоты',
};
const BOSS_POWER: Record<string, { power: string; ru: string }> = {
  Aurites: { power: 'heal', ru: 'Сияние: восстанавливает 2 HP в свою основную фазу' },
  Necrus: { power: 'drain', ru: 'Жатва: похищает у вас 1 HP в свою основную фазу' },
  Terramorph: { power: 'heal', ru: 'Каменная кожа: восстанавливает 2 HP в свою основную фазу' },
  Pyromancer: { power: 'burn', ru: 'Испепеление: жжёт вас на 1 в свою основную фазу' },
  Ethereal: { power: 'drain', ru: 'Сифон: похищает у вас 1 HP в свою основную фазу' },
};
function campNodeDef(fac: string, n: number): { kind: CampKind; skill: number; title: string } {
  if (n === 4) return { kind: 'boss', skill: 0.72, title: `Босс: ${BOSS_NAME[fac] ?? fac}` };
  if (n === 3) return { kind: 'elite', skill: 0.62, title: 'Элитный бой' };
  return { kind: 'battle', skill: n === 1 ? 0.42 : 0.52, title: n === 1 ? 'Первая стычка' : 'Бой' };
}
const LORE: Record<string, string> = {
  Aurites_1: 'Рассвет над Цитаделью. Ауриты собираются у знамени: эхо древних рун пробудилось, а с ним — голод теней.',
  Aurites_2: 'В мраморных залах судят дезертиров света. Тебе придётся доказать, что твой клинок служит рассвету, а не гордыне.',
  Aurites_3: 'Элитная стража Серафимов преграждает путь: достоин подняться лишь тот, кто выдержит их сияние.',
  Aurites_4: 'Серафим Зари расправляет шестикрылую тень. «Эхо принадлежит Цитадели, — гремит он, — а значит, и ты».',
  Necrus_1: 'В катакомбах под Цитаделью кости помнят каждую войну. Некрусы встречают гостей холодной вежливостью.',
  Necrus_2: 'Кладбищенские стражи просят плату за проход — кровью, разумеется.',
  Necrus_3: 'Избранные Кровавой Жатвы плетут ритуал из умирающих: разорви круг, пока он не сомкнулся на тебе.',
  Necrus_4: 'Владыка Кровавой Жатвы поднимается с трона из костей: «Каждое сердцебиение — долг. Твоё — просрочено».',
  Terramorph_1: 'Живой камень стонет под ногами. Терраморфы не воюют — они выращивают войну, как лес.',
  Terramorph_2: 'Путь преграждают пробуждённые големы. Гора требует уважения — докажи, что ты не случайный гость.',
  Terramorph_3: 'Элита Корневой стражи оплетает всё живое. Их сок гуще твоей крови.',
  Terramorph_4: 'Колосс Корней разрывает землю. Сорок ударов сердца горы — столько у тебя времени.',
  Pyromancer_1: 'Воздух здесь пахнет пеплом. Пироманты верят: эхо нужно сжечь — только тогда оно зазвучит чисто.',
  Pyromancer_2: 'Танцоры пламени поджигают мосты у тебя под ногами. Огонь — не враг, огонь — экзамен.',
  Pyromancer_3: 'Элита Углей куёт пламя в живые клинки: каждая искра, которую они поймают, вернётся к тебе вдвое.',
  Pyromancer_4: 'Джинн Испепелитель хохочет, рассыпая искры: «Сожгу — а что останется, назову другом».',
  Ethereal_1: 'Границы реальности тонки. Эфирные ходят меж мгновений, забирая чужое время.',
  Ethereal_2: 'Туман стирает память. Заблудившиеся здесь повторяют один и тот же шаг вечно.',
  Ethereal_3: 'Вестники Тишины плетут поединок из твоих собственных упущенных возможностей.',
  Ethereal_4: 'Вестник Пустоты говорит твоим голосом: «Отдай эхо — и я подарю тебе тишину».',
};
const CAMP_DIFFS = [
  { id: 1, ru: 'Нормально', skillAdd: 0, mult: 1 },
  { id: 2, ru: 'Героически', skillAdd: 0.1, mult: 1.5 },
  { id: 4, ru: 'Мифически', skillAdd: 0.2, mult: 2 },
];
let campSel: string | null = null;
function campStars(node: string): number { return meta.campStars?.[node] ?? 0; }
function openCampaign(): void {
  const regions = FACTION_IDS.map(f => {
    const nodes = [1, 2, 3, 4].map(n => {
      const id = `${f}_${n}`;
      const def = campNodeDef(f, n);
      const st = campStars(id);
      const open = n === 1 || campStars(`${f}_${n - 1}`) > 0;
      const star = (bit: number): string => (st & bit ? '★' : '☆');
      return `<button class="btn campNode${open ? '' : ' locked'}${def.kind === 'boss' ? ' boss' : ''}"
        data-node="${id}" ${open ? '' : 'disabled'}
        title="${def.title}${def.kind === 'boss' ? ` · ${BOSS_POWER[f].ru}` : ''} · награда ×1/×1.5/×2">
        ${open ? (def.kind === 'boss' ? '👑' : def.kind === 'elite' ? '✦' : '⚔') : '🔒'} ${n}
        <span class="cStars">${star(1)}${star(2)}${star(4)}</span></button>`;
    }).join('');
    const cleared = [1, 2, 3, 4].filter(n => campStars(`${f}_${n}`) > 0).length;
    const loreN = [1, 2, 3, 4].filter(n => (meta.loreRead ?? []).includes(`${f}_${n}`)).length;
    return `<div class="campRegion">
      <div class="campRegHead" style="border-color:${colorOf(f).primary}">
        <span class="facIcoWrap" title="${FACTION_RU[f as Faction]}">${FACTION_SIGIL[f]}<img src="img/ico_fac_${FACTION_IDS.indexOf(f)}.png" alt="" onerror="this.remove()"></span>
        <b style="color:${colorOf(f).primary}">${FACTION_RU[f as Faction]}</b>
        <span style="color:#7a7264;font-size:.66rem">узлов ${cleared}/4 · лор ${loreN}/4</span>
      </div>
      <div class="campNodes">${nodes}</div></div>`;
  }).join('');
  let loreBox = '';
  if (campSel) {
    const fac = campSel.split('_')[0];
    const n = Number(campSel.split('_')[1]);
    const def = campNodeDef(fac, n);
    loreBox = `<div class="loreBox">
      <div style="color:#ffe9b0;font-family:Philosopher,serif;margin-bottom:.3rem">${def.title} · регион ${FACTION_RU[fac as Faction]}</div>
      <div class="jl" style="font-style:italic">${LORE[campSel] ?? ''}</div>
      ${def.kind === 'boss' ? `<div class="jl" style="color:#e0b0ff">👑 ${BOSS_NAME[fac]} · 40+ HP · ${BOSS_POWER[fac].ru}</div>` : ''}
      <div class="ptabs">
        ${CAMP_DIFFS.map(d => {
          const done = campStars(campSel as string) & d.id;
          const hp = def.kind === 'boss' ? ` · 👑${40 + (d.id === 2 ? 5 : d.id === 4 ? 10 : 0)} HP` : '';
          return `<button class="btn campGo${done ? ' sel' : ''}" data-node="${campSel}" data-d="${d.id}">
            ${d.ru} ${done ? '★' : ''}${hp} · награда ×${d.mult}</button>`;
        }).join('')}
      </div>
      <div style="text-align:right"><button class="btn" id="campCancel" style="padding:.2rem .7rem;font-size:.7rem">Отмена</button></div>
    </div>`;
  }
  $('campBody').innerHTML = `<div class="jl" style="opacity:.8">Карта мира Эхо-Цитадели: 5 регионов, в каждом — цепочка из
    3 боёв и босса. Боссы: повышенное здоровье и уникальная сила героя. Сложности Нормально/Героически/Мифически —
    награды ×1/×1.5/×2 (звёзды ★). Кампания не влияет на рейтинг.</div>${loreBox}${regions}`;
  $('campaignModal').classList.remove('hidden');
}
document.addEventListener('click', ev => {
  const t0 = ev.target as HTMLElement | null;
  const cn = t0?.closest?.('.campNode') as HTMLElement | null;
  if (cn?.dataset.node && !cn.hasAttribute('disabled')) { campSel = cn.dataset.node; openCampaign(); return; }
  if (t0?.id === 'campCancel') { campSel = null; openCampaign(); return; }
  const go = t0?.closest?.('.campGo') as HTMLElement | null;
  if (go?.dataset.node) {
    const nodeId = go.dataset.node;
    const d = Number(go.dataset.d ?? 1);
    const fac = nodeId.split('_')[0];
    const n = Number(nodeId.split('_')[1]);
    const def = campNodeDef(fac, n);
    const diff = CAMP_DIFFS.find(x => x.id === d) ?? CAMP_DIFFS[0];
    battle.launchMode = 'campaign';
    battle.practice = true;
    battle.campaignBoss = def.kind === 'boss' ? fac : null;
    battle.bossPower = def.kind === 'boss' ? BOSS_POWER[fac].power : null;
    battle.bossHp = def.kind === 'boss' ? 40 + (d === 2 ? 5 : d === 4 ? 10 : 0) : 0;
    battle.enemyFaction = fac as Faction;
    battle.difficulty = Math.min(1.05, def.skill + diff.skillAdd);
    battle.campNode = { id: nodeId, mult: diff.mult, diff: d, kind: def.kind };
    campSel = null;
    $('campaignModal').classList.add('hidden');
    btn('btnPlay').click();
  }
});

/* --- обучение: 4 интерактивных урока, тренер-панель, награда (спека «6. 🎓 Обучение», v2.5.1) --- */
const LESSONS: Array<{ ru: string; hint: string; need: string; reward: string }> = [
  { ru: 'Урок 1 · Основы', hint: 'По шагам: руна → существо («Ветеран Осады») → заклинание («Луч Рассвета»). Игра подсвечивает нужную карту и блокирует остальные действия.', need: 'Разыграйте руну, существо и заклинание', reward: '🪙100' },
  { ru: 'Урок 2 · Бой', hint: 'Атакуйте цель своим существом, затем встаньте Провокацией ⛨: атаки врага обязаны бить провокатора — так работает блок.', need: 'Нанесите урон в бою', reward: '🪙100' },
  { ru: 'Урок 3 · Ключевые механики', hint: 'Вампиризм 🩸 (урон лечит героя), Неуловимость 👁 (нельзя выбрать целью — наша «неуязвимость») и Боевой клич ✦. Карты уже в руке — разыграйте все три.', need: 'Разыграйте все три механики', reward: '🪙150' },
  { ru: 'Урок 4 · Ресурсы', hint: 'Кривая маны: почему нельзя сыграть карту за 5✦ на 2-й ход. Мана +1 за ход; сыграйте 3+ карты к 3-му ходу — не копите дорогое.', need: '3+ карты к 3-му ходу', reward: '💎100 + 5 бустеров' },
];
/* Зеркало unity/.../StreamingAssets/tutorial.json: те же 20 шагов, те же сообщения. */
interface TutStep { id: number; lesson: number; message: string; hi: () => HTMLElement | null; ok: () => boolean; allow: string[] }
const tutHandSel = (id: string): string => `#hand [data-card-id="${id}"]`;
const TUT_TGT = '#playerBoard,#enemyBoard,#playerRunes,#enemyRunes,#playerHero,#enemyHero,#enemyPortrait,#btnEndTurn';
/** Заскриптованные руки уроков (инжектируются в стартовую руку; муллиган в уроках пропущен). */
const TUT_HANDS: Record<number, string[]> = {
  1: ['aur_r07', 'neu_03', 'aur_s01'],   // руна «Обетный монолит» → «Ветеран Осады» → «Луч Рассвета»
  2: ['aur_01'],                          // «Послушник Света» — Провокация ⛨
  3: ['nec_03', 'eth_01', 'aur_03'],      // Вампиризм / Неуловимость / Боевой клич
  4: ['aur_09', 'aur_01'],                // «Серафим Зари» 5✦ (кривая маны) + дешёвая 1✦
};
const TUT_STEP_FIRST: Record<number, number> = { 1: 1, 2: 6, 3: 11, 4: 16 };
const TUT_STEPS: TutStep[] = [
  /* --- урок 1 · Основы (шаги 1-5): руна → существо → заклинание --- */
  { id: 1, lesson: 1, message: 'Разыграйте руну «Обетный монолит» (1✦): кликните карту, затем своё поле. Руны дают Эхо — постоянные усилители.',
    hi: () => document.querySelector(tutHandSel('aur_r07')),
    ok: () => (battle.engine?.stats[Side.Player].runesPlayed ?? 0) >= 1,
    allow: [tutHandSel('aur_r07'), TUT_TGT] },
  { id: 2, lesson: 1, message: 'Теперь разыграйте «Ветерана Осады» (3✦) — дождитесь маны, кликните карту, затем поле.',
    hi: () => document.querySelector(tutHandSel('neu_03')),
    ok: () => (battle.engine?.stats[Side.Player].creaturesSummoned ?? 0) >= 1,
    allow: [tutHandSel('neu_03'), TUT_TGT] },
  { id: 3, lesson: 1, message: 'Разыграйте заклинание «Луч Рассвета» (1✦): кликните карту, затем цель — существо или героя.',
    hi: () => document.querySelector(tutHandSel('aur_s01')),
    ok: () => (battle.engine?.stats[Side.Player].spellsCast ?? 0) >= 1,
    allow: [tutHandSel('aur_s01'), TUT_TGT] },
  { id: 4, lesson: 1, message: 'Отлично! Завершите ход — кнопка подсвечена.',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
  { id: 5, lesson: 1, message: 'Закрепим: сыграйте любую карту или завершите ход.',
    hi: () => null,
    ok: () => (battle.engine?.stats[Side.Player].cardsPlayed ?? 0) > battle.tutMarkCards
      || (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#hand', TUT_TGT] },
  /* --- урок 2 · Бой (шаги 6-10): атака, блок, Провокация --- */
  { id: 6, lesson: 2, message: 'Бой! Призовите «Послушника Света» (1✦) — у него Провокация ⛨.',
    hi: () => document.querySelector(tutHandSel('aur_01')),
    ok: () => (battle.engine?.stats[Side.Player].creaturesSummoned ?? 0) >= 1,
    allow: [tutHandSel('aur_01'), TUT_TGT] },
  { id: 7, lesson: 2, message: 'Атакуйте: кликните своё существо (золотое свечение), затем цель — вражеское существо или героя.',
    hi: () => document.querySelector('#playerBoard .card'),
    ok: () => (battle.engine?.stats[Side.Player].damageDealt ?? 0) >= 1,
    allow: [TUT_TGT] },
  { id: 8, lesson: 2, message: 'Урон нанесён! Завершите ход — враг ОБЯЗАН бить «Послушника» ⛨: так работает блокирование.',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
  { id: 9, lesson: 2, message: 'Смотрите: атаки врага ушли в Провокацию — герой защищён. Дождитесь своего хода.',
    hi: () => document.querySelector('#playerBoard [data-card-id="aur_01"]') ?? document.querySelector('#playerBoard .card'),
    ok: () => battle.engine?.activeSide === Side.Player && battle.engine?.phase === Phase.Main,
    allow: [TUT_TGT] },
  { id: 10, lesson: 2, message: 'Урок 2 пройден: атака, блок, Провокация. Завершите ход.',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
  /* --- урок 3 · Ключевые механики (шаги 11-15): Вампиризм, Неуловимость, Боевой клич --- */
  { id: 11, lesson: 3, message: 'Вампиризм 🩸: разыграйте «Упыря-мародёра» (2✦) — его урон лечит вашего героя.',
    hi: () => document.querySelector(tutHandSel('nec_03')),
    ok: () => battle.tutPlayedPub('nec_03'),
    allow: [tutHandSel('nec_03'), TUT_TGT] },
  { id: 12, lesson: 3, message: 'Атакуйте Упырём: HP героя восстановится — это Вампиризм в действии. (Нет маны/атаки — завершите ход.)',
    hi: () => document.querySelector('#playerBoard [data-card-id="nec_03"]'),
    ok: () => (battle.engine?.stats[Side.Player].healingDone ?? 0) > 0
      || (battle.engine?.stats[Side.Player].damageDealt ?? 0) > battle.tutMarkDmg,
    allow: [TUT_TGT] },
  { id: 13, lesson: 3, message: 'Неуловимость 👁 (неуязвимость): «Эфирный разведчик» (1✦) не может быть выбран целью врагом. Разыграйте его.',
    hi: () => document.querySelector(tutHandSel('eth_01')),
    ok: () => battle.tutPlayedPub('eth_01'),
    allow: [tutHandSel('eth_01'), TUT_TGT] },
  { id: 14, lesson: 3, message: 'Боевой клич ✦: «Рассветный капеллан» (2✦) срабатывает при выходе на поле. Разыграйте его.',
    hi: () => document.querySelector(tutHandSel('aur_03')),
    ok: () => battle.tutPlayedPub('aur_03'),
    allow: [tutHandSel('aur_03'), TUT_TGT] },
  { id: 15, lesson: 3, message: 'Все три механики в деле! Завершите ход.',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
  /* --- урок 4 · Ресурсы (шаги 16-20): кривая маны --- */
  { id: 16, lesson: 4, message: 'Мана растёт на +1 каждый ход (до 10). Кликните «Серафима Зари» (5✦) — рано, маны не хватит. Это и есть кривая маны.',
    hi: () => document.querySelector(tutHandSel('aur_09')),
    ok: () => battle.tutTapPub(),
    allow: [tutHandSel('aur_09'), '#btnEndTurn'] },
  { id: 17, lesson: 4, message: 'Дорогие карты — на поздний ход. Сыграйте дешёвую: «Послушник Света» (1✦).',
    hi: () => document.querySelector(tutHandSel('aur_01')),
    ok: () => battle.tutPlayedPub('aur_01'),
    allow: [tutHandSel('aur_01'), TUT_TGT] },
  { id: 18, lesson: 4, message: 'Завершите ход — маны станет больше.',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
  { id: 19, lesson: 4, message: 'Мана выросла! Сыграйте ещё 2 карты — не копите дорогое, играйте по кривой.',
    hi: () => null,
    ok: () => (battle.engine?.stats[Side.Player].cardsPlayed ?? 0) >= battle.tutMarkCards + 2,
    allow: ['#hand', TUT_TGT] },
  { id: 20, lesson: 4, message: 'Кривая маны освоена! Завершите ход — награда за все уроки ждёт в меню «🎓 Обучение».',
    hi: () => $('btnEndTurn'), ok: () => (battle.engine?.turn ?? 0) > battle.tutMark,
    allow: ['#btnEndTurn'] },
];
function tutCoach(text: string): void {
  const n = $('tutCoach');
  if (!n) return;
  n.textContent = `🎓 ${text}`;
  n.classList.remove('hidden');
}
function tutCoachHide(): void { $('tutCoach')?.classList.add('hidden'); }
function openTut(): void {
  const rows = LESSONS.map((l, i) => {
    const n = i + 1;
    const done = (meta.tutStage ?? 0) >= n;
    return `<div class="setRow" style="margin:0"><div style="flex:1;font-size:.76rem;color:#e6d6ac">
      <b>${l.ru}</b> ${done ? '✅' : ''} · награда ${l.reward}
      <span class="setHint">${l.hint}</span></div>
      <button class="btn tutStart" data-n="${n}">${done ? 'Пройти снова' : 'Начать'}</button></div>`;
  }).join('');
  let reward = '';
  if ((meta.tutStage ?? 0) >= 4 && !meta.tutReward) {
    reward = `<h4 class="shopH">🎁 Награда за обучение: стартовая колода фракции + 5 бустеров + 💎100</h4>
      <div class="ptabs">${FACTION_IDS.map(f =>
        `<button class="btn tutPick" data-f="${f}">${FACTION_SIGIL[f]} ${FACTION_RU[f as Faction]}</button>`).join('')}</div>`;
  } else if (meta.tutReward) {
    reward = `<div class="jl you">🎁 Награда получена: стартовая колода «${FACTION_RU[meta.tutReward as Faction]}» + 5 бустеров + 💎100</div>`;
  }
  $('tutBody').innerHTML = `
    <div class="jl" style="opacity:.8">Четыре урока на настоящем движке боя: игра не даст завершить ход, пока задание
      урока не выполнено. Матчи уроков не влияют на рейтинг; противник — пассивный ИИ.</div>${rows}${reward}
    <div class="ptabs" style="margin-top:.5rem">
      <button class="btn" id="btnTourRun">🗺 Тур по интерфейсу</button>
      <button class="btn" id="btnPracticeHint">🏹 Режим тренировки</button></div>`;
  $('tutModal').classList.remove('hidden');
}
function startLesson(n: number): void {
  battle.tutCleanup();
  battle.launchMode = 'tut';
  battle.practice = true;
  battle.tutLesson = n;
  battle.difficulty = 0.3;
  battle.enemyFaction = FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)];
  $('tutModal').classList.add('hidden');
  btn('btnPlay').click();
}
function grantTutReward(fac: string): void {
  meta.tutReward = fac;
  const cheap = [...db.values()].filter(c => c.faction === fac && !isExpansionId(c.id))
    .sort((a, b) => a.cost - b.cost).slice(0, 10);
  for (const c of cheap) owned.set(c.id, Math.min(PLAYSET, (owned.get(c.id) ?? 0) + 2));
  ownedSave();
  meta.freeOpens = (meta.freeOpens ?? 0) + 5;
  metaSave();
  gemsAdd(100);
  renderShards();
  tutGatePractice();
  openTut();
  showToast(`🎁 Стартовая колода «${FACTION_RU[fac as Faction]}»: 10 карт ×2, 5 бустеров, 💎100`);
}
/** Спека 6.3: тренировка (матчи без рейтинга) доступна только после обучения. */
function tutGatePractice(): void {
  const cp = document.getElementById('chkPractice') as HTMLInputElement | null;
  if (!cp) return;
  cp.disabled = !meta.tutDone;
  if (cp.parentElement) cp.parentElement.title = meta.tutDone
    ? 'Тренировка: матчи против ИИ без влияния на рейтинг'
    : '🎓 Тренировка откроется после прохождения обучения';
  // после обучения убираем устаревшую приписку «доступна после обучения» из видимого текста
  const lbl = cp.parentElement?.querySelector('span');
  if (lbl) lbl.textContent = meta.tutDone
    ? 'Тренировка — без влияния на рейтинг и наград'
    : 'Тренировка — без влияния на рейтинг · доступна после 🎓 обучения';
}
/* тестовые хуки спеки «6» (смоук) */
(window as unknown as { ecSetTut: (stage: number, done: boolean) => void }).ecSetTut = (stage, done) => {
  meta.tutStage = stage; meta.tutDone = done; metaSave(); tutGatePractice();
};
(window as unknown as { ecFreeOpens: () => number }).ecFreeOpens = () => meta.freeOpens ?? 0;
(window as unknown as { ecGems: () => number }).ecGems = () => gemsGet();
document.addEventListener('click', ev => {
  const t0 = ev.target as HTMLElement | null;
  const ts = t0?.closest?.('.tutStart') as HTMLElement | null;
  if (ts?.dataset.n) { startLesson(Number(ts.dataset.n)); return; }
  const tp = t0?.closest?.('.tutPick') as HTMLElement | null;
  if (tp?.dataset.f) { grantTutReward(tp.dataset.f); return; }
  if (t0?.id === 'btnTourRun') { $('tutModal').classList.add('hidden'); tourIdx = 0; tourShow(); return; }
  if (t0?.id === 'btnPracticeHint') {
    $('tutModal').classList.add('hidden');
    if (!meta.tutDone) { showToast('🏹 Тренировка откроется после обучения — начните с урока 1'); return; }
    const chk = document.getElementById('chkPractice') as HTMLInputElement | null;
    if (chk) { chk.checked = true; chk.scrollIntoView({ block: 'center' }); }
    showToast('🏹 Тренировка включена: матчи без влияния на рейтинг');
    return;
  }
  if (t0?.id === 'btnTutClose') $('tutModal').classList.add('hidden');
});

/* --- тур-туториал: подсветка ключевых зон интерфейса --- */
const TOUR: Array<[string, string]> = [
  ['#hand', 'Ваша рука: веер карт. Клик — разыграть (если хватает маны), перетаскивание — на цель или на поле.'],
  ['#playerMana', 'Мана: растёт на 1 каждый ход (до 10). Стоимость карты — кристалл в правом углу пластины имени.'],
  ['#stepTrack', 'Дорожка фаз: Начало → Ресурсы → Основная → Битва → Конец. Фазы идут автоматически, решения — в Основной и Битве.'],
  ['#playerBoard', 'Ваше поле: до 7 существ. Золотое свечение — существо готово атаковать.'],
  ['#playerRunes', 'Руны: постоянные усилители (до 3). Ставятся в основной фазе за ману.'],
  ['#actionDock', 'Панель действий: завершить ход, журнал боя, подсказки. Во время боя противника здесь появится окно отклика для мгновенных заклинаний.'],
  ['#playerGrave', 'Кладбище: клик по счётчику сброса открывает просмотр ваших и вражеских ушедших карт.'],
];
let tourIdx = 0;
function tourShow(): void {
  document.querySelectorAll('.tourHi').forEach(x => x.classList.remove('tourHi'));
  if (!meta.tutDone && tourIdx < TOUR.length) {
    const [selr, text] = TOUR[tourIdx];
    const tgt = document.querySelector(selr);
    if (tgt) tgt.classList.add('tourHi');
    $('tourText').textContent = text;
    $('tourStep').textContent = `${tourIdx + 1} / ${TOUR.length}`;
    $('tourOverlay').classList.remove('hidden');
  } else {
    $('tourOverlay').classList.add('hidden');
    meta.tutDone = true; metaSave();
  }
}
btn('btnTourNext').addEventListener('click', () => { tourIdx += 1; tourShow(); });
btn('btnTourSkip').addEventListener('click', () => { tourIdx = TOUR.length; tourShow(); });

btn('btnPackFlip').addEventListener('click', () => {
  const slots = Array.from($('packRow').querySelectorAll('.packSlot')) as HTMLElement[];
  slots.forEach((sl, i) => {
    window.setTimeout(() => {
      if (!sl.classList.contains('flip')) {
        sl.classList.add('flip');
        const rar = (sl.dataset.rarity ?? '').toLowerCase();
        if (rar === 'rare' || rar === 'epic' || rar === 'legendary') {
          sl.classList.add('burst');
          window.setTimeout(()=> sl.classList.remove('burst'), 900);
        }
        try { Sfx.uiClick(); } catch {}
      }
    }, i * 110);
  });
});
btn('btnEcho').addEventListener('click', () => { battle.useEchoNow().catch(err => reportFatal('echo', err)); });
btn('btnSound').addEventListener('click', () => {
  const on = !audioOn;
  audioOn = on;
  settings.sound = on;
  audioSetEnabled(on);
  btn('btnSound').textContent = on ? '🔊 Звук' : '🔇 Звук';
  const s2 = $('setSound2') as HTMLInputElement | null;
  if (s2) s2.checked = on;
  saveSettings();
  if (on) { audioUnlock(); Sfx.uiClick(); }
});

/* --- панель настроек (⚙ / H) --- */
btn('btnSettings').addEventListener('click', () => toggleSettings());
btn('btnSetClose')?.addEventListener('click', () => toggleSettings(false));
$('settingsScrim')?.addEventListener('click', () => toggleSettings(false));
([
  ['setPreview', 'preview'],
  ['setFx', 'fxLite'],
  ['setSound2', 'sound'],
  ['setHints', 'hints'],
] as [string, keyof UISettings][]).forEach(([id, key]) => {
  const box = $(id) as HTMLInputElement | null;
  if (!box) return;
  box.addEventListener('change', () => {
    (settings as unknown as Record<string, boolean | number>)[key] = box.checked;
    saveSettings();
    applySettings();
  });
});
btn('btnMenu').addEventListener('click', () => openHomeScreen());
btn('btnAgain').addEventListener('click', () => { $('gameover').classList.add('hidden'); battle.start().catch(err => reportFatal('restart', err)); });
btn('btnGoMenu').addEventListener('click', () => openHomeScreen());

/* --- коллекция: виртуализированная подгрузка оформлениями по 40 карточек --- */
interface CollectionEntry { card: CardData; style: CardAppearance }
const COLLECTION_PAGE_SIZE = 40;
let colList: CardData[] = [];
let colStyles: CardAppearance[] = [];
let colEntries: CollectionEntry[] = [];
let colRendered = 0;
let colBaseCount = 0;
let colActiveStyle = '';
let colObserver: IntersectionObserver | null = null;
let colRenderGeneration = 0;
function openCollectionScreen(): void {
  setAppRoute('collection');
  $('menu').classList.add('hidden');
  for (const id of ['homeScreen','eventsScreen','decksScreen','shopModal','bpModal','profileModal','boosterModal','campaignModal','journalModal','replayModal'])
    document.getElementById(id)?.classList.add('hidden');
  $('collection').classList.remove('hidden');
  document.getElementById('tabCollection')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function collectionCountText(baseCount: number, styleFilter: string): string {
  if (styleFilter === '') return `${baseCount} карт × 2 оформления`;
  return styleFilter === 'borderless' ? `${baseCount} Borderless-вариантов` : `${baseCount} классических карт`;
}
function updateCollectionCount(baseCount: number, styleFilter: string): void {
  const node = document.getElementById('colCount');
  if (!node) return;
  const found = colEntries.length;
  if (!found) { node.textContent = 'Ничего не найдено'; return; }
  const count = Math.min(colRendered, found);
  const tail = count < found ? ` · ещё ${found - count} загрузятся при прокрутке` : ' · всё загружено';
  node.textContent = `Показано ${count} из ${found} · ${collectionCountText(baseCount, styleFilter)}${tail}`;
  const load = document.querySelector<HTMLButtonElement>('#colSentinel .collectionLoadMore');
  if (load && !load.disabled) load.textContent = `Загрузить ещё · ${Math.min(COLLECTION_PAGE_SIZE, found - count)} из ${found - count}`;
}
function renderCollectionEntry(entry: CollectionEntry): HTMLElement {
  const { card: c, style } = entry;
  const node = renderCard(c, style);
  node.style.transform = 'none';
  node.addEventListener('mouseenter', ev => { showTooltip(c, ev.clientX, ev.clientY); showZoom(c, ev.clientX, ev.clientY, 'auto', style); });
  node.addEventListener('mouseleave', () => { hideTooltip(); hideZoom(); });
  node.addEventListener('click', () => openCardModal(c, colList, style, colStyles));
  if (style === 'borderless') {
    if (!hasBorderless(c.id)) {
      node.classList.add('locked', 'borderlessLocked');
      node.title = 'Borderless — та же карта без рамки. Награда события или шанс 0,1% из бустера.';
    } else {
      node.classList.add('borderlessOwned');
      if (isBorderlessEquipped(c.id)) node.classList.add('borderlessEquipped');
    }
  } else {
    const cnt = ownedCount(c.id);
    if (cnt > 1) node.appendChild(el('div', 'ownCnt', `×${cnt}`));
    if (cnt === 0) {
      node.classList.add('locked');
      node.appendChild(el('div', 'lockBadge', 'Не открыта'));
      node.title = STARTER_CARD_IDS.has(c.id)
        ? 'Карта есть в готовой стартовой колоде; отдельная копия коллекции не открыта.'
        : 'Карта вне стартовых колод: открывается из бустеров, боевого пропуска и событий.';
    }
    if (isBorderlessEquipped(c.id)) node.title = 'Borderless-вариант этой карты надет; откройте карточку, чтобы изменить оформление.';
  }
  return node;
}
function appendCollectionPage(): number {
  const grid = document.getElementById('colGrid');
  const sentinel = document.getElementById('colSentinel');
  if (!grid || !sentinel || colRendered >= colEntries.length) return 0;
  const start = colRendered;
  const end = Math.min(colEntries.length, start + COLLECTION_PAGE_SIZE);
  const added = end - start;
  const fragment = document.createDocumentFragment();
  for (; colRendered < end; colRendered++) fragment.appendChild(renderCollectionEntry(colEntries[colRendered]));
  grid.insertBefore(fragment, sentinel);
  updateCollectionCount(colBaseCount, colActiveStyle);
  if (colRendered >= colEntries.length) {
    colObserver?.disconnect(); colObserver = null;
    sentinel.classList.add('allLoaded');
    const button = sentinel.querySelector<HTMLButtonElement>('.collectionLoadMore');
    if (button) { button.disabled = true; button.textContent = '✓ Все карты загружены'; }
    const note = sentinel.querySelector<HTMLElement>('.collectionLoadNote');
    if (note) note.textContent = 'Фильтры можно изменить в любое время.';
  }
  return added;
}
function loadAllCollectionPagesForTest(): number {
  while (colRendered < colEntries.length) {
    const before = colRendered;
    appendCollectionPage();
    if (colRendered === before) break;
  }
  return colRendered;
}
(window as any).ecTestLoadCollectionAll = loadAllCollectionPagesForTest;
(window as any).ecTestCollectionState = (): { rendered: number; total: number; pageSize: number } =>
  ({ rendered: colRendered, total: colEntries.length, pageSize: COLLECTION_PAGE_SIZE });
function renderCollection(): void {
  colObserver?.disconnect(); colObserver = null;
  colRenderGeneration++;
  const generation = colRenderGeneration;
  const fac = sel('colFaction').value;
  const typ = sel('colType').value;
  const rar = sel('colRarity').value;
  const q = ($('colSearch') as HTMLInputElement).value.trim().toLowerCase();
  const grid = $('colGrid');
  grid.innerHTML = '';
  grid.scrollTop = 0;
  colRendered = 0;
  const onlyOwned = ($('colOwned') as HTMLInputElement | null)?.checked ?? false;
  const costF = sel('colCost').value;
  const kwF = sel('colKw').value;
  const styleFilter = sel('colStyle').value;
  colActiveStyle = styleFilter;
  const baseList = ALL_CARDS.filter(c =>
    (!fac || c.faction === fac) && (!typ || c.type === typ) && (!rar || c.rarity === rar) &&
    (!costF || (costF === 'low' ? c.cost <= 3 : costF === 'mid' ? c.cost >= 4 && c.cost <= 5 : c.cost >= 6)) &&
    (!kwF || (c.keywords ?? []).includes(kwF as Keyword)) &&
    (!q || c.name.toLowerCase().includes(q) || (c.abilityText ?? '').toLowerCase().includes(q)
      || cardName(c).toLowerCase().includes(q) || cardText(c).toLowerCase().includes(q)));
  const order: Record<string, number> = { Creature: 0, Spell: 1, Rune: 2 };
  baseList.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.cost - b.cost || a.name.localeCompare(b.name, 'ru'));
  const styles: CardAppearance[] = styleFilter === '' ? ['classic', 'borderless'] : [styleFilter as CardAppearance];
  colBaseCount = baseList.length;
  colEntries = [];
  for (const card of baseList) for (const style of styles) {
    if (onlyOwned && (style === 'borderless' ? !hasBorderless(card.id) : ownedCount(card.id) <= 0)) continue;
    colEntries.push({ card, style });
  }
  colList = colEntries.map(entry => entry.card);
  colStyles = colEntries.map(entry => entry.style);
  if (!colEntries.length) {
    grid.innerHTML = '<div class="collectionEmpty">Нет карт по выбранным фильтрам. Измените поиск или параметры фильтра.</div>';
    updateCollectionCount(baseList.length, styleFilter);
    return;
  }
  grid.innerHTML = `<div class="collectionSentinel" id="colSentinel">
    <button type="button" class="btn collectionLoadMore" aria-label="Загрузить следующую страницу карт">Загрузить ещё · ${Math.min(COLLECTION_PAGE_SIZE, colEntries.length)} из ${colEntries.length}</button>
    <span class="collectionLoadNote">Или прокрутите вниз — следующие карты появятся автоматически.</span>
  </div>`;
  const button = grid.querySelector<HTMLButtonElement>('.collectionLoadMore');
  button?.addEventListener('click', () => appendCollectionPage());
  appendCollectionPage();
  updateCollectionCount(baseList.length, styleFilter);
  const sentinel = document.getElementById('colSentinel');
  if (sentinel && 'IntersectionObserver' in window) {
    colObserver = new IntersectionObserver(entries => {
      if (generation !== colRenderGeneration) return;
      if (entries.some(entry => entry.isIntersecting)) appendCollectionPage();
    }, { root: grid, rootMargin: '480px 0px', threshold: 0.01 });
    colObserver.observe(sentinel);
  }
}
btn('btnCollection').addEventListener('click', () => openCollectionScreen());
btn('btnColClose').addEventListener('click', () => navigateApp('back'));
sel('colFaction').innerHTML = '<option value="">Все фракции</option>' +
  FACTION_IDS.map(f => `<option value="${f}">${FACTION_RU[f]}</option>`).join('') + '<option value="Neutral">◈ Нейтральные</option>';
const spSel = document.getElementById('setSpeed') as HTMLSelectElement | null;
if (spSel) spSel.addEventListener('change', () => { settings.animSpeed = Number(spSel.value) || 1; saveSettings(); applySettings(); });
const apChk = document.getElementById('setAutoPass') as HTMLInputElement | null;
if (apChk) apChk.addEventListener('change', () => { settings.autoPass = apChk.checked; saveSettings(); applySettings(); });
const rpChk = document.getElementById('setRope') as HTMLInputElement | null;
if (rpChk) rpChk.addEventListener('change', () => { settings.rope = rpChk.checked; saveSettings(); applySettings(); });
const cbChk = document.getElementById('setCb') as HTMLInputElement | null;
if (cbChk) cbChk.addEventListener('change', () => { settings.cbMode = cbChk.checked; saveSettings(); applySettings(); });
const fsSel = document.getElementById('setFontScale') as HTMLSelectElement | null;
if (fsSel) fsSel.addEventListener('change', () => { settings.fontScale = Number(fsSel.value) || 1; saveSettings(); applySettings(); });
const subChk = document.getElementById('setSubs') as HTMLInputElement | null;
if (subChk) subChk.addEventListener('change', () => { settings.subs = subChk.checked; saveSettings(); applySettings(); });
const langSel = document.getElementById('setLang') as HTMLSelectElement | null;
if (langSel) langSel.addEventListener('change', () => { void switchLang(langSel.value); });
const vmSl = document.getElementById('setVolMusic') as HTMLInputElement | null;
if (vmSl) vmSl.addEventListener('input', () => { settings.volMusic = Number(vmSl.value); saveSettings(); applySettings(); });
const vsSl = document.getElementById('setVolSfx') as HTMLInputElement | null;
if (vsSl) vsSl.addEventListener('input', () => { settings.volSfx = Number(vsSl.value); saveSettings(); applySettings(); });
const qSel = document.getElementById('setQuality') as HTMLSelectElement | null;
if (qSel) qSel.addEventListener('change', () => { settings.quality = qSel.value; saveSettings(); applySettings(); });
/* ---- Аккаунт: вход/регистрация через meta-server (LAUNCH_PLAN v2.27.0) ---- */
let authMode: 'login' | 'register' = 'login';
function syncAccountRow(): void {
  const inn = !!meta.signedIn;
  const show = (id: string, on: boolean): void => {
    const e = document.getElementById(id);
    if (e) e.style.display = on ? '' : 'none';
  };
  show('btnLoginOpen', !inn);
  show('btnRegisterOpen', !inn);
  show('btnLogout', inn);
  const hint = document.getElementById('accHint');
  if (hint) hint.textContent = inn
    ? `Аккаунт: ${meta.nick} · профиль синхронизируется с meta-server`
    : 'Локальный профиль: прогресс сохраняется в браузере';
}
function openAuth(mode: 'login' | 'register'): void {
  authMode = mode;
  const m = document.getElementById('authModal');
  if (!m) return;
  const title = document.getElementById('authTitle');
  if (title) title.textContent = mode === 'login' ? 'Вход в аккаунт' : 'Регистрация аккаунта';
  const sub = document.getElementById('authSubmit');
  if (sub) sub.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  const sw = document.getElementById('authSwitch');
  if (sw) sw.textContent = mode === 'login' ? 'Создать аккаунт' : 'У меня уже есть аккаунт';
  const er = document.getElementById('authErr');
  if (er) er.textContent = '';
  const pw = document.getElementById('authPass') as HTMLInputElement | null;
  if (pw) pw.value = '';
  m.classList.remove('hidden');
  (document.getElementById('authLogin') as HTMLInputElement | null)?.focus();
}
function closeAuth(): void { document.getElementById('authModal')?.classList.add('hidden'); }
/** Гидрация профиля с meta-server после логина на новом устройстве. */
async function pullProfile(pid: string): Promise<void> {
  try {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 2000);
    const r = await window.fetch(`${META_API()}/api/profile?pid=${encodeURIComponent(pid)}`, { signal: ctl.signal });
    window.clearTimeout(t);
    if (!r.ok) return; // зеркала ещё нет — остаёмся на локальном прогрессе
    const gp = (await r.json()) as Record<string, unknown>;
    meta.nick = String(gp.nick ?? meta.nick);
    meta.xp = Number(gp.xp ?? meta.xp);
    meta.mmr = Number(gp.mmr ?? meta.mmr);
    meta.bestMmr = Number(gp.bestMmr ?? meta.bestMmr ?? meta.mmr);
    meta.wins = Number(gp.wins ?? meta.wins);
    meta.losses = Number(gp.losses ?? meta.losses);
    meta.avatarFac = String(gp.avatarFac ?? meta.avatarFac);
    meta.frame = String(gp.frame ?? meta.frame);
    if (gp.ach) meta.ach = gp.ach as Record<string, boolean>;
    const q = gp.quests as { daily?: Array<{ id: string; prog: number; goal: number; claimed: boolean; fac?: string }>; weekly?: Array<{ id: string; prog: number; goal: number; claimed: boolean }> } | undefined;
    if (typeof gp.questDate === 'string') meta.questDate = gp.questDate;
    if (typeof gp.wquestWeek === 'string') meta.wquestWeek = gp.wquestWeek;
    if (q?.daily) meta.quests = normalizeQuestSet(q.daily.map(x => ({ ...x })), freshQuests());
    if (q?.weekly) meta.wquests = normalizeQuestSet(q.weekly.map(x => ({ ...x })), freshWQuests());
    syncQuestPeriods();
    if (Array.isArray(gp.history)) meta.history = gp.history as typeof meta.history;
    if (typeof gp.shards === 'number') shardsSet(gp.shards);
    if (typeof gp.gems === 'number') meta.gems = gp.gems;
    meta.freeOpens = Number(gp.freeOpens ?? meta.freeOpens ?? 0);
    if (Array.isArray(gp.bundles)) meta.bundles = gp.bundles as string[];
    meta.bpXp = Number(gp.bpXp ?? meta.bpXp ?? 0);
    if (gp.bpPremium != null) meta.bpPremium = !!gp.bpPremium;
    if (Array.isArray(gp.bpClaimed)) meta.bpClaimed = gp.bpClaimed as number[];
    if (Array.isArray(gp.bpClaimedP)) meta.bpClaimedP = gp.bpClaimedP as number[];
    meta.foilTokens = Number(gp.foilTokens ?? meta.foilTokens ?? 0);
    meta.premOpens = Number(gp.premOpens ?? meta.premOpens ?? 0);
    if (Array.isArray(gp.avatarsOwned)) meta.avatarsOwned = gp.avatarsOwned as string[];
    meta.tutStage = Number(gp.tutStage ?? meta.tutStage ?? 0);
    if (gp.tutDone != null) meta.tutDone = !!gp.tutDone;
    meta.tutReward = String(gp.tutReward ?? meta.tutReward ?? '');
    if (Array.isArray(gp.tutClaims)) meta.tutClaims = gp.tutClaims as number[];
    const c = gp.cosmetics as { backs?: string[]; tables?: string[]; runes?: string[]; backEq?: string; tableSkin?: string; runeSkin?: string } | null | undefined;
    if (c) {
      if (Array.isArray(c.backs)) meta.backsOwned = c.backs;
      if (Array.isArray(c.tables)) meta.tablesOwned = c.tables;
      if (Array.isArray(c.runes)) meta.runesOwned = c.runes;
      if (c.backEq) meta.backEq = c.backEq;
      if (c.tableSkin) meta.tableSkin = c.tableSkin;
      if (c.runeSkin) meta.runeSkin = c.runeSkin;
    }
    metaSave();
  } catch { /* офлайн — локальный профиль остаётся источником истины */ }
}
async function authDo(): Promise<void> {
  const login = (document.getElementById('authLogin') as HTMLInputElement | null)?.value.trim() ?? '';
  const pw = (document.getElementById('authPass') as HTMLInputElement | null)?.value ?? '';
  const er = document.getElementById('authErr');
  const setErr = (s: string): void => { if (er) er.textContent = s; };
  setErr('');
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(login)) { setErr('Логин:3–20 символов, латиница/цифры/_.-'); return; }
  if (pw.length < 4) { setErr('Пароль: минимум4 символа'); return; }
  try {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 2500);
    const r = await window.fetch(`${META_API()}/api/auth/${authMode}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ login, password: pw, pid: meta.pid }),
    });
    window.clearTimeout(t);
    const j = (await r.json().catch(() => ({}))) as { error?: string; login?: string; pid?: string };
    if (!r.ok) { setErr(j.error || `Ошибка сервера (${r.status})`); return; }
    const accPid = String(j.pid || meta.pid);
    if (accPid && accPid !== meta.pid) { meta.pid = accPid; await pullProfile(accPid); }
    if (meta.nick === 'Гость') meta.nick = String(j.login || login);
    meta.signedIn = true;
    metaSave(); syncProfile(); syncAccountRow(); renderShards();
    closeAuth();
    showToast(authMode === 'login' ? `🔑 Вы вошли: ${j.login}` : `🎉 Аккаунт создан: ${j.login}`);
  } catch {
    setErr('Сервер недоступен — запусти `npm run server:meta` (:8081) или играй локально как Гость');
  }
}
document.getElementById('btnLoginOpen')?.addEventListener('click', () => openAuth('login'));
document.getElementById('btnRegisterOpen')?.addEventListener('click', () => openAuth('register'));
document.getElementById('authSubmit')?.addEventListener('click', () => { Sfx.uiClick(); void authDo(); });
document.getElementById('authSwitch')?.addEventListener('click', () => { Sfx.uiClick(); openAuth(authMode === 'login' ? 'register' : 'login'); });
document.getElementById('authCancelBtn')?.addEventListener('click', () => { Sfx.uiClick(); closeAuth(); });
document.getElementById('authModal')?.addEventListener('click', ev => { if (ev.target === document.getElementById('authModal')) closeAuth(); });
for (const id of ['authLogin', 'authPass']) {
  document.getElementById(id)?.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Enter') { ev.preventDefault(); void authDo(); } });
}
syncAccountRow();

const logoutB = document.getElementById('btnLogout');
if (logoutB) logoutB.addEventListener('click', () => {
  if (!window.confirm('Выйти из аккаунта? Локальный прогресс сохранится.')) return;
  meta.signedIn = false; meta.nick = 'Гость'; metaSave();
  document.getElementById('settingsPanel')?.classList.add('hidden');
  document.getElementById('settingsScrim')?.classList.add('hidden');
  syncAccountRow();
  showToast('👋 Вы вышли из аккаунта');
});
['colFaction', 'colType', 'colRarity', 'colCost', 'colKw', 'colStyle'].forEach(id => sel(id).addEventListener('change', renderCollection));
$('colOwned').addEventListener('change', renderCollection);
$('colSearch').addEventListener('input', renderCollection);

/* ---------------------------------------------------------------------- */
/*  Модалка карты: «открыть и прочитать описание»                          */
/* ---------------------------------------------------------------------- */

let modalList: CardData[] = [];
let modalStyles: CardAppearance[] = [];
let modalIdx = 0;

function openCardModal(card: CardData, list: CardData[], appearance: CardAppearance = 'auto', styles?: CardAppearance[]): void {
  modalList = list.length ? list : [card];
  modalStyles = modalList.map((_, i) => styles?.[i] ?? appearance);
  modalIdx = modalList.findIndex((item, i) => item === card && modalStyles[i] === appearance);
  if (modalIdx < 0) modalIdx = Math.max(0, modalList.indexOf(card));
  renderCardModal();
  $('cardModal').classList.remove('hidden');
  hideZoom();
  hideZoom(); hideTooltip();
  Sfx.uiClick();
}

function renderCardModal(): void {
  const c = modalList[modalIdx];
  if (!c) return;
  const appearance = modalStyles[modalIdx] ?? 'auto';
  const cardStyle = resolvedAppearance(c, appearance);
  const borderlessOwned = hasBorderless(c.id);
  const borderlessOn = isBorderlessEquipped(c.id);
  const col = colorOf(c.faction);
  const host = $('cmCard');
  host.innerHTML = '';
  host.appendChild(renderCardLarge(c, 'xxl', appearance));
  const kws = (c.keywords ?? []).map(k => kwName(k));
  $('cmInfo').innerHTML = `
    <div class="cmName" style="color:${col.primary}">${esc(cardName(c))}</div>
    <div class="cmType">${typeName(c.type)} · ${factionName(c.faction)} · ${rarityName(c.rarity)}${
      c.element !== Element.None ? ' · ' + elemName(c.element) : ''}${
      c.type === CardType.Spell && c.subtype === SpellSubtype.Ritual ? bi(' · ритуал', ' · ritual') : ''}</div>
    <div class="cmVariantNote ${cardStyle === 'borderless' ? 'isBorderless' : ''}">${cardStyle === 'borderless'
      ? '◇ Borderless · тот же арт и название, снята только рамка; правила и характеристики те же'
      : 'Классическая версия · Borderless-вариант сохраняет арт, название и свойства карты'}</div>
    <section class="cmStylePicker" id="cmStylePicker" aria-label="Стили карты">
      <div class="cmStylePickerHead"><b>СТИЛЬ КАРТЫ</b><span>Используется в коллекции, колодах и матче</span></div>
      <div class="cmStyleOptions">
        <button type="button" class="cmStyleChoice ${borderlessOn ? '' : 'isActive'}" data-cm-style="classic" aria-pressed="${!borderlessOn}">
          <span class="cmStyleSwatch classic" aria-hidden="true"></span><span class="cmStyleLabel"><b>Классика</b><small>Стандартная рамка</small></span><span class="cmStyleCheck">${borderlessOn ? '' : '✓'}</span>
        </button>
        <button type="button" class="cmStyleChoice ${borderlessOn ? 'isActive' : ''}" data-cm-style="borderless" aria-pressed="${borderlessOn}" ${borderlessOwned ? '' : 'disabled'} title="${borderlessOwned ? 'Применить стиль Borderless' : 'Получите вариант в событии или бустере'}">
          <span class="cmStyleSwatch borderless" aria-hidden="true"></span><span class="cmStyleLabel"><b>Borderless</b><small>${borderlessOwned ? 'Получен · без рамки' : 'Не получен · событие или бустер'}</small></span><span class="cmStyleCheck">${borderlessOn ? '✓' : ''}</span>
        </button>
      </div>
    </section>
    <div class="cmStyleStatus">Сейчас в игре: <b>${borderlessOn ? 'Borderless' : 'Классика'}</b> · тот же игровой ID и лимит копий</div>
    <div class="cmStats">
      <span title="Стоимость маны">✦ ${c.cost}</span>
      ${c.type === CardType.Creature
        ? `<span title="Атака">⚔ ${c.attack ?? 0}</span><span title="Здоровье">❤ ${c.health ?? 0}</span>` : ''}
    </div>
    <div class="cmText">${kws.length ? `<span class="cmKw">${kws.map(k => `<strong class="cardKeyword">${esc(k)}</strong>`).join(' · ')}.</span> ` : ''}${
      highlightCardKeywords(cardText(c) || bi('Без текста способности.', 'No ability text.'))}</div>
    ${cardFlavor(c) ? `<div class="cmFlavor">${esc(cardFlavor(c))}</div>` : ''}`;
  $('cmStylePicker').querySelectorAll<HTMLButtonElement>('[data-cm-style]').forEach(button => {
    button.addEventListener('click', () => {
      const wantsBorderless = button.dataset.cmStyle === 'borderless';
      if (wantsBorderless && !hasBorderless(c.id)) return;
      setBorderlessEquipped(c.id, wantsBorderless);
      modalStyles[modalIdx] = 'auto';
      renderCardModal();
      if (!$('collection').classList.contains('hidden')) {
        if (!$('dbMain').classList.contains('hidden')) renderEditor(); else renderCollection();
      }
      showToast(wantsBorderless ? `◇ Borderless надет: «${cardName(c)}»` : `Классический стиль включён: «${cardName(c)}»`);
    });
  });
  $('cmPos').textContent = `${modalIdx + 1} / ${modalList.length}`;
  const have = ownedCount(c.id);
  const bc = $('cmCraft') as HTMLButtonElement | null;
  const bd = $('cmDust') as HTMLButtonElement | null;
  if (bc) { bc.textContent = `Создать 🪙${CRAFT_COST[c.rarity] ?? 100}`; bc.disabled = have >= PLAYSET; }
  if (bd) { bd.textContent = `Разобрать +🪙${DISENCHANT_COINS[c.rarity] ?? 20}`; bd.disabled = have <= (isExpansionId(c.id) ? 0 : 1); }
  const bf = $('cmFoil') as HTMLButtonElement | null;
  if (bf) {
    bf.textContent = `🌟 Фойл (жетонов: ${meta.foilTokens ?? 0})`;
    bf.disabled = (meta.foilTokens ?? 0) <= 0 || have <= 0 || (foils.get(c.id) ?? 0) >= PLAYSET;
    bf.title = (meta.foilTokens ?? 0) <= 0 ? 'Фойл-жетоны — награда премиум-ветки пропуска (5 уровень)'
      : have <= 0 ? 'Сначала получите карту' : 'Сделать фойл-версию карты (навечно)';
  }
  const bbl = $('cmBorderless') as HTMLButtonElement | null;
  if (bbl) {
    bbl.textContent = borderlessOwned ? (borderlessOn ? '◇ Borderless · надето ✓' : '◇ Надеть Borderless') : '◇ Borderless · не получено';
    bbl.disabled = !borderlessOwned;
    bbl.setAttribute('aria-pressed', borderlessOn ? 'true' : 'false');
    bbl.title = borderlessOwned
      ? 'Альтернативный внешний вид; правила и характеристики карты не меняются'
      : 'Получите из события или с шансом 0,1% из бустера';
  }
  const own = $('cmOwned');
  if (own) own.textContent = `Обычная ×${have} · Borderless ${borderlessOwned ? '✓' : '—'}`;
}

function modalStep(d: number): void {
  if (!modalList.length) return;
  modalIdx = (modalIdx + d + modalList.length) % modalList.length;
  renderCardModal();
  Sfx.uiHover();
}
function closeCardModal(): void { $('cardModal').classList.add('hidden'); }

btn('cmPrev').addEventListener('click', () => modalStep(-1));
btn('cmNext').addEventListener('click', () => modalStep(1));
btn('cmClose').addEventListener('click', closeCardModal);
$('cardModal').addEventListener('click', ev => { if (ev.target === $('cardModal')) closeCardModal(); });

/* ---------------------------------------------------------------------- */
/*  Конструктор колод (пользовательские колоды, localStorage)              */
/* ---------------------------------------------------------------------- */

interface EditDeck { id: string | null; name: string; faction: Faction; counts: Map<string, number>; avatarCardId: string | null }
let editing: EditDeck | null = null;
let builderOn = false;

/** Весь пул карт, включая нейтральные (коллекция их не показывает). */
const POOL_CARDS: CardData[] = cardsJson.cards as CardData[];
const dbLookup = (id: string): CardData | undefined => db.get(id);

function editingCards(): string[] {
  const out: string[] = [];
  if (editing) for (const [id, n] of editing.counts) for (let i = 0; i < n; i++) out.push(id);
  return out;
}

function dbStatus(msg: string, ok = false): void {
  const n = $('dbStatus');
  if (!msg) { n.classList.add('hidden'); n.textContent = ''; return; }
  n.classList.remove('hidden');
  n.textContent = msg;
  n.style.color = ok ? '#9fc7a9' : '#ffb4a8';
  n.style.background = ok ? 'rgba(30,90,50,.16)' : 'rgba(120,30,20,.16)';
}

/** null — добавить можно; иначе причина запрета (правила ТЗ п.3 + лимит владения). */
function canAdd(id: string): string | null {
  if (!editing) return 'Сначала создайте колоду: «＋ Новая»';
  const c = dbLookup(id);
  if (!c) return 'Неизвестная карта';
  if (c.faction !== editing.faction && c.faction !== Faction.Neutral) {
    return `В колоду ${FACTION_RU[editing.faction]} можно лишь свои и нейтральные карты`;
  }
  const n = editing.counts.get(id) ?? 0;
  const have = ownedCount(id);
  const cap = c.rarity === Rarity.Legendary ? MAX_LEGENDARY_COPIES : MAX_COPIES;
  if (n >= cap) return `«${c.name}»: не более ${cap} копий`;
  if (n >= have) return `«${c.name}»: в коллекции ${have} из ${cap} — откройте бустеры или скрафтите`;
  return null;
}

function dbAdd(id: string): void {
  const why = canAdd(id);
  if (why) { dbStatus(why); return; }
  editing!.counts.set(id, (editing!.counts.get(id) ?? 0) + 1);
  dbStatus(''); renderEditor();
}
function dbRemove(id: string): void {
  if (!editing) return;
  const n = editing.counts.get(id) ?? 0;
  if (!n) return;
  if (n === 1) editing.counts.delete(id); else editing.counts.set(id, n - 1);
  dbStatus(''); renderEditor();
}

function renderDeckAvatarPreview(): void {
  const host = document.getElementById('dbAvatarPreview') as HTMLElement | null;
  if (!host || !editing) return;
  const card = editing.avatarCardId ? dbLookup(editing.avatarCardId) : undefined;
  host.replaceChildren();
  const fallback = el('span', 'dbAvatarPlaceholder', FACTION_SIGIL[editing.faction] ?? '◇');
  host.appendChild(fallback);
  if (card) {
    const image = document.createElement('img');
    image.src = `/art/${encodeURIComponent(card.faction)}/${encodeURIComponent(card.id)}.png`;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => image.remove();
    host.appendChild(image);
    host.title = `Обложка колоды: ${cardName(card)}`;
  } else {
    host.title = 'Добавьте карту, чтобы выбрать обложку колоды';
  }
}

function renderEditor(): void {
  if (!editing) return;
  const cards = editingCards();
  $('dbDeckFaction').textContent = `· ${FACTION_RU[editing.faction]}`;
  $('dbCount').textContent = `${cards.length} · мин. ${MIN_DECK_SIZE}`;
  $('dbCount').title = `Минимум ${MIN_DECK_SIZE} карт; верхнего лимита нет`;
  $('dbCount').setAttribute('aria-label', `${cards.length} карт; минимум ${MIN_DECK_SIZE}, верхнего лимита нет`);
  sel('dbFaction').value = editing.faction;
  ($('dbName') as HTMLInputElement).value = editing.name;

  const avatarCards = [...editing.counts.entries()]
    .map(([id, count]) => ({ card: dbLookup(id), count }))
    .filter((row): row is { card: CardData; count: number } => !!row.card)
    .sort((a, b) => a.card.cost - b.card.cost || a.card.name.localeCompare(b.card.name, 'ru'));
  if (!editing.avatarCardId || !editing.counts.has(editing.avatarCardId)) {
    editing.avatarCardId = suggestedDeckArt(avatarCards.map(row => row.card.id))?.id ?? null;
  }
  const avatarSelect = sel('dbAvatarCard');
  avatarSelect.innerHTML = avatarCards.length
    ? avatarCards.map(({ card, count }) => `<option value="${esc(card.id)}">${esc(cardName(card))} · ×${count}</option>`).join('')
    : '<option value="">Добавьте карты в колоду</option>';
  avatarSelect.disabled = avatarCards.length === 0;
  avatarSelect.value = editing.avatarCardId ?? '';
  const avatarGallery = document.getElementById('btnDbAvatarGallery') as HTMLButtonElement | null;
  if (avatarGallery) {
    avatarGallery.disabled = avatarCards.length === 0;
    avatarGallery.title = avatarCards.length ? 'Открыть галерею артов карт этой колоды' : 'Сначала добавьте карты';
  }
  renderDeckAvatarPreview();

  /* список колоды */
  const listHost = $('dbDeckList');
  listHost.innerHTML = '';
  if (!cards.length) {
    listHost.appendChild(el('div', 'dbEmpty',
      'Колода пуста.<br>Добавляйте карты кликом из пула справа →'));
  } else {
    const rows = [...editing.counts.entries()]
      .map(([id, n]) => ({ c: dbLookup(id)!, n }))
      .filter(r => r.c)
      .sort((a, b) => a.c.cost - b.c.cost || a.c.name.localeCompare(b.c.name, 'ru'));
    for (const r of rows) {
      const row = el('div', 'dbRow');
      const styleBadge = isBorderlessEquipped(r.c.id)
        ? '<span class="dbRowStyle isBorderless" title="Borderless-оформление надето для этой карты">◇</span>' : '';
      row.innerHTML = `<span class="c">${r.c.cost}</span><span class="n" title="${esc(r.c.name)}">${esc(r.c.name)}${styleBadge}</span>
        <span class="q">×${r.n}</span>`;
      const minus = el('button', '', '−');
      minus.title = 'Убрать одну копию';
      minus.addEventListener('click', ev => { ev.stopPropagation(); dbRemove(r.c.id); });
      row.appendChild(minus);
      row.addEventListener('click', () => openCardModal(r.c, rows.map(x => x.c)));
      listHost.appendChild(row);
    }
  }

  /* кривая маны */
  const curve = $('dbCurve');
  curve.innerHTML = '';
  const buckets = new Array<number>(11).fill(0);
  for (const id of cards) { const c = dbLookup(id); if (c) buckets[Math.min(10, c.cost)]++; }
  const max = Math.max(1, ...buckets);
  buckets.forEach((v, i) => {
    const bar = el('div', 'bar');
    bar.innerHTML = `<i style="height:${Math.round((v / max) * 100)}%"></i><b>${i === 10 ? '10+' : i}</b>`;
    bar.title = `Мана ${i === 10 ? '10+' : i}: ${v} карт`;
    curve.appendChild(bar);
  });

  renderPool();
  updateDeckStyleAllButton();
}

function renderPool(): void {
  if (!editing) return;
  const q = ($('dbSearch') as HTMLInputElement).value.trim().toLowerCase();
  const typ = sel('dbType').value;
  const grid = $('dbPoolGrid');
  grid.innerHTML = '';
  const list = POOL_CARDS.filter(c =>
    ownedCount(c.id) > 0 &&
    (c.faction === editing!.faction || c.faction === Faction.Neutral) &&
    (!typ || c.type === typ) &&
    (!q || c.name.toLowerCase().includes(q) || (c.abilityText ?? '').toLowerCase().includes(q)
      || cardName(c).toLowerCase().includes(q) || cardText(c).toLowerCase().includes(q)));
  const order: Record<string, number> = { Creature: 0, Spell: 1, Rune: 2 };
  list.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.cost - b.cost || a.name.localeCompare(b.name, 'ru'));
  for (const c of list) {
    const node = renderCard(c);
    node.style.transform = 'none';
    const n = editing.counts.get(c.id) ?? 0;
    if (n > 0) node.appendChild(el('div', 'dbN', `×${n}`));
    if (canAdd(c.id) !== null && n > 0) node.classList.add('maxed');
    const info = el('button', 'dbI', 'i');
    info.title = 'Открыть описание карты';
    info.setAttribute('aria-label', `Описание: ${cardName(c)}`);
    info.addEventListener('click', ev => { ev.stopPropagation(); openCardModal(c, list); });
    node.appendChild(info);
    const stylePicker = el('button', 'dbStylePicker', '◇') as HTMLButtonElement;
    const equipped = isBorderlessEquipped(c.id);
    stylePicker.dataset.cardId = c.id;
    stylePicker.setAttribute('aria-pressed', equipped ? 'true' : 'false');
    stylePicker.setAttribute('aria-label', `Выбрать оформление: ${cardName(c)}`);
    stylePicker.title = `Стили карты · сейчас ${equipped ? 'Borderless' : 'Классика'} · выберите внешний вид для коллекции, колод и матча`;
    stylePicker.addEventListener('click', ev => {
      ev.stopPropagation();
      openCardModal(c, list, 'auto');
    });
    stylePicker.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); });
    node.appendChild(stylePicker);
    node.classList.toggle('borderlessEquipped', equipped);
    node.addEventListener('mouseenter', ev => showZoom(c, ev.clientX, ev.clientY));
    node.addEventListener('mouseleave', hideZoom);
    node.addEventListener('click', () => dbAdd(c.id));
    node.addEventListener('contextmenu', ev => { ev.preventDefault(); dbRemove(c.id); });
    grid.appendChild(node);
  }
  const borderlessInPool = list.filter(card => hasBorderless(card.id)).length;
  $('colCount').textContent = `Пул: ${list.length} игровых карт · Borderless доступно: ${borderlessInPool}`;
}

function updateDeckStyleAllButton(): void {
  const button = document.getElementById('btnDbStyleAll') as HTMLButtonElement | null;
  if (!button) return;
  const unlockedIds = ALL_CARDS.filter(card => hasBorderless(card.id)).map(card => card.id);
  const allOn = unlockedIds.length > 0 && unlockedIds.every(id => isBorderlessEquipped(id));
  button.disabled = unlockedIds.length === 0;
  button.textContent = unlockedIds.length === 0 ? '◇ Нет стилей'
    : allOn ? '◇ Снять все' : `◇ Все стили · ${unlockedIds.length}`;
  button.title = unlockedIds.length === 0
    ? 'Сначала получите Borderless-вариант'
    : allOn ? 'Снять Borderless-оформление со всех полученных карт'
      : `Применить Borderless-оформление ко всем ${unlockedIds.length} полученным картам`;
}

function renderMyDecksSel(): void {
  const list = loadCustomDecks();
  sel('dbMyDecks').innerHTML = list.length
    ? list.map(d => `<option value="${d.id}">${esc(d.name)} (${d.cards.length})</option>`).join('')
    : '<option value="">— моих колод нет —</option>';
}

function newEditing(faction: Faction): EditDeck {
  return { id: null, name: '', faction, counts: new Map(), avatarCardId: null };
}

function loadIntoEditor(deck: DeckLike | null): void {
  if (!deck) return;
  const counts = new Map<string, number>();
  for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  editing = {
    id: deck.id.startsWith('custom-') ? deck.id : null,
    name: deck.name,
    faction: deck.faction as Faction,
    counts,
    avatarCardId: deck.avatarCardId ?? null,
  };
  dbStatus(''); renderEditor();
}

function setTab(builder: boolean): void {
  builderOn = builder;
  btn('tabCollection').classList.toggle('sel', !builder);
  btn('tabBuilder').classList.toggle('sel', builder);
  $('colFilters').classList.toggle('hidden', builder);
  $('colGrid').classList.toggle('hidden', builder);
  $('colHint').classList.toggle('hidden', builder);
  $('dbBar').classList.toggle('hidden', !builder);
  $('dbMain').classList.toggle('hidden', !builder);
  if (builder) {
    if (!editing) editing = newEditing((sel('dbFaction').value || picked) as Faction);
    renderMyDecksSel();
    renderEditor();
  } else {
    $('colCount').textContent = '';
    renderCollection();
  }
}

btn('tabCollection').addEventListener('click', () => { Sfx.uiClick(); setTab(false); });
btn('tabBuilder').addEventListener('click', () => { Sfx.uiClick(); setTab(true); });
btn('btnDbStyleAll').addEventListener('click', () => {
  const styleIds = ALL_CARDS.filter(card => hasBorderless(card.id)).map(card => card.id);
  if (!styleIds.length) { showToast('Borderless-стили ещё не получены'); return; }
  const allOn = styleIds.every(id => isBorderlessEquipped(id));
  meta.borderlessEquipped = allOn ? [] : Array.from(new Set([...(meta.borderlessEquipped ?? []), ...styleIds]));
  metaSave(); renderEditor();
  showToast(allOn ? 'Классические стили включены для всех карт' : `Применено Borderless-стилей: ${styleIds.length}`);
});
btn('btnDbNew').addEventListener('click', () => {
  editing = newEditing((sel('dbFaction').value || picked) as Faction);
  dbStatus(''); renderEditor(); Sfx.uiClick();
});
btn('btnDbDup').addEventListener('click', () => {
  const srcId = sel('dbMyDecks').value !== '' && loadCustomDecks().some(d => d.id === sel('dbMyDecks').value)
    ? sel('dbMyDecks').value : sel('deckPick').value;
  const src = resolveDeck(srcId, deckList as unknown as DeckLike[]);
  if (!src) { dbStatus('Не найдена колода-источник'); return; }
  if (!FACTION_IDS.includes(src.faction as Faction)) {
    dbStatus('Колоду «Стартовая» скопировать нельзя: выберите фракционную'); return;
  }
  loadIntoEditor(src);
  editing!.id = null;
  editing!.name = `${src.name} (копия)`;
  dbStatus(''); renderEditor(); Sfx.uiClick();
});
btn('btnDbSave').addEventListener('click', () => {
  if (!editing) return;
  const name = (($('dbName') as HTMLInputElement).value.trim()) ||
    `${FACTION_RU[editing.faction]}: моя колода`;
  const check = validateDeck(editingCards(), editing.faction, dbLookup);
  if (!check.ok) { dbStatus(`Нельзя сохранить: ${check.problems.slice(0, 3).join('; ')}`); return; }
  const unowned = editingCards().filter(id => ownedCount(id) === 0);
  if (unowned.length > 0) {
    dbStatus(`Нельзя сохранить: карты расширения не получены (${unowned.length} шт.) — откройте бустеры`);
    return;
  }
  const over = [...editing.counts.entries()].filter(([id, n]) => n > ownedCount(id));
  if (over.length > 0) { dbStatus('Копий в колоде больше, чем получено из бустеров'); return; }
  const id = editing.id ?? `custom-${Date.now().toString(36)}`;
  const deck: CustomDeck = {
    id,
    name,
    faction: editing.faction,
    cards: editingCards(),
    avatarCardId: editing.avatarCardId ?? undefined,
    updated: Date.now(),
  };
  upsertCustomDeck(deck);
  editing.id = id; editing.name = name;
  buildMenu(); renderMyDecksSel();
  sel('dbMyDecks').value = id;
  dbStatus(`Сохранено: «${name}» — выберите обложку и запускайте бой кнопкой «В бой» или через Колоды → «Играть».`, true);
  Sfx.uiClick();
});
btn('btnDbExport').addEventListener('click', () => {
  if (!editing) { dbStatus('Нет открытой колоды для экспорта'); return; }
  const code = window.btoa(editingCards().join(','));
  dbStatus(`Код колоды: ${code}`, true);
  try { (window.navigator as Navigator).clipboard?.writeText(code); } catch { void 0; }
});
btn('btnDbImport').addEventListener('click', () => {
  const code = window.prompt('Вставьте код колоды:');
  if (!code) return;
  try {
    const ids = window.atob(code.trim()).split(',').filter(Boolean);
    const check = validateDeck(ids, (db.get(ids[0])?.faction ?? Faction.Aurites) as Faction, dbLookup);
    if (!check.ok) { dbStatus(`Импорт: ${check.problems.slice(0, 2).join('; ')}`); return; }
    const unowned = ids.filter(id => ownedCount(id) === 0);
    if (unowned.length) { dbStatus(`Импорт: не получены карты (${unowned.length}) — сначала бустеры/крафт`); return; }
    const over = new Map<string, number>();
    for (const id of ids) over.set(id, (over.get(id) ?? 0) + 1);
    const tooMany = [...over.entries()].find(([id, n]) => n > ownedCount(id));
    if (tooMany) { dbStatus(`Импорт: «${db.get(tooMany[0])?.name ?? tooMany[0]}» ×${tooMany[1]} — в коллекции только ${ownedCount(tooMany[0])}`); return; }
    editing = newEditing((db.get(ids[0])?.faction ?? Faction.Aurites) as Faction);
    for (const id of ids) editing.counts.set(id, (editing.counts.get(id) ?? 0) + 1);
    dbStatus(''); renderEditor();
  } catch { dbStatus('Некорректный код колоды'); }
});
btn('btnDbDelete').addEventListener('click', () => {
  if (!editing?.id) { dbStatus('Сохранённая колода не выбрана'); return; }
  deleteCustomDeck(editing.id);
  dbStatus(`Колода удалена из хранилища.`, true);
  editing.id = null;
  buildMenu(); renderMyDecksSel(); Sfx.uiClick();
});
function editorMatchesSavedDeck(deck: CustomDeck): boolean {
  if (!editing) return false;
  const ids = editingCards().slice().sort().join('|');
  const savedIds = deck.cards.slice().sort().join('|');
  const name = editing.name.trim() || `${FACTION_RU[editing.faction]}: моя колода`;
  const editorAvatar = editing.avatarCardId ?? suggestedDeckArt(editingCards())?.id ?? null;
  const savedAvatar = deck.avatarCardId ?? suggestedDeckArt(deck.cards)?.id ?? null;
  return ids === savedIds && editing.faction === deck.faction && name === deck.name && editorAvatar === savedAvatar;
}

btn('btnDbUse').addEventListener('click', () => {
  if (!editing?.id) { dbStatus('Сначала сохраните колоду'); return; }
  const saved = loadCustomDecks().find(deck => deck.id === editing?.id);
  if (!saved) { dbStatus('Сохранённая колода не найдена — сначала нажмите «Сохранить»'); return; }
  if (!editorMatchesSavedDeck(saved)) { dbStatus('Есть несохранённые изменения. Нажмите «Сохранить», затем запускайте бой.'); return; }
  if (launchDeckForBattle(saved.id)) showToast(`Запускаем колоду «${saved.name}»`);
});
sel('dbMyDecks').addEventListener('change', () => {
  const d = loadCustomDecks().find(x => x.id === sel('dbMyDecks').value);
  if (d) { loadIntoEditor(d); }
});
sel('dbFaction').addEventListener('change', () => {
  if (!editing) return;
  const f = sel('dbFaction').value as Faction;
  editing.faction = f;
  for (const id of [...editing.counts.keys()]) {
    const c = dbLookup(id);
    if (c && c.faction !== f && c.faction !== Faction.Neutral) editing.counts.delete(id);
  }
  dbStatus(''); renderEditor();
});
$('dbName').addEventListener('input', () => { if (editing) editing.name = ($('dbName') as HTMLInputElement).value; });
sel('dbAvatarCard').addEventListener('change', () => {
  if (!editing) return;
  editing.avatarCardId = sel('dbAvatarCard').value || null;
  renderDeckAvatarPreview();
});
btn('btnDbAvatarGallery').addEventListener('click', openEditorDeckArtPicker);
sel('dbFaction').innerHTML = FACTION_IDS.map(f => `<option value="${f}">${FACTION_RU[f]}</option>`).join('');
['dbSearch', 'dbType'].forEach(id => $(id).addEventListener(id === 'dbSearch' ? 'input' : 'change', renderPool));

/* для headless-проверок: API колод наружу */
(window as unknown as {
  __decks?: {
    list: () => CustomDeck[];
    save: (d: CustomDeck) => CustomDeck[];
    remove: (id: string) => CustomDeck[];
    validate: (cards: string[], faction: string) => ReturnType<typeof validateDeck>;
    resolve: (id: string) => DeckLike | null;
    pool: (faction: string) => { id: string; rarity: string }[];
  };
}).__decks = {
  list: loadCustomDecks,
  save: upsertCustomDeck,
  remove: deleteCustomDeck,
  validate: (cards, faction) => validateDeck(cards, faction, dbLookup),
  resolve: id => resolveDeck(id, deckList as unknown as DeckLike[]),
  pool: faction => POOL_CARDS
    .filter(c => c.faction === faction || c.faction === Faction.Neutral)
    .map(c => ({ id: c.id, rarity: c.rarity as string })),
};


/* --- правила --- */
const RULES_HTML = `
<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.6rem 0">Цель и ресурсы</h3>
<p>Снизьте здоровье героя противника с <b>30</b> до <b>0</b>. Колода — минимум <b>60</b> карт, не более <b>4</b> копий любой карты (включая легендарные); верхнего лимита и сайдборда нет. Стартовая рука — <b>5</b>,
муллиган доступен <b>один раз</b> за игру. Максимум маны растёт на 1 каждый ход (до 10) и полностью восполняется
в фазе «Ресурсы». <b>Неиспользованная мана сохраняется до вашего следующего хода</b> — оставляйте ману для <b>мгновенных заклинаний в ход противника</b> (как в MTG). Пустая колода → <b>усталость</b>: каждый добор наносит растущий урон.
На доске не более <b>7</b> существ и <b>3</b> рун у каждого игрока.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Пять фаз хода</h3>
<ol style="padding-left:1.2rem;line-height:2">
<li><b>Начало</b> — активируются руны, пассивки и триггеры существ, тикает Горение, разрешаются ритуалы.</li>
<li><b>Ресурсы</b> — +1 к максимуму маны, полное восполнение (<span style="color:#8ad0ff">избыток не сгорает — копите для мгновенных</span>), добор карты.</li>
<li><b>Основная</b> — розыгрыш ЛЮБЫХ карт. <b>Мгновенные (⚡)</b> можно играть и здесь, и вне её.</li>
<li><b>Битва</b> — <b>ручная</b>: вы объявляете атакующих стрелкой. До и после объявления атак <b>оба игрока получают приоритет для мгновенных</b>. «Пропустить бой» — закончить без атак.</li>
<li><b>Конец</b> — начисление Эхо-очка, истечение эффектов, срок жизни рун. Мгновенные ещё можно разыграть «в конец хода».</li>
</ol>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">⚡ Мгновенные заклинания — как в MTG (важно)</h3>
<p><b>Мгновенное заклинание (⚡ Мгновенное, Instant)</b> при наличии маны можно разыграть <b>в любой момент, когда у вас есть приоритет</b> — не только в свой Main:</p>
<ul style="padding-left:1.2rem;line-height:1.7;margin:.4rem 0">
<li><b>В ваш ход:</b> в основную фазу, в фазе Битвы (до/после атак), в фазе Конца.</li>
<li><b>В ход противника:</b> в его основную фазу, перед его атакой, в конце его хода — карты подсвечены <span style="display:inline-block;padding:0 .35em;border-radius:4px;background:rgba(120,220,255,.18);border:1px solid rgba(120,220,255,.35);color:#8ad0ff">⚡ instantReady</span> (голубая пульсация + ⚡ бейдж).</li>
<li><b>В ответ на заклинание:</b> любое мгновенное уходит в <b>стек LIFO</b> — последнее сыгранное разрешается первым. Противник получает окно ответа.</li>
</ul>
<p><b>Приоритет и стек (MTG):</b></p>
<ul style="padding-left:1.2rem;line-height:1.7;margin:.4rem 0">
<li>Когда вы разыгрываете мгновенное, оно попадает в <b>стек</b>. Игра ждёт <b>20 с</b> (индикатор <code>◷ 20 с</code> в правом доке) — противник может ответить своим мгновенным, которое встанет выше в стеке.</li>
<li>Если оба пасуют — стек разрешается <b>сверху вниз</b> (последний ответ срабатывает первым). Кнопка <b>«Пас»</b> в доке — вручную передать приоритет.</li>
<li>В симуляциях и при включённом <b>Авто-пас</b> (⚙ настройки) окно пропускается автоматически. В бою — ИИ отвечает эвристикой (лечит ≤14 HP, фризит 4+ атаку, добивает).</li>
<li>Мана не «сгорает» между фазами: оставьте 2–3 маны после своего Main — и в ход противника сможете «вспышкой» добить существо, вылечить героя или заморозить угрозу.</li>
</ul>
<p style="color:var(--muted);font-size:.78rem">Движок: <code>canPlay()</code> теперь <code>isInstant → instantWindow===side || instantWindow===null ? allow : wait</code>, вне окна — instant speed без проверки <code>activeSide/phase</code>. Немота/мана/цели всё ещё проверяются.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Ритуалы vs мгновенные</h3>
<p><b>◷ Ритуал</b> — заклинание с задержкой <b>1 ход</b>: цель фиксируется при розыгрыше, разрешается <b>в начале вашего следующего хода</b> (сильнее мгновенного за ту же ману, но противник видит подготовку). <b>Нельзя</b> играть в ответ, <b>не повторяется Эхом</b>, <b>не идёт в стек</b>.</p>
<p><b>⚡ Мгновенное</b> — срабатывает сразу, уходит в <b>сброс</b>, может быть <b>повторено Эхом</b>, идёт в <b>стек</b> и может быть сыграно <b>в ход противника</b>.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Бой — выбор цели</h3>
<p><b>Бить существо обязательно только если</b> у противника есть <b>Провокация</b> (Taunt) или карта прямо пишет «бьёт только существо».
Во всех остальных случаях <b>можете бить героя напрямую</b> (даже если есть существа без Провокации). Перед блоком урона оба игрока могут сыграть мгновенные (бафф, урон, лечение).</p>
<ul style="padding-left:1.2rem;line-height:1.7;margin:.4rem 0">
<li>Если есть провокатор (не под Немотой) — герой недоступен, подсвечиваются только провокаторы.</li>
<li>Если провокаторов нет — подсвечиваются все существа + герой (клик по портрету).</li>
<li>Немота отключает Провокацию.</li>
</ul>
<p style="color:var(--muted);font-size:.78rem">Готовые к атаке — золотой пульс <code>readyPulse</code> + ⚔, мгновенные — голубой <code>instantPulse</code> + ⚡.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Ключевые слова существ — 12 механик (расширено v2.12.2)</h3>
<table style="width:100%;border-collapse:collapse;font-size:.82rem;line-height:1.5">
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Провокация</b> <span style="color:#ffd87a">⛨</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Противник обязан атаковать это существо; герой недоступен пока провокатор жив. Снимается Немотой. <em>65 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Рывок</b> <span style="color:#8ad0ff">⚡</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Может атаковать в ход призыва (игнорирует «болезнь призыва»). <em>46 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Буря</b> <span style="color:#8ad0ff">🌀</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Две атаки за ход (ветер). <em>12 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Прорыв</b> <span style="color:#ff9a4a">➤</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Избыточный урон над убитым блокёром проходит в героя противника. <em>19 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Вампиризм</b> <span style="color:#ff6b6b">🩸</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Весь нанесённый боевым уроном урон лечит вашего героя. <em>45 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Неуловимость</b> <span style="color:#b0b8c8">👁</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Не может быть выбрано целью атаки существом (герой бьётся). <em>24 карты</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Божественный щит</b> <span style="color:#ffd87a">🛡</span> <span style="color:#8aff8a;font-size:.7em">NEW</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>NEW v2.12.2:</b> входит на поле со <b>Щитом (1 заряд)</b> — поглощает первое повреждение. Теряется при пробитии, не восстанавливается. <em>18 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Ядовитый</b> <span style="color:#7aff7a">☠</span> <span style="color:#8aff8a;font-size:.7em">NEW</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>NEW:</b> при успешном уроне существу накладывает <b>Яд</b> — любая следующая рана смертельна. Срабатывает даже при 1 уроне. <em>15 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Ледяное касание</b> <span style="color:#8ad0ff">❄</span> <span style="color:#8aff8a;font-size:.7em">NEW</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>NEW:</b> при успешном уроне <b>замораживает цель на 1 ход</b> — не атакует. Комбо с контролем доски. <em>15 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Боевой клич</b> <span style="color:#ffd87a">! </span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Срабатывает при входе на поле (из руки). Эффекты: урон, лечение, призыв токена, немота и т.д. <em>127 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Предсмертный хрип</b> <span style="color:#c8b8ff">✝</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Срабатывает при смерти существа: призыв, урон, добор и т.д. Отключается Немотой. <em>16 карт</em></td></tr>
<tr><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)"><b>Урон заклинаний +1</b> <span style="color:#ff8aff">✦</span></td><td style="padding:.3rem .5rem;border:1px solid rgba(255,255,255,.08)">Пассивная аура: ваши заклинания наносят на +1 больше (складывается). Элементальные бонусы учитываются. <em>13 карт</em></td></tr>
</table>
<p style="color:var(--muted);font-size:.75rem;margin-top:.45rem">Баланс: каждая новая механика стоит <code>+1 маны ≈ +1.5 силы</code> (power-модель). Божественный щит + Ядовитый/Ледяное касание подняли стоимость 48 существ на +1, проверено 10k симуляций — винрейт 47–52%.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Типы карт — описание и способности</h3>
<p><b>Существо</b> — остаётся на доске, <b>атака / здоровье</b>. Способности — ключевые слова + триггеры <code>onPlay / onTurnStart / onDeath / onSpellCast</code>. Текст в <code>ctext</code> точно повторяет эффект движка.</p>
<p><b>Заклинание — ⚡ Мгновенное</b> (101 карта): если на карте написано <b>«⚡ Мгновенное»</b> — это <b>Instant Speed</b> (как в MTG): мана → эффект сразу → в сброс → в <b>стек LIFO</b> → можно играть <b>в ход противника</b> при наличии маны. Пример: «Тлетворное касание» <b>3✦</b> (было 2✦, +1 за instant premium) — 3 урона + Яд; «Серебряная клетка» 4✦ Немота + возврат. В коллекции подсвечено голубым пульсом <code>instantReady</code>.</p>
<p><b>Заклинание — обычное</b> (если просто «Заклинание» без ⚡) — это <b>Sorcery Speed</b>: играется <b>только в вашу основную фазу</b>, не идёт в стек мгновенных. В базе это <b>◷ Ритуал (31 карта)</b> — подтип обычного с задержкой 1 ход: мана → подготовка → резолв в начале вашего следующего хода (цель фиксируется сразу, эффект сильнее за ту же ману). Пример: «Полночный реквием» 6✦ 2 урона всем + 2 карты. Обычные без задержки (если есть) — тоже только Main. Отмечены как <b>◷ Ритуал</b> или просто <b>Заклинание</b>.</p>
<p style="color:var(--muted);font-size:.78rem"><b>Баланс заклинаний v2.12.2:</b> мгновенные дороже на <code>+1 маны</code> за instant premium (8 переоценённых: aur_s11 1→2, pyr_s18 1→2 и т.д.). Ritual дешевле за мощность из-за задержки, но сильнее. Проверено симуляцией.</p>
<p><b>Руна</b> — постоянная аура на 3 слота (уникальна). Даёт <code>+атака/+здоровье, –урон герою, +мана, +добор, урон заклинаний</code> либо тик. Не уничтожается обычным уроном.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Эхо-очки</h3>
<p>Если за основную фазу вы <b>не разыграли ни одного заклинания</b>, в конце хода получаете <b>1 Эхо-очко</b>. Тратите в свой Main и <b>бесплатно</b> повторяете последнее мгновенное (ту же цель; ритуалы не повторяются). По ТЗ — <b>один раз за игру</b>.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Статусы</h3>
<p><b>Щит</b> — поглощает урон (заряд). <b>Горение</b> — урон в начале хода. <b>Яд</b> — любая рана смертельна. <b>Заморозка</b> — не атакует. <b>Немота</b> — отключает навсегда. <b>Выжигание</b> — режет лечение. <b>Порча</b> — <code>debuffHealth</code> –HP.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Пассивки фракций (баланс 45–55%)</h3>
${FACTION_IDS.map(f => `<p style="margin:.45rem 0"><b style="color:${colorOf(f).primary}">${FACTION_SIGIL[f]} ${FACTION_RU[f]}</b> — ${PASSIVE_TEXT[f]}</p>`).join('')}
<p style="color:var(--muted);font-size:.78rem;margin-top:.7rem">10 000 симуляций: 46–53% винрейт. Коэффициенты: Aur 0.87 / Nec 1.14 / Ter 1.13 / Pyr 1.28 / Eth 0.85.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Коллекция и баланс</h3>
<p>Всего <b>500</b> карт (313 существ / 101 ⚡ + 31 ◷ / 55 рун), по 30/фракцию + 70 нейтральных. 150 базы сразу, остальное — бустеры (3C+1R+1Эпик 12.5%→Лега, 20% фойл). Лимит <b>4 копии</b>. Описания cгенерированы из эффектов, стоимость — <code>power = body+kw+effects</code>.</p>

<h3 style="color:var(--gold-hi);letter-spacing:.1em;margin:.9rem 0">Управление и подсказки</h3>
<p>Карту можно <b>перетащить</b> на поле/цель или <b>кликнуть</b> — цели подсвечиваются золотом. Мгновенные — даже в ход противника (<code>instantReady</code> голубая пульсация). <b>Esc / ПКМ — отмена</b>, <b>Пробел — завершить ход / Пас в окне отклика</b>, <b>1–9 — карта из руки</b> (мгновенные работают и в чужой ход), <b>E — Эхо</b>.</p>
<p>Док <b>Стек</b> (правый низ) показывает LIFO-очередь, <b>Окно отклика</b> — 20 с круговой индикатор и кнопка «Пас». В ⚙ — Авто-пас, Веревка 75 с, предпросмотр.</p>
`;
btn('btnRules').addEventListener('click', () => { $('rulesBody').innerHTML = RULES_HTML; $('rules').classList.remove('hidden'); });
btn('btnRulesClose').addEventListener('click', () => $('rules').classList.add('hidden'));

/* --- горячие клавиши --- */
document.addEventListener('keydown', (ev: KeyboardEvent) => {
  // не перехватываем ввод в полях поиска и настроек
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;

  const inBattle = !$('battle').classList.contains('hidden');

  if (ev.key === 'Escape') {
    if (!$('deckArtPickerModal').classList.contains('hidden')) { closeDeckArtPicker(); return; }
    if (!$('cardModal').classList.contains('hidden')) { closeCardModal(); return; }
    for (const id of ['cosmPreview','journalModal','replayModal','factionModal','graveModal']) {
      const modal = document.getElementById(id);
      if (modal && !modal.classList.contains('hidden')) { modal.classList.add('hidden'); return; }
    }
    if (!$('authModal').classList.contains('hidden')) { closeAuth(); return; }
    if (!$('rules').classList.contains('hidden')) { $('rules').classList.add('hidden'); return; }
    if (!$('settingsPanel').classList.contains('hidden')) { $('settingsPanel').classList.add('hidden'); $('settingsScrim')?.classList.add('hidden'); return; }
    if (['boosterModal','profileModal','shopModal','bpModal','campaignModal','tutModal'].some(id => !$(id).classList.contains('hidden'))
        || ['collection','decksScreen','eventsScreen'].some(id => !$(id).classList.contains('hidden'))) {
      navigateApp('back');
      return;
    }
    return;
  }
  if (!$('cardModal').classList.contains('hidden')) {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); modalStep(-1); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); modalStep(1); }
    return;
  }
  if (ev.key === '?' || (ev.key === '/' && ev.shiftKey)) {
    ev.preventDefault();
    $('rulesBody').innerHTML = RULES_HTML;
    $('rules').classList.remove('hidden');
    return;
  }
  if (ev.key.toLowerCase() === 'h' || ev.key.toLowerCase() === 'р') {   // «р» = H в русской раскладке
    ev.preventDefault();
    toggleSettings();
    return;
  }
  if (!inBattle) return;

  if (ev.key === ' ' || ev.key === 'Enter') {
    ev.preventDefault();
    if (battle.inCombatWindow) battle.closeCombatWindow();
    else battle.endTurnNow();
    return;
  }
  if (ev.key.toLowerCase() === 'e' || ev.key.toLowerCase() === 'у') {   // «у» = E в русской раскладке
    battle.useEchoNow().catch(err => reportFatal('echo-key', err));
    return;
  }
  // 1–9: взять карту из руки (тот же путь, что клик мышью)
  if (/^[1-9]$/.test(ev.key)) {
    ev.preventDefault();
    battle.playHandIndex(parseInt(ev.key, 10) - 1);
  }
});

// настройки применяются сразу: звук, «лёгкие эффекты», подсказки
applySettings();

buildMenu();
// Отладочный доступ (используется headless-тестом tools/smoke_prototype.js).
(window as unknown as { __battle?: Battle }).__battle = battle;
console.log('[Эхо-Цитадель] прототип готов. Карт в базе:', db.size, '| колод:', deckList.length,
  '| passiveMul:', JSON.stringify(PASSIVE_MUL));

// объёмные объекты — первый проход после загрузки
try { window.setTimeout(()=> attachVolumetric(document.body), 600); } catch {}
