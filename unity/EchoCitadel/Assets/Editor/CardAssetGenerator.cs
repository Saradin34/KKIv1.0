using System.IO;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
namespace EchoCitadel.Editor
{
    /// Читает StreamingAssets/Cards.json и создаёт/обновляет CardDataSO в Assets/Data/CardsSO.
    /// Data-driven: правим JSON -> Assets -> CardAssetGenerator.Generate (или кнопка в меню).
    public static class CardAssetGenerator
    {
        [MenuItem("EchoCitadel/Generate Card ScriptableObjects")]
        public static void Generate()
        {
            const string jsonPath = "Assets/StreamingAssets/Cards.json";
            const string outDir = "Assets/Data/CardsSO";
            if (!AssetDatabase.IsValidFolder(outDir))
            {
                Directory.CreateDirectory(Path.Combine(Application.dataPath, "Data/CardsSO"));
                AssetDatabase.Refresh();
            }
            var root = JsonUtility.FromJson<Root>(FixJson(File.ReadAllText(jsonPath)));
            int n = 0;
            foreach (var c in root.cards)
            {
                var path = $"{outDir}/{c.id}.asset";
                var so = AssetDatabase.LoadAssetAtPath<CardDataSO>(path)
                         ?? ScriptableObject.CreateInstance<CardDataSO>();
                so.id = c.id; so.cardName = c.name; so.faction = c.faction; so.type = c.type;
                so.subtype = c.subtype; so.rarity = c.rarity; so.cost = c.cost;
                so.attack = c.attack; so.health = c.health; so.element = c.element;
                so.keywords = c.keywords ?? new string[0]; so.target = c.target;
                so.abilityText = c.abilityText; so.flavor = c.flavor;
                so.art = AssetDatabase.LoadAssetAtPath<Sprite>($"Assets/Resources/Cards/{c.faction}/{c.id}.png");
                if (!AssetDatabase.Contains(so)) AssetDatabase.CreateAsset(so, path);
                else EditorUtility.SetDirty(so);
                n++;
            }
            AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
            Debug.Log($"[EchoCitadel] CardDataSO обновлено: {n}");
        }

        [System.Serializable] public class Card { public string id, name, faction, type, subtype, rarity, element, target, abilityText, flavor; public int cost, attack, health; public string[] keywords; }
        [System.Serializable] public class Root { public Card[] cards; }
        // JsonUtility не любит верхний уровень-массив и ключ "name" не конфликтует — оборачиваем
        static string FixJson(string s) => s;
    }
}
