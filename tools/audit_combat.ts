/* v3.8: аудит боевых способностей в РУЧНОМ бою (как в прототипе и PvP).
   Запуск: npx esbuild tools/audit_combat.ts --bundle --platform=node --outfile=build/audit_combat.js && node build/audit_combat.js */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../src/engine/db';
import { GameEngine } from '../src/engine/engine';
import { CardData, CardType, DEFAULT_CONFIG, Faction, Keyword, Phase, Side, StatusType, EntityCreature } from '../src/engine/types';

const A = path.join(process.cwd(), 'unity/EchoCitadel/Assets/StreamingAssets');
const { db } = buildDatabase(JSON.parse(fs.readFileSync(path.join(A, 'Cards.json'), 'utf-8')) as CardsFile);
const decks: Record<string, string[]> = {};
for (const d of (JSON.parse(fs.readFileSync(path.join(A, 'Decks.json'), 'utf-8')) as DeckFile).decks) decks[d.id] = d.cards;
const ALL = [...db.values()];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = ''): void => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
function eng(fa = Faction.Pyromancer, fb = Faction.Pyromancer): GameEngine {
  const e = new GameEngine(db, [decks[fa], decks[fb]], { factions: [fa, fb], seed: 7, names: ['A', 'B'], config: { ...DEFAULT_CONFIG, combatMode: 'manual' } } as any);
  e.setup(); e.mulligan(Side.Player, []); e.mulligan(Side.Opponent, []);
  const E = e as any; E.phase = Phase.Combat; E.activeSide = Side.Player; E.turn = 9;
  for (const s of [Side.Player, Side.Opponent]) { e.p(s).mana = 10; e.p(s).maxMana = 10; e.p(s).creatures.length = 0; }
  e.drainEvents(); return e;
}
const cr = (pred: (c: CardData) => boolean): CardData => {
  const c = ALL.find(x => x.type === CardType.Creature && pred(x)); if (!c) throw new Error('нет карты'); return c;
};
const only = (k: string) => (c: CardData): boolean => (c.keywords as string[]).includes(k) && !(c.keywords as string[]).some(x => ['DivineShield','Taunt','Unblockable','Windfury','Trample','Lifesteal','Poisonous','Freezing','Rush'].includes(x) && x !== k) && !(c.effects ?? []).length;
const vanilla = (c: CardData): boolean => !(c.keywords ?? []).length && !(c.effects ?? []).length && !c.onTurnStart?.length;
function put(e: GameEngine, s: Side, c: CardData, ready = true): EntityCreature {
  const u = e.summon(s, c, { fromHand: false })!; if (ready) { (u as any).justPlayed = false; u.attacksThisTurn = 0; }
  u.statuses = u.statuses.filter(x => x.type !== StatusType.Shield); return u;
}

console.log('\n=== Аудит ручного боя ===');
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla), false);
  check('болезнь призыва: новое существо без Рывка не атакует', !e.canAttack(a)); }
{ const e = eng(); const c = cr(only('Rush')); const a = e.summon(Side.Player, c, { fromHand: false })!;
  check('Рывок: атакует в ход призыва', e.canAttack(a), c.name); }
{ const e = eng(); const a = put(e, Side.Player, cr(c => vanilla(c) && (c.attack ?? 0) >= 2));
  const t = put(e, Side.Opponent, cr(only('Taunt'))); const o = put(e, Side.Opponent, cr(vanilla));
  check('Провокация: нельзя бить героя', !e.manualAttack(Side.Player, a.uid, undefined, true));
  check('Провокация: нельзя бить другое существо', !e.manualAttack(Side.Player, a.uid, o.uid));
  check('Провокация: можно бить провокатора', e.manualAttack(Side.Player, a.uid, t.uid)); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); const u = put(e, Side.Opponent, cr(only('Unblockable')));
  check('Неуловимость: нельзя выбрать целью', !e.manualAttack(Side.Player, a.uid, u.uid));
  check('Неуловимость: герой доступен', e.manualAttack(Side.Player, a.uid, undefined, true)); }
{ const e = eng(); const c = cr(only('Windfury')); const a = put(e, Side.Player, c);
  const h0 = e.p(Side.Opponent).health;
  const r1 = e.manualAttack(Side.Player, a.uid, undefined, true), r2 = e.manualAttack(Side.Player, a.uid, undefined, true), r3 = e.manualAttack(Side.Player, a.uid, undefined, true);
  check('Буря: ровно 2 атаки', r1 && r2 && !r3, `${h0}→${e.p(Side.Opponent).health}`); }
{ const e = eng(); const c = cr(only('Poisonous')); const a = put(e, Side.Player, c); a.health = 20;
  const big = put(e, Side.Opponent, cr(vanilla)); big.health = 30; big.attack = 1;
  e.manualAttack(Side.Player, a.uid, big.uid); e.checkDeaths();
  const alive = e.p(Side.Opponent).creatures.includes(big);
  check('Ядовитый: выжившая цель отравлена', !alive || big.statuses.some(s => s.type === StatusType.Poison), `${c.name} → ${big.name}`); }
{ const e = eng(); const c = cr(only('Freezing')); const a = put(e, Side.Player, c);
  const big = put(e, Side.Opponent, cr(vanilla)); big.health = 30; a.health = 30;
  e.manualAttack(Side.Player, a.uid, big.uid);
  check('Ледяное касание: цель заморожена и не может атаковать', big.frozen && !e.canAttack(big)); }
{ const e = eng(); const c = cr(only('DivineShield')); const u = e.summon(Side.Opponent, c, { fromHand: false })!;
  const hp = u.health; const a = put(e, Side.Player, cr(c => vanilla(c) && (c.attack ?? 0) >= 1));
  e.manualAttack(Side.Player, a.uid, u.uid);
  check('Божественный щит: первый удар поглощён', u.health === hp && !u.statuses.some(s => s.type === StatusType.Shield), `${c.name}`); }
{ const e = eng(); const c = cr(only('Trample')); const a = put(e, Side.Player, c);
  a.attack = 6; const w = put(e, Side.Opponent, cr(vanilla)); w.health = 2;
  const h0 = e.p(Side.Opponent).health; e.manualAttack(Side.Player, a.uid, w.uid);
  check('Прорыв: избыток урона в героя', h0 - e.p(Side.Opponent).health === 4, `${h0}→${e.p(Side.Opponent).health}`); }
{ const e = eng(); const c = cr(only('Lifesteal')); const a = put(e, Side.Player, c);
  e.p(Side.Player).health = 10; e.manualAttack(Side.Player, a.uid, undefined, true);
  check('Вампиризм: лечит героя', e.p(Side.Player).health === 10 + a.attack); }
{ const e = eng(); const c = cr(c => (c.keywords as string[]).includes('Deathrattle') && (c.onDeath ?? []).some(x => x.op === 'summonToken'));
  const u = put(e, Side.Opponent, c); u.health = 0; (e as any).pendingDeaths.push(u); e.checkDeaths();
  check('Предсмертный хрип: срабатывает при смерти (призыв)', e.p(Side.Opponent).creatures.length >= 1, `${c.name}`); }
{ const e = eng(); const c = cr(c => (c.keywords as string[]).includes('Deathrattle') && (c.onDeath ?? []).some(x => x.op === 'draw'));
  const u = put(e, Side.Opponent, c); const h = e.p(Side.Opponent).hand.length; u.health = 0; (e as any).pendingDeaths.push(u); e.checkDeaths();
  check('Предсмертный хрип: добор при смерти', e.p(Side.Opponent).hand.length > h, c.name); }
{ const e = eng(); const c = cr(c => (c.keywords as string[]).includes('Deathrattle') && (c.onDeath ?? []).length > 0);
  const u = put(e, Side.Opponent, c); u.silenced = true; const n = e.p(Side.Opponent).creatures.length; const h = e.p(Side.Opponent).hand.length;
  u.health = 0; (e as any).pendingDeaths.push(u); e.checkDeaths();
  check('Немота отключает Предсмертный хрип', e.p(Side.Opponent).creatures.length === n - 1 && e.p(Side.Opponent).hand.length === h); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); a.attack = 3; a.health = 10;
  const d = put(e, Side.Opponent, cr(vanilla)); d.attack = 2; d.health = 10;
  const ah = a.health; e.manualAttack(Side.Player, a.uid, d.uid);
  check('Ответный урон защитника', a.health === ah - d.attack); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); a.attack = 0;
  check('Существо с атакой 0 не атакует', !e.canAttack(a) || !e.manualAttack(Side.Player, a.uid, undefined, true) || e.p(Side.Opponent).health === 30); }
console.log(`\n=== ИТОГ: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
