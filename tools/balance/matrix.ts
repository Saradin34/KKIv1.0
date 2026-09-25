/* Матрица матч-апов 5x5: кто кого фармит. Запуск:
   npx esbuild tools/balance/matrix.ts --bundle --platform=node --outfile=build/matrix.js --log-level=error && node build/matrix.js --per-pair 60 --seed 20260903 */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../../src/engine/db';
import { FACTIONS5, playMatch, CoefMap } from './solver_lib';
import { FACTION_RU } from '../../src/engine/types';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ROOT = (() => {
  let d = __dirname;
  for (let i = 0; i < 8; i++) { if (fs.existsSync(path.join(d, 'package.json'))) return d; d = path.dirname(d); }
  return process.cwd();
})();
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');
const perPair = parseInt(arg('per-pair', '60'), 10);
const seed = parseInt(arg('seed', '20260903'), 10);
const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
const { db } = buildDatabase(cardsFile);
const decks: Record<string, string[]> = {};
for (const d of decksFile.decks) decks[d.id] = d.cards;
const coefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'generator', 'faction_balance.json'), 'utf-8')) as CoefMap;
const coefsBy = coefs as CoefMap;
const mx: Record<string, Record<string, number>> = {};
for (const a of FACTIONS5) {
  mx[a] = {};
  for (const b of FACTIONS5) {
    if (a === b) continue;
    let w = 0;
    for (let m = 0; m < perPair; m++) {
      const swap = m % 2 === 1;
      const winner = playMatch(db, decks, swap ? b : a, swap ? a : b, seed + FACTIONS5.indexOf(a) * 100003 + FACTIONS5.indexOf(b) * 101 + m * 7919, coefsBy);
      if (winner === a) w++;
    }
    mx[a][b] = w / perPair;
  }
}
const head = 'строка бьёт столбец: ' + FACTIONS5.map(f => (FACTION_RU as any)[f].slice(0, 8).padStart(8)).join('');
console.log(head);
for (const a of FACTIONS5) {
  console.log(((FACTION_RU as any)[a].slice(0, 8)).padEnd(10) + FACTIONS5.map(b => {
    if (a === b) return '       —';
    return (mx[a][b] * 100).toFixed(1).padStart(8);
  }).join(''));
}
