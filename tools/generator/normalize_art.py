#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — нормализация артов карт под требования ТЗ п.9.
=====================================================================
Художник или генерация обычно отдают картинку крупнее и/или другого
соотношения. Скрипт приводит ВСЕ арты в папках фракций к единому виду:

    размер        512 × 720 px (или --scale 2 → 1024 × 1440 для ретины)
    соотношение   5:7 — лишнее обрезается по центру (cover), ничего не плющится
    формат        PNG, sRGB, без альфы (карта непрозрачная)
    вес           оптимизированный PNG; обычно 300–500 КБ

Что делает:
  1. находит *.png / *.jpg / *.jpeg / *.webp в Assets/Resources/Cards/**;
  2. кадрирует до соотношения 5:7 по центру;
  3. масштабирует до 512×720 (Lanczos);
  4. сохраняет как <id>.png (исходник другого формата остаётся рядом — можно
     удалить вручную или флагом --clean);
  5. печатает отчёт с вложенным путём; манифесты обновляет make_art_folders.py.

Идемпотентен: файл уже 512×720 → пропускает (если не задан --force).

Запуск:
    python3 tools/generator/normalize_art.py            # проверить и привести
    python3 tools/generator/normalize_art.py --dry      # только отчёт
    python3 tools/generator/normalize_art.py --scale 2  # 1024×1440
    python3 tools/generator/normalize_art.py --clean    # удалить исходники jpg/webp
"""

import argparse
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ART_ROOT = os.path.join(ROOT, "unity", "EchoCitadel", "Assets", "Resources", "Cards")
SOURCES = (".png", ".jpg", ".jpeg", ".webp")
RATIO = 5.0 / 7.0   # 512:720


def target_size(scale):
    return 512 * scale, 720 * scale


def crop_to_ratio(im, ratio):
    """Кадрирование по центру до нужного соотношения (аналог object-fit: cover)."""
    w, h = im.size
    cur = w / h
    if abs(cur - ratio) < 1e-3:
        return im
    if cur > ratio:                       # шире, чем нужно → режем бока
        nw = int(round(h * ratio))
        left = (w - nw) // 2
        return im.crop((left, 0, left + nw, h))
    nh = int(round(w / ratio))            # выше, чем нужно → режем верх/низ
    top = (h - nh) // 2
    return im.crop((0, top, w, top + nh))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="только отчёт, файлы не менять")
    ap.add_argument("--force", action="store_true", help="пересохранять даже файлы нужного размера")
    ap.add_argument("--scale", type=int, default=1, help="1 → 512×720 (ТЗ), 2 → 1024×1440")
    ap.add_argument("--clean", action="store_true", help="удалить исходники .jpg/.jpeg/.webp после конвертации")
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("Нужен Pillow:  pip install Pillow", file=sys.stderr)
        return 2

    tw, th = target_size(args.scale)
    print(f"Целевой размер: {tw}×{th} (соотношение 5:7), папка {os.path.relpath(ART_ROOT, ROOT)}")
    print("-" * 78)

    changed = skipped = missing = 0
    if not os.path.isdir(ART_ROOT):
        print(f"Папка артов не найдена: {ART_ROOT}", file=sys.stderr)
        return 2

    for folder_abs, dirs, filenames in os.walk(ART_ROOT):
        dirs.sort()
        rel_folder = os.path.relpath(folder_abs, ART_ROOT)
        folder = "" if rel_folder == "." else rel_folder.replace(os.sep, "/")
        arts = [name for name in sorted(filenames) if name.lower().endswith(SOURCES)]
        if not arts:
            continue

        for name in arts:
            rel_name = f"{folder}/{name}" if folder else name
            src = os.path.join(folder_abs, name)
            stem = os.path.splitext(name)[0]
            dst = os.path.join(folder_abs, stem + ".png")
            try:
                with Image.open(src) as im:
                    w0, h0 = im.size
                    if (w0, h0) == (tw, th) and src == dst and not args.force:
                        skipped += 1
                        continue
                    if args.dry:
                        print(f"{rel_name:<56} {w0}×{h0} → требуется {tw}×{th}")
                        changed += 1
                        continue
                    im = crop_to_ratio(im.convert("RGB"), RATIO)
                    if im.size != (tw, th):
                        im = im.resize((tw, th), Image.LANCZOS)
                    im.save(dst, "PNG", optimize=True)
                    size_kb = os.path.getsize(dst) // 1024
                    print(f"{rel_name:<56} {w0}×{h0} → {tw}×{th}, {size_kb} КБ")
                    changed += 1
                    if args.clean and src != dst:
                        os.remove(src)
            except Exception as e:                       # noqa: BLE001 — отчёт важнее падения
                print(f"{rel_name:<56} ОШИБКА: {e}")
                missing += 1

    print("-" * 78)
    mode = "требуют правки" if args.dry else "приведено к ТЗ"
    print(f"{mode}: {changed}, уже в норме: {skipped}, ошибок: {missing}")
    if args.dry and changed:
        print("запустите без --dry, чтобы применить")
    return 0


if __name__ == "__main__":
    sys.exit(main())
