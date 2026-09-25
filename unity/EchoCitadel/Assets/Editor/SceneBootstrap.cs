// SceneBootstrap — утилиты редактора для развертывания «Эхо-Цитадели» в Unity.
// Меню: EchoCitadel → Create Bootstrap Scene / Run Headless Demo / Generate Card ScriptableObjects.
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using EchoCitadel.Core;
using EchoCitadel.Data;

namespace EchoCitadel.EditorTools
{
    public static class SceneBootstrap
    {
        private const string ScenesDir = "Assets/Scenes";
        private const string MainScene = "Assets/Scenes/Main.unity";

        /// Создаёт стартовую сцену: камера + свет + GameCore(EchoBoot) и сохраняет её.
        [MenuItem("EchoCitadel/Create Bootstrap Scene")]
        public static void CreateBootstrapScene()
        {
            Directory.CreateDirectory(ScenesDir);
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            var core = new GameObject("GameCore");
            core.AddComponent<EchoBoot>();
            var uiRoot = new GameObject("UIRoot");
            uiRoot.transform.SetParent(core.transform);
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, MainScene);
            Debug.Log($"[EchoCitadel] Стартовая сцена создана: {MainScene} (GameCore+EchoBoot, UIRoot-заготовка). " +
                      "Далее: EchoCitadel → Generate Card ScriptableObjects.");
        }

        /// Headless-прогон в редакторе: 1 матч ИИ vs ИИ на общей базе (смоук C#-порта без входа в Play).
        [MenuItem("EchoCitadel/Run Headless Demo")]
        public static void RunHeadlessDemo()
        {
            var cardsPath = Path.Combine(Application.dataPath, "StreamingAssets", "Cards.json");
            var decksPath = Path.Combine(Application.dataPath, "StreamingAssets", "Decks.json");
            if (!File.Exists(cardsPath) || !File.Exists(decksPath))
            {
                Debug.LogError("[EchoCitadel] Нет StreamingAssets/Cards.json|Decks.json рядом с Assets.");
                return;
            }
            var (db, decks) = CardDatabase.FromJson(File.ReadAllText(cardsPath), File.ReadAllText(decksPath));
            var a = decks.Decks[0];
            var b = decks.Decks[1];
            var runner = new MatchRunner(db, a.Cards, b.Cards, a.Faction, b.Faction, new MatchOptions { Seed = 20260903 });
            runner.RunMulligans();
            var res = runner.Run();
            Debug.Log($"[EchoCitadel][headless] карт={db.Cards.Count}; {a.Faction} vs {b.Faction}: " +
                      $"{res.Result}, победитель={res.Winner?.ToString() ?? "—"}, ходов={res.Turns}");
        }
    }
}
