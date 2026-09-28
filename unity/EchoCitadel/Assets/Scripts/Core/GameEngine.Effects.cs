/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#), GameEngine, ЧАСТЬ 4.
   Эффекты карт: runEffects / applyEffect (23 операции), условие «если»,
   резолв цели и фильтры целей.
   ---------------------------------------------------------------------
   Порт src/engine/engine.ts, строки ~1244–1520. Здесь особенно важен
   порядок: он определяет последовательность обращений к ГПСЧ
   (chance, random-фильтр, stealCard) и порядок событий в журнале.

   Замечание по сортировкам: Array.prototype.sort в JS ГАРАНТИРОВАННО
   устойчив, List<T>.Sort в .NET — нет. Поэтому везде, где ключ сортировки
   может совпасть, используется LINQ OrderBy (устойчивая) — иначе выбор
   цели при равных значениях разъехался бы с TS.
   ===================================================================== */

using System;
using System.Collections.Generic;
using System.Linq;

namespace EchoCitadel.Core
{
    using EchoCitadel.Data;

    /// <summary>Результат резолва цели эффекта (TS: { creatures, heroSide? }).</summary>
    public sealed class EffectTarget
    {
        public List<EntityCreature> Creatures = new();
        public Side? HeroSide;
        public bool Invalid;
        public bool AllowHeroFallback;
    }

    public sealed partial class GameEngine
    {
        /* ----------------------------- ЭФФЕКТЫ ---------------------------------- */

        /// <summary>Последовательно применить список эффектов.</summary>
        public void RunEffects(List<CardEffect> effects, Side side, EffectContext ctx)
        {
            foreach (var eff in effects) ApplyEffect(eff, side, ctx);
        }

        /// <summary>Проверка условия «если» у эффекта. Порядок проверок повторяет TS:
        /// обращение к ГПСЧ (chance) происходит ПОСЛЕДНИМ.</summary>
        private bool CondOk(EffectCondition? cond, Side side)
        {
            if (cond == null) return true;
            var me = P(side);
            var en = P(side.Other());

            if (cond.HeroHealthAtMost.HasValue && me.Health > cond.HeroHealthAtMost.Value) return false;
            if (cond.HeroHealthAtLeast.HasValue && me.Health < cond.HeroHealthAtLeast.Value) return false;
            if (cond.EnemyCreaturesAtLeast.HasValue && en.Creatures.Count < cond.EnemyCreaturesAtLeast.Value) return false;
            if (cond.FriendlyCreaturesAtLeast.HasValue && me.Creatures.Count < cond.FriendlyCreaturesAtLeast.Value) return false;
            if (cond.HandSizeAtMost.HasValue && me.Hand.Count > cond.HandSizeAtMost.Value) return false;
            if (cond.HandSizeAtLeast.HasValue && me.Hand.Count < cond.HandSizeAtLeast.Value) return false;
            if (cond.TurnAtLeast.HasValue && TurnsTaken[(int)side] < cond.TurnAtLeast.Value) return false;
            if (cond.HasRune != null && !me.Runes.Any(r => r.CardId == cond.HasRune)) return false;
            if (cond.EnemyHasRune != null && !en.Runes.Any(r => r.CardId == cond.EnemyHasRune)) return false;
            if (cond.Chance.HasValue && !Rng.Chance(cond.Chance.Value)) return false;

            return true;
        }

        /// <summary>
        /// Применить один эффект. <c>repeat</c> повторяет ВСЁ разрешение (включая
        /// ветку <c>then</c> и проверку смертей) — как цикл в TS.
        /// </summary>
        public void ApplyEffect(CardEffect eff, Side side, EffectContext ctx)
        {
            if (!CondOk(eff.If, side)) return;

            var me = P(side);
            var en = P(side.Other());
            bool isSpellDamage = ctx.FromSpell;
            int? srcCost = ctx.SourceCard?.Cost;
            Element srcElement = ctx.SourceCard?.Element ?? Element.None;
            string? srcName = ctx.SourceCard?.Name;
            string? srcId = ctx.SourceCard?.Id;
            int repeat = eff.Repeat ?? 1;

            for (int i = 0; i < repeat; i++)
            {
                switch (eff.Op)
                {
                    case EffectOp.damage:
                    {
                        int baseAmt = eff.Value ?? 0;
                        int amt = isSpellDamage ? baseAmt + SpellDamageOf(side, srcElement, srcCost) : baseAmt;
                        var t = ResolveTarget(side, eff.To, eff.Filter, ctx);
                        if (amt <= 0 || t.Invalid) break;

                        var opts = new DamageOptions
                        {
                            Source = srcName,
                            FromSpell = isSpellDamage,
                            SourceCardId = srcId,
                        };
                        if (t.Creatures.Count > 0)
                            foreach (var c in t.Creatures) DamageCreature(c, amt, opts);
                        else if (t.HeroSide.HasValue)
                            DamageHero(t.HeroSide.Value, amt, opts);
                        else if (t.AllowHeroFallback)
                            DamageHero(en.Side, amt, opts);
                        break;
                    }

                    case EffectOp.heal:
                    {
                        var t = ResolveTarget(side, eff.To, eff.Filter, ctx);
                        int amt = eff.Value ?? 0;
                        if (t.Invalid) break;
                        if (t.Creatures.Count > 0)
                            foreach (var c in t.Creatures) HealCreature(c, amt, srcId);
                        else if (t.HeroSide.HasValue)
                            HealHero(t.HeroSide.Value, amt, srcName, srcId);
                        else if (t.AllowHeroFallback)
                            HealHero(side, amt, srcName, srcId);
                        break;
                    }

                    case EffectOp.draw:
                        for (int k = 0; k < (eff.Value ?? 1); k++) Draw(side, source: srcName);
                        break;

                    case EffectOp.opponentDraw:
                        for (int k = 0; k < (eff.Value ?? 1); k++) Draw(en.Side, source: srcName);
                        break;

                    case EffectOp.mill:
                        for (int k = 0; k < (eff.Value ?? 1); k++)
                        {
                            if (en.Deck.Count == 0) continue;
                            string c = en.Deck[0];
                            en.Deck.RemoveAt(0);
                            en.Graveyard.Add(c);
                            Emit(new GameEvent
                            {
                                Type = GameEventType.CardDiscarded,
                                Side = en.Side,
                                CardId = c,
                                Text = $"{en.Name} сбрасывает карту",
                            });
                        }
                        break;

                    case EffectOp.destroyCreature:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.EnemyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures) { c.Health = 0; MarkDeath(c); }
                        break;
                    }

                    case EffectOp.buffAttack:
                    case EffectOp.buffHealth:
                    case EffectOp.debuffAttack:
                    case EffectOp.debuffHealth:
                    case EffectOp.setAttack:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.AnyCreature, eff.Filter, ctx);
                        int v = eff.Value ?? 0;
                        foreach (var c in t.Creatures)
                        {
                            switch (eff.Op)
                            {
                                case EffectOp.buffAttack: c.Attack += v; break;
                                case EffectOp.buffHealth: c.MaxHealth += v; c.Health += v; break;
                                case EffectOp.debuffAttack: c.Attack = Math.Max(0, c.Attack - v); break;
                                case EffectOp.debuffHealth: // v2.6: Порча — перманентный -X здоровья
                                    c.MaxHealth = Math.Max(0, c.MaxHealth - v);
                                    c.Health -= v;
                                    if (c.Health <= 0) { c.Health = 0; MarkDeath(c); }
                                    break;
                                case EffectOp.setAttack: c.Attack = v; break;
                            }
                        }
                        break;
                    }

                    case EffectOp.applyStatus:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.AnyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures)
                            AddStatus(c, new StatusInstance
                            {
                                Type = eff.Status ?? StatusType.Burn,
                                Value = eff.StatusValue ?? 1,
                                TurnsLeft = eff.Value ?? -1,
                                SourceCardId = srcId,
                            });
                        break;
                    }

                    case EffectOp.removeStatus:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.FriendlyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures) c.Statuses.RemoveAll(s => s.Type == eff.Status);
                        foreach (var c in t.Creatures) c.Frozen = c.Statuses.Any(s => s.Type == StatusType.Freeze);
                        break;
                    }

                    case EffectOp.silence:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.EnemyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures) Silence(c);
                        break;
                    }

                    case EffectOp.returnToHand:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.EnemyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures)
                        {
                            var owner = P(c.Owner);
                            owner.Creatures.Remove(c);
                            _uidMap.Remove(c.Uid);
                            if (owner.Hand.Count < Config.MaxHand) owner.Hand.Add(c.CardId);
                            else owner.Graveyard.Add(c.CardId);

                            Emit(new GameEvent
                            {
                                Type = GameEventType.CreatureBounced,
                                Uid = c.Uid,
                                Side = c.Owner,
                                CardName = c.Name,
                                Text = $"«{c.Name}» возвращается в руку",
                            });
                        }
                        break;
                    }

                    case EffectOp.stealCard:
                    {
                        int n = eff.Value ?? 1;
                        for (int k = 0; k < n; k++)
                        {
                            if (en.Hand.Count == 0) break;
                            int idx = Rng.Int(en.Hand.Count);
                            string cardId = en.Hand[idx];
                            en.Hand.RemoveAt(idx);
                            if (me.Hand.Count < Config.MaxHand) me.Hand.Add(cardId);
                            else me.Graveyard.Add(cardId);

                            Emit(new GameEvent
                            {
                                Type = GameEventType.CardStolen,
                                Side = side,
                                CardId = cardId,
                                CardName = Db.Get(cardId)?.Name,
                                Text = $"{me.Name} крадёт карту у {en.Name}",
                            });
                        }
                        break;
                    }

                    case EffectOp.stealCreature:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.EnemyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures)
                        {
                            var from = P(c.Owner);
                            int idx = from.Creatures.IndexOf(c);
                            if (idx < 0) continue;
                            if (me.Creatures.Count >= Config.MaxCreaturesPerSide) break;

                            from.Creatures.RemoveAt(idx);
                            c.Owner = side;
                            c.JustPlayed = true;
                            c.SummonedOnTurn = TurnsTaken[(int)side];
                            c.AttacksThisTurn = 0;
                            me.Creatures.Add(c);

                            Emit(new GameEvent
                            {
                                Type = GameEventType.CreatureStolen,
                                Uid = c.Uid,
                                Side = side,
                                CardName = c.Name,
                                Text = $"{me.Name} перехватывает «{c.Name}»",
                            });
                        }
                        break;
                    }

                    case EffectOp.gainMana:
                        me.Mana = Math.Min(Config.MaxMana, me.Mana + (eff.Value ?? 1));
                        Emit(new GameEvent { Type = GameEventType.ManaChanged, Side = side, Value = me.Mana });
                        break;

                    case EffectOp.gainMaxMana:
                    {
                        int oldMax = me.MaxMana;
                        me.MaxMana = Math.Min(Config.MaxMana, me.MaxMana + (eff.Value ?? 1));
                        int gained = me.MaxMana - oldMax;
                        me.Mana = Math.Min(Config.MaxMana, me.Mana + gained);
                        Emit(new GameEvent
                        {
                            Type = GameEventType.ManaChanged,
                            Side = side,
                            Value = me.Mana,
                            Data = new Dictionary<string, object> { ["max"] = Math.Min(Config.MaxMana, me.MaxMana + me.BonusMana) },
                        });
                        break;
                    }

                    case EffectOp.gainEcho:
                        me.EchoPoints = Math.Min(Config.EchoPointsMax, me.EchoPoints + (eff.Value ?? 1));
                        Emit(new GameEvent
                        {
                            Type = GameEventType.EchoGained,
                            Side = side,
                            Text = $"{me.Name} получает Эхо-очко",
                        });
                        break;

                    case EffectOp.summonToken:
                        // токен встроен прямо в эффект; боевой клич не срабатывает
                        // (TS вызывает summon без opts.fromHand → false)
                        if (eff.Token != null) Summon(side, eff.Token, fromHand: false);
                        break;

                    case EffectOp.sacrifice:
                    {
                        var pool = me.Creatures.Where(c => c.Uid != ctx.SourceUid).ToList();
                        if (pool.Count > 0)
                        {
                            // устойчивая сортировка: слабейшее тело, при равенстве — раньше призванное
                            pool = pool.OrderBy(c => c.Attack + c.Health).ThenBy(c => c.Uid).ToList();
                            var victim = pool[0];
                            victim.Health = 0;
                            MarkDeath(victim);
                        }
                        break;
                    }

                    case EffectOp.restoreHealthByAttack:
                    {
                        var t = ResolveTarget(side, eff.To ?? TargetKind.FriendlyCreature, eff.Filter, ctx);
                        foreach (var c in t.Creatures) HealHero(side, c.Attack, c.Name);
                        break;
                    }

                    case EffectOp.damageAllEnemyCreatures:
                    {
                        int amt = (eff.Value ?? 0) + (isSpellDamage ? SpellDamageOf(side, srcElement, srcCost) : 0);
                        foreach (var c in new List<EntityCreature>(en.Creatures))
                            DamageCreature(c, amt, new DamageOptions { Source = srcName, FromSpell = isSpellDamage, SourceCardId = srcId });
                        break;
                    }

                    case EffectOp.damageAllFriendlyCreatures:
                    {
                        int amt = (eff.Value ?? 0) + (isSpellDamage ? SpellDamageOf(side, srcElement, srcCost) : 0);
                        foreach (var c in new List<EntityCreature>(me.Creatures))
                            DamageCreature(c, amt, new DamageOptions { Source = srcName, FromSpell = isSpellDamage, SourceCardId = srcId });
                        break;
                    }

                    case EffectOp.damageAllCreatures:
                    {
                        int amt = (eff.Value ?? 0) + (isSpellDamage ? SpellDamageOf(side, srcElement, srcCost) : 0);
                        foreach (var c in AllCreatures())
                            DamageCreature(c, amt, new DamageOptions { Source = srcName, FromSpell = isSpellDamage, SourceCardId = srcId });
                        break;
                    }

                    case EffectOp.healAllFriendlyCreatures:
                        foreach (var c in me.Creatures) HealCreature(c, eff.Value ?? 1, srcId);
                        break;

                    case EffectOp.freezeAllEnemies:
                        foreach (var c in en.Creatures)
                            AddStatus(c, new StatusInstance { Type = StatusType.Freeze, Value = 1, TurnsLeft = eff.Value ?? 1 });
                        break;

                    case EffectOp.burnAllEnemies:
                        foreach (var c in en.Creatures)
                            AddStatus(c, new StatusInstance
                            {
                                Type = StatusType.Burn,
                                Value = eff.StatusValue ?? 1,
                                TurnsLeft = eff.Value ?? 2,
                            });
                        break;

                    case EffectOp.shieldAllFriendlies:
                        foreach (var c in me.Creatures)
                            AddStatus(c, new StatusInstance { Type = StatusType.Shield, Value = 1, TurnsLeft = -1 });
                        break;

                    case EffectOp.damageHeroes:
                    {
                        int amount = (eff.Value ?? 1)
                            + (isSpellDamage ? SpellDamageOf(side, srcElement, srcCost) : 0);
                        var opts = new DamageOptions
                        {
                            Source = srcName,
                            SourceCardId = srcId,
                            FromSpell = isSpellDamage,
                        };
                        DamageHero(en.Side, amount, opts);
                        DamageHero(side, amount, opts);
                        break;
                    }

                    case EffectOp.reduceIncomingDamage:
                        me.DamageReduction += eff.Value ?? 1;
                        me.IncomingDamageReductionTurns = Math.Max(me.IncomingDamageReductionTurns, 1);
                        break;

                    case EffectOp.increaseSpellDamage:
                        me.SpellDamageBonus += eff.Value ?? 1;
                        break;

                    case EffectOp.copyLastSpell:
                        if (me.LastSpell != null)
                        {
                            var card = Db.Get(me.LastSpell.CardId);
                            if (card != null && card.Subtype != SpellSubtype.Ritual)
                                CastInstantSpell(side, card, me.LastSpell.TargetUid, me.LastSpell.TargetSide, isEchoCopy: true);
                        }
                        break;
                }

                if (eff.Then != null) ApplyEffect(eff.Then, side, ctx);
                CheckDeaths();
                if (Result != GameResult.Ongoing) return;
            }
        }

        /* ----------------------------- ЦЕЛИ ЭФФЕКТОВ ----------------------------- */

        /// <summary>
        /// Резолв цели по каждой компоненте эффекта. Ручной выбор влияет только на
        /// совместимый одиночный эффект; массовые и случайные эффекты сохраняют свои правила.
        /// </summary>
        private EffectTarget ResolveTarget(Side side, TargetKind? to, EffectFilter? filter, EffectContext ctx)
        {
            var me = P(side);
            var en = P(side.Other());
            var kind = to.HasValue && to.Value != TargetKind.None
                ? to.Value : (ctx.SourceCard?.Target ?? TargetKind.None);
            var res = new EffectTarget();
            bool isSingleCreature = kind == TargetKind.EnemyCreature
                || kind == TargetKind.FriendlyCreature || kind == TargetKind.AnyCreature;

            if (ctx.TargetUid.HasValue && isSingleCreature && filter?.Random != true)
            {
                var c = FindCreature(ctx.TargetUid.Value);
                bool sideMatches = c != null && (kind == TargetKind.AnyCreature
                    || (kind == TargetKind.FriendlyCreature && c.Owner == me.Side)
                    || (kind == TargetKind.EnemyCreature && c.Owner == en.Side));
                bool filterMatches = c != null && FilterCreatures(new List<EntityCreature> { c }, filter).Count > 0;
                if (!sideMatches || !filterMatches)
                {
                    res.Invalid = true;
                    return res;
                }
                res.Creatures.Add(c!);
                return res;
            }

            res.AllowHeroFallback = kind == TargetKind.None
                && !ctx.TargetUid.HasValue && !ctx.TargetSide.HasValue;
            switch (kind)
            {
                case TargetKind.None:
                    break;
                case TargetKind.EnemyCreature:
                    res.Creatures = FilterCreatures(en.Creatures, filter);
                    break;
                case TargetKind.FriendlyCreature:
                    res.Creatures = FilterCreatures(me.Creatures, filter);
                    break;
                case TargetKind.AnyCreature:
                {
                    var both = new List<EntityCreature>(me.Creatures);
                    both.AddRange(en.Creatures);
                    res.Creatures = FilterCreatures(both, filter);
                    break;
                }
                case TargetKind.AllEnemies:
                    res.Creatures = new List<EntityCreature>(en.Creatures);
                    break;
                case TargetKind.AllFriendlies:
                    res.Creatures = new List<EntityCreature>(me.Creatures);
                    break;
                case TargetKind.AllCreatures:
                    res.Creatures = AllCreatures();
                    break;
                case TargetKind.EnemyHero:
                    res.HeroSide = en.Side;
                    break;
                case TargetKind.FriendlyHero:
                    res.HeroSide = me.Side;
                    break;
                case TargetKind.AnyHero:
                    res.HeroSide = ctx.TargetSide == me.Side ? me.Side : en.Side;
                    break;
            }
            return res;
        }

        /// <summary>
        /// Фильтр целей. Без фильтра берётся существо с наименьшим здоровьем
        /// (по духу авто-боя из ТЗ). Все сортировки — устойчивые (LINQ OrderBy),
        /// чтобы совпадать с Array.prototype.sort из JS.
        /// </summary>
        private List<EntityCreature> FilterCreatures(List<EntityCreature> list, EffectFilter? f)
        {
            if (list.Count == 0) return new List<EntityCreature>();

            if (f == null)
            {
                var one = list.OrderBy(c => c.Health).ThenBy(c => c.Uid).FirstOrDefault();
                var single = new List<EntityCreature>();
                if (one != null) single.Add(one);
                return single;
            }

            IEnumerable<EntityCreature> q = list;
            if (f.AttackAtLeast.HasValue) q = q.Where(c => c.Attack >= f.AttackAtLeast.Value);
            if (f.AttackAtMost.HasValue) q = q.Where(c => c.Attack <= f.AttackAtMost.Value);
            if (f.CostAtLeast.HasValue) q = q.Where(c => c.Cost >= f.CostAtLeast.Value);
            if (f.IsLegendary.HasValue) q = q.Where(c => (c.Data.Rarity == Rarity.Legendary) == f.IsLegendary.Value);
            if (f.NotSilenced == true) q = q.Where(c => !c.Silenced);

            var l = q.ToList();
            if (l.Count == 0) return l;

            if (f.Random == true)
            {
                int n = f.Count ?? 1;
                var pool = Rng.Shuffle(l);
                return pool.Take(Math.Min(n, pool.Count)).ToList();
            }

            // порядок применения флагов — как в TS (каждый следующий пересортировывает)
            if (f.LowestHealth == true) l = l.OrderBy(c => c.Health).ThenBy(c => c.Uid).ToList();
            if (f.LowestAttack == true) l = l.OrderBy(c => c.Attack).ThenBy(c => c.Uid).ToList();
            if (f.HighestAttack == true) l = l.OrderByDescending(c => c.Attack).ThenBy(c => c.Uid).ToList();
            if (f.HighestHealth == true) l = l.OrderByDescending(c => c.Health).ThenBy(c => c.Uid).ToList();

            return l.Take(f.Count ?? 1).ToList();
        }
    }
}
