// FactionCatalog — каталог фракций из единого источника factions.json
// (StreamingAssets; тот же файл читает HTML-прототип — спека «1. Главное меню» п.1.2).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using UnityEngine;
using UnityEngine.Networking;

namespace EchoCitadel.UI
{
    [Serializable]
    public sealed class FactionColorInfo
    {
        [JsonPropertyName("primary")] public string Primary { get; set; } = "#f5d76e";
        [JsonPropertyName("secondary")] public string Secondary { get; set; } = "#ffffff";
        [JsonPropertyName("accent")] public string Accent { get; set; } = "#7ec8ff";

        public Color PrimaryColor => Parse(Primary);
        public Color AccentColor => Parse(Accent);

        private static Color Parse(string hex) =>
            ColorUtility.TryParseHtmlString(hex, out var c) ? c : Color.white;
    }

    [Serializable]
    public sealed class FactionInfo
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("tagline")] public string Tagline { get; set; } = "";
        [JsonPropertyName("sigil")] public string Sigil { get; set; } = "✦";
        [JsonPropertyName("icon")] public string Icon { get; set; } = "";
        [JsonPropertyName("color")] public FactionColorInfo Color { get; set; } = new();
        [JsonPropertyName("description")] public string Description { get; set; } = "";
        [JsonPropertyName("mechanics")] public string Mechanics { get; set; } = "";
        [JsonPropertyName("tips")] public List<string> Tips { get; set; } = new();
    }

    [Serializable]
    public sealed class FactionFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("factions")] public List<FactionInfo> Factions { get; set; } = new();
    }

    public static class FactionCatalog
    {
        private static FactionFile? _cache;

        /// Загрузка каталога (кэш на процесс). Десктоп/редактор — File, Android — UnityWebRequest.
        public static FactionFile Load()
        {
            if (_cache != null) return _cache;
            var json = ReadStreaming("factions.json");
            if (string.IsNullOrEmpty(json))
            {
                Debug.LogError("[FactionCatalog] StreamingAssets/factions.json не найден");
                _cache = new FactionFile();
                return _cache;
            }
            _cache = JsonSerializer.Deserialize<FactionFile>(json, EchoBootJson.Options) ?? new FactionFile();
            return _cache;
        }

        public static FactionInfo? ById(string id)
        {
            foreach (var f in Load().Factions)
                if (string.Equals(f.Id, id, StringComparison.Ordinal)) return f;
            return null;
        }

        internal static string ReadStreaming(string file)
        {
            var path = Path.Combine(Application.streamingAssetsPath, file);
#if UNITY_ANDROID && !UNITY_EDITOR
            using var uwr = UnityWebRequest.Get(path);
            var op = uwr.SendWebRequest();
            while (!op.isDone) { }
            return uwr.result == UnityWebRequest.Result.Success ? uwr.downloadHandler.text : "";
#else
            return File.Exists(path) ? File.ReadAllText(path) : "";
#endif
        }
    }

    /// Общие настройки JSON (System.Text.Json) для UI-слоя.
    public static class EchoBootJson
    {
        public static readonly JsonSerializerOptions Options = new()
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };
    }
}
