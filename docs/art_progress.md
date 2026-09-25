# Эхо-Цитадель — прогресс генерации PNG-артов

Пайплайн интеграции (единый для прототипа и Unity):
1. `generate_image` → `art_raw/<id>.png` (квадратная композиция под арт-зону 70%).
2. Нормализация PIL: центр-кроп в квадрат → 768×768 PNG (optimize).
3. Файл кладётся в `unity/EchoCitadel/Assets/Resources/Cards/<Faction>/<id>.png`
   (путь совпадает с `artworkPath` в Cards.json).
4. Прототип: `tools/serve.js` отдаёт папку по `/art/…`; `artUrlFor()` (src/ui/art.ts)
   строит URL; `cardArt()` рисует `<image … preserveAspectRatio="xMidYMid slice">`
   поверх процедурной заглушки. Файла нет → остаётся заглушка, ошибок нет.
5. Unity: тот же файл читается `Resources.Load<CardArtPath>`.

Правило_batches: **5 генераций за один заход**, дальше отчёт и «продолжи».

> **ВАЖНО (правило заказчика,2026-09-24): изображения генерирует ТОЛЬКО пользователь —
> ассистент сам ничего не генерирует (никакого generate_image).** Роль ассистента по арт-конвейеру:
> вести очереди и промпты, готовить drop-in пути, принимать файлы пользователя
> (art_raw → art:sync → проверка /art → смок → этот док), процедурные CSS/SVG-заглушки в коде игры.
> AI-генерация изображений ассистентом запрещена, даже по команде «продолжи».

## Готово

### Пакет 1 (2026-09-03) — флагманы фракций, 5 карт
| id | карта | фракция | редкость | файл |
|----|-------|---------|----------|------|
| nec_15 | Жнец Тысячи Голосов | Necrus | Legendary | Resources/Cards/Necrus/nec_15.png |
| ter_14 | Владыка Недр | Terramorph | Legendary | Resources/Cards/Terramorph/ter_14.png |
| pyr_14 | Избранник Огня | Pyromancer | Legendary | Resources/Cards/Pyromancer/pyr_14.png |
| eth_15 | Серебряный архонт | Ethereal | Legendary | Resources/Cards/Ethereal/eth_15.png |
| aur_14 | Престол Вечного Света | Aurites | Epic | Resources/Cards/Aurites/aur_14.png |

### Пакет 2 (2026-09-24) — следующие по id,5 карт
| id | карта | фракция | редкость | файл |
|----|-------|---------|----------|------|
| aur_15 | Крылатый страж порога | Aurites | Common | Resources/Cards/Aurites/aur_15.png |
| nec_14 | Владыка Могильника | Necrus | Epic | Resources/Cards/Necrus/nec_14.png |
| ter_13 | Мать Леса | Terramorph | Epic | Resources/Cards/Terramorph/ter_13.png |
| pyr_13 | Пепельный титан | Pyromancer | Rare | Resources/Cards/Pyromancer/pyr_13.png |
| eth_14 | Похититель пустоты | Ethereal | Epic | Resources/Cards/Ethereal/eth_14.png |

Всего на диске: 16 PNG (пакет 1 + пакет 2 + 6 семплов Unity).

### Ранее (семплы Unity, 6 карт)
aur_01, eth_01, nec_01, pyr_01, ter_01, tkn_spark — первые семплы в тех же папках.

## Очередь следующих пакетов
Правило: оставшиеся Legendary/Epic → Rare → Common, по порядку id внутри фракции;
только id с промптом в `docs/art_prompts.csv` (CSV сейчас покрывает 5 фракций + Neutral;
фракции вроде meh_/pal_ ждут промптов). Осталось: 61 L/E + 118 R + 261 C, из них с промптами — 141.
Кандидаты Пакета 3: pyr_r06 (Руна Вечного Пламени, L), pyr_s09 (Зов Вулкана, L),
ter_s09 (Сердце Мира, L), aur_r06 (Руна Последнего Света, E), aur_s09 (Откровение Вечности, E).

## Контроль
- Смоук-чеки: «PNG-арты флагманов интегрированы (пакет 1: 5 карт)» и
  «PNG-арты интегрированы (пакет 2: 5 карт)» — файлы на диске + PNG-магия + `artUrlFor` в бандле.
- Ручная сверка: `curl /art/<Faction>/<id>.png` → 200, md5 == диск.

## Drop-in режим (2026-09-04)
Художник кладёт файл в `art_raw/<id>.png` (принимаются также .jpg/.jpeg/.webp;
`aur_1.png` понимается как `aur_01`) — прототип подхватывает его **сразу**, без шагов:
- `tools/serve.js`: запрос `/art/<Faction>/<id>.png` резолвится так:
  1) `art_raw/<id>*` (свежий файл, приоритет), 2) `Resources/Cards/<Faction>/<id>.png`.
  Папки drop-in: `/home/user/art_raw` и `/home/user/echo-citadel/art_raw` (подпапки игнорируются).
- Для Unity: `npm run art:sync` — нормализует (центр-кроп квадрат, 768×768, PIL; без PIL — копия)
  и раскладывает по `artworkPath` из Cards.json; неизвестные id пропускаются с предупреждением.
- Оригиналы пакетов 1 и 2 лежат в `art_raw/_processed/` (не мешают drop-in).
- Смоук: чек «drop-in артов: art_raw/<id>.png подхватывается сервером».
- Проверено функционально: aur_2.png → `/art/Aurites/aur_02.png` 200 (md5==файл), sync создал
  копию в Resources, после удаления файла — снова 404 (резолв на каждый запрос).
