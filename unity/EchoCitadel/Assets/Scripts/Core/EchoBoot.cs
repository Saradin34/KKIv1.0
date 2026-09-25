// EchoBoot — рантайм-бутстрап «Эхо-Цитадели» в Unity.
// Грузит ЕДИНУЮ базу карт (StreamingAssets/Cards.json + Decks.json — тот же источник,
// что у TS-движка и HTML-прототипа) и опционально гонит headless-матч для дым-теста порта.
using System.IO;
using UnityEngine;
using EchoCitadel.Data;

namespace EchoCitadel.Core
{
    public sealed class EchoBoot : MonoBehaviour
    {
        public static EchoBoot? Instance { get; private set; }
        public CardDatabase? Db { get; private set; }
        public DeckFile? Decks { get; private set; }

        [Header("Дым-тест порта")]
        [Tooltip("При старте сцены прогнать один headless-матч ИИ vs ИИ и залогировать результат")]
        public bool runHeadlessDemo = true;
        public int demoSeed = 20260903;

        private void Awake()
        {
            Instance = this;
            var cards = ReadStreaming("Cards.json");
            var decks = ReadStreaming("Decks.json");
            if (string.IsNullOrEmpty(cards))
            {
                Debug.LogError("[EchoBoot] Не найден StreamingAssets/Cards.json — проверьте, что папка скопирована в проект.");
                return;
            }
            if (string.IsNullOrEmpty(decks))
            {
                Db = CardDatabase.FromJson(cards);
                Debug.Log($"[EchoBoot] Cards.json загружен: карт в базе = {Db.Cards.Count} (Decks.json отсутствует)");
                return;
            }
            var (db, deckFile) = CardDatabase.FromJson(cards, decks);
            Db = db; Decks = deckFile;
            Debug.Log($"[EchoBoot] База готова: карт = {Db.Cards.Count}, колод = {Decks.Decks.Count}");
            if (runHeadlessDemo) RunDemo();
        }

        /// Headless-матч первых двух колод из Decks.json — смоук C#-порта прямо в сцене.
        public void RunDemo()
        {
            if (Db == null || Decks == null || Decks.Decks.Count < 2) return;
            var a = Decks.Decks[0];
            var b = Decks.Decks[1];
            var runner = new MatchRunner(Db, a.Cards, b.Cards, a.Faction, b.Faction,
                new MatchOptions { Seed = demoSeed });
            runner.RunMulligans();
            var res = runner.Run();
            Debug.Log($"[EchoBoot][demo] {a.Faction} vs {b.Faction}: результат={res.Result}, " +
                      $"победитель={res.Winner?.ToString() ?? "—"}, ходов={res.Turns}");
        }

        /// StreamingAssets: на десктопе/в редакторе — файл, на Android — внутри APK (UnityWebRequest).
        private static string ReadStreaming(string file)
        {
            var path = Path.Combine(Application.streamingAssetsPath, file);
#if UNITY_ANDROID && !UNITY_EDITOR
            using var uwr = UnityEngine.Networking.UnityWebRequest.Get(path);
            var op = uwr.SendWebRequest();
            while (!op.isDone) { /* синхронно на старте — база маленькая */ }
            return uwr.result == UnityEngine.Networking.UnityWebRequest.Result.Success ? uwr.downloadHandler.text : "";
#else
            return File.Exists(path) ? File.ReadAllText(path) : "";
#endif
        }
    }
}
