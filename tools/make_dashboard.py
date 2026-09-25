#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_dashboard.py — текстовый дашборд баланса из docs/balance/*.csv.

Собирает faction_report.csv + balance_report.csv в docs/balance/dashboard.md
(фракционные винрейты, топ/низ карт, средняя длина матча) — «дашборд без сервера»
для ревью. Продакшн-дашборды — Metabase/Grafana поверх PostgreSQL-вью
(server/schema.sql: v_card_winrate), см. раздел «Grafana/Metabase» в dashboard.md.
"""
import csv, io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAL = os.path.join(ROOT, 'docs', 'balance')
OUT = os.path.join(BAL, 'dashboard.md')


def read(name):
    p = os.path.join(BAL, name)
    if not os.path.exists(p):
        return []
    with io.open(p, encoding='utf-8') as f:
        return list(csv.DictReader(f))


def fnum(r, k, d=0.0):
    try:
        return float(r.get(k, '') or d)
    except ValueError:
        return d


def main():
    facs = read('faction_report.csv')
    cards = read('balance_report.csv')
    L = ['# Дашборд баланса (генерируется tools/make_dashboard.py)', '']

    if facs:
        L += ['## Фракции (коридор ТЗ 45–55%)', '', '| Фракция | WinRate | Матчи | Статус |', '|---|---|---|---|']
        for r in facs:
            name = r.get('Faction') or r.get('faction') or '?'
            wr = fnum(r, 'WinRate') or fnum(r, 'Winrate')
            m = r.get('Games') or r.get('Matches') or ''
            ok = '✅' if 0.45 <= wr <= 0.55 else '⚠️'
            L.append(f'| {name} | {wr*100:.1f}% | {m} | {ok} |')
        L.append('')

    if cards:
        def key(r):
            return fnum(r, 'WinRateWhenPlayed') or fnum(r, 'WinRate')
        played = [r for r in cards if fnum(r, 'TimesPlayed') >= 25]
        top = sorted(played, key=key, reverse=True)[:10]
        low = sorted(played, key=key)[:10]
        for title, sel in (('## Топ-10 по винрейту (нерф-кандидаты)', top),
                           ('## Низ-10 по винрейту (баф-кандидаты)', low)):
            L += [title, '', '| Карта | Фракция | WinRate при розыгрыше | Розыгрышей |', '|---|---|---|---|']
            for r in sel:
                L.append(f'| {r.get("CardName","?")} | {r.get("Faction","?")} | '
                         f'{key(r)*100:.1f}% | {int(fnum(r,"TimesPlayed"))} |')
            L.append('')
        if facs and any('AvgTurns' in r for r in facs):
            vals = [fnum(x, 'AvgTurns') for x in facs if fnum(x, 'AvgTurns')]
            if vals:
                L += [f'Средняя длина матча: **{sum(vals)/len(vals):.1f} ходов** (по фракциям)', '']

    L += ['## Grafana / Metabase (продакшн)', '',
          'Живые данные после soft launch берутся из PostgreSQL, а не из CSV:', '',
          '1. `server/schema.sql` создаёт таблицу телеметрии `match_card_events` (played/stuck по ходам)',
          '   и вью `v_card_winrate` (winrate при розыгрыше, средняя длина).',
          '2. **Metabase**: подключить PG → вопрос «SELECT * FROM v_card_winrate ORDER BY winrate_when_played DESC»',
          '   → dashboards «Карты», «Фракции», «Длина матча».',
          '3. **Grafana**: PG data source → панели по `v_card_winrate`, `match_history.duration_seconds`,',
          '   retention D1/D7/D30 по `profiles.created_at` + `match_history.started_at`.',
          '4. CSV-дашборд выше — оффлайн-режим для симуляций до запуска серверов.', '',
          'Авто-предложения нерфов/бафов: `npm run autonerf` → docs/balance/nerf_proposals.md',
          '(применение только вручную + повторная симуляция `npm run balance`).', '']
    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(L))
    print(f'✔ {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
