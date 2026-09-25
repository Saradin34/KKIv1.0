// CraftingController — крафт и разбор карт (зеркало спеки «3. Магазин» п.4.4, Промпт 3).
//  1. При выборе карты из коллекции показывается стоимость в пыли (крафт) и доход (разбор).
//  2. Кнопка «Создать»: проверка пыли на клиенте → POST /api/craft (сервер авторитетен).
//  3. Кнопка «Разобрать»: диалог подтверждения → POST /api/dust.
//  4. Обновление состояния коллекции и пыли после ответа сервера (shards/copies).
//
// Тарифы (решение пользователя: пыль = золото ◈, единая валюта):
//   крафт  — Обычная 5, Редкая 20, Эпическая 100, Легендарная 400;
//   разбор — Обычная 1, Редкая 5, Эпическая 20, Легендарная 100.
// Префаб confirmDust: «Text» (TMP), «YesButton», «NoButton» (Button).
using System;
using System.Collections;
using System.Text.Json;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using EchoCitadel.Core;
using EchoCitadel.Data;

namespace EchoCitadel.UI
{
    public sealed class CraftingController : MonoBehaviour
    {
        [Header("Сервер")]
        public string baseUrl = "http://localhost:8081";

        [Header("Данные")]
        public CardDatabase? database;

        [Header("Выбранная карта")]
        public TMP_Text? cardNameText, cardCostText, copiesText;
        public Image? cardArt;                  // опционально: арт 512×720 из Assets/Art/Cards
        public Button? btnCraft, btnDust;

        [Header("Пыль (◈)")]
        public TMP_Text? dustText;

        [Header("Подтверждение разбора")]
        public GameObject? confirmPanel;        // префаб/панель confirmDust
        public TMP_Text? confirmText;
        public Button? btnConfirmYes, btnConfirmNo;

        /// Карта выбрана в UI коллекции (для внешних экранов).
        public static event Action<CardData>? OnCardSelected;
        /// Крафт/разбор завершены успешно (id карты, новое число копий).
        public static event Action<string, int>? OnCollectionChanged;

        private CardData? _card;
        private int _copies;                    // локальное зеркало коллекции (сервер авторитетен)

        /// Локальное зеркало пыли ◈ (PlayerPrefs) — для мгновенной подсветки «не хватает».
        public static long Dust
        {
            get => long.TryParse(PlayerPrefs.GetString("ec.wallet.shards", "0"), out var v) ? v : 0;
            set => PlayerPrefs.SetString("ec.wallet.shards", value.ToString());
        }

        private void Awake()
        {
            if (!database && TryGetComponent(out MenuContext? ctx)) database = ctx?.database;
            if (btnCraft) btnCraft.onClick.AddListener(Craft);
            if (btnDust) btnDust.onClick.AddListener(AskDust);
            if (btnConfirmYes) btnConfirmYes.onClick.AddListener(ConfirmDust);
            if (btnConfirmNo) btnConfirmNo.onClick.AddListener(() => SetConfirm(false));
            SetConfirm(false);
            RefreshDust();
        }

        /* ---------------- 1. Выбор карты и стоимость ---------------- */

        /// Вызов из списка коллекции: показать стоимость крафта и доход разбора.
        public void SelectCard(CardData c, int copies)
        {
            _card = c; _copies = copies;
            if (cardNameText) cardNameText.text = c.Name;
            if (cardCostText)
                cardCostText.text = $"Стоимость крафта: ◈ {CraftCost(c.Rarity)}   |   Разбор: +◈ {DustGain(c.Rarity)}";
            if (copiesText) copiesText.text = $"Копий: {copies}/4";
            // Арт карты назначает вызывающий список коллекции: SetCardArt(sprite) —
            // реестра CardArt в CardDatabase пока нет (см. docs/PROFILE_SPEC.md, интеграция арта).
            RefreshButtons();
            OnCardSelected?.Invoke(c);
        }

        private void RefreshButtons()
        {
            if (btnCraft) btnCraft.interactable = _card != null && _copies < 4 && Dust >= CraftCost(_card.Rarity);
            if (btnDust) btnDust.interactable = _card != null && _copies > (IsExpansion(_card) ? 0 : 1);
        }

        /// Арт выбранной карты (512×720, Assets/Art/Cards/{id}.png) — задаёт список коллекции.
        public void SetCardArt(Sprite? sprite) { if (cardArt && sprite) cardArt.sprite = sprite; }

        private static bool IsExpansion(CardData c) => PackGenerator.ExpansionIds().Contains(c.Id);

        private void RefreshDust()
        {
            if (dustText) dustText.text = "◈ " + Dust;
        }

        /* ---------------- 2. «Создать» → POST /api/craft ---------------- */

        public void Craft()
        {
            if (_card == null) return;
            var cost = CraftCost(_card.Rarity);
            if (Dust < cost) { Log($"недостаточно ◈ (нужно {cost})"); return; }   // клиентская проверка
            StartCoroutine(Request("/api/craft", _card.Id, ok =>
            {
                if (ok) _copies++;
                RefreshButtons();
            }));
        }

        /* ---------------- 3. «Разобрать» → подтверждение → POST /api/dust ---------------- */

        private void AskDust()
        {
            if (_card == null) return;
            if (confirmText)
                confirmText.text = $"Разобрать «{_card.Name}» за ◈ {DustGain(_card.Rarity)}?";
            SetConfirm(true);
        }

        private void SetConfirm(bool on) { if (confirmPanel) confirmPanel.SetActive(on); }

        private void ConfirmDust()
        {
            SetConfirm(false);
            if (_card == null) return;
            StartCoroutine(Request("/api/dust", _card.Id, ok =>
            {
                if (ok) _copies = Math.Max(0, _copies - 1);
                RefreshButtons();
            }));
        }

        /* ---------------- 4. Общая серверная обработка ---------------- */

        private IEnumerator Request(string path, string cardId, Action<bool> done)
        {
            yield return MetaApi.Post(this, baseUrl, path,
                new { pid = MetaApi.Pid, cardId }, (code, root) =>
            {
                var ok = code == 200 && root.HasValue;
                if (ok)
                {
                    if (root!.Value.TryGetProperty("shards", out var sh)) Dust = sh.GetInt64();
                    if (root.Value.TryGetProperty("copies", out var cp)) _copies = cp.GetInt32();
                    RefreshDust();
                    OnCollectionChanged?.Invoke(cardId, _copies);
                }
                else
                {
                    var err = root.HasValue && root.Value.TryGetProperty("error", out var e)
                        ? (e.GetString() ?? $"HTTP {code}") : $"HTTP {code}";
                    Log(err);   // playset limit / not enough ◈ / cannot dust
                }
                done(ok);
            });
        }

        private static void Log(string msg) => Debug.Log($"[crafting] {msg}");

        /* ---------------- Тарифы (зеркало серверных CRAFT_COST/DUST_GAIN) ---------------- */

        public static int CraftCost(Rarity r) => r switch
        {
            Rarity.Common => 5,
            Rarity.Uncommon => 10,
            Rarity.Rare => 20,
            Rarity.Epic => 100,
            Rarity.Legendary => 400,
            _ => 5,
        };

        public static int DustGain(Rarity r) => r switch
        {
            Rarity.Common => 1,
            Rarity.Uncommon => 2,
            Rarity.Rare => 5,
            Rarity.Epic => 20,
            Rarity.Legendary => 100,
            _ => 1,
        };
    }
}
