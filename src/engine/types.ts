/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — ядро правил. Модуль типов, констант и контрактов.
   ---------------------------------------------------------------------
   Этот файл — «единственный источник истины» по правилам игры.
   Он портируется 1-в-1 в C# (Unity/Assets/Scripts/Core/GameEnums.cs,
   GameTypes.cs) и в Python (tools/balance/engine.py) для headless-
   симуляции 10 000 матчей. Любое изменение правил делается СНАЧАЛА
   здесь, затем синхронно в трёх реализациях.
   ===================================================================== */

/* ------------------------------ ФРАКЦИИ ------------------------------ */

export enum Faction {
  Aurites   = 'Aurites',    // Ауриты  — Свет: защита, контроль, исцеление
  Necrus    = 'Necrus',     // Некрусы — Тьма: агрессия, жертвы, грабёж
  Terramorph= 'Terramorph', // Терраморфы — Земля: рампа, большие тела
  Pyromancer= 'Pyromancer', // Пироманты — Огонь: прямой урон
  Ethereal  = 'Ethereal',   // Эфирные — Воздух: контроль поля, кража, уклонение
  Neutral   = 'Neutral',    // Нейтральные (для будущих кросс-фракционных карт)
}

/* ------------------------------ ЭЛЕМЕНТЫ ----------------------------- */

export enum Element {
  None   = 'None',
  Fire   = 'Fire',
  Water  = 'Water',
  Earth  = 'Earth',
  Air    = 'Air',
  Chaos  = 'Chaos',
}

/* ------------------------------ ТИПЫ КАРТ ---------------------------- */

export enum CardType {
  Creature = 'Creature',
  Spell    = 'Spell',
  Rune     = 'Rune',
}

export enum SpellSubtype {
  Instant = 'Instant',   // мгновенное: сработало -> в сброс
  Ritual  = 'Ritual',    // ритуал: 1 ход подготовки, резолв в начале след. хода
}

export enum Rarity {
  Common    = 'Common',     // 60%
  Uncommon  = 'Uncommon',   // волна архетипов (мехи/гремлины/…)
  Rare      = 'Rare',       // 25%
  Epic      = 'Epic',       // 10%
  Legendary = 'Legendary',  // 5%
}

/* ------------------------------ ФАЗЫ ХОДА ---------------------------- */

export enum Phase {
  Start    = 'Start',     // 1. Начало
  Resource = 'Resource',  // 2. Ресурсы
  Main     = 'Main',      // 3. Основная
  Combat   = 'Combat',    // 4. Битва
  End      = 'End',       // 5. Конец
}

export const PHASE_ORDER: Phase[] = [
  Phase.Start, Phase.Resource, Phase.Main, Phase.Combat, Phase.End,
];

export const PHASE_RU: Record<Phase, string> = {
  [Phase.Start]:    'Начало',
  [Phase.Resource]: 'Ресурсы',
  [Phase.Main]:     'Основная',
  [Phase.Combat]:   'Битва',
  [Phase.End]:      'Конец',
};

/* ------------------------------ СТАТУСЫ ------------------------------ */

export enum StatusType {
  Burn    = 'Burn',     // Горение: N урона в начале хода владельца, стек -1
  Poison  = 'Poison',   // Яд: любое полученное существом повреждение -> смерть
  Freeze  = 'Freeze',   // Заморозка: не атакует, стек -1 в конце хода
  Shield  = 'Shield',   // Щит: поглощает первое полученное повреждение
  Fury    = 'Fury',     // Ярость: игнорирует болезнь призыва
  Silence = 'Silence',  // Немота: способности и статусы отключены (перманентно)
}

/* ------------------------------ КЛЮЧЕВЫЕ СЛОВА ------------------------ */

export enum Keyword {
  Taunt       = 'Taunt',        // Провокация: приоритетная цель авто-атаки
  Lifesteal   = 'Lifesteal',    // Вампиризм: урон лечит героя
  Deathrattle = 'Deathrattle',  // Предсмертный хрип
  Battlecry   = 'Battlecry',    // Боевой клич (при входе)
  Rush        = 'Rush',         // Рывок: может атаковать в ход призыва
  Windfury    = 'Windfury',     // Буря: 2 атаки за ход
  Unblockable = 'Unblockable',  // Не может быть целью авто-атаки (эвезив)
  Trample     = 'Trample',      // Прорыв: избыточный урон идёт в героя
  SpellDamage = 'SpellDamage',  // +N к урону заклинаний владельца
  DivineShield= 'DivineShield', // Божественный щит: входит со Щитом (1 заряд), поглощает первое повреждение
  Poisonous   = 'Poisonous',    // Ядовитый: при нанесении урона существу накладывает Яд (любая рана смертельна)
  Freezing    = 'Freezing',     // Ледяное касание: при нанесении урона замораживает цель на 1 ход
}

/* ------------------------------ ЦЕЛИ --------------------------------- */

export enum TargetKind {
  None          = 'None',
  EnemyCreature = 'EnemyCreature',
  FriendlyCreature = 'FriendlyCreature',
  AnyCreature   = 'AnyCreature',
  EnemyHero     = 'EnemyHero',
  FriendlyHero  = 'FriendlyHero',
  AnyHero       = 'AnyHero',
  AllEnemies    = 'AllEnemies',
  AllFriendlies = 'AllFriendlies',
  AllCreatures  = 'AllCreatures',
}

export enum Side { Player = 0, Opponent = 1 }

/* ------------------------------ КОНФИГУРАЦИЯ -------------------------- */

export interface GameConfig {
  deckSize: number;          // минимум 30 (30, 60, 90… — без верхнего лимита)
  startingHand: number;      // 5
  maxHand: number;           // 10 (излишек сгорает)
  heroHealth: number;        // 30
  maxMana: number;           // 10
  startingMaxMana: number;   // 0 -> +1 в первой фазе Ресурсов = 1 маны на 1-м ходу
  maxCreaturesPerSide: number; // 7
  mulliganAllowed: boolean;  // одна пересдача за игру
  echoPointsMax: number;     // 99 (накапливаются)
  echoUsagesPerGame: number; // 1 (по ТЗ: одно очко тратится один раз за игру)
  fatigueDamageStep: number; // 1 (урон за каждую пропущенную карту, растёт)
  combatMode: 'auto' | 'manual'; // по ТЗ — auto; manual для PvP/расширений
  maxTurns: number;          // предохранитель от бесконечных партий (200)
  seed: number;              // детерминированный RNG
  /**
   * Множители силы ПАССИВОК фракций (балансировочный слой, ТЗ п.8.2).
   * Значения по умолчанию = 1.0 — «как написано в ТЗ п.2.5».
   * Влияют только на числовые параметры пассивки (не на её наличие),
   * а также на стоимость пассивки в очках баланса (см. docs/BALANCE_MODEL.md).
   */
  passiveMul: Record<string, number>;
}

export const DEFAULT_CONFIG: GameConfig = {
  deckSize: 30,
  startingHand: 5,
  maxHand: 10,
  heroHealth: 30,
  maxMana: 10,
  startingMaxMana: 0,
  maxCreaturesPerSide: 7,
  mulliganAllowed: true,
  echoPointsMax: 99,
  echoUsagesPerGame: 1,
  fatigueDamageStep: 1,
  combatMode: 'auto',
  maxTurns: 200,
  seed: 1,
  passiveMul: {
    Aurites: 1.0,      // Божественный щит: заряды щита (редакция 2.5.1)
    Necrus: 1.0,       // Кровавая жатва: здоровье за смерть существа (2 * mul) (2.5.2)
    Terramorph: 1.0,   // Корни земли: доп. мана и длительность «мирного» периода (2.5.3)
    Pyromancer: 1.0,   // Пламя возмездия: бонус урона заклинаний и самоурон (2.5.4)
    Ethereal: 1.0,     // Иллюзорная тень: шанс срабатывания за ход (2.5.5)
  },
};

/* ------------------------------ ДАННЫЕ КАРТЫ -------------------------- */

/** Атомарный эффект. Декларативный: движок исполняет его, UI — рисует. */
export interface CardEffect {
  op: EffectOp;
  /** Числовые параметры (урон, лечение, кол-во карт, +атака, +здоровье...). */
  value?: number;
  /** К кому применяется (если не указано — берётся из target карты). */
  to?: TargetKind;
  /** Фильтр цели: минимальная/максимальная атака, «случайная», «все с X». */
  filter?: EffectFilter;
  /** Тип/сила накладываемого статуса. */
  status?: StatusType;
  statusValue?: number;
  /** Элемент, с которым связан эффект (для рун «стихийных»). */
  element?: Element;
  /** Вложенный эффект (для условных «если ... то ...»). */
  then?: CardEffect;
  /** Условие срабатывания. */
  if?: EffectCondition;
  /** Число повторов. */
  repeat?: number;
}

export type EffectOp =
  | 'damage'            // нанести value урона цели
  | 'heal'              // восстановить value здоровья цели
  | 'draw'              // взять value карт
  | 'opponentDraw'      // противник берёт value карт
  | 'destroyCreature'   // уничтожить существо
  | 'buffAttack'        // +value атаки (до конца боя / перманентно — per flag)
  | 'buffHealth'        // +value здоровья
  | 'debuffAttack'      // -value атаки
  | 'debuffHealth'      // -value здоровья (перманентно; здоровье <=0 -> смерть) v2.6 «Порча»
  | 'applyStatus'       // наложить статус
  | 'removeStatus'      // снять статус
  | 'silence'           // немота
  | 'returnToHand'      // вернуть существо в руку владельца
  | 'stealCard'         // украсть случайную карту из руки противника
  | 'stealCreature'     // перехватить существо противника
  | 'gainMana'          // +value маны сейчас (временная)
  | 'gainMaxMana'       // +value к максимуму маны (перманентно)
  | 'summonToken'       // призвать токен-существо
  | 'gainEcho'          // получить Эхо-очко
  | 'sacrifice'         // пожертвовать своим существом
  | 'restoreHealthByAttack' // лечение = атаке цели
  | 'damageAllEnemyCreatures'
  | 'damageAllFriendlyCreatures'
  | 'damageAllCreatures'
  | 'healAllFriendlyCreatures'
  | 'freezeAllEnemies'
  | 'burnAllEnemies'
  | 'shieldAllFriendlies'
  | 'setAttack'
  | 'copyLastSpell'     // Эхо-механика
  | 'mill'              // сбросить value карт из колоды противника
  | 'damageHeroes'
  | 'reduceIncomingDamage' // бафф «защита героя»
  | 'increaseSpellDamage';

export interface EffectFilter {
  lowestHealth?: boolean;
  lowestAttack?: boolean;
  highestAttack?: boolean;
  highestHealth?: boolean;
  random?: boolean;
  count?: number;
  attackAtLeast?: number;
  attackAtMost?: number;
  costAtLeast?: number;
  isLegendary?: boolean;
  notSilenced?: boolean;
}

export interface EffectCondition {
  heroHealthAtMost?: number;
  heroHealthAtLeast?: number;
  enemyCreaturesAtLeast?: number;
  friendlyCreaturesAtLeast?: number;
  handSizeAtMost?: number;
  handSizeAtLeast?: number;
  turnAtLeast?: number;
  hasRune?: string;
  enemyHasRune?: string;
  chance?: number;      // 0..1 — для «неидеального» поведения
}

/** Полное описание карты (из Cards.json). */
export interface CardData {
  id: string;
  name: string;
  faction: Faction;
  type: CardType;
  subtype?: SpellSubtype;
  rarity: Rarity;
  cost: number;
  attack?: number;
  health?: number;
  element: Element;
  keywords: Keyword[];
  target: TargetKind;          // требуемая цель при розыгрыше
  effects: CardEffect[];       // эффекты при розыгрыше
  onDeath?: CardEffect[];      // предсмертный хрип
  onTurnStart?: CardEffect[];  // триггер начала хода (руны, ритуалы, существа)
  onTurnEnd?: CardEffect[];
  onDamageTaken?: CardEffect[];
  onCreatureDies?: CardEffect[];
  onSpellCast?: CardEffect[];
  /** «Выжигание»: на сколько снижено входящее лечение противника, пока карта в игре. */
  healReduction?: number;
  duration?: number;           // для рун: сколько ходов живёт (undefined = навсегда)
  ritualDelay?: number;        // для ритуалов: ходов подготовки (default 1)
  abilityText: string;         // текст способности (показывается на карте)
  flavor: string;              // лоровая фраза
  art: string;                 // путь к арту: Resources/Cards/<file>
  artPrompt?: string;          // промпт для Midjourney / Stable Diffusion
  tags?: string[];             // для поиска в коллекции и драфта
}

/* ------------------------------ СОСТОЯНИЕ ----------------------------- */

export interface StatusInstance {
  type: StatusType;
  value: number;   // стаки / сила (для Burn — урон за тик)
  turnsLeft: number; // -1 = перманентно
  sourceCardId?: string;
}

export interface EntityCreature {
  uid: number;                 // уникальный id实例 на доске
  cardId: string;
  owner: Side;
  name: string;
  faction: Faction;
  attack: number;
  health: number;
  maxHealth: number;
  cost: number;
  element: Element;
  keywords: Keyword[];
  statuses: StatusInstance[];
  summonedOnTurn: number;
  attacksThisTurn: number;
  canAttackThisTurn: boolean;
  silenced: boolean;
  frozen: boolean;
  justPlayed: boolean;         // болезнь призыва
  unblockableThisTurn: boolean;// «Иллюзорная тень» Эфирных
  data: CardData;
}

export interface EntityRune {
  uid: number;
  cardId: string;
  owner: Side;
  name: string;
  faction: Faction;
  element: Element;
  turnsLeft: number;           // -1 = навсегда
  data: CardData;
  silenced: boolean;
}

export interface EntityRitual {
  uid: number;
  cardId: string;
  owner: Side;
  name: string;
  turnsLeft: number;
  targetUid?: number;          // запомненная цель
  targetSide?: Side;
  data: CardData;
}

export interface PlayerState {
  side: Side;
  name: string;
  faction: Faction;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  bonusMana: number;           // от эффектов/рун
  deck: string[];              // cardId
  hand: string[];              // cardId
  graveyard: string[];         // cardId
  creatures: EntityCreature[];
  runes: EntityRune[];
  rituals: EntityRitual[];
  echoPoints: number;
  echoUsedThisGame: number;
  lastSpellCast?: { cardId: string; targetUid?: number; targetSide?: Side };
  spellsCastThisTurn: number;
  cardsPlayedThisTurn: number;
  fatigueCounter: number;
  damageReduction: number;     // временная «Защита героя»
  spellDamageBonus: number;    // от существ/рун с SpellDamage
  mulliganUsed: boolean;
  incomingDamageReductionTurns: number; // до конца следующего хода противника
}

export enum GameResult { Ongoing = 'Ongoing', PlayerWin = 'PlayerWin', OpponentWin = 'OpponentWin', Draw = 'Draw' }

export interface GameSnapshot {
  turn: number;
  activeSide: Side;
  phase: Phase;
  result: GameResult;
  players: [PlayerState, PlayerState];
}

/* ------------------------------ СОБЫТИЯ ------------------------------- */

export enum GameEventType {
  GameStarted = 'GameStarted',
  PhaseChanged = 'PhaseChanged',
  TurnStarted = 'TurnStarted',
  TurnEnded = 'TurnEnded',
  ManaChanged = 'ManaChanged',
  CardDrawn = 'CardDrawn',
  CardBurned = 'CardBurned',
  CardDiscarded = 'CardDiscarded',
  CardPlayed = 'CardPlayed',
  CreatureSummoned = 'CreatureSummoned',
  CreatureAttacks = 'CreatureAttacks',
  CreatureDamaged = 'CreatureDamaged',
  CreatureHealed = 'CreatureHealed',
  CreatureDeath = 'CreatureDeath',
  CreatureSilenced = 'CreatureSilenced',
  CreatureBounced = 'CreatureBounced',
  CreatureStolen = 'CreatureStolen',
  StatusApplied = 'StatusApplied',
  StatusExpired = 'StatusExpired',
  SpellCast = 'SpellCast',
  SpellCopied = 'SpellCopied',
  RitualPlaced = 'RitualPlaced',
  RitualResolved = 'RitualResolved',
  InstantWindow = 'InstantWindow',
  InstantWindowClosed = 'InstantWindowClosed',
  StackPushed = 'StackPushed',
  StackResolved = 'StackResolved',
  RunePlayed = 'RunePlayed',
  RuneTick = 'RuneTick',
  RuneExpired = 'RuneExpired',
  EchoGained = 'EchoGained',
  EchoSpent = 'EchoSpent',
  PlayerDamage = 'PlayerDamage',
  PlayerHeal = 'PlayerHeal',
  PlayerDeath = 'PlayerDeath',
  CardStolen = 'CardStolen',
  GameOver = 'GameOver',
  Log = 'Log',
}

export interface GameEvent {
  type: GameEventType;
  side?: Side;
  uid?: number;
  cardId?: string;
  cardName?: string;
  value?: number;
  /** Урон поглощён щитом целиком: значение 0, слою представления показать «🛡». */
  absorbed?: boolean;
  text?: string;
  phase?: Phase;
  turn?: number;
  targetUid?: number;
  targetSide?: Side;
  /** Карта-источник события (для per-card статистики урона/лечения в автотестере). */
  sourceCardId?: string;
  /**
   * Стихия источника и флаг «урон нанесён заклинанием» — нужны слою представления,
   * чтобы выбрать VFX (docs/VISUAL_STACK.md, раздел 6: огонь/вода/земля/воздух/хаос).
   * На игровую логику не влияют.
   */
  sourceElement?: Element;
  fromSpell?: boolean;
  result?: GameResult;
  data?: any;
}

/* ------------------------------ УТИЛИТЫ ------------------------------- */

/** Детерминированный ГПСЧ (xorshift128+) — обязателен для воспроизводимых симуляций. */
export class Rng {
  private s0: number;
  private s1: number;
  constructor(seed: number) {
    this.s0 = (seed | 0) || 0x9e3779b9;
    this.s1 = (this.s0 * 1812433253 + 12345) | 0;
    if (this.s1 === 0) this.s1 = 0x6d2b79f5;
  }
  /** v3.4 (онлайн): снимок/восстановление состояния генератора для синхронизации клиентов. */
  getState(): [number, number] { return [this.s0, this.s1]; }
  setState(st: [number, number]): void { this.s0 = st[0] | 0; this.s1 = st[1] | 0; }
  /** [0,1) */
  next(): number {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= (s1 << 23) | 0;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.s1 = s1;
    const r = ((this.s0 + this.s1) >>> 0) / 4294967296;
    return r;
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  range(min: number, max: number): number { return min + this.int(max - min + 1); }
  pick<T>(arr: T[]): T { return arr[this.int(arr.length)]; }
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  chance(p: number): boolean { return this.next() < p; }
}

export const FACTION_RU: Record<Faction, string> = {
  [Faction.Aurites]: 'Ауриты',
  [Faction.Necrus]: 'Некрусы',
  [Faction.Terramorph]: 'Терраморфы',
  [Faction.Pyromancer]: 'Пироманты',
  [Faction.Ethereal]: 'Эфирные',
  [Faction.Neutral]: 'Нейтральные',
};

export const FACTION_COLORS: Record<Faction, { primary: string; secondary: string; accent: string }> = {
  [Faction.Aurites]:    { primary: '#f5d76e', secondary: '#ffffff', accent: '#7ec8ff' },
  [Faction.Necrus]:     { primary: '#8e44ad', secondary: '#1a1020', accent: '#e74c3c' },
  [Faction.Terramorph]: { primary: '#4e8f3a', secondary: '#6b4a2b', accent: '#e0a33e' },
  [Faction.Pyromancer]: { primary: '#ff7a18', secondary: '#c0392b', accent: '#ffd54a' },
  [Faction.Ethereal]:   { primary: '#3fd6c8', secondary: '#dfe7ee', accent: '#ffffff' },
  [Faction.Neutral]:    { primary: '#9aa3ad', secondary: '#3a3f46', accent: '#e6e9ee' },
};

export const RARITY_COLORS: Record<Rarity, string> = {
  [Rarity.Common]: '#cfd6dd',
  [Rarity.Uncommon]: '#3ecf7a',
  [Rarity.Rare]: '#4f9cf9',
  [Rarity.Epic]: '#b06cf0',
  [Rarity.Legendary]: '#f5a623',
};
