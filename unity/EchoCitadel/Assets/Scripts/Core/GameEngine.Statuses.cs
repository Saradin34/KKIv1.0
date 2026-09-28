/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#), GameEngine, ЧАСТЬ 2.
   Статусы, смерти, предсмертные хрипы, пассивки Некрусов,
   возможность атаки, руны и ритуалы.
   ---------------------------------------------------------------------
   Порт src/engine/engine.ts, строки ~473–610. Порядок вызовов ГПСЧ и
   обхода списков повторяет TS — иначе партии разъезжаются.
   ===================================================================== */

using System;
using System.Collections.Generic;

namespace EchoCitadel.Core
{
    using EchoCitadel.Data;

    public sealed partial class GameEngine
    {
        /* ----------------------------- СМЕРТИ ---------------------------------- */

        /// <summary>Отметить существо как умирающее (разрешится в CheckDeaths).</summary>
        private void MarkDeath(EntityCreature c)
        {
            if (_pendingDeaths.Contains(c)) return;
            _pendingDeaths.Add(c);
        }

        /// <summary>
        /// Проверка состояний (state-based): убираем мёртвых, триггерим предсмертные
        /// хрипы и пассивку Некрусов. Цикл повторяется, пока хрипы порождают новые смерти.
        /// </summary>
        public void CheckDeaths()
        {
            if (_depth > 32) return;   // защита от бесконечной рекурсии
            int guard = 0;

            while (_pendingDeaths.Count > 0 && guard++ < 200)
            {
                var dying = new List<EntityCreature>(_pendingDeaths);
                _pendingDeaths.Clear();

                foreach (var c in dying)
                {
                    if (c.Health > 0) continue;
                    var owner = P(c.Owner);

                    int idx = owner.Creatures.IndexOf(c);
                    if (idx >= 0) owner.Creatures.RemoveAt(idx);
                    _uidMap.Remove(c.Uid);
                    owner.Graveyard.Add(c.CardId);
                    Stats[(int)c.Owner].Losses++;

                    Emit(new GameEvent
                    {
                        Type = GameEventType.CreatureDeath,
                        Uid = c.Uid,
                        Side = c.Owner,
                        CardId = c.CardId,
                        CardName = c.Name,
                        Text = $"«{c.Name}» погибает",
                    });
                    Say($"{owner.Name}: «{c.Name}» погибает", c.Owner);

                    // предсмертный хрип
                    if (!c.Silenced && c.Data.OnDeath is { Count: > 0 })
                    {
                        _depth++;
                        RunEffects(c.Data.OnDeath, c.Owner, new EffectContext
                        {
                            SourceUid = c.Uid,
                            SourceCard = c.Data,
                            IsDeathrattle = true,
                        });
                        _depth--;
                    }

                    // Пассивка Некрусов «Кровавая жатва» (редакция ТЗ п.2.5.2):
                    // +1 карта и +2 здоровья за смерть своего существа стоимостью ≥ 2.
                    // Порог нужен, иначе токены и «мелочь» дают бесконечный card advantage.
                    if (owner.Faction == Faction.Necrus)
                    {
                        int heal = Pround(2 * PassiveMul(Faction.Necrus));
                        bool drawsCard = c.Cost >= 2;
                        if (drawsCard) Draw(c.Owner, source: "Кровавая жатва");
                        if (heal > 0) HealHero(c.Owner, heal, "Кровавая жатва");
                        Say($"Кровавая жатва: {owner.Name} {(drawsCard ? "берёт карту и " : "")}восстанавливает {heal} здоровья", c.Owner);
                    }
                }

                // смерти, порождённые хрипами
                foreach (var c in AllCreatures()) if (c.Health <= 0) MarkDeath(c);
            }
        }

        /* ----------------------------- СТАТУСЫ --------------------------------- */

        /// <summary>
        /// Наложить статус. Одноимённые статусы не складываются: берётся максимум
        /// значения и максимум длительности, −1 («навсегда») поглощает всё.
        /// Немота снимает все статусы и ключевые слова.
        /// </summary>
        public void AddStatus(EntityCreature c, StatusInstance s)
        {
            if (c.Silenced && s.Type != StatusType.Silence) return;

            StatusInstance? existing = null;
            foreach (var x in c.Statuses) if (x.Type == s.Type) { existing = x; break; }

            if (existing != null)
            {
                existing.Value = Math.Max(existing.Value, s.Value);
                if (s.TurnsLeft == -1 || existing.TurnsLeft == -1) existing.TurnsLeft = -1;
                else existing.TurnsLeft = Math.Max(existing.TurnsLeft, s.TurnsLeft);
            }
            else
            {
                c.Statuses.Add(new StatusInstance
                {
                    Type = s.Type,
                    Value = s.Value,
                    TurnsLeft = s.TurnsLeft,
                    SourceCardId = s.SourceCardId,
                });
            }

            if (s.Type == StatusType.Freeze) c.Frozen = true;

            if (s.Type == StatusType.Silence)
            {
                c.Silenced = true;
                c.Frozen = false;
                c.Statuses.RemoveAll(x => x.Type != StatusType.Silence);
                c.Keywords.Clear();
                Emit(new GameEvent
                {
                    Type = GameEventType.CreatureSilenced,
                    Uid = c.Uid,
                    Side = c.Owner,
                    CardName = c.Name,
                    Text = $"«{c.Name}» под немотой",
                });
            }

            var activeStatus = c.FindStatus(s.Type);
            int shownValue = activeStatus?.Value ?? s.Value;
            Emit(new GameEvent
            {
                Type = GameEventType.StatusApplied,
                Uid = c.Uid,
                Side = c.Owner,
                CardName = c.Name,
                Value = shownValue,
                Data = new Dictionary<string, object>
                {
                    ["status"] = s.Type.ToString(),
                    ["turnsLeft"] = activeStatus?.TurnsLeft ?? s.TurnsLeft,
                },
                Text = $"«{c.Name}»: {GameText.StatusRu(s.Type)}{(shownValue > 1 ? $" ({shownValue})" : "")}",
            });
        }

        /// <summary>Снять конкретный экземпляр статуса.</summary>
        public void RemoveStatus(EntityCreature c, StatusInstance s)
        {
            int i = c.Statuses.IndexOf(s);
            if (i >= 0) c.Statuses.RemoveAt(i);
            if (s.Type == StatusType.Freeze) c.Frozen = HasStatusType(c, StatusType.Freeze);
        }

        /// <summary>Немота: перманентная (TurnsLeft = −1).</summary>
        public void Silence(EntityCreature c) =>
            AddStatus(c, new StatusInstance { Type = StatusType.Silence, Value = 1, TurnsLeft = -1 });

        private static bool HasStatusType(EntityCreature c, StatusType t)
        {
            foreach (var s in c.Statuses) if (s.Type == t) return true;
            return false;
        }

        /* ----------------------------- ВОЗМОЖНОСТЬ АТАКИ ------------------------ */

        /// <summary>
        /// Может ли существо атаковать сейчас. Немота отключает рывок и бурю,
        /// но не саму возможность атаковать (как в TS).
        /// </summary>
        public bool CanAttack(EntityCreature c)
        {
            if (c.Frozen) return false;
            if (c.Attack <= 0) return false;

            int maxAttacks = c.Keywords.Contains(Keyword.Windfury) ? 2 : 1;
            if (c.AttacksThisTurn >= maxAttacks) return false;

            if (c.JustPlayed && !c.Keywords.Contains(Keyword.Rush) && !HasStatusType(c, StatusType.Fury))
                return false;

            return true;
        }

        /* ----------------------------- РУНЫ / РИТУАЛЫ ---------------------------- */

        /// <summary>
        /// Установить руну (ТЗ п.2.4.3 — постоянная карта правил).
        /// Порядок: событие → onPlay → немедленный пересчёт аур → проверки смертей.
        /// </summary>
        public EntityRune PlayRune(Side side, CardData card)
        {
            var pl = P(side);
            var r = new EntityRune
            {
                Uid = NextUid(),
                CardId = card.Id,
                Owner = side,
                Name = card.Name,
                Faction = card.Faction,
                Element = card.Element,
                TurnsLeft = card.Duration ?? -1,
                Data = card,
                Silenced = false,
            };
            pl.Runes.Add(r);
            Stats[(int)side].RunesPlayed++;

            Emit(new GameEvent
            {
                Type = GameEventType.RunePlayed,
                Side = side,
                CardId = card.Id,
                CardName = card.Name,
                Text = $"{pl.Name} устанавливает руну «{card.Name}»",
            });
            Say($"{pl.Name}: руна «{card.Name}» вступает в силу", side);

            // руны с мгновенным эффектом при установке
            if (card.OnPlay is { Count: > 0 })
                RunEffects(card.OnPlay, side, new EffectContext { SourceCard = card, FromRune = true });

            // постоянные ауры сразу пересчитываются для уже стоящих существ
            if (card.Aura != null) ApplyAuraImmediate(side, card.Aura);

            CheckDeaths();
            return r;
        }

        /// <summary>
        /// Немедленное применение ауры к УЖЕ стоящим существам.
        /// Операции, которые считаются динамически (spellDamage, heroProtection,
        /// extraMana, extraCard), здесь намеренно не делают ничего.
        /// </summary>
        private void ApplyAuraImmediate(Side side, AuraDef aura)
        {
            var pl = P(side);
            var en = P(side.Other());

            bool Matches(EntityCreature c) =>
                aura.Matches == null || aura.Matches.Count == 0 || aura.Matches.Contains(c.Element);

            switch (aura.Op)
            {
                case AuraOp.buffAttackHealth:
                    foreach (var c in pl.Creatures)
                        if (Matches(c))
                        {
                            c.Attack += aura.Atk ?? 0;
                            c.Health += aura.Hp ?? 0;
                            c.MaxHealth += aura.Hp ?? 0;
                        }
                    break;

                case AuraOp.buffAttack:
                    foreach (var c in pl.Creatures)
                        if (Matches(c)) c.Attack += aura.Value ?? 0;
                    break;

                case AuraOp.buffHealth:
                    foreach (var c in pl.Creatures)
                        if (Matches(c))
                        {
                            c.Health += aura.Value ?? 0;
                            c.MaxHealth += aura.Value ?? 0;
                        }
                    break;

                case AuraOp.debuffAttackEnemy:
                    foreach (var c in en.Creatures)
                        if (Matches(c)) c.Attack = Math.Max(0, c.Attack - (aura.Value ?? 0));
                    break;

                case AuraOp.spellDamage:      break; // учитывается в SpellDamageOf()
                case AuraOp.heroProtection:   break; // учитывается в HeroDamageReduction()
                case AuraOp.healReduction:    break; // учитывается в HealReductionOn()
                case AuraOp.extraMana:        break; // учитывается в фазе Ресурсов
                case AuraOp.extraCard:        break; // учитывается в фазе Начала
                case AuraOp.drawOnResource:   break; // учитывается в фазе Ресурсов
            }
        }

        /// <summary>Отложить ритуал: разрешится в начале хода владельца через ritualDelay.</summary>
        public void PlaceRitual(Side side, CardData card, int? targetUid = null, Side? targetSide = null)
        {
            var pl = P(side);
            var r = new EntityRitual
            {
                Uid = NextUid(),
                CardId = card.Id,
                Owner = side,
                Name = card.Name,
                Faction = card.Faction,
                Element = card.Element,
                TurnsLeft = card.RitualDelay ?? 1,
                TargetUid = targetUid,
                TargetSide = targetSide,
                Data = card,
            };
            pl.Rituals.Add(r);

            Emit(new GameEvent
            {
                Type = GameEventType.RitualPlaced,
                Side = side,
                CardId = card.Id,
                CardName = card.Name,
                Text = $"{pl.Name} начинает ритуал «{card.Name}» (1 ход подготовки)",
            });
            Say($"{pl.Name}: ритуал «{card.Name}» готовится", side);
        }
    }
}
