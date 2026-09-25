#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локализация: генерирует ключи card_<id>_name/_text/_flavor + ui_* из Cards.json.
   Пишет только ru.json (источник истины — русские строки карт).
   EN собирается отдельно: python3 tools/translate_en.py  (или npm run locale = оба шага).
   Запуск: python3 tools/make_locale.py"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
OUT = os.path.join(ROOT, 'data', 'locale')
os.makedirs(OUT, exist_ok=True)
d = json.load(open(CARDS, encoding='utf-8'))
ru = {}
UI = {
    'ui_menu_play': 'В бой', 'ui_menu_collection': 'Коллекция', 'ui_menu_boosters': 'Бустеры',
    'ui_menu_profile': 'Профиль', 'ui_menu_shop': 'Магазин', 'ui_menu_campaign': 'Кампания',
    'ui_menu_pass': 'Пропуск', 'ui_battle_endturn': 'Завершить ход', 'ui_battle_journal': 'Журнал',
    'ui_pack_buy': 'Купить бустер', 'ui_craft': 'Создать', 'ui_dust': 'Разобрать',
}
ru.update(UI)
for c in d['cards']:
    ru[f"card_{c['id']}_name"] = c['name']
    ru[f"card_{c['id']}_text"] = c.get('abilityText', '')
    ru[f"card_{c['id']}_flavor"] = (c.get('flavor') or '').strip('«»')
# токены (призываемые существа) — те же ключи card_<id>_*
tokens = d.get('tokens') or []
for t in tokens:
    ru[f"card_{t['id']}_name"] = t['name']
    ru[f"card_{t['id']}_text"] = t.get('abilityText', '')
    ru[f"card_{t['id']}_flavor"] = (t.get('flavor') or '').strip('«»')
json.dump(ru, open(os.path.join(OUT, 'ru.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'✔ локализация: {len(ru)} ключей ru → data/locale/ru.json '
      f'({len(d["cards"])} карт + {len(tokens)} токенов + {len(UI)} ui). '
      f'EN: python3 tools/translate_en.py')
