# Дашборд баланса (генерируется tools/make_dashboard.py)

## Фракции (коридор ТЗ 45–55%)

| Фракция | WinRate | Матчи | Статус |
|---|---|---|---|
| Terramorph | 53.6% | 4078 | ✅ |
| Pyromancer | 51.1% | 3953 | ✅ |
| Ethereal | 49.4% | 4025 | ✅ |
| Necrus | 48.0% | 4070 | ✅ |
| Aurites | 47.8% | 3874 | ✅ |

## Топ-10 по винрейту (нерф-кандидаты)

| Карта | Фракция | WinRate при розыгрыше | Розыгрышей |
|---|---|---|---|
| Метеоритный дождь | Pyromancer | 78.0% | 1106 |
| Руна Абсолютной Тьмы | Necrus | 71.3% | 810 |
| Избранник Огня | Pyromancer | 70.5% | 678 |
| Похититель пустоты | Ethereal | 69.0% | 1463 |
| Руна Первозданной Земли | Terramorph | 66.3% | 867 |
| Вулканический колосс | Pyromancer | 66.2% | 820 |
| Руна Абсолютной Иллюзии | Ethereal | 65.0% | 580 |
| Руна Последнего Света | Aurites | 63.0% | 2106 |
| Пепельный титан | Pyromancer | 61.7% | 1762 |
| Похищение разума | Ethereal | 60.9% | 1659 |

## Низ-10 по винрейту (баф-кандидаты)

| Карта | Фракция | WinRate при розыгрыше | Розыгрышей |
|---|---|---|---|
| Полночный реквием | Necrus | 23.9% | 411 |
| Проклятие Тлена | Necrus | 34.5% | 1725 |
| Руна Горения | Pyromancer | 37.1% | 502 |
| Пир Праха | Necrus | 39.2% | 4745 |
| Руна Вечной Жатвы | Necrus | 40.7% | 523 |
| Руна Тяжести | Terramorph | 41.1% | 1343 |
| Пробуждение Колосса | Terramorph | 42.6% | 1480 |
| Кровавый обмен | Necrus | 42.8% | 5845 |
| Огненный снаряд | Pyromancer | 43.2% | 2913 |
| Инферно | Pyromancer | 45.0% | 717 |

Средняя длина матча: **12.0 ходов** (по фракциям)

## Grafana / Metabase (продакшн)

Живые данные после soft launch берутся из PostgreSQL, а не из CSV:

1. `server/schema.sql` создаёт таблицу телеметрии `match_card_events` (played/stuck по ходам)
   и вью `v_card_winrate` (winrate при розыгрыше, средняя длина).
2. **Metabase**: подключить PG → вопрос «SELECT * FROM v_card_winrate ORDER BY winrate_when_played DESC»
   → dashboards «Карты», «Фракции», «Длина матча».
3. **Grafana**: PG data source → панели по `v_card_winrate`, `match_history.duration_seconds`,
   retention D1/D7/D30 по `profiles.created_at` + `match_history.started_at`.
4. CSV-дашборд выше — оффлайн-режим для симуляций до запуска серверов.

Авто-предложения нерфов/бафов: `npm run autonerf` → docs/balance/nerf_proposals.md
(применение только вручную + повторная симуляция `npm run balance`).
