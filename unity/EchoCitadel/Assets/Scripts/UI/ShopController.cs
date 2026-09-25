// ShopController — магазин в Unity (зеркало спеки «3. Магазин», Промпт 1).
//  1. GET {baseUrl}/api/shop → каталог (бустеры / стартовые наборы / косметика / тарифы крафта).
//  2. 4 вкладки — как в HTML-прототипе.
//  3. Кнопка «Купить» → POST /api/shop/buy {pid,itemId,faction?}.
//     Успех (200) → обновление валют и инвентаря (+события OnPurchased/OnPackOpened);
//     ошибка (402/409/403/404) → всплывающее сообщение-тост с текстом сервера.
//
// Префаб itemShop: «Name» (TMP), «Price» (TMP), «Tag» (TMP, опц.), «BuyButton» (Button).
// Тост: префаб toastAchievement из §2 (профиль) — «Name»+«Desc»; при отсутствии префаба — Debug.Log.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using EchoCitadel.Core;
using EchoCitadel.Data;

namespace EchoCitadel.UI
{
    public sealed class ShopController : MonoBehaviour
    {
        [Header("Сервер")]
        public string baseUrl = "http://localhost:8081";

        [Header("Данные")]
        public CardDatabase? database;          // для локальной генерации превью бустеров (опц.)

        [Header("Вкладки (4, как в прототипе)")]
        public Button? tabBoosters, tabStarters, tabCosmetics, tabCraft;
        public GameObject? panelBoosters, panelStarters, panelCosmetics, panelCraft;
        public Transform? boostersRoot, startersRoot, cosmeticsRoot;
        public GameObject? itemPrefab;          // префаб itemShop

        [Header("Кошелёк")]
        public TMP_Text? shardsText, gemsText;

        [Header("Тосты ошибок/успеха")]
        public GameObject? toastPrefab;         // toastAchievement
        public Transform? toastRoot;

        /// Успешная покупка (itemId, JSON-корень ответа сервера).
        public static event Action<string, JsonElement?>? OnPurchased;
        /// Открыт бустер: список 5 id карт (после покупки pack/pack_faction).
        public static event Action<IReadOnlyList<string>>? OnPackOpened;
        /// Куплен стартовый набор фракции (для блокировки кнопки).
        public static event Action<string>? OnBundleBought;

        private ShopCatalog? _catalog;

        private void Awake()
        {
            if (!database && TryGetComponent(out MenuContext? ctx)) database = ctx?.database;
            if (tabBoosters) tabBoosters.onClick.AddListener(() => SwitchTab(0));
            if (tabStarters) tabStarters.onClick.AddListener(() => SwitchTab(1));
            if (tabCosmetics) tabCosmetics.onClick.AddListener(() => SwitchTab(2));
            if (tabCraft) tabCraft.onClick.AddListener(() => SwitchTab(3));
            SwitchTab(0);
        }

        private void OnEnable()
        {
            LoadWallet();
            StartCoroutine(LoadCatalog());
        }

        /// Пыль/золото ◈ — единая валюта (PlayerPrefs хранит строкой: long не входит в PlayerPrefs API).
        public static long WalletShards
            => long.TryParse(PlayerPrefs.GetString("ec.wallet.shards", "0"), out var v) ? v : 0;

        private void LoadWallet()
        {
            if (shardsText) shardsText.text = "◈ " + WalletShards;
            if (gemsText) gemsText.text = "💎 " + PlayerPrefs.GetInt("ec.wallet.gems", 0);
        }

        private IEnumerator LoadCatalog()
        {
            yield return MetaApi.Get(this, baseUrl, "/api/shop", (code, root) =>
            {
                if (code != 200 || !root.HasValue) { Toast("Каталог недоступен", $"HTTP {code}", false); return; }
                try
                {
                    _catalog = root.Value.Deserialize<ShopCatalog>();
                }
                catch (JsonException e) { Toast("Каталог повреждён", e.Message, false); return; }
                if (_catalog != null) BuildTabs(_catalog);
            });
        }

        private void BuildTabs(ShopCatalog cat)
        {
            BuildItems(boostersRoot, cat.Boosters, it => Buy(it.Id, null));
            BuildItems(startersRoot, cat.Starters, it => Buy(it.Id, null));
            BuildItems(cosmeticsRoot, cat.Cosmetics.All(), it => Buy(it.Id, null));
            // вкладка «Крафт» — тарифы из каталога; сам крафт ведёт CraftingController.
        }

        private void BuildItems(Transform? root, IEnumerable<ShopItem> items, Action<ShopItem> onBuy)
        {
            if (!root || !itemPrefab) return;
            foreach (Transform old in root) Destroy(old.gameObject);
            foreach (var it in items)
            {
                var go = Instantiate(itemPrefab, root);
                go.name = "item_" + it.Id;
                var name = go.transform.Find("Name")?.GetComponent<TMP_Text>();
                var price = go.transform.Find("Price")?.GetComponent<TMP_Text>();
                var tag = go.transform.Find("Tag")?.GetComponent<TMP_Text>();
                var btn = go.transform.Find("BuyButton")?.GetComponent<Button>();
                if (name) name.text = it.Name;
                var cur = it.Currency == "gems" ? "💎" : it.Currency == "bp" ? "🎖" : "◈";
                if (price) price.text = it.Currency == "bp" ? it.Source ?? "боевой пропуск" : $"{cur} {it.Price}";
                if (tag) tag.text = it.Composition ?? (it.Cards > 0 ? $"{it.Cards} карт" : "");
                if (btn)
                {
                    var captured = it;
                    btn.onClick.AddListener(() => onBuy(captured));
                    if (it.Currency == "bp") btn.interactable = false;   // награды БП не продаются
                }
            }
        }

        private void SwitchTab(int i)
        {
            if (panelBoosters) panelBoosters.SetActive(i == 0);
            if (panelStarters) panelStarters.SetActive(i == 1);
            if (panelCosmetics) panelCosmetics.SetActive(i == 2);
            if (panelCraft) panelCraft.SetActive(i == 3);
        }

        /// Пункт 3 промпта: покупка через POST /api/shop/buy.
        public void Buy(string itemId, Faction? faction = null)
        {
            StartCoroutine(BuyCo(itemId, faction));
        }

        private IEnumerator BuyCo(string itemId, Faction? faction)
        {
            var body = faction.HasValue
                ? (object)new { pid = MetaApi.Pid, itemId, faction = faction.Value.ToString() }
                : new { pid = MetaApi.Pid, itemId };
            yield return MetaApi.Post(this, baseUrl, "/api/shop/buy", body, (code, root) =>
            {
                if (code == 200 && root.HasValue)
                {
                    // успех → обновить валюты и инвентарь
                    if (root.Value.TryGetProperty("shards", out var sh)) PlayerPrefs.SetString("ec.wallet.shards", sh.GetRawText());
                    if (root.Value.TryGetProperty("gems", out var gm)) PlayerPrefs.SetInt("ec.wallet.gems", gm.GetInt32());
                    LoadWallet();
                    if (root.Value.TryGetProperty("drops", out var drops) && drops.ValueKind == JsonValueKind.Array)
                    {
                        var ids = drops.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s != "").ToList();
                        OnPackOpened?.Invoke(ids);
                        // регистрация в коллекцию на сервере (копии ≤4; излишек → ◈)
                        StartCoroutine(PackGenerator.AddToCollection(this, baseUrl, ids));
                    }
                    if (itemId.StartsWith("starter_")) OnBundleBought?.Invoke(itemId.Substring("starter_".Length));
                    OnPurchased?.Invoke(itemId, root);
                    Toast("Покупка удалась", ItemName(itemId), true);
                    return;
                }
                // ошибка → тост с текстом сервера (недостаточно валюты / уже куплено / …)
                var err = root.HasValue && root.Value.TryGetProperty("error", out var e) ? (e.GetString() ?? $"HTTP {code}") : $"HTTP {code}";
                Toast("Покупка не удалась", err, false);
            });
        }

        private string ItemName(string id)
        {
            if (_catalog == null) return id;
            var all = _catalog.Boosters.Concat(_catalog.Starters).Concat(_catalog.Cosmetics.All());
            return all.FirstOrDefault(x => x.Id == id)?.Name ?? id;
        }

        private void Toast(string title, string desc, bool gold)
        {
            if (!toastPrefab || !toastRoot) { Debug.Log($"[shop] {title}: {desc}"); return; }
            var go = Instantiate(toastPrefab, toastRoot);
            go.name = "toast_shop";
            var name = go.transform.Find("Name")?.GetComponent<TMP_Text>();
            var d = go.transform.Find("Desc")?.GetComponent<TMP_Text>();
            if (name) name.text = title;
            if (d) d.text = desc;
            StartCoroutine(DestroyLater(go));
        }

        private IEnumerator DestroyLater(GameObject go)
        {
            yield return new WaitForSeconds(4f);
            if (go) Destroy(go);
        }

        /* ---------------- DTO каталога (зеркало SHOP_CATALOG сервера) ---------------- */

        public sealed class ShopItem
        {
            [JsonPropertyName("id")] public string Id { get; set; } = "";
            [JsonPropertyName("name")] public string Name { get; set; } = "";
            [JsonPropertyName("price")] public int Price { get; set; }
            [JsonPropertyName("currency")] public string Currency { get; set; } = "shards";
            [JsonPropertyName("cards")] public int Cards { get; set; }
            [JsonPropertyName("composition")] public string? Composition { get; set; }
            [JsonPropertyName("source")] public string? Source { get; set; }
            [JsonPropertyName("requiresFaction")] public bool RequiresFaction { get; set; }
        }

        public sealed class ShopCosmetics
        {
            [JsonPropertyName("backs")] public List<ShopItem> Backs { get; set; } = new();
            [JsonPropertyName("tables")] public List<ShopItem> Tables { get; set; } = new();
            [JsonPropertyName("runes")] public List<ShopItem> Runes { get; set; } = new();
            public IEnumerable<ShopItem> All() => Backs.Concat(Tables).Concat(Runes);
        }

        public sealed class ShopCatalog
        {
            [JsonPropertyName("boosters")] public List<ShopItem> Boosters { get; set; } = new();
            [JsonPropertyName("starters")] public List<ShopItem> Starters { get; set; } = new();
            [JsonPropertyName("cosmetics")] public ShopCosmetics Cosmetics { get; set; } = new();
            [JsonPropertyName("craft")] public Dictionary<string, int> Craft { get; set; } = new();
            [JsonPropertyName("dust")] public Dictionary<string, int> Dust { get; set; } = new();
        }
    }
}
