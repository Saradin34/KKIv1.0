#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
 ЭХО-ЦИТАДЕЛЬ — шаблоны для генерации артов (docs/ART_SPEC.md)
=====================================================================
 Рисует PNG-шаблоны с точными зонами рамки карты и медальона героя:
   _processed/templates/card_template_512x720.png
   _processed/templates/hero_template_512x512.png
 Зоны совпадают с боевой разметкой прототипа:
   • карта 512×720 (пропорция рамки 190:266 = 0.7143);
   • имя-пластина закрывает y 0–72 px (10%);
   • ВИДИМОЕ АРТ-ОКНО: y 72–504 px (10–70%), полная ширина;
   • типовая линия y 504–547 (70–76%); пергамент текста y 547–677 (76–94%);
   • безопасная зона сюжета: x 41–471, y 101–475 (с учётом кадрирования cover);
   • фокус кадрирования object-position: 50% 38% → центр сюжета ~(256, 274).
 Запуск: python3 tools/make_art_template.py
=====================================================================
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '_processed', 'templates')
os.makedirs(OUT, exist_ok=True)

def font(sz):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
              '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'):
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()

def card_template():
    W, H = 512, 720
    im = Image.new('RGBA', (W, H), (24, 18, 8, 255))
    d = ImageDraw.Draw(im)
    # сетка 10%
    for i in range(1, 10):
        d.line([(0, H * i // 10), (W, H * i // 10)], fill=(255, 255, 255, 36), width=1)
        d.line([(W * i // 10, 0), (W * i // 10, H)], fill=(255, 255, 255, 36), width=1)
    # скрытые зоны (пластины интерфейса)
    d.rectangle([0, 0, W, 72], fill=(0, 0, 0, 150))          # имя
    d.rectangle([0, 504, W, 677], fill=(0, 0, 0, 150))       # тип + пергамент
    # видимое арт-окно
    d.rectangle([0, 72, W, 504], outline=(120, 255, 140, 255), width=3)
    # безопасная зона сюжета
    d.rectangle([41, 101, 471, 475], outline=(255, 214, 90, 255), width=2)
    # фокус кадрирования 50%/38%
    d.line([(256 - 26, 274), (256 + 26, 274)], fill=(255, 90, 90, 255), width=3)
    d.line([(256, 274 - 26), (256, 274 + 26)], fill=(255, 90, 90, 255), width=3)
    f = font(20); fs = font(15)
    d.text((12, 24), 'ИМЯ КАРТЫ (скрыто)', fill=(255, 255, 255, 200), font=fs)
    d.text((12, 80), 'ВИДИМОЕ АРТ-ОКНО  y 72–504', fill=(150, 255, 160, 255), font=f)
    d.text((48, 108), 'БЕЗОПАСНАЯ ЗОНА СЮЖЕТА', fill=(255, 214, 90, 255), font=fs)
    d.text((12, 512), 'ТИП + ТЕКСТ (скрыто)', fill=(255, 255, 255, 200), font=fs)
    d.text((268, 262), 'фокус 50/38', fill=(255, 120, 120, 255), font=fs)
    d.text((12, 692), '512×720 px · PNG · рамка 3px + фаска · пропорция 0.7143', fill=(220, 200, 150, 255), font=fs)
    p = os.path.join(OUT, 'card_template_512x720.png')
    im.convert('RGB').save(p, 'PNG', optimize=True)
    return p

def hero_template():
    W = 512
    im = Image.new('RGBA', (W, W), (18, 14, 8, 255))
    d = ImageDraw.Draw(im)
    mask = Image.new('L', (W, W), 0)
    dm = ImageDraw.Draw(mask)
    dm.ellipse([8, 8, W - 8, W - 8], fill=70)
    d.rectangle([0, 0, W, W], fill=(0, 0, 0, 160))
    d.rectangle([0, 0, W, W], fill=(60, 50, 30, 0), width=0)
    im.paste(Image.new('RGBA', (W, W), (70, 58, 34, 255)), (0, 0), mask)
    d.ellipse([8, 8, W - 8, W - 8], outline=(216, 180, 90, 255), width=4)     # медальон
    d.ellipse([56, 56, W - 56, W - 56], outline=(255, 214, 90, 200), width=2)  # безопасный круг
    d.line([(256 - 24, 230), (256 + 24, 230)], fill=(255, 90, 90, 255), width=3)  # фокус лица ~45%
    d.line([(256, 230 - 24), (256, 230 + 24)], fill=(255, 90, 90, 255), width=3)
    f = font(18)
    d.text((150, 470), '512×512 · портрет в круг', fill=(230, 210, 160, 255), font=f)
    d.text((140, 70), 'лицо внутри круга', fill=(255, 214, 90, 255), font=f)
    p = os.path.join(OUT, 'hero_template_512x512.png')
    im.convert('RGB').save(p, 'PNG', optimize=True)
    return p

if __name__ == '__main__':
    a, b = card_template(), hero_template()
    print('✔ шаблоны для художника:')
    print(' ', os.path.relpath(a, ROOT))
    print(' ', os.path.relpath(b, ROOT))
