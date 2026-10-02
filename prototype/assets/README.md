# Ассеты клиента «Эхо-Цитадель» (v3.12)

Все папки для ваших артов. PNG кладутся как есть — код подхватит их сам (пока файла нет,
показывается тематический фолбэк без «затычек»). В git PNG игнорируются: коммитьте с `git add -f`.

| Папка | Что класть |
|---|---|
| `icons/` | Значки верхней панели (десктоп): home, collection, decks, packs, store, events, campaign, online, mastery, quests, rules + малые tutorial, settings, exit. Квадрат с прозрачным фоном, 96–128 px |
| `ui/` | `logo.png` — логотип топбара (горизонтальный, ~600×160, прозрачный фон) |

Серверные арты (не в этой папке, а в корне репо):
- `art_raw/<id>.png` → арты карт (flat drop-in; сервер/синк используют `/art/<Фракция>[/<Семейство>]/<id>.png` по artworkPath);
- `art_raw/heroes/<Фракция>/` — портреты героев для «Быстрого выбора» и аватаров;
- `art_raw/cosm/{backs,tables,runes,offers,bundles,bp,quests,events,mana,sets}/` — косметика и ключ-арты (см. `art_raw/README.md`).
