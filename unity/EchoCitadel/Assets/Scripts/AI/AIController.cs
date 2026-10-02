/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   ИИ-противник (ТЗ раздел 5).
   ---------------------------------------------------------------------
   Порт src/engine/ai.ts. Гибрид:
     • эвристика приоритетов из ТЗ п.5.2 (добивание → выживание → доска →
       руны → заклинания → пас);
     • упрощённый minimax глубины 2 (ТЗ п.5.3): оценка «ценности» каждой
       карты по формулам ТЗ + поправка на состояние доски;
     • фракционный стиль (последние абзацы ТЗ п.5.2);
     • «неидеальность»: с вероятностью blunderRate ИИ берёт не лучшее,
       а второе по ценности действие (ТЗ п.5.1 — «допускает ошибки»).

   Порядок обращений к ГПСЧ (chance на «промах», shuffle в фильтрах) обязан
   совпадать с TS: от него зависит воспроизводимость матчей и винрейты.
   Все сортировки — устойчивые (LINQ), как Array.prototype.sort в JS.
   ===================================================================== */

using System;
using System.Collections.Generic;
using System.Linq;

namespace EchoCitadel.AI
{
    using EchoCitadel.Core;
    using EchoCitadel.Data;

    public sealed class AIController
    {
        public readonly GameEngine Engine;
        public readonly Side Side;
        public readonly AIProfile Profile;

        public AIController(GameEngine engine, Side side, AIProfile profile)
        {
            Engine = engine;
            Side = side;
            Profile = profile;
        }

        private PlayerState Me => Engine.P(Side);
        private PlayerState En => Engine.P(Side.Other());

        /* ----------------------------- ПОЛНЫЙ ХОД ------------------------------- */

        /// <summary>
        /// Полный ход ИИ: основная фаза (розыгрыш карт + Эхо), затем «Завершить ход».
        /// Возвращает список выполненных действий — его читают лог и отладка.
        /// </summary>
        public List<GameAction> TakeTurn()
        {
            var actions = new List<GameAction>();
            var e = Engine;

            if (e.Phase != Phase.Main || e.ActiveSide != Side)
            {
                actions.Add(GameAction.EndTurn());
                return actions;
            }

            int guard = 0;
            while (guard++ < 40)
            {
                var best = ChooseBestAction();
                if (best == null || best.Score <= 0) break;

                // «неидеальность»: иногда берём второе по силе действие
                if (e.Rng.Chance(Profile.BlunderRate * (1 - Profile.Skill)))
                {
                    var alt = ChooseSecondBest();
                    if (alt != null && alt.Score > 0)
                    {
                        actions.Add(alt.Action);
                        e.ApplyAction(alt.Action, Side);
                        continue;
                    }
                }

                actions.Add(best.Action);
                if (!e.ApplyAction(best.Action, Side)) break;
                if (e.Result != GameResult.Ongoing) break;
            }

            actions.Add(GameAction.EndTurn());
            return actions;
        }

        /* ----------------------------- ОЦЕНКА ДОСКИ ------------------------------ */

        /// <summary>
        /// Оценка состояния доски «с точки зрения» ИИ
        /// (упрощённый minimax, глубина 2 = один ход вперёд).
        /// В TS метод определён, но в переборе действий не вызывается — решения
        /// принимаются по ценности карт; оценка доски оставлена для диагностики
        /// и отладки (печать позиции в логах автотестера).
        /// </summary>
        public double BoardScore()
        {
            var e = Engine;
            var me = Me;
            var en = En;
            double s = 0;

            // герои
            s += (en.Health <= 0 ? 1000 : 0) - (me.Health <= 0 ? 1000 : 0);
            s += (30 - en.Health) * (1 + Profile.Aggression);
            s += (me.Health - 30) * Profile.SelfPreservation * 0.6;

            // доска
            s += CreaturesValue(me.Creatures) * 1.0;
            s -= CreaturesValue(en.Creatures) * 1.1;

            // темп и ресурсы
            s += (me.Hand.Count - en.Hand.Count) * 0.8;
            s += me.Deck.Count <= 0 ? -6 : 0;
            s += me.EchoPoints * 1.2;
            s += me.Mana * 0.15;

            // руны: постоянный бонус
            s += me.Runes.Count * 2.0;
            s -= en.Runes.Count * 2.0;

            return s;
        }

        private double CreaturesValue(List<EntityCreature> list)
        {
            double v = 0;
            foreach (var c in list)
            {
                v += c.Attack * 1.5 + c.Health;
                if (c.Keywords.Contains(Keyword.Taunt)) v += 1.0;
                if (c.Keywords.Contains(Keyword.Vigilance)) v += 0.7;
                if (c.Keywords.Contains(Keyword.Lifesteal)) v += 1.2;
                if (c.Keywords.Contains(Keyword.Unblockable)) v += 1.5;
                if (c.Keywords.Contains(Keyword.Windfury)) v += c.Attack * 0.8;
                if (c.Statuses.Any(s => s.Type == StatusType.Shield)) v += 1.0;
                if (c.Statuses.Any(s => s.Type == StatusType.Poison)) v += 2.0;
                if (c.Frozen) v -= 1.5;
                if (c.Silenced) v -= 1.0;
            }
            return v;
        }

        /* ----------------------------- ЦЕННОСТЬ КАРТЫ ---------------------------- */

        /// <summary>Ценность карты по формулам ТЗ п.5.3 + контекстные поправки.</summary>
        private double CardValue(CardData card, EntityCreature? target = null)
        {
            var e = Engine;
            var en = En;
            var me = Me;
            int cost = Math.Max(1, card.Cost);

            if (card.Type == CardType.Creature)
            {
                // ТЗ: (Attack × 1.5 + Health) / Cost
                double v = ((card.Attack ?? 0) * 1.5 + (card.Health ?? 0)) / cost;
                v *= 3.0;   // приведение к единой шкале

                foreach (var kw in card.Keywords)
                {
                    switch (kw)
                    {
                        case Keyword.Taunt: v += Profile.SelfPreservation * 1.5; break;
                        case Keyword.Vigilance: v += Profile.SelfPreservation * 0.65; break;
                        case Keyword.Rush: v += Profile.Aggression * 1.8; break;
                        case Keyword.Lifesteal: v += me.Health < 15 ? 2.2 : 0.9; break;
                        case Keyword.Unblockable: v += Profile.Aggression * 1.6; break;
                        case Keyword.Windfury: v += 1.4; break;
                        case Keyword.Trample: v += 0.8; break;
                        case Keyword.SpellDamage:
                            v += me.Hand.Any(h => e.Db.Get(h)?.Type == CardType.Spell) ? 1.6 : 0.3;
                            break;
                        case Keyword.Deathrattle: v += card.Faction == Faction.Necrus ? 1.8 : 0.8; break;
                    }
                }

                if (card.Effects.Count > 0) v += 0.9;
                if (card.OnDeath is { Count: > 0 }) v += card.Faction == Faction.Necrus ? 1.4 : 0.7;
                if (card.OnTurnStart is { Count: > 0 }) v += 1.1;

                // рампа Терраморфов дороже в ранней игре
                if (card.Faction == Faction.Terramorph && cost >= 5) v += e.Turn < 8 ? 1.0 : 0.4;
                if (RarityBonus(card)) v += 0.4;
                return v;
            }

            if (card.Type == CardType.Spell)
            {
                // ТЗ: EffectValue / Cost
                double effect = EstimateSpellEffect(card, target);
                double v = effect / cost;
                if (card.Subtype == SpellSubtype.Ritual) v *= 0.85;   // задержка в один ход
                return v * 3.0;
            }

            // ТЗ: руна = 2.0 (постоянный бонус)
            double rv = 2.0;
            var aura = card.Aura;
            if (aura != null)
            {
                switch (aura.Op)
                {
                    case AuraOp.extraMana: rv += 1.6; break;
                    case AuraOp.extraCard: rv += 1.5; break;
                    case AuraOp.buffAttack:
                    case AuraOp.buffAttackHealth: rv += me.Creatures.Count * 0.5; break;
                    case AuraOp.debuffAttackEnemy: rv += en.Creatures.Count * 0.5; break;
                    case AuraOp.spellDamage: rv += card.Faction == Faction.Pyromancer ? 1.6 : 0.9; break;
                    case AuraOp.heroProtection: rv += me.Health < 20 ? 1.4 : 0.6; break;
                }
            }
            if (card.OnTurnStart is { Count: > 0 }) rv += 1.2;
            rv -= cost * 0.12;

            // не ставить больше двух рун, пока доска пуста (стиль фракций)
            if (me.Runes.Count >= 2 && me.Creatures.Count == 0) rv -= 1.2;
            return rv;
        }

        private static bool RarityBonus(CardData card) =>
            card.Rarity == Rarity.Legendary || card.Rarity == Rarity.Epic;

        /// <summary>Оценка полезности заклинания в текущей позиции.</summary>
        private double EstimateSpellEffect(CardData card, EntityCreature? target = null)
        {
            var e = Engine;
            var me = Me;
            var en = En;
            // TS вызывает spellDamageOf(side, element) БЕЗ цены заклинания, поэтому
            // бонус Пиромантов здесь считается по стоимости 1. Повторяем дословно:
            // иначе оценки ИИ (и винрейты автотестера) разъедутся с TypeScript.
            int sd = e.SpellDamageOf(Side, card.Element, spellCost: null);
            double v = 0;

            foreach (var eff in card.Effects)
            {
                int val = eff.Value ?? 1;
                switch (eff.Op)
                {
                    case EffectOp.damage:
                    {
                        int amt = val + sd;
                        if (target != null)
                            v += Math.Min(amt, target.Health) * 1.4 + (amt >= target.Health ? 1.6 : 0);
                        else if (eff.To == TargetKind.EnemyHero)
                            v += amt * (en.Health <= amt ? 12 : (en.Health <= 10 ? 1.8 : 1.1)) * (0.6 + Profile.Aggression);
                        else
                            v += amt * 1.2;
                        break;
                    }
                    case EffectOp.damageAllEnemyCreatures:
                        v += Math.Min(en.Creatures.Count, 4) * val * 1.5;
                        break;
                    case EffectOp.damageAllCreatures:
                        v += Math.Min(en.Creatures.Count, 4) * val * 1.4
                             - me.Creatures.Count * val * 1.1 * Profile.SelfPreservation;
                        break;
                    case EffectOp.heal:
                        v += me.Health < 20
                            ? Math.Min(val, 20 - me.Health) * 1.3 * Profile.SelfPreservation
                            : val * 0.4;
                        break;
                    case EffectOp.draw: v += val * 1.7; break;
                    case EffectOp.opponentDraw: v -= val * 1.4; break;
                    case EffectOp.destroyCreature:
                    {
                        var best = BestEnemyByValue();
                        if (best != null) v += (best.Attack * 1.5 + best.Health) * 0.85;
                        break;
                    }
                    case EffectOp.buffAttack:
                    case EffectOp.buffHealth:
                        v += val * (me.Creatures.Count > 0 ? 1.0 : 0.25);
                        break;
                    case EffectOp.debuffAttack:
                        v += val * Math.Min(en.Creatures.Count, 3) * 0.8;
                        break;
                    case EffectOp.applyStatus:
                    {
                        var st = eff.Status;
                        if (st == StatusType.Poison) v += target != null ? 3.0 : 1.6;
                        if (st == StatusType.Burn)
                            v += (eff.StatusValue ?? 1) * Math.Min(3, eff.Value ?? 2) * (en.Creatures.Count > 1 ? 1.3 : 0.8);
                        if (st == StatusType.Freeze) v += en.Creatures.Count * 1.2;
                        if (st == StatusType.Shield) v += me.Creatures.Count * 0.9 * Profile.SelfPreservation;
                        break;
                    }
                    case EffectOp.freezeAllEnemies: v += en.Creatures.Count * 1.6; break;
                    case EffectOp.burnAllEnemies:
                        v += en.Creatures.Count * (eff.StatusValue ?? 1) * Math.Min(3, eff.Value ?? 2) * 0.9;
                        break;
                    case EffectOp.shieldAllFriendlies: v += me.Creatures.Count * 1.0 * Profile.SelfPreservation; break;
                    case EffectOp.silence: v += target != null ? 1.6 : 0.9; break;
                    case EffectOp.returnToHand:
                        v += target != null ? (target.Attack + target.Health) * 0.45 : en.Creatures.Count * 1.1;
                        break;
                    case EffectOp.stealCard: v += val * 1.8 * (en.Hand.Count > 0 ? 1 : 0.1); break;
                    case EffectOp.stealCreature:
                    {
                        var best = BestEnemyByValue();
                        if (best != null) v += (best.Attack * 1.5 + best.Health) * 0.9;
                        break;
                    }
                    case EffectOp.gainMana: v += val * (e.Turn <= 6 ? 1.5 : 0.5); break;
                    case EffectOp.gainMaxMana: v += val * 2.2; break;
                    case EffectOp.gainEcho: v += 1.4; break;
                    case EffectOp.summonToken:
                        v += eff.Token != null ? (eff.Token.Attack ?? 0) * 1.2 + (eff.Token.Health ?? 0) * 0.8 : 1.0;
                        break;
                    case EffectOp.sacrifice: v -= me.Creatures.Count > 0 ? 1.2 : 3.0; break;
                    case EffectOp.reduceIncomingDamage: v += val * (me.Health < 20 ? 1.4 : 0.6); break;
                    default: v += 0.5; break;
                }
            }

            // Пироманты: штраф за самоурон учтён в пассивке движка; ИИ это знает
            if (card.Faction == Faction.Pyromancer && me.Health <= 5) v -= 2.0;
            return Math.Max(0, v);
        }

        /// <summary>Самое «дорогое» существо противника: Attack × 1.5 + Health.</summary>
        private EntityCreature? BestEnemyByValue() =>
            En.Creatures.OrderByDescending(c => c.Attack * 1.5 + c.Health).FirstOrDefault();

        /* ----------------------------- ВЫБОР ДЕЙСТВИЯ ---------------------------- */

        /// <summary>Статическая оценка позиции для lookahead: доска + герои + рука.</summary>
        private static double StaticEval(GameEngine e, Side side)
        {
            var me = e.P(side);
            var op = e.P(side.Other());
            double v = (me.Health - op.Health) * 1.4 + (me.Hand.Count - op.Hand.Count) * 0.5 + me.Mana * 0.2;
            foreach (var u in me.Creatures) v += u.Attack + u.Health * 0.9;
            foreach (var u in op.Creatures) v -= u.Attack + u.Health * 0.9;
            return v;
        }

        /// <summary>Перебор всех легальных действий + оценка (minimax глубина 2). «Мифический»: топ-5 клоном.</summary>
        public ScoredAction? ChooseBestAction()
        {
            var list = EnumerateActions();
            if (list.Count == 0) return null;
            list = list.OrderByDescending(a => a.Score).ToList();
            if (Profile.Lookahead && list.Count > 1)
            {
                var top = list.Take(5).ToList();
                double baseEval = StaticEval(Engine, Side);
                foreach (var sc in top)
                {
                    try
                    {
                        var clone = Engine.CloneForLookahead();
                        if (clone.ApplyAction(sc.Action, Side))
                            sc.Score += (StaticEval(clone, Side) - baseEval) * 0.6;
                    }
                    catch { /* как TS: глотаем сбой клона */ }
                }
                return top.OrderByDescending(a => a.Score).First();
            }
            return list[0];
        }

        public ScoredAction? ChooseSecondBest()
        {
            var list = EnumerateActions();
            if (list.Count < 2) return null;
            return list.OrderByDescending(a => a.Score).Skip(1).First();
        }

        public List<ScoredAction> EnumerateActions()
        {
            var e = Engine;
            var me = Me;
            var en = En;
            var outList = new List<ScoredAction>();

            // приоритет 1 из ТЗ п.5.2: добивание героя (здоровье противника ≤ 5)
            bool lethalMode = en.Health <= 5;
            // приоритет 2 из ТЗ п.5.2: своё здоровье ≤ 10
            bool dangerMode = me.Health <= 10;

            for (int idx = 0; idx < me.Hand.Count; idx++)
            {
                var card = e.Db.Get(me.Hand[idx]);
                if (card == null) continue;

                var chk = e.CanPlay(Side, idx);
                if (!chk.Ok) continue;

                // карты без цели дают один вариант «без цели»
                var targets = card.Target == TargetKind.None
                    ? new List<TargetOption> { new TargetOption() }
                    : e.ValidTargets(Side, card);

                foreach (var t in targets.Take(8))
                {
                    var targetCreature = t.Uid.HasValue ? e.FindCreature(t.Uid.Value) : null;
                    double score = CardValue(card, targetCreature);

                    // контекстные приоритеты ТЗ п.5.2
                    if (lethalMode)
                    {
                        double burst = BurnPotential(card, targetCreature);
                        if (burst >= en.Health) score += 50;                                   // летальный удар
                        else if (card.Type == CardType.Creature && (card.Attack ?? 0) >= 4) score += 6;
                        else if (card.Type == CardType.Spell) score += burst * 2.0;
                    }
                    if (dangerMode)
                    {
                        if (IsDefensive(card)) score += 8;
                        if (card.Type == CardType.Creature && card.Keywords.Contains(Keyword.Taunt)) score += 6;
                        if (card.Type == CardType.Creature && card.Keywords.Contains(Keyword.Lifesteal)) score += 5;
                    }

                    // фракционный стиль (ТЗ п.5.2)
                    score += FactionBias(card);

                    // экономия маны: не выкидывать всё в первый же ход у Терраморфов
                    if (me.Faction == Faction.Terramorph && e.TurnsTaken[(int)Side] <= 3 && card.Cost >= 4) score += 2.0;

                    // не играть карту, если она «в минус» по позиции
                    if (score <= 0.2) continue;

                    outList.Add(new ScoredAction
                    {
                        Action = GameAction.PlayCard(idx, t.Uid, t.Side),
                        Score = score,
                        Label = $"{card.Name} ({card.Cost}м) → {(t.Label.Length > 0 ? t.Label : "без цели")}",
                    });
                }
            }

            // Эхо (ТЗ п.2.6)
            var echo = e.CanUseEcho(Side);
            if (echo.Ok && echo.Card != null)
            {
                double score = EstimateSpellEffect(echo.Card) * 1.1;
                if (lethalMode) score += BurnPotential(echo.Card) >= en.Health ? 60 : 6;
                if (dangerMode && IsDefensive(echo.Card)) score += 8;

                // Эхо тратится один раз за игру — приберегаем, если выгода мала
                if (score < 4.0) score *= 0.35;
                if (score > 0.5)
                    outList.Add(new ScoredAction
                    {
                        Action = GameAction.UseEcho(),
                        Score = score,
                        Label = $"ЭХО → {echo.Card.Name}",
                    });
            }

            // «Завершить ход» как действие с нулевой ценностью
            outList.Add(new ScoredAction
            {
                Action = GameAction.EndTurn(),
                Score = 0.05,
                Label = "Завершить ход",
            });
            return outList;
        }

        /// <summary>Сколько урона «в лицо» может дать карта прямо сейчас.</summary>
        private double BurnPotential(CardData card, EntityCreature? target = null)
        {
            var e = Engine;
            int sd = card.Type == CardType.Spell ? e.SpellDamageOf(Side, card.Element, spellCost: null) : 0;
            double dmg = 0;

            foreach (var eff in card.Effects)
            {
                if (eff.Op == EffectOp.damage && (eff.To == TargetKind.EnemyHero || eff.To == null))
                    dmg += ((eff.Value ?? 0) + sd) * (eff.Repeat ?? 1);
                // damageAllEnemyCreatures в героя не идёт — не учитываем
            }

            if (card.Type == CardType.Creature)
                dmg += (card.Attack ?? 0) * (card.Keywords.Contains(Keyword.Rush) ? 1 : 0);

            return dmg;
        }

        /// <summary>Карта защищает своего героя или чистит доску противника.</summary>
        private bool IsDefensive(CardData card)
        {
            bool Has(EffectOp op) => card.Effects.Any(e => e.Op == op);

            if (Has(EffectOp.heal) || Has(EffectOp.shieldAllFriendlies) || Has(EffectOp.reduceIncomingDamage)) return true;
            if (Has(EffectOp.freezeAllEnemies) || Has(EffectOp.returnToHand) || Has(EffectOp.destroyCreature)) return true;
            if (card.Keywords.Contains(Keyword.Taunt)) return true;

            if (card.Type == CardType.Rune && card.Aura != null)
            {
                var op = card.Aura.Op;
                if (op == AuraOp.heroProtection || op == AuraOp.buffHealth || op == AuraOp.debuffAttackEnemy) return true;
            }
            return false;
        }

        /// <summary>Фракционный стиль: какие эффекты данная фракция ценит выше.</summary>
        private double FactionBias(CardData card)
        {
            bool Has(EffectOp op) => card.Effects.Any(e => e.Op == op);
            double b = 0;

            switch (Profile.Faction)
            {
                case Faction.Necrus:
                    // агрессивно жертвует существами ради «Кровавой жатвы»
                    if (Has(EffectOp.sacrifice)) b += 3.0;
                    if (card.Keywords.Contains(Keyword.Deathrattle)) b += 1.6;
                    if (card.Keywords.Contains(Keyword.Lifesteal)) b += 1.2;
                    if (Has(EffectOp.stealCard)) b += 1.0;
                    break;

                case Faction.Aurites:
                    if (Has(EffectOp.heal)) b += 1.6;
                    if (card.Keywords.Contains(Keyword.Taunt)) b += 1.4;
                    if (card.Type == CardType.Rune && card.Aura?.Op == AuraOp.heroProtection) b += 1.8;
                    if (Has(EffectOp.silence)) b += 1.0;
                    break;

                case Faction.Terramorph:
                    if (card.Effects.Any(e => e.Op == EffectOp.gainMaxMana || e.Op == EffectOp.gainMana)) b += 2.2;
                    if (card.Type == CardType.Rune && card.Aura?.Op == AuraOp.extraMana) b += 2.0;
                    if (card.Type == CardType.Creature && card.Cost >= 5) b += 1.4;
                    break;

                case Faction.Pyromancer:
                    if (card.Effects.Any(e => e.Op == EffectOp.damage && e.To == TargetKind.EnemyHero)) b += 2.2;
                    if (card.Type == CardType.Rune && card.Aura?.Op == AuraOp.spellDamage) b += 2.0;
                    if (card.Keywords.Contains(Keyword.SpellDamage)) b += 1.4;
                    if (card.Keywords.Contains(Keyword.Rush)) b += 1.0;
                    break;

                case Faction.Ethereal:
                    if (Has(EffectOp.stealCard)) b += 2.0;
                    if (Has(EffectOp.stealCreature)) b += 2.2;
                    if (Has(EffectOp.returnToHand)) b += 1.6;
                    if (card.Keywords.Contains(Keyword.Unblockable)) b += 1.2;
                    break;
            }
            return b;
        }
    }
}
