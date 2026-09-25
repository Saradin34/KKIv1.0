using UnityEngine;
namespace EchoCitadel.Data
{
    /// ScriptableObject-карточка: создаётся редакторным генератором из Cards.json.
    [CreateAssetMenu(fileName = "Card", menuName = "EchoCitadel/CardData")]
    public class CardDataSO : ScriptableObject
    {
        public string id;
        public string cardName;
        public string faction;
        public string type;
        public string subtype;
        public string rarity;
        public int cost;
        public int attack;
        public int health;
        public string element;
        public string[] keywords;
        public string target;
        public string abilityText;
        public string flavor;
        public Sprite art;
    }
}
