/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — решатель баланса фракций (ТЗ п.8.2 + критерий п.10.8)
   ---------------------------------------------------------------------
   Замкнутый контур:
     1) записать коэффициенты в tools/generator/faction_balance.json
     2) перегенерировать Cards.json (python3 tools/generator/generate_cards.py)
     3) прогнать матрицу матч-апов 5x5 симулятором правил
     4) скорректировать коэффициенты обратной связью по винрейту
     5) повторять, пока все фракции не попадут в 45–55%

   Запуск:
     npx esbuild tools/balance/solve_balance.ts --bundle --platform=node \
        --outfile=build/solve_balance.js
     node build/solve_balance.js --rounds 30 --per-pair 12
   ===================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildDatabase, CardsFile, DeckFile } from '../../src/engine/db';
import { Faction, FACTION_RU } from '../../src/engine/types';
import { CoefMap, FACTIONS5, simulateMatrix, stepCoefs, allInRange } from './solver_lib';

const ROOT = (() => {
  let d = __dirname;
  for (let i = 0; i < 8; i++) { if (fs.existsSync(path.join(d, 'package.json'))) return d; d = path.dirname(d); }
  return process.cwd();
})();
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');
const COEF_FILE = path.join(ROOT, 'tools', 'generator', 'faction_balance.json');
const GENERATOR = path.join(ROOT, 'tools', 'generator', 'generate_cards.py');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const COMMENT = [
  'Коэффициенты авто-балансировки фракций (ТЗ п.8.2).',
  'ПОДОБРАНЫ АВТОМАТИЧЕСКИ решателем tools/balance/solve_balance.ts',
  'на основе симуляции матрицы матч-апов 5x5 движком правил (src/engine).',
  'Цель: винрейт каждой фракции в коридоре 45-55% (ТЗ п.10.8).',
  'bodyMul  — множитель суммарных статов существ;',
  'spellMul — множитель числовых параметров заклинаний;',
  'runeMul  — множитель числовых параметров рун.',
];

function writeCoefs(coefs: CoefMap, meta: Record<string, any>): void {
  const out: any = { _comment: COMMENT, ...meta };
  for (const f of FACTIONS5) {
    out[f] = {
      bodyMul: +coefs[f].bodyMul.toFixed(4),
      spellMul: +coefs[f].spellMul.toFixed(4),
      runeMul: +coefs[f].runeMul.toFixed(4),
      passiveMul: +coefs[f].passiveMul.toFixed(4),
    };
  }
  fs.writeFileSync(COEF_FILE, JSON.stringify(out, null, 2), 'utf-8');
}

function loadCoefs(): CoefMap {
  try {
    const raw = JSON.parse(fs.readFileSync(COEF_FILE, 'utf-8'));
    const out = {} as CoefMap;
    for (const f of FACTIONS5) {
      out[f] = {
        bodyMul: raw[f]?.bodyMul ?? 1, spellMul: raw[f]?.spellMul ?? 1, runeMul: raw[f]?.runeMul ?? 1,
        passiveMul: raw[f]?.passiveMul ?? 1,
      };
    }
    return out;
  } catch {
    const out = {} as CoefMap;
    for (const f of FACTIONS5) out[f] = { bodyMul: 1, spellMul: 1, runeMul: 1, passiveMul: 1 };
    return out;
  }
}

function regenerate(): void {
  execFileSync('python3', [GENERATOR], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
}

function loadData(): { db: Map<string, any>; decks: Record<string, string[]> } {
  const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
  const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
  const { db } = buildDatabase(cardsFile);
  const decks: Record<string, string[]> = {};
  for (const d of decksFile.decks) decks[d.id] = d.cards;
  return { db, decks };
}

function fmt(coefs: CoefMap): string {
  return FACTIONS5.map(f => `${FACTION_RU[f]} тел=${coefs[f].bodyMul.toFixed(2)} зак=${coefs[f].spellMul.toFixed(2)} рун=${coefs[f].runeMul.toFixed(2)} пас=${coefs[f].passiveMul.toFixed(2)}`).join('\n              ');
}

function main(): void {
  const rounds = parseInt(arg('rounds', '30'), 10);
  const perPair = parseInt(arg('per-pair', '12'), 10);
  const gain = parseFloat(arg('gain', '0.85'));
  const seed = parseInt(arg('seed', '777'), 10);

  let coefs = loadCoefs();
  console.log(`Решатель баланса: ${rounds} итераций, ${perPair} матчей на пару (всего ${perPair * 25} за итерацию)`);
  console.log(`Старт: ${fmt(coefs)}\n`);

  // EMA-сглаживание винрейта: решение принимаем по накопленной оценке, а не по шуму одного раунда
  const ema: Record<string, number> = {};
  for (const f of FACTIONS5) ema[f] = 0.5;
  const alpha = parseFloat(arg('ema', '0.5'));
  let convergedAt = -1;

  for (let r = 1; r <= rounds; r++) {
    const data = loadDataAfter(coefs);
    const out = simulateMatrix(data.db, data.decks, perPair, seed + r * 101, coefs);
    for (const f of FACTIONS5) ema[f] = alpha * out.winRate[f] + (1 - alpha) * ema[f];
    const spread = Math.max(...FACTIONS5.map(f => out.winRate[f])) - Math.min(...FACTIONS5.map(f => out.winRate[f]));
    console.log(`[Раунд ${String(r).padStart(2, '0')}] ` +
      FACTIONS5.map(f => `${FACTION_RU[f]} ${(out.winRate[f] * 100).toFixed(1)}%`).join(' | ') +
      `   разброс ${(spread * 100).toFixed(1)} п.п.`);
    console.log('           EMA:  ' +
      FACTIONS5.map(f => `${FACTION_RU[f]} ${(ema[f] * 100).toFixed(1)}%`).join(' | '));
    const stable = r >= 14 && allInRange(ema) && Math.max(...FACTIONS5.map(f => Math.abs(out.winRate[f] - ema[f]))) < 0.06;
    if (stable) {
      convergedAt = r;
      console.log('\n✅ Все фракции в коридоре 45–55% (по сглаженной оценке). Коэффициенты зафиксированы.');
      break;
    }
    // затухающий шаг: чем дальше, тем осторожнее корректировка
    const g = gain * (r <= 4 ? 1.0 : r <= 10 ? 0.7 : 0.45);
    coefs = stepCoefs(coefs, ema, { gain: g, passiveGain: g * 2.6 });
    writeCoefs(coefs, { _solved: { round: r, winRates: out.winRate, ema, matchesPerPair: perPair } });
    regenerate();
  }

  // финальный контрольный прогон на большем числе матчей
  const finalPerPair = parseInt(arg('final-per-pair', '60'), 10);
  const finalData = loadData();
  const fin = simulateMatrix(finalData.db, finalData.decks, finalPerPair, 424242, coefs);
  console.log(`\n=== КОНТРОЛЬНЫЙ ПРОГОН (${finalPerPair * 25} матчей) ===`);
  for (const f of FACTIONS5) {
    const wr = fin.winRate[f];
    console.log(`  ${FACTION_RU[f].padEnd(12)} ${(wr * 100).toFixed(1).padStart(5)}%  ${wr >= 0.45 && wr <= 0.55 ? '✅' : '⚠️'}  (игр ${fin.games[f]})`);
  }
  console.log(`  Ничьих: ${fin.draws}`);
  console.log(`\nИтоговые коэффициенты: ${fmt(coefs)}`);

  fs.writeFileSync(path.join(ROOT, 'docs', 'balance', 'solver_result.json'),
    JSON.stringify({ coefs, finalWinRates: fin.winRate, games: fin.games, draws: fin.draws,
                     rounds, perPair, finalPerPair, convergedAt, ema }, null, 2), 'utf-8');
  console.log('Записано: docs/balance/solver_result.json');
}

function loadDataAfter(coefs: CoefMap) {
  writeCoefs(coefs, { _note: 'промежуточное состояние решателя' });
  regenerate();
  return loadData();
}

main();
