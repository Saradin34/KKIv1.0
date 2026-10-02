/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — AI-противник (ТЗ раздел 5)
   ---------------------------------------------------------------------
   Гибрид:
     • эвристика приоритетов из ТЗ п.5.2 (добивание → выживание → доска →
       руны → заклинания → пас);
     • упрощённый minimax глубины 2 (ТЗ п.5.3) — оценка «ценности» каждой
       карты по формулам ТЗ + поправка на состояние доски;
     • фракционный стиль (ТЗ п.5.2, последние абзацы);
     • «неидеальность»: с вероятностью blunderRate AI берёт не лучшее,
       а второе по ценности действие (ТЗ п.5.1 — «допускает ошибки»).
   ===================================================================== */

import {
  CardData, CardType, Element, EntityCreature, Faction, Keyword, Phase, Rarity,
  Side, SpellSubtype, StatusType, TargetKind,
} from './types';
import { GameEngine, GameAction } from './engine';

export interface AIProfile {
  faction: Faction;
  /** 0 — «новичок», 1 — «идеальный». Влияет на долю случайных ошибок. */
  skill: number;
  /** Вероятность взять неоптимальное действие. */
  blunderRate: number;
  /** Насколько агрессивно идёт в лицо (0..1). */
  aggression: number;
  /** 1-ply перебор лучших действий клоном движка («Мифический»). */
  lookahead?: boolean;
  /** Насколько ценит сохранение своих существ (0..1). */
  selfPreservation: number;
}

export const AI_PROFILES: Record<Faction, AIProfile> = {
  // Ауриты: защита, контроль, исцеление
  [Faction.Aurites]:     { faction: Faction.Aurites,     skill: 0.8, blunderRate: 0.12, aggression: 0.35, selfPreservation: 0.85 },
  // Некрусы: агрессия, жертвы (пассивка даёт карту+2 HP за смерть)
  [Faction.Necrus]:      { faction: Faction.Necrus,      skill: 0.85, blunderRate: 0.10, aggression: 0.85, selfPreservation: 0.30 },
  // Терраморфы: копить ману, выставлять дорогих
  [Faction.Terramorph]:  { faction: Faction.Terramorph,  skill: 0.8, blunderRate: 0.12, aggression: 0.45, selfPreservation: 0.70 },
  // Пироманты: максимум прямого урона
  [Faction.Pyromancer]:  { faction: Faction.Pyromancer,  skill: 0.85, blunderRate: 0.10, aggression: 0.95, selfPreservation: 0.35 },
  // Эфирные: кража и контроль стола
  [Faction.Ethereal]:    { faction: Faction.Ethereal,    skill: 0.9, blunderRate: 0.08, aggression: 0.55, selfPreservation: 0.65 },
  [Faction.Neutral]:     { faction: Faction.Neutral,     skill: 0.75, blunderRate: 0.15, aggression: 0.5, selfPreservation: 0.5 },
};

export interface ScoredAction {
  action: GameAction;
  score: number;
  label: string;
}

/* ---------------------------------------------------------------------- */

export class AIController {
  constructor(public engine: GameEngine, public side: Side, public profile: AIProfile) {}

  /** Полный ход AI: основная фаза (розыгрыш карт + Эхо), затем «Завершить ход». */
  takeTurn(): GameAction[] {
    const actions: GameAction[] = [];
    const e = this.engine;
    if (e.phase !== Phase.Main || e.activeSide !== this.side) return [{ type: 'endTurn' }];

    let guard = 0;
    while (guard++ < 40) {
      const best = this.chooseBestAction();
      if (!best || best.score <= 0) break;
      // «неидеальность»: иногда берём второе по силе действие
      if (e.rng.chance(this.profile.blunderRate * (1 - this.profile.skill))) {
        const alt = this.chooseSecondBest();
        if (alt && alt.score > 0) { actions.push(alt.action); e.playAIFallback(alt.action, this.side); continue; }
      }
      actions.push(best.action);
      if (!e.playAIFallback(best.action, this.side)) break;
      if (e.result !== 'Ongoing') break;
    }
    actions.push({ type: 'endTurn' });
    return actions;
  }

  /** Оценка состояния доски «с точки зрения» AI (упрощённый minimax, глубина 2). */
  private boardScore(): number {
    const e = this.engine;
    const me = e.p(this.side);
    const en = e.p(this.side === Side.Player ? Side.Opponent : Side.Player);
    let s = 0;

    // Герои
    s += (en.health <= 0 ? 1000 : 0) - (me.health <= 0 ? 1000 : 0);
    s += (30 - en.health) * (1 + this.profile.aggression);
    s += (me.health - 30) * this.profile.selfPreservation * 0.6;

    // Доска
    s += this.creaturesValue(me.creatures) * 1.0;
    s -= this.creaturesValue(en.creatures) * 1.1;

    // Темп/ресурсы
    s += (me.hand.length - en.hand.length) * 0.8;
    s += (me.deck.length <= 0 ? -6 : 0);
    s += me.echoPoints * 1.2;
    s += me.mana * 0.15;

    // Руны: постоянный бонус
    s += me.runes.length * 2.0;
    s -= en.runes.length * 2.0;

    return s;
  }

  private creaturesValue(list: EntityCreature[]): number {
    let v = 0;
    for (const c of list) {
      v += c.attack * 1.5 + c.health;
      if (c.keywords.includes(Keyword.Taunt)) v += 1.0;
      if (c.keywords.includes(Keyword.Vigilance)) v += 0.7;
      if (c.keywords.includes(Keyword.Lifesteal)) v += 1.2;
      if (c.keywords.includes(Keyword.Unblockable)) v += 1.5;
      if (c.keywords.includes(Keyword.Windfury)) v += c.attack * 0.8;
      if (c.statuses.some(s => s.type === StatusType.Shield)) v += 1.0;
      if (c.statuses.some(s => s.type === StatusType.Poison)) v += 2.0;
      if (c.frozen) v -= 1.5;
      if (c.silenced) v -= 1.0;
    }
    return v;
  }

  /** Ценность карты по формулам ТЗ п.5.3 + контекстные поправки. */
  private cardValue(card: CardData, target?: EntityCreature): number {
    const e = this.engine;
    const en = e.p(this.side === Side.Player ? Side.Opponent : Side.Player);
    const me = e.p(this.side);
    const cost = Math.max(1, card.cost);

    if (card.type === CardType.Creature) {
      // ТЗ: (Attack * 1.5 + Health) / Cost
      let v = ((card.attack ?? 0) * 1.5 + (card.health ?? 0)) / cost;
      v *= 3.0; // приведение к единой шкале
      for (const kw of card.keywords) {
        if (kw === Keyword.Taunt) v += this.profile.selfPreservation * 1.5;
        if (kw === Keyword.Vigilance) v += this.profile.selfPreservation * 0.65;
        if (kw === Keyword.Rush) v += this.profile.aggression * 1.8;
        if (kw === Keyword.Lifesteal) v += me.health < 15 ? 2.2 : 0.9;
        if (kw === Keyword.Unblockable) v += this.profile.aggression * 1.6;
        if (kw === Keyword.Windfury) v += 1.4;
        if (kw === Keyword.Trample) v += 0.8;
        if (kw === Keyword.SpellDamage) v += me.hand.some(h => e.db.get(h)?.type === CardType.Spell) ? 1.6 : 0.3;
        if (kw === Keyword.Deathrattle) v += card.faction === Faction.Necrus ? 1.8 : 0.8;
      }
      if (card.effects?.length) v += 0.9;
      if (card.onDeath?.length) v += card.faction === Faction.Necrus ? 1.4 : 0.7;
      if (card.onTurnStart?.length) v += 1.1;
      // рампа Терраморфов дороже в ранней игре
      if (card.faction === Faction.Terramorph && cost >= 5) v += e.turn < 8 ? 1.0 : 0.4;
      if (rarityBonus(card)) v += 0.4;
      return v;
    }

    if (card.type === CardType.Spell) {
      // ТЗ: EffectValue / Cost
      let effect = this.estimateSpellEffect(card, target);
      let v = effect / cost;
      if (card.subtype === SpellSubtype.Ritual) v *= 0.85; // задержка в 1 ход
      return v * 3.0;
    }

    // ТЗ: руна = 2.0 (постоянный бонус)
    let v = 2.0;
    const aura = (card as any).aura;
    if (aura) {
      if (aura.op === 'extraMana') v += 1.6;
      if (aura.op === 'extraCard') v += 1.5;
      if (aura.op === 'buffAttack' || aura.op === 'buffAttackHealth') v += me.creatures.length * 0.5;
      if (aura.op === 'debuffAttackEnemy') v += en.creatures.length * 0.5;
      if (aura.op === 'spellDamage') v += card.faction === Faction.Pyromancer ? 1.6 : 0.9;
      if (aura.op === 'heroProtection') v += me.health < 20 ? 1.4 : 0.6;
    }
    if ((card as any).onTurnStart?.length) v += 1.2;
    v -= cost * 0.12;
    // не ставить больше 2 рун, пока доска пуста (стиль фракций)
    if (me.runes.length >= 2 && me.creatures.length === 0) v -= 1.2;
    return v;
  }

  /** Оценка полезности заклинания в текущей позиции. */
  private estimateSpellEffect(card: CardData, target?: EntityCreature): number {
    const e = this.engine;
    const me = e.p(this.side);
    const en = e.p(this.side === Side.Player ? Side.Opponent : Side.Player);
    const sd = e.spellDamageOf(this.side, card.element);
    let v = 0;

    for (const eff of card.effects ?? []) {
      const val = eff.value ?? 1;
      switch (eff.op) {
        case 'damage': {
          const amt = val + (sd || 0);
          if (target) v += Math.min(amt, target.health) * 1.4 + (amt >= target.health ? 1.6 : 0);
          else if (eff.to === TargetKind.EnemyHero) {
            v += amt * (en.health <= amt ? 12 : (en.health <= 10 ? 1.8 : 1.1)) * (0.6 + this.profile.aggression);
          } else v += amt * 1.2;
          break;
        }
        case 'damageAllEnemyCreatures': v += Math.min(en.creatures.length, 4) * val * 1.5; break;
        case 'damageAllCreatures': v += (Math.min(en.creatures.length, 4) * val * 1.4) - (me.creatures.length * val * 1.1 * this.profile.selfPreservation); break;
        case 'heal': v += me.health < 20 ? Math.min(val, 20 - me.health) * 1.3 * this.profile.selfPreservation : val * 0.4; break;
        case 'draw': v += val * 1.7; break;
        case 'opponentDraw': v -= val * 1.4; break;
        case 'destroyCreature': {
          const best = [...en.creatures].sort((a, b) => (b.attack * 1.5 + b.health) - (a.attack * 1.5 + a.health))[0];
          v += best ? (best.attack * 1.5 + best.health) * 0.85 : 0;
          break;
        }
        case 'buffAttack': case 'buffHealth': v += val * (me.creatures.length > 0 ? 1.0 : 0.25); break;
        case 'debuffAttack': v += val * Math.min(en.creatures.length, 3) * 0.8; break;
        case 'applyStatus': {
          const st = eff.status;
          if (st === StatusType.Poison) v += target ? 3.0 : 1.6;
          if (st === StatusType.Burn) v += (eff.statusValue ?? 1) * Math.min(3, eff.value ?? 2) * (en.creatures.length > 1 ? 1.3 : 0.8);
          if (st === StatusType.Freeze) v += en.creatures.length * 1.2;
          if (st === StatusType.Shield) v += me.creatures.length * 0.9 * this.profile.selfPreservation;
          break;
        }
        case 'freezeAllEnemies': v += en.creatures.length * 1.6; break;
        case 'burnAllEnemies': v += en.creatures.length * (eff.statusValue ?? 1) * Math.min(3, eff.value ?? 2) * 0.9; break;
        case 'shieldAllFriendlies': v += me.creatures.length * 1.0 * this.profile.selfPreservation; break;
        case 'silence': v += target ? 1.6 : 0.9; break;
        case 'returnToHand': v += target ? (target.attack + target.health) * 0.45 : en.creatures.length * 1.1; break;
        case 'stealCard': v += val * 1.8 * (en.hand.length > 0 ? 1 : 0.1); break;
        case 'stealCreature': {
          const best = [...en.creatures].sort((a, b) => (b.attack * 1.5 + b.health) - (a.attack * 1.5 + a.health))[0];
          v += best ? (best.attack * 1.5 + best.health) * 0.9 : 0;
          break;
        }
        case 'gainMana': v += val * (e.turn <= 6 ? 1.5 : 0.5); break;
        case 'gainMaxMana': v += val * 2.2; break;
        case 'gainEcho': v += 1.4; break;
        case 'summonToken': {
          const t = (eff as any).token as CardData | undefined;
          v += t ? (t.attack ?? 0) * 1.2 + (t.health ?? 0) * 0.8 : 1.0;
          break;
        }
        case 'sacrifice': v -= me.creatures.length > 0 ? 1.2 : 3.0; break;
        case 'reduceIncomingDamage': v += val * (me.health < 20 ? 1.4 : 0.6); break;
        default: v += 0.5;
      }
    }
    // Пироманты: штраф за самоурон учтён в пассивке движка; AI это знает
    if (card.faction === Faction.Pyromancer && me.health <= 5) v -= 2.0;
    return Math.max(0, v);
  }

  /** Перебор всех легальных действий основной фазы + оценка (minimax depth 2 = 1 ход вперёд). */
  /** Статическая оценка позиции для lookahead: доска + герои + рука. */
  private static staticEval(e: GameEngine, side: Side): number {
    const me = e.p(side), op = e.p(side === Side.Player ? Side.Opponent : Side.Player);
    let v = (me.health - op.health) * 1.4 + (me.hand.length - op.hand.length) * 0.5 + me.mana * 0.2;
    for (const u of me.creatures) v += u.attack + u.health * 0.9;
    for (const u of op.creatures) v -= u.attack + u.health * 0.9;
    return v;
  }

  chooseBestAction(): ScoredAction | null {
    const list = this.enumerateActions();
    if (list.length === 0) return null;
    list.sort((a, b) => b.score - a.score);
    // «Мифический»: топ-5 кандидатов прогоняются клоном движка на 1 ply
    if (this.profile.lookahead && list.length > 1) {
      const top = list.slice(0, 5);
      const base = AIController.staticEval(this.engine, this.side);
      for (const sc of top) {
        try {
          const clone = new GameEngine(this.engine.db, [[], []], { seed: 7 });
          clone.players = JSON.parse(JSON.stringify(this.engine.players)) as typeof clone.players;
          clone.turn = this.engine.turn;
          clone.phase = this.engine.phase;
          clone.result = this.engine.result;
          clone.activeSide = this.engine.activeSide;
          if (clone.playAIFallback(sc.action, this.side)) {
            sc.score += (AIController.staticEval(clone, this.side) - base) * 0.6;
          }
        } catch { void 0; }
      }
      top.sort((a, b) => b.score - a.score);
      return top[0];
    }
    return list[0];
  }

  chooseSecondBest(): ScoredAction | null {
    const list = this.enumerateActions();
    if (list.length < 2) return null;
    list.sort((a, b) => b.score - a.score);
    return list[1];
  }

  enumerateActions(): ScoredAction[] {
    const e = this.engine;
    const me = e.p(this.side);
    const en = e.p(this.side === Side.Player ? Side.Opponent : Side.Player);
    const out: ScoredAction[] = [];

    // --- приоритет 1 из ТЗ: добивание героя (здоровье противника <= 5) ---
    const lethalMode = en.health <= 5;
    // --- приоритет 2 из ТЗ: своё здоровье <= 10 ---
    const dangerMode = me.health <= 10;

    me.hand.forEach((cardId, idx) => {
      const card = e.db.get(cardId);
      if (!card) return;
      const chk = e.canPlay(this.side, idx);
      if (!chk.ok) return;

      const targets = card.target === TargetKind.None ? [undefined] : e.validTargets(this.side, card);
      for (const t of targets.slice(0, 8)) {
        const targetCreature = t?.uid !== undefined ? e.findCreature(t.uid) : undefined;
        let score = this.cardValue(card, targetCreature);

        // Контекстные приоритеты ТЗ п.5.2
        if (lethalMode) {
          const burst = this.burnPotential(card, targetCreature);
          if (burst >= en.health) score += 50;               // летальный удар
          else if (card.type === CardType.Creature && (card.attack ?? 0) >= 4) score += 6;
          else if (card.type === CardType.Spell) score += burst * 2.0;
        }
        if (dangerMode) {
          if (this.isDefensive(card)) score += 8;
          if (card.type === CardType.Creature && card.keywords.includes(Keyword.Taunt)) score += 6;
          if (card.type === CardType.Creature && card.keywords.includes(Keyword.Lifesteal)) score += 5;
        }

        // Фракционный стиль (ТЗ п.5.2)
        score += this.factionBias(card);

        // Экономия маны: не выкидывать всё в первый же ход у Терраморфов
        if (me.faction === Faction.Terramorph && e.turnsTaken[this.side] <= 3 && card.cost >= 4) score += 2.0;

        // Не играть карту, если она «в минус» по позиции
        if (score <= 0.2) continue;
        out.push({
          action: { type: 'playCard', handIndex: idx, targetUid: t?.uid, targetSide: t?.side as Side },
          score,
          label: `${card.name} (${card.cost}м) → ${t?.label ?? 'без цели'}`,
        });
      }
    });

    // --- Эхо (ТЗ п.2.6) ---
    const echo = e.canUseEcho(this.side);
    if (echo.ok && echo.card) {
      let score = this.estimateSpellEffect(echo.card) * 1.1;
      if (lethalMode) score += this.burnPotential(echo.card) >= en.health ? 60 : 6;
      if (dangerMode && this.isDefensive(echo.card)) score += 8;
      // Эхо тратится один раз за игру — приберегаем, если выгода мала
      if (score < 4.0) score *= 0.35;
      if (score > 0.5) out.push({ action: { type: 'useEcho' }, score, label: `ЭХО → ${echo.card.name}` });
    }

    // «Завершить ход» как действие с нулевой ценностью
    out.push({ action: { type: 'endTurn' }, score: 0.05, label: 'Завершить ход' });
    return out;
  }

  private burnPotential(card: CardData, target?: EntityCreature): number {
    const e = this.engine;
    const sd = card.type === CardType.Spell ? e.spellDamageOf(this.side, card.element) : 0;
    let dmg = 0;
    for (const eff of card.effects ?? []) {
      if (eff.op === 'damage' && (eff.to === TargetKind.EnemyHero || eff.to === undefined)) dmg += ((eff.value ?? 0) + sd) * (eff.repeat ?? 1);
      if (eff.op === 'damageAllEnemyCreatures') dmg += 0; // не в героя
    }
    if (card.type === CardType.Creature) dmg += (card.attack ?? 0) * (card.keywords.includes(Keyword.Rush) ? 1 : 0);
    return dmg;
  }

  private isDefensive(card: CardData): boolean {
    const has = (op: string) => (card.effects ?? []).some(e => e.op === op);
    if (has('heal') || has('shieldAllFriendlies') || has('reduceIncomingDamage')) return true;
    if (has('freezeAllEnemies') || has('returnToHand') || has('destroyCreature')) return true;
    if (card.keywords.includes(Keyword.Taunt)) return true;
    if (card.type === CardType.Rune) {
      const aura = (card as any).aura;
      if (aura && ['heroProtection', 'buffHealth', 'debuffAttackEnemy'].includes(aura.op)) return true;
    }
    return false;
  }

  private factionBias(card: CardData): number {
    const f = this.profile.faction;
    let b = 0;
    switch (f) {
      case Faction.Necrus:
        // агрессивно жертвует существами ради «Кровавой жатвы»
        if ((card.effects ?? []).some(e => e.op === 'sacrifice')) b += 3.0;
        if (card.keywords.includes(Keyword.Deathrattle)) b += 1.6;
        if (card.keywords.includes(Keyword.Lifesteal)) b += 1.2;
        if ((card.effects ?? []).some(e => e.op === 'stealCard')) b += 1.0;
        break;
      case Faction.Aurites:
        if ((card.effects ?? []).some(e => e.op === 'heal')) b += 1.6;
        if (card.keywords.includes(Keyword.Taunt)) b += 1.4;
        if (card.type === CardType.Rune && (card as any).aura?.op === 'heroProtection') b += 1.8;
        if ((card.effects ?? []).some(e => e.op === 'silence')) b += 1.0;
        break;
      case Faction.Terramorph:
        if ((card.effects ?? []).some(e => e.op === 'gainMaxMana' || e.op === 'gainMana')) b += 2.2;
        if (card.type === CardType.Rune && (card as any).aura?.op === 'extraMana') b += 2.0;
        if (card.type === CardType.Creature && card.cost >= 5) b += 1.4;
        break;
      case Faction.Pyromancer:
        if ((card.effects ?? []).some(e => e.op === 'damage' && e.to === TargetKind.EnemyHero)) b += 2.2;
        if (card.type === CardType.Rune && (card as any).aura?.op === 'spellDamage') b += 2.0;
        if (card.keywords.includes(Keyword.SpellDamage)) b += 1.4;
        if (card.keywords.includes(Keyword.Rush)) b += 1.0;
        break;
      case Faction.Ethereal:
        if ((card.effects ?? []).some(e => e.op === 'stealCard')) b += 2.0;
        if ((card.effects ?? []).some(e => e.op === 'stealCreature')) b += 2.2;
        if ((card.effects ?? []).some(e => e.op === 'returnToHand')) b += 1.6;
        if (card.keywords.includes(Keyword.Unblockable)) b += 1.2;
        break;
      default: break;
    }
    return b;
  }
}

function rarityBonus(card: CardData): boolean {
  return card.rarity === Rarity.Legendary || card.rarity === Rarity.Epic;
}
