#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Заполняет data/locale/en.json английскими строками из tools/locale_en/.

Источник истины — Cards.json: имена берутся по card_id, тексты способностей и
флейворы — по уникальной русской строке (порядок первого появления в файле,
см. tools/locale_en/texts.py и flavors.py).

Запуск:  python3 tools/translate_en.py            — собрать/обновить en.json
         python3 tools/translate_en.py --check    — только отчёт, без записи
         python3 tools/translate_en.py --sample N — показать N пар ru→en
"""
import json
import os
import sys
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

from locale_en.names import NAMES          # noqa: E402
from locale_en.texts import TEXTS          # noqa: E402
from locale_en.flavors import FLAVORS      # noqa: E402
from locale_en.misc import TOKENS, UI_EN   # noqa: E402

CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
OUT_EN = os.path.join(ROOT, 'data', 'locale', 'en.json')


def unique_ordered(cards, field):
    """Уникальные непустые значения поля в порядке первого появления."""
    acc = OrderedDict()
    for c in cards:
        v = (c.get(field) or '').strip()
        if v:
            acc.setdefault(v, []).append(c['id'])
    return acc


def main():
    check = '--check' in sys.argv
    sample = 0
    if '--sample' in sys.argv:
        i = sys.argv.index('--sample')
        sample = int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 10

    data = json.load(open(CARDS, encoding='utf-8'))
    cards = data['cards']
    tokens = data.get('tokens') or []

    texts = unique_ordered(cards, 'abilityText')
    flavors = unique_ordered(cards, 'flavor')

    problems = []
    if len(TEXTS) != len(texts):
        problems.append(f'TEXTS: в таблице {len(TEXTS)}, в Cards.json {len(texts)} уникальных '
                        f'текстов — обновите tools/locale_en/texts.py')
    if len(FLAVORS) != len(flavors):
        problems.append(f'FLAVORS: в таблице {len(FLAVORS)}, в Cards.json {len(flavors)} — '
                        f'обновите tools/locale_en/flavors.py')
    if problems:
        print('✖ Нельзя собрать en.json:')
        for p in problems:
            print('  ·', p)
        return 1

    tmap = dict(zip(texts.keys(), TEXTS))
    fmap = dict(zip(flavors.keys(), FLAVORS))

    en = dict(UI_EN)
    missing, empty_text, empty_flavor = [], 0, 0
    for c in cards:
        cid = c['id']
        nm = NAMES.get(cid, '')
        if not nm:
            missing.append(cid)
        en[f'card_{cid}_name'] = nm
        t = (c.get('abilityText') or '').strip()
        en[f'card_{cid}_text'] = tmap.get(t, '') if t else ''
        if t and not en[f'card_{cid}_text']:
            empty_text += 1
        f = (c.get('flavor') or '').strip()
        en[f'card_{cid}_flavor'] = fmap.get(f, '') if f else ''
        if f and not en[f'card_{cid}_flavor']:
            empty_flavor += 1

    for t in tokens:
        tid = t['id']
        nm, tx = TOKENS.get(tid, ('', ''))
        en[f'card_{tid}_name'] = nm
        en[f'card_{tid}_text'] = tx or 'Token'
        en[f'card_{tid}_flavor'] = (t.get('flavor') or '').strip() and '' or ''
        if not nm:
            missing.append(tid)

    filled = sum(1 for v in en.values() if v)
    print(f'✔ en.json: {len(en)} ключей, заполнено {filled} '
          f'({filled * 100 // max(1, len(en))}%)')
    if missing:
        print(f'  ⚠ нет EN-имени: {len(missing)} → {", ".join(missing[:12])}'
              f'{"…" if len(missing) > 12 else ""}')
    if empty_text:
        print(f'  ⚠ пустой EN-текст: {empty_text} карт')
    if empty_flavor:
        print(f'  ⚠ пустой EN-флейвор: {empty_flavor} карт')

    # контроль: не осталось ли в значениях кириллицы (кроме кавычек-ёлочек)
    cyr = [k for k, v in en.items() if any('а' <= ch <= 'я' or 'А' <= ch <= 'Я' for ch in v)]
    if cyr:
        print(f'  ⚠ кириллица в {len(cyr)} значениях: {", ".join(cyr[:8])}')

    if sample:
        print(f'\n--- примеры пар ru→en ({sample}) ---')
        for i, (ru, ids) in enumerate(texts.items()):
            if i >= sample:
                break
            print(f'  {ids[0]:>8} | {ru[:58]} → {TEXTS[i][:58]}')

    if check:
        print('\n(режим --check: файл не перезаписан)')
        return 0

    with open(OUT_EN, 'w', encoding='utf-8') as f:
        json.dump(en, f, ensure_ascii=False, indent=1)
    print(f'→ записано: {os.path.relpath(OUT_EN, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
