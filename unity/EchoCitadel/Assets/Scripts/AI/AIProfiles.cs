/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   ИИ: профили фракций (ТЗ раздел 5, п.5.2 «фракционный стиль»).
   ---------------------------------------------------------------------
   Порт AI_PROFILES из src/engine/ai.ts. Значения обязаны совпадать:
   от них зависит поведение противника и, следовательно, винрейты в
   автотестере баланса (ТЗ п.8.1).
   ===================================================================== */

using System.Collections.Generic;

namespace EchoCitadel.AI
{
    using EchoCitadel.Core;

    /// <summary>Настройки поведения ИИ для одной фракции.</summary>
    public sealed class AIProfile
    {
        public Faction Faction;

        /// <summary>0 — «новичок», 1 — «идеальный». Влияет на долю случайных ошибок.</summary>
        public double Skill = 0.75;

        /// <summary>Вероятность взять неоптимальное действие (ТЗ п.5.1 «допускает ошибки»).</summary>
        public double BlunderRate = 0.15;

        /// <summary>Насколько агрессивно идёт в лицо (0..1).</summary>
        public double Aggression = 0.5;

        /// <summary>Насколько ценит сохранение своих существ (0..1).</summary>
        public double SelfPreservation = 0.5;

        /// <summary>1-ply перебор топ-5 действий клоном движка («Мифический», skill ≥ 1).</summary>
        public bool Lookahead;

        public AIProfile() { }

        public AIProfile(Faction faction, double skill, double blunderRate, double aggression, double selfPreservation)
        {
            Faction = faction;
            Skill = skill;
            BlunderRate = blunderRate;
            Aggression = aggression;
            SelfPreservation = selfPreservation;
        }

        /// <summary>Копия с точечными правками (MatchRunner подмешивает настройки теста).</summary>
        public AIProfile Clone() => new(Faction, Skill, BlunderRate, Aggression, SelfPreservation);
    }

    /// <summary>Таблица профилей по фракциям — аналог AI_PROFILES из ai.ts.</summary>
    public static class AIProfiles
    {
        public static readonly Dictionary<Faction, AIProfile> Table = new()
        {
            // Ауриты: защита, контроль, исцеление
            { Faction.Aurites,    new AIProfile(Faction.Aurites,    0.80, 0.12, 0.35, 0.85) },
            // Некрусы: агрессия, жертвы (пассивка даёт карту и +2 HP за смерть)
            { Faction.Necrus,     new AIProfile(Faction.Necrus,     0.85, 0.10, 0.85, 0.30) },
            // Терраморфы: копить ману, выставлять дорогих
            { Faction.Terramorph, new AIProfile(Faction.Terramorph, 0.80, 0.12, 0.45, 0.70) },
            // Пироманты: максимум прямого урона
            { Faction.Pyromancer, new AIProfile(Faction.Pyromancer, 0.85, 0.10, 0.95, 0.35) },
            // Эфирные: кража и контроль стола
            { Faction.Ethereal,   new AIProfile(Faction.Ethereal,   0.90, 0.08, 0.55, 0.65) },
            // Нейтральный профиль — запасной (в базе 6 нейтральных карт)
            { Faction.Neutral,    new AIProfile(Faction.Neutral,    0.75, 0.15, 0.50, 0.50) },
        };

        /// <summary>Профиль фракции с откатом на нейтральный (TS: AI_PROFILES[f] ?? AI_PROFILES[Neutral]).</summary>
        public static AIProfile For(Faction f) =>
            Table.TryGetValue(f, out var p) ? p : Table[Faction.Neutral];
    }
}
