import { Faction } from '../engine/types';

/** Визуальные герои колод — отдельная коллекция, не связанная с профильными аватарами. */
export type DeckHeroTier = 'standard' | 'coin' | 'donation';

export interface DeckHeroDefinition {
  /** Стабильный ID совпадает с именем папки art_raw/deck_heroes/<id>/. */
  id: string;
  faction: Faction;
  name: string;
  tier: DeckHeroTier;
}

export const DECK_HERO_COIN_PRICE = 2000;

/** По три героя на фракцию: стандартный, за игровые монеты и донатный витринный. */
export const DECK_HERO_CATALOG: readonly DeckHeroDefinition[] = [
  { id: 'Aurites', faction: Faction.Aurites, name: 'Стражи Света', tier: 'standard' },
  { id: 'aurites-veteran', faction: Faction.Aurites, name: 'Капитан Рассвета', tier: 'coin' },
  { id: 'aurites-ascendant', faction: Faction.Aurites, name: 'Златокрылый защитник', tier: 'donation' },

  { id: 'Necrus', faction: Faction.Necrus, name: 'Культ Тени', tier: 'standard' },
  { id: 'necrus-herald', faction: Faction.Necrus, name: 'Вестник Бездны', tier: 'coin' },
  { id: 'necrus-overlord', faction: Faction.Necrus, name: 'Повелитель Костей', tier: 'donation' },

  { id: 'Terramorph', faction: Faction.Terramorph, name: 'Древний Конклав', tier: 'standard' },
  { id: 'terramorph-elder', faction: Faction.Terramorph, name: 'Старейшина Рощи', tier: 'coin' },
  { id: 'terramorph-worldroot', faction: Faction.Terramorph, name: 'Сердце Древнего Леса', tier: 'donation' },

  { id: 'Pyromancer', faction: Faction.Pyromancer, name: 'Легион Пламени', tier: 'standard' },
  { id: 'pyromancer-sparkmaster', faction: Faction.Pyromancer, name: 'Мастер Искр', tier: 'coin' },
  { id: 'pyromancer-inferno', faction: Faction.Pyromancer, name: 'Владыка Пламени', tier: 'donation' },

  { id: 'Ethereal', faction: Faction.Ethereal, name: 'Странник Ветра', tier: 'standard' },
  { id: 'ethereal-stormkeeper', faction: Faction.Ethereal, name: 'Хранитель Бури', tier: 'coin' },
  { id: 'ethereal-starborn', faction: Faction.Ethereal, name: 'Астральный странник', tier: 'donation' },
] as const;

export const DECK_HERO_BY_ID: ReadonlyMap<string, DeckHeroDefinition> = new Map(
  DECK_HERO_CATALOG.map(hero => [hero.id, hero]),
);

export function deckHeroesForFaction(faction: string): DeckHeroDefinition[] {
  return DECK_HERO_CATALOG.filter(hero => hero.faction === faction);
}
