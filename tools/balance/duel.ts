/* Диагностический прогон одной пары фракций с подробным логом. */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../../src/engine/db';
import { MatchRunner } from '../../src/engine/match';
import { Faction, FACTION_RU, GameResult, Side } from '../../src/engine/types';

const ROOT = (() => { let d = __dirname; for (let i=0;i<8;i++){ if (fs.existsSync(path.join(d,'package.json'))) return d; d = path.dirname(d);} return process.cwd(); })();
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');

const a = process.argv[2] as Faction;
const b = process.argv[3] as Faction;
const n = parseInt(process.argv[4] ?? '200', 10);
const verbose = process.argv.includes('--log');

const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
const { db } = buildDatabase(cardsFile);
const decks: Record<string, string[]> = {};
for (const d of decksFile.decks) decks[d.id] = d.cards;

let wa = 0, wb = 0, draw = 0, turns = 0;
let dmgA = 0, dmgB = 0, healA = 0, healB = 0, spellsA = 0, spellsB = 0, playedA = 0, playedB = 0;
let lastLog: string[] = [];

for (let i = 0; i < n; i++) {
  const swap = i % 2 === 1;
  const left = swap ? b : a;
  const right = swap ? a : b;
  const r = new MatchRunner(db, [decks[left], decks[right]], [left, right], { seed: 1000 + i * 13 });
  r.setupAI();
  const res = r.run({});
  turns += res.turns;
  const sA = swap ? res.stats[1] : res.stats[0];
  const sB = swap ? res.stats[0] : res.stats[1];
  dmgA += sA.damageDealt; dmgB += sB.damageDealt;
  healA += sA.healingDone; healB += sB.healingDone;
  spellsA += sA.spellsCast; spellsB += sB.spellsCast;
  playedA += sA.cardsPlayed; playedB += sB.cardsPlayed;
  const winnerFac = res.winner === null ? null : (swap ? (res.winner === Side.Player ? b : a) : (res.winner === Side.Player ? a : b));
  if (winnerFac === a) wa++; else if (winnerFac === b) wb++; else draw++;
  if (verbose && i === 0) lastLog = res.log;
}

console.log(`\n=== ${FACTION_RU[a]} vs ${FACTION_RU[b]}  (${n} матчей) ===`);
console.log(`${FACTION_RU[a]}: ${wa} побед (${(wa/n*100).toFixed(1)}%)   ${FACTION_RU[b]}: ${wb} (${(wb/n*100).toFixed(1)}%)   ничьих ${draw}`);
console.log(`Средняя партия: ${(turns/n).toFixed(1)} ходов`);
console.log(`${FACTION_RU[a]}: урон/игру ${(dmgA/n).toFixed(1)}, лечение ${(healA/n).toFixed(1)}, заклинаний ${(spellsA/n).toFixed(1)}, карт сыграно ${(playedA/n).toFixed(1)}`);
console.log(`${FACTION_RU[b]}: урон/игру ${(dmgB/n).toFixed(1)}, лечение ${(healB/n).toFixed(1)}, заклинаний ${(spellsB/n).toFixed(1)}, карт сыграно ${(playedB/n).toFixed(1)}`);
if (verbose) { console.log('\n--- ЛОГ ПЕРВОГО МАТЧА ---'); lastLog.slice(0, 120).forEach(l => console.log('  ' + l)); }
