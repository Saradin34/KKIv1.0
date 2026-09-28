/*
 * Эхо-Цитадель — подбор сбалансированных 30-карточных starter-колод.
 *
 * Не меняет Constructed, карту или пассивки: меняет только списки `format: starter`
 * в Decks.json. Пул — базовые карты выбранной фракции + нейтральные, playset ×4.
 *
 * Запуск:
 *   npx esbuild tools/balance/tune_starters.ts --bundle --platform=node --format=cjs \
 *     --outfile=build/tune_starters.cjs --log-level=error
 *   node build/tune_starters.cjs --rounds 250 --matches 1500 --seed 20260928 --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase } from '../../src/engine/db';
import { runSimulation } from '../../src/engine/match';
import { Rng } from '../../src/engine/types';

function findRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const ROOT = findRoot();
const CARDS_PATH = path.join(ROOT, 'unity/EchoCitadel/Assets/StreamingAssets/Cards.json');
const DECKS_PATH = path.join(ROOT, 'unity/EchoCitadel/Assets/StreamingAssets/Decks.json');
const FACTIONS = ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal'];
const PLAYSET = 4;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function score(rates: Record<string, number>): number {
  const diffs = FACTIONS.map(f => Math.abs((rates[f] ?? 0.5) - 0.5));
  return diffs.reduce((sum, d) => sum + d * d + 1.5 * Math.max(0, d - 0.05) ** 2, 0);
}
function ratesOf(report: ReturnType<typeof runSimulation>): Record<string, number> {
  return Object.fromEntries(report.factions.map(f => [f.faction, f.winRate]));
}
function cloneDecks(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(FACTIONS.map(f => [f, [...input[f]]]));
}
function formatRates(rates: Record<string, number>): string {
  return FACTIONS.map(f => `${f} ${(100 * (rates[f] ?? 0.5)).toFixed(1)}%`).join(' · ');
}

function main(): void {
  const rounds = Math.max(1, parseInt(arg('rounds', '250'), 10) || 250);
  const matches = Math.max(500, parseInt(arg('matches', '1500'), 10) || 1500);
  const seed = parseInt(arg('seed', '20260928'), 10) || 20260928;
  const apply = process.argv.includes('--apply');
  const cardsFile = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  const decksFile = JSON.parse(fs.readFileSync(DECKS_PATH, 'utf8'));
  const { db } = buildDatabase(cardsFile);
  const expansion = new Set<string>(cardsFile.meta?.expansionIds ?? []);
  const pools = new Map<string, string[]>();
  for (const faction of FACTIONS) {
    pools.set(faction, cardsFile.cards
      .filter((c: { faction: string; id: string; isToken?: boolean }) =>
        !c.isToken && !expansion.has(c.id) && (c.faction === faction || c.faction === 'Neutral'))
      .map((c: { id: string }) => c.id));
  }
  const starterEntries = decksFile.decks.filter((d: { format?: string }) => d.format === 'starter');
  if (starterEntries.length !== FACTIONS.length) throw new Error(`Ожидалось 5 starter-колод, найдено ${starterEntries.length}`);
  let current: Record<string, string[]> = Object.fromEntries(starterEntries.map((d: { faction: string; cards: string[] }) => [d.faction, [...d.cards]]));
  const rawCoeff = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/generator/faction_balance.json'), 'utf8'));
  const passiveMul: Record<string, number> = Object.fromEntries(FACTIONS.map(f => [f, rawCoeff[f]?.passiveMul ?? 1]));
  const evalDecks = (candidate: Record<string, string[]>) => {
    const report = runSimulation(db, candidate, { matches, baseSeed: seed, deckIds: FACTIONS as any, passiveMul });
    const rates = ratesOf(report);
    return { rates, score: score(rates) };
  };
  let currentEval = evalDecks(current);
  let best = cloneDecks(current);
  let bestEval = currentEval;
  let rng = new Rng(seed ^ 0x5f3759df);
  let accepted = 0;
  console.log(`Starter tuning: ${rounds} попыток × ${matches} матчей; seed=${seed}`);
  console.log(`Старт: score=${currentEval.score.toFixed(5)} · ${formatRates(currentEval.rates)}`);

  // Перебор начинается и с исходных списков, и с «все 30 карт своей фракции».
  const allBase: Record<string, string[]> = Object.fromEntries(FACTIONS.map(f => [f,
    cardsFile.cards.filter((c: { faction: string; id: string; isToken?: boolean }) =>
      c.faction === f && !c.isToken && !expansion.has(c.id)).map((c: { id: string }) => c.id).slice(0, 30)]));
  if (FACTIONS.every(f => allBase[f].length === 30)) {
    const baseEval = evalDecks(allBase);
    console.log(`Все базовые карты: score=${baseEval.score.toFixed(5)} · ${formatRates(baseEval.rates)}`);
    if (baseEval.score < bestEval.score) { best = cloneDecks(allBase); bestEval = baseEval; }
  }
  current = cloneDecks(best);
  currentEval = bestEval;

  for (let i = 0; i < rounds; i++) {
    const weighted = FACTIONS.map(f => Math.abs((currentEval.rates[f] ?? 0.5) - 0.5) + 0.025);
    const totalWeight = weighted.reduce((a, b) => a + b, 0);
    let roll = rng.next() * totalWeight;
    let target = FACTIONS[0];
    for (let j = 0; j < FACTIONS.length; j++) { roll -= weighted[j]; if (roll <= 0) { target = FACTIONS[j]; break; } }

    const next = cloneDecks(current);
    const deck = next[target];
    const counts = new Map<string, number>();
    for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
    const outIndex = rng.int(deck.length);
    const outId = deck[outIndex];
    const options = (pools.get(target) ?? []).filter(id => id !== outId && (counts.get(id) ?? 0) < PLAYSET);
    if (!options.length) continue;
    const inId = options[rng.int(options.length)];
    deck[outIndex] = inId;

    const proposed = evalDecks(next);
    const progress = i / rounds;
    const temperature = 0.0018 * (1 - progress) + 0.00012;
    const delta = proposed.score - currentEval.score;
    const accept = delta <= 0 || rng.next() < Math.exp(-delta / temperature);
    if (accept) { current = next; currentEval = proposed; accepted++; }
    if (proposed.score < bestEval.score) { best = cloneDecks(next); bestEval = proposed; }

    if ((i + 1) % 25 === 0 || i + 1 === rounds) {
      console.log(`${i + 1}/${rounds}: best=${bestEval.score.toFixed(5)} current=${currentEval.score.toFixed(5)} · ${formatRates(bestEval.rates)}`);
    }
  }

  console.log(`Принято ходов: ${accepted}/${rounds}`);
  console.log(`Итог score=${bestEval.score.toFixed(5)} · ${formatRates(bestEval.rates)}`);
  if (!apply) { console.log('Decks.json не менялся (добавьте --apply для сохранения).'); return; }
  for (const entry of starterEntries) entry.cards = best[entry.faction];
  decksFile.meta.updated = new Date().toISOString().slice(0, 10);
  decksFile.meta.note = 'Пять сбалансированных стартовых колод по 30 карт; Constructed остаётся 60+';
  fs.writeFileSync(DECKS_PATH, JSON.stringify(decksFile, null, 1) + '\n', 'utf8');
  console.log(`Сохранено: ${path.relative(ROOT, DECKS_PATH)}`);
}

main();
