// BattlePassXP — начисление опыта боевого пропуска (зеркало спеки «5. 🎟», Промпт 2).
//  1. Подписка на события шины GameEvents: OnMatchWin (победа/поражение) и OnQuestComplete
//     (ежедневное/недельное задание; публикуют QuestSystem и контроллер боя).
//  2. Ставки (сервер авторитетен — rates приходят в GET /api/battlepass):
//     победа +120, поражение +60, ежедневное задание +150, недельное +250.
//  3. Отправка POST /api/battlepass/addxp {pid, reason} — сервер сам знает тариф по reason.
//  4. Ответ levelUps > 0 → анимация «Level Up» (levelUpFx + Animator-триггер) и звук.
//
// Вешать на UIRoot в Main.unity (рядом с BattlePassController — он подписан на OnBpLevelUp
// и может обновлять ленту; либо зовите BattlePassController.Reload() вручную).
using System;
using System.Collections;
using UnityEngine;

namespace EchoCitadel.UI
{
    public sealed class BattlePassXP : MonoBehaviour
    {
        [Header("Сервер")]
        public string baseUrl = "http://localhost:8081";

        [Header("Анимация Level Up")]
        public GameObject? levelUpFx;           // корень эффекта (частицы/ Animator с триггером LevelUp)
        public float levelUpFxSeconds = 2.2f;

        [Header("Звук Level Up")]
        public AudioSource? audioSource;
        public AudioClip? levelUpClip;

        [Header("Связь с лентой пропуска")]
        public BattlePassController? passController;   // опц.: авто-Reload после level-up

        /// Достигнут новый уровень пропуска (для тостов/ленты/звука в других экранах).
        public static event Action<int>? OnBpLevelUp;

        private void OnEnable()
        {
            GameEvents.OnMatchWin += HandleMatch;
            GameEvents.OnQuestComplete += HandleQuest;
        }

        private void OnDisable()
        {
            GameEvents.OnMatchWin -= HandleMatch;
            GameEvents.OnQuestComplete -= HandleQuest;
        }

        /* ---------------- 1–2. События → ставки ---------------- */

        // победа +120 / поражение +60 — во всех режимах (решение пользователя: унифицированно)
        private void HandleMatch(bool win, bool ranked, string faction) => AddXp(win ? "win" : "loss");

        // ежедневное задание +150, недельное +250
        private void HandleQuest(string questId, string kind) => AddXp(kind == "weekly" ? "weekly" : "daily");

        /* ---------------- 3. POST /api/battlepass/addxp ---------------- */

        public void AddXp(string reason) => StartCoroutine(AddXpCo(reason));

        private IEnumerator AddXpCo(string reason)
        {
            yield return MetaApi.Post(this, baseUrl, "/api/battlepass/addxp",
                new { pid = MetaApi.Pid, reason }, (code, root) =>
            {
                if (code != 200 || !root.HasValue)
                {
                    Debug.Log($"[BattlePassXP] addxp «{reason}» не начислен (код {code}) — офлайн?");
                    return;
                }
                var ups = root.Value.TryGetProperty("levelUps", out var u) ? u.GetInt32() : 0;
                var level = root.Value.TryGetProperty("level", out var l) ? l.GetInt32() : 0;
                if (ups <= 0) return;

                /* ---------------- 4. Level Up: анимация + звук ---------------- */
                for (var i = ups; i >= 1; i--) PlayLevelUp(level - i + 1);
                if (passController != null) passController.Reload();
            });
        }

        private void PlayLevelUp(int newLevel)
        {
            Debug.Log($"[BattlePassXP] 🎖 Level Up: уровень пропуска {newLevel}!");
            OnBpLevelUp?.Invoke(newLevel);
            if (levelUpFx != null)
            {
                levelUpFx.SetActive(true);
                var anim = levelUpFx.GetComponent<Animator>();
                if (anim != null) anim.SetTrigger("LevelUp");
                StartCoroutine(HideFxLater());
            }
            if (audioSource != null && levelUpClip != null) audioSource.PlayOneShot(levelUpClip);
        }

        private IEnumerator HideFxLater()
        {
            yield return new WaitForSeconds(levelUpFxSeconds);
            if (levelUpFx != null) levelUpFx.SetActive(false);
        }
    }
}
