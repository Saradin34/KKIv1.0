/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — загрузка базы карт (Cards.json) и колод (Decks.json).
   В Unity этот же контракт реализует CardFactory + DataLoader (C#).
   ===================================================================== */

import { CardData, Faction } from './types';

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
  map.set(c.id, c);
}

/** Проверка целостности: минимум 60 карт, без максимума, известные id и playset ×4. */
export function validateDeck(deck: string[], db: Map<string, CardData>, minSize = 60): string[] {
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
