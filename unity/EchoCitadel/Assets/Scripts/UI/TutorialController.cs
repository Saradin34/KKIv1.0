// TutorialController — пошаговое обучение (зеркало спеки «6. 🎓 Обучение», Промпт 1).
//  1. Сценарий грузится из StreamingAssets/tutorial.json (20 шагов × 4 урока: id, message,
//     highlight, required_action, next_step; next_step=0 — урок завершён, on_complete=reward — финал).
//  2. На каждом шаге — подсветка нужной карты/кнопки (реестр RegisterHighlight или поиск по имени)
//     и текст подсказки в messageText.
//  3. Ожидание действия игрока: NotifyAction(...) из боя/UI (play_card/attack/end_turn/
//     wait_player_turn/tap_card/play_any) → переход к next_step.
//  4. Блокировка всего, кроме требуемого: полноэкранный blocker (raycast), подсвеченный объект
//     поднимается Canvas'ом с overrideSorting выше блокера; «Отменить урок» — всегда кликабельна.
//  5. По завершении урока → POST /api/tutorial/complete; после урока 4 → панель награды:
//     выбор фракции → POST /api/tutorial/reward (стартовая колода + 5 бустеров + 💎100) →
//     PlayerPrefs "ec.tut.done" = 1 (открывает Тренировку, спека 6.3).
//
// Интеграция: повесить на UIRoot в Main.unity; бой вызывает NotifyAttack/NotifyEndTurn/
// NotifyPlayerTurnStart; карточка руки — NotifyTap(go)/NotifyCardPlayed через шину GameEvents.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace EchoCitadel.UI
{
    public sealed class TutorialController : MonoBehaviour
    {
        [Header("Сервер")]
        public string baseUrl = "http://localhost:8081";

        [Header("Сценарий")]
        public string scenarioFile = "tutorial.json";   // StreamingAssets
        public int autoStartLesson = 0;                 // >0 — сразу запустить урок (иначе StartLesson из хаба)

        [Header("Подсказка и блокировка")]
        public TMP_Text? messageText;
        public GameObject? blocker;                     // полноэкранный Image (raycastTarget), parent Canvas
        public int blockerSortingOrder = 200;
        public Button? btnCancelLesson;                 // анти-softlock: всегда над блокером

        [Header("Панель награды (спека 6.2)")]
        public GameObject? rewardPanel;
        public Button[] factionButtons = Array.Empty<Button>();
        public string[] factionNames = { "Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal" };

        [Header("Тосты/звук")]
        public GameObject? toastPrefab;
        public Transform? toastRoot;
        public AudioSource? audioSource;
        public AudioClip? stepClip, rewardClip;

        /// Шаг сменился (для аналитики/подсветки во внешних экранах).
        public static event Action<TutorialStep>? OnStepChanged;
        /// Урок завершён (1..4).
        public static event Action<int>? OnLessonCompleted;
        /// Обучение пройдено полностью, фракция награды выбрана — тренировка открыта (спека 6.3).
        public static event Action<string>? OnTutorialCompleted;

        /// Тренировка доступна только после обучения (спека 6.3).
        public static bool TrainingUnlocked => PlayerPrefs.GetInt("ec.tut.done", 0) == 1;

        private readonly Dictionary<string, GameObject> _highlights = new();
        private List<TutorialStep> _steps = new();
        private TutorialStep? _cur;
        private int _lesson;
        private GameObject? _raised;          // объект, поднятый над блокером
        private Canvas? _raisedCanvas;

        /* ---------------- 1. Загрузка сценария из tutorial.json ---------------- */

        private void Awake()
        {
            LoadScenario();
            if (btnCancelLesson) btnCancelLesson.onClick.AddListener(CancelLesson);
            for (var i = 0; i < factionButtons.Length && i < factionNames.Length; i++)
            {
                var fac = factionNames[i];
                factionButtons[i].onClick.AddListener(() => ClaimReward(fac));
            }
            GameEvents.OnCardPlayed += HandleCardPlayed;
        }

        private void OnDestroy() => GameEvents.OnCardPlayed -= HandleCardPlayed;

        private void Start()
        {
            if (rewardPanel) rewardPanel.SetActive(false);
            if (autoStartLesson > 0 && !_steps.Any(s => s.Lesson == autoStartLesson))
                Debug.LogWarning($"[tutorial] урок {autoStartLesson} не найден в {scenarioFile}");
            else if (autoStartLesson > 0) StartLesson(autoStartLesson);
        }

        private void LoadScenario()
        {
            var path = Path.Combine(Application.streamingAssetsPath, scenarioFile);
            try
            {
                var json = File.ReadAllText(path);
                var file = JsonSerializer.Deserialize<TutorialFile>(json);
                _steps = file?.Steps ?? new List<TutorialStep>();
                Debug.Log($"[tutorial] загружено шагов: {_steps.Count} из {scenarioFile}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[tutorial] не удалось загрузить {path}: {e.Message}");
                _steps = new List<TutorialStep>();
            }
        }

        /* ---------------- Реестр подсветки ---------------- */

        /// Ключи сценария: hand_rune, hand_veteran, hand_spell, hand_taunt, hand_lifesteal,
        /// hand_unblockable, hand_battlecry, hand_expensive, hand_cheap, hand_any,
        /// board_own_creature, board_own_taunt, board_own_lifesteal, btn_end_turn.
        /// Регистрируйте живые объекты при каждой раздаче/перерисовке (карты руки пересоздаются!).
        public void RegisterHighlight(string key, GameObject? go)
        {
            if (go == null) _highlights.Remove(key);
            else _highlights[key] = go;
        }

        private GameObject? Resolve(string key)
        {
            if (_highlights.TryGetValue(key, out var go) && go) return go;
            var found = GameObject.Find(key);            // фолбэк: поиск по имени в сцене
            return found;
        }

        /* ---------------- Запуск урока ---------------- */

        public void StartLesson(int lesson)
        {
            _lesson = lesson;
            var first = _steps.Where(s => s.Lesson == lesson).OrderBy(s => s.Id).FirstOrDefault();
            if (first == null) { Debug.LogWarning($"[tutorial] урок {lesson}: нет шагов"); return; }
            if (rewardPanel) rewardPanel.SetActive(false);
            GoToStep(first.Id);
        }

        public void CancelLesson()
        {
            _cur = null;
            LowerRaised();
            if (blocker) blocker.SetActive(false);
            if (messageText) messageText.text = "";
            Debug.Log($"[tutorial] урок {_lesson} отменён игроком");
        }

        /* ---------------- 2. Подсветка + текст подсказки ---------------- */

        private void GoToStep(int id)
        {
            _cur = _steps.FirstOrDefault(s => s.Id == id);
            if (_cur == null) { LessonDone(); return; }
            if (messageText) messageText.text = $"🎓 {_cur.Message}";
            if (audioSource && stepClip) audioSource.PlayOneShot(stepClip);

            LowerRaised();
            if (blocker) blocker.SetActive(true);
            var target = Resolve(_cur.Highlight);
            if (target != null)
            {
                // поднять подсвеченный объект над блокером — клики доходят только до него (п.4)
                _raisedCanvas = target.GetComponent<Canvas>();
                if (_raisedCanvas == null) _raisedCanvas = target.AddComponent<Canvas>();
                _raisedCanvas.overrideSorting = true;
                _raisedCanvas.sortingOrder = blockerSortingOrder + 1;
                var gr = target.GetComponent<GraphicRaycaster>();
                if (gr == null) gr = target.AddComponent<GraphicRaycaster>();
                _raised = target;
            }
            if (btnCancelLesson)
            {
                // анти-softlock: отмена урока кликабельна всегда
                var bc = btnCancelLesson.GetComponent<Canvas>() ?? btnCancelLesson.gameObject.AddComponent<Canvas>();
                bc.overrideSorting = true;
                bc.sortingOrder = blockerSortingOrder + 2;
            }
            OnStepChanged?.Invoke(_cur);
        }

        private void LowerRaised()
        {
            if (_raisedCanvas != null) _raisedCanvas.overrideSorting = false;
            _raisedCanvas = null;
            _raised = null;
        }

        /* ---------------- 3. Ожидание действия игрока ---------------- */

        /// Универсальный вход: бой/UI сообщают о действии. context — id карты (для play_card).
        public void NotifyAction(string action, string? context = null)
        {
            if (_cur == null) return;
            var need = _cur.RequiredAction;
            var ok = need == action || (need == "play_any" && (action == "play_card" || action == "end_turn"));
            if (!ok) return;                              // любое другое действие игнорируется (п.4)
            if (need == "play_card" && context != null && !HighlightMatchesCard(context)) return;
            Advance();
        }

        private bool HighlightMatchesCard(string cardId)
        {
            var go = _cur != null ? Resolve(_cur.Highlight) : null;
            // соглашение: имя объекта руки содержит id карты (например "card_aur_r07") или
            // зарегистрирован точный ключ; при невозможности сверки — не блокируем прогресс
            return go == null || go.name.Contains(cardId, StringComparison.Ordinal)
                || _highlights.Values.Any(v => v && v.name.Contains(cardId, StringComparison.Ordinal));
        }

        public void NotifyAttack() => NotifyAction("attack");
        public void NotifyEndTurn() => NotifyAction("end_turn");
        public void NotifyPlayerTurnStart() => NotifyAction("wait_player_turn");
        public void NotifyTap(GameObject go)
        {
            if (_cur == null) return;
            if (_cur.RequiredAction == "tap_card" && Resolve(_cur.Highlight) == go) NotifyAction("tap_card");
        }

        private void HandleCardPlayed(string cardId, string cardType) => NotifyAction("play_card", cardId);

        private void Advance()
        {
            if (_cur == null) return;
            var next = _cur.NextStep;
            var onComplete = _cur.OnComplete;
            _cur = null;
            if (next > 0) { GoToStep(next); return; }
            // next_step = 0 — урок завершён
            if (onComplete == "reward") { FinishTutorialFlow(); return; }
            LessonDone();
        }

        /* ---------------- 5. Завершение: награда + открытие тренировки ---------------- */

        private void LessonDone()
        {
            LowerRaised();
            if (blocker) blocker.SetActive(false);
            if (messageText) messageText.text = "";
            OnLessonCompleted?.Invoke(_lesson);
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/tutorial/complete",
                new { pid = MetaApi.Pid, lesson = _lesson }, (code, root) =>
            {
                var granted = code == 200 && root.HasValue
                    && root.Value.TryGetProperty("granted", out var g) ? g.GetInt32() : 0;
                Toast($"🎓 Урок {_lesson} пройден!", granted > 0 ? $"награда ◈{granted}" : "так держать", true);
                if (_lesson < 4) StartLesson(_lesson + 1);        // уроки идут подряд
                else OpenRewardPanel();
            }));
        }

        private void FinishTutorialFlow()
        {
            // шаг 20 (on_complete=reward): сначала фиксируем урок 4, потом награда
            LowerRaised();
            if (blocker) blocker.SetActive(false);
            OnLessonCompleted?.Invoke(_lesson);
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/tutorial/complete",
                new { pid = MetaApi.Pid, lesson = _lesson }, (code, _) => OpenRewardPanel()));
        }

        private void OpenRewardPanel()
        {
            if (rewardPanel) rewardPanel.SetActive(true);
            Toast("🎁 Все уроки пройдены!", "Выберите фракцию — стартовая колода + 5 бустеров + 💎100", true);
        }

        /// Спека 6.2: выбор фракции → стартовая колода + 5 бустеров (+💎100) через сервер.
        public void ClaimReward(string faction)
        {
            StartCoroutine(MetaApi.Post(this, baseUrl, "/api/tutorial/reward",
                new { pid = MetaApi.Pid, faction }, (code, root) =>
            {
                if (code == 200)
                {
                    PlayerPrefs.SetInt("ec.tut.done", 1);
                    PlayerPrefs.SetString("ec.tut.reward", faction);
                    if (rewardPanel) rewardPanel.SetActive(false);
                    if (audioSource && rewardClip) audioSource.PlayOneShot(rewardClip);
                    OnTutorialCompleted?.Invoke(faction);
                    Toast("🎁 Награда получена!", $"Стартовая колода «{faction}» + 5 бустеров + 💎100 · Тренировка открыта", true);
                    return;
                }
                var err = root.HasValue && root.Value.TryGetProperty("error", out var e)
                    ? (e.GetString() ?? $"HTTP {code}") : $"HTTP {code}";
                Toast("Награда недоступна", err, false);   // 409 — не все уроки / уже получена
            }));
        }

        private void Toast(string title, string desc, bool gold)
        {
            if (!toastPrefab || !toastRoot) { Debug.Log($"[tutorial] {title}: {desc}"); return; }
            var go = Instantiate(toastPrefab, toastRoot);
            go.name = "toast_tut";
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

        /* ---------------- DTO (формат из Промпта 2) ---------------- */

        public sealed class TutorialStep
        {
            [JsonPropertyName("id")] public int Id { get; set; }
            [JsonPropertyName("lesson")] public int Lesson { get; set; }
            [JsonPropertyName("message")] public string Message { get; set; } = "";
            [JsonPropertyName("highlight")] public string Highlight { get; set; } = "";
            [JsonPropertyName("required_action")] public string RequiredAction { get; set; } = "";
            [JsonPropertyName("next_step")] public int NextStep { get; set; }
            [JsonPropertyName("on_complete")] public string? OnComplete { get; set; }
        }

        public sealed class TutorialFile
        {
            [JsonPropertyName("version")] public string Version { get; set; } = "";
            [JsonPropertyName("spec")] public string Spec { get; set; } = "";
            [JsonPropertyName("steps")] public List<TutorialStep> Steps { get; set; } = new();
        }
    }
}
