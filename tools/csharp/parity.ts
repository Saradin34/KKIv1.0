/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — эталон паритета для сверки C#-порта движка.
   ---------------------------------------------------------------------
   Прогоняет набор матчей TypeScript-движком (источник истины) и пишет
   tools/csharp/parity_ts.json: по каждому матчу — результат, стороны,
   число ходов, здоровье героев, ПОЛНАЯ последовательность разыгранных
   карт, число строк журнала и его FNV-1a хеш, а также вклад каждой карты
   в урон/лечение. Плюс агрегаты: винрейты фракций, средняя длина партии.

   C#-стенд (npm run verify:cs → режим parity) повторяет те же матчи
   тем же порядком и сравнивает всё до последней карты. Если хоть одно
   обращение к ГПСЧ или правило разъехалось, хеш журнала и список
   разыгранных карт это покажут.

   Сборка и запуск (нужны node_modules: npm i):
     npx esbuild tools/csharp/parity.ts --bundle --platform=node \
       --outfile=build/parity.js
     node build/parity.js --matches 200 --seed 20260903
   ===================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../../src/engine/db';
import { MatchRunner } from '../../src/engine/match';
import { Faction, GameResult, Rng, Side } from '../../src/engine/types';

/**
 * Корень репозитория. esbuild подставляет __dirname каталогом СБОРКИ (build/),
 * поэтому поднимаемся вверх до package.json — приём уже проверен в run_balance.ts.
 */
function findRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}
const ROOT = findRoot();
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** FNV-1a 32 бита по UTF-16 кодам — та же функция реализована в C#-стенде. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface ParityMatch {
  index: number;
  seed: number;
  left: string;
  right: string;
  result: string;
  winner: string | null;
  turns: number;
  winnerHealth: number;
  loserHealth: number;
  playedCount: number;
  played: string[];        // «сторона:cardId» по порядку розыгрыша
  logLines: number;
  log?: string[];
  logHash: number;
  cardDamage: Record<string, number>;
  cardHeal: Record<string, number>;
  stats: { damageDealt: number; healingDone: number; cardsPlayed: number; echoUsed: number; kills: number }[];
}

function main(): void {
  const matches = parseInt(arg('matches', '200'), 10);
  const baseSeed = parseInt(arg('seed', '20260903'), 10);

  const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
  const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
  const { db } = buildDatabase(cardsFile);

  const decks: Record<string, string[]> = {};
  for (const d of decksFile.decks) decks[d.id] = d.cards;
  const factionIds = Object.keys(decks).filter(k => k !== 'Starter');

  // множители пассивок — из той же Cards.json, что читает C#:
  // единый источник истины для обеих реализаций
  const coefs = ((cardsFile.meta as any).factionCoefficients ?? {}) as Record<string, { passiveMul?: number }>;
  const passiveMul: Record<string, number> = {};
  for (const k of Object.keys(coefs)) if (coefs[k]?.passiveMul !== undefined) passiveMul[k] = coefs[k].passiveMul!;

  // тот же порядок выбора пар и сторон, что в runSimulation (match.ts):
  // ГПСЧ с baseSeed выбирает колоды и чередование сторон
  const rng = new Rng(baseSeed);

  const out: ParityMatch[] = [];
  const wins: Record<string, { games: number; wins: number }> = {};
  for (const f of factionIds) wins[f] = { games: 0, wins: 0 };
  let totalTurns = 0, draws = 0;

  for (let i = 0; i < matches; i++) {
    const fA = rng.pick(factionIds);
    const fB = rng.pick(factionIds);
    const swap = rng.chance(0.5);
    const left = swap ? fB : fA;
    const right = swap ? fA : fB;

    const runner = new MatchRunner(db, [decks[left], decks[right]],
      [left as Faction, right as Faction],
      { seed: baseSeed + i * 7919, config: { passiveMul } as any });
    runner.setupAI();
    const res = runner.run({});

    totalTurns += res.turns;
    if (res.result === GameResult.Draw) draws++;

    for (const side of [Side.Player, Side.Opponent]) {
      const fac = runner.engine.p(side).faction as unknown as string;
      if (!wins[fac]) continue;
      wins[fac].games++;
      if (res.winner === side) wins[fac].wins++;
    }

    let logHash = 0;
    for (const line of res.log) logHash = (fnv1a(`${logHash}|${line}`)) >>> 0;

    out.push({
      index: i,
      seed: baseSeed + i * 7919,
      left, right,
      result: res.result,
      winner: res.winner === null ? null : String(res.winner),
      turns: res.turns,
      winnerHealth: res.winnerHealth,
      loserHealth: res.loserHealth,
      playedCount: res.playedCards.length,
      played: res.playedCards.map(p => `${p.side}:${p.cardId}`),
      logLines: res.log.length,
      log: res.log,
      logHash,
      cardDamage: Object.fromEntries(res.cardDamage),
      cardHeal: Object.fromEntries(res.cardHeal),
      stats: [Side.Player, Side.Opponent].map(s => ({
        damageDealt: res.stats[s].damageDealt,
        healingDone: res.stats[s].healingDone,
        cardsPlayed: res.stats[s].cardsPlayed,
        echoUsed: res.stats[s].echoUsed,
        kills: res.stats[s].kills,
      })),
    });
  }

  const factionWinRates: Record<string, number> = {};
  for (const f of factionIds) factionWinRates[f] = wins[f].games ? wins[f].wins / wins[f].games : 0;

  const payload = {
    engine: 'typescript',
    matches,
    baseSeed,
    passiveMul,
    avgTurns: matches ? totalTurns / matches : 0,
    draws,
    factionWinRates,
    matches_: out,
  };
  // отладочный дамп журнала одного матча: node build/parity.js --dump 56
  const dumpIdx = process.argv.indexOf('--dump');
  if (dumpIdx >= 0 && process.argv[dumpIdx + 1]) {
    const idx = parseInt(process.argv[dumpIdx + 1] ?? '-1', 10);
    const item = idx >= 0 ? out[idx] : undefined;
    if (item && item.log) {
      const d = path.join(ROOT, 'tools', 'csharp', `dump_${idx}_ts.txt`);
      fs.writeFileSync(d, item.log.join('\n') + '\n');
      console.log(`журнал TS матча #${idx}: ${d} (${item.log.length} строк)`);
    }
  }

  const dest = path.join(ROOT, 'tools', 'csharp', 'parity_ts.json');
  fs.writeFileSync(dest, JSON.stringify(payload));
  console.log(`TS-эталон паритета: ${out.length} матчей → ${dest}`);
  console.log(`средняя длина партии ${payload.avgTurns.toFixed(2)}, ничьих ${draws}`);
  for (const f of factionIds) console.log(`  ${f}: ${(factionWinRates[f] * 100).toFixed(1)}%`);
}

main();
