/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   Ядро: перечисления и текстовые константы.
   ---------------------------------------------------------------------
   Порт 1-в-1 файла src/engine/types.ts (TypeScript). Порядок элементов и
   значения совпадают, поэтому:
     • Cards.json / Decks.json из StreamingAssets читаются без изменений;
     • результаты симуляции C# и TS сверяются друг с другом
       (tools/csharp → проверка «движки эквивалентны»);
     • правила меняются СНАЧАЛА в types.ts, затем здесь (см. шапку types.ts).

   Соответствие файлов:
     src/engine/types.ts   → Core/GameEnums.cs + Core/GameTypes.cs + Core/Rng.cs
     src/engine/db.ts      → Data/CardDatabase.cs
     src/engine/engine.ts  → Core/GameEngine.cs
     src/engine/ai.ts      → AI/AIController.cs + AI/AIProfiles.cs
     src/engine/match.ts   → Core/MatchRunner.cs
   ===================================================================== */

namespace EchoCitadel.Core
{
    /* ------------------------------ ФРАКЦИИ ------------------------------ */

    /// <summary>Фракции (ТЗ п.2.5). Значения совпадают со строками в Cards.json.</summary>
    public enum Faction
    {
        Aurites,      // Ауриты  — Свет: защита, контроль, исцеление
        Necrus,       // Некрусы — Тьма: агрессия, жертвы, грабёж
        Terramorph,   // Терраморфы — Земля: рампа, большие тела
        Pyromancer,   // Пироманты — Огонь: прямой урон
        Ethereal,     // Эфирные — Воздух: контроль поля, кража, уклонение
        Neutral,      // Нейтральные
    }

    /* ------------------------------ ЭЛЕМЕНТЫ ----------------------------- */

    public enum Element { None, Fire, Water, Earth, Air, Chaos }

    /* ------------------------------ ТИПЫ КАРТ ---------------------------- */

    public enum CardType { Creature, Spell, Rune }

    public enum SpellSubtype
    {
        Instant = 0,   // мгновенное: сработало → в сброс
        Ritual = 1,    // ритуал: 1 ход подготовки, резолв в начале следующего хода
    }

    /// <summary>Редкость. Распределение ТЗ п.3.2: 60 / 25 / 10 / 5 %.</summary>
    public enum Rarity { Common, Uncommon, Rare, Epic, Legendary }

    /* ------------------------------ ФАЗЫ ХОДА ---------------------------- */

    /// <summary>Пять фаз хода (ТЗ п.2.2).</summary>
    public enum Phase
    {
        Start = 0,     // 1. Начало
        Resource = 1,  // 2. Ресурсы
        Main = 2,      // 3. Основная
        Combat = 3,    // 4. Битва
        End = 4,       // 5. Конец
    }

    /* ------------------------------ СТАТУСЫ ------------------------------ */

    public enum StatusType
    {
        Burn,     // Горение: N урона в начале хода владельца, стек −1
        Poison,   // Яд: любое полученное существом повреждение → смерть
        Freeze,   // Заморозка: не атакует, стек −1 в конце хода
        Shield,   // Щит: поглощает первое полученное повреждение (за заряд)
        Fury,     // Ярость: игнорирует болезнь призыва
        Silence,  // Немота: способности и статусы отключены (перманентно)
    }

    /* --------------------------- КЛЮЧЕВЫЕ СЛОВА -------------------------- */

    public enum Keyword
    {
        Taunt,        // Провокация: приоритетная цель авто-атаки
        Lifesteal,    // Вампиризм: урон лечит героя
        Deathrattle,  // Предсмертный хрип
        Battlecry,    // Боевой клич (при входе)
        Rush,         // Рывок: может атаковать в ход призыва
        Windfury,     // Буря: 2 атаки за ход
        Unblockable,  // Не может быть целью авто-атаки
        Trample,      // Прорыв: избыточный урон идёт в героя
        SpellDamage,  // +N к урону заклинаний владельца
        DivineShield, // Божественный щит: входит со Щитом (1 заряд)
        Poisonous,    // Ядовитый: при уроне накладывает Яд
        Freezing,     // Ледяное касание: замораживает цель на 1 ход
    }

    /* ------------------------------- ЦЕЛИ -------------------------------- */

    public enum TargetKind
    {
        None,
        EnemyCreature,
        FriendlyCreature,
        AnyCreature,
        EnemyHero,
        FriendlyHero,
        AnyHero,
        AllEnemies,
        AllFriendlies,
        AllCreatures,
    }

    /// <summary>Сторона. Численные значения важны: ими индексируется массив игроков.</summary>
    public enum Side { Player = 0, Opponent = 1 }

    /* ---------------------------- РЕЗУЛЬТАТ ------------------------------ */

    public enum GameResult { Ongoing, PlayerWin, OpponentWin, Draw }

    /* ------------------------ ОПЕРАЦИИ ЭФФЕКТОВ -------------------------- */

    /// <summary>
    /// Атомарные операции эффектов. Значения совпадают со строками поля "op"
    /// в Cards.json, поэтому JSON-десериализация даёт их напрямую.
    /// </summary>
    public enum EffectOp
    {
        damage,
        heal,
        draw,
        opponentDraw,
        destroyCreature,
        buffAttack,
        buffHealth,
        debuffAttack,
        debuffHealth,
        applyStatus,
        removeStatus,
        silence,
        returnToHand,
        stealCard,
        stealCreature,
        gainMana,
        gainMaxMana,
        summonToken,
        gainEcho,
        sacrifice,
        restoreHealthByAttack,
        damageAllEnemyCreatures,
        damageAllFriendlyCreatures,
        damageAllCreatures,
        healAllFriendlyCreatures,
        freezeAllEnemies,
        burnAllEnemies,
        shieldAllFriendlies,
        setAttack,
        copyLastSpell,
        mill,
        damageHeroes,
        reduceIncomingDamage,
        increaseSpellDamage,
    }

    /// <summary>Операции аур рун и существ (поле "aura.op" в Cards.json).</summary>
    public enum AuraOp
    {
        none,
        extraMana,            // +value к максимуму маны каждый ход
        extraCard,            // +value карт в фазу Ресурсов
        drawOnResource,       // добор в фазу Ресурсов
        heroProtection,       // снижение входящего урона героя на value
        spellDamage,          // +value к урону заклинаний (можно ограничить стихией)
        buffAttack,           // +value атаки своим существам
        buffHealth,           // +value здоровья своим существам
        buffAttackHealth,     // +atk/+hp своим существам
        debuffAttackEnemy,    // −value атаки существам противника
        healReduction,        // «Выжигание»: входящее лечение противника ниже на value
    }

    /* ---------------------------- ТИПЫ СОБЫТИЙ --------------------------- */

    public enum GameEventType
    {
        GameStarted,
        PhaseChanged,
        TurnStarted,
        TurnEnded,
        ManaChanged,
        CardDrawn,
        CardBurned,
        CardDiscarded,
        CardPlayed,
        CreatureSummoned,
        CreatureAttacks,
        CreatureDamaged,
        CreatureHealed,
        CreatureDeath,
        CreatureSilenced,
        CreatureBounced,
        CreatureStolen,
        StatusApplied,
        StatusExpired,
        SpellCast,
        SpellCopied,
        RitualPlaced,
        InstantWindow,
        InstantWindowClosed,
        StackPushed,
        StackResolved,
        RitualResolved,
        RunePlayed,
        RuneTick,
        RuneExpired,
        EchoGained,
        EchoSpent,
        PlayerDamage,
        PlayerHeal,
        PlayerDeath,
        CardStolen,
        GameOver,
        Log,
    }

    /* ------------------------- ТЕКСТОВЫЕ КОНСТАНТЫ ----------------------- */

    /// <summary>Русские названия и палитры — аналог PHASE_RU / FACTION_RU / FACTION_COLORS из TS.</summary>
    public static class GameText
    {
        public static readonly Phase[] PhaseOrder =
        {
            Phase.Start, Phase.Resource, Phase.Main, Phase.Combat, Phase.End,
        };

        public static string PhaseRu(Phase p) => p switch
        {
            Phase.Start => "Начало",
            Phase.Resource => "Ресурсы",
            Phase.Main => "Основная",
            Phase.Combat => "Битва",
            Phase.End => "Конец",
            _ => p.ToString(),
        };

        public static string FactionRu(Faction f) => f switch
        {
            Faction.Aurites => "Ауриты",
            Faction.Necrus => "Некрусы",
            Faction.Terramorph => "Терраморфы",
            Faction.Pyromancer => "Пироманты",
            Faction.Ethereal => "Эфирные",
            _ => "Нейтральные",
        };

        public static string KeywordRu(Keyword k) => k switch
        {
            Keyword.Taunt => "Провокация",
            Keyword.Lifesteal => "Вампиризм",
            Keyword.DivineShield => "Божественный щит",
            Keyword.Poisonous => "Ядовитый",
            Keyword.Freezing => "Ледяное касание",
            Keyword.Deathrattle => "Предсмертный хрип",
            Keyword.Battlecry => "Боевой клич",
            Keyword.Rush => "Рывок",
            Keyword.Windfury => "Буря",
            Keyword.Unblockable => "Неуловимость",
            Keyword.Trample => "Прорыв",
            Keyword.SpellDamage => "Урон заклинаний +1",
            _ => k.ToString(),
        };

        public static string StatusRu(StatusType s) => s switch
        {
            StatusType.Burn => "Горение",
            StatusType.Poison => "Яд",
            StatusType.Freeze => "Заморозка",
            StatusType.Shield => "Щит",
            StatusType.Fury => "Ярость",
            StatusType.Silence => "Немота",
            _ => s.ToString(),
        };

        /// <summary>Текст результата партии (resultText из engine.ts).</summary>
        public static string ResultText(GameResult r) => r switch
        {
            GameResult.PlayerWin => "Победа!",
            GameResult.OpponentWin => "Поражение",
            GameResult.Draw => "Ничья",
            _ => "Игра идёт",
        };

        /// <summary>Русское название редкости (rarityRu из engine.ts).</summary>
        public static string RarityRu(Rarity r) => r switch
        {
            Rarity.Common => "Обычная",
            Rarity.Uncommon => "Необычная",
            Rarity.Rare => "Редкая",
            Rarity.Epic => "Эпическая",
            _ => "Легендарная",
        };

        /// <summary>Палитра фракции (primary / secondary / accent) — как FACTION_COLORS в TS.</summary>
        public static (string primary, string secondary, string accent) FactionColors(Faction f) => f switch
        {
            Faction.Aurites => ("#f5d76e", "#ffffff", "#7ec8ff"),
            Faction.Necrus => ("#8e44ad", "#1a1020", "#e74c3c"),
            Faction.Terramorph => ("#4e8f3a", "#6b4a2b", "#e0a33e"),
            Faction.Pyromancer => ("#ff7a18", "#c0392b", "#ffd54a"),
            Faction.Ethereal => ("#3fd6c8", "#dfe7ee", "#ffffff"),
            _ => ("#9aa3ad", "#3a3f46", "#e6e9ee"),
        };

        /// <summary>Цвет редкости (RARITY_COLORS в TS) — рамка и фойл карты.</summary>
        public static string RarityColor(Rarity r) => r switch
        {
            Rarity.Common => "#cfd6dd",
            Rarity.Uncommon => "#3ecf7a",
            Rarity.Rare => "#4f9cf9",
            Rarity.Epic => "#b06cf0",
            _ => "#f5a623",
        };

        /// <summary>Сигил фракции для интерфейса (тот же набор, что в прототипе).</summary>
        public static string FactionSigil(Faction f) => f switch
        {
            Faction.Aurites => "✵",
            Faction.Necrus => "☠",
            Faction.Terramorph => "⛰",
            Faction.Pyromancer => "🜂",
            Faction.Ethereal => "☁",
            _ => "◈",
        };
    }

    /// <summary>Фракции, участвующие в балансировке (Neutral — служебная).</summary>
    public static class Factions
    {
        public static readonly Faction[] Playable =
        {
            Faction.Aurites, Faction.Necrus, Faction.Terramorph, Faction.Pyromancer, Faction.Ethereal,
        };

        public static Side Other(this Side s) => s == Side.Player ? Side.Opponent : Side.Player;
    }
}
