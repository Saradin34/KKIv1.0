/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — хранилище пользовательских колод (конструктор колод)
   ---------------------------------------------------------------------
   Колоды игрока, собранные в конструкторе, живут в localStorage браузера
   (ключ echo-citadel.decks.v1) и доступны прототипу наравне со встроенными
   колодами из Decks.json: меню «Колода», бой, список «Мои колоды».

   Правила сборки (MTG Constructed):
     • минимум 60 карт, верхнего лимита нет;
     • не более 4 копий любой карты, включая легендарные;
     • карта может быть своей фракции или нейтральной.

   Единая точка проверки — validateDeck(): её же вызывает конструктор
   перед сохранением, поэтому «кривую» колоду собрать не даст UI.
   ===================================================================== */

import { CardData, CardType, Rarity } from '../engine/types';

export interface DeckLike {
  id: string;
  name: string;
  faction: string;
  cards: string[];
  /** У встроенных преконструктов `starter` разрешён отдельный учебный формат на 30 карт. */
  format?: string;
  /** ID карты из колоды, чьё существующее изображение используется как обложка. */
  avatarCardId?: string;
}

export interface CustomDeck extends DeckLike {
  /** время последнего сохранения, мс */
  updated: number;
}

export const MIN_DECK_SIZE = 60;
/** @deprecated Используйте MIN_DECK_SIZE: верхнего лимита колоды нет. */
export const DECK_SIZE = MIN_DECK_SIZE;
export const MAX_COPIES = 4;   // MTG playset: максимум 4 копии карты в колоде
export const MAX_LEGENDARY_COPIES = 4; // легендарные также подчиняются playset ×4

const KEY = 'echo-citadel.decks.v1';

/* --------------------------------------------------------------------- */
/* Чтение/запись                                                          */
/* --------------------------------------------------------------------- */

export function loadCustomDecks(): CustomDeck[] {
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is CustomDeck =>
      !!d && typeof d === 'object' && typeof (d as CustomDeck).id === 'string'
      && Array.isArray((d as CustomDeck).cards));
  } catch { return []; }
}

export function saveCustomDecks(list: CustomDeck[]): void {
  try { window.localStorage?.setItem(KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}

export function upsertCustomDeck(deck: CustomDeck): CustomDeck[] {
  const list = loadCustomDecks().filter(d => d.id !== deck.id);
  list.push(deck);
  list.sort((a, b) => a.updated - b.updated);
  saveCustomDecks(list);
  return list;
}

export function deleteCustomDeck(id: string): CustomDeck[] {
  const list = loadCustomDecks().filter(d => d.id !== id);
  saveCustomDecks(list);
  return list;
}

/** Колода по id: сначала встроенные (Decks.json), затем пользовательские. */
export function resolveDeck(id: string, builtins: DeckLike[]): DeckLike | null {
  const b = builtins.find(d => d.id === id);
  if (b) return b;
  return loadCustomDecks().find(d => d.id === id) ?? null;
}

/* --------------------------------------------------------------------- */
/* Валидация MTG Constructed                                              */
/* --------------------------------------------------------------------- */

export interface DeckProblems {
  ok: boolean;
  problems: string[];
  total: number;
}

export function validateDeck(
  cards: string[],
  faction: string,
  lookup: (id: string) => CardData | undefined,
): DeckProblems {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);

  if (cards.length < MIN_DECK_SIZE) {
    problems.push(`нужно минимум ${MIN_DECK_SIZE} карт, сейчас ${cards.length}`);
  }
  for (const [id, n] of counts) {
    const card = lookup(id);
    if (!card) { problems.push(`неизвестная карта ${id}`); continue; }
    if (card.faction !== faction && card.faction !== 'Neutral') {
      problems.push(`«${card.name}» — чужая фракция (${card.faction})`);
    }
    const cap = card.rarity === Rarity.Legendary ? MAX_LEGENDARY_COPIES : MAX_COPIES;
    if (n > cap) {
      problems.push(`«${card.name}»: копий ${n}, максимум ${cap}`);
    }
  }
  return { ok: problems.length === 0, problems, total: cards.length };
}

/** Базовая валидность колоды для гейта «В бой»: по умолчанию Constructed — минимум
 *  MIN_DECK_SIZE (60), без верхнего лимита, не более 4 копий любой карты.
 *  Только встроенный формат `starter` явно передаёт 30; пользовательские колоды всегда
 *  идут через validateDeck() и остаются минимум 60 карт. */
export function validateDeckSize(
  cards: string[],
  lookup: (id: string) => CardData | undefined,
  minSize = MIN_DECK_SIZE,
): DeckProblems {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);

  if (cards.length < minSize) {
    problems.push(`нужно минимум ${minSize} карт, сейчас ${cards.length}`);
  }
  for (const [id, n] of counts) {
    const card = lookup(id);
    if (!card) { problems.push(`неизвестная карта ${id}`); continue; }
    const cap = card.rarity === Rarity.Legendary ? MAX_LEGENDARY_COPIES : MAX_COPIES;
    if (n > cap) {
      problems.push(`«${card.name}»: копий ${n}, максимум ${cap}`);
    }
  }
  return { ok: problems.length === 0, problems, total: cards.length };
}

/** Краткая сводка колоды для списков: существа/заклинания/руны и средняя мана. */
export function deckSummary(cards: string[], lookup: (id: string) => CardData | undefined):
{ creatures: number; spells: number; runes: number; avgCost: number } {
  let cr = 0, sp = 0, ru = 0, sum = 0, n = 0;
  for (const id of cards) {
    const c = lookup(id);
    if (!c) continue;
    if (c.type === CardType.Creature) cr++;
    else if (c.type === CardType.Spell) sp++;
    else ru++;
    sum += c.cost; n++;
  }
  return { creatures: cr, spells: sp, runes: ru, avgCost: n ? Math.round((sum / n) * 10) / 10 : 0 };
}
