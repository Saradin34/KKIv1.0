/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — движок правил (GameEngine).
   Чистая логика без зависимостей от Unity/рендеринга/времени.
   Детерминирован: при одинаковых (seed, колоды, AI-политика) даёт
   идентичную партию. Это позволяет гонять 10 000 матчей в headless-режиме.
   ===================================================================== */

import {
  CardData, CardEffect, CardType, Element, EntityCreature, EntityRitual, EntityRune,
  Faction, GameConfig, GameEvent, GameEventType, GameResult, Keyword, Phase, PHASE_ORDER,
  PlayerState, Rarity, Rng, Side, SpellSubtype, StatusInstance, StatusType, TargetKind,
  DEFAULT_CONFIG, EffectFilter, EffectCondition,
} from './types';

export type CardDatabase = Map<string, CardData>;

/* --------------------------- ДЕЙСТВИЯ ИГРОКА --------------------------- */

export type GameAction =
  | { type: 'playCard'; handIndex: number; targetUid?: number; targetSide?: Side }
  | { type: 'useEcho'; targetUid?: number; targetSide?: Side }
  | { type: 'endTurn' }
  | { type: 'mulliganKeep'; keepIndices: number[] }
  | { type: 'activate'; uid: number }        // активируемая способность существа
  | { type: 'manualAttack'; uid: number; targetUid?: number; targetHero?: boolean };

export interface EngineHooks {
  /** Вызывается на каждое событие (UI, лог, аналитика). */
  onEvent?: (e: GameEvent) => void;
  /** Ворота анимации: UI может вернуть Promise, движок его дождётся. */
  waitFor?: (e: GameEvent) => Promise<void> | void;
}

export interface MatchStats {
  cardsPlayed: number;
  spellsCast: number;
  creaturesSummoned: number;
  runesPlayed: number;
  damageDealt: number;
  damageTaken: number;
  healingDone: number;
  cardsDrawn: number;
  echoGained: number;
  echoUsed: number;
  manaSpent: number;
  kills: number;
  losses: number;
}

export function emptyStats(): MatchStats {
  return {
    cardsPlayed: 0, spellsCast: 0, creaturesSummoned: 0, runesPlayed: 0,
    damageDealt: 0, damageTaken: 0, healingDone: 0, cardsDrawn: 0,
    echoGained: 0, echoUsed: 0, manaSpent: 0, kills: 0, losses: 0,
  };
}

/* ======================================================================= */

export class GameEngine {
  readonly config: GameConfig;
  readonly db: CardDatabase;
  readonly rng: Rng;
  readonly hooks: EngineHooks;

  players: [PlayerState, PlayerState];
  turn = 0;                 // глобальный номер хода
  turnsTaken: [number, number] = [0, 0]; // сколько ходов сделал каждый игрок
  activeSide: Side = Side.Player;
  phase: Phase = Phase.Start;
  result: GameResult = GameResult.Ongoing;
  log: GameEvent[] = [];
  stats: [MatchStats, MatchStats] = [emptyStats(), emptyStats()];

  private uidCounter = 1;
  private eventQueue: GameEvent[] = [];
  /** Карта uid -> существо (для быстрого поиска). */
  private uidMap = new Map<number, EntityCreature>();
  /** Очередь смертей, резолвится после текущего эффекта (правило «state-based»). */
  private pendingDeaths: EntityCreature[] = [];
  private depth = 0;

  constructor(db: CardDatabase, decks: [string[], string[]], opts: {
    config?: Partial<GameConfig>;
    factions?: [Faction, Faction];
    names?: [string, string];
    seed?: number;
    hooks?: EngineHooks;
  } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}), seed: opts.seed ?? opts.config?.seed ?? 1 };
    this.db = db;
    this.rng = new Rng(this.config.seed);
    this.hooks = opts.hooks ?? {};

    this.players = [
      this.makePlayer(Side.Player, decks[0], opts.factions?.[0] ?? Faction.Aurites, opts.names?.[0] ?? 'Игрок'),
      this.makePlayer(Side.Opponent, decks[1], opts.factions?.[1] ?? Faction.Necrus, opts.names?.[2 - 1] ?? 'Противник'),
    ];
  }

  /* ----------------------------- ИНИЦИАЛИЗАЦИЯ ----------------------------- */

  private makePlayer(side: Side, deckList: string[], faction: Faction, name: string): PlayerState {
    return {
      side, name, faction,
      health: this.config.heroHealth,
      maxHealth: this.config.heroHealth,
      mana: 0,
      maxMana: this.config.startingMaxMana,
      bonusMana: 0,
      deck: this.rng.shuffle(deckList),
      hand: [],
      graveyard: [],
      creatures: [],
      runes: [],
      rituals: [],
      echoPoints: 0,
      echoUsedThisGame: 0,
      spellsCastThisTurn: 0,
      cardsPlayedThisTurn: 0,
      fatigueCounter: 0,
      damageReduction: 0,
      spellDamageBonus: 0,
      mulliganUsed: false,
      incomingDamageReductionTurns: 0,
    };
  }

  /** Раздача стартовой руки. Возвращает true, если нужен муллиган. */
  setup(): void {
    this.emit({ type: GameEventType.GameStarted, text: 'Бой начался' });
    for (const side of [Side.Player, Side.Opponent]) {
      for (let i = 0; i < this.config.startingHand; i++) this.draw(side, { silent: true });
    }
  }

  /** Множитель силы пассивки фракции (балансировочный слой, default 1.0 = ТЗ). */
  passiveMul(f: Faction): number {
    const v = this.config.passiveMul?.[f];
    return typeof v === 'number' && v >= 0 ? v : 1.0;
  }

  /**
   * Вероятностное округление дробного значения пассивки.
   * Делает силу пассивки НЕПРЕРЫВНОЙ функцией множителя (2.5 → 50% шанс 3 щита,
   * 50% шанс 2), иначе балансировщик осциллирует между целыми ступенями.
   */
  private pround(x: number): number {
    if (x <= 0) return 0;
    const f = Math.floor(x);
    const frac = x - f;
    return this.rng.next() < frac ? f + 1 : f;
  }

  get opponentSide(): Side { return this.activeSide === Side.Player ? Side.Opponent : Side.Player; }
  p(side: Side): PlayerState { return this.players[side]; }
  active(): PlayerState { return this.players[this.activeSide]; }
  enemy(): PlayerState { return this.players[this.opponentSide]; }

  /* ----------------------------- СОБЫТИЯ / ЛОГ ----------------------------- */

  emit(e: GameEvent): void {
    e.turn = e.turn ?? this.turn;
    e.phase = e.phase ?? this.phase;
    this.log.push(e);
    if (this.log.length > 4000) this.log.splice(0, 1000);
    this.eventQueue.push(e);
    this.hooks.onEvent?.(e);
  }

  drainEvents(): GameEvent[] {
    const q = this.eventQueue;
    this.eventQueue = [];
    return q;
  }

  private say(text: string, side?: Side): void {
    this.emit({ type: GameEventType.Log, text, side });
  }

  /* ----------------------------- ДОБОР КАРТ ------------------------------- */

  draw(side: Side, opts: { silent?: boolean; source?: string } = {}): CardData | null {
    const pl = this.p(side);
    if (pl.deck.length === 0) {
      // Усталость: 1 урон за каждую пропущенную карту, урон растёт
      pl.fatigueCounter += this.config.fatigueDamageStep;
      this.damageHero(side, pl.fatigueCounter, { source: 'Усталость', ignoreReduction: true });
      if (!opts.silent) this.say(`${pl.name}: колода пуста — усталость ${pl.fatigueCounter}`, side);
      return null;
    }
    const cardId = pl.deck.shift()!;
    const card = this.db.get(cardId);
    if (pl.hand.length >= this.config.maxHand) {
      pl.graveyard.push(cardId);
      this.emit({ type: GameEventType.CardBurned, side, cardId, cardName: card?.name, text: `${pl.name}: карта «${card?.name}» сгорела (рука полна)` });
      return null;
    }
    pl.hand.push(cardId);
    this.stats[side].cardsDrawn++;
    if (!opts.silent) this.emit({ type: GameEventType.CardDrawn, side, cardId, cardName: card?.name });
    return card ?? null;
  }

  /** Муллиган: оставить указанные индексы, остальные — в колоду и перемешать. */
  mulligan(side: Side, keepIndices: number[]): void {
    const pl = this.p(side);
    if (!this.config.mulliganAllowed || pl.mulliganUsed) return;
    const keep = new Set(keepIndices.map(i => Math.max(0, Math.min(pl.hand.length - 1, i))));
    const kept: string[] = [];
    const back: string[] = [];
    pl.hand.forEach((c, i) => (keep.has(i) ? kept : back).push(c));
    pl.hand = kept;
    pl.deck.unshift(...back);
    pl.deck = this.rng.shuffle(pl.deck);
    for (let i = 0; i < back.length; i++) this.draw(side, { silent: true });
    pl.mulliganUsed = true;
    this.say(`${pl.name} совершает муллиган: заменено ${back.length} карт`, side);
  }

  /* ----------------------------- УРОН / ЛЕЧЕНИЕ ---------------------------- */

  damageHero(side: Side, amount: number, opts: { source?: string; ignoreReduction?: boolean; lifestealFor?: Side; sourceCardId?: string; fromSpell?: boolean } = {}): number {
    if (amount <= 0 || this.result !== GameResult.Ongoing) return 0;
    const pl = this.p(side);
    let dmg = amount;
    if (!opts.ignoreReduction) {
      const rd = this.heroDamageReduction(side);
      if (rd > 0) dmg = Math.max(0, dmg - rd);
    }
    if (dmg <= 0) {
      this.say(`${pl.name}: урон поглощён защитой`, side);
      return 0;
    }
    pl.health -= dmg;
    this.emit({
      type: GameEventType.PlayerDamage, side, value: dmg, sourceCardId: opts.sourceCardId,
      sourceElement: this.elementOfCard(opts.sourceCardId), fromSpell: opts.fromSpell ?? !!this.spellSourceCard,
      text: `${pl.name} получает ${dmg} урона${opts.source ? ` (${opts.source})` : ''}`,
    });
    if (opts.lifestealFor !== undefined) {
      this.healHero(opts.lifestealFor, dmg, { source: 'Вампиризм' });
    }
    if (side === Side.Player) this.stats[Side.Opponent].damageDealt += dmg; else this.stats[Side.Player].damageDealt += dmg;
    this.stats[side].damageTaken += dmg;
    if (pl.health <= 0) {
      pl.health = 0;
      this.emit({ type: GameEventType.PlayerDeath, side, text: `${pl.name} пал` });
      this.endGame(side === Side.Player ? GameResult.OpponentWin : GameResult.PlayerWin);
    }
    return dmg;
  }

  healHero(side: Side, amount: number, opts: { source?: string; sourceCardId?: string } = {}): number {
    const pl = this.p(side);
    if (amount <= 0) return 0;
    // «Выжигание»: входящее лечение снижено (пол — 1), снимается в конце хода владельца дебаффа
    const red = this.healReductionOn(side);
    const eff = red > 0 ? Math.max(1, amount - red) : amount;
    const before = pl.health;
    pl.health = Math.min(pl.maxHealth, pl.health + eff);
    const healed = pl.health - before;
    if (healed > 0) {
      this.emit({ type: GameEventType.PlayerHeal, side, value: healed, sourceCardId: opts.sourceCardId, text: `${pl.name} восстанавливает ${healed} здоровья${opts.source ? ` (${opts.source})` : ''}` });
      this.stats[side].healingDone += healed;
    }
    return healed;
  }

  /**
   * «Выжигание» — суммарное снижение входящего ЛЕЧЕНИЯ героя (механика Пиромантов).
   * Складывается из аур рун и эффектов существ противника.
   */
  healReductionOn(side: Side): number {
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    let red = 0;
    for (const r of en.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (aura?.op === 'healReduction') red += aura.value ?? 1;
      if (typeof (r.data as any).healReduction === 'number') red += (r.data as any).healReduction;
    }
    for (const c of en.creatures) {
      if (c.silenced) continue;
      const hr = (c.data as any).healReduction;
      if (typeof hr === 'number') red += hr;
    }
    return Math.max(0, red);
  }

  /** Суммарное снижение урона героя (пассивка Ауритов-руны, ауры, баффы). */
  heroDamageReduction(side: Side): number {
    const pl = this.p(side);
    let rd = pl.damageReduction;
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const heroProt = (r.data as any).heroProtection;
      if (typeof heroProt === 'number') rd += heroProt;
      const aura = (r.data as any).aura as any;
      if (aura && aura.op === 'heroProtection') rd += aura.value ?? 0;
    }
    return Math.max(0, rd);
  }

  /**
   * Бонус к урону заклинаний (существа/руны со SpellDamage + пассивка Пиромантов).
   * spellCost нужен для редакции п.2.5.4: дорогие заклинания получают больший бонус.
   */
  spellDamageOf(side: Side, element: Element = Element.None, spellCost?: number): number {
    const pl = this.p(side);
    let bonus = pl.spellDamageBonus;
    for (const c of pl.creatures) {
      if (c.silenced) continue;
      if (c.keywords.includes(Keyword.SpellDamage)) bonus += (c.data as any).spellDamageValue ?? 1;
    }
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (aura && aura.op === 'spellDamage') {
        const onlyElem: Element | undefined = aura.element;
        if (!onlyElem || onlyElem === Element.None || onlyElem === element) bonus += aura.value ?? 0;
      }
      if (typeof (r.data as any).spellDamage === 'number') bonus += (r.data as any).spellDamage;
    }
    // Пассивка Пиромантов «Пламя возмездия» (редакция ТЗ п.2.5.4):
    // заклинания наносят больше урона, и бонус РАСТЁТ с ценой заклинания:
    //   стоимость 1-2  -> +1 урона
    //   стоимость 3+   -> +2 урона
    // В паре с постоянной платой «−1 здоровье за заклинание» это делает
    // «спам дешёвых» невыгодным, а дорогой выстрел — окупающимся.
    if (pl.faction === Faction.Pyromancer) {
      const tier = (spellCost ?? 1) >= 3 ? 2 : 1;
      bonus += this.pround(tier * this.passiveMul(Faction.Pyromancer));
    }
    return bonus;
  }

  /* ----------------------------- СУЩЕСТВА ---------------------------------- */

  private nextUid(): number { return this.uidCounter++; }

  /** Стихия карты-источника (для VFX слоя представления). */
  private elementOfCard(cardId?: string): Element | undefined {
    if (!cardId) return undefined;
    return this.db.get(cardId)?.element;
  }
  /** Карта-заклинание, чей урон сейчас разрешается (для VFX: «урон от заклинания»). */
  private spellSourceCard: CardData | null = null;

  findCreature(uid: number): EntityCreature | undefined { return this.uidMap.get(uid); }

  allCreatures(): EntityCreature[] { return [...this.players[0].creatures, ...this.players[1].creatures]; }

  summon(side: Side, card: CardData, opts: { fromHand?: boolean; targetUid?: number; targetSide?: Side } = {}): EntityCreature | null {
    const pl = this.p(side);
    if (pl.creatures.length >= this.config.maxCreaturesPerSide) {
      this.say(`${pl.name}: поле заполнено (7 существ) — призыв отменён`, side);
      pl.graveyard.push(card.id);
      return null;
    }
    const c: EntityCreature = {
      uid: this.nextUid(),
      cardId: card.id,
      owner: side,
      name: card.name,
      faction: card.faction,
      attack: card.attack ?? 0,
      health: card.health ?? 1,
      maxHealth: card.health ?? 1,
      cost: card.cost,
      element: card.element,
      keywords: [...(card.keywords ?? [])],
      statuses: [],
      summonedOnTurn: this.turnsTaken[side],
      attacksThisTurn: 0,
      canAttackThisTurn: false,
      silenced: false,
      frozen: false,
      justPlayed: true,
      unblockableThisTurn: false,
      data: card,
    };
    // Ауры «+X/+Y всем вашим существам» применяются сразу при входе
    this.applyAuraToNewCreature(side, c);
    pl.creatures.push(c);
    this.uidMap.set(c.uid, c);
    this.stats[side].creaturesSummoned++;

    // Пассивка Ауритов «Божественный щит» (редакция ТЗ п.2.5.1):
    // существо получает Щит при выходе на поле; заряды = 1 + (стоимость >= 4 ? 1 : 0).
    // Обоснование: в авто-бою цель выбирается по наименьшему здоровью, поэтому
    // «щит всем» на дешёвых телах полностью обнуляет размен. Дорогое тело защищено сильнее.
    if (pl.faction === Faction.Aurites) {
      const base = 1 + (c.cost >= 4 ? 1 : 0);
      const eligible = c.cost >= 2 ? base : 0;
      const charges = this.pround(eligible * this.passiveMul(Faction.Aurites));
      if (charges > 0) {
        this.addStatus(c, { type: StatusType.Shield, value: charges, turnsLeft: -1 });
        this.say(`Божественный щит: «${c.name}» под защитой (${charges})`, side);
      }
    }

    // Новые ключевые слова v2.12.2: Божественный щит входит со Щитом
    if (!c.silenced && c.keywords.includes(Keyword.DivineShield)) {
      this.addStatus(c, { type: StatusType.Shield, value: 1, turnsLeft: -1 });
      this.say(`Божественный щит: «${c.name}» защищён`, side);
    }

    this.emit({ type: GameEventType.CreatureSummoned, side, uid: c.uid, cardId: c.cardId, cardName: c.name, data: { attack: c.attack, health: c.health } });
    this.say(`${pl.name} призывает «${c.name}» (${c.attack}/${c.health})`, side);

    // Боевой клич / эффекты при входе
    if (!c.silenced && card.effects && card.effects.length > 0 && opts.fromHand !== false) {
      this.runEffects(card.effects, side, {
        sourceUid: c.uid, sourceCard: card, isBattlecry: true,
        targetUid: opts.targetUid, targetSide: opts.targetSide,
      });
    }
    this.checkDeaths();
    return c;
  }

  /** Постоянные ауры обеих сторон применяются и к новичку на доске. */
  private applyAuraToNewCreature(side: Side, c: EntityCreature): void {
    const pl = this.p(side);
    const enemy = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const matches = (aura: any): boolean => !Array.isArray(aura.matches)
      || aura.matches.length === 0 || aura.matches.includes(c.element);

    // Дружественные руны усиливают новое существо.
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (!aura || !matches(aura)) continue;
      if (aura.op === 'buffAttackHealth') { c.attack += aura.atk ?? 0; c.health += aura.hp ?? 0; c.maxHealth += aura.hp ?? 0; }
      if (aura.op === 'buffAttack') c.attack += aura.value ?? 0;
      if (aura.op === 'buffHealth') { c.health += aura.value ?? 0; c.maxHealth += aura.value ?? 0; }
    }

    // Руны противника с постоянным ослаблением тоже должны захватывать
    // существ, которые вышли на поле уже после установки руны.
    for (const r of enemy.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (aura?.op === 'debuffAttackEnemy' && matches(aura)) {
        c.attack = Math.max(0, c.attack - (aura.value ?? 0));
      }
    }
    // Пассивная аура существ с SpellDamage уже учтена в spellDamageOf().
  }

  damageCreature(c: EntityCreature, amount: number, opts: { source?: string; pierceShield?: boolean; fromSpell?: boolean; sourceCardId?: string } = {}): number {
    if (amount <= 0 || !this.uidMap.has(c.uid)) return 0;
    let dmg = amount;

    // Щит поглощает первое повреждение
    const shield = c.statuses.find(s => s.type === StatusType.Shield && s.value > 0);
    if (shield && !opts.pierceShield) {
      shield.value -= 1;
      if (shield.value <= 0) this.removeStatus(c, shield);
      this.emit({
        type: GameEventType.CreatureDamaged, uid: c.uid, side: c.owner, value: 0, absorbed: true,
        cardName: c.name, sourceCardId: opts.sourceCardId, fromSpell: opts.fromSpell === true,
        text: `Щит «${c.name}» поглотил ${dmg} урона`,
      });
      return 0;
    }

    // Яд: любое повреждение убивает
    const poison = c.statuses.find(s => s.type === StatusType.Poison);
    if (poison && !c.silenced) dmg = Math.max(dmg, c.health);

    c.health -= dmg;
    this.emit({
      type: GameEventType.CreatureDamaged, uid: c.uid, side: c.owner, value: dmg, cardName: c.name,
      sourceCardId: opts.sourceCardId, sourceElement: this.elementOfCard(opts.sourceCardId), fromSpell: opts.fromSpell === true,
      text: `«${c.name}» получает ${dmg} урона (${c.health}/${c.maxHealth})`,
    });

    if (c.data.onDamageTaken && c.data.onDamageTaken.length && !c.silenced) {
      this.runEffects(c.data.onDamageTaken, c.owner, { sourceUid: c.uid, sourceCard: c.data });
    }
    if (c.health <= 0) this.markDeath(c);
    return dmg;
  }

  healCreature(c: EntityCreature, amount: number, sourceCardId?: string): number {
    if (amount <= 0) return 0;
    const red = this.healReductionOn(c.owner);
    const eff = red > 0 ? Math.max(1, amount - red) : amount;
    const before = c.health;
    c.health = Math.min(c.maxHealth, c.health + eff);
    const healed = c.health - before;
    if (healed > 0) this.emit({ type: GameEventType.CreatureHealed, uid: c.uid, side: c.owner, value: healed, cardName: c.name, sourceCardId });
    return healed;
  }

  private markDeath(c: EntityCreature): void {
    if (this.pendingDeaths.includes(c)) return;
    this.pendingDeaths.push(c);
  }

  /** Проверка состояний: убираем мёртвых, триггерим предсмертные хрипы и пассивку Некрусов. */
  checkDeaths(): void {
    if (this.depth > 32) return; // защита от бесконечной рекурсии
    let guard = 0;
    while (this.pendingDeaths.length > 0 && guard++ < 200) {
      const dying = this.pendingDeaths.splice(0, this.pendingDeaths.length);
      for (const c of dying) {
        if (c.health > 0) continue;
        const owner = this.p(c.owner);
        const idx = owner.creatures.indexOf(c);
        if (idx >= 0) owner.creatures.splice(idx, 1);
        this.uidMap.delete(c.uid);
        owner.graveyard.push(c.cardId);
        this.stats[c.owner].losses++;
        this.emit({ type: GameEventType.CreatureDeath, uid: c.uid, side: c.owner, cardId: c.cardId, cardName: c.name, text: `«${c.name}» погибает` });
        this.say(`${owner.name}: «${c.name}» погибает`, c.owner);

        // Предсмертный хрип
        if (!c.silenced && c.data.onDeath && c.data.onDeath.length) {
          this.depth++;
          this.runEffects(c.data.onDeath, c.owner, { sourceUid: c.uid, sourceCard: c.data, isDeathrattle: true });
          this.depth--;
        }

        // Пассивка Некрусов «Кровавая жатва»: смерть своего существа -> +1 карта, +2 здоровья
        if (owner.faction === Faction.Necrus) {
          const heal = this.pround(2 * this.passiveMul(Faction.Necrus));
          // Пассивка Некрусов «Кровавая жатва» (редакция ТЗ п.2.5.2):
          // +1 карта и +2 здоровья, но только за смерть существа стоимостью >= 2.
          // Обоснование: без порога токены и «мелочь» дают бесконечный card advantage.
          const drawsCard = c.cost >= 2;
          if (drawsCard) this.draw(c.owner, { source: 'Кровавая жатва' });
          if (heal > 0) this.healHero(c.owner, heal, { source: 'Кровавая жатва' });
          this.say(`Кровавая жатва: ${owner.name} ${drawsCard ? 'берёт карту и ' : ''}восстанавливает ${heal} здоровья`, c.owner);
        }
      }
      // смерти, порождённые хрипами
      for (const c of this.allCreatures()) if (c.health <= 0) this.markDeath(c);
    }
  }

  addStatus(c: EntityCreature, s: StatusInstance): void {
    if (c.silenced && s.type !== StatusType.Silence) return;
    const existing = c.statuses.find(x => x.type === s.type);
    if (existing) {
      existing.value = Math.max(existing.value, s.value);
      if (s.turnsLeft === -1 || existing.turnsLeft === -1) existing.turnsLeft = -1;
      else existing.turnsLeft = Math.max(existing.turnsLeft, s.turnsLeft);
    } else {
      c.statuses.push({ ...s });
    }
    if (s.type === StatusType.Freeze) c.frozen = true;
    if (s.type === StatusType.Silence) {
      c.silenced = true;
      c.statuses = c.statuses.filter(x => x.type === StatusType.Silence);
      c.frozen = false;
      c.keywords = [];
      this.emit({ type: GameEventType.CreatureSilenced, uid: c.uid, side: c.owner, cardName: c.name, text: `«${c.name}» под немотой` });
    }
    const activeStatus = c.statuses.find(x => x.type === s.type);
    this.emit({
      type: GameEventType.StatusApplied, uid: c.uid, side: c.owner, cardName: c.name,
      value: activeStatus?.value ?? s.value,
      data: { status: s.type, turnsLeft: activeStatus?.turnsLeft ?? s.turnsLeft },
      text: `«${c.name}»: ${statusRu(s.type)}${(activeStatus?.value ?? s.value) > 1 ? ` (${activeStatus?.value ?? s.value})` : ''}`,
    });
  }

  removeStatus(c: EntityCreature, s: StatusInstance): void {
    const i = c.statuses.indexOf(s);
    if (i >= 0) c.statuses.splice(i, 1);
    if (s.type === StatusType.Freeze) c.frozen = c.statuses.some(x => x.type === StatusType.Freeze);
  }

  silence(c: EntityCreature): void {
    this.addStatus(c, { type: StatusType.Silence, value: 1, turnsLeft: -1 });
  }

  canAttack(c: EntityCreature): boolean {
    if (c.silenced) {
      // немота отключает и рывок/бурю, но не базовую возможность атаки
    }
    if (c.frozen) return false;
    if (c.attack <= 0) return false;
    const maxAttacks = c.keywords.includes(Keyword.Windfury) ? 2 : 1;
    if (c.attacksThisTurn >= maxAttacks) return false;
    if (c.justPlayed && !c.keywords.includes(Keyword.Rush) && !c.statuses.some(s => s.type === StatusType.Fury)) return false;
    return true;
  }

  /* ----------------------------- РУНЫ / РИТУАЛЫ ---------------------------- */

  playRune(side: Side, card: CardData): EntityRune {
    const pl = this.p(side);
    const r: EntityRune = {
      uid: this.nextUid(), cardId: card.id, owner: side, name: card.name,
      faction: card.faction, element: card.element,
      turnsLeft: card.duration ?? -1, data: card, silenced: false,
    };
    pl.runes.push(r);
    this.stats[side].runesPlayed++;
    this.emit({ type: GameEventType.RunePlayed, side, cardId: card.id, cardName: card.name, text: `${pl.name} устанавливает руну «${card.name}»` });
    this.say(`${pl.name}: руна «${card.name}» вступает в силу`, side);

    // Руны с мгновенным эффектом при установке (onPlay)
    const onPlay = (card as any).onPlay as CardEffect[] | undefined;
    if (onPlay && onPlay.length) this.runEffects(onPlay, side, { sourceCard: card, fromRune: true });

    // Постоянные ауры сразу пересчитываются для уже стоящих существ
    const aura = (card as any).aura;
    if (aura) this.applyAuraImmediate(side, aura);
    this.checkDeaths();
    return r;
  }

  private applyAuraImmediate(side: Side, aura: any): void {
    const pl = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const matches = (c: EntityCreature) => !aura.matches || aura.matches.length === 0 || aura.matches.includes(c.element);
    switch (aura.op) {
      case 'buffAttackHealth':
        for (const c of pl.creatures) if (matches(c)) { c.attack += aura.atk ?? 0; c.health += aura.hp ?? 0; c.maxHealth += aura.hp ?? 0; }
        break;
      case 'buffAttack':
        for (const c of pl.creatures) if (matches(c)) c.attack += aura.value ?? 0;
        break;
      case 'buffHealth':
        for (const c of pl.creatures) if (matches(c)) { c.health += aura.value ?? 0; c.maxHealth += aura.value ?? 0; }
        break;
      case 'debuffAttackEnemy':
        for (const c of en.creatures) if (matches(c)) c.attack = Math.max(0, c.attack - (aura.value ?? 0));
        break;
      case 'spellDamage':
        break; // учитывается динамически в spellDamageOf()
      case 'heroProtection':
        break; // учитывается динамически в heroDamageReduction()
      case 'extraMana':
        break; // учитывается в фазе Ресурсов
      case 'extraCard':
        break; // учитывается в фазе Начала
    }
  }

  placeRitual(side: Side, card: CardData, targetUid?: number, targetSide?: Side): void {
    const pl = this.p(side);
    const r: EntityRitual = {
      uid: this.nextUid(), cardId: card.id, owner: side, name: card.name,
      turnsLeft: card.ritualDelay ?? 1, targetUid, targetSide, data: card,
    };
    pl.rituals.push(r);
    this.emit({ type: GameEventType.RitualPlaced, side, cardId: card.id, cardName: card.name, text: `${pl.name} начинает ритуал «${card.name}» (1 ход подготовки)` });
    this.say(`${pl.name}: ритуал «${card.name}» готовится`, side);
  }

  /* ----------------------------- РОЗЫГРЫШ КАРТ ----------------------------- */

  canPlay(side: Side, handIndex: number): { ok: boolean; reason?: string; card?: CardData; needsTarget?: boolean } {
    const pl = this.p(side);
    if (this.result !== GameResult.Ongoing) return { ok: false, reason: 'Игра окончена' };
    if (handIndex < 0 || handIndex >= pl.hand.length) return { ok: false, reason: 'Нет такой карты в руке' };
    const peek = this.db.get(pl.hand[handIndex]);
    const isInstant = !!peek && peek.type === CardType.Spell && peek.subtype === SpellSubtype.Instant;
    // ── MTG: мгновенные заклинания — instant speed ──
    // При наличии маны (проверяется ниже) могут быть разыграны В ЛЮБОЙ МОМЕНТ, когда у вас есть приоритет:
    // в вашу основную фазу, в вашу Битву/Конец, в ход противника (любая фаза), в ответ на заклинание (стек LIFO).
    // Окно отклика 20 с даёт приоритет; вне окна — свободный приоритет между фазами.
    if (isInstant) {
      if (this.instantWindow !== null && this.instantWindow !== side) {
        return { ok: false, reason: 'Сейчас приоритет у противника — дождитесь окна отклика' };
      }
      // иначе — instant speed: фаза/активный игрок не проверяются (только мана/цели ниже)
    } else {
      if (this.instantWindow === side) {
        return { ok: false, reason: 'В окне отклика играются только мгновенные заклинания (⚡)' };
      }
      if (this.instantWindow !== null && this.instantWindow !== side) {
        return { ok: false, reason: 'Сейчас приоритет у противника' };
      }
      if (this.activeSide !== side || this.phase !== Phase.Main) {
        return { ok: false, reason: 'Сейчас не ваша основная фаза — не-мгновенные карты только в свой Main' };
      }
    }
    const card = peek!;
    if (!card) return { ok: false, reason: 'Карта не найдена в базе' };
    if (card.cost > this.availableMana(side)) return { ok: false, reason: 'Недостаточно маны', card };
    if (card.type === CardType.Creature && pl.creatures.length >= this.config.maxCreaturesPerSide) {
      return { ok: false, reason: 'Поле заполнено (7 существ)', card };
    }
    if (card.type === CardType.Rune) {
      const limit = (card as any).runeLimit ?? 3;
      if (pl.runes.length >= limit) return { ok: false, reason: `Максимум рун: ${limit}`, card };
      if (pl.runes.some(r => r.cardId === card.id)) return { ok: false, reason: 'Эта руна уже установлена (уникальна)', card };
    }
    const needsTarget = this.targetRequiresChoice(card.target);
    if (needsTarget && !this.hasValidTarget(side, card)) return { ok: false, reason: 'Нет допустимой цели', card };
    return { ok: true, card, needsTarget };
  }

  availableMana(side: Side): number {
    const pl = this.p(side);
    return pl.mana;
  }

  spendMana(side: Side, amount: number): boolean {
    const pl = this.p(side);
    if (pl.mana < amount) return false;
    pl.mana -= amount;
    this.stats[side].manaSpent += amount;
    this.emit({ type: GameEventType.ManaChanged, side, value: pl.mana, data: { max: pl.maxMana + pl.bonusMana } });
    return true;
  }

  private targetRequiresChoice(target: TargetKind): boolean {
    return target === TargetKind.EnemyCreature || target === TargetKind.FriendlyCreature
      || target === TargetKind.AnyCreature || target === TargetKind.EnemyHero
      || target === TargetKind.FriendlyHero || target === TargetKind.AnyHero;
  }

  needsTarget(side: Side, card: CardData): boolean {
    return this.targetRequiresChoice(card.target) && this.hasValidTarget(side, card);
  }

  hasValidTarget(side: Side, card: CardData): boolean {
    return this.validTargets(side, card).length > 0;
  }

  validTargets(side: Side, card: CardData): { uid?: number; side?: Side; label: string }[] {
    const me = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const out: { uid?: number; side?: number; label: string }[] = [];
    switch (card.target) {
      case TargetKind.None: break;
      case TargetKind.EnemyCreature: for (const c of en.creatures) out.push({ uid: c.uid, side: en.side, label: c.name }); break;
      case TargetKind.FriendlyCreature: for (const c of me.creatures) out.push({ uid: c.uid, side: me.side, label: c.name }); break;
      case TargetKind.AnyCreature:
        for (const c of me.creatures) out.push({ uid: c.uid, side: me.side, label: c.name });
        for (const c of en.creatures) out.push({ uid: c.uid, side: en.side, label: c.name });
        break;
      case TargetKind.EnemyHero: out.push({ side: en.side, label: en.name }); break;
      case TargetKind.FriendlyHero: out.push({ side: me.side, label: me.name }); break;
      case TargetKind.AnyHero: out.push({ side: me.side, label: me.name }); out.push({ side: en.side, label: en.name }); break;
      default: break; // массовые цели не требуют выбора
    }
    return out as any;
  }

  playCard(side: Side, handIndex: number, targetUid?: number, targetSide?: Side): boolean {
    const check = this.canPlay(side, handIndex);
    if (!check.ok || !check.card) { this.say(`Нельзя разыграть: ${check.reason}`, side); return false; }
    const card = check.card;
    const pl = this.p(side);

    // Цель всегда должна быть выбрана из актуального списка. Не подменяем
    // ошибочный/устаревший выбор «первой попавшейся» целью.
    if (check.needsTarget) {
      const valid = this.validTargets(side, card);
      const chosen = valid.find(v => v.uid === targetUid
        && (targetSide === undefined || v.side === targetSide))
        ?? (targetUid === undefined && targetSide !== undefined
          ? valid.find(v => v.uid === undefined && v.side === targetSide) : undefined);
      if (!chosen) {
        this.say('Нужно выбрать допустимую цель', side);
        return false;
      }
      targetUid = chosen.uid;
      targetSide = chosen.side as Side;
    }

    pl.hand.splice(handIndex, 1);
    if (card.cost > 0) this.spendMana(side, card.cost);
    pl.cardsPlayedThisTurn++;
    this.stats[side].cardsPlayed++;
    this.emit({ type: GameEventType.CardPlayed, side, cardId: card.id, cardName: card.name, value: card.cost });

    switch (card.type) {
      case CardType.Creature:
        this.summon(side, card, { fromHand: true, targetUid, targetSide });
        break;
      case CardType.Rune:
        this.playRune(side, card);
        break;
      case CardType.Spell:
        if (card.subtype === SpellSubtype.Ritual) {
          pl.spellsCastThisTurn++;
          this.stats[side].spellsCast++;
          this.emit({ type: GameEventType.SpellCast, side, cardId: card.id, cardName: card.name, text: `${pl.name} разыгрывает ритуал «${card.name}»` });
          this.factionOnSpellCast(side, card);
          this.placeRitual(side, card, targetUid, targetSide);
        } else {
          this.stack.push({ side, card, targetUid, targetSide });
          this.emit({ type: GameEventType.StackPushed, side, cardId: card.id, cardName: card.name,
            text: `В стек: «${card.name}»` });
          if (!this.interactiveStack) this.resolveStackTop();   // симы: без окон
        }
        break;
    }
    this.checkDeaths();
    return true;
  }

  /** Мгновенное заклинание: резолв эффектов + учёт для Эха и пассивок. */
  castInstantSpell(side: Side, card: CardData, targetUid?: number, targetSide?: Side,
    opts: { fromHand?: boolean; isEchoCopy?: boolean } = {}): void {
    const pl = this.p(side);
    pl.spellsCastThisTurn++;
    this.stats[side].spellsCast++;
    pl.lastSpellCast = { cardId: card.id, targetUid, targetSide };
    this.emit({
      type: opts.isEchoCopy ? GameEventType.SpellCopied : GameEventType.SpellCast,
      side, cardId: card.id, cardName: card.name, targetUid, targetSide,
      text: `${pl.name} ${opts.isEchoCopy ? 'ЭХОм повторяет' : 'разыгрывает'} «${card.name}»`,
    });
    this.say(`${pl.name}: заклинание «${card.name}»${opts.isEchoCopy ? ' (Эхо)' : ''}`, side);

    // Помечаем, что урон сейчас наносит заклинание: слой представления по этому
    // флагу и по sourceElement выбирает VFX (docs/VISUAL_STACK.md, раздел 6).
    this.spellSourceCard = card;
    this.runEffects(card.effects ?? [], side, { sourceCard: card, targetUid, targetSide, fromSpell: true });
    this.spellSourceCard = null;
    this.factionOnSpellCast(side, card);
    pl.graveyard.push(card.id);
    this.checkDeaths();
  }

  /** Пассивка Пиромантов: -1 здоровье за каждое разыгранное заклинание. */
  private factionOnSpellCast(side: Side, card: CardData): void {
    const pl = this.p(side);
    if (pl.faction === Faction.Pyromancer) {
      // Пассивка Пиромантов: −1 здоровье за каждое разыгранное заклинание (без порога —
      // плата постоянна), но бонус урона растёт с ценой заклинания, поэтому
      // «спам дешёвых» невыгоден, а «дорогой выстрел» окупается.
      const selfDmg = this.pround(1 * this.passiveMul(Faction.Pyromancer));
      if (selfDmg > 0) {
        this.damageHero(side, selfDmg, { source: 'Пламя возмездия', ignoreReduction: true });
        this.say(`Пламя возмездия: Пиромант теряет ${selfDmg} здоровья`, side);
      }
    }
    // Триггеры «при розыгрыше заклинания» у существ и рун
    for (const c of pl.creatures) {
      if (c.silenced || !c.data.onSpellCast?.length) continue;
      this.runEffects(c.data.onSpellCast, side, { sourceUid: c.uid, sourceCard: c.data });
    }
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const osc = (r.data as any).onSpellCast as CardEffect[] | undefined;
      if (osc?.length) this.runEffects(osc, side, { sourceCard: r.data, fromRune: true });
    }
  }

  /* ----------------------------- МЕХАНИКА «ЭХО» ---------------------------- */

  canUseEcho(side: Side): { ok: boolean; reason?: string; card?: CardData } {
    const pl = this.p(side);
    if (this.activeSide !== side || this.phase !== Phase.Main) return { ok: false, reason: 'Эхо доступно только в вашу основную фазу' };
    if (pl.echoPoints <= 0) return { ok: false, reason: 'Нет Эхо-очков' };
    if (pl.echoUsedThisGame >= this.config.echoUsagesPerGame) return { ok: false, reason: 'Эхо уже использовано в этой игре' };
    if (!pl.lastSpellCast) return { ok: false, reason: 'Вы ещё не разыгрывали заклинаний' };
    const card = this.db.get(pl.lastSpellCast.cardId);
    if (!card) return { ok: false, reason: 'Повторяемое заклинание недоступно' };
    if (card.subtype === SpellSubtype.Ritual) return { ok: false, reason: 'Эхо не повторяет ритуалы' };
    return { ok: true, card };
  }

  useEcho(side: Side, targetUid?: number, targetSide?: Side): boolean {
    const chk = this.canUseEcho(side);
    if (!chk.ok || !chk.card) { this.say(`Эхо недоступно: ${chk.reason}`, side); return false; }
    const pl = this.p(side);
    const card = chk.card;
    let tUid = pl.lastSpellCast?.targetUid;
    let tSide = pl.lastSpellCast?.targetSide;
    // Цель должна быть жива; иначе — авто-выбор валидной или розыгрыш без цели
    if (tUid !== undefined && !this.uidMap.has(tUid)) {
      const valid = this.validTargets(side, card);
      tUid = valid[0]?.uid; tSide = valid[0]?.side as Side;
    }
    if (targetUid !== undefined) { tUid = targetUid; tSide = targetSide ?? tSide; }

    pl.echoPoints -= 1;
    pl.echoUsedThisGame += 1;
    this.stats[side].echoUsed++;
    this.emit({ type: GameEventType.EchoSpent, side, cardId: card.id, cardName: card.name, text: `${pl.name} тратит Эхо-очко и повторяет «${card.name}» бесплатно` });
    this.castInstantSpell(side, card, tUid, tSide, { isEchoCopy: true });
    return true;
  }

  /* ----------------------------- ФАЗЫ ХОДА --------------------------------- */

  /** Полный цикл хода активного игрока. */
  runTurn(): void {
    if (this.result !== GameResult.Ongoing) return;
    this.closeInstantWindow();
    this.turnsTaken[this.activeSide]++;
    if (this.activeSide === Side.Player) this.turn++;
    const pl = this.active();

    pl.spellsCastThisTurn = 0;
    pl.cardsPlayedThisTurn = 0;
    for (const c of pl.creatures) { c.attacksThisTurn = 0; c.unblockableThisTurn = false; }

    this.setPhase(Phase.Start);    this.doStartPhase();
    if (this.result !== GameResult.Ongoing) return;
    this.setPhase(Phase.Resource); this.doResourcePhase();
    if (this.result !== GameResult.Ongoing) return;
    this.setPhase(Phase.Main);     // основную фазу ведёт контроллер (человек или AI)
  }

  /** Сторона, держащая приоритет в окне отклика (MTG: instant speed). */
  instantWindow: Side | null = null;

  /* ------------------------- СТЕК (LIFO) ------------------------- */
  /** Интерактивный стек: true в бою с UI-окнами; false в симах (авто-резолв). */
  interactiveStack = false;
  stack: Array<{ side: Side; card: CardData; targetUid?: number; targetSide?: Side }> = [];

  /** Резолв вершины стека; возвращает true, если стек ещё не пуст. */
  resolveStackTop(): boolean {
    const en = this.stack.pop();
    if (!en) return false;
    this.castInstantSpell(en.side, en.card, en.targetUid, en.targetSide, { fromHand: false } as never);
    this.emit({ type: GameEventType.StackResolved, side: en.side, cardId: en.card.id, cardName: en.card.name,
      text: `Стек резолвится: «${en.card.name}»` });
    this.checkDeaths();
    return this.stack.length > 0;
  }

  /** Пас приоритета в стеке: резолв вершины (LIFO). */
  passStack(side: Side): boolean {
    void side;
    if (this.stack.length === 0) return false;
    return this.resolveStackTop();
  }

  openInstantWindow(side: Side): void {
    if (this.result !== GameResult.Ongoing) return;
    this.instantWindow = side;
    this.emit({ type: GameEventType.InstantWindow, side, turn: this.turn,
      text: `Окно отклика: приоритет у ${side === Side.Player ? 'игрока' : 'противника'}` });
  }

  closeInstantWindow(): void {
    if (this.instantWindow === null) return;
    const side = this.instantWindow;
    this.instantWindow = null;
    this.emit({ type: GameEventType.InstantWindowClosed, side, turn: this.turn, text: 'Приоритет возвращён' });
  }

  private setPhase(ph: Phase): void {
    this.phase = ph;
    this.emit({ type: GameEventType.PhaseChanged, side: this.activeSide, phase: ph, turn: this.turn, text: `Фаза: ${ph}` });
  }

  /* --- 1. НАЧАЛО --- */
  private doStartPhase(): void {
    const side = this.activeSide;
    const pl = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);

    // 1.1 Руны владельца активируются
    for (const r of [...pl.runes]) {
      if (r.silenced) continue;
      const tick = (r.data as any).onTurnStart as CardEffect[] | undefined;
      if (tick?.length) {
        this.emit({ type: GameEventType.RuneTick, side, cardId: r.cardId, cardName: r.name, text: `Руна «${r.name}» пульсирует` });
        this.runEffects(tick, side, { sourceCard: r.data, fromRune: true });
      }
      const aura = (r.data as any).aura as any;
      if (aura?.op === 'extraCard') {
        for (let i = 0; i < (aura.value ?? 1); i++) this.draw(side, { source: r.name });
      }
    }
    // 1.2 Руны противника, действующие «в начале хода владельца» — уже отработали в его ход.
    //     Здесь обрабатываем только те, что помечены onEnemyTurnStart.
    for (const r of [...en.runes]) {
      if (r.silenced) continue;
      const t = (r.data as any).onEnemyTurnStart as CardEffect[] | undefined;
      if (t?.length) this.runEffects(t, en.side, { sourceCard: r.data, fromRune: true });
    }

    // 1.3 Пассивки фракций на начало хода
    //     Эфирные «Иллюзорная тень»: случайное существо с наименьшей атакой не блокируется
    if (pl.faction === Faction.Ethereal && pl.creatures.length > 0) {
      // Пассивка Эфирных «Иллюзорная тень» (редакция ТЗ п.2.5.5):
      // в начале хода ОДНО ваше существо с наименьшей атакой становится неуловимым,
      // но срабатывает это с вероятностью 50% (иллюзия нестабильна).
      // Обоснование: в авто-бою гарантированная неуловимость = бесплатный урон в героя
      // каждый ход, что ломает баланс сильнее любого заклинания.
      const rate = 0.5;
      const count = this.pround(rate * this.passiveMul(Faction.Ethereal));
      const sorted = [...pl.creatures].sort((a, b) => a.attack - b.attack);
      const minAtk = sorted[0].attack;
      let pool = sorted.filter(c => c.attack === minAtk);
      const chosen: EntityCreature[] = [];
      for (let i = 0; i < count; i++) {
        if (pool.length === 0) pool = sorted.filter(c => !chosen.includes(c));
        if (pool.length === 0) break;
        const pick = this.rng.pick(pool);
        pick.unblockableThisTurn = true;
        chosen.push(pick);
        pool = pool.filter(c => c !== pick);
      }
      if (chosen.length) {
        this.say(`Иллюзорная тень: ${chosen.map(c => `«${c.name}»`).join(', ')} неуловимы в этом ходу`, side);
      }
    }

    // 1.4 Статусы существ владельца (горение, яд-тик) и сброс болезни призыва
    for (const c of [...pl.creatures]) {
      c.justPlayed = c.summonedOnTurn >= this.turnsTaken[side];
      // Горение
      const burn = c.statuses.find(s => s.type === StatusType.Burn);
      if (burn && !c.silenced) {
        this.damageCreature(c, burn.value, { source: 'Горение', pierceShield: true, sourceCardId: burn.sourceCardId });
        if (burn.turnsLeft > 0) {
          burn.turnsLeft--;
          if (burn.turnsLeft <= 0) this.removeStatus(c, burn);
        }
      }
      // Триггеры существ на начало хода
      if (!c.silenced && c.data.onTurnStart?.length) {
        this.runEffects(c.data.onTurnStart, side, { sourceUid: c.uid, sourceCard: c.data });
      }
    }

    // 1.5 Ритуалы: отсчёт и резолв
    for (const rt of [...pl.rituals]) {
      rt.turnsLeft--;
      if (rt.turnsLeft <= 0) {
        pl.rituals.splice(pl.rituals.indexOf(rt), 1);
        pl.graveyard.push(rt.cardId);
        this.emit({ type: GameEventType.RitualResolved, side, cardId: rt.cardId, cardName: rt.name, text: `Ритуал «${rt.name}» завершён` });
        this.say(`${pl.name}: ритуал «${rt.name}» разрешается`, side);
        this.runEffects(rt.data.effects ?? [], side, { sourceCard: rt.data, targetUid: rt.targetUid, targetSide: rt.targetSide, fromSpell: true });
        this.factionOnSpellCast(side, rt.data);
      }
    }

    this.checkDeaths();
  }

  /* --- 2. РЕСУРСЫ --- */
  private doResourcePhase(): void {
    const side = this.activeSide;
    const pl = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);

    // +1 к максимуму маны (до 10)
    if (pl.maxMana < this.config.maxMana) pl.maxMana++;

    // (бонусная мана Терраморфов считается в computeBonusMana с учётом множителя пассивки)

    // Бонусная мана: пассивка Терраморфов + ауры рун (считается заново каждый ход)
    pl.bonusMana = this.computeBonusMana(side);

    const totalMax = Math.min(this.config.maxMana, pl.maxMana + pl.bonusMana);
    pl.mana = totalMax; // полное восполнение

    // Аура «лишний добор»
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (aura?.op === 'drawOnResource') for (let i = 0; i < (aura.value ?? 1); i++) this.draw(side, { source: r.name });
    }

    this.emit({ type: GameEventType.ManaChanged, side, value: pl.mana, data: { max: totalMax }, text: `${pl.name}: ${pl.mana}/${totalMax} маны` });

    // Обычный добор карты в начале хода
    this.draw(side, { source: 'Ход' });
    this.checkDeaths();
    void en;
  }

  /**
   * Число стартовых ходов Терраморфов, в которые нельзя атаковать (ТЗ: 3).
   * При балансировочном множителе <1 «мирный» период probabilistically короче.
   */
  terramorphPeaceTurns(side: Side): number {
    const pl = this.p(side);
    if (pl.faction !== Faction.Terramorph) return 0;
    return this.pround(3 * this.passiveMul(Faction.Terramorph));
  }

  private computeBonusMana(side: Side): number {
    const pl = this.p(side);
    let bonus = 0;
    // Пассивка Терраморфов «Корни земли»: +1 мана сверх обычного прироста
    // Пассивка Терраморфов «Корни земли» (редакция ТЗ п.2.5.3):
    // +1 к максимуму маны сверх обычного прироста (всегда), но первые 3 своих хода
    // существа Терраморфов не могут атаковать. Рампа постоянна — ограничение и есть цена.
    if (pl.faction === Faction.Terramorph) {
      bonus += this.pround(1 * this.passiveMul(Faction.Terramorph));
    }
    for (const r of pl.runes) {
      if (r.silenced) continue;
      const aura = (r.data as any).aura as any;
      if (aura?.op === 'extraMana') bonus += aura.value ?? 1;
    }
    return bonus;
  }

  /* --- 3. ОСНОВНАЯ --- (управляется контроллером; движок лишь исполняет действия) */

  /** Контроллер сообщает, что основная фаза завершена -> переходим к Битве. */
  /** UI: вход в фазу боя БЕЗ авто-разрешения — окно объявления атак стрелкой. */
  enterCombatPhase(): void {
    if (this.phase !== Phase.Main || this.result !== GameResult.Ongoing) return;
    this.setPhase(Phase.Combat);
  }

  finishMainPhase(): void | Promise<void> {
    if (this.phase === Phase.Main) this.setPhase(Phase.Combat);
    if (this.phase !== Phase.Combat || this.result !== GameResult.Ongoing) return;
    this.doCombatPhase();
    // Правила боя разрешаются синхронно, но фаза End/передача приоритета ждёт
    // очередь VFX: иначе число HP/ход ИИ перескакивали анимацию удара.
    const animation = this.runCombatAnimations();
    if (animation) return animation.then(
      () => this.completeMainPhase(),
      err => { this.completeMainPhase(); throw err; },
    );
    this.completeMainPhase();
  }

  private completeMainPhase(): void {
    if (this.result !== GameResult.Ongoing) return;
    this.setPhase(Phase.End);
    this.doEndPhase();
    if (this.result !== GameResult.Ongoing) return;
    this.emit({ type: GameEventType.TurnEnded, side: this.activeSide, turn: this.turn });
    this.activeSide = this.opponentSide;
    this.emit({ type: GameEventType.TurnStarted, side: this.activeSide, turn: this.turn + 1 });
  }

  /* --- Публичные обёртки для контроллеров/UI (движок остаётся источником истины). --- */
  /**
   * Очередь атак фазы «Битва». UI-контроллер читает её ПОСЛЕ синхронного
   * исполнения боя и проигрывает анимации в правильном порядке (ТЗ п.6.2).
   * Каждый элемент содержит состояние атакующего и защитника ДО удара —
   * этого достаточно, чтобы корректно показать полёт, тряску и числа урона.
   */
  attackQueue: {
    attackerUid: number; attackerSide: Side; attackerName: string;
    defenderUid?: number; defenderName?: string; hitHero: boolean;
    attackerBefore: { hp: number }; defenderBefore?: { hp: number };
    heroDamage: number; defenderDamage: number; attackerDamage: number;
    lifesteal: boolean; lifestealAmount: number;
    attackerAfter: { hp: number }; defenderAfter?: { hp: number };
  }[] = [];
  /**
   * Хок проигрывания анимаций после фазы «Битва» (используется HTML-прототипом).
   * Движок остаётся синхронным и детерминированным: бой уже разрешён,
   * а UI лишь показывает queue последовательно. В headless-симуляциях хук не задан.
   */
  onBeforeCombatEnd: ((queue: GameEngine['attackQueue']) => Promise<void> | void) | null = null;
  private runCombatAnimations(): Promise<void> | null {
    if (!this.onBeforeCombatEnd) return null;
    const q = this.attackQueue;
    this.attackQueue = [];
    this.animating = true;
    let result: Promise<void>;
    try { result = Promise.resolve(this.onBeforeCombatEnd(q)); }
    catch (err) { result = Promise.reject(err); }
    return result.finally(() => { this.animating = false; });
  }
  /** True, пока UI проигрывает анимации боя (контроллеры могут ждать этого флага). */
  animating = false;
  /** Флаг пропуска авто-боя в ручном режиме — игрок объявил «Пропустить бой» в окне атаки. */
  manualCombatSkip = false;

  /* --- 4. БИТВА --- */
  private doCombatPhase(): void {
    this.attackQueue = [];
    if (this.config.combatMode === 'manual' && this.manualCombatSkip) {
      this.manualCombatSkip = false;
      this.say('Бой пропущен: атакующие не объявлены', this.activeSide);
      return;
    }
    this.manualCombatSkip = false;
    const side = this.activeSide;
    const pl = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);

    // Пассивка Терраморфов: первые N ходов нельзя атаковать (ТЗ: 3)
    const peace = this.terramorphPeaceTurns(side);
    if (peace > 0 && this.turnsTaken[side] <= peace) {
      this.say(`Корни земли: Терраморфы не могут атаковать в первые ${peace} ход(а)`, side);
      return;
    }

    const attackers = pl.creatures.filter(c => this.canAttack(c));
    // Порядок атаки: сначала неуловимые/быстрые, затем по убыванию атаки
    attackers.sort((a, b) => (b.attack - a.attack) || (a.uid - b.uid));

    for (const atk of attackers) {
      if (this.result !== GameResult.Ongoing) return;
      const maxAttacks = atk.keywords.includes(Keyword.Windfury) ? 2 : 1;
      for (let i = 0; i < maxAttacks; i++) {
        if (!this.canAttack(atk) || !pl.creatures.includes(atk)) break;
        const target = this.chooseAutoTarget(side, atk);
        this.resolveAttack(atk, target.creature, target.hitHero ? en : undefined);
        atk.attacksThisTurn++;
        this.checkDeaths();
        if (this.result !== GameResult.Ongoing) return;
      }
    }
  }

  /**
   * Авто-выбор цели (ТЗ 2.2, фаза «Битва»):
   *  1) если у противника есть существа с Провокацией — бьём существо с наименьшим здоровьем среди них;
   *  2) иначе — существо с наименьшим здоровьем (неуловимые игнорируются);
   *  3) если существ нет (или все неуловимы) — атака героя.
   */
  chooseAutoTarget(side: Side, attacker: EntityCreature): { creature?: EntityCreature; hitHero: boolean } {
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const candidates = en.creatures.filter(c =>
      !c.unblockableThisTurn && !c.keywords.includes(Keyword.Unblockable));
    if (candidates.length === 0) return { hitHero: true };
    const taunts = candidates.filter(c => !c.silenced && c.keywords.includes(Keyword.Taunt));
    const pool = taunts.length > 0 ? taunts : candidates;
    pool.sort((a, b) => (a.health - b.health) || (a.attack - b.attack) || (a.uid - b.uid));
    return { creature: pool[0], hitHero: false };
  }

  resolveAttack(attacker: EntityCreature, defender?: EntityCreature, enemyHero?: PlayerState): void {
    const rec = {
      attackerUid: attacker.uid, attackerSide: attacker.owner, attackerName: attacker.name,
      defenderUid: defender?.uid, defenderName: defender?.name,
      hitHero: !!enemyHero,
      attackerBefore: { hp: attacker.health },
      defenderBefore: defender ? { hp: defender.health } : undefined,
      heroDamage: 0, defenderDamage: 0, attackerDamage: 0,
      lifesteal: !attacker.silenced && attacker.keywords.includes(Keyword.Lifesteal), lifestealAmount: 0,
      attackerAfter: { hp: 0 }, defenderAfter: defender ? { hp: 0 } : undefined,
    };
    if (attacker.attack <= 0) return;
    rec.attackerSide = attacker.owner;
    const ownerSide = attacker.owner;
    const attackerBeforeHp = attacker.health;
    const lifesteal = !attacker.silenced && attacker.keywords.includes(Keyword.Lifesteal);

    if (defender) {
      this.emit({
        type: GameEventType.CreatureAttacks, uid: attacker.uid, side: ownerSide, targetUid: defender.uid,
        cardName: attacker.name, value: attacker.attack,
        text: `«${attacker.name}» атакует «${defender.name}»`,
      });
      // Ответный урон
      const counter = defender.attack;
      const defHpBefore = defender.health;
      const dealt = this.damageCreature(defender, attacker.attack, { source: attacker.name, sourceCardId: attacker.cardId });
      const dealtToCreature = Math.min(dealt, Math.max(0, defHpBefore));
      if (dealtToCreature > 0 && lifesteal) {
        const hpBeforeHeal = this.p(ownerSide).health;
        this.healHero(ownerSide, dealtToCreature, { source: 'Вампиризм' });
        rec.lifestealAmount += Math.max(0, this.p(ownerSide).health - hpBeforeHeal);
      }
      // v2.12.2: Ядовитый / Ледяное касание — доп. статусы при успешном уроне
      if (dealt > 0 && !attacker.silenced && defender.health > 0) {
        if (attacker.keywords.includes(Keyword.Poisonous)) {
          this.addStatus(defender, { type: StatusType.Poison, value: 1, turnsLeft: -1 });
          this.say(`Ядовитый: «${defender.name}» отравлен «${attacker.name}»`, defender.owner);
        }
        if (attacker.keywords.includes(Keyword.Freezing)) {
          this.addStatus(defender, { type: StatusType.Freeze, value: 1, turnsLeft: 1 });
          defender.frozen = true;
          this.say(`Ледяное касание: «${defender.name}» заморожен`, defender.owner);
        }
      }
      if (counter > 0 && this.uidMap.has(attacker.uid)) {
        this.damageCreature(attacker, counter, { source: defender.name, sourceCardId: defender.cardId });
      }
      if (dealt > 0) this.stats[ownerSide].kills += defender.health <= 0 ? 1 : 0;
      // Прорыв: избыток урона над убитым блокёром уходит в героя защитника
      if (dealt > 0 && defender.health <= 0 && !attacker.silenced
          && attacker.keywords.includes(Keyword.Trample)) {
        const excess = attacker.attack - Math.min(dealt, defHpBefore);
        if (excess > 0) {
          const hero = this.p(defender.owner);
          const hpBeforeHeal = this.p(ownerSide).health;
          const hd = this.damageHero(hero.side, excess, {
            source: `${attacker.name} (Прорыв)`, sourceCardId: attacker.cardId,
            lifestealFor: lifesteal ? ownerSide : undefined,
          });
          if (lifesteal) rec.lifestealAmount += Math.max(0, this.p(ownerSide).health - hpBeforeHeal);
          rec.heroDamage = hd;
          rec.hitHero = hd > 0;
        }
      }
      rec.defenderDamage = dealt;
      rec.attackerDamage = Math.max(0, attackerBeforeHp - attacker.health);
      rec.defenderAfter = { hp: Math.max(0, defender.health) };
      rec.attackerAfter = { hp: Math.max(0, attacker.health) };
      this.attackQueue.push(rec);
    } else if (enemyHero) {
      const dmg = attacker.attack;
      this.emit({
        type: GameEventType.CreatureAttacks, uid: attacker.uid, side: ownerSide, cardName: attacker.name,
        value: dmg, text: `«${attacker.name}» атакует героя ${enemyHero.name}`,
      });
      const hpBeforeHeal = this.p(ownerSide).health;
      const dealt = this.damageHero(enemyHero.side, dmg, { source: attacker.name, sourceCardId: attacker.cardId, lifestealFor: lifesteal ? ownerSide : undefined });
      if (lifesteal) rec.lifestealAmount = Math.max(0, this.p(ownerSide).health - hpBeforeHeal);
      // Прорыв не нужен при прямой атаке героя; урон уже нанесён
      rec.heroDamage = dealt;
      rec.attackerAfter = { hp: Math.max(0, attacker.health) };
      this.attackQueue.push(rec);
    }
  }

  /** Ручная атака (режим manual — для PvP/расширений). Правила: бить существо обязательно только если у противника есть Провокация (Taunt) или карта прямо указывает «обязана атаковать существо»; во всех остальных случаях можно бить героя. */
  manualAttack(side: Side, uid: number, targetUid?: number, targetHero = false): boolean {
    if (this.config.combatMode !== 'manual') return false;
    const c = this.findCreature(uid);
    if (!c || c.owner !== side || !this.canAttack(c)) return false;
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const taunts = en.creatures.filter(t => !t.silenced && (t.keywords ?? []).includes(Keyword.Taunt));
    const hasTaunt = taunts.length > 0;
    // особая пометка карты «бьёт только существо» — считаем как условная провокация
    const mustHitCreature = !!(c.data as any).mustHitCreature;
    if (targetHero) {
      if (hasTaunt || mustHitCreature) return false;
      this.resolveAttack(c, undefined, en); c.attacksThisTurn++; this.checkDeaths(); return true;
    }
    const t = targetUid !== undefined ? this.findCreature(targetUid) : undefined;
    if (!t || t.owner === side) return false;
    if (hasTaunt && !taunts.includes(t)) return false;
    this.resolveAttack(c, t); c.attacksThisTurn++; this.checkDeaths();
    return true;
  }

  /**
   * Универсальный исполнитель действия (используется AI и UI-контроллером).
   * Возвращает true, если действие принято и изменило состояние.
   */
  playAIFallback(action: GameAction, side: Side): boolean {
    switch (action.type) {
      case 'playCard':  return this.playCard(side, action.handIndex, action.targetUid, action.targetSide);
      case 'useEcho':   return this.useEcho(side, action.targetUid, action.targetSide);
      case 'manualAttack': return this.manualAttack(side, action.uid, action.targetUid, action.targetHero);
      case 'endTurn':
        if (this.phase !== Phase.Main || this.activeSide !== side) return false;
        this.finishMainPhase();
        return true;
      case 'mulliganKeep':
        this.mulligan(side, action.keepIndices);
        return true;
      case 'activate':
        return false; // активируемые способности существ: расширение (см. docs/EXTENSIONS.md)
      default:
        return false;
    }
  }

  /* --- 5. КОНЕЦ --- */
  private doEndPhase(): void {
    const side = this.activeSide;
    const pl = this.p(side);

    // Эхо-очко, если за ход не разыграно ни одного ЗАКЛИНАНИЯ
    if (pl.spellsCastThisTurn === 0) {
      pl.echoPoints = Math.min(this.config.echoPointsMax, pl.echoPoints + 1);
      this.stats[side].echoGained++;
      this.emit({ type: GameEventType.EchoGained, side, text: `${pl.name} получает Эхо-очко (всего ${pl.echoPoints})` });
      this.say(`${pl.name}: Эхо-очко получено (заклинаний не было)`, side);
    }

    // Истечение временных эффектов
    for (const c of [...pl.creatures]) {
      for (const s of [...c.statuses]) {
        if (s.turnsLeft > 0) {
          s.turnsLeft--;
          if (s.turnsLeft <= 0) {
            this.removeStatus(c, s);
            this.emit({ type: GameEventType.StatusExpired, uid: c.uid, side, cardName: c.name,
              data: { status: s.type }, text: `«${c.name}»: ${statusRu(s.type)} рассеивается` });
          }
        }
      }
      // Заморозка снимается в конце хода владельца
      c.frozen = c.statuses.some(s => s.type === StatusType.Freeze);
      c.attacksThisTurn = 0;
      c.unblockableThisTurn = false;
      // Эффекты «в конце хода»
      if (!c.silenced && c.data.onTurnEnd?.length) this.runEffects(c.data.onTurnEnd, side, { sourceUid: c.uid, sourceCard: c.data });
    }

    // Срок жизни рун
    for (const r of [...pl.runes]) {
      if (r.turnsLeft > 0) {
        r.turnsLeft--;
        if (r.turnsLeft <= 0) {
          pl.runes.splice(pl.runes.indexOf(r), 1);
          pl.graveyard.push(r.cardId);
          this.emit({ type: GameEventType.RuneExpired, side, cardId: r.cardId, cardName: r.name, text: `Руна «${r.name}» угасает` });
        }
      }
    }

    // Временная защита героя держится до конца следующего хода противника.
    // Таймер уменьшается на конце чужого хода, а не сразу после розыгрыша.
    const guarded = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    if (guarded.incomingDamageReductionTurns > 0) {
      guarded.incomingDamageReductionTurns--;
      if (guarded.incomingDamageReductionTurns === 0) guarded.damageReduction = 0;
    }

    this.checkDeaths();

    // Усталость при пустой колоде проверяется при доборе (draw), дополнительно — здесь
    if (pl.deck.length === 0) {
      this.say(`${pl.name}: колода пуста, следующий добор нанесёт урон`, side);
    }
  }

  private endGame(result: GameResult): void {
    if (this.result !== GameResult.Ongoing) return;
    this.result = result;
    this.emit({ type: GameEventType.GameOver, result, text: resultText(result) });
  }

  forceDrawCheck(): void {
    if (this.turn > this.config.maxTurns && this.result === GameResult.Ongoing) {
      this.endGame(GameResult.Draw);
    }
  }

  /* ----------------------------- ЭФФЕКТЫ ---------------------------------- */

  runEffects(effects: CardEffect[], side: Side, ctx: {
    sourceUid?: number; sourceCard?: CardData; targetUid?: number; targetSide?: Side;
    fromSpell?: boolean; fromRune?: boolean; isBattlecry?: boolean; isDeathrattle?: boolean;
  } = {}): void {
    for (const eff of effects) this.applyEffect(eff, side, ctx);
  }

  private condOk(cond: EffectCondition | undefined, side: Side): boolean {
    if (!cond) return true;
    const me = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    if (cond.heroHealthAtMost !== undefined && me.health > cond.heroHealthAtMost) return false;
    if (cond.heroHealthAtLeast !== undefined && me.health < cond.heroHealthAtLeast) return false;
    if (cond.enemyCreaturesAtLeast !== undefined && en.creatures.length < cond.enemyCreaturesAtLeast) return false;
    if (cond.friendlyCreaturesAtLeast !== undefined && me.creatures.length < cond.friendlyCreaturesAtLeast) return false;
    if (cond.handSizeAtMost !== undefined && me.hand.length > cond.handSizeAtMost) return false;
    if (cond.handSizeAtLeast !== undefined && me.hand.length < cond.handSizeAtLeast) return false;
    if (cond.turnAtLeast !== undefined && this.turnsTaken[side] < cond.turnAtLeast) return false;
    if (cond.hasRune && !me.runes.some(r => r.cardId === cond.hasRune)) return false;
    if (cond.enemyHasRune && !en.runes.some(r => r.cardId === cond.enemyHasRune)) return false;
    if (cond.chance !== undefined && !this.rng.chance(cond.chance)) return false;
    return true;
  }

  applyEffect(eff: CardEffect, side: Side, ctx: {
    sourceUid?: number; sourceCard?: CardData; targetUid?: number; targetSide?: Side;
    fromSpell?: boolean; fromRune?: boolean; isBattlecry?: boolean; isDeathrattle?: boolean;
  }): void {
    if (!this.condOk(eff.if, side)) return;
    const me = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    const isSpellDamage = ctx.fromSpell === true;
    const srcCost = ctx.sourceCard?.cost;
    const repeat = eff.repeat ?? 1;

    for (let i = 0; i < repeat; i++) {
      switch (eff.op) {
        case 'damage': {
          const base = eff.value ?? 0;
          const amt = isSpellDamage ? base + this.spellDamageOf(side, ctx.sourceCard?.element ?? Element.None, srcCost) : base;
          const t = this.resolveTarget(side, eff.to, eff.filter, { ...ctx, sourceCard: ctx.sourceCard });
          if (amt <= 0 || t.invalid) break;
          if (t.creatures.length) for (const c of t.creatures) this.damageCreature(c, amt, { source: ctx.sourceCard?.name, fromSpell: isSpellDamage, sourceCardId: ctx.sourceCard?.id });
          else if (t.heroSide !== undefined) this.damageHero(t.heroSide, amt, { source: ctx.sourceCard?.name, sourceCardId: ctx.sourceCard?.id, fromSpell: isSpellDamage });
          else if (t.allowHeroFallback) this.damageHero(en.side, amt, { source: ctx.sourceCard?.name, sourceCardId: ctx.sourceCard?.id, fromSpell: isSpellDamage });
          break;
        }
        case 'heal': {
          const t = this.resolveTarget(side, eff.to, eff.filter, { ...ctx, sourceCard: ctx.sourceCard });
          const amt = eff.value ?? 0;
          if (t.invalid) break;
          if (t.creatures.length) for (const c of t.creatures) this.healCreature(c, amt, ctx.sourceCard?.id);
          else if (t.heroSide !== undefined) this.healHero(t.heroSide, amt, { source: ctx.sourceCard?.name, sourceCardId: ctx.sourceCard?.id });
          else if (t.allowHeroFallback) this.healHero(side, amt, { source: ctx.sourceCard?.name, sourceCardId: ctx.sourceCard?.id });
          break;
        }
        case 'draw': for (let k = 0; k < (eff.value ?? 1); k++) this.draw(side, { source: ctx.sourceCard?.name }); break;
        case 'opponentDraw': for (let k = 0; k < (eff.value ?? 1); k++) this.draw(en.side, { source: ctx.sourceCard?.name }); break;
        case 'mill': {
          for (let k = 0; k < (eff.value ?? 1); k++) {
            if (en.deck.length > 0) { const c = en.deck.shift()!; en.graveyard.push(c); this.emit({ type: GameEventType.CardDiscarded, side: en.side, cardId: c, text: `${en.name} сбрасывает карту` }); }
          }
          break;
        }
        case 'destroyCreature': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.EnemyCreature, eff.filter, ctx);
          for (const c of t.creatures) { c.health = 0; this.markDeath(c); }
          break;
        }
        case 'buffAttack':
        case 'buffHealth':
        case 'debuffAttack':
        case 'debuffHealth':
        case 'setAttack': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.AnyCreature, eff.filter, ctx);
          for (const c of t.creatures) {
            const v = eff.value ?? 0;
            if (eff.op === 'buffAttack') { c.attack += v; }
            if (eff.op === 'buffHealth') { c.maxHealth += v; c.health += v; }
            if (eff.op === 'debuffAttack') { c.attack = Math.max(0, c.attack - v); }
            if (eff.op === 'debuffHealth') {   // v2.6: Порча/проклятие — перманентный -X здоровья
              c.maxHealth = Math.max(0, c.maxHealth - v);
              c.health -= v;
              if (c.health <= 0) { c.health = 0; this.markDeath(c); }
            }
            if (eff.op === 'setAttack') { c.attack = v; }
          }
          break;
        }
        case 'applyStatus': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.AnyCreature, eff.filter, ctx);
          for (const c of t.creatures) {
            this.addStatus(c, { type: eff.status!, value: eff.statusValue ?? 1, turnsLeft: eff.value ?? -1, sourceCardId: ctx.sourceCard?.id });
          }
          break;
        }
        case 'removeStatus': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.FriendlyCreature, eff.filter, ctx);
          for (const c of t.creatures) c.statuses = c.statuses.filter(s => s.type !== eff.status);
          for (const c of t.creatures) c.frozen = c.statuses.some(s => s.type === StatusType.Freeze);
          break;
        }
        case 'silence': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.EnemyCreature, eff.filter, ctx);
          for (const c of t.creatures) this.silence(c);
          break;
        }
        case 'returnToHand': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.EnemyCreature, eff.filter, ctx);
          for (const c of t.creatures) {
            const owner = this.p(c.owner);
            const idx = owner.creatures.indexOf(c);
            if (idx >= 0) owner.creatures.splice(idx, 1);
            this.uidMap.delete(c.uid);
            if (owner.hand.length < this.config.maxHand) owner.hand.push(c.cardId);
            else owner.graveyard.push(c.cardId);
            this.emit({ type: GameEventType.CreatureBounced, uid: c.uid, side: c.owner, cardName: c.name, text: `«${c.name}» возвращается в руку` });
          }
          break;
        }
        case 'stealCard': {
          const n = eff.value ?? 1;
          for (let k = 0; k < n; k++) {
            if (en.hand.length === 0) break;
            const idx = this.rng.int(en.hand.length);
            const cardId = en.hand.splice(idx, 1)[0];
            if (me.hand.length < this.config.maxHand) me.hand.push(cardId);
            else me.graveyard.push(cardId);
            this.emit({ type: GameEventType.CardStolen, side, cardId, cardName: this.db.get(cardId)?.name, text: `${me.name} крадёт карту у ${en.name}` });
          }
          break;
        }
        case 'stealCreature': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.EnemyCreature, eff.filter, ctx);
          for (const c of t.creatures) {
            const from = this.p(c.owner);
            const idx = from.creatures.indexOf(c);
            if (idx < 0) continue;
            if (me.creatures.length >= this.config.maxCreaturesPerSide) break;
            from.creatures.splice(idx, 1);
            c.owner = side; c.justPlayed = true; c.summonedOnTurn = this.turnsTaken[side]; c.attacksThisTurn = 0;
            me.creatures.push(c);
            this.emit({ type: GameEventType.CreatureStolen, uid: c.uid, side, cardName: c.name, text: `${me.name} перехватывает «${c.name}»` });
          }
          break;
        }
        case 'gainMana': me.mana = Math.min(this.config.maxMana, me.mana + (eff.value ?? 1)); this.emit({ type: GameEventType.ManaChanged, side, value: me.mana }); break;
        case 'gainMaxMana': {
          const beforeMax = me.maxMana;
          me.maxMana = Math.min(this.config.maxMana, me.maxMana + (eff.value ?? 1));
          const gained = me.maxMana - beforeMax;
          me.mana = Math.min(this.config.maxMana, me.mana + gained);
          this.emit({ type: GameEventType.ManaChanged, side, value: me.mana,
            data: { max: Math.min(this.config.maxMana, me.maxMana + me.bonusMana) } });
          break;
        }
        case 'gainEcho': me.echoPoints = Math.min(this.config.echoPointsMax, me.echoPoints + (eff.value ?? 1)); this.emit({ type: GameEventType.EchoGained, side, text: `${me.name} получает Эхо-очко` }); break;
        case 'summonToken': {
          const token = (eff as any).token as CardData | undefined;
          if (token) this.summon(side, token);
          break;
        }
        case 'sacrifice': {
          const pool = me.creatures.filter(c => c.uid !== ctx.sourceUid);
          if (pool.length) {
            pool.sort((a, b) => (a.attack + a.health) - (b.attack + b.health));
            const victim = pool[0];
            victim.health = 0; this.markDeath(victim);
          }
          break;
        }
        case 'restoreHealthByAttack': {
          const t = this.resolveTarget(side, eff.to ?? TargetKind.FriendlyCreature, eff.filter, ctx);
          for (const c of t.creatures) this.healHero(side, c.attack, { source: c.name });
          break;
        }
        case 'damageAllEnemyCreatures': {
          const amt = (eff.value ?? 0) + (isSpellDamage ? this.spellDamageOf(side, ctx.sourceCard?.element ?? Element.None, srcCost) : 0);
          for (const c of [...en.creatures]) this.damageCreature(c, amt, { source: ctx.sourceCard?.name, fromSpell: isSpellDamage, sourceCardId: ctx.sourceCard?.id });
          break;
        }
        case 'damageAllFriendlyCreatures': {
          const amt = (eff.value ?? 0) + (isSpellDamage ? this.spellDamageOf(side, ctx.sourceCard?.element ?? Element.None, srcCost) : 0);
          for (const c of [...me.creatures]) this.damageCreature(c, amt, { source: ctx.sourceCard?.name, fromSpell: isSpellDamage, sourceCardId: ctx.sourceCard?.id });
          break;
        }
        case 'damageAllCreatures': {
          const amt = (eff.value ?? 0) + (isSpellDamage ? this.spellDamageOf(side, ctx.sourceCard?.element ?? Element.None, srcCost) : 0);
          for (const c of [...this.allCreatures()]) this.damageCreature(c, amt, { source: ctx.sourceCard?.name, fromSpell: isSpellDamage, sourceCardId: ctx.sourceCard?.id });
          break;
        }
        case 'healAllFriendlyCreatures': for (const c of me.creatures) this.healCreature(c, eff.value ?? 1, ctx.sourceCard?.id); break;
        case 'freezeAllEnemies': for (const c of en.creatures) this.addStatus(c, { type: StatusType.Freeze, value: 1, turnsLeft: eff.value ?? 1 }); break;
        case 'burnAllEnemies': for (const c of en.creatures) this.addStatus(c, { type: StatusType.Burn, value: eff.statusValue ?? 1, turnsLeft: eff.value ?? 2 }); break;
        case 'shieldAllFriendlies': for (const c of me.creatures) this.addStatus(c, { type: StatusType.Shield, value: 1, turnsLeft: -1 }); break;
        case 'damageHeroes': {
          const base = eff.value ?? 1;
          const amt = base + (isSpellDamage ? this.spellDamageOf(side, ctx.sourceCard?.element ?? Element.None, srcCost) : 0);
          const opts = { source: ctx.sourceCard?.name, sourceCardId: ctx.sourceCard?.id, fromSpell: isSpellDamage };
          this.damageHero(en.side, amt, opts); this.damageHero(side, amt, opts);
          break;
        }
        case 'reduceIncomingDamage': {
          me.damageReduction += eff.value ?? 1;
          me.incomingDamageReductionTurns = Math.max(me.incomingDamageReductionTurns, 1);
          break;
        }
        case 'increaseSpellDamage': me.spellDamageBonus += eff.value ?? 1; break;
        case 'copyLastSpell': {
          if (me.lastSpellCast) {
            const card = this.db.get(me.lastSpellCast.cardId);
            if (card && card.subtype !== SpellSubtype.Ritual) this.castInstantSpell(side, card, me.lastSpellCast.targetUid, me.lastSpellCast.targetSide, { isEchoCopy: true });
          }
          break;
        }
      }
      if (eff.then) this.applyEffect(eff.then, side, ctx);
      this.checkDeaths();
      if (this.result !== GameResult.Ongoing) return;
    }
    void en;
  }

  /** Резолв цели эффекта с учётом фильтра (авто-выбор, если цель не задана игроком). */
  private resolveTarget(side: Side, to: TargetKind | undefined, filter: EffectFilter | undefined,
    ctx: { targetUid?: number; targetSide?: Side; sourceCard?: CardData }): {
      creatures: EntityCreature[]; heroSide?: Side; invalid?: boolean; allowHeroFallback?: boolean;
    } {
    const me = this.p(side);
    const en = this.p(side === Side.Player ? Side.Opponent : Side.Player);
    // Если отдельный эффект не уточнил цель, наследуем цель карты. Это важно для
    // AnyCreature/AnyHero и для составных заклинаний с несколькими разными целями.
    const cardTarget = ctx.sourceCard?.target ?? TargetKind.None;
    const kind = to && to !== TargetKind.None ? to : cardTarget;
    const creatureKind = (k: TargetKind): boolean =>
      k === TargetKind.EnemyCreature || k === TargetKind.FriendlyCreature || k === TargetKind.AnyCreature;
    const basicFilterMatches = (c: EntityCreature): boolean => {
      if (!filter) return true;
      if (filter.attackAtLeast !== undefined && c.attack < filter.attackAtLeast) return false;
      if (filter.attackAtMost !== undefined && c.attack > filter.attackAtMost) return false;
      if (filter.costAtLeast !== undefined && c.cost < filter.costAtLeast) return false;
      if (filter.isLegendary !== undefined && (c.data.rarity === Rarity.Legendary) !== filter.isLegendary) return false;
      if (filter.notSilenced && c.silenced) return false;
      return true;
    };

    // Выбранная цель применяется только к совместимому одиночному эффекту.
    // Массовые и случайные эффекты остаются массовыми/случайными; цели героя не
    // перехватываются UID существа. Если выбранная цель исчезла в стеке/ритуале,
    // эффект фizzle-ится вместо случайной переадресации или урона герою.
    if (ctx.targetUid !== undefined && !filter?.random && creatureKind(kind)) {
      const c = this.uidMap.get(ctx.targetUid);
      const sideMatches = c && (kind === TargetKind.AnyCreature
        || (kind === TargetKind.FriendlyCreature && c.owner === me.side)
        || (kind === TargetKind.EnemyCreature && c.owner === en.side));
      if (!c || !sideMatches || !basicFilterMatches(c)) return { creatures: [], invalid: true };
      return { creatures: [c] };
    }

    const allowHeroFallback = kind === TargetKind.None
      && ctx.targetUid === undefined && ctx.targetSide === undefined;
    switch (kind) {
      case TargetKind.None: return { creatures: [], allowHeroFallback };
      case TargetKind.EnemyCreature: return { creatures: this.filterCreatures(en.creatures, filter) };
      case TargetKind.FriendlyCreature: return { creatures: this.filterCreatures(me.creatures, filter) };
      case TargetKind.AnyCreature: return { creatures: this.filterCreatures([...me.creatures, ...en.creatures], filter) };
      case TargetKind.AllEnemies: return { creatures: [...en.creatures] };
      case TargetKind.AllFriendlies: return { creatures: [...me.creatures] };
      case TargetKind.AllCreatures: return { creatures: [...this.allCreatures()] };
      case TargetKind.EnemyHero: return { creatures: [], heroSide: en.side };
      case TargetKind.FriendlyHero: return { creatures: [], heroSide: me.side };
      case TargetKind.AnyHero: return { creatures: [], heroSide: ctx.targetSide === me.side ? me.side : en.side };
      default: return { creatures: [], allowHeroFallback: false };
    }
  }

  /**
   * Фильтр целей. Если фильтра нет — берётся первая подходящая цель
   * (для существ — с наименьшим здоровьем, по духу авто-боя из ТЗ).
   */
  private filterCreatures(list: EntityCreature[], f?: EffectFilter): EntityCreature[] {
    if (list.length === 0) return [];
    if (!f) {
      const sorted = list.slice().sort((a, b) => (a.health - b.health) || (a.uid - b.uid));
      return [sorted[0]];
    }
    let l = list.slice();
    if (f.attackAtLeast !== undefined) l = l.filter(c => c.attack >= f.attackAtLeast!);
    if (f.attackAtMost !== undefined) l = l.filter(c => c.attack <= f.attackAtMost!);
    if (f.costAtLeast !== undefined) l = l.filter(c => c.cost >= f.costAtLeast!);
    if (f.isLegendary !== undefined) l = l.filter(c => (c.data.rarity === Rarity.Legendary) === f.isLegendary);
    if (f.notSilenced) l = l.filter(c => !c.silenced);
    if (l.length === 0) return [];
    if (f.random) {
      const n = f.count ?? 1;
      const pool = this.rng.shuffle(l);
      return pool.slice(0, Math.min(n, pool.length));
    }
    if (f.lowestHealth) l.sort((a, b) => (a.health - b.health) || (a.uid - b.uid));
    if (f.lowestAttack) l.sort((a, b) => (a.attack - b.attack) || (a.uid - b.uid));
    if (f.highestAttack) l.sort((a, b) => (b.attack - a.attack) || (a.uid - b.uid));
    if (f.highestHealth) l.sort((a, b) => (b.health - a.health) || (a.uid - b.uid));
    return l.slice(0, f.count ?? 1);
  }

  snapshot(): any {
    return {
      turn: this.turn,
      activeSide: this.activeSide,
      phase: this.phase,
      result: this.result,
      players: this.players.map(pl => ({
        side: pl.side, name: pl.name, faction: pl.faction, health: pl.health, mana: pl.mana,
        maxMana: pl.maxMana + pl.bonusMana, hand: pl.hand.length, deck: pl.deck.length,
        graveyard: pl.graveyard.length, echo: pl.echoPoints, echoUsed: pl.echoUsedThisGame,
        creatures: pl.creatures.map(c => ({ uid: c.uid, name: c.name, attack: c.attack, health: c.health, statuses: c.statuses.map(s => s.type) })),
        runes: pl.runes.map(r => ({ name: r.name, turnsLeft: r.turnsLeft })),
        rituals: pl.rituals.map(r => ({ name: r.name, turnsLeft: r.turnsLeft })),
      })),
    };
  }
}

/* ------------------------------ ВСПОМОГАТЕЛЬНОЕ ------------------------------ */

export function statusRu(s: StatusType): string {
  switch (s) {
    case StatusType.Burn: return 'Горение';
    case StatusType.Poison: return 'Яд';
    case StatusType.Freeze: return 'Заморозка';
    case StatusType.Shield: return 'Щит';
    case StatusType.Fury: return 'Ярость';
    case StatusType.Silence: return 'Немота';
  }
}

export function resultText(r: GameResult): string {
  switch (r) {
    case GameResult.PlayerWin: return 'Победа!';
    case GameResult.OpponentWin: return 'Поражение';
    case GameResult.Draw: return 'Ничья';
    default: return 'Игра идёт';
  }
}

export function rarityRu(r: Rarity): string {
  return r === Rarity.Common ? 'Обычная' : r === Rarity.Rare ? 'Редкая' : r === Rarity.Epic ? 'Эпическая' : 'Легендарная';
}
