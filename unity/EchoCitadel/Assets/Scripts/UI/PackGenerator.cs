// PackGenerator — генерация бустеров (Unity-зеркало спеки «3. Магазин» п.4.1, Промпт 2).
//  1. Параметры: тип бустера (обычный/фракционный) + фракция (если указана).
//  2. 5 карт по редкостям: 3 обычных, 1 редкая, 1 эпическая (шанс 12.5% — легендарная).
//     Состав идентичен серверному rollPack (meta_server) и прототипу.
//  3. Возвращает список id карт.
//  4. AddToCollection — POST /api/collection/add (копии ≤4 в коллекцию, излишек → ◈).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using UnityEngine;
using EchoCitadel.Core;
using EchoCitadel.Data;
using Random = System.Random;

namespace EchoCitadel.UI
{
    public enum BoosterType { Normal, Faction }

    public static class PackGenerator
    {
        private static HashSet<string>? _expansion;

        /// meta.expansionIds из Cards.json. В CardsFileMeta поля пока нет —
        /// добавим при догоне C#-порта (BLOCK 2); до того читаем JSON напрямую.
        public static HashSet<string> ExpansionIds()
        {
            if (_expansion != null) return _expansion;
            _expansion = new HashSet<string>(StringComparer.Ordinal);
            var json = FactionCatalog.ReadStreaming("Cards.json");
            if (string.IsNullOrEmpty(json)) return _expansion;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("meta", out var meta)
                    && meta.TryGetProperty("expansionIds", out var arr)
                    && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var el in arr.EnumerateArray())
                        if (el.ValueKind == JsonValueKind.String) _expansion.Add(el.GetString() ?? "");
                }
            }
            catch (JsonException) { /* пустой список — пул останется общим */ }
            return _expansion;
        }

        /// Генерация 5 карт. Пул — только расширение (ECH1); для фракционного бустера —
        /// карты выбранной фракции (если их ≥5, иначе общий пул расширения).
        public static List<string> Generate(BoosterType type, Faction? faction, CardDatabase db, Random? rng = null)
        {
            rng ??= new Random();
            var ids = new List<string>(5);
            var exp = ExpansionIds();
            var pool = db.Cards.Values.Where(c => exp.Contains(c.Id)).ToList();
            if (type == BoosterType.Faction && faction.HasValue)
            {
                var byFac = pool.Where(c => c.Faction == faction.Value).ToList();
                if (byFac.Count >= 5) pool = byFac;
            }
            if (pool.Count == 0) return ids;

            var comp = new[]
            {
                Rarity.Common, Rarity.Common, Rarity.Common, Rarity.Rare,
                rng.NextDouble() < 0.125 ? Rarity.Legendary : Rarity.Epic,
            };
            foreach (var r in comp)
            {
                var cand = pool.Where(c => c.Rarity == r).ToList();
                if (cand.Count == 0) cand = pool;      // деградация: редкость не представлена в пуле
                ids.Add(cand[rng.Next(cand.Count)].Id);
            }
            return ids;
        }

        /// Регистрация дропа на сервере: POST /api/collection/add.
        /// Ответ: {ok, added:[{id,copies}], converted:[{id,dust}], shards}.
        public static IEnumerator AddToCollection(MonoBehaviour host, string baseUrl,
            IReadOnlyList<string> ids, Action<long, JsonElement?>? cb = null)
        {
            return MetaApi.Post(host, baseUrl, "/api/collection/add",
                new { pid = MetaApi.Pid, ids }, (code, root) => cb?.Invoke(code, root));
        }
    }
}
