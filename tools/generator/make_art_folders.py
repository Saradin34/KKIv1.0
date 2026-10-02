#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — папки под арт карт (фракции + подфракции) и манифесты.
=====================================================================
Создаёт корневые папки шести фракций и тематические подпапки по tags/id:

    Cards/Aurites/Mechanoids/       meh_*.png
    Cards/Aurites/PaladinBrotherhood/ pal_*.png
    Cards/Pyromancer/Gremlins/      grm_*.png
    Cards/Necrus/Vampires/          vmp_*.png
    Cards/Neutral/SacredBrotherhood/ sbd_*.png
    ... + остальные племена Расширения II и Наёмники.

В каждой папке лежат README.md и manifest.csv со списком ожидаемых файлов,
папка назначения берётся из artworkPath в Cards.json. PNG не создаются и
не перемещаются: пользователь добавляет их сам. Синк/сервер используют тот
же путь для Unity Resources и прототипа.

Скрипт идемпотентен: манифесты пересчитываются, существующие PNG не трогаются.

Запуск:
    python3 tools/generator/make_art_folders.py            # создать/обновить
    python3 tools/generator/make_art_folders.py --check    # только отчёт
"""

import argparse
import csv
import io
import json
import os
import sys
from art_layout import SUBFACTIONS, resource_card_path, subfaction_code

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CARDS_JSON = os.path.join(ROOT, "unity", "EchoCitadel", "Assets", "StreamingAssets", "Cards.json")
ART_ROOT = os.path.join(ROOT, "unity", "EchoCitadel", "Assets", "Resources", "Cards")
WEB_ROOT = "art"          # прототип отдаёт /art/<Faction>[/<Subfamily>]/<id>.png
SIZE = "512x720"

FACTIONS = ["Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal", "Neutral"]
FACTION_RU = {
    "Aurites": "Ауриты",
    "Necrus": "Некрусы",
    "Terramorph": "Терраморфы",
    "Pyromancer": "Пироманты",
    "Ethereal": "Эфирные",
    "Neutral": "Нейтральные",
    "_Tokens": "Токены",
}
FACTION_STYLE = {
    "Aurites": "Свет, мрамор, латунь, витражи, перья, нимбы. Палитра: золото #f5d76e, белый, голубой акцент.",
    "Necrus": "Кость, кровь, рваный шёлк, чёрный дым, зелёно-фиолетовая некромантия. Палитра: #8e44ad, #e74c3c.",
    "Terramorph": "Камень, корни, мох, базальт, тяжёлые силуэты. Палитра: #4e8f3a, #6b4a2b, охра.",
    "Pyromancer": "Пламя, раскалённый металл, вулканический пепел, искры. Палитра: #ff7a18, #c0392b, #ffd54a.",
    "Ethereal": "Туман, эфир, полупрозрачность, ветер, холодный неон. Палитра: #3fd6c8, #dfe7ee.",
    "Neutral": "Нейтральные карты: без фракционной символики, приглушённая палитра #9aa3ad.",
    "_Tokens": "Токены — мелкие призываемые существа. Тот же стиль, что у фракции-владельца.",
}
SUBFAMILY_BY_FOLDER = {spec["folder"]: {"code": code, **spec} for code, spec in SUBFACTIONS.items()}
TYPE_RU = {"Creature": "Существо", "Spell": "Заклинание", "Rune": "Руна"}


def load_cards():
    with io.open(CARDS_JSON, encoding="utf-8") as f:
        d = json.load(f)
    entries = []
    for c in d["cards"]:
        entries.append({
            "id": c["id"],
            "name": c["name"],
            "faction": c.get("faction", "Neutral"),
            "tags": c.get("tags", []) or [],
            "type": c.get("type", "Creature"),
            "rarity": c.get("rarity", "Common"),
            "cost": c.get("cost", 0),
            "element": c.get("element", "None"),
            "attack": c.get("attack", ""),
            "health": c.get("health", ""),
            "keywords": ",".join(c.get("keywords", []) or []),
            "prompt": c.get("artPrompt", ""),
            "negative": c.get("negativePrompt", ""),
            "file": c.get("artworkPath") or resource_card_path(c.get("faction", "Neutral"), c["id"], subfaction_code(c)),
        })
    for t in d.get("tokens", []):
        entries.append({
            "id": t["id"],
            "name": t["name"],
            "faction": "_Tokens",
            "type": t.get("type", "Creature"),
            "rarity": t.get("rarity", "Common"),
            "cost": t.get("cost", 1),
            "element": t.get("element", "None"),
            "attack": t.get("attack", ""),
            "health": t.get("health", ""),
            "keywords": ",".join(t.get("keywords", []) or []),
            "prompt": t.get("artPrompt") or (
                "dark fantasy trading card game token illustration, small summoned creature "
                f"'{t['name']}', simple readable silhouette, muted background, painterly brushwork, "
                "high detail, dramatic rim light, no text, no watermark"
            ),
            "negative": t.get("negativePrompt") or (
                "text, letters, numbers, watermark, signature, frame, border, blurry, lowres, "
                "extra limbs, deformed, jpeg artifacts"
            ),
            "file": t.get("artworkPath") or f"Resources/Cards/_Tokens/{t['id']}.png",
        })
    return d, entries


def folder_for(entry):
    """Папка внутри Assets/Resources/Cards — вся ветка из artworkPath."""
    rel = entry["file"] or resource_card_path(entry["faction"], entry["id"], subfaction_code(entry))
    parts = rel.replace("\\", "/").split("/")
    try:
        cards_i = parts.index("Cards")
        if cards_i + 2 < len(parts):
            return "/".join(parts[cards_i + 1:-1])
    except ValueError:
        pass
    return entry["faction"]


README_TMPL = """# {title} — арты карт

Папка назначения: `unity/EchoCitadel/Assets/Resources/Cards/{folder}/`.
Основная фракция: **{faction_ru}**. {family_line}

## Куда класть

Добавьте сюда PNG с **id карты** из `Cards.json` в имени:

```
{folder}/{example_id}.png
```

`artworkPath` уже указывает на эту папку. Арты не генерируются и не копируются
этим скриптом — достаточно положить свой файл, после чего его увидят Unity и прототип.

## Требования к файлу

| Параметр | Значение |
|---|---|
| Размер | **{size} px**, допустимо 1024×1440 с тем же соотношением |
| Формат | PNG; JPG/JPEG/WebP сначала пропустите через `tools/process_art.py` или `normalize_art.py` |
| Цветовое пространство | sRGB |
| Композиция | объект по центру, верхняя треть — «воздух» под рамку и стоимость |
| Текст на арте | **запрещён** — имя, стоимость и правила рисует интерфейс |

## Стиль

{style}

Общий стиль проекта — тёмное фэнтези, painterly, драматический rim-light.
В `manifest.csv` есть id, статус, промпт и negative prompt для каждой карты.

## Проверка и адрес прототипа

```bash
python3 tools/generator/make_art_folders.py --check
```

URL карты: `/{web}/{folder}/{example_id}.png`. Пока PNG отсутствует, остаётся
процедурное оформление карты (`src/ui/art.ts`).

В этой папке ожидается **{count} карт**.
"""


def folder_details(folder_name):
    parts = folder_name.split("/")
    root = parts[0]
    family = SUBFAMILY_BY_FOLDER.get(parts[1]) if len(parts) > 1 else None
    faction_name = FACTION_RU.get(root, root)
    if root == "_Tokens":
        return "Токены", faction_name, "Токены призываемых существ.", FACTION_STYLE[root]
    if family:
        title = family["name"]
        family_line = f"Подфракция: **{family['name']}** · направление {family['direction']}."
        style = f"{FACTION_STYLE.get(root, '')} Семейство: {family['name']} ({family['direction']})."
        return title, faction_name, family_line, style
    return faction_name, faction_name, "Ядро основной фракции; подфракции находятся в соседних подпапках.", FACTION_STYLE.get(root, "")


def write_readme(folder_abs, folder_name, entries):
    example = entries[0]["id"] if entries else "card_id"
    title, faction_name, family_line, style = folder_details(folder_name)
    text = README_TMPL.format(
        title=title, faction_ru=faction_name, family_line=family_line,
        folder=folder_name, example_id=example, size=SIZE, style=style,
        web=WEB_ROOT, count=len(entries),
    )
    with io.open(os.path.join(folder_abs, "README.md"), "w", encoding="utf-8") as f:
        f.write(text)


def write_manifest(folder_abs, folder_name, entries):
    path = os.path.join(folder_abs, "manifest.csv")
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["file", "resource_path", "id", "name", "type", "rarity", "cost", "element",
                    "attack", "health", "keywords", "tags", "status", "size", "prompt", "negative"])
        for e in entries:
            exists = os.path.exists(os.path.join(folder_abs, e["id"] + ".png"))
            resource_path = f"Resources/Cards/{folder_name}/{e['id']}.png"
            w.writerow([
                e["id"] + ".png", resource_path, e["id"], e["name"], TYPE_RU.get(e["type"], e["type"]),
                e["rarity"], e["cost"], e["element"], e["attack"], e["health"], e["keywords"],
                ",".join(e.get("tags", []) or []), "OK" if exists else "НЕТ ФАЙЛА", SIZE,
                e["prompt"].replace('"', "'"), e["negative"].replace('"', "'"),
            ])
    return path


def folder_sort_key(folder):
    parts = folder.split("/")
    root = parts[0]
    root_order = FACTIONS.index(root) if root in FACTIONS else len(FACTIONS)
    if len(parts) == 1:
        return root_order, 0, 0
    family = SUBFAMILY_BY_FOLDER.get(parts[1], {})
    code = family.get("code", "")
    family_order = list(SUBFACTIONS).index(code) if code in SUBFACTIONS else 999
    return root_order, 1, family_order


def write_root_readme(by_folder):
    lines = [
        "# Арты карт: структура папок",
        "",
        "Пути заданы в `Assets/StreamingAssets/Cards.json` (`artworkPath`) и общих",
        "метаданных `meta.artLayout`. Карты основного набора лежат прямо в папке",
        "фракции; карты подфракций — в подпапках. Отдельные категории: `Neutral` и `_Tokens`.",
        "",
        "| Фракция | Семейство | Код | Папка внутри `Cards/` | Карт |",
        "|---|---|---|---|---:|",
    ]
    for faction in FACTIONS:
        count = len(by_folder.get(faction, []))
        if count:
            lines.append(f"| {FACTION_RU.get(faction, faction)} | Основной набор | — | `{faction}/` | {count} |")
        for code, spec in SUBFACTIONS.items():
            if spec["faction"] != faction:
                continue
            folder = f"{faction}/{spec['folder']}"
            family_count = len(by_folder.get(folder, []))
            lines.append(f"| {FACTION_RU.get(faction, faction)} | {spec['name']} | `{code}` | `{folder}/` | {family_count} |")
    token_count = len(by_folder.get("_Tokens", []))
    lines.append(f"| Токены | Отдельная категория | — | `_Tokens/` | {token_count} |")
    lines.extend([
        "",
        "## Добавление арта",
        "",
        "Файл назначения — `<id>.png`; точная папка показана в `artworkPath` карты и в",
        "локальном `manifest.csv`. PNG не генерируются этим скриптом.",
        "Плоский drop-in `art_raw/<id>.png` сохранён: `npm run art:sync` или",
        "`npm run art:process` положит обработанную копию по вложенному `artworkPath`.",
        "Прототип отдаёт файл через `/art/<Faction>[/<Family>]/<id>.png`.",
        "",
        "Пересоздать папки и манифесты: `python3 tools/generator/make_art_folders.py`.",
        "Проверить наличие PNG: `python3 tools/generator/make_art_folders.py --check`.",
        "",
    ])
    with io.open(os.path.join(ART_ROOT, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="только отчёт, ничего не писать")
    args = ap.parse_args()

    _, entries = load_cards()
    by_folder = {}
    for entry in entries:
        by_folder.setdefault(folder_for(entry), []).append(entry)
    order = sorted(by_folder, key=folder_sort_key)

    total_ok = 0
    print("Папки артов: unity/EchoCitadel/Assets/Resources/Cards/")
    print("-" * 96)
    print(f"{'папка':<43} {'карт':>5} {'есть':>5} {'нет':>5}  прогресс")
    print("-" * 96)

    for folder in order:
        items = by_folder[folder]
        folder_abs = os.path.join(ART_ROOT, *folder.split("/"))
        if not args.check:
            os.makedirs(folder_abs, exist_ok=True)
            write_readme(folder_abs, folder, items)
            write_manifest(folder_abs, folder, items)

        ok = sum(1 for entry in items if os.path.exists(os.path.join(folder_abs, entry["id"] + ".png")))
        missing = len(items) - ok
        total_ok += ok
        bar_len = 22
        filled = int(round(bar_len * ok / max(1, len(items))))
        bar = "█" * filled + "·" * (bar_len - filled)
        print(f"{folder:<43} {len(items):>5} {ok:>5} {missing:>5}  {bar} {ok/len(items)*100:.0f}%")

    if not args.check:
        write_root_readme(by_folder)

    print("-" * 96)
    print(f"всего карт {len(entries)}, артов на месте {total_ok}, не хватает {len(entries) - total_ok}")
    if args.check:
        print("(режим --check: файлы не изменялись)")
    else:
        print("созданы/обновлены корневой README, README.md и manifest.csv во всех папках")
    return 0


if __name__ == "__main__":
    sys.exit(main())
