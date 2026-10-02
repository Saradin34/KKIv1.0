/* v3.8: аудит боевых способностей в РУЧНОМ бою (как в прототипе и PvP).
   Запуск: npx esbuild tools/audit_combat.ts --bundle --platform=node --outfile=build/audit_combat.js && node build/audit_combat.js */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../src/engine/db';
import { GameEngine } from '../src/engine/engine';
import { CardData, CardType, DEFAULT_CONFIG, Faction, Keyword, Phase, Side, StatusType, EntityCreature, TargetKind } from '../src/engine/types';

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
const only = (k: string) => (c: CardData): boolean => (c.keywords as string[]).includes(k) && !(c.keywords as string[]).some(x => ['DivineShield','Taunt','Unblockable','Windfury','Trample','Lifesteal','Poisonous','Freezing','Rush','Vigilance'].includes(x) && x !== k) && !(c.effects ?? []).length;
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
  const r1 = e.manualAttack(Side.Player, a.uid, undefined, true), tappedAfterFirst = a.tapped;
  const r2 = e.manualAttack(Side.Player, a.uid, undefined, true), r3 = e.manualAttack(Side.Player, a.uid, undefined, true);
  check('Буря: ровно 2 атаки, первая уже поворачивает существо', r1 && tappedAfterFirst && r2 && !r3, `${h0}→${e.p(Side.Opponent).health}`); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); const foe = put(e, Side.Opponent, cr(vanilla));
  const wrongTurnAttack = e.manualAttack(Side.Opponent, foe.uid, undefined, true);
  const attacked = e.manualAttack(Side.Player, a.uid, undefined, true);
  const tappedAfterAttack = a.tapped && a.attacksThisTurn === 1;
  e.manualCombatSkip = true; e.finishMainPhase();
  const remainsAfterOwnEnd = a.tapped && a.attacksThisTurn === 1;
  e.runTurn();
  const remainsOnOpponentTurn = e.activeSide === Side.Opponent && a.tapped && a.attacksThisTurn === 1;
  e.manualCombatSkip = true; e.finishMainPhase(); e.runTurn();
  const untapsOnOwnerStart = e.activeSide === Side.Player && !a.tapped && a.attacksThisTurn === 0;
  check('tap сохраняется весь ход противника и снимается только на своём Untap',
    !wrongTurnAttack && attacked && tappedAfterAttack && remainsAfterOwnEnd && remainsOnOpponentTurn && untapsOnOwnerStart,
    `чужая атака отклонена ${!wrongTurnAttack}; свой End ${remainsAfterOwnEnd}; ход врага ${remainsOnOpponentTurn}; Untap ${untapsOnOwnerStart}`); }
{ const e = eng(); const vigilantCard = cr(c => c.type === CardType.Creature && (c.keywords as string[]).includes('Vigilance'));
  const a = put(e, Side.Player, vigilantCard);
  const attacked = e.manualAttack(Side.Player, a.uid, undefined, true);
  check('Бдительность: после атаки остаётся развёрнутым, но обычный лимит атак действует',
    attacked && !a.tapped && a.attacksThisTurn === 1 && !e.canAttack(a), vigilantCard.name); }
{ const e = eng(); const vigilantCard = cr(c => c.type === CardType.Creature && (c.keywords as string[]).includes('Vigilance'));
  const a = put(e, Side.Player, vigilantCard); e.silence(a);
  const attacked = e.manualAttack(Side.Player, a.uid, undefined, true);
  check('Немота отключает Бдительность: атака снова поворачивает существо', attacked && a.tapped, vigilantCard.name); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); a.attacksThisTurn = 1; a.tapped = true;
  const hashTapped = e.stateHash(); a.tapped = false; const hashReady = e.stateHash(); a.tapped = true;
  const net = e.exportState(); const replica = eng(); replica.importState(net, false); const restored = replica.findCreature(a.uid);
  const mirrored = eng(); mirrored.importState(net, true); const mirroredCreature = mirrored.findCreature(a.uid);
  const legacy = JSON.parse(JSON.stringify(net)) as any;
  for (const pl of legacy.players) for (const creature of pl.creatures) delete creature.tapped;
  const oldReplica = eng(); oldReplica.importState(legacy, false); const oldCreature = oldReplica.findCreature(a.uid);
  check('сетевой снимок и hash сохраняют tap, mirror и старые снимки восстанавливаются',
    hashTapped !== hashReady && restored?.tapped === true && mirroredCreature?.tapped === true
      && mirroredCreature.owner === Side.Opponent && oldCreature?.tapped === true,
    `hash ${hashReady !== hashTapped}, replica ${restored?.tapped}, mirror ${mirroredCreature?.owner}/${mirroredCreature?.tapped}, old=${oldCreature?.tapped}`); }
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
{ const e = eng(); const base = cr(vanilla);
  const deathA: CardData = { ...base, id: 'audit-simultaneous-a', name: 'Погибший A',
    onDeath: [{ op: 'healAllFriendlyCreatures', value: 5 }] };
  const a = put(e, Side.Player, deathA), b = put(e, Side.Player, base), survivor = put(e, Side.Player, base);
  a.health = 0; b.health = 0; survivor.health = 1;
  (e as any).pendingDeaths.push(a, b); e.checkDeaths();
  check('одновременная смерть: deathrattle не спасает существо той же летальной пачки',
    !e.findCreature(a.uid) && !e.findCreature(b.uid) && (e.findCreature(survivor.uid)?.health ?? 0) > 1,
    `погибшие ${!e.findCreature(a.uid) && !e.findCreature(b.uid)}, выживший ${survivor.health}`); }
{ const e = eng(); const base = cr(vanilla);
  const deathA: CardData = { ...base, id: 'audit-combat-simultaneous-a', name: 'Хрип атакующего',
    onDeath: [{ op: 'draw', value: 1 }] };
  const deathB: CardData = { ...base, id: 'audit-combat-simultaneous-b', name: 'Хрип защитника',
    onDeath: [{ op: 'draw', value: 1 }] };
  const a = put(e, Side.Player, deathA), b = put(e, Side.Opponent, deathB);
  a.attack = b.attack = 5; a.health = b.health = 2;
  const handA = e.p(Side.Player).hand.length, handB = e.p(Side.Opponent).hand.length;
  e.manualAttack(Side.Player, a.uid, b.uid);
  check('боевой размен: оба летальных удара применяются до deathrattle',
    !e.findCreature(a.uid) && !e.findCreature(b.uid)
      && e.p(Side.Player).graveyard.filter(id => id === deathA.id).length === 1
      && e.p(Side.Opponent).graveyard.filter(id => id === deathB.id).length === 1
      && e.p(Side.Player).hand.length === handA + 1 && e.p(Side.Opponent).hand.length === handB + 1,
    `на поле ${!!e.findCreature(a.uid)}/${!!e.findCreature(b.uid)}, хрипы ${e.p(Side.Player).hand.length - handA}/${e.p(Side.Opponent).hand.length - handB}`); }
{ const e = eng(); const base = cr(vanilla);
  const deathA: CardData = { ...base, id: 'audit-reentrant-a', name: 'Взрыв погибшего',
    onDeath: [{ op: 'damageAllEnemyCreatures', value: 1 }] };
  const deathB: CardData = { ...base, id: 'audit-reentrant-b', name: 'Добор погибшего',
    onDeath: [{ op: 'draw', value: 1 }] };
  const a = put(e, Side.Player, deathA), b = put(e, Side.Opponent, deathB);
  const hand0 = e.p(Side.Opponent).hand.length;
  a.health = 0; b.health = 0; (e as any).pendingDeaths.push(a, b); e.checkDeaths();
  check('вложенная проверка не дублирует смерть, graveyard или deathrattle',
    e.p(Side.Player).graveyard.filter(id => id === deathA.id).length === 1
      && e.p(Side.Opponent).graveyard.filter(id => id === deathB.id).length === 1
      && e.stats[Side.Player].losses === 1 && e.stats[Side.Opponent].losses === 1
      && e.p(Side.Opponent).hand.length === hand0 + 1,
    `могилы ${e.p(Side.Player).graveyard.filter(id => id === deathA.id).length}/${e.p(Side.Opponent).graveyard.filter(id => id === deathB.id).length}, добор ${e.p(Side.Opponent).hand.length - hand0}`); }
{ const e = eng(); const base = cr(vanilla);
  const burnCard: CardData = { ...base, id: 'audit-burn-death', name: 'Горящий свидетель',
    onDeath: [{ op: 'heal', to: TargetKind.FriendlyHero, value: 1 }] };
  const startCard: CardData = { ...base, id: 'audit-start-trigger', name: 'Страж начала',
    onTurnStart: [{ op: 'damage', to: TargetKind.EnemyHero, value: 2 }] };
  const dying = put(e, Side.Player, burnCard), watcher = put(e, Side.Player, startCard);
  dying.health = 1; dying.statuses.push({ type: StatusType.Burn, value: 1, turnsLeft: 1 });
  e.p(Side.Player).health = 10; e.drainEvents();
  (e as any).doStartPhase();
  const events = e.drainEvents();
  const deathAt = events.findIndex(x => x.type === 'CreatureDeath' && x.uid === dying.uid);
  const deathrattleAt = events.findIndex(x => x.type === 'PlayerHeal' && x.side === Side.Player);
  const startAt = events.findIndex(x => x.type === 'PlayerDamage' && x.side === Side.Opponent);
  check('смерть от Горения и deathrattle разрешаются до следующего onTurnStart',
    deathAt >= 0 && deathrattleAt > deathAt && startAt > deathrattleAt,
    `события смерть=${deathAt}, хрип=${deathrattleAt}, следующий триггер=${startAt}`); }
{ const e = eng(); const base = cr(vanilla);
  const observerData: CardData = { ...base, id: 'audit-creature-dies-observer', name: 'Наблюдатель',
    onCreatureDies: [{ op: 'heal', to: TargetKind.FriendlyHero, value: 1 }] };
  const observer = put(e, Side.Player, observerData);
  const victimA = put(e, Side.Player, base), victimB = put(e, Side.Opponent, base);
  e.p(Side.Player).health = 10;
  victimA.health = 0; victimB.health = 0; (e as any).pendingDeaths.push(victimA, victimB); e.checkDeaths();
  check('onCreatureDies срабатывает по разу на каждую смерть в одновременной пачке',
    !e.findCreature(victimA.uid) && !e.findCreature(victimB.uid) && e.p(Side.Player).health === 12,
    `наблюдатель ${!!e.findCreature(observer.uid)}, HP 10→${e.p(Side.Player).health}`); }
{ const e = eng(); const base = cr(vanilla);
  const attacker = put(e, Side.Player, base); attacker.attack = 6; attacker.health = 10;
  const deathCard: CardData = { ...base, id: 'audit-combat-hp-deathrattle', name: 'Эхо боли',
    onDeath: [{ op: 'damage', to: TargetKind.EnemyHero, value: 3 }] };
  const defender = put(e, Side.Opponent, deathCard); defender.health = 1; defender.attack = 1;
  e.p(Side.Player).health = 12;
  e.manualAttack(Side.Player, attacker.uid, defender.uid);
  const rec = e.attackQueue[e.attackQueue.length - 1];
  const triggerDamage = rec?.hpEvents.filter(x => x.kind === 'damage' && x.side === Side.Player && x.amount === 3).length ?? 0;
  check('боевой снимок включает урон герою от deathrattle и итоговый HP',
    triggerDamage === 1 && rec.heroHpAfter[Side.Player] === 9 && e.p(Side.Player).health === 9,
    `событий ${triggerDamage}, итог HP ${rec?.heroHpAfter[Side.Player]}`); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); a.attack = 3; a.health = 10;
  const d = put(e, Side.Opponent, cr(vanilla)); d.attack = 2; d.health = 10;
  const ah = a.health; e.manualAttack(Side.Player, a.uid, d.uid);
  check('Ответный урон защитника', a.health === ah - d.attack); }
{ const e = eng(); const a = put(e, Side.Player, cr(vanilla)); a.attack = 0;
  check('Существо с атакой 0 не атакует', !e.canAttack(a) || !e.manualAttack(Side.Player, a.uid, undefined, true) || e.p(Side.Opponent).health === 30); }
{
  const core = path.join(process.cwd(), 'unity/EchoCitadel/Assets/Scripts/Core');
  const unityTurn = fs.readFileSync(path.join(core, 'GameEngine.Turn.cs'), 'utf-8');
  const unityStatuses = fs.readFileSync(path.join(core, 'GameEngine.Statuses.cs'), 'utf-8');
  const unityTypes = fs.readFileSync(path.join(core, 'GameTypes.cs'), 'utf-8');
  const unityEnums = fs.readFileSync(path.join(core, 'GameEnums.cs'), 'utf-8');
  const unityCard = JSON.parse(fs.readFileSync(path.join(A, 'Cards.json'), 'utf-8')).cards.find((c: any) => c.id === 'ent_04');
  const ownerUntap = /c\.Tapped = false; c\.AttacksThisTurn = 0/.test(unityTurn);
  const attackTap = /CommitAttack\(atk\)/.test(unityTurn) && /CommitAttack\(c\)/.test(unityTurn)
    && /if \(!attacker\.HasKeyword\(Keyword\.Vigilance\)\) attacker\.Tapped = true/.test(unityTurn);
  const tappedGate = /if \(c\.Tapped && c\.AttacksThisTurn == 0\) return false/.test(unityStatuses);
  const syncedCard = unityCard?.keywords?.includes('Vigilance') && /Keyword\.Vigilance/.test(unityEnums);
  check('Unity-порт синхронизирован: tapped, Untap, Vigilance и ent_04',
    /public bool Tapped/.test(unityTypes) && ownerUntap && attackTap && tappedGate && syncedCard,
    `Tapped=${/public bool Tapped/.test(unityTypes)}, owner Untap=${ownerUntap}, attack/Vigilance=${attackTap}, gate=${tappedGate}, ent_04=${!!syncedCard}`);
}
console.log(`\n=== ИТОГ: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
