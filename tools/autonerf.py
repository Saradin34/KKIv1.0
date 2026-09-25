#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""autonerf.py — авто-предложения нерфов/бафов по данным баланса (ТЗ: data science).

Читает docs/balance/balance_report.csv (результат симуляции run_balance.ts),
находит карты с NeedsBalance=YES и винрейтом вне коридора 45–55% и генерирует
docs/balance/nerf_proposals.md с конкретными предложениями (стоимость ±1).

НИЧЕГО НЕ МЕНЯЕТ АВТОМАТИЧЕСКИ: применение — только флагом --apply, и после него
ОБЯЗАТЕЛЬНА повторная симуляция (tools/balance/run_balance.ts), чтобы подтвердить,
что фракционные винрейты остались в 45–55%.

Использование:
  python3 tools/autonerf.py            # только отчёт-предложение
  python3 tools/autonerf.py --apply    # применить cost±1 к Cards.json
"""
import csv, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, 'docs', 'balance', 'balance_report.csv')
CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
OUT = os.path.join(ROOT, 'docs', 'balance', 'nerf_proposals.md')
LO, HI = 0.45, 0.55      # коридор ТЗ
MIN_PLAYED = 25          # малая выборка — не трогаем


def fnum(row, key, default=0.0):
    try:
        return float(row.get(key, '') or default)
    except ValueError:
        return default


def main():
    apply = '--apply' in sys.argv
    with io.open(REPORT, encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print('balance_report.csv пуст'); return 1

    db = json.load(io.open(CARDS, encoding='utf-8'))
    by_name = {}
    for c in db['cards']:
        by_name.setdefault(c.get('name', ''), c)

    over, under = [], []
    for r in rows:
        wr = fnum(r, 'WinRateWhenPlayed') or fnum(r, 'WinRate')
        played = int(fnum(r, 'TimesPlayed'))
        name = r.get('CardName', '')
        flag = (r.get('NeedsBalance', '') or '').upper() == 'YES'
        if played < MIN_PLAYED:
            continue
        if flag and wr > HI:
            over.append((name, wr, played))
        elif flag and wr < LO:
            under.append((name, wr, played))
    over.sort(key=lambda t: -t[1]); under.sort(key=lambda t: t[1])

    def prop(name, wr, nerf):
        c = by_name.get(name)
        if not c:
            return f'| {name} | {wr*100:.1f}% | — | нет в Cards.json | |'
        cost = int(c.get('cost', 0))
        if nerf:
            if cost < 10:
                return f'| {name} | {wr*100:.1f}% | cost {cost} → {cost+1} | {cost+1} | {c["id"]} |'
            return f'| {name} | {wr*100:.1f}% | статы −1/−1 (вручную) | | {c["id"]} |'
        if cost > 0:
            return f'| {name} | {wr*100:.1f}% | cost {cost} → {cost-1} | {cost-1} | {c["id"]} |'
        return f'| {name} | {wr*100:.1f}% | хп +1 (вручную) | | {c["id"]} |'

    lines = ['# Авто-предложения баланса (autonerf.py)', '',
             f'Коридор ТЗ: {LO*100:.0f}–{HI*100:.0f}% (WinRateWhenPlayed), флаг NeedsBalance=YES, '
             f'выборка ≥ {MIN_PLAYED} розыгрышей. Источник: docs/balance/balance_report.csv.',
             '',
             '> **Предложения НЕ применяются автоматически.** Каждое нужно подтвердить',
             '> повторной симуляцией: `npm run balance` (esbuild tools/balance/run_balance.ts → build/run_balance.js --matches 10000).',
             '', '## Слишком сильные (нерф)', '',
             '| Карта | WinRate | Предложение | new cost | id |', '|---|---|---|---|---|']
    lines += [prop(n, w, True) for n, w, _ in over[:20]] or ['| — | — | — | | |']
    lines += ['', '## Слишком слабые (баф)', '',
              '| Карта | WinRate | Предложение | new cost | id |', '|---|---|---|---|---|']
    lines += [prop(n, w, False) for n, w, _ in under[:20]] or ['| — | — | — | | |']
    lines += ['', '## Порядок применения',
              '1. `python3 tools/autonerf.py --apply` — правит **только cost** (±1) у карт из таблиц выше;',
              '2. повторная симуляция баланса (10k матчей) — фракционные винрейты должны остаться 45–55%;',
              '3. если карта ушла в коридор — коммит Cards.json + balance_report.csv вместе;',
              '4. если нет — откатить изменение и попробовать правку статов вручную.', '']
    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'✔ {os.path.relpath(OUT, ROOT)}: нерф-кандидатов {len(over)}, баф-кандидатов {len(under)}')

    if apply:
        changed = 0
        for name, wr, _ in over:
            c = by_name.get(name)
            if c and int(c.get('cost', 0)) < 10:
                c['cost'] = int(c['cost']) + 1; changed += 1
        for name, wr, _ in under:
            c = by_name.get(name)
            if c and int(c.get('cost', 0)) > 0:
                c['cost'] = int(c['cost']) - 1; changed += 1
        io.open(CARDS, 'w', encoding='utf-8').write(json.dumps(db, ensure_ascii=False, indent=1))
        print(f'✔ --apply: cost изменён у {changed} карт. ОБЯЗАТЕЛЬНО повторная симуляция баланса!')
    return 0


if __name__ == '__main__':
    sys.exit(main())
