/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — оркестрация матча и headless-симулятор (ТЗ раздел 8.1)
   ---------------------------------------------------------------------
   MatchRunner: «склейка» движка и контроллеров (AI или человек).
   Simulator:   прогон N матчей AI-vs-AI со сбором статистики по картам.
   Один и тот же код используется:
     • консольным автотестером (tools/balance/run_balance.ts),
     • юнит-тестами,
     • Unity-обвязкой (через портированную C#-версию).
   ===================================================================== */

import {
  CardData, Faction, GameConfig, GameResult, Phase, Rng, Side, DEFAULT_CONFIG,
} from './types';
import { GameEngine, GameAction, emptyStats, MatchStats } from './engine';
import { AIController, AI_PROFILES, AIProfile } from './ai';

export interface MatchOptions {
  config?: Partial<GameConfig>;
  seed?: number;
  /** Муллиган: какие индексы оставить (по умолчанию AI оставляет карты ≤ 3 маны). */
  mulliganPolicy?: (hand: CardData[]) => number[];
  /** Ограничение итераций основной фазы (защита от зацикливания). */
  maxActionsPerTurn?: number;
  trace?: boolean;
}

export interface MatchResult {
  result: GameResult;
  winner: Side | null;
  turns: number;
  loserHealth: number;
  winnerHealth: number;
  stats: [MatchStats, MatchStats];
  /** Какие карты играли за победителя / проигравшего. */
  winnerDeck: string[];
  loserDeck: string[];
  winnerFaction: Faction;
  loserFaction: Faction;
  /** Какие карты реально были разыграны (для отчёта TimesPlayed). */
  playedCards: { side: Side; cardId: string }[];
  /** Вклад каждой карты в урон/лечение (для колонок AvgDamage/AvgHeal отчёта). */
  cardDamage: Map<string, number>;
  cardHeal: Map<string, number>;
  log: string[];
}

/* ---------------------------------------------------------------------- */

export class MatchRunner {
  engine: GameEngine;
  ai: [AIController | null, AIController | null] = [null, null];
  private played: { side: Side; cardId: string }[] = [];
  private cardDamage = new Map<string, number>();
  private cardHeal = new Map<string, number>();
  private cardMana = new Map<string, number>();

  constructor(db: Map<string, CardData>, decks: [string[], string[]],
    factions: [Faction, Faction], opts: MatchOptions = {}) {
    this.engine = new GameEngine(db, decks, {
      config: opts.config,
      factions,
      names: ['Игрок', 'Противник'],
      seed: opts.seed ?? 1,
      hooks: {
        onEvent: (e) => {
          if (e.type === 'CardPlayed' && e.cardId && e.side !== undefined) {
            this.played.push({ side: e.side, cardId: e.cardId });
            this.cardMana.set(e.cardId, (this.cardMana.get(e.cardId) ?? 0) + (e.value ?? 0));
          }
          const src = e.sourceCardId;
          if (!src) return;
          if (e.type === 'PlayerDamage' || e.type === 'CreatureDamaged') {
            this.cardDamage.set(src, (this.cardDamage.get(src) ?? 0) + (e.value ?? 0));
          } else if (e.type === 'PlayerHeal' || e.type === 'CreatureHealed') {
            this.cardHeal.set(src, (this.cardHeal.get(src) ?? 0) + (e.value ?? 0));
          }
        },
      },
    });
  }

  /** Оба игрока — AI. */
  setupAI(profiles?: [Partial<AIProfile>?, Partial<AIProfile>?]): void {
    for (const side of [Side.Player, Side.Opponent]) {
      const fac = this.engine.p(side).faction;
      const base = AI_PROFILES[fac] ?? AI_PROFILES[Faction.Neutral];
      this.ai[side] = new AIController(this.engine, side, { ...base, ...(profiles?.[side] ?? {}) });
    }
  }

  /** Муллиган по умолчанию: оставляем всё дешевле 4 маны (максимум 3 карты). */
  runMulligans(policy?: (hand: CardData[]) => number[]): void {
    for (const side of [Side.Player, Side.Opponent]) {
      const pl = this.engine.p(side);
      const hand = pl.hand.map(id => this.engine.db.get(id)!).filter(Boolean);
      const keep = policy ? policy(hand)
        : hand.map((c, i) => (c.cost <= 3 ? i : -1)).filter(i => i >= 0).slice(0, 3);
      this.engine.mulligan(side, keep);
    }
  }

  /** Прогон матча до конца. */
  run(opts: MatchOptions = {}): MatchResult {
    const e = this.engine;
    e.setup();
    this.runMulligans(opts.mulliganPolicy);

    const maxActions = opts.maxActionsPerTurn ?? 30;
    let safety = 0;

    // Первый ход — у игрока 0
    e.activeSide = Side.Player;
    e.turn = 0;

    while (e.result === GameResult.Ongoing && safety++ < 1000) {
      e.runTurn();
      if (e.result !== GameResult.Ongoing) break;

      // Основная фаза: действия контроллера
      const ai = this.ai[e.activeSide];
      if (ai) {
        let n = 0;
        while (e.phase === Phase.Main && e.result === GameResult.Ongoing && n++ < maxActions) {
          const best = ai.chooseBestAction();
          if (!best) break;
          // «неидеальность» AI: иногда второе по ценности действие
          if (e.rng.chance(ai.profile.blunderRate)) {
            const alt = ai.chooseSecondBest();
            if (alt && alt.action.type !== 'endTurn' && alt.score > 0) {
              e.playAIFallback(alt.action, e.activeSide);
              continue;
            }
          }
          if (best.action.type === 'endTurn') { e.finishMainPhase(); break; }
          if (!e.playAIFallback(best.action, e.activeSide)) { e.finishMainPhase(); break; }
        }
        if (e.phase === Phase.Main) e.finishMainPhase();
      } else {
        // Ход человека обрабатывается внешним контроллером (Unity/прототип)
        throw new Error('MatchRunner.run(): для стороны ' + e.activeSide + ' не задан контроллер');
      }

      e.forceDrawCheck();
      if (e.turn > e.config.maxTurns) { e.result = GameResult.Draw; break; }
    }

    const winner = e.result === GameResult.PlayerWin ? Side.Player
      : e.result === GameResult.OpponentWin ? Side.Opponent : null;

    const wDeck = winner === null ? e.p(Side.Player).deck : e.p(winner).deck;
    const lDeck = winner === null ? e.p(Side.Opponent).deck : e.p(Side.Opponent).deck;

    return {
      result: e.result,
      winner,
      turns: e.turn,
      loserHealth: winner === Side.Player ? e.p(Side.Opponent).health : e.p(Side.Player).health,
      winnerHealth: winner === null ? 0 : e.p(winner).health,
      stats: [e.stats[0], e.stats[1]],
      winnerDeck: winner === null ? [] : [...e.p(winner).graveyard, ...wDeck, ...e.p(winner).hand],
      loserDeck: winner === null ? [] : [...e.p(winner === Side.Player ? Side.Opponent : Side.Player).graveyard,
                                          ...lDeck, ...e.p(winner === Side.Player ? Side.Opponent : Side.Player).hand],
      winnerFaction: winner === null ? Faction.Neutral : e.p(winner).faction,
      loserFaction: winner === null ? Faction.Neutral : e.p(winner === Side.Player ? Side.Opponent : Side.Player).faction,
      playedCards: this.played,
      cardDamage: this.cardDamage,
      cardHeal: this.cardHeal,
      log: e.log.filter(x => x.type === 'Log' && x.text).map(x => x.text as string),
    };
  }
}

/* ---------------------------------------------------------------------- */

export interface CardStat {
  cardId: string;
  cardName: string;
  faction: Faction;
  type: string;
  rarity: string;
  cost: number;
  timesPlayed: number;          // сколько раз карта была РОЗЫГРАНА
  matchesPresent: number;       // в скольких матчах карта лежала в колоде
  timesInWinnerDeck: number;
  timesInLoserDeck: number;
  wins: number;                 // матчей, где карта в колоде победителя
  losses: number;
  winRate: number;              // wins / matchesPresent
  /**
   * МАРГИНАЛЬНЫЙ ВКЛАД карты (главная метрика для балансировки).
   *   relativeWinRate = P(победа | карта разыграна) − P(победа | фракция)
   * Ноль = карта ровно среднего уровня своей фракции.
   * >0 — карта сильнее среднего, <0 — слабее. Именно это и надо править в JSON.
   */
  relativeWinRate: number;
  /** P(победа | карта была разыграна в матче). */
  winRateWhenPlayed: number;
  /** Базовый винрейт фракции карты в этом прогоне. */
  factionBaseWinRate: number;
  playRate: number;             // разыграна / присутствовала
  avgDamage: number;            // среднегодовой вклад в урон за 1 розыгрыш
  avgHeal: number;
  avgMana: number;
  needsBalance: boolean;
}

export interface FactionStat {
  faction: Faction;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  avgTurns: number;
  avgDamage: number;
  avgHeal: number;
  avgCardsPlayed: number;
  avgEchoUsed: number;
  withinTarget: boolean;   // 45–55% по ТЗ п.10.8
}

export interface SimulationReport {
  matches: number;
  seed: number;
  avgTurns: number;
  draws: number;
  factions: FactionStat[];
  cards: CardStat[];
  outOfRange: CardStat[];
}

export interface SimulationOptions {
  matches?: number;
  baseSeed?: number;
  decks?: Record<string, string[]>;
  deckIds?: string[];
  config?: Partial<GameConfig>;
  /** Множители силы пассивок из tools/generator/faction_balance.json */
  passiveMul?: Record<string, number>;
}

/** Прогон N матчей всеми парами фракций (ТЗ п.8.1: 10 000 матчей). */
export function runSimulation(db: Map<string, CardData>, decks: Record<string, string[]>,
  opts: SimulationOptions = {}): SimulationReport {
  const matches = opts.matches ?? 10000;
  const baseSeed = opts.baseSeed ?? 12345;
  const rng = new Rng(baseSeed);

  const factionList: Faction[] = [Faction.Aurites, Faction.Necrus, Faction.Terramorph,
                                  Faction.Pyromancer, Faction.Ethereal];
  const deckIds = opts.deckIds ?? factionList.map(f => f);

  const cardAgg = new Map<string, { played: number; wins: number; losses: number; inWin: number; inLose: number;
                                     present: number; dmg: number; heal: number; mana: number;
                                     playedMatches: number; playedWins: number }>();
  const newAgg = () => ({ played: 0, wins: 0, losses: 0, inWin: 0, inLose: 0, present: 0,
                          dmg: 0, heal: 0, mana: 0, playedMatches: 0, playedWins: 0 });
  const facAgg = new Map<Faction, { games: number; wins: number; turns: number; dmg: number; heal: number; played: number; echo: number }>();
  for (const f of factionList) facAgg.set(f, { games: 0, wins: 0, turns: 0, dmg: 0, heal: 0, played: 0, echo: 0 });

  let totalTurns = 0, draws = 0;

  for (let i = 0; i < matches; i++) {
    const fA = deckIds.length > 1 ? rng.pick(deckIds) : deckIds[0];
    let fB = deckIds.length > 1 ? rng.pick(deckIds) : deckIds[0];
    // зеркальные матчи учитываются, но чередуем стороны для честности
    const swap = rng.chance(0.5);
    const left = swap ? fB : fA;
    const right = swap ? fA : fB;

    const runner = new MatchRunner(db, [decks[left], decks[right]],
      [left as Faction, right as Faction],
      { seed: baseSeed + i * 7919,
        config: {
          ...(opts.config ?? {}),
          ...(opts.passiveMul ? { passiveMul: opts.passiveMul } : {}),
        } as Partial<GameConfig> });
    runner.setupAI();
    let res: MatchResult;
    try {
      res = runner.run({});
    } catch (ex) {
      console.error(`Матч #${i} (${left} vs ${right}) упал:`, ex);
      continue;
    }

    totalTurns += res.turns;
    if (res.result === GameResult.Draw) draws++;

    // разыгранные карты + «победа при розыгрыше» (основа маргинального вклада)
    const playedIds = new Set<string>();
    for (const pc of res.playedCards) {
      const a = cardAgg.get(pc.cardId) ?? newAgg();
      a.played++;
      cardAgg.set(pc.cardId, a);
      playedIds.add(pc.cardId);
    }
    for (const cid of playedIds) {
      const ownerSide = res.playedCards.find(pc => pc.cardId === cid)!.side;
      const a = cardAgg.get(cid) ?? newAgg();
      a.playedMatches++;
      if (res.winner === ownerSide) a.playedWins++;
      cardAgg.set(cid, a);
    }
    // Карта считается «присутствовавшей» в матче, если лежала в колоде любой из сторон.
    const present = new Set<string>([...res.winnerDeck, ...res.loserDeck]);
    for (const cid of present) {
      const a = cardAgg.get(cid) ?? newAgg();
      a.present++;
      cardAgg.set(cid, a);
    }
    if (res.winner !== null) {
      for (const cid of new Set(res.winnerDeck)) {
        const a = cardAgg.get(cid) ?? newAgg();
        a.wins++; a.inWin++; cardAgg.set(cid, a);
      }
      for (const cid of new Set(res.loserDeck)) {
        const a = cardAgg.get(cid) ?? newAgg();
        a.losses++; a.inLose++; cardAgg.set(cid, a);
      }
    }
    // вклад карт в урон/лечение/ману
    for (const [cid, v] of res.cardDamage) { const a = cardAgg.get(cid) ?? newAgg(); a.dmg += v; cardAgg.set(cid, a); }
    for (const [cid, v] of res.cardHeal)   { const a = cardAgg.get(cid) ?? newAgg(); a.heal += v; cardAgg.set(cid, a); }

    for (const side of [Side.Player, Side.Opponent]) {
      const fac = runner.engine.p(side).faction;
      const agg = facAgg.get(fac);
      if (!agg) continue;
      agg.games++;
      if (res.winner === side) agg.wins++;
      agg.turns += res.turns;
      agg.dmg += res.stats[side].damageDealt;
      agg.heal += res.stats[side].healingDone;
      agg.played += res.stats[side].cardsPlayed;
      agg.echo += res.stats[side].echoUsed;
    }
  }

  const cards: CardStat[] = [];
  for (const [id, a] of cardAgg) {
    const data = db.get(id);
    if (!data) continue;
    const wr = a.present > 0 ? a.wins / a.present : 0;
    const wrPlayed = a.playedMatches > 0 ? a.playedWins / a.playedMatches : 0.5;
    cards.push({
      cardId: id, cardName: data.name, faction: data.faction, type: data.type,
      rarity: data.rarity, cost: data.cost,
      timesPlayed: a.played, matchesPresent: a.present,
      timesInWinnerDeck: a.inWin, timesInLoserDeck: a.inLose,
      wins: a.wins, losses: a.losses, winRate: wr,
      relativeWinRate: 0, winRateWhenPlayed: wrPlayed, factionBaseWinRate: 0,
      playRate: a.present > 0 ? a.played / a.present : 0,
      avgDamage: a.played ? a.dmg / a.played : 0,
      avgHeal: a.played ? a.heal / a.played : 0,
      avgMana: a.played ? a.mana / a.played : 0,
      needsBalance: false,
    });
  }
  // Базовые винрейты фракций (берутся из facAgg — уже посчитаны выше)
  const factionBase = new Map<Faction, number>();
  for (const [f, a] of facAgg) factionBase.set(f, a.games ? a.wins / a.games : 0.5);
  // Для нейтральных карт база — средний винрейт всех фракций
  const neutralBase = [...factionBase.values()].reduce((s, v) => s + v, 0) / Math.max(1, factionBase.size);

  for (const c of cards) {
    const base = c.faction === Faction.Neutral ? neutralBase : (factionBase.get(c.faction) ?? 0.5);
    c.factionBaseWinRate = base;
    c.relativeWinRate = c.timesPlayed > 0 ? c.winRateWhenPlayed - base : 0;
    // ТЗ п.8.1 (адаптировано): карта требует балансировки, если её маргинальный вклад
    // выходит за ±5 п.п. при достаточной выборке розыгрышей.
    c.needsBalance = c.timesPlayed >= 100 && Math.abs(c.relativeWinRate) > 0.05;
  }
  cards.sort((x, y) => y.relativeWinRate - x.relativeWinRate);

  const factions: FactionStat[] = [];
  for (const [f, a] of facAgg) {
    const wr = a.games ? a.wins / a.games : 0;
    factions.push({
      faction: f, games: a.games, wins: a.wins, losses: a.games - a.wins, winRate: wr,
      avgTurns: a.games ? a.turns / a.games : 0,
      avgDamage: a.games ? a.dmg / a.games : 0,
      avgHeal: a.games ? a.heal / a.games : 0,
      avgCardsPlayed: a.games ? a.played / a.games : 0,
      avgEchoUsed: a.games ? a.echo / a.games : 0,
      withinTarget: wr >= 0.45 && wr <= 0.55,
    });
  }
  factions.sort((a, b) => b.winRate - a.winRate);

  return {
    matches, seed: baseSeed, avgTurns: matches ? totalTurns / matches : 0, draws,
    factions, cards,
    outOfRange: cards.filter(c => c.needsBalance),
  };
}

export { emptyStats };
