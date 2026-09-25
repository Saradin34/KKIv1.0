/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — библиотека решателя баланса (ТЗ п.8.2)
   Обратная связь по винрейту: подбирает фракционные коэффициенты
   (bodyMul / spellMul / runeMul), пока все 5 фракций не попадут в
   целевой коридор 45–55% (критерий приёмки ТЗ п.10.8).
   ===================================================================== */

import { CardData, Faction } from '../../src/engine/types';
import { GameEngine } from '../../src/engine/engine';
import { AIController, AI_PROFILES } from '../../src/engine/ai';
import { Phase, GameResult, Side } from '../../src/engine/types';

export const FACTIONS5: Faction[] = [
  Faction.Aurites, Faction.Necrus, Faction.Terramorph, Faction.Pyromancer, Faction.Ethereal,
];

export interface Coefs { bodyMul: number; spellMul: number; runeMul: number; passiveMul: number }
export type CoefMap = Record<string, Coefs>;

export interface SimOutcome {
  winRate: Record<string, number>;
  games: Record<string, number>;
  avgTurns: number;
  draws: number;
}

/** Быстрый симулятор одной пары колод (без отчётов) — для внутренней петли решателя. */
export function passiveMulFromCoefs(coefs: CoefMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FACTIONS5) out[f] = coefs[f]?.passiveMul ?? 1.0;
  return out;
}

export function playMatch(db: Map<string, CardData>, decks: Record<string, string[]>,
  left: Faction, right: Faction, seed: number, coefs?: CoefMap): Faction | null {
  const e = new GameEngine(db, [decks[left], decks[right]], {
    factions: [left, right], names: ['A', 'B'], seed,
    config: { passiveMul: coefs ? passiveMulFromCoefs(coefs) : undefined } as any,
  });
  e.setup();
  // муллиган: оставляем карты ≤3 маны (не более 3)
  for (const side of [Side.Player, Side.Opponent]) {
    const pl = e.p(side);
    const hand = pl.hand.map(id => e.db.get(id)!).filter(Boolean);
    const keep = hand.map((c, i) => (c.cost <= 3 ? i : -1)).filter(i => i >= 0).slice(0, 3);
    e.mulligan(side, keep);
  }
  const ai = [new AIController(e, Side.Player, AI_PROFILES[left]),
              new AIController(e, Side.Opponent, AI_PROFILES[right])];
  e.activeSide = Side.Player;
  e.turn = 0;
  let guard = 0;
  while (e.result === GameResult.Ongoing && guard++ < 500) {
    e.runTurn();
    if (e.result !== GameResult.Ongoing) break;
    const cur = ai[e.activeSide];
    let n = 0;
    while (e.phase === Phase.Main && e.result === GameResult.Ongoing && n++ < 30) {
      const best = cur.chooseBestAction();
      if (!best) break;
      if (best.action.type === 'endTurn') { e.finishMainPhase(); break; }
      if (!e.playAIFallback(best.action, e.activeSide)) { e.finishMainPhase(); break; }
    }
    if (e.phase === Phase.Main) e.finishMainPhase();
    if (e.turn > e.config.maxTurns) { e.result = GameResult.Draw; break; }
  }
  if (e.result === GameResult.Draw) return null;
  const winnerSide = e.result === GameResult.PlayerWin ? Side.Player : Side.Opponent;
  return winnerSide === Side.Player ? left : right;
}

/** Прогон матрицы матч-апов: каждая пара фракций x matchesPerPair (со сменой сторон). */
export function simulateMatrix(db: Map<string, CardData>, decks: Record<string, string[]>,
  matchesPerPair: number, baseSeed: number, coefs?: CoefMap): SimOutcome {
  const wins: Record<string, number> = {};
  const games: Record<string, number> = {};
  for (const f of FACTIONS5) { wins[f] = 0; games[f] = 0; }
  let turns = 0, total = 0, draws = 0;

  for (let i = 0; i < FACTIONS5.length; i++) {
    for (let j = 0; j < FACTIONS5.length; j++) {
      const a = FACTIONS5[i], b = FACTIONS5[j];
      for (let m = 0; m < matchesPerPair; m++) {
        const swap = m % 2 === 1;
        const left = swap ? b : a;
        const right = swap ? a : b;
        const w = playMatch(db, decks, left, right, baseSeed + i * 1000 + j * 37 + m * 7919, coefs);
        games[a]++; games[b]++; total++;
        if (w === null) { draws++; continue; }
        wins[w]++;
      }
    }
  }
  const winRate: Record<string, number> = {};
  for (const f of FACTIONS5) winRate[f] = games[f] ? wins[f] / games[f] : 0.5;
  void turns;
  return { winRate, games, avgTurns: turns / Math.max(1, total), draws };
}

/** Один шаг обратной связи: winRate -> новые коэффициенты. */
/**
 * Шаг обратной связи.
   Главный рычаг — passiveMul (сила пассивки): он не портит дизайн карт.
   bodyMul/spellMul/runeMul — вспомогательные, работают в узком коридоре
   и с малым усилением, чтобы статы оставались в «человеческих» пределах.
 */
export function stepCoefs(coefs: CoefMap, winRate: Record<string, number>,
  opts: { gain?: number; passiveGain?: number; bodyRange?: [number, number];
          spellRange?: [number, number]; passiveRange?: [number, number] } = {}): CoefMap {
  const gain = opts.gain ?? 0.35;
  const pgain = opts.passiveGain ?? 1.1;
  const [bMin, bMax] = opts.bodyRange ?? [0.85, 1.40];
  const [sMin, sMax] = opts.spellRange ?? [0.85, 1.45];
  const [pMin, pMax] = opts.passiveRange ?? [0.45, 2.4];
  const next: CoefMap = {};
  for (const f of FACTIONS5) {
    const cur = coefs[f] ?? { bodyMul: 1, spellMul: 1, runeMul: 1, passiveMul: 1 };
    const err = (winRate[f] ?? 0.5) - 0.5;         // >0 — фракция слишком сильна
    const kp = clamp(1 - err * pgain, pMin, pMax);
    const kb = clamp(1 - err * gain, bMin, bMax);
    const ks = clamp(1 - err * gain, sMin, sMax);
    next[f] = {
      bodyMul:  clamp(cur.bodyMul * kb, bMin, bMax),
      spellMul: clamp(cur.spellMul * ks, sMin, sMax),
      runeMul:  clamp(cur.runeMul * ks, sMin, sMax),
      passiveMul: clamp(cur.passiveMul * kp, pMin, pMax),
    };
  }
  return next;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function allInRange(winRate: Record<string, number>, lo = 0.45, hi = 0.55): boolean {
  return FACTIONS5.every(f => (winRate[f] ?? 0) >= lo && (winRate[f] ?? 0) <= hi);
}
