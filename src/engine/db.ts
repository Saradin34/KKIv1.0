/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — загрузка базы карт (Cards.json) и колод (Decks.json).
   В Unity этот же контракт реализует CardFactory + DataLoader (C#).
   ===================================================================== */

import { CardData, CardEffect, Faction } from './types';

export interface CardsFile {
  meta: {
    game: string; version: string; totalCards: number;
    distribution: Record<string, Record<string, number>>;
    [k: string]: any;
  };
  cards: CardData[];
  tokens: CardData[];
}

export interface DeckFile {
  meta: { deckSize: number; copyLimit: number; legendaryCopyLimit: number };
  decks: { id: string; name: string; faction: string; cards: string[]; format?: string }[];
}

export function buildDatabase(file: CardsFile): { db: Map<string, CardData>; tokens: Map<string, CardData> } {
  const db = new Map<string, CardData>();
  const tokens = new Map<string, CardData>();
  for (const c of file.cards ?? []) normalizeAndSet(db, c);
  for (const t of file.tokens ?? []) normalizeAndSet(tokens, t);
  return { db, tokens };
}

function normalizeAndSet(map: Map<string, CardData>, c: CardData): void {
  c.keywords = c.keywords ?? [];
  c.effects = c.effects ?? [];
  c.element = c.element ?? ('None' as any);
  c.target = c.target ?? ('None' as any);
  c.tags = c.tags ?? [];
  if (c.keywords.includes('Deathrattle' as any) && !(c.onDeath && c.onDeath.length)) {
    const od = deathrattleFromText(c);
    if (od.length) c.onDeath = od;
  }
  map.set(c.id, c);
}

/** Проверка целостности: минимум 30 карт, без максимума, известные id и playset ×4. */
export function validateDeck(deck: string[], db: Map<string, CardData>, minSize = 30): string[] {
  const errs: string[] = [];
  if (deck.length < minSize) errs.push(`Размер колоды ${deck.length}, минимум ${minSize}`);
  const counts = new Map<string, number>();
  for (const id of deck) {
    const c = db.get(id);
    if (!c) { errs.push(`Неизвестная карта: ${id}`); continue; }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    const limit = 4;
    if (n > limit) errs.push(`Превышен лимит копий ${id}: ${n} > ${limit}`);
  }
  return errs;
}

export function factionOf(deck: string[], db: Map<string, CardData>): Faction {
  const tally = new Map<Faction, number>();
  for (const id of deck) {
    const c = db.get(id);
    if (!c || c.faction === Faction.Neutral) continue;
    tally.set(c.faction, (tally.get(c.faction) ?? 0) + 1);
  }
  let best = Faction.Neutral, n = -1;
  for (const [f, v] of tally) if (v > n) { best = f; n = v; }
  return best;
}

/* v3.6: «Предсмертный хрип» в Cards.json описан только текстом (effects пустые) — эффект не срабатывал.
   Восстанавливаем onDeath из текста карты (формулировки генератора). */
function tokenOf(src: CardData, name: string, atk: number, hp: number): CardData {
  const slug = name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '_');
  return {
    id: `tkn_${slug}_${atk}_${hp}`, name, faction: src.faction, type: 'Creature', rarity: 'Common', cost: 1,
    attack: atk, health: hp, element: src.element, keywords: [], target: 'None', effects: [],
    abilityText: 'Токен', flavor: '', isToken: true, tags: ['token'],
  } as unknown as CardData;
}
export function deathrattleFromText(c: CardData): CardEffect[] {
  const txt = String(c.abilityText ?? '');
  const m = /Предсмертный хрип:\s*([^]*?)(?:\.\s|\.$|$)/i.exec(txt);
  if (!m) return [];
  const t = m[1];
  const out: CardEffect[] = [];
  const sum = /[Пп]ризовите «([^»]+)» (\d+)\/(\d+)/g;
  let sm: RegExpExecArray | null;
  while ((sm = sum.exec(t))) out.push({ op: 'summonToken', token: tokenOf(c, sm[1], +sm[2], +sm[3]) } as unknown as CardEffect);
  let x: RegExpExecArray | null;
  if ((x = /Возьмите (\d+) карт/i.exec(t))) out.push({ op: 'draw', value: +x[1] });
  if ((x = /Нанесите (\d+) урона всем вражеским существам/i.exec(t))) out.push({ op: 'damageAllEnemyCreatures', value: +x[1] });
  if ((x = /Восстановите (\d+) здоровья/i.exec(t))) out.push({ op: 'heal', value: +x[1], to: 'FriendlyHero' as any });
  if ((x = /все ваши существа получают \+(\d+)\/\+(\d+)/i.exec(t))) {
    out.push({ op: 'buffAttack', value: +x[1], to: 'AllFriendlies' as any }, { op: 'buffHealth', value: +x[2], to: 'AllFriendlies' as any });
  }
  if (/Яд на случайное существо противника/i.test(t)) {
    out.push({ op: 'applyStatus', status: 'Poison' as any, value: -1, statusValue: 1, to: 'EnemyCreature' as any, filter: { random: true, count: 1 } });
  }
  if ((x = /все существа противника получают -(\d+) здоровья/i.exec(t))) out.push({ op: 'debuffHealth', value: +x[1], to: 'AllEnemies' as any });
  return out;
}
