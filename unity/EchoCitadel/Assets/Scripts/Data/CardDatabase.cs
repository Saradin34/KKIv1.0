/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Unity-порт (C#)
   Данные: загрузка и валидация базы карт.
   ---------------------------------------------------------------------
   Порт src/engine/db.ts. Читает ТОТ ЖЕ Cards.json / Decks.json из
   StreamingAssets, что и TypeScript-движок и HTML-прототип: единая база
   на все реализации, карты не заводятся руками в инспекторе.

   Загрузка в Unity:
       var text = File.ReadAllText(Path.Combine(Application.streamingAssetsPath, "Cards.json"));
       var db = CardDatabase.FromJson(text);
   (На Android StreamingAssets лежит внутри APK — там используйте
   UnityWebRequest; контракт FromJson от этого не меняется.)
   ===================================================================== */

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EchoCitadel.Data
{
    using EchoCitadel.Core;

    /// <summary>База карт: словарь id → CardData + словарь токенов.</summary>
    public sealed class CardDatabase
    {
        private readonly Dictionary<string, CardData> _cards = new(StringComparer.Ordinal);
        private readonly Dictionary<string, CardData> _tokens = new(StringComparer.Ordinal);

        public CardsFileMeta Meta { get; private set; } = new();

        public int Count => _cards.Count;
        public int TokenCount => _tokens.Count;

        public CardData? Get(string? id) =>
            id != null && _cards.TryGetValue(id, out var c) ? c
            : id != null && _tokens.TryGetValue(id, out var t) ? t
            : null;

        /// <summary>Карта только из основной базы (без токенов).</summary>
        public CardData? GetCard(string? id) => id != null && _cards.TryGetValue(id, out var c) ? c : null;

        public IReadOnlyDictionary<string, CardData> Cards => _cards;
        public IReadOnlyDictionary<string, CardData> Tokens => _tokens;

        public IEnumerable<CardData> All() => _cards.Values;

        /// <summary>
        /// Настройки десериализации: имена полей заданы атрибутами, перечисления
        /// приходят строками ("Aurites", "damage"), неизвестные поля игнорируются,
        /// поэтому добавление колонок генератором не ломает клиент.
        /// </summary>
        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = false,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            NumberHandling = JsonNumberHandling.AllowReadingFromString,
            Converters =
            {
                // Decks.json содержит служебную колоду «Starter» со значением
                // faction, которого нет в перечислении (смесь фракций).
                // TS-движок к ней не обращается, поэтому C# обязан не падать,
                // а приводить неизвестное значение к Neutral.
                // ВАЖНО: конвертер обязан стоять ПЕРЕД JsonStringEnumConverter —
                // System.Text.Json берёт первый подходящий по типу, иначе
                // штатный конвертер бросит исключение на «Starter».
                new LenientFactionConverter(),
                new JsonStringEnumConverter(),
            },
        };

        public static CardDatabase FromJson(string cardsJson)
        {
            var file = JsonSerializer.Deserialize<CardsFile>(cardsJson, JsonOptions)
                       ?? throw new InvalidOperationException("Cards.json пуст или повреждён");
            var db = new CardDatabase { Meta = file.Meta ?? new CardsFileMeta() };
            foreach (var c in file.Cards) Put(db._cards, c);
            foreach (var t in file.Tokens) Put(db._tokens, t);
            return db;
        }

        public static (CardDatabase db, DeckFile decks) FromJson(string cardsJson, string decksJson)
        {
            var db = FromJson(cardsJson);
            var decks = JsonSerializer.Deserialize<DeckFile>(decksJson, JsonOptions)
                        ?? throw new InvalidOperationException("Decks.json пуст или повреждён");
            return (db, decks);
        }

        /// <summary>Нормализация карты: списки не должны быть null (как normalizeAndSet в TS).</summary>
        private static void Put(IDictionary<string, CardData> map, CardData c)
        {
            c.Keywords ??= new List<Keyword>();
            c.Effects ??= new List<CardEffect>();
            c.Tags ??= new List<string>();
            c.AbilityText ??= "";
            c.Flavor ??= "";
            map[c.Id] = c;
        }

        /// <summary>
        /// Коэффициент силы пассивки фракции из meta.factionCoefficients.
        /// Если генератор их не записал — 1.0 («как в ТЗ п.2.5»).
        /// </summary>
        public double PassiveCoefficient(Faction f) =>
            Meta.FactionCoefficients != null && Meta.FactionCoefficients.TryGetValue(f.ToString(), out var c)
                ? c.PassiveMul
                : 1.0;

        /// <summary>Заполняет config.PassiveMul коэффициентами из базы карт.</summary>
        public GameConfig ApplyCoefficients(GameConfig config)
        {
            foreach (var f in Factions.Playable) config.PassiveMul[f] = PassiveCoefficient(f);
            return config;
        }

        /* ------------------------- ВАЛИДАЦИЯ КОЛОДЫ ------------------------ */

        /// <summary>
        /// Проверка колоды: размер, существование id, лимит копий
        /// (обычные — 2, легендарные — 1; ТЗ п.3.3). Возвращает список ошибок.
        /// </summary>
        public List<string> ValidateDeck(IList<string> deck, int size = 40)
        {
            var errs = new List<string>();
            if (deck.Count != size) errs.Add($"Размер колоды {deck.Count}, требуется {size}");

            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var id in deck)
            {
                var c = GetCard(id);
                if (c == null) { errs.Add($"Неизвестная карта: {id}"); continue; }
                counts[id] = counts.TryGetValue(id, out var n) ? n + 1 : 1;
            }
            foreach (var kv in counts)
            {
                int limit = GetCard(kv.Key)!.Rarity == Rarity.Legendary ? 1 : 2;
                if (kv.Value > limit) errs.Add($"Превышен лимит копий {kv.Key}: {kv.Value} > {limit}");
            }
            return errs;
        }

        /// <summary>Доминирующая фракция колоды (как factionOf в TS).</summary>
        public Faction FactionOf(IList<string> deck)
        {
            var tally = new Dictionary<Faction, int>();
            foreach (var id in deck)
            {
                var c = GetCard(id);
                if (c == null) continue;
                tally[c.Faction] = tally.TryGetValue(c.Faction, out var n) ? n + 1 : 1;
            }
            var best = Faction.Neutral;
            int max = -1;
            foreach (var kv in tally) if (kv.Value > max) { max = kv.Value; best = kv.Key; }
            return best;
        }

        /// <summary>Проверка распределения базы под ТЗ п.3.1–3.2 (типы и редкости).</summary>
        public Dictionary<string, int> Distribution()
        {
            var d = new Dictionary<string, int>
            {
                { "total", _cards.Count },
                { "Creature", 0 }, { "Spell", 0 }, { "Rune", 0 },
                { "Common", 0 }, { "Uncommon", 0 }, { "Rare", 0 }, { "Epic", 0 }, { "Legendary", 0 },
            };
            foreach (var c in _cards.Values)
            {
                d[c.Type.ToString()]++;
                d[c.Rarity.ToString()]++;
            }
            foreach (var f in Factions.Playable)
            {
                int n = 0;
                foreach (var c in _cards.Values) if (c.Faction == f) n++;
                d[f.ToString()] = n;
            }
            // нейтральные карты считаются отдельно: в балансировке фракций
            // они не участвуют, но в базе присутствуют (ТЗ п.3.1)
            int neutral = 0;
            foreach (var c in _cards.Values) if (c.Faction == Faction.Neutral) neutral++;
            d[Faction.Neutral.ToString()] = neutral;
            return d;
        }
    }

    /// <summary>
    /// Преобразователь фракций, терпимый к неизвестным строкам в JSON.
    /// Порядок регистрации важен: он должен стоять ДО JsonStringEnumConverter,
    /// иначе штатный конвертер перехватит тип и бросит исключение на неизвестном значении.
    /// </summary>
    internal sealed class LenientFactionConverter : JsonConverter<Faction>
    {
        public override Faction Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.String:
                    var s = reader.GetString();
                    if (s != null && Enum.TryParse<Faction>(s, ignoreCase: false, out var parsed)) return parsed;
                    return Faction.Neutral;
                case JsonTokenType.Number:
                    return reader.TryGetInt32(out var n) && Enum.IsDefined(typeof(Faction), n)
                        ? (Faction)n
                        : Faction.Neutral;
                default:
                    return Faction.Neutral;
            }
        }

        public override void Write(Utf8JsonWriter writer, Faction value, JsonSerializerOptions options)
            => writer.WriteStringValue(value.ToString());
    }
}
