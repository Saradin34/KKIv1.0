/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — автоматический тестировщик баланса (ТЗ п.8.1)
   ---------------------------------------------------------------------
   Запуск:
     npx esbuild tools/balance/run_balance.ts --bundle --platform=node \
        --outfile=build/run_balance.js && node build/run_balance.js --matches 10000

   Выход:
     docs/balance/balance_report.csv    — CardName,Faction,TimesPlayed,Wins,
                                          WinRate,AvgDamage,AvgHeal
     docs/balance/faction_report.csv    — сводка по фракциям (цель 45–55%)
     docs/balance/summary.md            — человекочитаемый отчёт
   ===================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, DeckFile, CardsFile } from '../../src/engine/db';
import { runSimulation, SimulationReport } from '../../src/engine/match';
import { Faction, FACTION_RU } from '../../src/engine/types';

/** Корень проекта: ищем вверх package.json (бандл esbuild лежит в build/). */
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
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');
const OUT = path.join(ROOT, 'docs', 'balance');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function pct(x: number): string { return (x * 100).toFixed(1) + '%'; }

function main(): void {
  const matches = parseInt(arg('matches', '10000'), 10);
  const seed = parseInt(arg('seed', '12345'), 10);

  const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
  const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
  const { db } = buildDatabase(cardsFile);

  const format = arg('format', 'constructed');
  const factionOrder = ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal'];
  const decks: Record<string, string[]> = {};
  if (format === 'starter') {
    for (const d of decksFile.decks) if (d.format === 'starter') decks[d.faction] = d.cards;
  } else {
    for (const d of decksFile.decks) if (factionOrder.includes(d.id) && d.format !== 'starter') decks[d.id] = d.cards;
  }
  const factionIds = factionOrder.filter(id => !!decks[id]);
  if (factionIds.length !== factionOrder.length) throw new Error(`Не найдены 5 колод для формата ${format}`);

  console.log(`База: ${db.size} карт. Колод: ${Object.keys(decks).length} (${format}). Матчей: ${matches}, seed=${seed}`);
  const t0 = Date.now();

  // коэффициенты пассивок из tools/generator/faction_balance.json
  let passiveMul: Record<string, number> | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'generator', 'faction_balance.json'), 'utf-8'));
    passiveMul = {};
    for (const k of Object.keys(raw)) if (!k.startsWith('_') && raw[k]?.passiveMul !== undefined) passiveMul[k] = raw[k].passiveMul;
  } catch { passiveMul = undefined; }

  const report: SimulationReport = runSimulation(db, decks, {
    matches, baseSeed: seed, deckIds: factionIds, passiveMul,
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Прогон завершён за ${dt} с. Ничьих: ${report.draws}. Средняя длина партии: ${report.avgTurns.toFixed(1)} ходов.`);

  fs.mkdirSync(OUT, { recursive: true });

  // --- balance_report.csv (формат колонок из ТЗ п.8.1) ---
  // Формат колонок из ТЗ п.8.1 + служебные колонки для анализа
  const csv: string[] = ['CardName,Faction,TimesPlayed,Wins,WinRate,AvgDamage,AvgHeal,' +
                         'RelativeWinRate,WinRateWhenPlayed,FactionBaseWinRate,PlayRate,MatchesPresent,Type,Rarity,Cost,NeedsBalance'];
  for (const c of report.cards) {
    const name = `"${c.cardName.replace(/"/g, "'")}"`;
    csv.push([name, c.faction, c.timesPlayed, c.wins, c.winRate.toFixed(4),
              c.avgDamage.toFixed(2), c.avgHeal.toFixed(2),
              c.relativeWinRate.toFixed(4), c.winRateWhenPlayed.toFixed(4),
              c.factionBaseWinRate.toFixed(4), c.playRate.toFixed(3), c.matchesPresent,
              c.type, c.rarity, c.cost, c.needsBalance ? 'YES' : ''].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'balance_report.csv'), csv.join('\n'), 'utf-8');

  // --- faction_report.csv ---
  const fcsv: string[] = ['Faction,FactionRu,Games,Wins,Losses,WinRate,WithinTarget45_55,AvgTurns,AvgDamage,AvgHeal,AvgCardsPlayed,AvgEchoUsed'];
  for (const f of report.factions) {
    fcsv.push([f.faction, FACTION_RU[f.faction as Faction] ?? f.faction, f.games, f.wins, f.losses,
               f.winRate.toFixed(4), f.withinTarget ? 'YES' : 'NO',
               f.avgTurns.toFixed(1), f.avgDamage.toFixed(1), f.avgHeal.toFixed(1),
               f.avgCardsPlayed.toFixed(1), f.avgEchoUsed.toFixed(2)].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'faction_report.csv'), fcsv.join('\n'), 'utf-8');

  // --- summary.md ---
  const md: string[] = [];
  md.push('# Отчёт автотестера баланса — «Эхо-Цитадель»', '');
  md.push(`- Матчей сыграно: **${report.matches}**`);
  md.push(`- Seed: ${report.seed}`);
  md.push(`- Средняя длина партии: **${report.avgTurns.toFixed(1)}** ходов`);
  md.push(`- Ничьих (лимит ${200} ходов): ${report.draws}`);
  md.push(`- Время прогона: ${dt} с`);
  md.push('- Пассивки фракций: редакция ТЗ п.2.5 v2 (см. docs/ADDENDUM_passives.md)', '');
  md.push('## Винрейты фракций (целевой коридор ТЗ п.10.8: 45–55%)', '');
  md.push('| Фракция | Игр | Побед | Винрейт | В коридоре | Ср. ходов | Ср. урон | Ср. лечение | Ср. карт за игру | Эхо использовано |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const f of report.factions) {
    md.push(`| ${FACTION_RU[f.faction as Faction]} | ${f.games} | ${f.wins} | **${pct(f.winRate)}** | ${f.withinTarget ? '✅' : '⚠️'} | ${f.avgTurns.toFixed(1)} | ${f.avgDamage.toFixed(1)} | ${f.avgHeal.toFixed(1)} | ${f.avgCardsPlayed.toFixed(1)} | ${f.avgEchoUsed.toFixed(2)} |`);
  }
  md.push('');
  md.push('## Карты, требующие балансировки', '');
  md.push('Метрика: **RelativeWinRate = P(победа | карта разыграна) − P(победа | фракция)**.');
  md.push('Ноль — карта ровно среднего уровня своей фракции. Флаг `NeedsBalance` ставится при');
  md.push('|вкладе| > 5 п.п. и ≥100 розыгрышах (адаптация критерия ТЗ п.8.1 «>60% / <40%»:');
  md.push('«сырой» винрейт карты в колоде победителя неинформативен, т.к. карта входит в колоду');
  md.push('по построению — см. docs/BALANCE_MODEL.md, раздел «Метрики карт»).', '');
  md.push(`Всего помечено: **${report.outOfRange.length}** из ${report.cards.length}`, '');
  if (report.outOfRange.length) {
    md.push('| Карта | Фракция | Тип | Редк. | Cost | Розыгрышей | Вклад | Винрейт при розыгрыше | База фракции | Ср. урон | Вердикт |');
    md.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of report.outOfRange) {
      const verdict = c.relativeWinRate > 0 ? 'усилить цену / ослабить эффект' : 'усилить эффект / снизить цену';
      md.push(`| ${c.cardName} | ${FACTION_RU[c.faction as Faction]} | ${c.type} | ${c.rarity} | ${c.cost} | ${c.timesPlayed} | **${(c.relativeWinRate * 100).toFixed(1)} п.п.** | ${pct(c.winRateWhenPlayed)} | ${pct(c.factionBaseWinRate)} | ${c.avgDamage.toFixed(1)} | ${verdict} |`);
    }
  } else {
    md.push('_Все карты в пределах ±5 п.п. от среднего уровня своей фракции._');
  }
  md.push('');
  md.push('## Топ-15 карт с наибольшим положительным вкладом (кандидаты на нерф)', '');
  md.push('| # | Карта | Фракция | Cost | Вклад | Розыгрышей | Ср. урон |');
  md.push('|---|---|---|---|---|---|---|');
  report.cards.slice(0, 15).forEach((c, i) => md.push(`| ${i + 1} | ${c.cardName} | ${FACTION_RU[c.faction as Faction]} | ${c.cost} | ${(c.relativeWinRate * 100).toFixed(1)} п.п. | ${c.timesPlayed} | ${c.avgDamage.toFixed(1)} |`));
  md.push('');
  md.push('## Топ-15 карт с наибольшим отрицательным вкладом (кандидаты на бафф)', '');
  md.push('| # | Карта | Фракция | Cost | Вклад | Розыгрышей | Ср. урон |');
  md.push('|---|---|---|---|---|---|---|');
  report.cards.slice(-15).reverse().forEach((c, i) => md.push(`| ${i + 1} | ${c.cardName} | ${FACTION_RU[c.faction as Faction]} | ${c.cost} | ${(c.relativeWinRate * 100).toFixed(1)} п.п. | ${c.timesPlayed} | ${c.avgDamage.toFixed(1)} |`));
  md.push('');
  fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'), 'utf-8');

  console.log('\n=== ВИНРЕЙТЫ ФРАКЦИЙ ===');
  for (const f of report.factions) {
    console.log(`  ${(FACTION_RU[f.faction as Faction] ?? f.faction).padEnd(12)} ${pct(f.winRate).padStart(7)}  ${f.withinTarget ? '✅ в коридоре' : '⚠️  вне 45-55%'}  (игр: ${f.games})`);
  }
  console.log(`\nКарт, требующих балансировки (|вклад| > 5 п.п.): ${report.outOfRange.length} из ${report.cards.length}`);
  console.log(`Отчёты: ${path.relative(ROOT, OUT)}/balance_report.csv, faction_report.csv, summary.md`);
}

main();
