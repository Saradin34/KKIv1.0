// MenuContext — общие зависимости экранов главного меню (§2 профиль, §3 магазин/крафт).
// Повесить на UIRoot в Main.unity рядом с ProfileScreen/ShopController/CraftingController:
// экраны берут ссылки через TryGetComponent<MenuContext>, поэтому порядок компонентов не важен.
// Заполнение: database — CardDatabase.LoadFromStreaming(); achievements/quests — из JSON
// (AchievementCatalog.json / QuestCatalog.json — см. docs/PROFILE_SPEC.md).
using UnityEngine;
using EchoCitadel.Data;

namespace EchoCitadel.UI
{
    public sealed class MenuContext : MonoBehaviour
    {
        /// База карт (300 карт, пул расширения и т.д.).
        public CardDatabase? database;

        /// Каталог достижений для ProfileScreen (AchievementCatalog.json).
        public AchievementSystem.AchievementDef[]? achievements;

        /// Каталог квестов для ProfileScreen (QuestCatalog.json).
        public QuestSystem.QuestDef[]? quests;
    }
}
