/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   Движок правил: GameEngine.
   ---------------------------------------------------------------------
   Порт src/engine/engine.ts. Чистая логика: ни UnityEngine, ни времени,
   ни потоков. Детерминирован: одинаковые (seed, колоды, политика ИИ) дают
   ИДЕНТИЧНУЮ партию — поэтому 10 000 матчей можно гонять headless и
   сверять с TypeScript-отчётами баланса.

   Правила порта (обязательны к соблюдению при правках):
     1. Порядок вызовов ГПСЧ не менять: любая перестановка rng.Next()
        разъезжает с TS на первом же матче.
     2. Порядок обхода списков (руны → существа, Player → Opponent)
        повторяет TS: от него зависят ауры и статистика.
     3. Все тексты событий — на русском, дословно из TS: их печатает
        журнал боя и по ним сверяются снапшоты.
     4. Округление дробных значений пассивок — только ProbabilisticRound.

   СОСТОЯНИЕ ПОРТА: ядро собрано (части 1–3) + догон v2.2:
     ✅ состояние, события, добор/муллиган, урон/лечение, ауры;
     ✅ статусы, смерти, runEffects, фазы, мана/Эхо, руны/ритуалы;
     ✅ розыгрыш карт, бой, снимок, ИИ-фолбэк;
     ✅ LIFO-стек мгновенных (StackPushed/StackResolved, interactiveStack);
     ✅ lookahead-ИИ («Мифический», CloneForLookahead).
   Headless-стенд: tools/csharp/verify.sh (маркер .engine-complete).
   ===================================================================== */

using System;
using System.Collections.Generic;

namespace EchoCitadel.Core
{
    using EchoCitadel.Data;

    /* --------------------------- ДЕЙСТВИЯ ИГРОКА --------------------------- */

    /// <summary>
    /// Подписки контроллера на события движка (TS: EngineHooks).
    /// В Unity реализация — слой представления: CombatPresenter, VfxDirector,
    /// журнал боя. Движок ничего не знает о подписчиках, кроме этого интерфейса.
    /// </summary>
    public sealed class EngineHooks
    {
        /// <summary>Вызывается на каждое событие (UI, лог, аналитика).</summary>
        public Action<GameEvent>? OnEvent;

        /// <summary>
        /// Ворота анимации. TS-версия возвращает Promise, который движок ждёт;
        /// в C# симуляция синхронная, поэтому представление либо играет очередь
        /// событий после хода (headless-режим), либо подписывается на OnEvent и
        /// ставит анимации в свою очередь. Хук оставлен для совместимости
        /// с поведением прототипа «движок не зависит от скорости отрисовки».
        /// </summary>
        public Func<GameEvent, bool>? WaitFor;
    }

    /// <summary>
    /// Параметры нанесения урона (в TS — объект opts с необязательными полями).
    /// Структура: не даёт забыть поле и не аллоцирует на каждый удар.
    /// </summary>
    public struct DamageOptions
    {
        /// <summary>Название источника для журнала («Усталость», «Вампиризм»…).</summary>
        public string? Source;

        /// <summary>Игнорировать снижение урона героя (усталость, часть эффектов).</summary>
        public bool IgnoreReduction;

        /// <summary>Кому лечить нанесённый урон (вампиризм).</summary>
        public Side? LifestealFor;

        /// <summary>Карта-источник: нужна для статистики по картам и для VFX.</summary>
        public string? SourceCardId;

        /// <summary>Пробить щит (игнорировать поглощение).</summary>
        public bool PierceShield;

        /// <summary>Урон нанесён заклинанием — флаг для слоя представления.</summary>
        public bool FromSpell;

        public static DamageOptions None => default;
    }

    /* ======================================================================= */

    /// <summary>
    /// Движок партии. Один экземпляр = один матч.
    /// </summary>
    public sealed partial class GameEngine
    {
        public readonly GameConfig Config;
        public readonly CardDatabase Db;
        public readonly Rng Rng;
        public readonly EngineHooks Hooks;

        /// <summary>Индексируется значением Side (Player = 0, Opponent = 1) — как в TS.</summary>
        public readonly PlayerState[] Players = new PlayerState[2];

        /// <summary>Глобальный номер хода.</summary>
        public int Turn;

        /// <summary>Сколько ходов сделал каждый игрок (для болезни призыва и ритуалов).</summary>
        public readonly int[] TurnsTaken = new int[2];

        public Side ActiveSide = Side.Player;
        public Phase Phase = Phase.Start;
        public GameResult Result = GameResult.Ongoing;

        /// <summary>Сторона, держащая приоритет в окне отклика (MTG: instant speed). TS: instantWindow.</summary>
        public Side? InstantWindow;

        /// <summary>true в живом бою с UI-окнами; false в симах — стек резолвится сразу. TS: interactiveStack.</summary>
        public bool InteractiveStack;

        /// <summary>LIFO-стек мгновенных заклинаний. TS: stack[].</summary>
        public readonly List<StackEntry> Stack = new();

        /// <summary>Журнал партии. TS держит не более 4000 записей — повторяем.</summary>
        public readonly List<GameEvent> Log = new();

        public readonly PlayerStats[] Stats = { new PlayerStats(), new PlayerStats() };

        private int _uidCounter = 1;
        private readonly List<GameEvent> _eventQueue = new();

        /// <summary>uid → существо: быстрый поиск по всем зонам.</summary>
        private readonly Dictionary<int, EntityCreature> _uidMap = new();

        /// <summary>Очередь смертей: разрешается после текущего эффекта (state-based).</summary>
        private readonly List<EntityCreature> _pendingDeaths = new();

        /// <summary>Глубина вложенности эффектов (защита от бесконечной рекурсии).</summary>
        private int _depth;

        /// <summary>Заклинание, чей урон разрешается прямо сейчас (для VFX-флага FromSpell).</summary>
        private CardData? _spellSourceCard;

        /// <summary>Флаг «идёт анимация» — UI блокирует ввод, движок не меняется.</summary>
        public bool Animating;

        public GameEngine(
            CardDatabase db,
            IReadOnlyList<string> deckA,
            IReadOnlyList<string> deckB,
            GameConfig? config = null,
            Faction? factionA = null,
            Faction? factionB = null,
            string? nameA = null,
            string? nameB = null,
            int? seed = null,
            EngineHooks? hooks = null)
        {
            // TS: { ...DEFAULT_CONFIG, ...opts.config, seed: opts.seed ?? config.seed ?? 1 }
            Config = config != null ? config.Clone() : new GameConfig();
            if (seed.HasValue) Config.Seed = seed.Value;
            Db = db;
            Rng = new Rng(Config.Seed);
            Hooks = hooks ?? new EngineHooks();

            Players[0] = MakePlayer(Side.Player, deckA, factionA ?? Faction.Aurites, nameA ?? "Игрок");
            Players[1] = MakePlayer(Side.Opponent, deckB, factionB ?? Faction.Necrus, nameB ?? "Противник");
        }

        /* ----------------------------- ИНИЦИАЛИЗАЦИЯ ----------------------------- */

        private PlayerState MakePlayer(Side side, IReadOnlyList<string> deckList, Faction faction, string name)
        {
            var pl = new PlayerState
            {
                Side = side,
                Name = name,
                Faction = faction,
                Health = Config.HeroHealth,
                MaxHealth = Config.HeroHealth,
                Mana = 0,
                MaxMana = Config.StartingMaxMana,
                BonusMana = 0,
                // колода перемешивается ОДИН раз при создании игрока:
                // порядок вызова ГПСЧ (Player, затем Opponent) фиксирован
                Deck = Rng.Shuffle(deckList),
                EchoPoints = 0,
                EchoUsedThisGame = 0,
                SpellsCastThisTurn = 0,
                CardsPlayedThisTurn = 0,
                FatigueCounter = 0,
                DamageReduction = 0,
                SpellDamageBonus = 0,
                MulliganUsed = false,
                IncomingDamageReductionTurns = 0,
            };
            return pl;
        }

        /// <summary>Раздача стартовой руки (по config.StartingHand каждому, молча).</summary>
        public void Setup()
        {
            Emit(new GameEvent { Type = GameEventType.GameStarted, Text = "Бой начался" });
            var sides = new[] { Side.Player, Side.Opponent };
            foreach (var side in sides)
                for (int i = 0; i < Config.StartingHand; i++)
                    Draw(side, silent: true);
        }

        /// <summary>
        /// Множитель силы пассивки фракции (балансировочный слой, docs/BALANCE_MODEL.md).
        /// 1.0 = «как написано в ТЗ п.2.5»; значения из meta.factionCoefficients.
        /// </summary>
        public double PassiveMul(Faction f)
        {
            double v = Config.Passive(f);
            return v >= 0 ? v : 1.0;
        }

        /// <summary>Вероятностное округление: 2.5 → 50% шанс 3, 50% шанс 2.</summary>
        private int Pround(double x) => ProbabilisticRound.Round(Rng, x);

        /* ----------------------------- ДОСТУП К СОСТОЯНИЮ ---------------------- */

        public Side OpponentSide => ActiveSide.Other();

        public PlayerState P(Side side) => Players[(int)side];

        public PlayerState Active() => Players[(int)ActiveSide];

        public PlayerState Enemy() => Players[(int)OpponentSide];

        /// <summary>
        /// Клон для 1-ply lookahead ИИ (порт ai.ts chooseBestAction).
        /// Карты (CardData) шарятся с оригиналом; существа/руны/ритуалы копируются.
        /// Сид клона = 7 — как в TS (`new GameEngine(..., { seed: 7 })`).
        /// </summary>
        public GameEngine CloneForLookahead()
        {
            var clone = new GameEngine(Db, Array.Empty<string>(), Array.Empty<string>(),
                Config, Players[0].Faction, Players[1].Faction,
                Players[0].Name, Players[1].Name, seed: 7);
            clone.Players[0] = Players[0].Clone();
            clone.Players[1] = Players[1].Clone();
            clone.Turn = Turn;
            clone.Phase = Phase;
            clone.Result = Result;
            clone.ActiveSide = ActiveSide;
            clone.TurnsTaken[0] = TurnsTaken[0];
            clone.TurnsTaken[1] = TurnsTaken[1];
            clone.InstantWindow = InstantWindow;
            clone.InteractiveStack = false;
            clone._uidCounter = _uidCounter;
            clone.RebuildUidMap();
            return clone;
        }

        internal void RebuildUidMap()
        {
            _uidMap.Clear();
            foreach (var pl in Players)
                foreach (var c in pl.Creatures)
                    _uidMap[c.Uid] = c;
        }

        private int NextUid() => _uidCounter++;

        /* ----------------------------- СОБЫТИЯ / ЛОГ ----------------------------- */

        /// <summary>
        /// Записать событие: в журнал, в очередь для представления и в хук.
        /// Turn/Phase подставляются, если вызывающий их не указал.
        /// </summary>
        public void Emit(GameEvent e)
        {
            e.Turn ??= Turn;
            e.Phase ??= Phase;
            Log.Add(e);
            if (Log.Count > 4000) Log.RemoveRange(0, 1000);
            _eventQueue.Add(e);
            Hooks.OnEvent?.Invoke(e);
        }

        /// <summary>Забрать накопившиеся события (представление играет их по очереди).</summary>
        public List<GameEvent> DrainEvents()
        {
            var q = new List<GameEvent>(_eventQueue);
            _eventQueue.Clear();
            return q;
        }

        /// <summary>Строка журнала (TS: say).</summary>
        private void Say(string text, Side? side = null) =>
            Emit(new GameEvent { Type = GameEventType.Log, Text = text, Side = side });

        /* ----------------------------- ДОБОР КАРТ ------------------------------- */

        /// <summary>
        /// Добрать карту. Пустая колода → усталость: урон растёт на FatigueDamageStep
        /// за каждый пропущенный добор и не снижается защитой героя.
        /// Полная рука → карта сгорает.
        /// </summary>
        public CardData? Draw(Side side, bool silent = false, string? source = null)
        {
            var pl = P(side);
            if (pl.Deck.Count == 0)
            {
                pl.FatigueCounter += Config.FatigueDamageStep;
                DamageHero(side, pl.FatigueCounter, new DamageOptions
                {
                    Source = "Усталость",
                    IgnoreReduction = true,
                });
                if (!silent) Say($"{pl.Name}: колода пуста — усталость {pl.FatigueCounter}", side);
                return null;
            }

            string cardId = pl.Deck[0];
            pl.Deck.RemoveAt(0);
            var card = Db.Get(cardId);

            if (pl.Hand.Count >= Config.MaxHand)
            {
                pl.Graveyard.Add(cardId);
                Emit(new GameEvent
                {
                    Type = GameEventType.CardBurned,
                    Side = side,
                    CardId = cardId,
                    CardName = card?.Name,
                    Text = $"{pl.Name}: карта «{card?.Name}» сгорела (рука полна)",
                });
                return null;
            }

            pl.Hand.Add(cardId);
            Stats[(int)side].CardsDrawn++;
            if (!silent)
                Emit(new GameEvent { Type = GameEventType.CardDrawn, Side = side, CardId = cardId, CardName = card?.Name });
            return card;
        }

        /// <summary>
        /// Муллиган: оставить указанные индексы, остальные — в колоду и перемешать,
        /// затем добрать столько же. Одна пересдача за игру (config.MulliganAllowed).
        /// </summary>
        public void Mulligan(Side side, IEnumerable<int> keepIndices)
        {
            var pl = P(side);
            if (!Config.MulliganAllowed || pl.MulliganUsed) return;

            var keep = new HashSet<int>();
            foreach (int i in keepIndices) keep.Add(Math.Max(0, Math.Min(pl.Hand.Count - 1, i)));

            var kept = new List<string>();
            var back = new List<string>();
            for (int i = 0; i < pl.Hand.Count; i++) (keep.Contains(i) ? kept : back).Add(pl.Hand[i]);

            pl.Hand = kept;
            pl.Deck.InsertRange(0, back);
            pl.Deck = Rng.Shuffle(pl.Deck);
            for (int i = 0; i < back.Count; i++) Draw(side, silent: true);
            pl.MulliganUsed = true;
            Say($"{pl.Name} совершает муллиган: заменено {back.Count} карт", side);
        }

        /* ----------------------------- УРОН / ЛЕЧЕНИЕ ---------------------------- */

        /// <summary>
        /// Урон герою. Учитывает снижение урона (руны-«защитники», статус героя),
        /// вампиризм, статистику и поражение при health ≤ 0.
        /// Возвращает фактически нанесённый урон.
        /// </summary>
        public int DamageHero(Side side, int amount, DamageOptions opts = default)
        {
            if (amount <= 0 || Result != GameResult.Ongoing) return 0;
            var pl = P(side);
            int dmg = amount;

            if (!opts.IgnoreReduction)
            {
                int rd = HeroDamageReduction(side);
                if (rd > 0) dmg = Math.Max(0, dmg - rd);
            }

            if (dmg <= 0)
            {
                Say($"{pl.Name}: урон поглощён защитой", side);
                return 0;
            }

            pl.Health -= dmg;
            Emit(new GameEvent
            {
                Type = GameEventType.PlayerDamage,
                Side = side,
                Value = dmg,
                SourceCardId = opts.SourceCardId,
                SourceElement = ElementOfCard(opts.SourceCardId),
                FromSpell = _spellSourceCard != null,
                Text = $"{pl.Name} получает {dmg} урона{(opts.Source != null ? $" ({opts.Source})" : "")}",
            });

            if (opts.LifestealFor.HasValue)
                HealHero(opts.LifestealFor.Value, dmg, "Вампиризм");

            // урон, полученный игроком, записывается в «нанесённый» противнику
            Stats[(int)(side == Side.Player ? Side.Opponent : Side.Player)].DamageDealt += dmg;
            Stats[(int)side].DamageTaken += dmg;

            if (pl.Health <= 0)
            {
                pl.Health = 0;
                Emit(new GameEvent { Type = GameEventType.PlayerDeath, Side = side, Text = $"{pl.Name} пал" });
                EndGame(side == Side.Player ? GameResult.OpponentWin : GameResult.PlayerWin);
            }
            return dmg;
        }

        /// <summary>
        /// Лечение героя. «Выжигание» Пиромантов снижает входящее лечение,
        /// но не ниже 1 (пол — как в TS).
        /// </summary>
        public int HealHero(Side side, int amount, string? source = null, string? sourceCardId = null)
        {
            var pl = P(side);
            if (amount <= 0) return 0;

            int red = HealReductionOn(side);
            int eff = red > 0 ? Math.Max(1, amount - red) : amount;
            int before = pl.Health;
            pl.Health = Math.Min(pl.MaxHealth, pl.Health + eff);
            int healed = pl.Health - before;

            if (healed > 0)
            {
                Emit(new GameEvent
                {
                    Type = GameEventType.PlayerHeal,
                    Side = side,
                    Value = healed,
                    SourceCardId = sourceCardId,
                    Text = $"{pl.Name} восстанавливает {healed} здоровья{(source != null ? $" ({source})" : "")}",
                });
                Stats[(int)side].HealingDone += healed;
            }
            return healed;
        }

        /// <summary>
        /// «Выжигание» — суммарное снижение входящего ЛЕЧЕНИЯ героя (механика Пиромантов).
        /// Складывается из аур рун и тел противника; немота отключает источник.
        /// </summary>
        public int HealReductionOn(Side side)
        {
            var en = P(side.Other());
            int red = 0;
            foreach (var r in en.Runes)
            {
                if (r.Silenced) continue;
                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.healReduction) red += aura.Value ?? 1;
                if (r.Data.HealReduction.HasValue) red += r.Data.HealReduction.Value;
            }
            foreach (var c in en.Creatures)
            {
                if (c.Silenced) continue;
                if (c.Data.HealReduction.HasValue) red += c.Data.HealReduction.Value;
            }
            return Math.Max(0, red);
        }

        /// <summary>Суммарное снижение урона героя (пассивка Ауритов-руны, ауры, баффы).</summary>
        public int HeroDamageReduction(Side side)
        {
            var pl = P(side);
            int rd = pl.DamageReduction;
            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                if (r.Data.HeroProtection.HasValue) rd += r.Data.HeroProtection.Value;
                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.heroProtection) rd += aura.Value ?? 0;
            }
            return Math.Max(0, rd);
        }

        /// <summary>
        /// Бонус к урону заклинаний (существа и руны со SpellDamage + пассивка Пиромантов).
        /// spellCost нужен для редакции ТЗ п.2.5.4: дорогие заклинания получают больший бонус,
        /// что в паре с платой «−1 здоровье за заклинание» делает спам дешёвых невыгодным.
        /// </summary>
        public int SpellDamageOf(Side side, Element element = Element.None, int? spellCost = null)
        {
            var pl = P(side);
            int bonus = pl.SpellDamageBonus;

            foreach (var c in pl.Creatures)
            {
                if (c.Silenced) continue;
                if (c.Keywords.Contains(Keyword.SpellDamage)) bonus += c.Data.SpellDamageValue ?? 1;
            }

            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                var aura = r.Data.Aura;
                if (aura != null && aura.Op == AuraOp.spellDamage)
                {
                    Element? onlyElem = aura.Element;
                    if (onlyElem == null || onlyElem == Element.None || onlyElem == element) bonus += aura.Value ?? 0;
                }
                if (r.Data.SpellDamage.HasValue) bonus += r.Data.SpellDamage.Value;
            }

            // Пассивка Пиромантов «Пламя возмездия» (редакция ТЗ п.2.5.4)
            if (pl.Faction == Faction.Pyromancer)
            {
                int tier = (spellCost ?? 1) >= 3 ? 2 : 1;
                bonus += Pround(tier * PassiveMul(Faction.Pyromancer));
            }
            return bonus;
        }

        /* ----------------------------- СУЩЕСТВА ---------------------------------- */

        /// <summary>Стихия карты-источника (для выбора VFX слоем представления).</summary>
        private Element? ElementOfCard(string? cardId) => cardId == null ? null : Db.Get(cardId)?.Element;

        public EntityCreature? FindCreature(int uid) => _uidMap.TryGetValue(uid, out var c) ? c : null;

        /// <summary>Все существа обеих сторон: сначала Player, затем Opponent (порядок TS).</summary>
        public List<EntityCreature> AllCreatures()
        {
            var all = new List<EntityCreature>(Players[0].Creatures.Count + Players[1].Creatures.Count);
            all.AddRange(Players[0].Creatures);
            all.AddRange(Players[1].Creatures);
            return all;
        }

        /// <summary>
        /// Призыв существа. Полный лимит поля (7) → карта уходит в сброс.
        /// Порядок шагов повторяет TS: ауры рун → пассивка Ауритов → события →
        /// боевой клич → проверка смертей.
        /// </summary>
        public EntityCreature? Summon(Side side, CardData card, bool fromHand = true)
        {
            var pl = P(side);
            if (pl.Creatures.Count >= Config.MaxCreaturesPerSide)
            {
                Say($"{pl.Name}: поле заполнено ({Config.MaxCreaturesPerSide} существ) — призыв отменён", side);
                pl.Graveyard.Add(card.Id);
                return null;
            }

            var c = new EntityCreature
            {
                Uid = NextUid(),
                CardId = card.Id,
                Owner = side,
                Name = card.Name,
                Faction = card.Faction,
                Attack = card.Attack ?? 0,
                Health = card.Health ?? 1,
                MaxHealth = card.Health ?? 1,
                Cost = card.Cost,
                Element = card.Element,
                Keywords = new List<Keyword>(card.Keywords),
                SummonedOnTurn = TurnsTaken[(int)side],
                AttacksThisTurn = 0,
                CanAttackThisTurn = false,
                Silenced = false,
                Frozen = false,
                JustPlayed = true,
                UnblockableThisTurn = false,
                Data = card,
            };

            // постоянные ауры уже стоящих рун применяются к новичку сразу
            ApplyAuraToNewCreature(side, c);
            pl.Creatures.Add(c);
            _uidMap[c.Uid] = c;
            Stats[(int)side].CreaturesSummoned++;

            // Пассивка Ауритов «Божественный щит» (редакция ТЗ п.2.5.1):
            // заряды = 1 + (стоимость ≥ 4 ? 1 : 0), но только для тел стоимостью ≥ 2.
            // Обоснование редакции: в авто-бою цель выбирается по наименьшему здоровью,
            // поэтому «щит всем» на дешёвых телах полностью обнуляет размен.
            if (pl.Faction == Faction.Aurites)
            {
                int b = 1 + (c.Cost >= 4 ? 1 : 0);
                int eligible = c.Cost >= 2 ? b : 0;
                int charges = Pround(eligible * PassiveMul(Faction.Aurites));
                if (charges > 0)
                {
                    AddStatus(c, new StatusInstance { Type = StatusType.Shield, Value = charges, TurnsLeft = -1 });
                    Say($"Божественный щит: «{c.Name}» под защитой ({charges})", side);
                }
            }

            // v2.12.2: Божественный щит как ключевое слово — входит со Щитом
            if (!c.Silenced && c.Keywords.Contains(Keyword.DivineShield))
            {
                AddStatus(c, new StatusInstance { Type = StatusType.Shield, Value = 1, TurnsLeft = -1 });
                Say($"Божественный щит: «{c.Name}» защищён", side);
            }

            Emit(new GameEvent
            {
                Type = GameEventType.CreatureSummoned,
                Side = side,
                Uid = c.Uid,
                CardId = c.CardId,
                CardName = c.Name,
                // TS кладёт сюда data: { attack, health } — представление рисует числа
                Data = new Dictionary<string, object> { ["attack"] = c.Attack, ["health"] = c.Health },
            });
            Say($"{pl.Name} призывает «{c.Name}» ({c.Attack}/{c.Health})", side);

            // боевой клич: эффекты карты при входе (кроме случая «не из руки»)
            if (!c.Silenced && card.Effects.Count > 0 && fromHand)
                RunEffects(card.Effects, side, new EffectContext
                {
                    SourceUid = c.Uid,
                    SourceCard = card,
                    IsBattlecry = true,
                });

            CheckDeaths();
            return c;
        }

        /// <summary>Постоянные ауры уже стоящих рун применяются к новичку.</summary>
        private void ApplyAuraToNewCreature(Side side, EntityCreature c)
        {
            var pl = P(side);
            foreach (var r in pl.Runes)
            {
                if (r.Silenced) continue;
                var aura = r.Data.Aura;
                if (aura == null) continue;
                if (aura.Op != AuraOp.buffAttackHealth && aura.Op != AuraOp.buffAttack && aura.Op != AuraOp.buffHealth)
                    continue;

                // matches: пустой/отсутствующий список = «все стихии»
                if (aura.Matches == null || aura.Matches.Count == 0 || aura.Matches.Contains(c.Element))
                {
                    switch (aura.Op)
                    {
                        case AuraOp.buffAttackHealth:
                            c.Attack += aura.Atk ?? 0;
                            c.Health += aura.Hp ?? 0;
                            c.MaxHealth += aura.Hp ?? 0;
                            break;
                        case AuraOp.buffAttack:
                            c.Attack += aura.Value ?? 0;
                            break;
                        case AuraOp.buffHealth:
                            c.Health += aura.Value ?? 0;
                            c.MaxHealth += aura.Value ?? 0;
                            break;
                    }
                }
            }
            // пассивная аура существ со SpellDamage учтена в SpellDamageOf()
        }

        /// <summary>
        /// Урон существу. Щит поглощает удар целиком (по заряду), яд делает любой урон
        /// смертельным, onDamageTaken срабатывает до отметки смерти.
        /// </summary>
        public int DamageCreature(EntityCreature c, int amount, DamageOptions opts = default)
        {
            if (amount <= 0 || !_uidMap.ContainsKey(c.Uid)) return 0;
            int dmg = amount;

            // щит поглощает первое повреждение
            var shield = FindStatusWithValue(c, StatusType.Shield);
            if (shield != null && !opts.PierceShield)
            {
                shield.Value -= 1;
                if (shield.Value <= 0) RemoveStatus(c, shield);
                Emit(new GameEvent
                {
                    Type = GameEventType.StatusExpired,
                    Uid = c.Uid,
                    Side = c.Owner,
                    Text = $"Щит «{c.Name}» поглотил {dmg} урона",
                });
                return 0;
            }

            // яд: любое повреждение убивает
            var poison = c.FindStatus(StatusType.Poison);
            if (poison != null && !c.Silenced) dmg = Math.Max(dmg, c.Health);

            c.Health -= dmg;
            Emit(new GameEvent
            {
                Type = GameEventType.CreatureDamaged,
                Uid = c.Uid,
                Side = c.Owner,
                Value = dmg,
                CardName = c.Name,
                SourceCardId = opts.SourceCardId,
                SourceElement = ElementOfCard(opts.SourceCardId),
                FromSpell = opts.FromSpell,
                Text = $"«{c.Name}» получает {dmg} урона ({c.Health}/{c.MaxHealth})",
            });

            if (c.Data.OnDamageTaken is { Count: > 0 } && !c.Silenced)
                RunEffects(c.Data.OnDamageTaken, c.Owner, new EffectContext { SourceUid = c.Uid, SourceCard = c.Data });

            if (c.Health <= 0) MarkDeath(c);
            return dmg;
        }

        /// <summary>Лечение существа (с учётом «Выжигания» владельца).</summary>
        public int HealCreature(EntityCreature c, int amount, string? sourceCardId = null)
        {
            if (amount <= 0) return 0;
            int red = HealReductionOn(c.Owner);
            int eff = red > 0 ? Math.Max(1, amount - red) : amount;
            int before = c.Health;
            c.Health = Math.Min(c.MaxHealth, c.Health + eff);
            int healed = c.Health - before;
            if (healed > 0)
                Emit(new GameEvent
                {
                    Type = GameEventType.CreatureHealed,
                    Uid = c.Uid,
                    Side = c.Owner,
                    Value = healed,
                    CardName = c.Name,
                    SourceCardId = sourceCardId,
                });
            return healed;
        }

        /// <summary>Щит ищется с положительным числом зарядов (TS: s.value > 0).</summary>
        private static StatusInstance? FindStatusWithValue(EntityCreature c, StatusType t)
        {
            foreach (var s in c.Statuses) if (s.Type == t && s.Value > 0) return s;
            return null;
        }
    }
}
