// QuestSystem — ежедневные и еженедельные задания (Unity-зеркало спеки «2. Профиль», Промпт 2).
//  1. Загрузка заданий с сервера: GET /api/quests?pid=… (офлайн-фолбэк: PlayerPrefs-кэш).
//  2. Прогресс через статические события GameEvents (OnMatchWin / OnCardPlayed / OnDamageDealt /
//     OnBoosterOpened) — движок боя шлёт их, UI подписан.
//  3. Выполнение → кнопка «Забрать» активна → POST /api/quests/claim (сервер валидирует prog≥goal).
//  4. Прогресс-бары обновляются в реальном времени (RefreshUI на каждое событие).
// Идентификаторы заданий — как в прототипе: день win_fac/runes/pack, неделя w_win3/w_runes/w_dmg.
// Префаб-конвенция questRowPrefab: "Label"(TMP), "Bar"(Image fillAmount), "Claim"(Button).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace EchoCitadel.UI
{
    /// Событийная шина геймплея: движок/бой публикуют, квесты и достижения подписываются.
    public static class GameEvents
    {
        public static event Action<bool, bool, string>? OnMatchWin;      // (победа, рейтинговый, фракция игрока)
        public static event Action<string, string>? OnCardPlayed;        // (cardId, cardType: Creature|Spell|Rune)
        public static event Action<int>? OnDamageDealt;                  // урон, нанесённый игроком за матч
        public static event Action? OnBoosterOpened;
        public static event Action<string>? OnBossDefeated;              // id фракции босса кампании
        public static event Action<string, string>? OnQuestComplete;     // (questId, kind: daily|weekly) — спека «5»: BP XP +150/+250

        public static void MatchWin(bool win, bool ranked, string faction) => OnMatchWin?.Invoke(win, ranked, faction);
        public static void CardPlayed(string cardId, string cardType) => OnCardPlayed?.Invoke(cardId, cardType);
        public static void DamageDealt(int amount) => OnDamageDealt?.Invoke(amount);
        public static void BoosterOpened() => OnBoosterOpened?.Invoke();
        public static void BossDefeated(string faction) => OnBossDefeated?.Invoke(faction);
        public static void QuestComplete(string questId, string kind) => OnQuestComplete?.Invoke(questId, kind);
    }

    [Serializable]
    public sealed class QuestRow
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("prog")] public int Prog { get; set; }
        [JsonPropertyName("goal")] public int Goal { get; set; } = 1;
        [JsonPropertyName("claimed")] public bool Claimed { get; set; }
        [JsonPropertyName("fac")] public string? Fac { get; set; }
    }

    public sealed class QuestSystem : MonoBehaviour
    {
        [SerializeField] private string baseUrl = MetaApi.DefaultBaseUrl;
        [SerializeField] private Transform? dailyRoot, weeklyRoot;
        [SerializeField] private GameObject? questRowPrefab;
        [SerializeField] private AudioSource? sfxSource;
        [SerializeField] private AudioClip? claimClip;

        private List<QuestRow> _daily = new();
        private List<QuestRow> _weekly = new();
        private string _dailyDate = "", _weeklyWeek = "";
        private float _syncAt;   // троттлинг POST /api/profile (зеркало прогресса)

        private static readonly Dictionary<string, int> DailyReward = new()
        { ["win_fac"] = 200, ["runes"] = 120, ["pack"] = 80 };
        private static readonly Dictionary<string, int> WeekReward = new()
        { ["w_win3"] = 300, ["w_runes"] = 250, ["w_dmg"] = 350 };

        private void OnEnable()
        {
            GameEvents.OnMatchWin += HandleMatch;
            GameEvents.OnCardPlayed += HandleCard;
            GameEvents.OnDamageDealt += HandleDamage;
            GameEvents.OnBoosterOpened += HandleBooster;
        }

        private void OnDisable()
        {
            GameEvents.OnMatchWin -= HandleMatch;
            GameEvents.OnCardPlayed -= HandleCard;
            GameEvents.OnDamageDealt -= HandleDamage;
            GameEvents.OnBoosterOpened -= HandleBooster;
        }

        private void Start() => StartCoroutine(LoadQuests());

        /* ---- 1. Загрузка с сервера + ротация (24ч / неделя) ---- */

        public IEnumerator LoadQuests()
        {
            bool got = false;
            yield return MetaApi.Get(this, baseUrl, $"/api/quests?pid={MetaApi.Pid}", root =>
            {
                if (root == null) return;
                try
                {
                    if (root.Value.TryGetProperty("daily", out var d))
                        _daily = JsonSerializer.Deserialize<List<QuestRow>>(d.GetRawText(), EchoBootJson.Options) ?? _daily;
                    if (root.Value.TryGetProperty("weekly", out var w))
                        _weekly = JsonSerializer.Deserialize<List<QuestRow>>(w.GetRawText(), EchoBootJson.Options) ?? _weekly;
                    got = _daily.Count > 0 || _weekly.Count > 0;
                }
                catch (JsonException) { /* фолбэк на кэш */ }
            });
            if (!got) LoadCache();
            RotateIfNeeded();
            RefreshUI();
        }

        private void LoadCache()
        {
            try
            {
                var d = PlayerPrefs.GetString("ec.quests.daily", "");
                var w = PlayerPrefs.GetString("ec.quests.weekly", "");
                if (!string.IsNullOrEmpty(d)) _daily = JsonSerializer.Deserialize<List<QuestRow>>(d, EchoBootJson.Options) ?? _daily;
                if (!string.IsNullOrEmpty(w)) _weekly = JsonSerializer.Deserialize<List<QuestRow>>(w, EchoBootJson.Options) ?? _weekly;
                _dailyDate = PlayerPrefs.GetString("ec.quests.date", "");
                _weeklyWeek = PlayerPrefs.GetString("ec.quests.week", "");
            }
            catch (JsonException) { /* повреждённый кэш — перегенерируем */ }
        }

        private static string Today() => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        private static string ThisWeek()
        {
            var d = DateTime.Now;
            int week = ISOWeek.GetWeekOfYear(d);
            return $"{d.Year}-W{week}";
        }

        private void RotateIfNeeded()
        {
            if (_dailyDate != Today() || _daily.Count == 0)
            {
                _dailyDate = Today();
                string fac = FactionOfDay();
                _daily = new List<QuestRow>
                {
                    new() { Id = "win_fac", Goal = 2, Fac = fac },
                    new() { Id = "runes", Goal = 6 },
                    new() { Id = "pack", Goal = 1 },
                };
            }
            if (_weeklyWeek != ThisWeek() || _weekly.Count == 0)
            {
                _weeklyWeek = ThisWeek();
                _weekly = new List<QuestRow>
                {
                    new() { Id = "w_win3", Goal = 3 },
                    new() { Id = "w_runes", Goal = 15 },
                    new() { Id = "w_dmg", Goal = 300 },
                };
            }
            SaveCache();
        }

        private static readonly string[] FactionIds = { "Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal" };
        private static readonly string[] FactionRu = { "Ауриты", "Некрусы", "Терраморфы", "Пироманты", "Эфирные" };

        private static string FactionOfDay() => FactionIds[DateTime.Now.Day % FactionIds.Length];

        /* ---- 2. Прогресс через события ---- */

        private void HandleMatch(bool win, bool ranked, string faction)
        {
            if (!win) return;
            Bump(_daily, "win_fac", q => q.Fac == faction || string.IsNullOrEmpty(q.Fac) ? 1 : 0);
            Bump(_weekly, "w_win3", 1);
        }

        private void HandleCard(string cardId, string cardType)
        {
            if (cardType != "Rune") return;
            Bump(_daily, "runes", 1);
            Bump(_weekly, "w_runes", 1);
        }

        private void HandleDamage(int amount) => Bump(_weekly, "w_dmg", amount);

        private void HandleBooster() => Bump(_daily, "pack", 1);

        private void Bump(List<QuestRow> list, string id, int n)
        {
            var q = list.FirstOrDefault(x => x.Id == id);
            if (q == null || q.Claimed || n <= 0) return;
            q.Prog = Math.Min(q.Goal, q.Prog + n);
            RefreshUI();
            ScheduleSync();
        }

        private void Bump(List<QuestRow> list, string id, Func<QuestRow, int> fn)
        {
            var q = list.FirstOrDefault(x => x.Id == id);
            if (q == null || q.Claimed) return;
            int n = fn(q);
            if (n <= 0) return;
            q.Prog = Math.Min(q.Goal, q.Prog + n);
            RefreshUI();
            ScheduleSync();
        }

        /* ---- 3. Клейм: POST /api/quests/claim ---- */

        private void Claim(QuestRow q, bool weekly)
        {
            if (q.Claimed || q.Prog < q.Goal) return;
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/quests/claim", new
            {
                pid = MetaApi.Pid, id = q.Id, kind = weekly ? "weekly" : "daily", prog = q.Prog, goal = q.Goal,
            }, (code, _) =>
            {
                if (code == 409) { q.Claimed = true; RefreshUI(); return; }   // уже заклеймлено на сервере
                if (code != 200)
                {
                    // Сервер недоступен — клейм локальный (клиент — источник истины в офлайне).
                    Debug.Log($"[Quests] claim офлайн (код {code}): {q.Id}");
                }
                q.Claimed = true;
                int shards = (weekly ? WeekReward : DailyReward).TryGetValue(q.Id, out var r) ? r : 0;
                int bpXp = weekly ? 250 : 150;
                if (sfxSource != null && claimClip != null) sfxSource.PlayOneShot(claimClip);
                Debug.Log($"[Quests] награда: ◈{shards} + {bpXp} BP XP ({q.Id})");
                // Начисление ◈ — через кошелёк игрока (MetaWallet — BLOCK 2);
                // BP XP отправляет на сервер BattlePassXP.cs по этому событию (спека «5», +150 daily / +250 weekly).
                GameEvents.QuestComplete(q.Id, weekly ? "weekly" : "daily");
                SaveCache();
                ScheduleSync();
                RefreshUI();
            }));
        }

        /* ---- 4. UI в реальном времени ---- */

        private void RefreshUI()
        {
            BuildRows(dailyRoot, _daily, false);
            BuildRows(weeklyRoot, _weekly, true);
        }

        private void BuildRows(Transform? root, List<QuestRow> list, bool weekly)
        {
            if (root == null || questRowPrefab == null) return;
            for (int i = root.childCount - 1; i >= 0; i--) Destroy(root.GetChild(i).gameObject);
            foreach (var q in list)
            {
                var row = Instantiate(questRowPrefab, root);
                var label = row.transform.Find("Label") as Transform;
                var lblTxt = label != null ? label.GetComponent<TMP_Text>() : null;
                if (lblTxt != null) lblTxt.text = $"{Label(q)} — {q.Prog}/{q.Goal}";
                var bar = row.transform.Find("Bar") as Transform;
                var barImg = bar != null ? bar.GetComponent<Image>() : null;
                if (barImg != null) barImg.fillAmount = q.Goal > 0 ? Mathf.Clamp01(q.Prog / (float)q.Goal) : 0f;
                var claim = row.transform.Find("Claim") as Transform;
                var claimBtn = claim != null ? claim.GetComponent<Button>() : null;
                if (claimBtn != null)
                {
                    claimBtn.interactable = !q.Claimed && q.Prog >= q.Goal;   // спека 2.3: активна только при выполнении
                    var txt = claimBtn.GetComponentInChildren<TMP_Text>();
                    if (txt != null) txt.text = q.Claimed ? "Получено" : "Забрать";
                    QuestRow captured = q;
                    claimBtn.onClick.RemoveAllListeners();
                    claimBtn.onClick.AddListener(() => Claim(captured, weekly));
                }
            }
        }

        private static string Label(QuestRow q)
        {
            switch (q.Id)
            {
                case "win_fac":
                {
                    int fi = Array.IndexOf(FactionIds, q.Fac ?? "");
                    return $"Выиграйте {q.Goal} матча фракцией {(fi >= 0 ? FactionRu[fi] : q.Fac)}";
                }
                case "runes": return $"Разыграйте {q.Goal} рун";
                case "pack": return $"Откройте {q.Goal} бустер";
                case "w_win3": return $"Неделя: выиграйте {q.Goal} матча";
                case "w_runes": return $"Неделя: разыграйте {q.Goal} рун";
                case "w_dmg": return $"Неделя: нанесите {q.Goal} урона";
                default: return q.Id;
            }
        }

        /* ---- сохранение/синхронизация ---- */

        private void SaveCache()
        {
            PlayerPrefs.SetString("ec.quests.daily", JsonSerializer.Serialize(_daily));
            PlayerPrefs.SetString("ec.quests.weekly", JsonSerializer.Serialize(_weekly));
            PlayerPrefs.SetString("ec.quests.date", _dailyDate);
            PlayerPrefs.SetString("ec.quests.week", _weeklyWeek);
            PlayerPrefs.Save();
        }

        private void ScheduleSync()
        {
            if (Time.unscaledTime < _syncAt) return;
            _syncAt = Time.unscaledTime + 2f;   // троттлинг 2с
            SaveCache();
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/profile", new
            {
                pid = MetaApi.Pid,
                quests = new
                {
                    daily = _daily.Select(q => new { id = q.Id, prog = q.Prog, goal = q.Goal, claimed = q.Claimed }),
                    weekly = _weekly.Select(q => new { id = q.Id, prog = q.Prog, goal = q.Goal, claimed = q.Claimed }),
                },
            }, (_, _) => { }));
        }
    }
}
