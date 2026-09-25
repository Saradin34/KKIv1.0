// MainMenuController — главное меню «Эхо-Цитадели» (Unity-зеркало спеки «1. Главное меню»).
// Реализует: 1.1 карусель фракций (выбор, подсветка, кроссфейд фона 0.5с, whoosh, PlayerPrefs),
// 1.2 панель «Ваша фракция» + модалка подробностей (данные из factions.json),
// 1.3 настройки матча (противник + «Случайно», 4 сложности, колоды, «Тренировка»),
// 1.4 «В БОЙ» (гейт валидности 40 карт/лимиты копий + POST /api/match/start → match_id),
// 1.5 нижняя навигация (overlay-панели с «пружиной», без смены сцены).
//
// Соглашения по префабам (все — простые контейнеры, поля ищутся по имени ребёнка):
//   chipPrefab:         Image-фон, Button, дети "Sigil"(TMP), "Name"(TMP), "Ico"(Image), "Sel"(GameObject)
//   factionCardPrefab:  Button, дети "Name"(TMP), "Tagline"(TMP), "Passive"(TMP), "Sel"(GameObject)
//   tipPrefab:          TMP_Text (буллет совета)
//   exampleCardPrefab:  дети "Name"(TMP), "Cost"(TMP)
// Текстуры/иконки: Assets/Resources/UI/menu_<faction>.png и ico_fac_N.png (копии из prototype/img).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using TMPro;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using EchoCitadel.Core;
using EchoCitadel.Data;

namespace EchoCitadel.UI
{
    public sealed class MainMenuController : MonoBehaviour
    {
        [Header("Карусель и панель фракций (п.1.1–1.2)")]
        [SerializeField] private Transform? carouselRoot;
        [SerializeField] private GameObject? chipPrefab;
        [SerializeField] private Transform? factionPanelRoot;
        [SerializeField] private GameObject? factionCardPrefab;
        [SerializeField] private CanvasGroup? bgCurrent;   // текущий фон меню
        [SerializeField] private CanvasGroup? bgFade;      // слой кроссфейда (0.5с)
        [SerializeField] private Image[] paletteTargets = Array.Empty<Image>(); // палитра UI по фракции

        [Header("Модалка фракции (п.1.2)")]
        [SerializeField] private GameObject? factionModal;
        [SerializeField] private TMP_Text? facSigil, facName, facTagline, facDesc, facMech;
        [SerializeField] private Transform? facTipsRoot;
        [SerializeField] private GameObject? tipPrefab;
        [SerializeField] private Transform? facExamplesRoot;
        [SerializeField] private GameObject? exampleCardPrefab;
        [SerializeField] private Button? btnFactionPlay, btnFactionClose;

        [Header("Настройки матча (п.1.3)")]
        [SerializeField] private TMP_Dropdown? enemyDropdown, difficultyDropdown, deckDropdown;
        [SerializeField] private Toggle? practiceToggle;
        [SerializeField] private Button? btnMakeDeck, btnPlay;
        [SerializeField] private TMP_Text? playHint;       // подсказка «Колода не собрана: …»
        [SerializeField] private GameObject? deckBuilderRoot; // панель конструктора колод (опц.)

        [Header("Нижняя навигация (п.1.5)")]
        [SerializeField] private List<Button> navButtons = new();
        [SerializeField] private List<RectTransform> overlayPanels = new();  // 1:1 с navButtons

        [Header("Звук и сервер")]
        [SerializeField] private AudioSource? sfxSource;
        [SerializeField] private AudioClip? whooshClip;    // смена фракции (в прототипе — синтез)
        [SerializeField] private string matchServerUrl = "http://127.0.0.1:8080";
        [SerializeField] private string battleSceneName = "Battle"; // должна быть в Build Settings

        /* Ключи PlayerPrefs (спека п.1.1: игра помнит выбор между запусками). */
        private const string K_Faction = "ec.faction", K_Enemy = "ec.enemy",
            K_Diff = "ec.difficulty", K_Deck = "ec.deck", K_Practice = "ec.practice";

        /* 4 уровня сложности (решение пользователя: спека «3 уровня» расширена «Учеником»). */
        private static readonly string[] DiffNames = { "Ученик", "Адепт", "Магистр", "Мифический" };
        private static readonly float[] DiffValues = { 0.6f, 0.8f, 0.95f, 1.05f };

        private string _picked = "Aurites";
        private string _modalFaction = "Aurites";
        private string? _lastMatchId;
        private CardDatabase? _db;
        private DeckFile? _decks;

        private static readonly AnimationCurve Spring = new(
            new Keyframe(0f, 0f), new Keyframe(0.72f, 1.05f), new Keyframe(1f, 1f));

        private void Start()
        {
            var boot = EchoBoot.Instance;
            _db = boot != null ? boot.Db : null;
            _decks = boot != null ? boot.Decks : null;

            _picked = PlayerPrefs.GetString(K_Faction, _picked);
            if (FactionCatalog.ById(_picked) == null) _picked = "Aurites";

            BuildCarousel();
            BuildFactionPanel();
            BuildEnemyDropdown();
            BuildDifficultyDropdown();
            BuildDeckDropdown();

            if (practiceToggle != null)
            {
                practiceToggle.isOn = PlayerPrefs.GetInt(K_Practice, 0) == 1;
                practiceToggle.onValueChanged.AddListener(v => PlayerPrefs.SetInt(K_Practice, v ? 1 : 0));
            }
            if (btnMakeDeck != null) btnMakeDeck.onClick.AddListener(OnMakeDeck);
            if (btnPlay != null) btnPlay.onClick.AddListener(OnPlay);
            if (btnFactionPlay != null) btnFactionPlay.onClick.AddListener(() => { PickFaction(_modalFaction); CloseFactionModal(); });
            if (btnFactionClose != null) btnFactionClose.onClick.AddListener(CloseFactionModal);
            for (int i = 0; i < navButtons.Count && i < overlayPanels.Count; i++)
            {
                int idx = i;
                if (navButtons[i] != null) navButtons[i].onClick.AddListener(() => OpenOverlay(idx));
            }

            ApplyPalette();
            var tex = TextureFor(_picked);
            if (tex != null && bgCurrent != null)
            {
                var img = bgCurrent.GetComponent<Image>();
                if (img != null) img.sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f));
            }
            UpdatePlayGate();
        }

        /* ---------------- 1.1 Карусель фракций ---------------- */

        private void BuildCarousel()
        {
            if (carouselRoot == null || chipPrefab == null) return;
            ClearChildren(carouselRoot);
            foreach (var info in FactionCatalog.Load().Factions)
            {
                var chip = Instantiate(chipPrefab, carouselRoot);
                SetText(chip, "Sigil", info.Sigil);
                SetText(chip, "Name", info.Name);
                var ico = chip.transform.Find("Ico") as Transform;
                var icoImg = ico != null ? ico.GetComponent<Image>() : null;
                if (icoImg != null)
                {
                    var spr = Resources.Load<Sprite>($"UI/{Path.GetFileNameWithoutExtension(info.Icon)}");
                    if (spr != null) icoImg.sprite = spr; else icoImg.enabled = false;
                }
                MarkSelected(chip, info.Id == _picked);
                string id = info.Id;
                var btn = chip.GetComponent<Button>();
                if (btn != null) btn.onClick.AddListener(() => PickFaction(id));
            }
        }

        /// Выбор фракции: сохранение (PlayerPrefs), whoosh, кроссфейд фона 0.5с, палитра UI.
        public void PickFaction(string id)
        {
            if (FactionCatalog.ById(id) == null || id == _picked) return;
            _picked = id;
            PlayerPrefs.SetString(K_Faction, id);
            PlayerPrefs.Save();
            if (sfxSource != null && whooshClip != null) sfxSource.PlayOneShot(whooshClip);
            ApplyPalette();
            RefreshSelection();
            BuildEnemyDropdown();          // список противников исключает свою фракцию
            StartCoroutine(CrossfadeBackground());
        }

        private void ApplyPalette()
        {
            var info = FactionCatalog.ById(_picked);
            if (info == null) return;
            var col = info.Color.PrimaryColor;
            foreach (var t in paletteTargets)
                if (t != null) t.color = col;
        }

        private IEnumerator CrossfadeBackground()
        {
            var tex = TextureFor(_picked);
            if (tex == null || bgCurrent == null || bgFade == null) yield break;
            var sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f));
            var fadeImg = bgFade.GetComponent<Image>();
            if (fadeImg != null) fadeImg.sprite = sprite;
            bgFade.gameObject.SetActive(true);
            const float dur = 0.5f;        // спека: кроссфейд 0.5 сек
            for (float t = 0f; t < dur; t += Time.unscaledDeltaTime)
            {
                bgFade.alpha = Mathf.Clamp01(t / dur);
                bgCurrent.alpha = 1f - bgFade.alpha;
                yield return null;
            }
            bgFade.alpha = 1f; bgCurrent.alpha = 0f;
            var curImg = bgCurrent.GetComponent<Image>();
            if (curImg != null) curImg.sprite = sprite;
            bgCurrent.alpha = 1f; bgFade.alpha = 0f;
            bgFade.gameObject.SetActive(false);
        }

        private static Texture2D? TextureFor(string factionId) =>
            Resources.Load<Texture2D>($"UI/menu_{factionId.ToLowerInvariant()}");

        /* ---------------- 1.2 Панель «Ваша фракция» + модалка ---------------- */

        private void BuildFactionPanel()
        {
            if (factionPanelRoot == null || factionCardPrefab == null) return;
            ClearChildren(factionPanelRoot);
            foreach (var info in FactionCatalog.Load().Factions)
            {
                var card = Instantiate(factionCardPrefab, factionPanelRoot);
                SetText(card, "Name", info.Name);
                SetText(card, "Tagline", info.Tagline);
                SetText(card, "Passive", info.Mechanics);
                MarkSelected(card, info.Id == _picked);
                string id = info.Id;
                var btn = card.GetComponent<Button>();
                if (btn != null) btn.onClick.AddListener(() => OpenFactionModal(id));
            }
        }

        public void OpenFactionModal(string id)
        {
            var info = FactionCatalog.ById(id);
            if (info == null || factionModal == null) return;
            _modalFaction = id;
            if (facSigil != null) { facSigil.text = info.Sigil; facSigil.color = info.Color.PrimaryColor; }
            if (facName != null) facName.text = info.Name;
            if (facTagline != null) facTagline.text = info.Tagline;
            if (facDesc != null) facDesc.text = info.Description;
            if (facMech != null) facMech.text = info.Mechanics;
            if (facTipsRoot != null && tipPrefab != null)
            {
                ClearChildren(facTipsRoot);
                foreach (var tip in info.Tips)
                {
                    var t = Instantiate(tipPrefab, facTipsRoot);
                    var txt = t.GetComponent<TMP_Text>();
                    if (txt != null) txt.text = "• " + tip;
                }
            }
            if (facExamplesRoot != null && exampleCardPrefab != null)
            {
                ClearChildren(facExamplesRoot);
                var examples = (_db != null ? _db.Cards.Values : Enumerable.Empty<CardData>())
                    .Where(c => c.Faction.ToString() == id)
                    .OrderBy(c => c.Cost).ThenBy(c => c.Id, StringComparer.Ordinal)
                    .Take(3);
                foreach (var c in examples)
                {
                    var ex = Instantiate(exampleCardPrefab, facExamplesRoot);
                    SetText(ex, "Name", c.Name);
                    SetText(ex, "Cost", c.Cost.ToString());
                }
            }
            if (btnFactionPlay != null)
            {
                var lbl = btnFactionPlay.GetComponentInChildren<TMP_Text>();
                if (lbl != null) lbl.text = id == _picked ? "Выбрана ✓" : $"Играть за «{info.Name}»";
            }
            factionModal.SetActive(true);
            var rt = factionModal.transform as RectTransform;
            if (rt != null) StartCoroutine(SpringPanel(rt));
        }

        public void CloseFactionModal()
        {
            if (factionModal != null) factionModal.SetActive(false);
        }

        /* ---------------- 1.3 Настройки матча ---------------- */

        private void BuildEnemyDropdown()
        {
            if (enemyDropdown == null) return;
            var ids = FactionCatalog.Load().Factions.Select(f => f.Id).Where(i => i != _picked).ToList();
            var names = ids.Select(i => FactionCatalog.ById(i)?.Name ?? i).ToList();
            names.Add("Случайно");
            ids.Add("__random");
            var saved = PlayerPrefs.GetString(K_Enemy, "__random");
            int idx = ids.IndexOf(saved);
            enemyDropdown.ClearOptions();
            enemyDropdown.AddOptions(names);
            enemyDropdown.value = idx >= 0 ? idx : ids.Count - 1;
            enemyDropdown.onValueChanged.RemoveAllListeners();
            enemyDropdown.onValueChanged.AddListener(v => PlayerPrefs.SetString(K_Enemy, ids[v]));
        }

        private void BuildDifficultyDropdown()
        {
            if (difficultyDropdown == null) return;
            difficultyDropdown.ClearOptions();
            difficultyDropdown.AddOptions(DiffNames.ToList());
            difficultyDropdown.value = Mathf.Clamp(PlayerPrefs.GetInt(K_Diff, 1), 0, DiffNames.Length - 1);
            difficultyDropdown.onValueChanged.RemoveAllListeners();
            difficultyDropdown.onValueChanged.AddListener(v => PlayerPrefs.SetInt(K_Diff, v));
        }

        private void BuildDeckDropdown()
        {
            if (deckDropdown == null || _decks == null) return;
            var ids = _decks.Decks.Select(d => d.Id).ToList();
            var names = _decks.Decks.Select(d => $"{d.Name} · база ({d.Cards.Count})").ToList();
            // TODO(BLOCK 2): пользовательские колоды из DeckStorage (PlayerPrefs/JSON) — как deckstore.ts.
            var saved = PlayerPrefs.GetString(K_Deck, ids.Count > 0 ? ids[0] : "");
            int idx = ids.IndexOf(saved);
            deckDropdown.ClearOptions();
            deckDropdown.AddOptions(names);
            deckDropdown.value = idx >= 0 ? idx : 0;
            deckDropdown.onValueChanged.RemoveAllListeners();
            deckDropdown.onValueChanged.AddListener(v => { PlayerPrefs.SetString(K_Deck, ids[v]); UpdatePlayGate(); });
        }

        private void OnMakeDeck()
        {
            if (deckBuilderRoot != null)
            {
                deckBuilderRoot.SetActive(true);
                var rt = deckBuilderRoot.transform as RectTransform;
                if (rt != null) StartCoroutine(SpringPanel(rt));
            }
            else Debug.Log("[MainMenu] Конструктор колод: подключите deckBuilderRoot (или сцену DeckBuilder).");
        }

        /* ---------------- 1.4 «В БОЙ»: гейт + POST /api/match/start ---------------- */

        /// Гейт валидности (решение пользователя: 40 карт, лимиты 4/1 — как deckstore.validateDeckSize).
        private void UpdatePlayGate()
        {
            if (btnPlay == null) return;
            var problems = ValidateSelectedDeck();
            btnPlay.interactable = problems.Count == 0;
            if (playHint != null) playHint.text = problems.Count > 0 ? $"Колода не собрана: {problems[0]}" : "";
        }

        private List<string> ValidateSelectedDeck()
        {
            var problems = new List<string>();
            var deck = SelectedDeck();
            if (deck == null || _db == null) { problems.Add("колода не найдена"); return problems; }
            if (deck.Cards.Count != 40) problems.Add($"нужно ровно 40 карт, сейчас {deck.Cards.Count}");
            foreach (var g in deck.Cards.GroupBy(x => x, StringComparer.Ordinal))
            {
                var card = _db.GetCard(g.Key);
                if (card == null) { problems.Add($"неизвестная карта {g.Key}"); continue; }
                int cap = card.Rarity == Rarity.Legendary ? 1 : 4;
                if (g.Count() > cap) problems.Add($"«{card.Name}»: копий {g.Count()}, максимум {cap}");
            }
            return problems;
        }

        private DeckEntry? SelectedDeck()
        {
            if (_decks == null || deckDropdown == null) return null;
            var id = PlayerPrefs.GetString(K_Deck, "");
            return _decks.Decks.FirstOrDefault(d => d.Id == id) ?? _decks.Decks.FirstOrDefault();
        }

        private void OnPlay()
        {
            if (ValidateSelectedDeck().Count > 0 || _db == null) { UpdatePlayGate(); return; }
            StartCoroutine(PlayFlow());
        }

        private IEnumerator PlayFlow()
        {
            var deck = SelectedDeck();
            var enemyIds = FactionCatalog.Load().Factions.Select(f => f.Id).Where(i => i != _picked).ToList();
            var enemySaved = PlayerPrefs.GetString(K_Enemy, "__random");
            string enemy = enemySaved == "__random" || !enemyIds.Contains(enemySaved)
                ? enemyIds[UnityEngine.Random.Range(0, Mathf.Max(1, enemyIds.Count))]
                : enemySaved;
            float diff = DiffValues[Mathf.Clamp(PlayerPrefs.GetInt(K_Diff, 1), 0, DiffValues.Length - 1)];
            bool practice = PlayerPrefs.GetInt(K_Practice, 0) == 1;

            var payload = JsonSerializer.Serialize(new
            {
                playerFaction = _picked,
                enemyFaction = enemy,
                difficulty = diff,
                deckId = deck != null ? deck.Id : "",
                practice,
            });

            _lastMatchId = null;
            using (var req = new UnityWebRequest(matchServerUrl + "/api/match/start", UnityWebRequest.kHttpVerbPOST))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(payload));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 1;   // ~0.7–1с: сервер недоступен → локальный бой (matchId = null)
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(req.downloadHandler.text);
                        if (doc.RootElement.TryGetProperty("match_id", out var mid)) _lastMatchId = mid.GetString();
                    }
                    catch (JsonException) { /* ответ не JSON — остаёмся на локальном бое */ }
                }
            }
            Debug.Log($"[MainMenu] матч: {(_lastMatchId ?? "локальный (сервер недоступен)")}; " +
                      $"{_picked} vs {enemy}, сложность {diff}, колода {(deck != null ? deck.Id : "—")}, тренировка={practice}");

            if (!string.IsNullOrEmpty(battleSceneName))
                SceneManager.LoadScene(battleSceneName);   // сцена Battle должна быть в Build Settings
        }

        /// <summary>match_id последнего запроса (для телеметрии — как telem.matchId в прототипе).</summary>
        public string? LastMatchId => _lastMatchId;

        /* ---------------- 1.5 Нижняя навигация: overlay + «пружина» ---------------- */

        private void OpenOverlay(int idx)
        {
            if (idx < 0 || idx >= overlayPanels.Count) return;
            var panel = overlayPanels[idx];
            if (panel == null) return;
            panel.gameObject.SetActive(true);
            StartCoroutine(SpringPanel(panel));
        }

        /// Панель выезжает снизу с перелётом (spring), 0.5с — спека п.1.5. */
        public IEnumerator SpringPanel(RectTransform rt)
        {
            var cg = rt.GetComponent<CanvasGroup>();
            if (cg == null) cg = rt.gameObject.AddComponent<CanvasGroup>();
            var from = new Vector3(0f, -560f, 0f);
            const float dur = 0.5f;
            for (float t = 0f; t < dur; t += Time.unscaledDeltaTime)
            {
                float k = Spring.Evaluate(Mathf.Clamp01(t / dur));
                rt.localPosition = Vector3.LerpUnclamped(from, Vector3.zero, k);
                rt.localScale = Vector3.one * Mathf.LerpUnclamped(0.97f, 1f, k);
                cg.alpha = Mathf.Clamp01(t / (dur * 0.6f));
                yield return null;
            }
            rt.localPosition = Vector3.zero;
            rt.localScale = Vector3.one;
            cg.alpha = 1f;
        }

        /* ---------------- утилиты ---------------- */

        private void RefreshSelection()
        {
            // Простая и надёжная пересборка состояний «sel» по текущему _picked.
            BuildCarousel();
            BuildFactionPanel();
        }

        private static void MarkSelected(GameObject go, bool sel)
        {
            var s = go.transform.Find("Sel");
            if (s != null) s.gameObject.SetActive(sel);
        }

        private static string? SetText(GameObject go, string child, string? value)
        {
            var tr = go.transform.Find(child);
            if (tr == null) return null;
            var txt = tr.GetComponent<TMP_Text>();
            if (txt == null) return null;
            if (value != null) txt.text = value;
            return txt.text;
        }

        private static void ClearChildren(Transform root)
        {
            for (int i = root.childCount - 1; i >= 0; i--) Destroy(root.GetChild(i).gameObject);
        }
    }
}
