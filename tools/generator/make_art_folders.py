#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — папки под арт карт (по фракциям) + манифесты.
=====================================================================
Создаёт структуру, в которую художник/генерация скидывают PNG-арты:

    unity/EchoCitadel/Assets/Resources/Cards/
      ├── Aurites/        Ауриты      (30 карт)
      ├── Necrus/         Некрусы     (30 карт)
      ├── Terramorph/     Терраморфы  (30 карт)
      ├── Pyromancer/     Пироманты   (30 карт)
      ├── Ethereal/       Эфирные     (30 карт)
      ├── Neutral/        Нейтральные (6 карт)
      └── _Tokens/        Токены      (7 карт)

В каждой папке:
    README.md    — куда класть, какой размер, как называется файл;
    manifest.csv — список всех нужных файлов этой фракции и статус
                   (OK / НЕТ ФАЙЛА), чтобы видеть прогресс одним взглядом.

Имя файла = id карты из Cards.json (например aur_01.png). Путь уже
прописан в Cards.json → поле artworkPath, поэтому Unity подхватит арт
автоматически: Resources.Load<CardArt>(...) или AssetDatabase по пути.

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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CARDS_JSON = os.path.join(ROOT, "unity", "EchoCitadel", "Assets", "StreamingAssets", "Cards.json")
ART_ROOT = os.path.join(ROOT, "unity", "EchoCitadel", "Assets", "Resources", "Cards")
WEB_ROOT = "art"          # прототип отдаёт арты по адресу /art/<Faction>/<id>.png
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
            "type": c.get("type", "Creature"),
            "rarity": c.get("rarity", "Common"),
            "cost": c.get("cost", 0),
            "element": c.get("element", "None"),
            "attack": c.get("attack", ""),
            "health": c.get("health", ""),
            "keywords": ",".join(c.get("keywords", []) or []),
            "prompt": c.get("artPrompt", ""),
            "negative": c.get("negativePrompt", ""),
            "file": c.get("artworkPath") or "",
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
    """Папка внутри Assets/Resources/Cards — совпадает с artworkPath из Cards.json."""
    rel = entry["file"] or f"Resources/Cards/{entry['faction']}/{entry['id']}.png"
    parts = rel.split("/")
    if parts[0] == "Resources" and parts[1] == "Cards":
        return parts[2] if len(parts) > 3 else entry["faction"]
    return entry["faction"]


README_TMPL = """# {title} — арт карт

Папка для PNG-артов карт фракции **{faction_ru}**.

## Куда класть

Прямо сюда, в эту папку. Имя файла — **id карты** из `Cards.json`:

```
{folder}/{example_id}.png
```

Путь уже прописан в `Cards.json` → поле `artworkPath`, поэтому ничего
переименовывать и регистрировать не нужно: положил файл — игра его подхватила.

## Требования к файлу

| Параметр | Значение |
|---|---|
| Размер | **{size} px** (портретная карта), допустимо 1024×1440 с тем же соотношением |
| Формат | `.png` (24 бит + альфа не нужна) или `.jpg` качества ≥ 90 |
| Цветовое пространство | sRGB |
| Композиция | объект по центру, верхняя треть — «воздух» под рамку и стоимость |
| Текст на арте | **запрещён** (имя, стоимость и правила рисует интерфейс) |

## Стиль фракции

{style}

Общий стиль проекта — тёмное фэнтези, painterly, драматический rim-light,
как в MTG Arena и Hearthstone. Полные промпты для Midjourney/Stable Diffusion:

* в этой папке — `manifest.csv` (колонки `prompt` и `negative`);
* сводно по всей игре — `docs/art_prompts.csv`.

## Как проверить прогресс

```bash
python3 tools/generator/make_art_folders.py --check
```

Скрипт пересчитает `manifest.csv` и покажет, сколько артов есть и каких не хватает.
Статус `OK` ставится, если файл `<id>.png` лежит в папке.

## Прототип в браузере

Сервер прототипа отдаёт эту папку по адресу `/{web}/{folder}/<id>.png`,
пока арта нет — карта рисуется процедурной заглушкой (`src/ui/art.ts`).
То есть достаточно просто положить PNG сюда и обновить страницу.

## Сколько карт

{count} шт. Список — в `manifest.csv`.
"""


def write_readme(folder_abs, folder_name, entries):
    example = entries[0]["id"] if entries else "card_id"
    title = "Токены" if folder_name == "_Tokens" else FACTION_RU.get(folder_name, folder_name)
    text = README_TMPL.format(
        title=title,
        faction_ru=FACTION_RU.get(folder_name, folder_name),
        folder=folder_name,
        example_id=example,
        size=SIZE,
        style=FACTION_STYLE.get(folder_name, ""),
        web=WEB_ROOT,
        count=len(entries),
    )
    with io.open(os.path.join(folder_abs, "README.md"), "w", encoding="utf-8") as f:
        f.write(text)


def write_manifest(folder_abs, folder_name, entries):
    path = os.path.join(folder_abs, "manifest.csv")
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["file", "id", "name", "type", "rarity", "cost", "element",
                    "attack", "health", "keywords", "status", "size", "prompt", "negative"])
        for e in entries:
            exists = os.path.exists(os.path.join(folder_abs, e["id"] + ".png"))
            w.writerow([
                e["id"] + ".png", e["id"], e["name"], TYPE_RU.get(e["type"], e["type"]),
                e["rarity"], e["cost"], e["element"], e["attack"], e["health"], e["keywords"],
                "OK" if exists else "НЕТ ФАЙЛА", SIZE,
                e["prompt"].replace('"', "'"), e["negative"].replace('"', "'"),
            ])
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="только отчёт, ничего не писать")
    args = ap.parse_args()

    _, entries = load_cards()

    by_folder = {}
    for e in entries:
        by_folder.setdefault(folder_for(e), []).append(e)

    # порядок вывода: фракции как в ТЗ, токены последними
    order = [f for f in FACTIONS if f in by_folder] + [f for f in by_folder if f not in FACTIONS]

    total_ok = 0
    print("Папки артов: unity/EchoCitadel/Assets/Resources/Cards/")
    print("-" * 74)
    print(f"{'папка':<14} {'фракция':<14} {'карт':>5} {'есть':>5} {'нет':>5}  прогресс")
    print("-" * 74)

    for folder in order:
        items = by_folder[folder]
        folder_abs = os.path.join(ART_ROOT, folder)
        if not args.check:
            os.makedirs(folder_abs, exist_ok=True)
            write_readme(folder_abs, folder, items)
            write_manifest(folder_abs, folder, items)

        ok = sum(1 for e in items if os.path.exists(os.path.join(folder_abs, e["id"] + ".png")))
        missing = len(items) - ok
        total_ok += ok
        bar_len = 22
        filled = int(round(bar_len * ok / max(1, len(items))))
        bar = "█" * filled + "·" * (bar_len - filled)
        print(f"{folder:<14} {FACTION_RU.get(folder, folder):<14} {len(items):>5} {ok:>5} {missing:>5}  {bar} {ok/len(items)*100:.0f}%")

    print("-" * 74)
    print(f"всего карт {len(entries)}, артов на месте {total_ok}, не хватает {len(entries) - total_ok}")
    if args.check:
        print("(режим --check: файлы не изменялись)")
    else:
        print("созданы/обновлены README.md и manifest.csv в каждой папке")
    return 0


if __name__ == "__main__":
    sys.exit(main())
