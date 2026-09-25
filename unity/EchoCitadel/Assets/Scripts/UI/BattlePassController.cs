// BattlePassController — экран боевого пропуска (зеркало спеки «5. 🎟 Боевой пропуск», Промпт 1).
//  1. Загрузка прогресса с сервера: GET /api/battlepass?pid=…
//  2. 50 уровней горизонтальной лентой (ScrollRect) с автопрокруткой к текущему уровню.
//  3. Для каждого уровня — награды бесплатной и премиум-ветки (🔒 до покупки премиума).
//  4. «Забрать» → POST /api/battlepass/claim {pid, level, track}.
//  5. «Забрать всё» → POST /api/battlepass/claimall → тост с суммарным итогом (спека 5.4).
//  Покупка премиума → POST /api/battlepass/buy (💎500, спека 5.3).
//
// Префаб bpLevel: «Level» (TMP), «Free» (TMP), «Prem» (TMP), «BtnFree», «BtnPrem» (Button),
//                 «Cur» (GameObject — подсветка текущего уровня, спека 5.1).
// Тост: префаб toastAchievement из §2 («Name»+«Desc»); без префаба — Debug.Log.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace EchoCitadel.UI
{
    public sealed class BattlePassController : MonoBehaviour
    {
        [Header("Сервер")]
        public string baseUrl = "http://localhost:8081";

        [Header("Лента уровней (50)")]
        public ScrollRect? ribbon;
        public Transform? levelsRoot;           // Content ленты
        public GameObject? levelPrefab;         // префаб bpLevel

        [Header("Прогресс (спека 5.1)")]
        public TMP_Text? headerText;            // «Уровень N/50 · XP X · до следующего Y/400»
        public Image? progressBarFill;          // Image с type=Filled (fillAmount) — прогресс до следующего уровня

        [Header("Кнопки")]
        public Button? btnClaimAll;             // «Забрать всё» (спека 5.4)
        public Button? btnBuyPremium;           // «Премиум-ветка · 💎500» (спека 5.3)
        public TMP_Text? btnBuyPremiumLabel;

        [Header("Тосты")]
        public GameObject? toastPrefab;
        public Transform? toastRoot;

        /// Новый уровень пропуска достигнут (лента/тосты/звук — по подписке).
        public static event Action<int>? OnLevelChanged;
        /// Награда получена: (уровень, ветка free|prem).
        public static event Action<int, string>? OnRewardClaimed;
        /// Премиум-ветка куплена.
        public static event Action? OnPremiumBought;

        private BpState? _state;

        private void OnEnable()
        {
            if (btnClaimAll) btnClaimAll.onClick.AddListener(ClaimAll);
            if (btnBuyPremium) btnBuyPremium.onClick.AddListener(BuyPremium);
            StartCoroutine(Load());
        }

        private void OnDisable()
        {
            if (btnClaimAll) btnClaimAll.onClick.RemoveListener(ClaimAll);
            if (btnBuyPremium) btnBuyPremium.onClick.RemoveListener(BuyPremium);
        }

        /// Публичное обновление (после addxp из BattlePassXP, покупок и т.д.).
        public void Reload() => StartCoroutine(Load());

        /* ---------------- 1. Загрузка прогресса ---------------- */

        private IEnumerator Load()
        {
            yield return MetaApi.Get(this, baseUrl, $"/api/battlepass?pid={Uri.EscapeDataString(MetaApi.Pid)}", root =>
            {
                if (!root.HasValue) { Toast("Пропуск недоступен", "сервер не отвечает", false); return; }
                try { _state = root.Value.Deserialize<BpState>(); }
                catch (JsonException e) { Toast("Пропуск недоступен", e.Message, false); return; }
                if (_state != null) Build(_state);
            });
        }

        /* ---------------- 2–3. Лента 50 уровней, две ветки ---------------- */

        private void Build(BpState st)
        {
            if (levelsRoot != null && levelPrefab != null)
            {
                foreach (Transform old in levelsRoot) Destroy(old.gameObject);
                foreach (var row in st.Rewards)
                {
                    var go = Instantiate(levelPrefab, levelsRoot);
                    go.name = $"bp_{row.Lvl}";
                    var lvl = go.transform.Find("Level")?.GetComponent<TMP_Text>();
                    var free = go.transform.Find("Free")?.GetComponent<TMP_Text>();
                    var prem = go.transform.Find("Prem")?.GetComponent<TMP_Text>();
                    var cur = go.transform.Find("Cur")?.gameObject;
                    var btnF = go.transform.Find("BtnFree")?.GetComponent<Button>();
                    var btnP = go.transform.Find("BtnPrem")?.GetComponent<Button>();

                    if (lvl) lvl.text = row.Lvl.ToString();
                    if (free) free.text = row.Free.Ru;
                    if (prem) prem.text = st.Premium ? row.Prem.Ru : $"🔒 {row.Prem.Ru}";
                    if (cur) cur.SetActive(row.Lvl == st.Level);       // текущий уровень подсвечен

                    var reached = row.Lvl <= st.Level;
                    var gotF = st.ClaimedFree.Contains(row.Lvl);
                    var gotP = st.ClaimedPrem.Contains(row.Lvl);
                    if (btnF)
                    {
                        SetClaimBtn(btnF, gotF ? "✔" : "Забрать", reached && !gotF);
                        int captured = row.Lvl;
                        btnF.onClick.AddListener(() => Claim(captured, "free"));
                    }
                    if (btnP)
                    {
                        SetClaimBtn(btnP, gotP ? "✔" : st.Premium ? "Забрать" : "🔒", st.Premium && reached && !gotP);
                        int captured = row.Lvl;
                        btnP.onClick.AddListener(() => Claim(captured, "prem"));
                    }
                }
                // автопрокрутка к текущему уровню
                if (ribbon != null && st.Levels > 1)
                    ribbon.horizontalNormalizedPosition = Mathf.Clamp01((st.Level - 1) / (float)(st.Levels - 1));
            }

            // прогресс-бар до следующего уровня (спека 5.1)
            var maxed = st.Level >= st.Levels;
            if (headerText)
                headerText.text = maxed
                    ? $"Уровень {st.Level}/{st.Levels} · XP {st.Xp} · МАКСИМУМ"
                    : $"Уровень {st.Level}/{st.Levels} · XP {st.Xp} · до следующего: {st.Xp % st.XpStep}/{st.XpStep}";
            if (progressBarFill)
                progressBarFill.fillAmount = maxed ? 1f : (st.Xp % st.XpStep) / (float)st.XpStep;

            if (btnBuyPremium)
            {
                btnBuyPremium.interactable = !st.Premium;
                if (btnBuyPremiumLabel) btnBuyPremiumLabel.text = st.Premium ? "💎 Премиум активен" : "Премиум-ветка · 💎500";
            }
            OnLevelChanged?.Invoke(st.Level);
        }

        private static void SetClaimBtn(Button b, string label, bool interactable)
        {
            b.interactable = interactable;
            var t = b.GetComponentInChildren<TMP_Text>();
            if (t) t.text = label;
        }

        /* ---------------- 4. «Забрать» ---------------- */

        public void Claim(int level, string track)
        {
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/battlepass/claim",
                new { pid = MetaApi.Pid, level, track }, (code, root) =>
            {
                if (code == 200 && root.HasValue)
                {
                    var ru = root.Value.TryGetProperty("reward", out var rw)
                        && rw.TryGetProperty("ru", out var ruEl) ? (ruEl.GetString() ?? "") : "";
                    OnRewardClaimed?.Invoke(level, track);
                    Toast("Награда получена", $"уровень {level} ({(track == "prem" ? "премиум" : "бесплатная")}): {ru}", true);
                    Reload();
                    return;
                }
                Toast("Не удалось получить", ErrText(code, root), false);
            }));
        }

        /* ---------------- 5. «Забрать всё» (спека 5.4: суммарный итог) ---------------- */

        public void ClaimAll()
        {
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/battlepass/claimall",
                new { pid = MetaApi.Pid }, (code, root) =>
            {
                if (code == 200 && root.HasValue)
                {
                    var claimed = root.Value.TryGetProperty("claimed", out var n) ? n.GetInt32() : 0;
                    if (claimed == 0) { Toast("Забрать всё", "нет доступных наград", false); Reload(); return; }
                    var parts = new List<string>();
                    if (root.Value.TryGetProperty("totals", out var tot))
                    {
                        void Add(string key, string label)
                        {
                            if (tot.TryGetProperty(key, out var v) && v.GetInt32() > 0) parts.Add($"{label} ×{v.GetInt32()}");
                        }
                        if (tot.TryGetProperty("shards", out var sh) && sh.GetInt32() > 0) parts.Insert(0, $"◈{sh.GetInt32()}");
                        if (tot.TryGetProperty("gems", out var gm) && gm.GetInt32() > 0) parts.Add($"💎{gm.GetInt32()}");
                        Add("packs", "🎁 бустеры");
                        Add("premPacks", "🌟 премиум-бустеры");
                        Add("foils", "фойл-жетоны");
                        Add("backs", "рубашки");
                        Add("avatars", "аватары");
                    }
                    Toast($"Забрано наград: {claimed}", string.Join(" · ", parts), true);
                    Reload();
                    return;
                }
                Toast("Не удалось собрать", ErrText(code, root), false);
            }));
        }

        /* ---------------- Покупка премиум-ветки (💎500) ---------------- */

        public void BuyPremium()
        {
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/battlepass/buy",
                new { pid = MetaApi.Pid }, (code, root) =>
            {
                if (code == 200)
                {
                    OnPremiumBought?.Invoke();
                    Toast("💎 Премиум-ветка активирована", "доступны все награды премиум-ветки", true);
                    Reload();
                    return;
                }
                Toast("Покупка не удалась", ErrText(code, root), false);   // 402 — мало гемов, 409 — уже куплен
            }));
        }

        private static string ErrText(long code, JsonElement? root)
            => root.HasValue && root.Value.TryGetProperty("error", out var e)
                ? (e.GetString() ?? $"HTTP {code}") : $"HTTP {code}";

        private void Toast(string title, string desc, bool gold)
        {
            if (!toastPrefab || !toastRoot) { Debug.Log($"[battlepass] {title}: {desc}"); return; }
            var go = Instantiate(toastPrefab, toastRoot);
            go.name = "toast_bp";
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

        /* ---------------- DTO (зеркало GET /api/battlepass) ---------------- */

        public sealed class BpRewardDto
        {
            [JsonPropertyName("ru")] public string Ru { get; set; } = "";
            [JsonPropertyName("shards")] public int? Shards { get; set; }
            [JsonPropertyName("pack")] public int? Pack { get; set; }
            [JsonPropertyName("premPack")] public int? PremPack { get; set; }
            [JsonPropertyName("gems")] public int? Gems { get; set; }
            [JsonPropertyName("back")] public string? Back { get; set; }
            [JsonPropertyName("foil")] public int? Foil { get; set; }
            [JsonPropertyName("ava")] public string? Ava { get; set; }
        }

        public sealed class BpRowDto
        {
            [JsonPropertyName("lvl")] public int Lvl { get; set; }
            [JsonPropertyName("free")] public BpRewardDto Free { get; set; } = new();
            [JsonPropertyName("prem")] public BpRewardDto Prem { get; set; } = new();
        }

        public sealed class BpState
        {
            [JsonPropertyName("levels")] public int Levels { get; set; } = 50;
            [JsonPropertyName("xpStep")] public int XpStep { get; set; } = 400;
            [JsonPropertyName("rates")] public Dictionary<string, int> Rates { get; set; } = new();
            [JsonPropertyName("xp")] public int Xp { get; set; }
            [JsonPropertyName("level")] public int Level { get; set; } = 1;
            [JsonPropertyName("premium")] public bool Premium { get; set; }
            [JsonPropertyName("claimedFree")] public List<int> ClaimedFree { get; set; } = new();
            [JsonPropertyName("claimedPrem")] public List<int> ClaimedPrem { get; set; } = new();
            [JsonPropertyName("rewards")] public List<BpRowDto> Rewards { get; set; } = new();
        }
    }
}
