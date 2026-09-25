// ProfileScreen — экран профиля (Unity-зеркало спеки «2. Профиль», Промпт 1).
//  1. Загрузка данных с сервера: GET /api/profile?pid=… (офлайн-фолбэк: локальный кэш PlayerPrefs).
//  2. Шапка: аватар, никнейм (клик → редактирование: 3–16 симв., без мата, уникальность на сервере),
//     уровень + XP-прогресс-бар (Level Up — анимация с частицами), ранг + прогресс до следующего.
//  3. Вкладки Общая/Фракции/История/Друзья — переключение панелей БЕЗ перезагрузки сцены.
//  4. Вкладка «Фракции»: круговая диаграмма винрейта — Image.fillAmount на каждый сегмент.
//  5. Вкладка «История»: строки-префабы MatchHistoryItem (дата, противник, фракция, результат,
//     длительность, кнопка «Реплей»).
// Префаб-конвенции (имена детей):
//   matchHistoryItemPrefab: "Date","Foe","EFac","Result","Duration" (TMP), "ReplayButton" (Button)
//   factionRowPrefab:       "Name"(TMP), "WL"(TMP), "Bar"(Image fillAmount), кнопка на корне
//   matchupRowPrefab:       "Text"(TMP)
//   friendRowPrefab:        "Nick"(TMP), "Dot"(Image), "Invite"(Button), "Remove"(Button)
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace EchoCitadel.UI
{
    /* ---- DTO профиля (форма ответа meta_server /api/profile) ---- */
    [Serializable]
    public sealed class HistoryRow
    {
        [JsonPropertyName("ts")] public long Ts { get; set; }
        [JsonPropertyName("win")] public bool Win { get; set; }
        [JsonPropertyName("fac")] public string Fac { get; set; } = "";
        [JsonPropertyName("efac")] public string? Efac { get; set; }
        [JsonPropertyName("foe")] public string? Foe { get; set; }
        [JsonPropertyName("turns")] public int Turns { get; set; }
        [JsonPropertyName("practice")] public bool Practice { get; set; }
    }

    [Serializable]
    public sealed class ProfileDto
    {
        [JsonPropertyName("pid")] public string Pid { get; set; } = "";
        [JsonPropertyName("nick")] public string Nick { get; set; } = "Гость";
        [JsonPropertyName("level")] public int Level { get; set; } = 1;
        [JsonPropertyName("xp")] public int Xp { get; set; }
        [JsonPropertyName("mmr")] public int Mmr { get; set; } = 1000;
        [JsonPropertyName("bestMmr")] public int BestMmr { get; set; } = 1000;
        [JsonPropertyName("wins")] public int Wins { get; set; }
        [JsonPropertyName("losses")] public int Losses { get; set; }
        [JsonPropertyName("avatarFac")] public string AvatarFac { get; set; } = "Aurites";
        [JsonPropertyName("frame")] public string Frame { get; set; } = "bronze";
        [JsonPropertyName("history")] public List<HistoryRow> History { get; set; } = new();
    }

    public sealed class ProfileScreen : MonoBehaviour
    {
        [Header("Сервер")]
        [SerializeField] private string baseUrl = MetaApi.DefaultBaseUrl;

        [Header("Шапка (п.2.1)")]
        [SerializeField] private Image? avatarImage;
        [SerializeField] private TMP_InputField? nickInput;
        [SerializeField] private TMP_Text? levelText, rankText;
        [SerializeField] private Image? xpBar, rankBar;           // type=Filled, fillAmount
        [SerializeField] private GameObject? levelUpFx;           // анимация + ParticleSystem
        [SerializeField] private AudioSource? sfxSource;
        [SerializeField] private AudioClip? levelUpClip;

        [Header("Вкладки (п.2.2) — без перезагрузки сцены")]
        [SerializeField] private List<Button> tabButtons = new();
        [SerializeField] private List<GameObject> tabPanels = new();  // Общая/Фракции/История/Друзья

        [Header("Вкладка «Фракции»: круговая диаграмма")]
        [SerializeField] private List<Image> pieSegments = new();     // 5 Image (type=Filled), pivots в центре
        [SerializeField] private TMP_Text? pieCenterText;
        [SerializeField] private Transform? factionRowsRoot;
        [SerializeField] private GameObject? factionRowPrefab;
        [SerializeField] private Transform? matchupRoot;              // детали: винрейт против каждой фракции
        [SerializeField] private GameObject? matchupRowPrefab;

        [Header("Вкладка «История»")]
        [SerializeField] private Transform? historyRoot;
        [SerializeField] private GameObject? matchHistoryItemPrefab;

        [Header("Вкладка «Друзья»")]
        [SerializeField] private Transform? friendsRoot;
        [SerializeField] private GameObject? friendRowPrefab;
        [SerializeField] private TMP_InputField? friendNickInput;
        [SerializeField] private Button? btnFriendAdd;

        private static readonly string[] FactionIds = { "Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal" };
        private static readonly string[] FactionRu = { "Ауриты", "Некрусы", "Терраморфы", "Пироманты", "Эфирные" };
        private static readonly Color[] FactionColors =
        {
            new Color(0.96f, 0.84f, 0.43f), new Color(0.56f, 0.27f, 0.68f), new Color(0.31f, 0.56f, 0.23f),
            new Color(1.00f, 0.48f, 0.09f), new Color(0.25f, 0.84f, 0.78f),
        };

        private const string LocalCacheKey = "ec.profile.cache";
        private ProfileDto _p = new();
        private int _tab;
        private string? _detailFaction;

        /* Ранговая лестница — как rankOf() в прототипе. */
        private static readonly (string Title, int Min, int Div)[] Ranks =
        {
            ("Ученик", 800, 0), ("Адепт", 1000, 3), ("Магистр", 1300, 3), ("Архимаг", 1600, 3), ("Легенда", 1900, 0),
        };

        private void Start()
        {
            for (int i = 0; i < tabButtons.Count; i++)
            {
                int idx = i;
                if (tabButtons[i] != null) tabButtons[i].onClick.AddListener(() => SwitchTab(idx));
            }
            if (nickInput != null) nickInput.onEndEdit.AddListener(OnNickEdited);
            if (btnFriendAdd != null) btnFriendAdd.onClick.AddListener(OnAddFriend);
            StartCoroutine(LoadProfile());
        }

        /* ---- 1. Загрузка с сервера (офлайн-фолбэк: локальный кэш) ---- */

        public IEnumerator LoadProfile()
        {
            bool fromServer = false;
            yield return MetaApi.Get(this, baseUrl, $"/api/profile?pid={MetaApi.Pid}", root =>
            {
                if (root == null) return;
                try
                {
                    var dto = JsonSerializer.Deserialize<ProfileDto>(root.Value.GetRawText(), EchoBootJson.Options);
                    if (dto != null) { _p = dto; fromServer = true; }
                }
                catch (JsonException) { /* повреждённый ответ — работаем с кэшем */ }
            });
            if (!fromServer)
            {
                var cache = PlayerPrefs.GetString(LocalCacheKey, "");
                if (!string.IsNullOrEmpty(cache))
                {
                    try { _p = JsonSerializer.Deserialize<ProfileDto>(cache, EchoBootJson.Options) ?? _p; }
                    catch (JsonException) { /* кэш повреждён — дефолты */ }
                }
                Debug.Log("[Profile] сервер недоступен — профиль из локального кэша");
            }
            _p.Pid = MetaApi.Pid;
            RefreshAll();
        }

        /// Сохранение на сервер + локальный кэш (вызывать после любых изменений).
        public void SaveProfile()
        {
            PlayerPrefs.SetString(LocalCacheKey, JsonSerializer.Serialize(_p));
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/profile", new
            {
                pid = _p.Pid, nick = _p.Nick, level = _p.Level, xp = _p.Xp, mmr = _p.Mmr,
                bestMmr = _p.BestMmr, wins = _p.Wins, losses = _p.Losses,
                avatarFac = _p.AvatarFac, frame = _p.Frame,
                history = _p.History.Take(20),
            }, (_, _) => { }));
        }

        /* ---- 2. Шапка ---- */

        private void RefreshAll()
        {
            RefreshHeader();
            RefreshFactions();
            RefreshHistory();
            RefreshFriends();
            SwitchTab(_tab);
        }

        private void RefreshHeader()
        {
            int prevLevel = _p.Level;
            _p.Level = _p.Xp / 500 + 1;
            if (levelText != null) levelText.text = $"Уровень {_p.Level}";
            if (xpBar != null) xpBar.fillAmount = (_p.Xp % 500) / 500f;
            var (title, prog) = RankOf(_p.Mmr);
            if (rankText != null) rankText.text = title;
            if (rankBar != null) rankBar.fillAmount = Mathf.Clamp01(prog);
            if (avatarImage != null)
            {
                var spr = Resources.Load<Sprite>($"Heroes/{_p.AvatarFac}");
                if (spr != null) avatarImage.sprite = spr;
            }
            if (nickInput != null && !nickInput.isFocused) nickInput.SetTextWithoutNotify(_p.Nick);
            if (_p.Level > prevLevel && prevLevel > 0) PlayLevelUp();
        }

        private void PlayLevelUp()
        {
            if (sfxSource != null && levelUpClip != null) sfxSource.PlayOneShot(levelUpClip);
            if (levelUpFx != null)
            {
                levelUpFx.SetActive(true);
                var ps = levelUpFx.GetComponentInChildren<ParticleSystem>();
                if (ps != null) ps.Play();
                StartCoroutine(HideLater(levelUpFx, 2.6f));
            }
        }

        private IEnumerator HideLater(GameObject go, float secs)
        {
            yield return new WaitForSecondsRealtime(secs);
            if (go != null) go.SetActive(false);
        }

        private static (string Title, float Prog) RankOf(int mmr)
        {
            for (int i = Ranks.Length - 1; i >= 0; i--)
            {
                if (mmr >= Ranks[i].Min)
                {
                    if (Ranks[i].Div == 0) return (Ranks[i].Title, 1f);
                    int next = i + 1 < Ranks.Length ? Ranks[i + 1].Min : Ranks[i].Min + 300;
                    int span = Mathf.Max(1, next - Ranks[i].Min);
                    float into = (mmr - Ranks[i].Min) / (float)span;
                    int div = Ranks[i].Div - Mathf.Min(Ranks[i].Div - 1, (int)(into * Ranks[i].Div));
                    return ($"{Ranks[i].Title} {ToRoman(div)}", into);
                }
            }
            return (Ranks[0].Title, 0f);
        }

        private static string ToRoman(int n) => n switch { 3 => "III", 2 => "II", 1 => "I", _ => "" };

        /* Никнейм: 3–16 символов, допустимые символы, без мата; уникальность — GET /api/profile/nick. */
        private void OnNickEdited(string raw)
        {
            var v = (raw ?? "").Trim();
            string prev = _p.Nick;
            if (v.Length == 0 || v == prev) { if (nickInput != null) nickInput.SetTextWithoutNotify(prev); return; }
            if (v.Length < 3 || v.Length > 16) { NickRejected(prev, "Никнейм: от 3 до 16 символов"); return; }
            if (!System.Text.RegularExpressions.Regex.IsMatch(v, @"^[\wА-Яа-яЁё .-]{3,16}$"))
            { NickRejected(prev, "Никнейм: только буквы, цифры, пробел, точка, дефис, подчёркивание"); return; }
            if (System.Text.RegularExpressions.Regex.IsMatch(v,
                @"(ху[йяюеи]|пизд|еб[а-яу]|бля|сук[аи]|муд[ао]к|говн|дроч|fuck|shit|bitch|asshole)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            { NickRejected(prev, "Никнейм: недопустимые слова"); return; }
            _p.Nick = v;
            SaveProfile();
            StartCoroutine(CheckNickFree(v, prev));
        }

        private void NickRejected(string prev, string reason)
        {
            Debug.Log("[Profile] " + reason);
            if (nickInput != null) nickInput.SetTextWithoutNotify(prev);
        }

        private IEnumerator CheckNickFree(string v, string prev)
        {
            bool free = true;
            yield return MetaApi.Get(this, baseUrl,
                $"/api/profile/nick?nick={UnityWebRequest.EscapeURL(v)}&pid={MetaApi.Pid}",
                root =>
                {
                    if (root != null && root.Value.TryGetProperty("free", out var f) && f.ValueKind == JsonValueKind.False)
                        free = false;
                });
            if (!free && _p.Nick == v)
            {
                _p.Nick = prev;
                SaveProfile();
                NickRejected(prev, $"Никнейм «{v}» занят другим игроком");
                RefreshHeader();
            }
        }

        /* ---- 3. Вкладки без перезагрузки сцены ---- */

        public void SwitchTab(int idx)
        {
            _tab = Mathf.Clamp(idx, 0, Mathf.Max(0, tabPanels.Count - 1));
            for (int i = 0; i < tabPanels.Count; i++)
                if (tabPanels[i] != null) tabPanels[i].SetActive(i == _tab);
        }

        /* ---- 4. Вкладка «Фракции»: круговая диаграмма Image.fillAmount ---- */

        private void RefreshFactions()
        {
            var wins = FactionIds.Select(f => _p.History.Count(h => h.Win && h.Fac == f)).ToList();
            int total = Mathf.Max(1, wins.Sum());
            float acc = 0f;
            for (int i = 0; i < pieSegments.Count && i < FactionIds.Length; i++)
            {
                var seg = pieSegments[i];
                if (seg == null) continue;
                seg.type = Image.Type.Filled;
                seg.fillAmount = wins[i] / (float)total;
                // Сегменты накладываются друг на другом: поворот на накопленный угол.
                seg.rectTransform.localRotation = Quaternion.Euler(0f, 0f, -acc * 360f);
                seg.color = FactionColors[i];
                acc += wins[i] / (float)total;
            }
            if (pieCenterText != null) pieCenterText.text = _p.Wins.ToString(CultureInfo.InvariantCulture);

            if (factionRowsRoot != null && factionRowPrefab != null)
            {
                ClearChildren(factionRowsRoot);
                for (int i = 0; i < FactionIds.Length; i++)
                {
                    string fid = FactionIds[i];
                    int w = _p.History.Count(h => h.Win && h.Fac == fid);
                    int l = _p.History.Count(h => !h.Win && h.Fac == fid);
                    var row = Instantiate(factionRowPrefab, factionRowsRoot);
                    SetText(row, "Name", FactionRu[i]);
                    SetText(row, "WL", $"{w}–{l} · {(w + l > 0 ? Mathf.RoundToInt(100f * w / (w + l)) : 0)}%");
                    var bar = row.transform.Find("Bar") as Transform;
                    var barImg = bar != null ? bar.GetComponent<Image>() : null;
                    if (barImg != null) { barImg.fillAmount = w + l > 0 ? w / (float)(w + l) : 0f; barImg.color = FactionColors[i]; }
                    var btn = row.GetComponent<Button>();
                    if (btn != null) btn.onClick.AddListener(() => ShowMatchups(fid));
                }
            }
            if (_detailFaction != null) ShowMatchups(_detailFaction);
            else if (matchupRoot != null) ClearChildren(matchupRoot);
        }

        /// Клик по фракции → детальная статистика: винрейт против каждой фракции (по истории матчей).
        private void ShowMatchups(string fid)
        {
            _detailFaction = _detailFaction == fid ? null : fid;
            if (matchupRoot == null) return;
            ClearChildren(matchupRoot);
            if (_detailFaction == null) return;
            int fi = Array.IndexOf(FactionIds, fid);
            AddMatchupRow($"▾ {(fi >= 0 ? FactionRu[fi] : fid)} — винрейт против фракций");
            foreach (var en in FactionIds.Where(x => x != fid))
            {
                var hs = _p.History.Where(h => h.Fac == fid && h.Efac == en).ToList();
                int w = hs.Count(h => h.Win), l = hs.Count - w;
                int ei = Array.IndexOf(FactionIds, en);
                AddMatchupRow(hs.Count > 0
                    ? $"vs {FactionRu[ei]}: {w}–{l} · {Mathf.RoundToInt(100f * w / hs.Count)}%"
                    : $"vs {FactionRu[ei]}: матчей не было");
            }
        }

        private void AddMatchupRow(string text)
        {
            if (matchupRoot == null || matchupRowPrefab == null) return;
            var row = Instantiate(matchupRowPrefab, matchupRoot);
            SetText(row, "Text", text);
        }

        /* ---- 5. Вкладка «История»: MatchHistoryItem-префабы ---- */

        private void RefreshHistory()
        {
            if (historyRoot == null || matchHistoryItemPrefab == null) return;
            ClearChildren(historyRoot);
            foreach (var h in _p.History.Take(20))
            {
                var item = Instantiate(matchHistoryItemPrefab, historyRoot);
                var date = DateTimeOffset.FromUnixTimeMilliseconds(h.Ts).LocalDateTime;
                SetText(item, "Date", date.ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture));
                SetText(item, "Foe", h.Foe ?? "ИИ");
                int ei = Array.IndexOf(FactionIds, h.Efac ?? "");
                SetText(item, "EFac", ei >= 0 ? FactionRu[ei] : "—");
                SetText(item, "Result", h.Win ? "✔ Победа" : "✘ Поражение");
                SetText(item, "Duration", $"{h.Turns} х.{(h.Practice ? " · тренировка" : "")}");
                var rp = item.transform.Find("ReplayButton") as Transform;
                var rpBtn = rp != null ? rp.GetComponent<Button>() : null;
                if (rpBtn != null)
                {
                    long ts = h.Ts;
                    rpBtn.onClick.AddListener(() => OnReplay(ts));
                }
            }
        }

        private void OnReplay(long ts)
        {
            // Реплеи — локальные логи событий (как meta.replays в прототипе); UI реплея — отдельный экран.
            Debug.Log($"[Profile] Реплей матча ts={ts}: откройте ReplayScreen (локальные логи матчей).");
        }

        /* ---- Вкладка «Друзья» (локальный список до появления лобби-сервера) ---- */

        private void RefreshFriends()
        {
            if (friendsRoot == null || friendRowPrefab == null) return;
            ClearChildren(friendsRoot);
            var friends = LoadFriends();
            foreach (var nick in friends)
            {
                var row = Instantiate(friendRowPrefab, friendsRoot);
                SetText(row, "Nick", nick);
                var dot = row.transform.Find("Dot") as Transform;
                var dotImg = dot != null ? dot.GetComponent<Image>() : null;
                bool online = (nick.GetHashCode() + DateTime.Now.Hour) % 3 != 0;   // демо-статус до лобби-сервера
                if (dotImg != null) dotImg.color = online ? new Color(0.4f, 0.9f, 0.4f) : new Color(0.5f, 0.5f, 0.5f);
                string n = nick;
                var invite = row.transform.Find("Invite") as Transform;
                var inviteBtn = invite != null ? invite.GetComponent<Button>() : null;
                if (inviteBtn != null) inviteBtn.onClick.AddListener(() => Debug.Log($"[Profile] Приглашение в лобби: {n}"));
                var remove = row.transform.Find("Remove") as Transform;
                var removeBtn = remove != null ? remove.GetComponent<Button>() : null;
                if (removeBtn != null) removeBtn.onClick.AddListener(() => { RemoveFriend(n); RefreshFriends(); });
            }
        }

        private void OnAddFriend()
        {
            if (friendNickInput == null) return;
            var nick = (friendNickInput.text ?? "").Trim();
            if (nick.Length < 3 || nick.Length > 16) { Debug.Log("[Profile] Ник друга: 3–16 символов"); return; }
            var friends = LoadFriends();
            if (friends.Contains(nick)) { Debug.Log("[Profile] Уже в друзьях"); return; }
            if (friends.Count >= 20) { Debug.Log("[Profile] Максимум 20 друзей"); return; }
            friends.Add(nick);
            PlayerPrefs.SetString("ec.friends", JsonSerializer.Serialize(friends));
            friendNickInput.SetTextWithoutNotify("");
            RefreshFriends();
        }

        private void RemoveFriend(string nick)
        {
            var friends = LoadFriends();
            friends.Remove(nick);
            PlayerPrefs.SetString("ec.friends", JsonSerializer.Serialize(friends));
        }

        private static List<string> LoadFriends()
        {
            var raw = PlayerPrefs.GetString("ec.friends", "[]");
            try { return JsonSerializer.Deserialize<List<string>>(raw) ?? new List<string>(); }
            catch (JsonException) { return new List<string>(); }
        }

        /* ---- утилиты ---- */

        private static void SetText(GameObject go, string child, string value)
        {
            var tr = go.transform.Find(child);
            if (tr == null) return;
            var txt = tr.GetComponent<TMP_Text>();
            if (txt != null) txt.text = value;
        }

        private static void ClearChildren(Transform root)
        {
            for (int i = root.childCount - 1; i >= 0; i--) Destroy(root.GetChild(i).gameObject);
        }
    }
}
