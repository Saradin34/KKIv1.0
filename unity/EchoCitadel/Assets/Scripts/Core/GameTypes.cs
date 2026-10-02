/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   Ядро: контракты данных.
   ---------------------------------------------------------------------
   Порт 1-в-1 интерфейсов из src/engine/types.ts. Имена JSON-полей заданы
   атрибутом [JsonPropertyName], поэтому классы читают ТОТ ЖЕ Cards.json
   из StreamingAssets, что и TypeScript-движок и HTML-прототип:
   единая база карт на все три реализации.

   Правила изменения: сначала src/engine/types.ts, затем этот файл.
   ===================================================================== */

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace EchoCitadel.Core
{
    /* ------------------------- ДАННЫЕ КАРТЫ (JSON) ----------------------- */

    /// <summary>
    /// Атомарный эффект карты. Декларативный: движок исполняет, UI — рисует.
    /// </summary>
    public sealed class CardEffect
    {
        [JsonPropertyName("op")] public EffectOp Op { get; set; }

        /// <summary>Числовые параметры (урон, лечение, число карт, +атака, +здоровье…).</summary>
        [JsonPropertyName("value")] public int? Value { get; set; }

        /// <summary>К кому применяется (если не указано — берётся из target карты).</summary>
        [JsonPropertyName("to")] public TargetKind? To { get; set; }

        /// <summary>Фильтр цели («случайная», «с наибольшей атакой», «не более N»).</summary>
        [JsonPropertyName("filter")] public EffectFilter? Filter { get; set; }

        [JsonPropertyName("status")] public StatusType? Status { get; set; }
        [JsonPropertyName("statusValue")] public int? StatusValue { get; set; }
        [JsonPropertyName("element")] public Element? Element { get; set; }

        /// <summary>Вложенный эффект (для условных «если … то …»).</summary>
        [JsonPropertyName("then")] public CardEffect? Then { get; set; }

        /// <summary>Условие срабатывания.</summary>
        [JsonPropertyName("if")] public EffectCondition? If { get; set; }

        /// <summary>Число повторов.</summary>
        [JsonPropertyName("repeat")] public int? Repeat { get; set; }

        /// <summary>Токен для summonToken (встроен прямо в эффект в Cards.json).</summary>
        [JsonPropertyName("token")] public CardData? Token { get; set; }
    }

    /// <summary>Фильтр выбора целей эффекта.</summary>
    public sealed class EffectFilter
    {
        [JsonPropertyName("lowestHealth")] public bool? LowestHealth { get; set; }
        [JsonPropertyName("lowestAttack")] public bool? LowestAttack { get; set; }
        [JsonPropertyName("highestAttack")] public bool? HighestAttack { get; set; }
        [JsonPropertyName("highestHealth")] public bool? HighestHealth { get; set; }
        [JsonPropertyName("random")] public bool? Random { get; set; }
        [JsonPropertyName("count")] public int? Count { get; set; }
        [JsonPropertyName("attackAtLeast")] public int? AttackAtLeast { get; set; }
        [JsonPropertyName("attackAtMost")] public int? AttackAtMost { get; set; }
        [JsonPropertyName("costAtLeast")] public int? CostAtLeast { get; set; }
        [JsonPropertyName("isLegendary")] public bool? IsLegendary { get; set; }
        [JsonPropertyName("notSilenced")] public bool? NotSilenced { get; set; }
    }

    /// <summary>Условие срабатывания эффекта.</summary>
    public sealed class EffectCondition
    {
        [JsonPropertyName("heroHealthAtMost")] public int? HeroHealthAtMost { get; set; }
        [JsonPropertyName("heroHealthAtLeast")] public int? HeroHealthAtLeast { get; set; }
        [JsonPropertyName("enemyCreaturesAtLeast")] public int? EnemyCreaturesAtLeast { get; set; }
        [JsonPropertyName("friendlyCreaturesAtLeast")] public int? FriendlyCreaturesAtLeast { get; set; }
        [JsonPropertyName("handSizeAtMost")] public int? HandSizeAtMost { get; set; }
        [JsonPropertyName("handSizeAtLeast")] public int? HandSizeAtLeast { get; set; }
        [JsonPropertyName("turnAtLeast")] public int? TurnAtLeast { get; set; }
        [JsonPropertyName("hasRune")] public string? HasRune { get; set; }
        [JsonPropertyName("enemyHasRune")] public string? EnemyHasRune { get; set; }
        [JsonPropertyName("chance")] public double? Chance { get; set; }
    }

    /// <summary>
    /// Аура руны (или существа). Постоянный эффект, пока карта в игре.
    /// Ключи соответствуют полю "aura" в Cards.json.
    /// </summary>
    public sealed class AuraDef
    {
        [JsonPropertyName("op")] public AuraOp Op { get; set; }
        [JsonPropertyName("value")] public int? Value { get; set; }

        /// <summary>Для buffAttackHealth: прибавка к атаке.</summary>
        [JsonPropertyName("atk")] public int? Atk { get; set; }

        /// <summary>Для buffAttackHealth: прибавка к здоровью.</summary>
        [JsonPropertyName("hp")] public int? Hp { get; set; }

        /// <summary>
        /// Фильтр по стихиям для аур-баффов: если список непустой, аура действует
        /// только на существ перечисленных стихий (engine.ts → applyAuraToNewCreature).
        /// В текущей базе поле не заполнено, но движок его читает — порт обязан уметь.
        /// </summary>
        [JsonPropertyName("matches")] public List<Element>? Matches { get; set; }

        /// <summary>Для spellDamage: ограничить бонус одной стихией.</summary>
        [JsonPropertyName("element")] public Element? Element { get; set; }
    }

    /// <summary>Полное описание карты. Читается из Cards.json.</summary>
    public sealed class CardData
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("faction")] public Faction Faction { get; set; }
        [JsonPropertyName("type")] public CardType Type { get; set; }
        [JsonPropertyName("subtype")] public SpellSubtype? Subtype { get; set; }
        [JsonPropertyName("rarity")] public Rarity Rarity { get; set; }
        [JsonPropertyName("cost")] public int Cost { get; set; }
        [JsonPropertyName("attack")] public int? Attack { get; set; }
        [JsonPropertyName("health")] public int? Health { get; set; }
        [JsonPropertyName("element")] public Element Element { get; set; }

        [JsonPropertyName("keywords")] public List<Keyword> Keywords { get; set; } = new();

        /// <summary>Требуемая цель при розыгрыше.</summary>
        [JsonPropertyName("target")] public TargetKind Target { get; set; }

        [JsonPropertyName("effects")] public List<CardEffect> Effects { get; set; } = new();

        /* --- триггеры --- */
        [JsonPropertyName("onDeath")] public List<CardEffect>? OnDeath { get; set; }
        [JsonPropertyName("onTurnStart")] public List<CardEffect>? OnTurnStart { get; set; }
        [JsonPropertyName("onTurnEnd")] public List<CardEffect>? OnTurnEnd { get; set; }
        [JsonPropertyName("onDamageTaken")] public List<CardEffect>? OnDamageTaken { get; set; }
        [JsonPropertyName("onCreatureDies")] public List<CardEffect>? OnCreatureDies { get; set; }
        [JsonPropertyName("onSpellCast")] public List<CardEffect>? OnSpellCast { get; set; }

        /// <summary>Мгновенный эффект при установке руны (engine.ts → playRune).</summary>
        [JsonPropertyName("onPlay")] public List<CardEffect>? OnPlay { get; set; }

        /// <summary>Эффект руны в начале хода ПРОТИВНИКА (engine.ts → doStartPhase).</summary>
        [JsonPropertyName("onEnemyTurnStart")] public List<CardEffect>? OnEnemyTurnStart { get; set; }

        /* --- руны и ритуалы --- */
        [JsonPropertyName("aura")] public AuraDef? Aura { get; set; }
        [JsonPropertyName("runeLimit")] public int? RuneLimit { get; set; }

        /// <summary>Сколько ходов живёт руна (null = навсегда).</summary>
        [JsonPropertyName("duration")] public int? Duration { get; set; }

        /// <summary>Ходов подготовки ритуала (по умолчанию 1).</summary>
        [JsonPropertyName("ritualDelay")] public int? RitualDelay { get; set; }

        /// <summary>«Выжигание»: насколько снижено входящее лечение противника.</summary>
        [JsonPropertyName("healReduction")] public int? HealReduction { get; set; }

        /// <summary>Сила «Магия заклинаний +N» у существа (engine.ts читает ?? 1).</summary>
        [JsonPropertyName("spellDamageValue")] public int? SpellDamageValue { get; set; }

        /// <summary>Снижение урона герою от руны/существа (engine.ts → heroDamageReduction).</summary>
        [JsonPropertyName("heroProtection")] public int? HeroProtection { get; set; }

        /// <summary>Плоский бонус к урону заклинаний владельца (engine.ts → spellDamageOf).</summary>
        [JsonPropertyName("spellDamage")] public int? SpellDamage { get; set; }

        [JsonPropertyName("isToken")] public bool? IsToken { get; set; }

        /* --- представление --- */
        [JsonPropertyName("abilityText")] public string AbilityText { get; set; } = "";
        [JsonPropertyName("flavor")] public string Flavor { get; set; } = "";

        /// <summary>Путь относительно Resources, может содержать подпапку семейства: Cards/&lt;Faction&gt;/[Subfamily]/&lt;id&gt;.</summary>
        [JsonPropertyName("art")] public string? Art { get; set; }
        [JsonPropertyName("artworkPath")] public string? ArtworkPath { get; set; }
        [JsonPropertyName("artPrompt")] public string? ArtPrompt { get; set; }
        [JsonPropertyName("negativePrompt")] public string? NegativePrompt { get; set; }
        [JsonPropertyName("artSize")] public string? ArtSize { get; set; }
        [JsonPropertyName("tags")] public List<string>? Tags { get; set; }

        public bool HasKeyword(Keyword k) => Keywords != null && Keywords.Contains(k);
        public bool IsRitual => Type == CardType.Spell && Subtype == SpellSubtype.Ritual;
    }

    /* ------------------------- ФАЙЛЫ БАЗЫ (JSON) ------------------------- */

    /// <summary>Коэффициенты силы фракции из meta.factionCoefficients (docs/BALANCE_MODEL.md).</summary>
    public sealed class FactionCoefficients
    {
        [JsonPropertyName("bodyMul")] public double BodyMul { get; set; } = 1.0;
        [JsonPropertyName("spellMul")] public double SpellMul { get; set; } = 1.0;
        [JsonPropertyName("runeMul")] public double RuneMul { get; set; } = 1.0;
        [JsonPropertyName("passiveMul")] public double PassiveMul { get; set; } = 1.0;
    }

    public sealed class CardsFileMeta
    {
        [JsonPropertyName("game")] public string Game { get; set; } = "";
        [JsonPropertyName("version")] public string Version { get; set; } = "";
        [JsonPropertyName("generatedAt")] public string GeneratedAt { get; set; } = "";
        [JsonPropertyName("seed")] public long Seed { get; set; }
        [JsonPropertyName("totalCards")] public int TotalCards { get; set; }
        [JsonPropertyName("totalTokens")] public int TotalTokens { get; set; }
        [JsonPropertyName("balanceModel")] public string BalanceModel { get; set; } = "";

        [JsonPropertyName("factionCoefficients")]
        public Dictionary<string, FactionCoefficients> FactionCoefficients { get; set; } = new();
    }

    public sealed class CardsFile
    {
        [JsonPropertyName("meta")] public CardsFileMeta Meta { get; set; } = new();
        [JsonPropertyName("cards")] public List<CardData> Cards { get; set; } = new();
        [JsonPropertyName("tokens")] public List<CardData> Tokens { get; set; } = new();
    }

    public sealed class DeckEntry
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("faction")] public Faction Faction { get; set; }
        [JsonPropertyName("cards")] public List<string> Cards { get; set; } = new();
        [JsonPropertyName("format")] public string? Format { get; set; }
    }

    public sealed class DeckFileMeta
    {
        [JsonPropertyName("deckSize")] public int DeckSize { get; set; } = 30;
        [JsonPropertyName("starterDeckSize")] public int StarterDeckSize { get; set; } = 30;
        [JsonPropertyName("copyLimit")] public int CopyLimit { get; set; } = 4;
        [JsonPropertyName("legendaryCopyLimit")] public int LegendaryCopyLimit { get; set; } = 4;
    }

    public sealed class DeckFile
    {
        [JsonPropertyName("meta")] public DeckFileMeta Meta { get; set; } = new();
        [JsonPropertyName("decks")] public List<DeckEntry> Decks { get; set; } = new();
    }

    /* ---------------------------- СОСТОЯНИЕ ------------------------------ */

    /// <summary>Экземпляр статуса на существе.</summary>
    public sealed class StatusInstance
    {
        public StatusType Type { get; set; }

        /// <summary>Значение: заряды щита, урон горения и т. п.</summary>
        public int Value { get; set; }

        /// <summary>Оставшиеся ходы; −1 = навсегда (не истекает).</summary>
        public int TurnsLeft { get; set; } = -1;

        /// <summary>Карта-источник статуса (для статистики и VFX).</summary>
        public string? SourceCardId { get; set; }

        public StatusInstance() { }

        public StatusInstance(StatusType type, int value = 1, int turnsLeft = -1, string? sourceCardId = null)
        {
            Type = type;
            Value = value;
            TurnsLeft = turnsLeft;
            SourceCardId = sourceCardId;
        }

        public StatusInstance Clone() => new(Type, Value, TurnsLeft, SourceCardId);
    }

    /// <summary>Существо на доске.</summary>
    public sealed class EntityCreature
    {
        public int Uid;
        public string CardId = "";
        public Side Owner;
        public string Name = "";
        public Faction Faction;
        public int Attack;
        public int Health;
        public int MaxHealth;
        public int Cost;
        public Element Element;
        public List<Keyword> Keywords = new();
        public List<StatusInstance> Statuses = new();
        public int SummonedOnTurn;
        public int AttacksThisTurn;
        public bool Tapped; // remains through the opponent's turn; clears at the owner's Untap
        public bool CanAttackThisTurn;
        public bool Silenced;
        public bool Frozen;

        /// <summary>Болезнь призыва: существо сыграно в этом ходу.</summary>
        public bool JustPlayed;

        /// <summary>«Иллюзорная тень» Эфирных: не может быть целью авто-атаки в этот ход.</summary>
        public bool UnblockableThisTurn;

        public CardData Data = null!;

        public EntityCreature Clone()
        {
            var c = (EntityCreature)MemberwiseClone();
            c.Keywords = new List<Keyword>(Keywords);
            c.Statuses = Statuses.ConvertAll(s => s.Clone());
            return c;
        }

        public bool HasKeyword(Keyword k) => !Silenced && Keywords.Contains(k);

        public StatusInstance? FindStatus(StatusType t)
        {
            for (int i = 0; i < Statuses.Count; i++) if (Statuses[i].Type == t) return Statuses[i];
            return null;
        }
    }

    /// <summary>Руна на столе (ТЗ п.2.4.3: постоянная карта правил).</summary>
    public sealed class EntityRune
    {
        public int Uid;
        public string CardId = "";
        public Side Owner;
        public string Name = "";
        public Faction Faction;
        public Element Element;

        /// <summary>−1 = навсегда.</summary>
        public int TurnsLeft;

        public CardData Data = null!;
        public bool Silenced;

        public EntityRune Clone() => (EntityRune)MemberwiseClone();
    }

    /// <summary>Отложенный ритуал: разрешается в начале хода владельца.</summary>
    public sealed class EntityRitual
    {
        public int Uid;
        public string CardId = "";
        public Side Owner;
        public string Name = "";
        public Faction Faction;
        public Element Element;
        public int TurnsLeft;
        public int? TargetUid;
        public Side? TargetSide;
        public CardData Data = null!;

        public EntityRitual Clone() => (EntityRitual)MemberwiseClone();
    }

    /// <summary>Запись на LIFO-стеке мгновенных (порт engine.ts stack[]).</summary>
    public sealed class StackEntry
    {
        public Side Side;
        public CardData Card = null!;
        public int? TargetUid;
        public Side? TargetSide;
    }

    /// <summary>Последнее разыгранное заклинание — источник для Эха (ТЗ п.2.6).</summary>
    public sealed class LastSpellCast
    {
        public string CardId = "";
        public int? TargetUid;
        public Side? TargetSide;
    }

    /// <summary>Полное состояние игрока.</summary>
    public sealed class PlayerState
    {
        public Side Side;
        public string Name = "";
        public Faction Faction;
        public int Health;
        public int MaxHealth;
        public int Mana;
        public int MaxMana;

        /// <summary>Дополнительная мана от эффектов и рун.</summary>
        public int BonusMana;

        public List<string> Deck = new();      // cardId
        public List<string> Hand = new();      // cardId
        public List<string> Graveyard = new(); // cardId

        public List<EntityCreature> Creatures = new();
        public List<EntityRune> Runes = new();
        public List<EntityRitual> Rituals = new();

        public int EchoPoints;
        public int EchoUsedThisGame;
        public LastSpellCast? LastSpell;

        public int SpellsCastThisTurn;
        public int CardsPlayedThisTurn;
        public int FatigueCounter;

        /// <summary>Временное снижение входящего урона героя.</summary>
        public int DamageReduction;

        /// <summary>Бонус к урону заклинаний от существ и рун с SpellDamage.</summary>
        public int SpellDamageBonus;

        public bool MulliganUsed;
        public int IncomingDamageReductionTurns;

        /// <summary>Индекс соседнего игрока (0 ↔ 1).</summary>
        public Side OpponentSide => Side.Other();

        public PlayerState Clone()
        {
            var p = (PlayerState)MemberwiseClone();
            p.Deck = new List<string>(Deck);
            p.Hand = new List<string>(Hand);
            p.Graveyard = new List<string>(Graveyard);
            p.Creatures = Creatures.ConvertAll(c => c.Clone());
            p.Runes = Runes.ConvertAll(r => r.Clone());
            p.Rituals = Rituals.ConvertAll(r => r.Clone());
            if (LastSpell != null)
                p.LastSpell = new LastSpellCast { CardId = LastSpell.CardId, TargetUid = LastSpell.TargetUid, TargetSide = LastSpell.TargetSide };
            return p;
        }
    }

    /* --------------------------- КОНФИГУРАЦИЯ ---------------------------- */

    /// <summary>Параметры партии. Значения по умолчанию — ТЗ п.2.1–2.3.</summary>
    public sealed class GameConfig
    {
        public int DeckSize = 30;
        public int StartingHand = 5;
        public int MaxHand = 10;             // излишек сгорает
        public int HeroHealth = 30;
        public int MaxMana = 10;
        public int StartingMaxMana = 0;      // +1 в первой фазе Ресурсов → 1 мана на 1-м ходу
        public int MaxCreaturesPerSide = 7;
        public bool MulliganAllowed = true;  // одна пересдача за игру
        public int EchoPointsMax = 99;
        public int EchoUsagesPerGame = 1;    // ТЗ п.2.6: очко тратится один раз за игру
        public int FatigueDamageStep = 1;
        public string CombatMode = "auto";   // ТЗ: авто-бой; "manual" — для PvP/расширений
        public int MaxTurns = 200;           // предохранитель от бесконечных партий
        public int Seed = 1;

        /// <summary>
        /// Множители силы ПАССИВОК фракций (балансировочный слой, docs/BALANCE_MODEL.md).
        /// 1.0 = «как написано в ТЗ п.2.5». Подбираются решателем
        /// (tools/balance/solve_balance.ts) и вшиваются генератором в
        /// Cards.json → meta.factionCoefficients.
        /// </summary>
        public Dictionary<Faction, double> PassiveMul = new()
        {
            { Faction.Aurites, 1.0 },     // Божественный щит: заряды щита (редакция 2.5.1)
            { Faction.Necrus, 1.0 },      // Кровавая жатва: здоровье за смерть (2 × mul) (2.5.2)
            { Faction.Terramorph, 1.0 },  // Корни земли: доп. мана и «мирный» период (2.5.3)
            { Faction.Pyromancer, 1.0 },  // Пламя возмездия: бонус урона и самоурон (2.5.4)
            { Faction.Ethereal, 1.0 },    // Иллюзорная тень: шанс срабатывания (2.5.5)
        };

        public GameConfig Clone()
        {
            var c = (GameConfig)MemberwiseClone();
            c.PassiveMul = new Dictionary<Faction, double>(PassiveMul);
            return c;
        }

        public double Passive(Faction f) => PassiveMul.TryGetValue(f, out var v) ? v : 1.0;
    }

    /* ------------------------------ СОБЫТИЯ ------------------------------ */

    /// <summary>
    /// Событие движка. UI подписывается на поток и рисует; логика не зависит от подписчиков.
    /// </summary>
    public sealed class GameEvent
    {
        public GameEventType Type;
        public Side? Side;
        public int? Uid;
        public string? CardId;
        public string? CardName;
        public int? Value;
        public string? Text;
        public Phase? Phase;
        public int? Turn;
        public int? TargetUid;
        public Side? TargetSide;

        /// <summary>Карта-источник (для per-card статистики урона/лечения в автотестере).</summary>
        public string? SourceCardId;

        /// <summary>
        /// Стихия источника и флаг «урон нанесён заклинанием» — нужны слою представления,
        /// чтобы выбрать VFX (docs/VISUAL_STACK.md, раздел 6). На логику не влияют.
        /// </summary>
        public Element? SourceElement;
        public bool FromSpell;

        public GameResult? Result;

        /// <summary>
        /// Дополнительные числа для представления (в TS — поле data):
        ///   ManaChanged     → { max }
        ///   CreatureSummoned→ { attack, health }
        /// На логику не влияет.
        /// </summary>
        public Dictionary<string, object>? Data;
    }

    /// <summary>Подписки контроллера на события движка.</summary>
    public interface IGameHooks
    {
        void OnEvent(GameEvent e);
    }

    /// <summary>
    /// Запись одной атаки фазы «Битва». Движок просчитывает бой синхронно и складывает
    /// план сюда, а представление проигрывает его по одной атаке (docs/VISUAL_STACK.md,
    /// раздел «Архитектурный принцип»). В Unity это CombatPresenter + DOTween.
    /// </summary>
    public sealed class AttackRecord
    {
        public int AttackerUid;
        public Side AttackerSide;
        public string AttackerName = "";
        public int? DefenderUid;
        public string? DefenderName;
        public bool HitHero;

        /// <summary>Здоровье ДО удара — нужно, чтобы показать числа урона в правильном порядке.</summary>
        public int AttackerHpBefore;
        public int DefenderHpBefore;

        public int HeroDamage;
        public int DefenderDamage;
        public int AttackerDamage;
        public bool Lifesteal;
        public int LifestealAmount;

        public int AttackerHpAfter;
        public int DefenderHpAfter;
    }

    /// <summary>
    /// Статистика матча (ТЗ п.8.1: урон, лечение, карты, Эхо). Совпадает ПОЛЕ В ПОЛЕ с MatchStats из engine.ts —
    /// иначе отчёты баланса TS и C# нельзя сравнивать напрямую.
    /// </summary>
    public sealed class PlayerStats
    {
        public int CardsPlayed;
        public int SpellsCast;
        public int CreaturesSummoned;
        public int RunesPlayed;
        public int DamageDealt;
        public int DamageTaken;
        public int HealingDone;
        public int CardsDrawn;
        public int EchoGained;
        public int EchoUsed;
        public int ManaSpent;
        public int Kills;
        public int Losses;

        public PlayerStats Clone() => (PlayerStats)MemberwiseClone();
    }

    /// <summary>
    /// Снимок состояния — для ИИ (minimax глубина 2), отладки и headless-отчётов.
    /// Форма повторяет engine.ts → snapshot(): только числа и имена, без ссылок
    /// на живые объекты, поэтому снимок можно сериализовать и сравнивать с TS.
    /// </summary>
    public sealed class GameSnapshot
    {
        public int Turn;
        public Side ActiveSide;
        public Phase Phase;
        public GameResult Result;
        public List<SnapshotPlayer> Players = new();
    }

    /// <summary>Срез состояния одного игрока в снимке.</summary>
    public sealed class SnapshotPlayer
    {
        public Side Side;
        public string Name = "";
        public Faction Faction;
        public int Health;
        public int Mana;
        public int MaxMana;         // maxMana + bonusMana (как в TS)
        public int Hand;
        public int Deck;
        public int Graveyard;
        public int Echo;
        public int EchoUsed;
        public List<SnapshotCreature> Creatures = new();
        public List<SnapshotRune> Runes = new();
        public List<SnapshotRitual> Rituals = new();
    }

    public sealed class SnapshotCreature
    {
        public int Uid;
        public string Name = "";
        public int Attack;
        public int Health;
        public List<StatusType> Statuses = new();
    }

    public sealed class SnapshotRune { public string Name = ""; public int TurnsLeft; }

    public sealed class SnapshotRitual { public string Name = ""; public int TurnsLeft; }

    /// <summary>Действие, которое может совершить контроллер (человек или ИИ).</summary>
    public sealed class GameAction
    {
        /// <summary>Типы действий — ровно как в TS GameAction (см. ниже константы).</summary>
        public string Type = Types.EndTurn;

        /// <summary>Индекс карты в руке (playCard).</summary>
        public int HandIndex;

        public int? TargetUid;
        public Side? TargetSide;

        /// <summary>Существо-источник действия (manualAttack, activate).</summary>
        public int? Uid;

        /// <summary>Атаковать героя вместо существа (manualAttack).</summary>
        public bool TargetHero;

        /// <summary>Индексы карт, которые игрок оставляет при муллигане.</summary>
        public List<int> KeepIndices = new();

        /// <summary>Имена типов действий (совпадают со строками TS-дискриминатора).</summary>
        public static class Types
        {
            public const string PlayCard = "playCard";
            public const string UseEcho = "useEcho";
            public const string EndTurn = "endTurn";
            public const string MulliganKeep = "mulliganKeep";
            public const string Activate = "activate";
            public const string ManualAttack = "manualAttack";
        }

        public static GameAction EndTurn() => new() { Type = Types.EndTurn };

        public static GameAction PlayCard(int handIndex, int? targetUid = null, Side? targetSide = null) =>
            new() { Type = Types.PlayCard, HandIndex = handIndex, TargetUid = targetUid, TargetSide = targetSide };

        public static GameAction UseEcho(int? targetUid = null, Side? targetSide = null) =>
            new() { Type = Types.UseEcho, TargetUid = targetUid, TargetSide = targetSide };

        public static GameAction MulliganKeep(IEnumerable<int> keep) =>
            new() { Type = Types.MulliganKeep, KeepIndices = new List<int>(keep) };

        public static GameAction ManualAttack(int uid, int? targetUid = null, bool targetHero = false) =>
            new() { Type = Types.ManualAttack, Uid = uid, TargetUid = targetUid, TargetHero = targetHero };

        public static GameAction Activate(int uid) => new() { Type = Types.Activate, Uid = uid };
    }

    /// <summary>Действие с оценкой — результат работы ИИ (AI/AIController.cs).</summary>
    public sealed class ScoredAction
    {
        public GameAction Action = GameAction.EndTurn();
        public double Score;
        public string Label = "";
    }
}
