/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   Оркестрация матча и headless-симулятор (ТЗ раздел 8.1).
   ---------------------------------------------------------------------
   Порт src/engine/match.ts. MatchRunner — «склейка» движка и контроллеров
   (ИИ или человек), Simulator — прогон N матчей ИИ-против-ИИ со сбором
   статистики по картам и фракциям.

   Один и тот же код используется:
     • консольным автотестером баланса (tools/csharp → режим balance),
     • проверкой паритета C# ↔ TypeScript (режим parity),
     • Unity-обвязкой (MatchRunner зовётся из контроллера матча).

   ВАЖНО. Некоторые места TS-реализации выглядят странно (например, состав
   «колоды проигравшего»), но они влияют на агрегаты отчёта. Порт повторяет
   их ДОСЛОВНО — иначе винрейты и маргинальный вклад карт в C# и TS
   перестанут совпадать, и смысл перекрёстной проверки пропадает.
   Каждое такое место помечено комментарием «квирк TS».
   ===================================================================== */

using System;
using System.Collections.Generic;
using System.Linq;

namespace EchoCitadel.Core
{
    using EchoCitadel.AI;
    using EchoCitadel.Data;

    /* ------------------------------ ПАРАМЕТРЫ -------------------------------- */

    public sealed class MatchOptions
    {
        public GameConfig? Config;
        public int? Seed;

        /// <summary>Муллиган: какие индексы оставить (по умолчанию ИИ оставляет карты ≤ 3 маны).</summary>
        public Func<List<CardData>, List<int>>? MulliganPolicy;

        /// <summary>Ограничение итераций основной фазы (защита от зацикливания).</summary>
        public int? MaxActionsPerTurn;

        public bool Trace;
    }

    /// <summary>Одна запись «сторона разыграла карту» (для отчёта TimesPlayed).</summary>
    public readonly struct PlayedCard
    {
        public readonly Side Side;
        public readonly string CardId;
        public PlayedCard(Side side, string cardId) { Side = side; CardId = cardId; }
    }

    public sealed class MatchResult
    {
        public GameResult Result;
        public Side? Winner;
        public int Turns;
        public int LoserHealth;
        public int WinnerHealth;
        public PlayerStats[] Stats = { new(), new() };

        /// <summary>Какие карты были у победителя / проигравшего (кладбище + колода + рука).</summary>
        public List<string> WinnerDeck = new();
        public List<string> LoserDeck = new();

        public Faction WinnerFaction;
        public Faction LoserFaction;

        /// <summary>Какие карты реально были разыграны.</summary>
        public List<PlayedCard> PlayedCards = new();

        /// <summary>Вклад каждой карты в урон / лечение (колонки AvgDamage, AvgHeal отчёта).</summary>
        public Dictionary<string, int> CardDamage = new();
        public Dictionary<string, int> CardHeal = new();

        public List<string> Log = new();
    }

    /* ------------------------------ MATCH RUNNER ------------------------------ */

    /// <summary>Двигает партию от раздачи до результата, опрашивая контроллеры сторон.</summary>
    public sealed class MatchRunner
    {
        public readonly GameEngine Engine;
        public readonly AIController?[] Ai = new AIController?[2];

        private readonly List<PlayedCard> _played = new();
        private readonly Dictionary<string, int> _cardDamage = new();
        private readonly Dictionary<string, int> _cardHeal = new();
        private readonly Dictionary<string, int> _cardMana = new();

        public MatchRunner(
            CardDatabase db,
            IReadOnlyList<string> deckA,
            IReadOnlyList<string> deckB,
            Faction factionA,
            Faction factionB,
            MatchOptions? opts = null)
        {
            opts ??= new MatchOptions();

            var hooks = new EngineHooks
            {
                OnEvent = e =>
                {
                    if (e.Type == GameEventType.CardPlayed && e.CardId != null && e.Side.HasValue)
                    {
                        _played.Add(new PlayedCard(e.Side.Value, e.CardId));
                        _cardMana[e.CardId] = (_cardMana.TryGetValue(e.CardId, out var m) ? m : 0) + (e.Value ?? 0);
                    }

                    var src = e.SourceCardId;
                    if (src == null) return;

                    if (e.Type == GameEventType.PlayerDamage || e.Type == GameEventType.CreatureDamaged)
                        _cardDamage[src] = (_cardDamage.TryGetValue(src, out var d) ? d : 0) + (e.Value ?? 0);
                    else if (e.Type == GameEventType.PlayerHeal || e.Type == GameEventType.CreatureHealed)
                        _cardHeal[src] = (_cardHeal.TryGetValue(src, out var h) ? h : 0) + (e.Value ?? 0);
                },
            };

            Engine = new GameEngine(db, deckA, deckB,
                config: opts.Config,
                factionA: factionA,
                factionB: factionB,
                nameA: "Игрок",
                nameB: "Противник",
                seed: opts.Seed ?? 1,
                hooks: hooks);
        }

        /// <summary>Оба игрока — ИИ (профили берутся по фракциям).</summary>
        public void SetupAI(AIProfile? profileA = null, AIProfile? profileB = null)
        {
            var sides = new[] { Side.Player, Side.Opponent };
            var overrides = new[] { profileA, profileB };
            for (int i = 0; i < sides.Length; i++)
            {
                var side = sides[i];
                var fac = Engine.P(side).Faction;
                var p = AIProfiles.For(fac).Clone();
                var o = overrides[i];
                if (o != null)
                {
                    p.Skill = o.Skill;
                    p.BlunderRate = o.BlunderRate;
                    p.Aggression = o.Aggression;
                    p.SelfPreservation = o.SelfPreservation;
                    p.Lookahead = o.Lookahead;
                }
                if (p.Skill >= 1.0) p.Lookahead = true;
                Ai[(int)side] = new AIController(Engine, side, p);
            }
        }

        /// <summary>Муллиган по умолчанию: оставляем всё дешевле 4 маны (максимум 3 карты).</summary>
        public void RunMulligans(Func<List<CardData>, List<int>>? policy = null)
        {
            var sides = new[] { Side.Player, Side.Opponent };
            foreach (var side in sides)
            {
                var pl = Engine.P(side);
                var hand = new List<CardData>();
                foreach (var id in pl.Hand)
                {
                    var c = Engine.Db.Get(id);
                    if (c != null) hand.Add(c);
                }

                List<int> keep;
                if (policy != null) keep = policy(hand);
                else
                {
                    keep = new List<int>();
                    for (int i = 0; i < hand.Count; i++) if (hand[i].Cost <= 3) keep.Add(i);
                    keep = keep.Take(3).ToList();
                }
                Engine.Mulligan(side, keep);
            }
        }

        /// <summary>Прогон матча до конца.</summary>
        public MatchResult Run(MatchOptions? opts = null)
        {
            opts ??= new MatchOptions();
            var e = Engine;

            e.Setup();
            RunMulligans(opts.MulliganPolicy);

            int maxActions = opts.MaxActionsPerTurn ?? 30;
            int safety = 0;

            // первый ход — у игрока 0
            e.ActiveSide = Side.Player;
            e.Turn = 0;

            while (e.Result == GameResult.Ongoing && safety++ < 1000)
            {
                e.RunTurn();
                if (e.Result != GameResult.Ongoing) break;

                // основная фаза: действия контроллера
                var ai = Ai[(int)e.ActiveSide];
                if (ai == null)
                    throw new InvalidOperationException(
                        $"MatchRunner.Run(): для стороны {e.ActiveSide} не задан контроллер");

                int n = 0;
                while (e.Phase == Phase.Main && e.Result == GameResult.Ongoing && n++ < maxActions)
                {
                    var best = ai.ChooseBestAction();
                    if (best == null) break;

                    // «неидеальность» ИИ: иногда второе по ценности действие
                    if (e.Rng.Chance(ai.Profile.BlunderRate))
                    {
                        var alt = ai.ChooseSecondBest();
                        if (alt != null && alt.Action.Type != GameAction.Types.EndTurn && alt.Score > 0)
                        {
                            e.ApplyAction(alt.Action, e.ActiveSide);
                            continue;
                        }
                    }

                    if (best.Action.Type == GameAction.Types.EndTurn) { e.FinishMainPhase(); break; }
                    if (!e.ApplyAction(best.Action, e.ActiveSide)) { e.FinishMainPhase(); break; }
                }
                if (e.Phase == Phase.Main) e.FinishMainPhase();

                e.ForceDrawCheck();
                if (e.Turn > e.Config.MaxTurns) { e.ForceDraw(); break; }
            }

            var winner = e.Result == GameResult.PlayerWin ? Side.Player
                       : e.Result == GameResult.OpponentWin ? Side.Opponent
                       : (Side?)null;

            var loserSide = winner == Side.Player ? Side.Opponent : Side.Player;
            var p0 = e.P(Side.Player);
            var p1 = e.P(Side.Opponent);

            // квирк TS: wDeck — колода победителя, а lDeck ВСЕГДА колода Opponent.
            // При winner == Opponent «колода проигравшего» получается колодой самого
            // победителя; порт повторяет это дословно ради совпадения отчётов.
            var wDeck = winner == null ? p0.Deck : e.P(winner.Value).Deck;
            var lDeck = p1.Deck;

            var res = new MatchResult
            {
                Result = e.Result,
                Winner = winner,
                Turns = e.Turn,
                LoserHealth = winner == Side.Player ? p1.Health : p0.Health,
                WinnerHealth = winner == null ? 0 : e.P(winner.Value).Health,
                Stats = new[] { e.Stats[0], e.Stats[1] },
                WinnerFaction = winner == null ? Faction.Neutral : e.P(winner.Value).Faction,
                LoserFaction = winner == null ? Faction.Neutral : e.P(loserSide).Faction,
                PlayedCards = new List<PlayedCard>(_played),
                CardDamage = new Dictionary<string, int>(_cardDamage),
                CardHeal = new Dictionary<string, int>(_cardHeal),
            };

            if (winner != null)
            {
                var w = e.P(winner.Value);
                var l = e.P(loserSide);
                res.WinnerDeck = Concat(w.Graveyard, wDeck, w.Hand);
                // квирк TS: здесь берётся рука ПОБЕДИТЕЛЯ (p(winner).hand), а не проигравшего
                res.LoserDeck = Concat(l.Graveyard, lDeck, w.Hand);
            }

            res.Log = e.Log.Where(x => x.Type == GameEventType.Log && x.Text != null)
                           .Select(x => x.Text!).ToList();
            return res;
        }

        private static List<string> Concat(List<string> a, List<string> b, List<string> c)
        {
            var r = new List<string>(a.Count + b.Count + c.Count);
            r.AddRange(a); r.AddRange(b); r.AddRange(c);
            return r;
        }
    }

    /* ------------------------------ ОТЧЁТ СИМУЛЯЦИИ --------------------------- */

    /// <summary>Статистика одной карты за прогон (колонки отчёта card_power_report.csv).</summary>
    public sealed class CardStat
    {
        public string CardId = "";
        public string CardName = "";
        public Faction Faction;
        public CardType Type;
        public Rarity Rarity;
        public int Cost;

        public int TimesPlayed;         // сколько раз карта была РОЗЫГРАНА
        public int MatchesPresent;      // в скольких матчах карта лежала в колоде
        public int TimesInWinnerDeck;
        public int TimesInLoserDeck;
        public int Wins;
        public int Losses;
        public double WinRate;          // wins / matchesPresent

        /// <summary>
        /// МАРГИНАЛЬНЫЙ ВКЛАД карты (главная метрика для балансировки):
        ///   relativeWinRate = P(победа | карта разыграна) − P(победа | фракция).
        /// Ноль = карта ровно среднего уровня своей фракции.
        /// </summary>
        public double RelativeWinRate;

        public double WinRateWhenPlayed;
        public double FactionBaseWinRate;
        public double PlayRate;
        public double AvgDamage;
        public double AvgHeal;
        public double AvgMana;
        public bool NeedsBalance;
    }

    /// <summary>Статистика фракции (ТЗ п.10.8: винрейт обязан попасть в 45–55%).</summary>
    public sealed class FactionStat
    {
        public Faction Faction;
        public int Games;
        public int Wins;
        public int Losses;
        public double WinRate;
        public double AvgTurns;
        public double AvgDamage;
        public double AvgHeal;
        public double AvgCardsPlayed;
        public double AvgEchoUsed;
        public bool WithinTarget;   // 45–55% по ТЗ п.10.8
    }

    public sealed class SimulationReport
    {
        public int Matches;
        public int Seed;
        public double AvgTurns;
        public int Draws;
        public List<FactionStat> Factions = new();
        public List<CardStat> Cards = new();
        public List<CardStat> OutOfRange = new();
    }

    public sealed class SimulationOptions
    {
        public int Matches = 10000;
        public int BaseSeed = 12345;
        public Dictionary<string, List<string>>? Decks;
        public List<string>? DeckIds;
        public GameConfig? Config;

        /// <summary>Множители силы пассивок (tools/generator/faction_balance.json).</summary>
        public Dictionary<Faction, double>? PassiveMul;
    }

    /* ------------------------------ СИМУЛЯТОР --------------------------------- */

    public static class Simulator
    {
        private sealed class CardAgg
        {
            public int Played, Wins, Losses, InWin, InLose, Present;
            public int Dmg, Heal, Mana, PlayedMatches, PlayedWins;
        }

        private sealed class FactionAgg
        {
            public int Games, Wins, Turns, Dmg, Heal, Played, Echo;
        }

        private static readonly Faction[] FactionList =
        {
            Faction.Aurites, Faction.Necrus, Faction.Terramorph, Faction.Pyromancer, Faction.Ethereal,
        };

        /// <summary>Прогон N матчей всеми парами фракций (ТЗ п.8.1: 10 000 матчей).</summary>
        public static SimulationReport RunSimulation(CardDatabase db, IReadOnlyDictionary<string, List<string>> decks,
            SimulationOptions? opts = null)
        {
            opts ??= new SimulationOptions();
            int matches = opts.Matches;
            int baseSeed = opts.BaseSeed;
            var rng = new Rng(baseSeed);

            var deckIds = opts.DeckIds ?? FactionList.Select(f => f.ToString()).ToList();

            var cardAgg = new Dictionary<string, CardAgg>(StringComparer.Ordinal);
            var facAgg = new Dictionary<Faction, FactionAgg>();
            foreach (var f in FactionList) facAgg[f] = new FactionAgg();

            int totalTurns = 0, draws = 0;

            var config = opts.Config != null ? opts.Config.Clone() : new GameConfig();
            if (opts.PassiveMul != null)
                foreach (var kv in opts.PassiveMul) config.PassiveMul[kv.Key] = kv.Value;

            for (int i = 0; i < matches; i++)
            {
                string fA = deckIds.Count > 1 ? rng.Pick(deckIds) : deckIds[0];
                string fB = deckIds.Count > 1 ? rng.Pick(deckIds) : deckIds[0];

                // зеркальные матчи учитываются, но чередуем стороны для честности
                bool swap = rng.Chance(0.5);
                string left = swap ? fB : fA;
                string right = swap ? fA : fB;

                if (!Enum.TryParse<Faction>(left, out var leftFaction)) leftFaction = Faction.Neutral;
                if (!Enum.TryParse<Faction>(right, out var rightFaction)) rightFaction = Faction.Neutral;

                var runner = new MatchRunner(db, decks[left], decks[right], leftFaction, rightFaction,
                    new MatchOptions { Seed = baseSeed + i * 7919, Config = config });
                runner.SetupAI();

                MatchResult res;
                try { res = runner.Run(); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Матч #{i} ({left} vs {right}) упал: {ex.Message}");
                    continue;
                }

                totalTurns += res.Turns;
                if (res.Result == GameResult.Draw) draws++;

                // разыгранные карты + «победа при розыгрыше» (основа маргинального вклада)
                var playedIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var pc in res.PlayedCards)
                {
                    var a = Get(cardAgg, pc.CardId);
                    a.Played++;
                    playedIds.Add(pc.CardId);
                }
                foreach (var cid in playedIds)
                {
                    // квирк TS: берётся сторона ПЕРВОГО розыгрыша этой карты в матче
                    Side ownerSide = res.PlayedCards.First(pc => pc.CardId == cid).Side;
                    var a = Get(cardAgg, cid);
                    a.PlayedMatches++;
                    if (res.Winner == ownerSide) a.PlayedWins++;
                }

                // карта считается «присутствовавшей», если лежала в колоде любой из сторон
                var present = new List<string>(res.WinnerDeck);
                present.AddRange(res.LoserDeck);
                foreach (var cid in present) Get(cardAgg, cid).Present++;

                if (res.Winner != null)
                {
                    foreach (var cid in res.WinnerDeck.Distinct(StringComparer.Ordinal))
                    {
                        var a = Get(cardAgg, cid);
                        a.Wins++; a.InWin++;
                    }
                    foreach (var cid in res.LoserDeck.Distinct(StringComparer.Ordinal))
                    {
                        var a = Get(cardAgg, cid);
                        a.Losses++; a.InLose++;
                    }
                }

                foreach (var kv in res.CardDamage) Get(cardAgg, kv.Key).Dmg += kv.Value;
                foreach (var kv in res.CardHeal) Get(cardAgg, kv.Key).Heal += kv.Value;

                var sides = new[] { Side.Player, Side.Opponent };
                foreach (var side in sides)
                {
                    var fac = runner.Engine.P(side).Faction;
                    if (!facAgg.TryGetValue(fac, out var agg)) continue;
                    agg.Games++;
                    if (res.Winner == side) agg.Wins++;
                    agg.Turns += res.Turns;
                    agg.Dmg += res.Stats[(int)side].DamageDealt;
                    agg.Heal += res.Stats[(int)side].HealingDone;
                    agg.Played += res.Stats[(int)side].CardsPlayed;
                    agg.Echo += res.Stats[(int)side].EchoUsed;
                }
            }

            /* --- сводка по картам --- */
            var cards = new List<CardStat>();
            foreach (var kv in cardAgg)
            {
                var data = db.Get(kv.Key);
                if (data == null) continue;
                var a = kv.Value;
                double wr = a.Present > 0 ? (double)a.Wins / a.Present : 0;
                double wrPlayed = a.PlayedMatches > 0 ? (double)a.PlayedWins / a.PlayedMatches : 0.5;

                cards.Add(new CardStat
                {
                    CardId = kv.Key,
                    CardName = data.Name,
                    Faction = data.Faction,
                    Type = data.Type,
                    Rarity = data.Rarity,
                    Cost = data.Cost,
                    TimesPlayed = a.Played,
                    MatchesPresent = a.Present,
                    TimesInWinnerDeck = a.InWin,
                    TimesInLoserDeck = a.InLose,
                    Wins = a.Wins,
                    Losses = a.Losses,
                    WinRate = wr,
                    WinRateWhenPlayed = wrPlayed,
                    PlayRate = a.Present > 0 ? (double)a.Played / a.Present : 0,
                    AvgDamage = a.Played > 0 ? (double)a.Dmg / a.Played : 0,
                    AvgHeal = a.Played > 0 ? (double)a.Heal / a.Played : 0,
                    AvgMana = a.Played > 0 ? (double)a.Mana / a.Played : 0,
                });
            }

            // базовые винрейты фракций; для нейтральных карт — среднее по фракциям
            var factionBase = new Dictionary<Faction, double>();
            foreach (var kv in facAgg) factionBase[kv.Key] = kv.Value.Games > 0 ? (double)kv.Value.Wins / kv.Value.Games : 0.5;
            double neutralBase = factionBase.Count > 0 ? factionBase.Values.Sum() / factionBase.Count : 0.5;

            foreach (var c in cards)
            {
                double basis = c.Faction == Faction.Neutral
                    ? neutralBase
                    : (factionBase.TryGetValue(c.Faction, out var b) ? b : 0.5);
                c.FactionBaseWinRate = basis;
                c.RelativeWinRate = c.TimesPlayed > 0 ? c.WinRateWhenPlayed - basis : 0;
                // ТЗ п.8.1 (адаптировано): карта требует балансировки, если маргинальный
                // вклад выходит за ±5 п.п. при достаточной выборке розыгрышей
                c.NeedsBalance = c.TimesPlayed >= 100 && Math.Abs(c.RelativeWinRate) > 0.05;
            }

            // устойчивая сортировка + детерминированный тай-брейк по id:
            // в JS Array.sort устойчив, в .NET List.Sort — нет
            cards = cards.OrderByDescending(c => c.RelativeWinRate).ThenBy(c => c.CardId, StringComparer.Ordinal).ToList();

            /* --- сводка по фракциям --- */
            var factions = new List<FactionStat>();
            foreach (var kv in facAgg)
            {
                var a = kv.Value;
                double wr = a.Games > 0 ? (double)a.Wins / a.Games : 0;
                factions.Add(new FactionStat
                {
                    Faction = kv.Key,
                    Games = a.Games,
                    Wins = a.Wins,
                    Losses = a.Games - a.Wins,
                    WinRate = wr,
                    AvgTurns = a.Games > 0 ? (double)a.Turns / a.Games : 0,
                    AvgDamage = a.Games > 0 ? (double)a.Dmg / a.Games : 0,
                    AvgHeal = a.Games > 0 ? (double)a.Heal / a.Games : 0,
                    AvgCardsPlayed = a.Games > 0 ? (double)a.Played / a.Games : 0,
                    AvgEchoUsed = a.Games > 0 ? (double)a.Echo / a.Games : 0,
                    WithinTarget = wr >= 0.45 && wr <= 0.55,
                });
            }
            factions = factions.OrderByDescending(f => f.WinRate).ThenBy(f => f.Faction).ToList();

            return new SimulationReport
            {
                Matches = matches,
                Seed = baseSeed,
                AvgTurns = matches > 0 ? (double)totalTurns / matches : 0,
                Draws = draws,
                Factions = factions,
                Cards = cards,
                OutOfRange = cards.Where(c => c.NeedsBalance).ToList(),
            };
        }

        private static CardAgg Get(Dictionary<string, CardAgg> map, string id)
        {
            if (!map.TryGetValue(id, out var a)) { a = new CardAgg(); map[id] = a; }
            return a;
        }
    }
}
