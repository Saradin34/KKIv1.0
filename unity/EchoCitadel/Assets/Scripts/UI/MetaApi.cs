// MetaApi — общий HTTP-клиент мета-сервера (:8081) для UI-слоя Unity.
// Спека «2. Профиль»: GET /api/profile, GET /api/quests, POST /api/quests/claim,
// GET /api/profile/nick. Клиент офлайн-устойчив: любая ошибка сети → callback(null),
// локальное сохранение (PlayerPrefs) остаётся источником истины.
using System;
using System.Collections;
using System.Text;
using System.Text.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace EchoCitadel.UI
{
    public static class MetaApi
    {
        public const string DefaultBaseUrl = "http://127.0.0.1:8081";
        private const string PidKey = "ec.pid";

        /// Постоянный id игрока (как meta.pid в прототипе).
        public static string Pid
        {
            get
            {
                var pid = PlayerPrefs.GetString(PidKey, "");
                if (string.IsNullOrEmpty(pid))
                {
                    pid = "ec-" + Guid.NewGuid().ToString("N").Substring(0, 16);
                    PlayerPrefs.SetString(PidKey, pid);
                    PlayerPrefs.Save();
                }
                return pid;
            }
        }

        /// GET с JSON-ответом; ошибка/таймаут → cb(null).
        public static IEnumerator Get(MonoBehaviour host, string baseUrl, string path, Action<JsonElement?> cb)
        {
            using var req = UnityWebRequest.Get(baseUrl + path);
            req.timeout = 2;
            yield return req.SendWebRequest();
            if (req.result != UnityWebRequest.Result.Success) { cb(null); yield break; }
            JsonElement? root = null;
            try { root = JsonDocument.Parse(req.downloadHandler.text).RootElement.Clone(); }
            catch (JsonException) { root = null; }
            cb(root);
        }

        /// POST с JSON-телом; cb(код ответа, тело или null).
        public static IEnumerator Post(MonoBehaviour host, string baseUrl, string path, object body,
            Action<long, JsonElement?> cb)
        {
            var json = JsonSerializer.Serialize(body);
            using var req = new UnityWebRequest(baseUrl + path, UnityWebRequest.kHttpVerbPOST);
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.timeout = 2;
            yield return req.SendWebRequest();
            JsonElement? root = null;
            if (req.result == UnityWebRequest.Result.Success)
            {
                try { root = JsonDocument.Parse(req.downloadHandler.text).RootElement.Clone(); }
                catch (JsonException) { root = null; }
            }
            cb(req.responseCode, root);
        }
    }
}
