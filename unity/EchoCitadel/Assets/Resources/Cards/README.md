# Арты карт: структура папок

Пути заданы в `Assets/StreamingAssets/Cards.json` (`artworkPath`) и общих
метаданных `meta.artLayout`. Карты основного набора лежат прямо в папке
фракции; карты подфракций — в подпапках. Отдельные категории: `Neutral` и `_Tokens`.

| Фракция | Семейство | Код | Папка внутри `Cards/` | Карт |
|---|---|---|---|---:|
| Ауриты | Основной набор | — | `Aurites/` | 58 |
| Ауриты | Мехи / механоиды | `meh` | `Aurites/Mechanoids/` | 14 |
| Ауриты | Братство паладинов | `pal` | `Aurites/PaladinBrotherhood/` | 14 |
| Некрусы | Основной набор | — | `Necrus/` | 59 |
| Некрусы | Вампиры | `vmp` | `Necrus/Vampires/` | 14 |
| Некрусы | Ведьмы | `wtc` | `Necrus/Witches/` | 14 |
| Терраморфы | Основной набор | — | `Terramorph/` | 56 |
| Терраморфы | Энты | `ent` | `Terramorph/Ents/` | 14 |
| Терраморфы | Аспиды | `asp` | `Terramorph/Aspids/` | 14 |
| Пироманты | Основной набор | — | `Pyromancer/` | 57 |
| Пироманты | Гремлины | `grm` | `Pyromancer/Gremlins/` | 14 |
| Пироманты | Каннибалы | `cnb` | `Pyromancer/Cannibals/` | 14 |
| Эфирные | Основной набор | — | `Ethereal/` | 60 |
| Эфирные | Спрайты | `spr` | `Ethereal/Sprites/` | 14 |
| Эфирные | Суккубы | `scc` | `Ethereal/Succubi/` | 14 |
| Нейтральные | Основной набор | — | `Neutral/` | 10 |
| Нейтральные | Священное братство / священники | `sbd` | `Neutral/SacredBrotherhood/` | 14 |
| Нейтральные | Иссохшие | `wtd` | `Neutral/Withered/` | 14 |
| Нейтральные | Наёмники | `nsu` | `Neutral/Mercenaries/` | 32 |
| Токены | Отдельная категория | — | `_Tokens/` | 7 |

## Добавление арта

Файл назначения — `<id>.png`; точная папка показана в `artworkPath` карты и в
локальном `manifest.csv`. PNG не генерируются этим скриптом.
Плоский drop-in `art_raw/<id>.png` сохранён: `npm run art:sync` или
`npm run art:process` положит обработанную копию по вложенному `artworkPath`.
Прототип отдаёт файл через `/art/<Faction>[/<Family>]/<id>.png`.

Пересоздать папки и манифесты: `python3 tools/generator/make_art_folders.py`.
Проверить наличие PNG: `python3 tools/generator/make_art_folders.py --check`.
