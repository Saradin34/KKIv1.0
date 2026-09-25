/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#), GameEngine, ЧАСТЬ 3.
   Розыгрыш карт, цели, мана, Эхо, пять фаз хода, бой, конец игры, снимок.
   ---------------------------------------------------------------------
   Порт src/engine/engine.ts, строки ~611–1545. Порядок вызовов ГПСЧ и
   обхода списков повторяет TS — иначе партии разъезжаются.
   ===================================================================== */

using System;
using System.Collections.Generic;

namespace EchoCitadel.Core
{
    using EchoCitadel.Data;

    /* ------------------------ КОНТЕКСТ И РЕЗУЛЬТАТЫ ПРОВЕРОК ------------------- */

    /// <summary>
    /// Контекст разрешения эффекта (в TS — объект ctx у runEffects/applyEffect).
    /// </summary>
    public sealed class EffectContext
    {
        public int? SourceUid;
        public CardData? SourceCard;
        public int? TargetUid;
        public Side? TargetSide;
        public bool FromSpell;
        public bool FromRune;
        public bool IsBattlecry;
        public bool IsDeathrattle;
    }

    /// <summary>Результат проверки «можно ли разыграть карту» (TS: canPlay).</summary>
    public sealed class PlayCheck
    {
        public bool Ok;
        public string? Reason;
        public CardData? Card;
        public bool NeedsTarget;
    }

    /// <summary>Результат проверки «можно ли использовать Эхо» (TS: canUseEcho).</summary>
    public sealed class EchoCheck
    {
        public bool Ok;
        public string? Reason;
        public CardData? Card;
    }

    /// <summary>Цель, которую может выбрать игрок (TS: validTargets).</summary>
    public sealed class TargetOption
    {
        public int? Uid;
        public Side? Side;
        public string Label = "";
    }

    /// <summary>Что выбрал авто-резолв цели (TS: chooseAutoTarget).</summary>
    public sealed class AutoTarget
    {
        public EntityCreature? Creature;
        public bool HitHero;
    }

    public sealed partial class GameEngine
    {
        /* ----------------------------- РОЗЫГРЫШ КАРТ ----------------------------- */

        /// <summary>
        /// Можно ли разыграть карту из руки: фаза, мана, лимит поля, лимит рун,
        /// уникальность руны, наличие допустимой цели.
        /// </summary>
        public PlayCheck CanPlay(Side side, int handIndex)
        {
            var pl = P(side);
            if (Result != GameResult.Ongoing) return new PlayCheck { Reason = "Игра окончена" };
            if (handIndex < 0 || handIndex >= pl.Hand.Count)
                return new PlayCheck { Reason = "Нет такой карты в руке" };
            var peek = Db.Get(pl.Hand[handIndex]);
            bool isInstant = peek != null && peek.Type == CardType.Spell && peek.Subtype == SpellSubtype.Instant;
            // MTG: мгновенные — instant speed
            if (isInstant)
            {
                if (InstantWindow != null && InstantWindow != side)
                    return new PlayCheck { Reason = "Сейчас приоритет у противника — дождитесь окна отклика" };
            }
            else
            {
                if (InstantWindow == side)
                    return new PlayCheck { Reason = "В окне отклика играются только мгновенные заклинания (⚡)" };
                if (InstantWindow != null && InstantWindow != side)
                    return new PlayCheck { Reason = "Сейчас приоритет у противника" };
                if (ActiveSide != side || Phase != Phase.Main)
                    return new PlayCheck { Reason = "Сейчас не ваша основная фаза — не-мгновенные карты только в свой Main" };
            }

            var card = Db.Get(pl.Hand[handIndex]);
            if (card == null) return new PlayCheck { Reason = "Карта не найдена в базе" };
            if (card.Cost > AvailableMana(side)) return new PlayCheck { Reason = "Недостаточно маны", Card = card };

            if (card.Type == CardType.Creature && pl.Creatures.Count >= Config.MaxCreaturesPerSide)
                return new PlayCheck { Reason = $"Поле заполнено ({Config.MaxCreaturesPerSide} существ)", Card = card };

            if (card.Type == CardType.Rune)
            {
                int limit = card.RuneLimit ?? 3;
                if (pl.Runes.Count >= limit) return new PlayCheck { Reason = $"Максимум рун: {limit}", Card = card };
                foreach (var r in pl.Runes)
                    if (r.CardId == card.Id)
                        return new PlayCheck { Reason = "Эта руна уже установлена (уникальна)", Card = card };
            }

            bool needsTarget = NeedsTarget(side, card);
            if (needsTarget && !HasValidTarget(side, card))
                return new PlayCheck { Reason = "Нет допустимой цели", Card = card };

            return new PlayCheck { Ok = true, Card = card, NeedsTarget = needsTarget };
        }

        /// <summary>Доступная мана. TS держит это отдельным методом — сохраняем контракт.</summary>
        public int AvailableMana(Side side) => P(side).Mana;

        /// <summary>Потратить ману. false — если не хватает.</summary>
        public bool SpendMana(Side side, int amount)
        {
            var pl = P(side);
            if (pl.Mana < amount) return false;
            pl.Mana -= amount;
            Stats[(int)side].ManaSpent += amount;
            Emit(new GameEvent
            {
                Type = GameEventType.ManaChanged,
                Side = side,
                Value = pl.Mana,
                Data = new Dictionary<string, object> { ["max"] = pl.MaxMana + pl.BonusMana },
            });
            return true;
        }

        /// <summary>Нужен ли карте выбор цели (массовые цели выбора не требуют).</summary>
        public bool NeedsTarget(Side side, CardData card)
        {
            if (card.Target == TargetKind.None) return false;
            return HasValidTarget(side, card);
        }

        public bool HasValidTarget(Side side, CardData card) => ValidTargets(side, card).Count > 0;

        /// <summary>Список допустимых целей карты — его рисует UI и по нему целится ИИ.</summary>
        public List<TargetOption> ValidTargets(Side side, CardData card)
        {
            var me = P(side);
            var en = P(side.Other());
            var list = new List<TargetOption>();

            switch (card.Target)
            {
                case TargetKind.None:
                    break;
                case TargetKind.EnemyCreature:
                    foreach (var c in en.Creatures) list.Add(new TargetOption { Uid = c.Uid, Side = en.Side, Label = c.Name });
                    break;
                case TargetKind.FriendlyCreature:
                    foreach (var c in me.Creatures) list.Add(new TargetOption { Uid = c.Uid, Side = me.Side, Label = c.Name });
                    break;
                case TargetKind.AnyCreature:
                    foreach (var c in me.Creatures) list.Add(new TargetOption { Uid = c.Uid, Side = me.Side, Label = c.Name });
                    foreach (var c in en.Creatures) list.Add(new TargetOption { Uid = c.Uid, Side = en.Side, Label = c.Name });
                    break;
                case TargetKind.EnemyHero:
                    list.Add(new TargetOption { Side = en.Side, Label = en.Name });
                    break;
                case TargetKind.FriendlyHero:
                    list.Add(new TargetOption { Side = me.Side, Label = me.Name });
                    break;
                case TargetKind.AnyHero:
                    list.Add(new TargetOption { Side = me.Side, Label = me.Name });
                    list.Add(new TargetOption { Side = en.Side, Label = en.Name });
                    break;
                default:
                    break;   // массовые цели не требуют выбора
            }
            return list;
        }

        /// <summary>
        /// Разыграть карту из руки. Если цель обязательна, но не указана или невалидна,
        /// берётся первая допустимая (так же поступает авто-бой и ИИ-фолбэк).
        /// </summary>
        public bool PlayCard(Side side, int handIndex, int? targetUid = null, Side? targetSide = null)
        {
            var check = CanPlay(side, handIndex);
            if (!check.Ok || check.Card == null)
            {
                Say($"Нельзя разыграть: {check.Reason}", side);
                return false;
            }

            var card = check.Card;
            var pl = P(side);

            // ритуалы и заклинания с обязательной целью: фиксируем цель
            if (check.NeedsTarget)
            {
                var valid = ValidTargets(side, card);
                TargetOption? chosen = null;
                foreach (var v in valid) if (v.Uid == targetUid && v.Side == targetSide) { chosen = v; break; }
                if (chosen == null) foreach (var v in valid) if (v.Uid == targetUid) { chosen = v; break; }
                chosen ??= valid[0];
                targetUid = chosen.Uid;
                targetSide = chosen.Side;
            }

            pl.Hand.RemoveAt(handIndex);
            if (card.Cost > 0) SpendMana(side, card.Cost);
            pl.CardsPlayedThisTurn++;
            Stats[(int)side].CardsPlayed++;

            Emit(new GameEvent
            {
                Type = GameEventType.CardPlayed,
                Side = side,
                CardId = card.Id,
                CardName = card.Name,
                Value = card.Cost,
            });

            switch (card.Type)
            {
                case CardType.Creature:
                    Summon(side, card, fromHand: true);
                    break;

                case CardType.Rune:
                    PlayRune(side, card);
                    break;

                case CardType.Spell:
                    if (card.Subtype == SpellSubtype.Ritual)
                    {
                        pl.SpellsCastThisTurn++;
                        Stats[(int)side].SpellsCast++;
                        Emit(new GameEvent
                        {
                            Type = GameEventType.SpellCast,
                            Side = side,
                            CardId = card.Id,
                            CardName = card.Name,
                            Text = $"{pl.Name} разыгрывает ритуал «{card.Name}»",
                        });
                        FactionOnSpellCast(side, card);
                        PlaceRitual(side, card, targetUid, targetSide);
                    }
                    else
                    {
                        // LIFO-стек мгновенных (порт engine.ts): в симах interactiveStack=false
                        // → сразу resolveStackTop, исход партии не меняется.
                        Stack.Add(new StackEntry { Side = side, Card = card, TargetUid = targetUid, TargetSide = targetSide });
                        Emit(new GameEvent
                        {
                            Type = GameEventType.StackPushed,
                            Side = side,
                            CardId = card.Id,
                            CardName = card.Name,
                            Text = $"В стек: «{card.Name}»",
                        });
                        if (!InteractiveStack) ResolveStackTop();
                    }
                    break;
            }

            CheckDeaths();
            return true;
        }

        /// <summary>Мгновенное заклинание: резолв эффектов + учёт для Эха и пассивок.</summary>
        public void CastInstantSpell(Side side, CardData card, int? targetUid = null, Side? targetSide = null,
            bool fromHand = false, bool isEchoCopy = false)
        {
            var pl = P(side);
            pl.SpellsCastThisTurn++;
            Stats[(int)side].SpellsCast++;
            pl.LastSpell = new LastSpellCast { CardId = card.Id, TargetUid = targetUid, TargetSide = targetSide };

            Emit(new GameEvent
            {
                Type = isEchoCopy ? GameEventType.SpellCopied : GameEventType.SpellCast,
                Side = side,
                CardId = card.Id,
                CardName = card.Name,
                TargetUid = targetUid,
                TargetSide = targetSide,
                Text = $"{pl.Name} {(isEchoCopy ? "ЭХОм повторяет" : "разыгрывает")} «{card.Name}»",
            });
            Say($"{pl.Name}: заклинание «{card.Name}»{(isEchoCopy ? " (Эхо)" : "")}", side);

            // помечаем, что урон сейчас наносит заклинание: представление по этому
            // флагу и по SourceElement выбирает VFX (docs/VISUAL_STACK.md, раздел 6)
            _spellSourceCard = card;
            RunEffects(card.Effects, side, new EffectContext
            {
                SourceCard = card,
                TargetUid = targetUid,
                TargetSide = targetSide,
                FromSpell = true,
            });
            _spellSourceCard = null;

            FactionOnSpellCast(side, card);
            pl.Graveyard.Add(card.Id);
            CheckDeaths();
        }

        /// <summary>
        /// Пассивка Пиромантов «Пламя возмездия» (−1 здоровье за заклинание)
        /// и триггеры «при розыгрыше заклинания» у существ и рун.
        /// </summary>
        private void FactionOnSpellCast(Side side, CardData card)
        {
            var pl = P(side);

            if (pl.Faction == Faction.Pyromancer)
            {
                int selfDmg = Pround(1 * PassiveMul(Faction.Pyromancer));
                if (selfDmg > 0)
                {
                    DamageHero(side, selfDmg, new DamageOptions { Source = "Пламя возмездия", IgnoreReduction = true });
                    Say($"Пламя возмездия: Пиромант теряет {selfDmg} здоровья", side);
                }
            }

            foreach (var c in pl.Creatures)
            {
                if (c.Silenced || c.Data.OnSpellCast is not { Count: > 0 }) continue;
                RunEffects(c.Data.OnSpellCast, side, new EffectContext { SourceUid = c.Uid, SourceCard = c.Data });
            }

            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                if (r.Data.OnSpellCast is { Count: > 0 })
                    RunEffects(r.Data.OnSpellCast, side, new EffectContext { SourceCard = r.Data, FromRune = true });
            }
        }

        /* ----------------------------- МЕХАНИКА «ЭХО» ---------------------------- */

        /// <summary>
        /// Доступно ли Эхо (ТЗ п.2.6): своя основная фаза, есть очко, не потрачено
        /// в этой игре, есть повторяемое мгновенное заклинание.
        /// </summary>
        public EchoCheck CanUseEcho(Side side)
        {
            var pl = P(side);
            if (ActiveSide != side || Phase != Phase.Main)
                return new EchoCheck { Reason = "Эхо доступно только в вашу основную фазу" };
            if (pl.EchoPoints <= 0) return new EchoCheck { Reason = "Нет Эхо-очков" };
            if (pl.EchoUsedThisGame >= Config.EchoUsagesPerGame)
                return new EchoCheck { Reason = "Эхо уже использовано в этой игре" };
            if (pl.LastSpell == null) return new EchoCheck { Reason = "Вы ещё не разыгрывали заклинаний" };

            var card = Db.Get(pl.LastSpell.CardId);
            if (card == null) return new EchoCheck { Reason = "Повторяемое заклинание недоступно" };
            if (card.Subtype == SpellSubtype.Ritual) return new EchoCheck { Reason = "Эхо не повторяет ритуалы" };

            return new EchoCheck { Ok = true, Card = card };
        }

        /// <summary>
        /// Потратить Эхо-очко и повторить последнее заклинание бесплатно.
        /// Цель берётся прежняя; если она мертва — первая допустимая.
        /// </summary>
        public bool UseEcho(Side side, int? targetUid = null, Side? targetSide = null)
        {
            var chk = CanUseEcho(side);
            if (!chk.Ok || chk.Card == null)
            {
                Say($"Эхо недоступно: {chk.Reason}", side);
                return false;
            }

            var pl = P(side);
            var card = chk.Card;
            int? tUid = pl.LastSpell?.TargetUid;
            Side? tSide = pl.LastSpell?.TargetSide;

            // цель должна быть жива; иначе — авто-выбор валидной или розыгрыш без цели
            if (tUid.HasValue && !_uidMap.ContainsKey(tUid.Value))
            {
                var valid = ValidTargets(side, card);
                tUid = valid.Count > 0 ? valid[0].Uid : null;
                tSide = valid.Count > 0 ? valid[0].Side : null;
            }
            if (targetUid.HasValue)
            {
                tUid = targetUid;
                tSide = targetSide ?? tSide;
            }

            pl.EchoPoints -= 1;
            pl.EchoUsedThisGame += 1;
            Stats[(int)side].EchoUsed++;

            Emit(new GameEvent
            {
                Type = GameEventType.EchoSpent,
                Side = side,
                CardId = card.Id,
                CardName = card.Name,
                Text = $"{pl.Name} тратит Эхо-очко и повторяет «{card.Name}» бесплатно",
            });

            CastInstantSpell(side, card, tUid, tSide, isEchoCopy: true);
            return true;
        }

        /* ----------------------------- ФАЗЫ ХОДА --------------------------------- */

        /// <summary>
        /// Полный цикл хода активного игрока: Начало → Ресурсы → (Основную ведёт
        /// контроллер: человек или ИИ, затем вызывает FinishMainPhase).
        /// </summary>
        /* ------------------------- СТЕК (LIFO) ------------------------- */

        /// <summary>Резолв вершины стека; true, если стек ещё не пуст. TS: resolveStackTop.</summary>
        public bool ResolveStackTop()
        {
            if (Stack.Count == 0) return false;
            var en = Stack[Stack.Count - 1];
            Stack.RemoveAt(Stack.Count - 1);
            CastInstantSpell(en.Side, en.Card, en.TargetUid, en.TargetSide, fromHand: false);
            Emit(new GameEvent
            {
                Type = GameEventType.StackResolved,
                Side = en.Side,
                CardId = en.Card.Id,
                CardName = en.Card.Name,
                Text = $"Стек резолвится: «{en.Card.Name}»",
            });
            CheckDeaths();
            return Stack.Count > 0;
        }

        /// <summary>Пас приоритета в стеке: резолв вершины (LIFO). TS: passStack.</summary>
        public bool PassStack(Side side)
        {
            if (Stack.Count == 0) return false;
            return ResolveStackTop();
        }

        public void OpenInstantWindow(Side side)
        {
            if (Result != GameResult.Ongoing) return;
            InstantWindow = side;
            Emit(new GameEvent
            {
                Type = GameEventType.InstantWindow,
                Side = side,
                Turn = Turn,
                Text = $"Окно отклика: приоритет у {(side == Side.Player ? "игрока" : "противника")}",
            });
        }

        public void CloseInstantWindow()
        {
            if (InstantWindow == null) return;
            var side = InstantWindow.Value;
            InstantWindow = null;
            Emit(new GameEvent
            {
                Type = GameEventType.InstantWindowClosed,
                Side = side,
                Turn = Turn,
                Text = "Приоритет возвращён",
            });
        }

        public void RunTurn()
        {
            if (Result != GameResult.Ongoing) return;
            CloseInstantWindow();

            TurnsTaken[(int)ActiveSide]++;
            if (ActiveSide == Side.Player) Turn++;
            var pl = Active();

            pl.SpellsCastThisTurn = 0;
            pl.CardsPlayedThisTurn = 0;
            foreach (var c in pl.Creatures) { c.AttacksThisTurn = 0; c.UnblockableThisTurn = false; }

            SetPhase(Phase.Start);
            DoStartPhase();
            if (Result != GameResult.Ongoing) return;

            SetPhase(Phase.Resource);
            DoResourcePhase();
            if (Result != GameResult.Ongoing) return;

            SetPhase(Phase.Main);   // основную фазу ведёт контроллер
        }

        private void SetPhase(Phase ph)
        {
            Phase = ph;
            Emit(new GameEvent
            {
                Type = GameEventType.PhaseChanged,
                Side = ActiveSide,
                Phase = ph,
                Turn = Turn,
                Text = $"Фаза: {ph}",   // TS печатает строку перечисления: «Фаза: Start»
            });
        }

        /* --- 1. НАЧАЛО --- */

        private void DoStartPhase()
        {
            var side = ActiveSide;
            var pl = P(side);
            var en = P(side.Other());

            // 1.1 руны владельца активируются
            foreach (var r in new List<EntityRune>(pl.Runes))
            {
                if (r.Silenced) continue;

                if (r.Data.OnTurnStart is { Count: > 0 } tick)
                {
                    Emit(new GameEvent
                    {
                        Type = GameEventType.RuneTick,
                        Side = side,
                        CardId = r.CardId,
                        CardName = r.Name,
                        Text = $"Руна «{r.Name}» пульсирует",
                    });
                    RunEffects(tick, side, new EffectContext { SourceCard = r.Data, FromRune = true });
                }

                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.extraCard)
                    for (int i = 0; i < (aura.Value ?? 1); i++) Draw(side, source: r.Name);
            }

            // 1.2 руны противника, помеченные onEnemyTurnStart
            foreach (var r in new List<EntityRune>(en.Runes))
            {
                if (r.Silenced) continue;
                if (r.Data.OnEnemyTurnStart is { Count: > 0 } t)
                    RunEffects(t, en.Side, new EffectContext { SourceCard = r.Data, FromRune = true });
            }

            // 1.3 пассивка Эфирных «Иллюзорная тень» (редакция ТЗ п.2.5.5):
            //     в начале хода ОДНО ваше существо с наименьшей атакой становится
            //     неуловимым, но лишь с вероятностью 50% (иллюзия нестабильна).
            //     Гарантированная неуловимость давала бы бесплатный урон в героя
            //     каждый ход — это сильнее любого заклинания.
            if (pl.Faction == Faction.Ethereal && pl.Creatures.Count > 0)
            {
                const double rate = 0.5;
                int count = Pround(rate * PassiveMul(Faction.Ethereal));

                var sorted = new List<EntityCreature>(pl.Creatures);
                sorted.Sort((a, b) => a.Attack.CompareTo(b.Attack));
                int minAtk = sorted[0].Attack;

                var pool = new List<EntityCreature>();
                foreach (var c in sorted) if (c.Attack == minAtk) pool.Add(c);

                var chosen = new List<EntityCreature>();
                for (int i = 0; i < count; i++)
                {
                    if (pool.Count == 0)
                    {
                        pool.Clear();
                        foreach (var c in sorted) if (!chosen.Contains(c)) pool.Add(c);
                    }
                    if (pool.Count == 0) break;

                    var pick = Rng.Pick(pool);
                    if (pick == null) break;
                    pick.UnblockableThisTurn = true;
                    chosen.Add(pick);
                    pool.Remove(pick);
                }

                if (chosen.Count > 0)
                {
                    var names = new List<string>();
                    foreach (var c in chosen) names.Add($"«{c.Name}»");
                    Say($"Иллюзорная тень: {string.Join(", ", names)} неуловимы в этом ходу", side);
                }
            }

            // 1.4 статусы существ владельца (горение) и сброс болезни призыва
            foreach (var c in new List<EntityCreature>(pl.Creatures))
            {
                c.JustPlayed = c.SummonedOnTurn >= TurnsTaken[(int)side];

                var burn = c.FindStatus(StatusType.Burn);
                if (burn != null && !c.Silenced)
                {
                    DamageCreature(c, burn.Value, new DamageOptions
                    {
                        Source = "Горение",
                        PierceShield = true,
                        SourceCardId = burn.SourceCardId,
                    });
                    if (burn.TurnsLeft > 0)
                    {
                        burn.TurnsLeft--;
                        if (burn.TurnsLeft <= 0) RemoveStatus(c, burn);
                    }
                }

                // триггеры существ на начало хода
                if (!c.Silenced && c.Data.OnTurnStart is { Count: > 0 } ots)
                    RunEffects(ots, side, new EffectContext { SourceUid = c.Uid, SourceCard = c.Data });
            }

            // 1.5 ритуалы: отсчёт и резолв
            foreach (var rt in new List<EntityRitual>(pl.Rituals))
            {
                rt.TurnsLeft--;
                if (rt.TurnsLeft > 0) continue;

                pl.Rituals.Remove(rt);
                pl.Graveyard.Add(rt.CardId);
                Emit(new GameEvent
                {
                    Type = GameEventType.RitualResolved,
                    Side = side,
                    CardId = rt.CardId,
                    CardName = rt.Name,
                    Text = $"Ритуал «{rt.Name}» завершён",
                });
                Say($"{pl.Name}: ритуал «{rt.Name}» разрешается", side);

                RunEffects(rt.Data.Effects, side, new EffectContext
                {
                    SourceCard = rt.Data,
                    TargetUid = rt.TargetUid,
                    TargetSide = rt.TargetSide,
                    FromSpell = true,
                });
                FactionOnSpellCast(side, rt.Data);
            }

            CheckDeaths();
        }

        /* --- 2. РЕСУРСЫ --- */

        private void DoResourcePhase()
        {
            var side = ActiveSide;
            var pl = P(side);

            // +1 к максимуму маны (до 10)
            if (pl.MaxMana < Config.MaxMana) pl.MaxMana++;

            // бонусная мана: пассивка Терраморфов + ауры рун (пересчёт каждый ход)
            pl.BonusMana = ComputeBonusMana(side);

            int totalMax = Math.Min(Config.MaxMana, pl.MaxMana + pl.BonusMana);
            pl.Mana = totalMax;   // полное восполнение

            // аура «лишний добор»
            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.drawOnResource)
                    for (int i = 0; i < (aura.Value ?? 1); i++) Draw(side, source: r.Name);
            }

            Emit(new GameEvent
            {
                Type = GameEventType.ManaChanged,
                Side = side,
                Value = pl.Mana,
                Data = new Dictionary<string, object> { ["max"] = totalMax },
                Text = $"{pl.Name}: {pl.Mana}/{totalMax} маны",
            });

            // обычный добор карты в начале хода
            Draw(side, source: "Ход");
            CheckDeaths();
        }

        /// <summary>
        /// Число стартовых ходов Терраморфов, в которые нельзя атаковать (ТЗ: 3).
        /// При балансировочном множителе &lt; 1 «мирный» период вероятностно короче.
        /// </summary>
        public int TerramorphPeaceTurns(Side side)
        {
            var pl = P(side);
            if (pl.Faction != Faction.Terramorph) return 0;
            return Pround(3 * PassiveMul(Faction.Terramorph));
        }

        /// <summary>
        /// Бонусная мана: «Корни земли» Терраморфов (редакция ТЗ п.2.5.3) —
        /// +1 к максимуму сверх обычного прироста всегда, но первые 3 своих хода
        /// существа не атакуют. Рампа постоянна — ограничение и есть цена.
        /// </summary>
        private int ComputeBonusMana(Side side)
        {
            var pl = P(side);
            int bonus = 0;

            if (pl.Faction == Faction.Terramorph)
                bonus += Pround(1 * PassiveMul(Faction.Terramorph));

            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.extraMana) bonus += aura.Value ?? 1;
            }
            return bonus;
        }

        /* --- 3. ОСНОВНАЯ --- (её ведёт контроллер; движок лишь исполняет действия) */

        /// <summary>
        /// Контроллер сообщает, что основная фаза завершена: Битва → анимации →
        /// Конец → передача хода.
        /// </summary>
        public void FinishMainPhase()
        {
            if (Phase != Phase.Main) return;

            SetPhase(Phase.Combat);
            DoCombatPhase();

            // даём представлению отрисовать бой по шагам (движок уже всё посчитал)
            RunCombatAnimations();
            if (Result != GameResult.Ongoing) return;

            SetPhase(Phase.End);
            DoEndPhase();
            if (Result != GameResult.Ongoing) return;

            // передача хода
            Emit(new GameEvent { Type = GameEventType.TurnEnded, Side = ActiveSide, Turn = Turn });
            ActiveSide = OpponentSide;
            Emit(new GameEvent { Type = GameEventType.TurnStarted, Side = ActiveSide, Turn = Turn + 1 });
        }

        /* ----------------------------- БИТВА ------------------------------------ */

        /// <summary>
        /// Очередь атак фазы «Битва». UI-контроллер читает её ПОСЛЕ синхронного
        /// исполнения боя и проигрывает анимации в правильном порядке (ТЗ п.6.2).
        /// Каждый элемент хранит состояние атакующего и защитника ДО удара —
        /// этого достаточно, чтобы корректно показать полёт, тряску и числа урона.
        /// </summary>
        public readonly List<AttackRecord> AttackQueue = new();

        /// <summary>
        /// Хок проигрывания анимаций после фазы «Битва» (в HTML-прототипе — async).
        /// Движок остаётся синхронным и детерминированным: бой уже разрешён,
        /// представление лишь показывает очередь последовательно. В headless не задан.
        /// </summary>
        public Func<List<AttackRecord>, object?>? OnBeforeCombatEnd;

        private void RunCombatAnimations()
        {
            if (OnBeforeCombatEnd == null) return;
            var q = new List<AttackRecord>(AttackQueue);
            AttackQueue.Clear();

            // в C# представление либо играет очередь сразу (синхронно), либо
            // возвращает задачу/корутину; флаг Animating повторяет контракт TS
            var r = OnBeforeCombatEnd(q);
            if (r != null)
            {
                Animating = true;
                if (r is System.Threading.Tasks.Task task)
                    task.ContinueWith(_ => Animating = false);
                else
                    Animating = false;
            }
        }

        /* --- 4. БИТВА --- */

        private void DoCombatPhase()
        {
            AttackQueue.Clear();
            var side = ActiveSide;
            var pl = P(side);
            var en = P(side.Other());

            // пассивка Терраморфов: первые N ходов нельзя атаковать (ТЗ: 3)
            int peace = TerramorphPeaceTurns(side);
            if (peace > 0 && TurnsTaken[(int)side] <= peace)
            {
                Say($"Корни земли: Терраморфы не могут атаковать в первые {peace} ход(а)", side);
                return;
            }

            var attackers = new List<EntityCreature>();
            foreach (var c in pl.Creatures) if (CanAttack(c)) attackers.Add(c);

            // порядок атаки: по убыванию атаки, при равенстве — по uid
            attackers.Sort((a, b) =>
            {
                int d = b.Attack.CompareTo(a.Attack);
                return d != 0 ? d : a.Uid.CompareTo(b.Uid);
            });

            foreach (var atk in attackers)
            {
                if (Result != GameResult.Ongoing) return;
                int maxAttacks = atk.Keywords.Contains(Keyword.Windfury) ? 2 : 1;

                for (int i = 0; i < maxAttacks; i++)
                {
                    if (!CanAttack(atk) || !pl.Creatures.Contains(atk)) break;

                    var target = ChooseAutoTarget(side, atk);
                    ResolveAttack(atk, target.Creature, target.HitHero ? en : null);
                    atk.AttacksThisTurn++;
                    CheckDeaths();
                    if (Result != GameResult.Ongoing) return;
                }
            }
        }

        /// <summary>
        /// Авто-выбор цели (ТЗ п.2.2, фаза «Битва»):
        ///  1) у противника есть существа с Провокацией → бьём то, у кого меньше здоровья;
        ///  2) иначе → существо с наименьшим здоровьем (неуловимые игнорируются);
        ///  3) существ нет (или все неуловимы) → атака героя.
        /// </summary>
        public AutoTarget ChooseAutoTarget(Side side, EntityCreature attacker)
        {
            var en = P(side.Other());

            var candidates = new List<EntityCreature>();
            foreach (var c in en.Creatures)
                if (!c.UnblockableThisTurn && !c.Keywords.Contains(Keyword.Unblockable))
                    candidates.Add(c);

            if (candidates.Count == 0) return new AutoTarget { HitHero = true };

            var taunts = new List<EntityCreature>();
            foreach (var c in candidates)
                if (!c.Silenced && c.Keywords.Contains(Keyword.Taunt)) taunts.Add(c);

            var pool = taunts.Count > 0 ? taunts : candidates;
            pool.Sort((a, b) =>
            {
                int d = a.Health.CompareTo(b.Health);
                if (d != 0) return d;
                d = a.Attack.CompareTo(b.Attack);
                return d != 0 ? d : a.Uid.CompareTo(b.Uid);
            });

            return new AutoTarget { Creature = pool[0], HitHero = false };
        }

        /// <summary>
        /// Разрешить одну атаку: урон защитнику, ответный урон, вампиризм,
        /// запись в очередь анимаций. Прорыв при прямой атаке героя не нужен.
        /// </summary>
        public void ResolveAttack(EntityCreature attacker, EntityCreature? defender, PlayerState? enemyHero)
        {
            var rec = new AttackRecord
            {
                AttackerUid = attacker.Uid,
                AttackerSide = attacker.Owner,
                AttackerName = attacker.Name,
                DefenderUid = defender?.Uid,
                DefenderName = defender?.Name,
                HitHero = enemyHero != null,
                AttackerHpBefore = attacker.Health,
                DefenderHpBefore = defender?.Health ?? 0,
                HeroDamage = 0,
                DefenderDamage = 0,
                AttackerDamage = 0,
            };

            if (attacker.Attack <= 0) return;

            rec.AttackerSide = attacker.Owner;
            var ownerSide = attacker.Owner;
            int attackerBeforeHp = attacker.Health;
            bool lifesteal = !attacker.Silenced && attacker.Keywords.Contains(Keyword.Lifesteal);

            if (defender != null)
            {
                Emit(new GameEvent
                {
                    Type = GameEventType.CreatureAttacks,
                    Uid = attacker.Uid,
                    Side = ownerSide,
                    TargetUid = defender.Uid,
                    CardName = attacker.Name,
                    Value = attacker.Attack,
                    Text = $"«{attacker.Name}» атакует «{defender.Name}»",
                });

                int counter = defender.Attack;
                int defHpBefore = defender.Health;
                int dealt = DamageCreature(defender, attacker.Attack, new DamageOptions
                {
                    Source = attacker.Name,
                    SourceCardId = attacker.CardId,
                });
                if (dealt > 0 && lifesteal) HealHero(ownerSide, dealt, "Вампиризм");
                // v2.12.2: Ядовитый / Ледяное касание
                if (dealt > 0 && !attacker.Silenced && defender.Health > 0)
                {
                    if (attacker.Keywords.Contains(Keyword.Poisonous))
                    {
                        AddStatus(defender, new StatusInstance { Type = StatusType.Poison, Value = 1, TurnsLeft = -1 });
                        Say($"Ядовитый: «{defender.Name}» отравлен «{attacker.Name}»", defender.Owner);
                    }
                    if (attacker.Keywords.Contains(Keyword.Freezing))
                    {
                        AddStatus(defender, new StatusInstance { Type = StatusType.Freeze, Value = 1, TurnsLeft = 1 });
                        defender.Frozen = true;
                        Say($"Ледяное касание: «{defender.Name}» заморожен", defender.Owner);
                    }
                }

                if (counter > 0 && _uidMap.ContainsKey(attacker.Uid))
                    DamageCreature(attacker, counter, new DamageOptions
                    {
                        Source = defender.Name,
                        SourceCardId = defender.CardId,
                    });

                if (dealt > 0 && defender.Health <= 0) Stats[(int)ownerSide].Kills++;

                rec.DefenderDamage = dealt;
                rec.AttackerDamage = Math.Max(0, attackerBeforeHp - attacker.Health);
                rec.DefenderHpAfter = Math.Max(0, defender.Health);
                rec.AttackerHpAfter = Math.Max(0, attacker.Health);
                AttackQueue.Add(rec);
            }
            else if (enemyHero != null)
            {
                int dmg = attacker.Attack;
                Emit(new GameEvent
                {
                    Type = GameEventType.CreatureAttacks,
                    Uid = attacker.Uid,
                    Side = ownerSide,
                    CardName = attacker.Name,
                    Value = dmg,
                    Text = $"«{attacker.Name}» атакует героя {enemyHero.Name}",
                });

                int dealt = DamageHero(enemyHero.Side, dmg, new DamageOptions
                {
                    Source = attacker.Name,
                    SourceCardId = attacker.CardId,
                    LifestealFor = lifesteal ? ownerSide : null,
                });

                rec.HeroDamage = dealt;
                rec.AttackerHpAfter = Math.Max(0, attacker.Health);
                AttackQueue.Add(rec);
            }
        }

        /// <summary>Ручная атака (режим manual — для PvP и расширений).</summary>
        public bool ManualAttack(Side side, int uid, int? targetUid = null, bool targetHero = false)
        {
            if (Config.CombatMode != "manual") return false;

            var c = FindCreature(uid);
            if (c == null || c.Owner != side || !CanAttack(c)) return false;

            var en = P(side.Other());
            if (targetHero)
            {
                ResolveAttack(c, null, en);
                c.AttacksThisTurn++;
                CheckDeaths();
                return true;
            }

            var t = targetUid.HasValue ? FindCreature(targetUid.Value) : null;
            if (t == null || t.Owner == side) return false;

            ResolveAttack(c, t, null);
            c.AttacksThisTurn++;
            CheckDeaths();
            return true;
        }

        /// <summary>
        /// Универсальный исполнитель действия (его зовут ИИ и UI-контроллер).
        /// true — действие принято и изменило состояние.
        /// </summary>
        public bool ApplyAction(GameAction action, Side side)
        {
            switch (action.Type)
            {
                case GameAction.Types.PlayCard:
                    return PlayCard(side, action.HandIndex, action.TargetUid, action.TargetSide);

                case GameAction.Types.UseEcho:
                    return UseEcho(side, action.TargetUid, action.TargetSide);

                case GameAction.Types.ManualAttack:
                    return ManualAttack(side, action.Uid ?? -1, action.TargetUid, action.TargetHero);

                case GameAction.Types.EndTurn:
                    if (Phase != Phase.Main || ActiveSide != side) return false;
                    FinishMainPhase();
                    return true;

                case GameAction.Types.MulliganKeep:
                    Mulligan(side, action.KeepIndices);
                    return true;

                case GameAction.Types.Activate:
                    return false;   // активируемые способности существ — расширение

                default:
                    return false;
            }
        }

        /* --- 5. КОНЕЦ --- */

        private void DoEndPhase()
        {
            var side = ActiveSide;
            var pl = P(side);

            // Эхо-очко, если за ход не разыграно ни одного ЗАКЛИНАНИЯ (ТЗ п.2.6)
            if (pl.SpellsCastThisTurn == 0)
            {
                pl.EchoPoints = Math.Min(Config.EchoPointsMax, pl.EchoPoints + 1);
                Stats[(int)side].EchoGained++;
                Emit(new GameEvent
                {
                    Type = GameEventType.EchoGained,
                    Side = side,
                    Text = $"{pl.Name} получает Эхо-очко (всего {pl.EchoPoints})",
                });
                Say($"{pl.Name}: Эхо-очко получено (заклинаний не было)", side);
            }

            // истечение временных эффектов
            foreach (var c in new List<EntityCreature>(pl.Creatures))
            {
                foreach (var s in new List<StatusInstance>(c.Statuses))
                {
                    if (s.TurnsLeft <= 0) continue;
                    s.TurnsLeft--;
                    if (s.TurnsLeft > 0) continue;

                    RemoveStatus(c, s);
                    Emit(new GameEvent
                    {
                        Type = GameEventType.StatusExpired,
                        Uid = c.Uid,
                        Side = side,
                        CardName = c.Name,
                        Text = $"«{c.Name}»: {GameText.StatusRu(s.Type)} рассеивается",
                    });
                }

                // заморозка снимается в конце хода владельца
                c.Frozen = false;
                foreach (var s in c.Statuses) if (s.Type == StatusType.Freeze) { c.Frozen = true; break; }
                c.AttacksThisTurn = 0;
                c.UnblockableThisTurn = false;

                if (!c.Silenced && c.Data.OnTurnEnd is { Count: > 0 } ote)
                    RunEffects(ote, side, new EffectContext { SourceUid = c.Uid, SourceCard = c.Data });
            }

            // срок жизни рун
            foreach (var r in new List<EntityRune>(pl.Runes))
            {
                if (r.TurnsLeft <= 0) continue;
                r.TurnsLeft--;
                if (r.TurnsLeft > 0) continue;

                pl.Runes.Remove(r);
                pl.Graveyard.Add(r.CardId);
                Emit(new GameEvent
                {
                    Type = GameEventType.RuneExpired,
                    Side = side,
                    CardId = r.CardId,
                    CardName = r.Name,
                    Text = $"Руна «{r.Name}» угасает",
                });
            }

            // сброс временных модификаторов героя
            pl.IncomingDamageReductionTurns = 0;

            CheckDeaths();

            if (pl.Deck.Count == 0)
                Say($"{pl.Name}: колода пуста, следующий добор нанесёт урон", side);
        }

        private void EndGame(GameResult result)
        {
            if (Result != GameResult.Ongoing) return;
            Result = result;
            Emit(new GameEvent { Type = GameEventType.GameOver, Result = result, Text = GameText.ResultText(result) });
        }

        /// <summary>Предохранитель: партия длиннее MaxTurns заканчивается ничьей.</summary>
        public void ForceDrawCheck()
        {
            if (Turn > Config.MaxTurns && Result == GameResult.Ongoing) EndGame(GameResult.Draw);
        }

        /// <summary>
        /// Принудительная ничья без события GameOver — ровно как
        /// <c>e.result = GameResult.Draw</c> в MatchRunner (match.ts).
        /// Нужен оркестратору матча как второй предохранитель после ForceDrawCheck.
        /// </summary>
        public void ForceDraw() => Result = GameResult.Draw;

        /* ----------------------------- СНИМОК ----------------------------------- */

        /// <summary>
        /// Снимок состояния — для ИИ (minimax), отладки и headless-отчётов.
        /// Форма повторяет engine.ts → snapshot().
        /// </summary>
        public GameSnapshot Snapshot()
        {
            var snap = new GameSnapshot
            {
                Turn = Turn,
                ActiveSide = ActiveSide,
                Phase = Phase,
                Result = Result,
            };

            foreach (var pl in Players)
            {
                var sp = new SnapshotPlayer
                {
                    Side = pl.Side,
                    Name = pl.Name,
                    Faction = pl.Faction,
                    Health = pl.Health,
                    Mana = pl.Mana,
                    MaxMana = pl.MaxMana + pl.BonusMana,
                    Hand = pl.Hand.Count,
                    Deck = pl.Deck.Count,
                    Graveyard = pl.Graveyard.Count,
                    Echo = pl.EchoPoints,
                    EchoUsed = pl.EchoUsedThisGame,
                };

                foreach (var c in pl.Creatures)
                {
                    var sc = new SnapshotCreature { Uid = c.Uid, Name = c.Name, Attack = c.Attack, Health = c.Health };
                    foreach (var s in c.Statuses) sc.Statuses.Add(s.Type);
                    sp.Creatures.Add(sc);
                }
                foreach (var r in pl.Runes) sp.Runes.Add(new SnapshotRune { Name = r.Name, TurnsLeft = r.TurnsLeft });
                foreach (var r in pl.Rituals) sp.Rituals.Add(new SnapshotRitual { Name = r.Name, TurnsLeft = r.TurnsLeft });

                snap.Players.Add(sp);
            }
            return snap;
        }
    }
}
