#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Дамп русских строк для переводчика + отчёт о покрытии data/locale/en.json.

  python3 tools/locale_check.py            — отчёт по en.json
  python3 tools/locale_check.py --dump     — дописать build/_loc/for_translation.txt
                                             (список T000…/F00… в порядке Cards.json,
                                             тот же порядок, что в tools/locale_en/*.py)

Порядок уникальных строк — «первое появление при обходе Cards.json»; именно в нём
лежат списки TEXTS/FLAVORS в tools/locale_en/, поэтому дамп — опора для следующей
волны перевода (добавились карты → свежий дамп → дописать хвост списков).
"""
import json
import os
import sys
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
LOCALE = os.path.join(ROOT, 'data', 'locale')
DUMP_DIR = os.path.join(ROOT, 'build', '_loc')


def unique_ordered(cards, field):
    acc = OrderedDict()
    for c in cards:
        v = (c.get(field) or '').strip()
        if v:
            acc.setdefault(v, []).append(c['id'])
    return acc


def main():
    data = json.load(open(CARDS, encoding='utf-8'))
    cards = data['cards']
    tokens = data.get('tokens') or []
    texts = unique_ordered(cards, 'abilityText')
    flavors = unique_ordered(cards, 'flavor')

    en = {}
    p = os.path.join(LOCALE, 'en.json')
    if os.path.exists(p):
        en = json.load(open(p, encoding='utf-8'))
    ru = {}
    p = os.path.join(LOCALE, 'ru.json')
    if os.path.exists(p):
        ru = json.load(open(p, encoding='utf-8'))

    keys = len(en)
    filled = sum(1 for v in en.values() if v)
    print(f'Карт: {len(cards)} | токенов: {len(tokens)}')
    print(f'Уникальных текстов: {len(texts)} | уникальных флейворов: {len(flavors)}')
    print(f'en.json: {keys} ключей, заполнено {filled} ({filled * 100 // max(1, keys)}%)')
    print(f'ru.json: {len(ru)} ключей')

    if en:
        no_name = [c['id'] for c in cards if not en.get(f"card_{c['id']}_name")]
        no_text = [c['id'] for c in cards
                   if (c.get('abilityText') or '').strip() and not en.get(f"card_{c['id']}_text")]
        no_flav = [c['id'] for c in cards
                   if (c.get('flavor') or '').strip() and not en.get(f"card_{c['id']}_flavor")]
        cyr = [k for k, v in en.items() if v and any('а' <= ch <= 'я' or 'А' <= ch <= 'Я' for ch in v)]
        print(f'  без EN-имени:   {len(no_name)}' + (f' → {", ".join(no_name[:8])}' if no_name else ' ✓'))
        print(f'  без EN-текста:  {len(no_text)}' + (f' → {", ".join(no_text[:8])}' if no_text else ' ✓'))
        print(f'  без EN-флейвора:{len(no_flav)}' + (f' → {", ".join(no_flav[:8])}' if no_flav else ' ✓'))
        print(f'  кириллица в значениях: {len(cyr)}' + (f' → {", ".join(cyr[:8])}' if cyr else ' ✓'))
        miss = [k for k in ru if k not in en]
        extra = [k for k in en if k not in ru]
        print(f'  ключи: есть в ru, нет в en — {len(miss)}; лишние в en — {len(extra)}'
              + (f' {extra[:5]}' if extra else ''))

    if '--dump' in sys.argv:
        os.makedirs(DUMP_DIR, exist_ok=True)
        out = os.path.join(DUMP_DIR, 'for_translation.txt')
        with open(out, 'w', encoding='utf-8') as f:
            f.write('=== NAMES (id => ru) ===\n')
            for c in cards:
                f.write(f"{c['id']}\t{c['name']}\n")
            f.write('\n=== ABILITY TEXTS (unique, порядок = tools/locale_en/texts.py) ===\n')
            for i, (t, ids) in enumerate(texts.items()):
                f.write(f'T{i:03d}\t{t}\n')
            f.write('\n=== FLAVORS (unique, порядок = tools/locale_en/flavors.py) ===\n')
            for i, (t, ids) in enumerate(flavors.items()):
                f.write(f'F{i:02d}\t{t}\n')
            f.write('\n=== TOKENS ===\n')
            for t in tokens:
                f.write(f"{t['id']}\t{t['name']}\t{(t.get('abilityText') or '').strip()}\n")
        print(f'→ дамп: {os.path.relpath(out, ROOT)} '
              f'({len(cards)} имён, {len(texts)} текстов, {len(flavors)} флейворов)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
