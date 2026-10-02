/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — процедурный арт карт (src/ui/art.ts)
   ---------------------------------------------------------------------
   Арт карты собирается в двух слоях:
     1. ПРОЦЕДУРНАЯ ОСНОВА (всегда) — детерминированный SVG от id карты;
     2. НАСТОЯЩИЙ PNG поверх неё, если файл уже лежит в папке фракции
        (unity/EchoCitadel/Assets/Resources/Cards/<Faction>[/<Subfamily>]/<id>.png).
        Файла нет → браузер не загрузит <image>, останется слой 1.
        То есть арты можно докладывать постепенно, ничего не пересобирая.

   Промпты — docs/art_prompts.csv и manifest.csv в папках фракций/семейств;
   размер 512×720 (ТЗ п.9).

   Вместо абстрактных «звёздочек» арт собирается из:
     1. АТМОСФЕРЫ: градиент неба, лучи света, туман (feTurbulence),
        партикл-искры фракции, виньетка, силуэт земли;
     2. МОТИВА: 17 тематических путей, выбираемых по тегам/ключевикам/стихии
        карты — tank→щит с башней, burn→пламя, heal→чаша с лучами,
        ritual→кольцо глифов, steal→рука с цепью, legend→корона и т.д.;
     3. МАТЕРИАЛА: силуэт с rim-light по краю, внутреннее свечение,
        контур «тушью» — то, что в Unity делает All In 1 Sprite Shader.

   Всё детерминировано от id карты: одинаковая карта всегда выглядит
   одинаково, разные — по-разному.
   ===================================================================== */

import { CardData, CardType, Element, Faction, Keyword, Rarity, SpellSubtype } from '../engine/types';

/* ------------------------------------------------------------------ */
/*  Палитры фракций (совпадают с FACTION_COLORS из types.ts)           */
/* ------------------------------------------------------------------ */

export interface Palette { primary: string; secondary: string; accent: string; deep: string }

export const PALETTES: Record<string, Palette> = {
  Aurites: { primary: '#f5d76e', secondary: '#fff3c4', accent: '#d8b45a', deep: '#2a2110' },
  Necrus: { primary: '#a855c9', secondary: '#d59bf0', accent: '#6b2a86', deep: '#1a0f22' },
  Terramorph: { primary: '#5aa648', secondary: '#a8d18a', accent: '#37652a', deep: '#101c0e' },
  Pyromancer: { primary: '#ff7a18', secondary: '#ffd08a', accent: '#a02a06', deep: '#22100a' },
  Ethereal: { primary: '#3fd6c8', secondary: '#c8fff8', accent: '#1b6f68', deep: '#0b1c1e' },
  Neutral: { primary: '#9aa3ad', secondary: '#dfe4ea', accent: '#5a616b', deep: '#12141a' },
};

/**
 * URL настоящего арта карты для прототипа.
 * artworkPath в Cards.json хранится как `Resources/Cards/<Faction>[/<Subfamily>]/<id>.png`
 * (карты ядра — прямо в папке фракции, семейства — во вложенных папках,
 * токены — в `_Tokens`); сервер прототипа отдаёт тот же относительный путь
 * через `/art` (tools/serve.js), Unity получает его из того же поля.
 */
export function artUrlFor(card: CardData, base = '/art'): string | null {
  const rel = card.artworkPath ?? card.art;
  if (!rel) return null;
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  const i = parts.indexOf('Cards');
  if (i < 0) return null;
  const tail = parts.slice(i + 1);
  if (tail.length < 2 || tail.some(part => part === '.' || part === '..')) return null;
  return `${base}/${tail.map(encodeURIComponent).join('/')}`;
}

/** Редкость → цвет рамки/фойла (совпадает с RARITY_COLORS). */
export const RARITY_ART: Record<string, { color: string; label: string }> = {
  Common: { color: '#cfd6dd', label: 'Обычная' },
  Rare: { color: '#4f9fe0', label: 'Редкая' },
  Epic: { color: '#b06cf0', label: 'Эпическая' },
  Legendary: { color: '#f5a623', label: 'Легендарная' },
};

export function paletteOf(faction: string): Palette {
  return PALETTES[faction in PALETTES ? faction : Faction.Neutral];
}

/* ------------------------------------------------------------------ */
/*  Детерминированный ГСЧ от id карты                                  */
/* ------------------------------------------------------------------ */

function hasher(str: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return (h >>> 8) / 16777216; };
}

/* ------------------------------------------------------------------ */
/*  Мотивы: 17 тематических путей в системе координат 0..100           */
/* ------------------------------------------------------------------ */

export type MotifId =
  | 'shield' | 'flame' | 'beast' | 'wings' | 'skull' | 'chalice' | 'eye' | 'spiral'
  | 'hand' | 'crystal' | 'blade' | 'runeCircle' | 'thorn' | 'golem' | 'crown'
  | 'bolt' | 'banner';

interface MotifDef { fill: string; stroke: string; extra?: string }

const MOTIFS: Record<MotifId, MotifDef> = {
  // Щит с башней — танки и Провокация
  shield: {
    fill: 'M50 12 L84 26 V56 C84 78 68 90 50 96 C32 90 16 78 16 56 V26 Z',
    stroke: 'M50 22 V88 M26 36 H74 M30 58 H70',
    extra: '<path d="M50 30 L60 42 V60 L50 70 L40 60 V42 Z" fill="none" stroke-width="1.6"/>',
  },
  // Пламя — burn, Огонь, Пироманты
  flame: {
    fill: 'M50 6 C64 28 84 36 84 58 A34 34 0 0 1 16 58 C16 36 36 28 50 6 Z',
    stroke: 'M50 30 C58 44 68 50 66 62 A17 17 0 0 1 34 62 C32 50 42 44 50 30 Z',
    extra: '<circle cx="50" cy="64" r="7" fill="none" stroke-width="1.4"/>',
  },
  // Зверь с рогами — aggro, brute
  beast: {
    fill: 'M20 34 L34 12 L42 30 L58 30 L66 12 L80 34 L72 52 L80 74 L62 66 L50 86 L38 66 L20 74 L28 52 Z',
    stroke: 'M38 46 L44 52 M62 46 L56 52 M44 64 H56',
    extra: '<circle cx="40" cy="42" r="3.2"/><circle cx="60" cy="42" r="3.2"/>',
  },
  // Крылья — evasion, Air, Неуловимость
  wings: {
    fill: 'M50 26 C36 12 14 14 6 30 C18 30 24 38 30 52 C36 40 42 32 50 30 C58 32 64 40 70 52 C76 38 82 30 94 30 C86 14 64 12 50 26 Z',
    stroke: 'M50 32 V84 M22 40 L30 54 M78 40 L70 54',
    extra: '<path d="M42 60 L50 74 L58 60" fill="none" stroke-width="1.5"/>',
  },
  // Череп — deathrattle, drain, Некрусы
  skull: {
    fill: 'M50 10 C72 10 84 28 84 46 C84 60 76 66 70 70 L68 88 H32 L30 70 C24 66 16 60 16 46 C16 28 28 10 50 10 Z',
    stroke: 'M42 76 H58',
    extra: '<ellipse cx="36" cy="44" rx="9" ry="11"/><ellipse cx="64" cy="44" rx="9" ry="11"/>' +
      '<path d="M50 56 L44 68 H56 Z"/>',
  },
  // Чаша с лучами — heal, protection
  chalice: {
    fill: 'M26 26 H74 L66 54 C62 68 56 72 54 82 H62 V90 H38 V82 H46 C44 72 38 68 34 54 Z',
    stroke: 'M50 6 V20 M30 12 L40 24 M70 12 L60 24',
    extra: '<circle cx="50" cy="44" r="9" fill="none" stroke-width="1.5"/>',
  },
  // Око в тумане — control, steal, illusion
  eye: {
    fill: 'M6 50 C24 22 76 22 94 50 C76 78 24 78 6 50 Z',
    stroke: 'M14 34 C30 26 70 26 86 34',
    extra: '<circle cx="50" cy="50" r="17" fill="none" stroke-width="2"/>' +
      '<circle cx="50" cy="50" r="7"/>',
  },
  // Спираль — spellpower, Chaos, echo
  spiral: {
    fill: 'M50 50 C50 38 62 34 68 44 C76 56 64 74 48 70 C30 66 22 44 34 30 C48 14 78 20 86 42',
    stroke: 'M50 50 C50 44 56 42 60 46',
    extra: '<circle cx="50" cy="50" r="3.4"/><circle cx="50" cy="50" r="30" fill="none" stroke-width=".7" stroke-dasharray="3 4"/>',
  },
  // Рука с цепью — steal
  hand: {
    fill: 'M34 92 V58 L28 40 L36 36 L40 50 V22 H48 V46 H52 V18 H60 V46 H64 V26 H72 V56 L78 68 V92 Z',
    stroke: 'M40 66 H72',
    extra: '<circle cx="24" cy="26" r="6" fill="none" stroke-width="1.6"/>' +
      '<circle cx="16" cy="14" r="5" fill="none" stroke-width="1.4"/>',
  },
  // Кристалл — mana, tempo
  crystal: {
    fill: 'M50 6 L82 34 L64 94 H36 L18 34 Z',
    stroke: 'M50 6 V94 M18 34 H82 M36 94 L50 40 L64 94',
    extra: '<path d="M50 22 L64 36 L50 60 L36 36 Z" fill="none" stroke-width="1.3"/>',
  },
  // Меч — removal, aggro, оружие
  blade: {
    fill: 'M46 4 H54 L58 20 V62 L50 76 L42 62 V20 Z',
    stroke: 'M50 8 V70',
    extra: '<path d="M26 62 H74 L68 72 H32 Z"/><path d="M46 74 H54 V94 H46 Z"/>',
  },
  // Кольцо глифов — ritual, rune
  runeCircle: {
    fill: 'M50 6 A44 44 0 1 1 49.9 6 Z M50 18 A32 32 0 1 0 50.1 18 Z',
    stroke: 'M50 6 V18 M94 50 H82 M50 94 V82 M6 50 H18',
    extra: '<path d="M50 26 L58 44 L78 50 L58 56 L50 74 L42 56 L22 50 L42 44 Z" fill="none" stroke-width="1.3"/>' +
      '<circle cx="50" cy="50" r="7"/>',
  },
  // Шипы и лоза — poison, Earth, Терраморфы
  thorn: {
    fill: 'M12 90 C28 68 40 60 52 40 C60 26 72 16 88 10 C80 26 76 40 66 52 C54 66 40 76 26 92 Z',
    stroke: 'M30 72 L22 60 M44 58 L38 44 M58 42 L54 28 M70 28 L70 16',
    extra: '<path d="M20 84 C34 80 44 84 52 92" fill="none" stroke-width="1.4"/>',
  },
  // Голем — Earth, vanilla-тело
  golem: {
    fill: 'M28 34 H72 L80 56 L68 60 V92 H32 V60 L20 56 Z',
    stroke: 'M32 46 H68 M50 34 V92',
    extra: '<rect x="38" y="52" width="10" height="8"/><rect x="52" y="52" width="10" height="8"/>' +
      '<path d="M36 70 H64" stroke-width="2"/>',
  },
  // Корона — legendary
  crown: {
    fill: 'M14 74 L20 30 L36 52 L50 20 L64 52 L80 30 L86 74 Z',
    stroke: 'M14 82 H86',
    extra: '<circle cx="50" cy="14" r="5"/><circle cx="20" cy="24" r="4"/><circle cx="80" cy="24" r="4"/>' +
      '<path d="M22 66 H78" stroke-width="1.6"/>',
  },
  // Молния — rush, tempo, Air
  bolt: {
    fill: 'M58 4 L26 54 H46 L38 96 L74 42 H52 Z',
    stroke: 'M52 24 L40 46',
    extra: '<path d="M20 30 L10 44 M84 26 L94 40" fill="none" stroke-width="1.4"/>',
  },
  // Знамя — vanilla, Neutral
  banner: {
    fill: 'M28 8 H72 V64 L50 78 L28 64 Z',
    stroke: 'M50 8 V78 M28 24 H72',
    extra: '<path d="M40 36 L50 48 L60 36" fill="none" stroke-width="1.6"/>' +
      '<circle cx="50" cy="52" r="6" fill="none" stroke-width="1.4"/>',
  },
};

/** Порядок приоритета тегов при выборе мотива. */
const TAG_TO_MOTIF: [string, MotifId][] = [
  ['legend', 'crown'], ['ritual', 'runeCircle'], ['antiheal', 'flame'], ['poison', 'thorn'],
  ['steal', 'hand'], ['drain', 'skull'], ['heal', 'chalice'], ['protection', 'shield'],
  ['mana', 'crystal'], ['removal', 'blade'], ['spellpower', 'spiral'], ['echo', 'spiral'],
  ['evasion', 'wings'], ['tempo', 'bolt'], ['burn', 'flame'], ['control', 'eye'],
  ['tank', 'shield'], ['brute', 'beast'], ['aggro', 'beast'], ['tokens', 'banner'],
  ['buff', 'banner'], ['debuff', 'eye'], ['aoe', 'runeCircle'], ['card', 'chalice'],
  ['vanilla', 'banner'],
];

const KEYWORD_TO_MOTIF: [Keyword, MotifId][] = [
  [Keyword.Taunt, 'shield'], [Keyword.Unblockable, 'wings'], [Keyword.Lifesteal, 'skull'],
  [Keyword.Deathrattle, 'skull'], [Keyword.Rush, 'bolt'], [Keyword.Windfury, 'wings'],
  [Keyword.Trample, 'beast'], [Keyword.SpellDamage, 'spiral'],
];

const ELEMENT_TO_MOTIF: Record<string, MotifId> = {
  Fire: 'flame', Water: 'chalice', Earth: 'golem', Air: 'wings', Chaos: 'spiral', None: 'banner',
};

/** Выбираем мотив карты: теги → ключевики → стихия → тип. */
export function motifOf(card: CardData): MotifId {
  const tags = (card.tags ?? []) as string[];
  for (const [tag, motif] of TAG_TO_MOTIF) if (tags.includes(tag)) return motif;
  for (const [kw, motif] of KEYWORD_TO_MOTIF) if ((card.keywords ?? []).includes(kw)) return motif;
  const byElem = ELEMENT_TO_MOTIF[card.element as string];
  if (byElem && card.element !== Element.None) return byElem;
  if (card.type === CardType.Rune) return 'runeCircle';
  if (card.type === CardType.Spell && card.subtype === SpellSubtype.Ritual) return 'runeCircle';
  if (card.type === CardType.Spell) return 'spiral';
  return (card.cost ?? 0) >= 6 ? 'crown' : 'banner';
}

/* ------------------------------------------------------------------ */
/*  Сборка SVG                                                         */
/* ------------------------------------------------------------------ */

/**
 * Арт карты.
 * @param card  данные карты
 * @param w,h   размер вывода в px (viewBox всегда 100×100, slice)
 * @param opts  variant: 'board' — меньше мелких деталей (читается в 78 px)
 */
export function cardArt(card: CardData, w: number, h: number,
  opts: { variant?: 'full' | 'board'; realArt?: boolean; artBase?: string } = {}): string {
  const p = paletteOf(card.faction);
  const rnd = hasher(card.id);
  const motif = MOTIFS[motifOf(card)];
  const uid = card.id.replace(/[^a-zA-Z0-9]/g, '');
  const board = opts.variant === 'board';
  const leg = card.rarity === Rarity.Legendary;

  // детерминированные параметры композиции
  const cx = 50 + (rnd() - 0.5) * 6;
  const cy = 52 + (rnd() - 0.5) * 5;
  const rot = (rnd() - 0.5) * 10;
  const scale = 0.94 + rnd() * 0.14;
  const rayAngle = 8 + rnd() * 16;
  const fogY = 58 + rnd() * 14;
  const fogSeed = Math.floor(rnd() * 90) + 1;

  // искры/частицы фракции
  const sparks: string[] = [];
  const sparkCount = board ? 5 : 11;
  for (let i = 0; i < sparkCount; i++) {
    const sx = (rnd() * 100).toFixed(1);
    const sy = (rnd() * 92).toFixed(1);
    const sr = (rnd() * (board ? 1.5 : 1.9) + 0.4).toFixed(2);
    const so = (rnd() * 0.55 + 0.2).toFixed(2);
    sparks.push(`<circle cx="${sx}" cy="${sy}" r="${sr}" fill="${p.secondary}" opacity="${so}"/>`);
  }

  // лучи света из-за мотива
  const rays: string[] = [];
  if (!board) {
    for (let i = -2; i <= 2; i++) {
      const a = i * rayAngle;
      rays.push(`<path d="M${cx} ${cy - 6} L${cx + Math.sin((a - 3) * Math.PI / 180) * 90} ${cy - 96}
        L${cx + Math.sin((a + 3) * Math.PI / 180) * 90} ${cy - 96} Z" fill="${p.secondary}" opacity=".055"/>`);
    }
  }

  const defs = `
  <radialGradient id="sky${uid}" cx="${cx}%" cy="${(cy - 16)}%" r="86%">
    <stop offset="0%" stop-color="${p.secondary}" stop-opacity=".78"/>
    <stop offset="26%" stop-color="${p.primary}" stop-opacity=".52"/>
    <stop offset="62%" stop-color="${p.accent}" stop-opacity=".28"/>
    <stop offset="100%" stop-color="${p.deep}" stop-opacity=".94"/>
  </radialGradient>
  <linearGradient id="grd${uid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#04050a" stop-opacity=".66"/>
  </linearGradient>
  <radialGradient id="halo${uid}" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="${p.secondary}" stop-opacity=".5"/>
    <stop offset="55%" stop-color="${p.primary}" stop-opacity=".16"/>
    <stop offset="100%" stop-color="${p.primary}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="rim${uid}" x1="0.2" y1="0" x2="0.8" y2="1">
    <stop offset="0%" stop-color="${p.secondary}" stop-opacity=".95"/>
    <stop offset="48%" stop-color="${p.primary}" stop-opacity=".45"/>
    <stop offset="100%" stop-color="${p.accent}" stop-opacity=".18"/>
  </linearGradient>
  <filter id="fog${uid}" x="-20%" y="-40%" width="140%" height="180%">
    <feTurbulence type="fractalNoise" baseFrequency="0.014 0.055" numOctaves="3" seed="${fogSeed}" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.72  0 0 0 0 0.74  0 0 0 0 0.82  0 0 0 .85 0" result="c"/>
    <feComposite in="c" in2="SourceGraphic" operator="in"/>
    <feGaussianBlur stdDeviation="2.4"/>
  </filter>
  <filter id="soft${uid}" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="${board ? 1.1 : 1.7}"/>
  </filter>
  <clipPath id="clip${uid}"><rect x="0" y="0" width="100" height="100" rx="${board ? 0 : 2}"/></clipPath>`;

  const ground = `<path d="M0 ${fogY + 16} C${18 + rnd() * 10} ${fogY + 4}, ${44} ${fogY + 20}, ${62} ${fogY + 8}
    C${78} ${fogY}, ${90} ${fogY + 14}, 100 ${fogY + 6} V100 H0 Z" fill="${p.deep}" opacity=".95"/>`;

  const motifGroup = `
  <g transform="translate(${cx} ${cy}) rotate(${rot.toFixed(2)}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})">
    <g transform="translate(${cx} ${cy}) scale(0.86) translate(${-cx} ${-cy})">
      <circle cx="${cx}" cy="${cy}" r="30" fill="url(#halo${uid})"/>
      <path d="${motif.fill}" fill="#05060b" opacity=".93"/>
      <path d="${motif.fill}" fill="${p.primary}" opacity="${leg ? 0.2 : 0.13}"/>
      <path d="${motif.fill}" fill="none" stroke="url(#rim${uid})" stroke-width="${board ? 1.9 : 1.5}" stroke-linejoin="round"/>
      <g fill="none" stroke="${p.secondary}" stroke-width="${board ? 1.3 : 1}" opacity=".62" stroke-linecap="round">
        <path d="${motif.stroke}"/>
      </g>
      <g fill="${p.secondary}" stroke="none" opacity=".5">${motif.extra ?? ''}</g>
      <g fill="none" stroke="${p.secondary}" stroke-width="1" opacity=".5">${motif.extra ?? ''}</g>
    </g>
  </g>`;

  // Настоящий PNG поверх процедурной основы: если файла ещё нет,
  // <image> просто не отрисуется и останется заглушка (без миганий и ошибок).
  const realUrl = opts.realArt === false ? null : artUrlFor(card, opts.artBase ?? '/art');
  const realArt = realUrl ? `
  <image href="${realUrl}" xlink:href="${realUrl}" x="0" y="0" width="100" height="100"
         preserveAspectRatio="xMidYMid slice"/>` : '';

  const frame = board ? '' : `
  <rect x="1.2" y="1.2" width="97.6" height="97.6" rx="2" fill="none" stroke="${p.accent}" stroke-width=".9" opacity=".55"/>
  <rect x="4" y="4" width="92" height="92" rx="1" fill="none" stroke="${p.primary}" stroke-width=".35" opacity=".3"/>
  ${leg ? `<g opacity=".8" fill="none" stroke="${p.secondary}" stroke-width="1">
      <path d="M4 14 V4 H14"/><path d="M86 4 H96 V14"/><path d="M96 86 V96 H86"/><path d="M14 96 H4 V86"/></g>` : ''}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" width="${w}" height="${h}">
<defs>${defs}</defs>
<g clip-path="url(#clip${uid})">
  <rect width="100" height="100" fill="${p.deep}"/>
  <rect width="100" height="100" fill="url(#sky${uid})"/>
  <g opacity=".9">${rays.join('')}</g>
  ${ground}
  <g opacity="${board ? 0.5 : 0.65}">${sparks.join('')}</g>
  <g filter="url(#fog${uid})" opacity="${board ? 0.3 : 0.42}">
    <rect x="-10" y="${fogY - 8}" width="120" height="${100 - fogY + 18}" fill="#c8cede"/>
  </g>
  ${motifGroup}
  ${realArt}
  <rect width="100" height="100" fill="url(#grd${uid})"/>
  <rect width="100" height="100" fill="none"/>
  ${frame}
</g>
</svg>`;
}

/* ------------------------------------------------------------------ */
/*  Герой/портрет фракции и фон стола                                  */
/* ------------------------------------------------------------------ */

/** Портрет героя для панели (ТЗ п.4.1). */
export function heroArt(faction: string, w = 320, h = 180): string {
  const p = paletteOf(faction);
  const motif = MOTIFS[faction === 'Aurites' ? 'crown' : faction === 'Necrus' ? 'skull'
    : faction === 'Terramorph' ? 'golem' : faction === 'Pyromancer' ? 'flame'
      : faction === 'Ethereal' ? 'wings' : 'banner'];
  const uid = 'hero' + faction;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" width="${w}" height="${h}">
<defs>
  <radialGradient id="${uid}g" cx="50%" cy="42%" r="76%">
    <stop offset="0%" stop-color="${p.primary}" stop-opacity=".6"/>
    <stop offset="52%" stop-color="${p.accent}" stop-opacity=".2"/>
    <stop offset="100%" stop-color="${p.deep}" stop-opacity=".1"/>
  </radialGradient>
  <linearGradient id="${uid}r" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${p.secondary}" stop-opacity=".9"/>
    <stop offset="100%" stop-color="${p.primary}" stop-opacity=".35"/>
  </linearGradient>
</defs>
<rect width="200" height="120" fill="url(#${uid}g)"/>
<g transform="translate(100 62) scale(1.06) translate(-50 -50)" opacity=".62">
  <path d="${motif.fill}" fill="#05060b" opacity=".85"/>
  <path d="${motif.fill}" fill="${p.primary}" opacity=".14"/>
  <path d="${motif.fill}" fill="none" stroke="url(#${uid}r)" stroke-width="1.5" stroke-linejoin="round"/>
</g>
<g stroke="${p.accent}" stroke-width=".5" opacity=".45" fill="none">
  <path d="M0 104 H200"/><path d="M0 110 H200"/>
</g>
</svg>`;
}

/**
 * Фон игрового стола: слои для параллакса (ТЗ «сцена вместо пустоты»).
 * Возвращает 4 SVG-слоя от дальнего к ближнему.
 */
export function tableBackdrop(faction: string): string[] {
  const p = paletteOf(faction);
  const uid = 'bg' + faction;
  const far = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<defs><radialGradient id="${uid}sky" cx="50%" cy="18%" r="82%">
  <stop offset="0%" stop-color="${p.accent}" stop-opacity=".5"/>
  <stop offset="48%" stop-color="#2a3564" stop-opacity=".85"/>
  <stop offset="100%" stop-color="#161f42" stop-opacity="1"/></radialGradient></defs>
<rect width="1600" height="900" fill="url(#${uid}sky)"/>
<g fill="${p.secondary}" opacity=".28">
  ${Array.from({ length: 60 }, (_, i) => {
    const x = ((i * 137) % 1600), y = ((i * 71) % 420);
    const r = ((i % 5) * 0.4 + 0.5).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  }).join('')}
</g></svg>`;

  const citadel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<g fill="#232e5c" opacity=".8">
  <path d="M520 470 L560 300 L600 470 Z"/>
  <path d="M590 470 L640 240 L690 470 Z"/>
  <path d="M680 470 L760 180 L840 470 Z"/>
  <path d="M830 470 L890 250 L950 470 Z"/>
  <path d="M940 470 L990 320 L1040 470 Z"/>
  <rect x="500" y="460" width="560" height="70"/>
  <path d="M470 530 H1090 V560 H470 Z"/>
</g>
<g fill="${p.primary}" opacity=".5">
  ${[560, 640, 760, 890, 990].map((x, i) => `<rect x="${x - 3}" y="${250 + i * 14}" width="6" height="16" rx="3"/>`).join('')}
</g></svg>`;

  const pillars = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<g fill="#1c2650" opacity=".85">
  <rect x="60" y="120" width="86" height="780"/><rect x="40" y="120" width="126" height="26"/>
  <rect x="1454" y="120" width="86" height="780"/><rect x="1434" y="120" width="126" height="26"/>
  <rect x="250" y="240" width="52" height="660" opacity=".8"/>
  <rect x="1298" y="240" width="52" height="660" opacity=".8"/>
</g>
<g fill="${p.primary}" opacity=".3">
  <rect x="96" y="200" width="14" height="620"/><rect x="1490" y="200" width="14" height="620"/>
</g></svg>`;

  const dust = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<defs><filter id="${uid}f"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.02" numOctaves="3" seed="11"/>
<feColorMatrix type="matrix" values="0 0 0 0 0.62  0 0 0 0 0.64  0 0 0 0 0.72  0 0 0 .5 0"/>
<feGaussianBlur stdDeviation="9"/></filter></defs>
<rect width="1600" height="900" filter="url(#${uid}f)" opacity=".16"/>
</svg>`;

  return [far, citadel, pillars, dust];
}

/** Текстура камня для поверхности стола (PBR-подобная имитация). */
export function tableSurface(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" preserveAspectRatio="none">
<defs>
  <filter id="tblStone" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.035 0.06" numOctaves="5" seed="4" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.30  0 0 0 0 0.33  0 0 0 0 0.45  0 0 0 .9 0" result="c"/>
    <feComposite in="c" in2="SourceGraphic" operator="in"/>
  </filter>
  <linearGradient id="tblLight" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#d8b45a" stop-opacity=".18"/>
    <stop offset="42%" stop-color="#ffffff" stop-opacity=".06"/>
    <stop offset="100%" stop-color="#000000" stop-opacity=".12"/>
  </linearGradient>
</defs>
<rect width="800" height="500" fill="#3a4463"/>
<rect width="800" height="500" filter="url(#tblStone)" opacity=".42"/>
<rect width="800" height="500" fill="url(#tblLight)"/>
<radialGradient id="tblCenter" cx="50%" cy="46%" r="62%">
  <stop offset="0%" stop-color="#ffffff" stop-opacity=".12"/>
  <stop offset="70%" stop-color="#ffffff" stop-opacity="0"/>
</radialGradient>
<rect width="800" height="500" fill="url(#tblCenter)"/>
<g fill="none" stroke="#d8b45a" stroke-width="1.2" opacity=".48">
  <rect x="14" y="12" width="772" height="476" rx="6"/>
  <rect x="26" y="24" width="748" height="452" rx="4" stroke-width=".6" opacity=".7"/>
</g>
</svg>`;
}

export const Art = { cardArt, heroArt, tableBackdrop, tableSurface, motifOf, paletteOf, artUrlFor, PALETTES, RARITY_ART };
export default Art;
