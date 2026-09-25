// AchievementSystem — достижения (Unity-зеркало спеки «2. Профиль» п.2.5, Промпт 3).
//  1. Список достижений — StreamingAssets/achievements.json (id, название, описание,
//     условие {type: wins|packs|bosses, value}, награда {shards, gems, frame, avatar}, иконка).
//  2. Условия проверяются на каждом событии GameEvents (победа, бустер, босс кампании).
//  3. Разблокировка → всплывающий Toast (иконка + текст) со звуком.
//  4. Прогресс сохраняется на сервере: POST /api/profile (поле ach) + локальный кэш PlayerPrefs.
// Префаб-конвенция toastPrefab: "Icon"(Image), "Text"(TMP_Text).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace EchoCitadel.UI
{
    [Serializable]
    public sealed class AchCondition
    {
        [JsonPropertyName("type")] public string Type { get; set; } = "wins";
        [JsonPropertyName("value")] public int Value { get; set; } = 1;
    }

    [Serializable]
    public sealed class AchReward
    {
        [JsonPropertyName("shards")] public int Shards { get; set; }
        [JsonPropertyName("gems")] public int Gems { get; set; }
        [JsonPropertyName("frame")] public string Frame { get; set; } = "";
        [JsonPropertyName("avatar")] public string Avatar { get; set; } = "";
    }

    [Serializable]
    public sealed class AchievementDef
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("description")] public string Description { get; set; } = "";
        [JsonPropertyName("condition")] public AchCondition Condition { get; set; } = new();
        [JsonPropertyName("reward")] public AchReward Reward { get; set; } = new();
        [JsonPropertyName("icon")] public string Icon { get; set; } = "";
    }

    [Serializable]
    public sealed class AchievementFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("achievements")] public List<AchievementDef> Achievements { get; set; } = new();
    }

    public sealed class AchievementSystem : MonoBehaviour
    {
        [SerializeField] private string baseUrl = MetaApi.DefaultBaseUrl;
        [SerializeField] private Transform? toastRoot;
        [SerializeField] private GameObject? toastPrefab;
        [SerializeField] private AudioSource? sfxSource;
        [SerializeField] private AudioClip? unlockClip;

        private List<AchievementDef> _defs = new();
        private readonly HashSet<string> _unlocked = new(StringComparer.Ordinal);
        private readonly HashSet<string> _bosses = new(StringComparer.Ordinal);
        private int _wins, _packs;

        private void OnEnable()
        {
            GameEvents.OnMatchWin += HandleMatch;
            GameEvents.OnBoosterOpened += HandleBooster;
            GameEvents.OnBossDefeated += HandleBoss;
        }

        private void OnDisable()
        {
            GameEvents.OnMatchWin -= HandleMatch;
            GameEvents.OnBoosterOpened -= HandleBooster;
            GameEvents.OnBossDefeated -= HandleBoss;
        }

        private void Start()
        {
            LoadDefs();
            LoadProgress();
            CheckAll();   // догоняющие разблокировки (например, после переноса прогресса)
        }

        /* ---- 1. achievements.json ---- */

        private void LoadDefs()
        {
            var json = FactionCatalog.ReadStreaming("achievements.json");
            if (string.IsNullOrEmpty(json))
            {
                Debug.LogError("[Achievements] StreamingAssets/achievements.json не найден");
                return;
            }
            try
            {
                var file = JsonSerializer.Deserialize<AchievementFile>(json, EchoBootJson.Options);
                _defs = file?.Achievements ?? new List<AchievementDef>();
            }
            catch (JsonException e)
            {
                Debug.LogError("[Achievements] ошибка разбора achievements.json: " + e.Message);
            }
        }

        /* ---- 2. Проверка условий на событиях ---- */

        private void HandleMatch(bool win, bool ranked, string faction)
        {
            if (!win) return;
            _wins++;
            CheckAll();
        }

        private void HandleBooster()
        {
            _packs++;
            CheckAll();
        }

        private void HandleBoss(string faction)
        {
            _bosses.Add(faction);
            CheckAll();
        }

        private int CounterFor(string type) => type switch
        {
            "wins" => _wins,
            "packs" => _packs,
            "bosses" => _bosses.Count,
            _ => 0,
        };

        private void CheckAll()
        {
            bool changed = false;
            foreach (var a in _defs)
            {
                if (_unlocked.Contains(a.Id)) continue;
                if (CounterFor(a.Condition.Type) < a.Condition.Value) continue;
                _unlocked.Add(a.Id);
                changed = true;
                GrantReward(a);
                ShowUnlockToast(a);   // 3. Toast с иконкой и звуком
            }
            if (changed)
            {
                SaveProgress();
                SyncToServer();       // 4. сохранение на сервере
            }
        }

        private void GrantReward(AchievementDef a)
        {
            // ◈/💎/рамка/аватар начисляет кошелёк игрока (MetaWallet — BLOCK 2);
            // здесь фиксируем факт выдачи для будущей сверки.
            Debug.Log($"[Achievements] «{a.Name}»: награда ◈{a.Reward.Shards} 💎{a.Reward.Gems}" +
                      $"{(string.IsNullOrEmpty(a.Reward.Frame) ? "" : " рамка " + a.Reward.Frame)}" +
                      $"{(string.IsNullOrEmpty(a.Reward.Avatar) ? "" : " аватар " + a.Reward.Avatar)}");
        }

        /* ---- 3. Toast ---- */

        private void ShowUnlockToast(AchievementDef a)
        {
            if (sfxSource != null && unlockClip != null) sfxSource.PlayOneShot(unlockClip);
            if (toastRoot == null || toastPrefab == null)
            {
                Debug.Log($"[Achievements] 🏆 {a.Name} — {a.Description}");
                return;
            }
            var toast = Instantiate(toastPrefab, toastRoot);
            var icon = toast.transform.Find("Icon") as Transform;
            var iconImg = icon != null ? icon.GetComponent<Image>() : null;
            if (iconImg != null)
            {
                var spr = Resources.Load<Sprite>($"UI/{Path.GetFileNameWithoutExtension(a.Icon)}");
                if (spr != null) iconImg.sprite = spr; else iconImg.enabled = false;
            }
            var text = toast.transform.Find("Text") as Transform;
            var txt = text != null ? text.GetComponent<TMP_Text>() : null;
            if (txt != null) txt.text = $"🏆 Достижение: {a.Name}";
            StartCoroutine(HideToast(toast));
        }

        private IEnumerator HideToast(GameObject toast)
        {
            yield return new WaitForSecondsRealtime(3.5f);
            if (toast != null) Destroy(toast);
        }

        /* ---- 4. Сохранение: локально + сервер ---- */

        private void SaveProgress()
        {
            PlayerPrefs.SetInt("ec.ach.wins", _wins);
            PlayerPrefs.SetInt("ec.ach.packs", _packs);
            PlayerPrefs.SetString("ec.ach.bosses", JsonSerializer.Serialize(_bosses.ToList()));
            PlayerPrefs.SetString("ec.ach.unlocked", JsonSerializer.Serialize(_unlocked.ToList()));
            PlayerPrefs.Save();
        }

        private void LoadProgress()
        {
            _wins = PlayerPrefs.GetInt("ec.ach.wins", 0);
            _packs = PlayerPrefs.GetInt("ec.ach.packs", 0);
            TryLoadSet("ec.ach.bosses", _bosses);
            TryLoadSet("ec.ach.unlocked", _unlocked);
        }

        private static void TryLoadSet(string key, HashSet<string> into)
        {
            var raw = PlayerPrefs.GetString(key, "");
            if (string.IsNullOrEmpty(raw)) return;
            try
            {
                foreach (var s in JsonSerializer.Deserialize<List<string>>(raw) ?? new List<string>())
                    into.Add(s);
            }
            catch (JsonException) { /* повреждённый кэш — начнём с нуля */ }
        }

        private void SyncToServer()
        {
            var ach = _defs.ToDictionary(a => a.Id, a => _unlocked.Contains(a.Id));
            // Частичный профиль: сервер мерджит отсутствующие поля из предыдущего состояния.
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/profile", new
            {
                pid = MetaApi.Pid,
                ach,
            }, (code, _) =>
            {
                if (code != 200)
                    Debug.Log($"[Achievements] сервер недоступен (код {code}) — прогресс сохранён локально");
            }));
        }

        /// Публичный прогресс для списков UI (профиль: «Достижения» — прогресс p/g).
        public (int Prog, int Goal, bool Done) ProgressOf(string id)
        {
            var a = _defs.FirstOrDefault(x => x.Id == id);
            if (a == null) return (0, 0, false);
            int p = CounterFor(a.Condition.Type);
            return (Math.Min(p, a.Condition.Value), a.Condition.Value, _unlocked.Contains(id));
        }

        public IReadOnlyList<AchievementDef> Defs => _defs;
    }
}
