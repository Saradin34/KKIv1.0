/* =====================================================================
   Аудит способностей: сценарные проверки движка + покрытие ключевых слов.
   Запуск: npm run audit:abilities
   Каждый сценарий изолирован: свой GameEngine, детерминированный seed.
   ===================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../src/engine/db';
import { GameEngine } from '../src/engine/engine';
import { GameResult } from '../src/engine/types';
import { MatchRunner } from '../src/engine/match';
import {
  CardData, CardType, Element, Faction, GameEventType, Keyword, Phase, Side, StatusType, TargetKind,
} from '../src/engine/types';

const ROOT = (() => { let d = __dirname; for (let i = 0; i < 8; i++) { if (fs.existsSync(path.join(d, 'package.json'))) return d; d = path.dirname(d); } return process.cwd(); })();
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');
const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
const { db } = buildDatabase(cardsFile);
const ALL = [...db.values()];
const decks: Record<string, string[]> = {};
for (const d of decksFile.decks) decks[d.id] = d.cards;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function freshEngine(fa = Faction.Pyromancer, fb = Faction.Necrus): GameEngine {
  const e = new GameEngine(db, [decks[fa], decks[fb]], { factions: [fa, fb], seed: 4242, names: ['A', 'B'] });
  e.setup();
  e.mulligan(Side.Player, [0, 1, 2, 3, 4]);
  e.mulligan(Side.Opponent, [0, 1, 2, 3, 4]);
  const E = e as any;
  E.phase = Phase.Main; E.activeSide = Side.Player;
  e.p(Side.Player).mana = 10; e.p(Side.Player).maxMana = 10;
  e.p(Side.Opponent).mana = 10; e.p(Side.Opponent).maxMana = 10;
  e.drainEvents();
  return e;
}
const find = (pred: (c: CardData) => boolean): CardData => {
  const c = ALL.find(pred);
  if (!c) throw new Error('не найдена карта для сценария');
  return c;
};

async function main(): Promise<void> {
console.log('\n=== Аудит способностей «Эхо-Цитадель» ===\n[1] Покрытие ключевых слов и целей');
for (const kw of Object.values(Keyword)) {
  const n = ALL.filter(c => (c.keywords ?? []).includes(kw)).length;
  check(`ключевое слово ${kw} встречается на картах`, n > 0, `${n} карт`);
}
for (const tk of [TargetKind.EnemyCreature, TargetKind.FriendlyCreature, TargetKind.AnyCreature, TargetKind.EnemyHero, TargetKind.FriendlyHero]) {
  const n = ALL.filter(c => c.target === tk).length;
  check(`вид цели ${tk} присутствует`, n > 0, `${n} карт`);
}
{
  const n = ALL.filter(c => c.target === TargetKind.AnyHero).length;
  console.log(`  ⚠ AnyHero: ${n} карт в наборе (движок поддерживает — зарезервировано под будущие карты)`);
}

console.log('\n[2] Сценарии способностей');
{ // Бафф своего существа заклинанием с FriendlyCreature
  const e = freshEngine();
  const buff = find(c => c.type === CardType.Spell && c.target === TargetKind.FriendlyCreature
    && (c.effects ?? []).some(x => x.op === 'buffAttack' || x.op === 'buffHealth'));
  const victim = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const u = e.summon(Side.Player, victim)!;
  const op = (buff.effects ?? []).find(x => x.op === 'buffAttack' || x.op === 'buffHealth')!;
  const before = op.op === 'buffAttack' ? u.attack : u.health;
  const valid = e.validTargets(Side.Player, buff).some(t => t.uid === u.uid);
  e.castInstantSpell(Side.Player, buff, u.uid, Side.Player);
  const after = op.op === 'buffAttack' ? u.attack : u.health;
  check('заклинание видит СВОЁ существо целью и баффает его', valid && after === before + (op.value ?? 0),
    `${buff.name}: ${before}→${after} (ожид. +${op.value})`);
}
{ // Провокация: авто-выбор цели бьёт таунта
  const e = freshEngine();
  const taunt = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Taunt));
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  e.summon(Side.Player, taunt); e.summon(Side.Player, plain);
  const atk = e.summon(Side.Opponent, plain)!;
  (atk as any).summonedTurn = -5; // снимаем болезнь призыва
  const t = e.chooseAutoTarget(Side.Opponent, atk);
  check('авто-атака при наличии Провокации идёт в таунта', t.creature?.cardId === taunt.id,
    t.creature ? `цель: ${t.creature.name}` : 'цель: герой');
}
{ // Вампиризм: урон лечит героя владельца
  const e = freshEngine();
  const ls = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Lifesteal));
  e.damageHero(Side.Player, 6);
  const hp0 = e.p(Side.Player).health;
  const u = e.summon(Side.Player, ls)!;
  (u as any).summonedTurn = -5;
  e.resolveAttack(u, undefined, e.p(Side.Opponent));
  check('Вампиризм лечит героя на величину урона', e.p(Side.Player).health === Math.min(30, hp0 + u.attack),
    `${hp0}→${e.p(Side.Player).health} при атаке ${u.attack}`);
}
{ // Прорыв: избыточный урон уходит в героя (без пассивки Некрусов, чтобы тест был изолирован)
  const e = freshEngine(Faction.Pyromancer, Faction.Pyromancer);
  const tr = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Trample));
  const wall = find(c => c.type === CardType.Creature && (c.health ?? 99) <= 3);
  const a = e.summon(Side.Player, tr)!; (a as any).summonedTurn = -5;
  const d = e.summon(Side.Opponent, wall)!;
  const hero0 = e.p(Side.Opponent).health;
  e.resolveAttack(a, d, e.p(Side.Opponent));
  const excess = Math.max(0, a.attack - (wall.health ?? 0));
  check('Прорыв пробивает избыток в героя', hero0 - e.p(Side.Opponent).health === excess,
    `избыток ${excess}, герой ${hero0}→${e.p(Side.Opponent).health}`);
}
{ // Боевой клич с добором
  const e = freshEngine();
  const bc = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Battlecry)
    && (c.effects ?? []).some(x => x.op === 'draw'));
  const n = (bc.effects ?? []).find(x => x.op === 'draw')!.value ?? 0;
  const idx = e.p(Side.Player).hand.push(bc.id) - 1;
  const hand0 = e.p(Side.Player).hand.length;
  const ok = e.playCard(Side.Player, idx);
  check('Боевой клич добирает карты при выходе', ok && e.p(Side.Player).hand.length === hand0 - 1 + n,
    `${bc.name}: рука ${hand0}→${e.p(Side.Player).hand.length} (ожид. ${hand0 - 1 + n})`);
}
{ // Эхо: повторяет последнее заклинание бесплатно один раз
  const e = freshEngine();
  const zap = find(c => c.type === CardType.Spell && c.target === TargetKind.FriendlyCreature
    && (c.effects ?? []).some(x => x.op === 'buffAttack' || x.op === 'buffHealth') && c.subtype !== 'Ritual' as any);
  const op = (zap.effects ?? []).find(x => x.op === 'buffAttack' || x.op === 'buffHealth')!;
  const val = op.value ?? 0;
  const pet = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const u = e.summon(Side.Player, pet)!;
  const get = (): number => (op.op === 'buffAttack' ? u.attack : u.health);
  e.p(Side.Player).echoPoints = 1;
  e.castInstantSpell(Side.Player, zap, u.uid, Side.Player);
  const v0 = get();
  const chk = e.canUseEcho(Side.Player);
  const used = e.useEcho(Side.Player, u.uid, Side.Player);
  const chk2 = e.canUseEcho(Side.Player);
  check('Эхо повторяет заклинание и гаснет после использования',
    chk.ok && used && get() === v0 + val && !chk2.ok && e.p(Side.Player).echoUsedThisGame === 1,
    `${zap.name}: ${op.op} ${v0}→${get()} (эхо +${val}), повтор запрещён: ${chk2.reason ?? 'да'}`);
}
{ // Руна: устанавливается как перманентное правило
  const e = freshEngine();
  const rune = find(c => c.type === CardType.Rune);
  e.playRune(Side.Player, rune);
  const evs = e.drainEvents();
  check('руна встаёт в ряд рун и даёт событие RunePlayed',
    e.p(Side.Player).runes.length === 1 && evs.some(v => v.type === GameEventType.RunePlayed), rune.name);
}

console.log('\n[2а] Сквозные регрессии: цели, комбинированные эффекты, статусы, бой');
{
  const e = freshEngine();
  const targeted = find(c => c.type === CardType.Spell && c.target === TargetKind.EnemyCreature
    && (c.effects ?? []).length > 0);
  const idx = e.p(Side.Player).hand.push(targeted.id) - 1;
  const playable = e.canPlay(Side.Player, idx);
  const played = e.playCard(Side.Player, idx);
  check('целевая карта без допустимой цели заблокирована и не тратится',
    !playable.ok && !played && e.p(Side.Player).hand.includes(targeted.id), targeted.name);
}
{
  const e = freshEngine();
  const nec06 = db.get('nec_06')!;
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const first = e.summon(Side.Opponent, plain)!;
  const chosen = e.summon(Side.Opponent, plain)!;
  const idx = e.p(Side.Player).hand.push(nec06.id) - 1;
  const ok = e.playCard(Side.Player, idx, chosen.uid, Side.Opponent);
  check('Боевой клич сохраняет выбранную цель (nec_06)', ok
    && chosen.statuses.some(s => s.type === StatusType.Poison)
    && !first.statuses.some(s => s.type === StatusType.Poison),
    `выбрано ${chosen.name} #${chosen.uid}`);
}
{
  const e = freshEngine();
  const spore = db.get('ter_s10')!;
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const own = e.summon(Side.Player, plain)!;
  const foes = [e.summon(Side.Opponent, plain)!, e.summon(Side.Opponent, plain)!];
  own.health = own.maxHealth = 20;
  for (const foe of foes) foe.health = foe.maxHealth = 20;
  const idx = e.p(Side.Player).hand.push(spore.id) - 1;
  const ok = e.playCard(Side.Player, idx);
  check('ter_s10 — заклинание без creature-only полей; базовые 3 + пассивка Pyromancer (+2)',
    spore.type === CardType.Spell && spore.attack == null && spore.health == null
      && !(spore.keywords ?? []).length && spore.healReduction == null
      && ok && own.health === 20 && foes.every(c => c.health === 15),
    `свои ${own.health}; враги ${foes.map(c => c.health).join('/')}`);
}
{
  const e = freshEngine();
  const spell = db.get('pyr_s01')!; // AnyCreature; у эффекта damage нет отдельного поля to
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const first = e.summon(Side.Opponent, plain)!;
  const chosen = e.summon(Side.Opponent, plain)!;
  first.health = first.maxHealth = 20;
  chosen.health = chosen.maxHealth = 20;
  const idx = e.p(Side.Player).hand.push(spell.id) - 1;
  const ok = e.playCard(Side.Player, idx, chosen.uid, Side.Opponent);
  check('цель заклинания сохраняется через стек и наследуется эффектом без to',
    ok && chosen.health < 20 && first.health === 20, `${first.health}/${chosen.health}`);
}
{
  const e = freshEngine();
  const nec06 = db.get('nec_06')!;
  const friendly = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const enemy = e.summon(Side.Opponent, friendly)!;
  e.summon(Side.Player, friendly);
  const idx = e.p(Side.Player).hand.push(nec06.id) - 1;
  const mana = e.p(Side.Player).mana;
  const ok = e.playCard(Side.Player, idx, e.p(Side.Player).creatures[0].uid, Side.Player);
  check('невалидная/чужая цель не подменяется первой допустимой и не тратит карту',
    !ok && e.p(Side.Player).hand.includes(nec06.id) && e.p(Side.Player).mana === mana
      && !enemy.statuses.some(s => s.type === StatusType.Poison));
}
{
  const e = freshEngine();
  const combo = db.get('wtc_04')!;
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const chosen = e.summon(Side.Opponent, plain)!;
  const randomTarget = e.summon(Side.Opponent, plain)!;
  // Задаём случайную выборку так, чтобы второй эффект обязан был попасть в другую цель.
  (e.rng as any).shuffle = (arr: unknown[]) => arr.slice().reverse();
  const idx = e.p(Side.Player).hand.push(combo.id) - 1;
  const ok = e.playCard(Side.Player, idx, chosen.uid, Side.Opponent);
  const has = (c: typeof chosen, s: StatusType): boolean => c.statuses.some(x => x.type === s);
  check('составной эффект: ручная цель и случайная компонента не перехватывают друг друга', ok
    && has(chosen, StatusType.Poison) && !has(chosen, StatusType.Burn)
    && has(randomTarget, StatusType.Burn) && !has(randomTarget, StatusType.Poison),
    `${combo.name}: Яд на выбранной, Горение на другой`);
}
{
  const e = freshEngine();
  const source = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Lifesteal));
  const wall = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const attacker = e.summon(Side.Player, source)!;
  attacker.attack = 10;
  attacker.keywords.push(Keyword.Trample);
  attacker.justPlayed = false; attacker.summonedOnTurn = -5;
  const defender = e.summon(Side.Opponent, wall)!;
  defender.health = 2; defender.maxHealth = 2;
  e.p(Side.Player).health = 5;
  e.resolveAttack(attacker, defender, e.p(Side.Opponent));
  const rec = e.attackQueue[e.attackQueue.length - 1]!;
  check('Вампиризм + Прорыв: overkill по существу не лечит повторно',
    e.p(Side.Player).health === 15 && rec.lifestealAmount === 10,
    `5→${e.p(Side.Player).health}, фактическое лечение ${rec.lifestealAmount} (2 по существу + 8 герою)`);
}
{
  const e = freshEngine();
  const silenceCard = db.get('aur_08')!;
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const frozen = e.summon(Side.Opponent, plain)!;
  frozen.justPlayed = false; frozen.summonedOnTurn = -5;
  e.addStatus(frozen, { type: StatusType.Freeze, value: 1, turnsLeft: 2 });
  const idx = e.p(Side.Player).hand.push(silenceCard.id) - 1;
  const ok = e.playCard(Side.Player, idx, frozen.uid, Side.Opponent);
  check('Немота снимает заморозку и разблокирует атаку', ok && frozen.silenced
    && !frozen.frozen && e.canAttack(frozen));
}
{
  const e = freshEngine();
  const rune = find(c => c.type === CardType.Rune && (c as any).aura?.op === 'debuffAttackEnemy');
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  e.playRune(Side.Opponent, rune);
  const creature = e.summon(Side.Player, plain)!;
  const expected = Math.max(0, (plain.attack ?? 0) - ((rune as any).aura.value ?? 0));
  check('вражеская руна-аура ослабляет существо, призванное позже', creature.attack === expected,
    `${creature.attack} атаки; ожидалось ${expected}`);
}
{
  const e = freshEngine();
  const baseRune = find(c => c.type === CardType.Rune && (c as any).aura?.op === 'buffAttack');
  const aura = (baseRune as any).aura;
  const focused = { ...baseRune, aura: { ...aura, matches: [Element.Fire] } } as CardData;
  e.playRune(Side.Player, focused);
  const fireCard = find(c => c.type === CardType.Creature && c.element === Element.Fire);
  const earthCard = find(c => c.type === CardType.Creature && c.element === Element.Earth);
  const fire = e.summon(Side.Player, fireCard)!;
  const earth = e.summon(Side.Player, earthCard)!;
  check('фильтр matches у ауры применяет бафф только к совпавшей стихии',
    fire.attack === (fireCard.attack ?? 0) + (aura.value ?? 0)
      && earth.attack === (earthCard.attack ?? 0), `${fire.name}/${earth.name}`);
}
{
  const e = freshEngine();
  const shield = db.get('aur_s18')!;
  e.p(Side.Player).damageReduction = 0;
  e.p(Side.Player).incomingDamageReductionTurns = 0;
  e.castInstantSpell(Side.Player, shield);
  const firstHit = e.damageHero(Side.Player, 4);
  e.finishMainPhase(); // собственный конец хода защиту не снимает
  const survivesOwnEnd = e.p(Side.Player).damageReduction === 1;
  e.runTurn(); // ход противника
  e.finishMainPhase(); // его конец снимает временную защиту
  const expired = e.p(Side.Player).damageReduction === 0;
  const nextHit = e.damageHero(Side.Player, 2);
  check('Защита героя действует до конца следующего хода противника и затем сбрасывается',
    firstHit === 3 && survivesOwnEnd && expired && nextHit === 2,
    `урон ${firstHit}, после своего хода ${survivesOwnEnd}, после чужого ${expired}`);
}
{
  const e = freshEngine();
  const ramp = db.get('ter_s09')!;
  e.p(Side.Player).maxMana = 10; e.p(Side.Player).mana = 10;
  e.castInstantSpell(Side.Player, ramp);
  check('прирост максимальной маны не переполняет текущую ману',
    e.p(Side.Player).maxMana === 10 && e.p(Side.Player).mana === 10);
}
{
  const e = freshEngine();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  e.onBeforeCombatEnd = () => gate;
  const finished = e.finishMainPhase();
  const waitsForCombat = e.phase === Phase.Combat && e.activeSide === Side.Player && e.animating
    && finished instanceof Promise;
  release();
  await finished;
  check('фаза/передача хода ждёт завершения боевой анимации', waitsForCombat
    && e.phase === Phase.End && e.activeSide === Side.Opponent && !e.animating);
}
{
  const e = freshEngine();
  e.onBeforeCombatEnd = () => Promise.reject(new Error('VFX-тест'));
  let rejected = false;
  try { await e.finishMainPhase(); } catch { rejected = true; }
  check('ошибка VFX не оставляет движок в Combat и не блокирует передачу хода',
    rejected && e.phase === Phase.End && e.activeSide === Side.Opponent && !e.animating);
}

console.log('\n[2б] Стадии назначения защитника (блоки/уклонение/статусы)');
{ // Неуловимого не выбирают блокёром, пока есть обычные
  const e = freshEngine();
  const eva = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Unblockable));
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  e.summon(Side.Player, eva); e.summon(Side.Player, plain);
  const atk = e.summon(Side.Opponent, plain)!;
  (atk as any).summonedTurn = -5;
  const t = e.chooseAutoTarget(Side.Opponent, atk);
  check('Неуловимое существо не назначается защитником при наличии обычных',
    t.creature?.cardId === plain.id, t.creature ? `блокёр: ${t.creature.name}` : 'герой');
}
{ // Если все неуловимые — авто-атака идёт в героя
  const e = freshEngine();
  const eva = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Unblockable));
  e.summon(Side.Player, eva);
  const atk = e.summon(Side.Opponent, eva)!;
  (atk as any).summonedTurn = -5;
  const t = e.chooseAutoTarget(Side.Opponent, atk);
  check('против неуловимых без обычных блокёров авто-атака бьёт героя', t.hitHero && !t.creature);
}
{ // Заморозка запрещает атаку
  const e = freshEngine();
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const u = e.summon(Side.Player, plain)!;
  (u as any).summonedOnTurn = -5; (u as any).justPlayed = false;
  const before = e.canAttack(u);
  u.frozen = true;
  check('замороженное существо не может атаковать', before === true && e.canAttack(u) === false);
}
{ // Буря: две атаки за ход
  const e = freshEngine();
  const wf = find(c => c.type === CardType.Creature && (c.keywords ?? []).includes(Keyword.Windfury));
  const u = e.summon(Side.Player, wf)!;
  (u as any).summonedOnTurn = -5; (u as any).justPlayed = false;
  u.attacksThisTurn = 1;
  const one = e.canAttack(u);
  u.attacksThisTurn = 2;
  check('Буря даёт ровно две атаки за ход', one === true && e.canAttack(u) === false);
}
{ // Щит поглощает первый удар целиком
  const e = freshEngine();
  const plain = find(c => c.type === CardType.Creature && (c.keywords ?? []).length === 0);
  const u = e.summon(Side.Player, plain)!;
  const hp0 = u.health;
  e.addStatus(u, { type: StatusType.Shield as any, value: 1 } as any);
  const dealt = e.damageCreature(u, 4, { source: 'тест' });
  const hp1 = u.health;
  const shieldLeft = u.statuses.some(st => st.type === StatusType.Shield);
  const dealt2 = e.damageCreature(u, 4, { source: 'тест2' });   // без щита урон проходит
  check('Щит поглощает удар целиком (по заряду за удар)',
    dealt === 0 && hp1 === hp0 && !shieldLeft && dealt2 === 4 && u.health === hp0 - 4,
    `удар1 ${dealt} (щит снят: ${!shieldLeft}), удар2 ${dealt2}, hp ${hp0}→${u.health}`);
}

console.log('\n[2в] Снятие жизней: летальность, оверкилл, порядок проверок состояний');
{
  const e = freshEngine();
  const plain = find(c => c.type === 'Creature' && (c.attack ?? 0) > 0 && !(c.keywords ?? []).length);
  const u = e.summon(Side.Player, plain)!
  e.damageCreature(u, u.health + 3, { source: 'оверкилл' });
  const onBoardBefore = e.p(Side.Player).creatures.some(c => c.uid === u.uid);
  e.checkDeaths();
  const onBoardAfter = e.p(Side.Player).creatures.some(c => c.uid === u.uid);
  const inGrave = e.p(Side.Player).graveyard.includes(u.cardId);
  check('летальный урон: существо дожидается проверки состояний и уходит на кладбище',
    u.health < 0 && onBoardBefore && !onBoardAfter && inGrave,
    `hp ${u.health}, на доске до SBA: ${onBoardBefore}, после: ${onBoardAfter}, в кладбище: ${inGrave}`);
}
{
  const e = freshEngine();
  e.p(Side.Player).health = 3;
  const dealt = e.damageHero(Side.Player, 10, { source: 'оверкилл героя' });
  check('оверкилл героя: отрицательный перехлёст виден (3 − 10 = −7), бой завершён',
    e.p(Side.Player).health === -7 && dealt === 10 && e.result === GameResult.OpponentWin,
    `health ${e.p(Side.Player).health}, dealt ${dealt}, результат ${e.result}`);
}
{
  const e = freshEngine();
  const plain = find(c => c.type === 'Creature' && (c.attack ?? 0) > 0 && !(c.keywords ?? []).length);
  const u = e.summon(Side.Player, plain)!
  const before = u.health;
  e.damageCreature(u, 2, { source: 'обычный урон' });
  check('снятие жизней существа: health уменьшается ровно на величину урона',
    u.health === before - 2, `hp ${before}→${u.health}`);
}

console.log('\n[4] Корректность стадий по MTG (порядок фаз, untap, draw, мана)');
{
  const facs = Object.values(Faction).filter(f => decks[f as string]);
  let seqBad = 0, untapBad = 0, drawBad = 0, manaBad = 0, cycles = 0, checkedCycles = 0;
  const badSamples: string[] = [];
  for (let m = 0; m < 6; m++) {
    const a = facs[m % facs.length], b2 = facs[(m * 2 + 1) % facs.length];
    type Ev =
      | { k: 'S'; side: Side }
      | { k: 'P'; phase: Phase }
      | { k: 'D'; side: Side }
      | { k: 'R'; side: Side; maxMana: number; mana: number; bonus: number };
    const evs: Ev[] = [];
    const e = new GameEngine(db, [decks[a], decks[b2]], {
      factions: [a, b2], seed: 700 + m, names: ['A', 'B'],
      hooks: {
        onEvent: (ev) => {
          if (ev.type === GameEventType.TurnStarted) evs.push({ k: 'S', side: ev.side ?? Side.Player });
          else if (ev.type === GameEventType.PhaseChanged) {
            const ph = (ev as { phase?: Phase }).phase as Phase;
            evs.push({ k: 'P', phase: ph });
            // Untap-инвариант проверяем живьём: в шаг Start существа активной стороны развёрнуты
            if (ph === Phase.Start && e.p(e.activeSide).creatures.some(c => c.attacksThisTurn > 0)) untapBad++;
            // снапшот маны ПОСЛЕ шага ресурса (эмит Main идёт следом за doResourcePhase)
            if (ph === Phase.Main) {
              const sd = e.activeSide;
              evs.push({ k: 'R', side: sd, maxMana: e.p(sd).maxMana, mana: e.p(sd).mana, bonus: e.p(sd).bonusMana });
            }
          } else if (ev.type === GameEventType.CardDrawn) evs.push({ k: 'D', side: ev.side ?? Side.Player });
          else if (ev.type === GameEventType.CardBurned) evs.push({ k: 'D', side: ev.side ?? Side.Player });  // переполненная рука: добол сгорает — шаг добора прошёл
        },
      },
    });
    e.setup();
    e.mulligan(Side.Player, [0, 1, 2, 3, 4]);
    e.mulligan(Side.Opponent, [0, 1, 2, 3, 4]);
    let guard = 0;
    while (e.result === GameResult.Ongoing && e.turn <= 6 && guard++ < 40) {
      e.runTurn();
      if (e.phase === Phase.Main && e.result === GameResult.Ongoing) e.finishMainPhase();
    }
    // сворачиваем поток в циклы ходов; сторона цикла берётся из S, а для первого хода — из R/D
    const ownCnt: Record<number, number> = { 0: 0, 1: 0 };
    let cur: { side: Side | null; phases: Phase[]; draws: number } | null = null;
    const close = (): void => {
      if (!cur) return;
      cycles++;
      const interrupted = !cur.phases.includes(Phase.End);   // хвост потока/обрыв партией — не цикл
      if (!interrupted) {
        checkedCycles++;
        const want = ['Start', 'Resource', 'Main', 'Combat', 'End'].join(',');
        if (cur.phases.join(',') !== want) seqBad++;
        if (cur.draws !== 1) { drawBad++; if (badSamples.length < 8) badSamples.push(`cyc side${cur.side} d=${cur.draws} ph=${cur.phases.join('.')}`); }
      }
      cur = null;
    };
    let anyP = false;
    const prevMax: Record<number, number> = { 0: 0, 1: 0 };
    for (const ev of evs) {
      if (ev.k === 'P') anyP = true;
      if (!anyP && ev.k !== 'P') continue;   // добора муллигана/старта не принадлежат циклам
      if (ev.k === 'S') { close(); cur = { side: ev.side, phases: [], draws: 0 }; }
      else if (ev.k === 'P') {
        if (!cur) cur = { side: null, phases: [], draws: 0 };              // первый ход без TurnStarted
        if (ev.phase === Phase.Start && cur.phases.length > 0) { close(); cur = { side: null, phases: [], draws: 0 }; }
        cur.phases.push(ev.phase);
      } else if (ev.k === 'R') {
        if (!cur) cur = { side: null, phases: [], draws: 0 };
        if (cur.side === null) cur.side = ev.side;
        ownCnt[ev.side] = (ownCnt[ev.side] ?? 0) + 1;
        // MTG: за свой ход кристалл маны растёт ровно на 1 (до 10) и заполняется в ресурс-шаг
        // MTG: базовый кристалл +1 за свой ход (до 10); пул заполнен целиком,
        // включая бонусную ману пассивок/рун (totalMax = min(10, base + bonus))
        if (ev.maxMana !== Math.min(10, (prevMax[ev.side] ?? 0) + 1)
          || ev.mana !== Math.min(10, ev.maxMana + ev.bonus)) {
          manaBad++;
          if (badSamples.length < 10) badSamples.push(`mana side${ev.side} max=${ev.maxMana} bonus=${ev.bonus} mana=${ev.mana} prev=${prevMax[ev.side]}`);
        }
        prevMax[ev.side] = ev.maxMana;
      } else {
        if (!cur) cur = { side: null, phases: [], draws: 0 };
        if (cur.side === null) cur.side = ev.side;
        if (ev.side !== cur.side) { drawBad++; if (badSamples.length < 8) badSamples.push(`D${ev.side} vs cyc side${cur.side} ph=${cur.phases.join('.')}`); }
        else cur.draws++;
      }
    }
    close();
  }
  check('порядок стадий каждого хода: Start→Resource→Main→Combat→End', seqBad === 0, `${checkedCycles} полных ходов, отклонений ${seqBad}`);
  check('Untap: в шаг Start все существа активной стороны развёрнуты', untapBad === 0, `нарушений ${untapBad}`);
  check('Draw: ровно 1 карта своей стороны за цикл хода', drawBad === 0, `нарушений ${drawBad}${badSamples.length ? ' | ' + badSamples.join(' ; ') : ''}`);
  check('Мана: +1 кристалл за свой ход (до 10), пул заполнен с учётом бонусной маны', manaBad === 0, `нарушений ${manaBad}`);
}

console.log('\n[3] Exhaustive-аудит каталога и легального розыгрыша');
{
  const typeLines = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'types.ts'), 'utf-8').split(/\r?\n/);
  const declaredOps = new Set<string>();
  let inEffectOp = false;
  for (const line of typeLines) {
    if (line.includes('export type EffectOp =')) { inEffectOp = true; continue; }
    if (!inEffectOp) continue;
    for (const match of line.matchAll(/'([^']+)'/g)) declaredOps.add(match[1]);
    if (line.trim().endsWith(';')) break;
  }
  const engineText = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'engine.ts'), 'utf-8');
  const implementedOps = new Set(Array.from(engineText.matchAll(/case\s+'([^']+)'/g), m => m[1]));
  const targetValues = new Set(Object.values(TargetKind));
  const keywordValues = new Set(Object.values(Keyword));
  const triggerKeys = ['effects', 'onPlay', 'onDeath', 'onTurnStart', 'onTurnEnd', 'onDamageTaken',
    'onCreatureDies', 'onSpellCast', 'onEnemyTurnStart'];
  const allOps = new Set<string>();
  const ids = new Set<string>();
  const auraOps = new Set<string>();
  const visit = (eff: any): void => {
    if (!eff || typeof eff !== 'object') return;
    if (typeof eff.op === 'string') allOps.add(eff.op);
    if (eff.then) visit(eff.then);
  };
  let schemaProblems = 0;
  for (const raw of cardsFile.cards as any[]) {
    if (!raw.id || ids.has(raw.id) || !raw.name || !Object.values(CardType).includes(raw.type)
      || !targetValues.has(raw.target) || !Array.isArray(raw.keywords) || !Array.isArray(raw.effects)
      || !Number.isInteger(raw.cost) || raw.cost < 0 || raw.cost > 10
      || (raw.type === CardType.Creature && (!Number.isFinite(raw.attack) || !Number.isFinite(raw.health)))) schemaProblems++;
    if (raw.id) ids.add(raw.id);
    for (const kw of raw.keywords ?? []) if (!keywordValues.has(kw)) schemaProblems++;
    if (raw.aura?.op) auraOps.add(raw.aura.op);
    for (const key of triggerKeys) for (const eff of raw[key] ?? []) visit(eff);
  }
  const untyped = [...allOps].filter(op => !declaredOps.has(op));
  const unhandled = [...allOps].filter(op => !implementedOps.has(op));
  const declaredButUnhandled = [...declaredOps].filter(op => !implementedOps.has(op));
  const auraHandled = new Set([
    ...Array.from(engineText.matchAll(/case\s+'([^']+)'/g), m => m[1]),
    ...Array.from(engineText.matchAll(/aura\.op\s*===\s*'([^']+)'/g), m => m[1]),
    ...Array.from(engineText.matchAll(/aura\?\.op\s*===\s*'([^']+)'/g), m => m[1]),
  ]);
  const unhandledAuras = [...auraOps].filter(op => !auraHandled.has(op));
  const brokenDeathrattles = ALL.filter(c => (c.keywords ?? []).includes(Keyword.Deathrattle) && !(c.onDeath?.length));
  const brokenBattlecries = ALL.filter(c => (c.keywords ?? []).includes(Keyword.Battlecry)
    && c.type === CardType.Creature && !(c.effects ?? []).length);
  const creatureOnlyKeywords = new Set([
    Keyword.Taunt, Keyword.Lifesteal, Keyword.Deathrattle, Keyword.Battlecry, Keyword.Rush,
    Keyword.Windfury, Keyword.Unblockable, Keyword.Trample, Keyword.DivineShield,
    Keyword.Poisonous, Keyword.Freezing, Keyword.Vigilance,
  ]);
  const misplacedCreatureFields = ALL.filter(c => c.type !== CardType.Creature
    && (c.attack != null || c.health != null || (c.keywords ?? []).some(k => creatureOnlyKeywords.has(k))));
  check('все 500 записей Cards.json проходят проверку схемы/целей/ключевых слов',
    cardsFile.cards.length === 500 && schemaProblems === 0, `${cardsFile.cards.length} карт; ошибок ${schemaProblems}`);
  check('все эффекты карты и триггеры объявлены и имеют обработчик движка',
    untyped.length === 0 && unhandled.length === 0 && declaredButUnhandled.length === 0,
    `${allOps.size} ops в каталоге; untyped=${untyped.join(',') || 0}; без обработчика=${unhandled.join(',') || 0}`);
  check('ауры и keywords согласованы с правилами движка',
    unhandledAuras.length === 0 && brokenDeathrattles.length === 0
      && brokenBattlecries.length === 0 && misplacedCreatureFields.length === 0,
    `ауры без обработчика=${unhandledAuras.join(',') || 0}; Deathrattle без onDeath=${brokenDeathrattles.length}; Battlecry без эффектов=${brokenBattlecries.length}; поля существ на не-существе=${misplacedCreatureFields.map(c => c.id).join(',') || 0}`);

  const plain = find(c => c.type === CardType.Creature && !(c.keywords ?? []).length
    && !(c.effects ?? []).length && !(c.onDeath ?? []).length && !(c.onTurnStart ?? []).length
    && !(c.onTurnEnd ?? []).length && !(c.onDamageTaken ?? []).length && !(c.onCreatureDies ?? []).length
    && !(c.onSpellCast ?? []).length);
  let played = 0, illegal = 0, runtimeErrors = 0;
  const badCards: string[] = [];
  for (const card of ALL) {
    try {
      const fa = decks[card.faction] ? card.faction : Faction.Pyromancer;
      const fb = fa === Faction.Necrus ? Faction.Pyromancer : Faction.Necrus;
      const e = freshEngine(fa, fb);
      e.interactiveStack = false;
      e.summon(Side.Player, plain, { fromHand: false });
      e.summon(Side.Opponent, plain, { fromHand: false });
      e.p(Side.Player).mana = 10; e.p(Side.Player).maxMana = 10;
      const idx = e.p(Side.Player).hand.push(card.id) - 1;
      const target = e.validTargets(Side.Player, card)[0];
      const check0 = e.canPlay(Side.Player, idx);
      const ok = check0.ok && e.playCard(Side.Player, idx, target?.uid, target?.side as Side | undefined);
      if (ok) { played++; e.checkDeaths(); }
      else {
        illegal++;
        if (badCards.length < 10) badCards.push(`${card.id}: ${check0.reason ?? 'розыгрыш отклонён'}`);
      }
    } catch (err) {
      runtimeErrors++;
      if (badCards.length < 10) badCards.push(`${card.id}: ${String(err)}`);
    }
  }
  check('каждая карта проходит хотя бы один легальный розыгрыш со стандартной целью',
    played === ALL.length && illegal === 0 && runtimeErrors === 0,
    `${played}/${ALL.length}; отказов ${illegal}, исключений ${runtimeErrors}${badCards.length ? ' | ' + badCards.join(' ; ') : ''}`);

  const deathCards = ALL.filter(c => c.type === CardType.Creature && (c.onDeath?.length ?? 0) > 0);
  let deathErrors = 0;
  for (const card of deathCards) {
    try {
      const e = freshEngine();
      e.summon(Side.Player, plain, { fromHand: false });
      e.summon(Side.Opponent, plain, { fromHand: false });
      const unit = e.summon(Side.Player, card, { fromHand: false });
      if (unit) { unit.health = 0; e.checkDeaths(); }
    } catch { deathErrors++; }
  }
  check('каждый onDeath/Deathrattle-эффект исполняется в сценарии смерти',
    deathErrors === 0, `${deathCards.length} карт; исключений ${deathErrors}`);

  const startCards = ALL.filter(c => ((c as any).onTurnStart?.length ?? 0) > 0);
  let startErrors = 0;
  for (const card of startCards) {
    try {
      const e = freshEngine();
      e.summon(Side.Player, plain, { fromHand: false });
      e.summon(Side.Opponent, plain, { fromHand: false });
      if (card.type === CardType.Creature) e.summon(Side.Player, card, { fromHand: false });
      else if (card.type === CardType.Rune) e.playRune(Side.Player, card);
      else throw new Error(`неподдерживаемый тип триггера: ${card.type}`);
      e.runTurn();
    } catch { startErrors++; }
  }
  check('каждый onTurnStart-триггер исполняется на начале хода',
    startErrors === 0, `${startCards.length} карт; исключений ${startErrors}`);

  const damageCards = ALL.filter(c => (c.onDamageTaken?.length ?? 0) > 0);
  let damageTriggerErrors = 0;
  for (const card of damageCards) {
    try {
      const e = freshEngine();
      const unit = e.summon(Side.Player, card, { fromHand: false });
      if (unit) e.damageCreature(unit, 1, { pierceShield: true, source: 'аудит onDamageTaken' });
    } catch { damageTriggerErrors++; }
  }
  check('каждый onDamageTaken-триггер исполняется при получении урона',
    damageTriggerErrors === 0, `${damageCards.length} карт; исключений ${damageTriggerErrors}`);

  const spellCards = ALL.filter(c => (c.onSpellCast?.length ?? 0) > 0);
  const buffSpell = find(c => c.type === CardType.Spell && c.target === TargetKind.FriendlyCreature
    && (c.effects ?? []).some(x => x.op === 'buffAttack' || x.op === 'buffHealth'));
  let spellTriggerErrors = 0;
  for (const card of spellCards) {
    try {
      const e = freshEngine();
      const target = e.summon(Side.Player, plain, { fromHand: false })!;
      e.summon(Side.Opponent, plain, { fromHand: false });
      e.summon(Side.Player, card, { fromHand: false });
      e.castInstantSpell(Side.Player, buffSpell, target.uid, Side.Player);
    } catch { spellTriggerErrors++; }
  }
  check('каждый onSpellCast-триггер исполняется при розыгрыше заклинания',
    spellTriggerErrors === 0, `${spellCards.length} карт; исключений ${spellTriggerErrors}`);
}

console.log('\n[4] Инварианты случайных партий (40 матчей AI vs AI)');
{
  let crashes = 0, bad = 0;
  const facs = Object.values(Faction).filter(f => decks[f as string]);
  for (let i = 0; i < 40; i++) {
    const a = facs[i % facs.length], b = facs[(i * 3 + 1) % facs.length];
    try {
      const r = new MatchRunner(db, [decks[a], decks[b]], [a, b], { seed: 77000 + i * 17 });
      r.setupAI();
      const res = r.run({});
      for (const sd of [Side.Player, Side.Opponent]) {
        const pl = r.engine.p(sd);
        const over = r.engine.result !== GameResult.Ongoing;
        const isLoser = over && pl.health <= 0;   // v3.14: оверкил виден, игра окончена
        if (pl.health > 30) bad++;
        if (!isLoser && pl.health < 1) bad++;
        if (pl.creatures.length > 7) bad++;
        if (pl.hand.length > 12) bad++;
      }
      void res;
    } catch { crashes++; }
  }
  check('40 матчей без падений движка', crashes === 0, `падений: ${crashes}`);
  check('инварианты (HP 1..30 в игре, проигравший ≤0 после, ≤7 существ, ≤12 карт)', bad === 0, `нарушений: ${bad}`);
}

console.log(`\n=== ИТОГ АУДИТА: ${pass} PASS / ${fail} FAIL ===`);
process.exitCode = fail === 0 ? 0 : 1;
}

void main().catch(err => {
  console.error('Критическая ошибка аудита:', err);
  process.exitCode = 1;
});
