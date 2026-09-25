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
  CardData, CardType, Faction, GameEventType, Keyword, Phase, Side, StatusType, TargetKind,
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
{ // Прорыв: избыточный урон уходит в героя
  const e = freshEngine();
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
  check('оверкилл героя: жизни не опускаются ниже 0, бой завершён',
    e.p(Side.Player).health === 0 && dealt === 10 && e.result === GameResult.OpponentWin,
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

console.log('\n[3] Инварианты случайных партий (40 матчей AI vs AI)');
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
        if (pl.health < 0 || pl.health > 30) bad++;
        if (pl.creatures.length > 7) bad++;
        if (pl.hand.length > 12) bad++;
      }
      void res;
    } catch { crashes++; }
  }
  check('40 матчей без падений движка', crashes === 0, `падений: ${crashes}`);
  check('инварианты (HP 0..30, ≤7 существ, ≤12 карт в руке)', bad === 0, `нарушений: ${bad}`);
}

console.log(`\n=== ИТОГ АУДИТА: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
