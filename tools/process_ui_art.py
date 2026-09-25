#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""process_ui_art.py — пост-обработка UI-арта (Часть 1 арт-задач).

raw (prototype/img/raw/) → готовое (prototype/img/):
  menu_<fac>.png   → menu_<fac>.jpg 1920×1080 (crop-to-fill)
  card_frame.png   → card_frame.png 380×532, белый фон/центр → альфа (оверлей рамки)
  ico_*.png        → нарезка листов по колонкам, чёрный фон → альфа, иконки 96×96:
                    ico_cur_0..4 (◈,💎,пыль,билет,осколок), ico_fac_0..4, ico_ach_0..5
Запуск: python3 tools/process_ui_art.py
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'prototype', 'img', 'raw')
OUT = os.path.join(ROOT, 'prototype', 'img')


def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, v))


def key_white(im: Image.Image, lo=200, hi=232) -> Image.Image:
    """Белый ключ: min(r,g,b) >= hi → прозрачно, полоса lo..hi — перо."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = min(r, g, b)
            if m >= hi:
                px[x, y] = (r, g, b, 0)
            elif m > lo:
                px[x, y] = (r, g, b, int(255 * (hi - m) / (hi - lo)))
    return im


def key_black(im: Image.Image, lo=18, hi=48) -> Image.Image:
    """Чёрный ключ: max(r,g,b) <= lo → прозрачно, полоса lo..hi — перо."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = max(r, g, b)
            if m <= lo:
                px[x, y] = (r, g, b, 0)
            elif m < hi:
                px[x, y] = (r, g, b, int(255 * (m - lo) / (hi - lo)))
    return im


def bbox_of_alpha(im: Image.Image):
    return im.getchannel('A').getbbox()


def crop_to_fill(im: Image.Image, w: int, h: int) -> Image.Image:
    sw, sh = im.size
    ar, sr = w / h, sw / sh
    if sr > ar:
        nw = int(sh * ar)
        im = im.crop(((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh))
    else:
        nh = int(sw / ar)
        im = im.crop((0, (sh - nh) // 2, sw, (sh - nh) // 2 + nh))
    return im.resize((w, h), Image.LANCZOS)


def slice_columns(im: Image.Image, expect: int):
    """Режет лист на иконки по пустым колонкам альфы."""
    a = im.getchannel('A')
    w, h = im.size
    hist = [0] * w
    px = a.load()
    for x in range(w):
        col = 0
        for y in range(0, h, 2):
            if px[x, y] > 24:
                col = 1
                break
        hist[x] = col
    runs, start = [], None
    gap = 0
    for x in range(w):
        if hist[x]:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max(6, w // 60):
                runs.append((start, x - gap))
                start = None
    if start is not None:
        runs.append((start, w))
    runs = [r for r in runs if r[1] - r[0] > w // (expect * 3)]
    if len(runs) != expect:
        # фолбэк: равномерная сетка
        cw = w // expect
        runs = [(i * cw, (i + 1) * cw) for i in range(expect)]
    out = []
    for x0, x1 in runs:
        cell = im.crop((x0, 0, x1, h))
        bb = bbox_of_alpha(cell)
        if bb:
            cell = cell.crop(bb)
        out.append(cell)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    done = []
    # 1) фоны меню
    for fac in ('aurites', 'necrus', 'terramorph', 'pyromancer', 'ethereal'):
        src = os.path.join(RAW, f'menu_{fac}.png')
        if not os.path.exists(src):
            continue
        im = crop_to_fill(Image.open(src), 1920, 1080).convert('RGB')
        im.save(os.path.join(OUT, f'menu_{fac}.jpg'), quality=84, optimize=True)
        done.append(f'menu_{fac}.jpg')
    # 2) рамка карты
    src = os.path.join(RAW, 'card_frame.png')
    if os.path.exists(src):
        im = key_white(Image.open(src))
        bb = bbox_of_alpha(im)
        if bb:
            im = im.crop(bb)
        im = im.resize((380, 532), Image.LANCZOS)
        im.save(os.path.join(OUT, 'card_frame.png'), optimize=True)
        done.append('card_frame.png')
    # 3) листы иконок
    sheets = [('ico_currency.png', 'ico_cur', 5), ('ico_factions.png', 'ico_fac', 5),
              ('ico_achieve.png', 'ico_ach', 6)]
    for fname, pref, n in sheets:
        src = os.path.join(RAW, fname)
        if not os.path.exists(src):
            continue
        im = key_black(Image.open(src))
        icons = slice_columns(im, n)
        for i, ic in enumerate(icons):
            ic = ic.copy()
            ic.thumbnail((96, 96), Image.LANCZOS)
            canvas = Image.new('RGBA', (96, 96), (0, 0, 0, 0))
            canvas.paste(ic, ((96 - ic.width) // 2, (96 - ic.height) // 2), ic)
            canvas.save(os.path.join(OUT, f'{pref}_{i}.png'), optimize=True)
            done.append(f'{pref}_{i}.png')
        print(f'  лист {fname}: нарезов {len(icons)} (ожидалось {n})')
    print('✔ process_ui_art:', ', '.join(done) or 'нечего обрабатывать')


if __name__ == '__main__':
    main()
