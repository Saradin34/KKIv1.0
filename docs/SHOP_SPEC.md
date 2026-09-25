# СПЕЦИФИКАЦИЯ «3. 🛒 МАГАЗИН» — реализация v2.4.2

Дата: 2026-09-21. Треки: HTML-прототип (?v=2.4.2) + meta_server (:8081) + Unity C# (некомпилированный, по решению пользователя компиляция на его стороне).
Решения пользователя (binding): **пыль = текущая валюта ◈** (переименована семантически, перетарифицирована; новой валюты нет); **стартовый набор 💎400** (не 500 из спеки).

## 1. Тарифы (п.4.4 + дубликаты)

| Редкость | Крафт ◈ | Разбор ◈ | Дубликат из бустера → ◈ |
|---|---|---|---|
| Обычная | 5 | 1 | 1 |
| Редкая | 20 | 5 | 5 |
| Эпическая | 100 | 20 | 20 |
| Легендарная | 400 | 100 | 100 |

Playset: ≤4 копий. Базовые карты (не расширение) разбираются только до 1 копии.
Константы: `CRAFT_COST`, `DUST_GAIN`, `CONVERT` — синхронно в `src/ui/prototype.ts` и `server/meta_server.ts`.

## 2. Бустеры (п.4.1)

- Обычный бустер — **◈300**: 5 карт = 3 обычных + 1 редкая + 1 эпическая (шанс **12.5%** → легендарная). Пул: только расширение ECH1 (`meta.expansionIds` из Cards.json).
- Фракционный бустер — **◈350**: тот же состав, пул — карты одной фракции (≥5, иначе фолбэк на общий пул).
- Набор «11 по цене 10» — **◈2700**: `freeOpens += 11`.
- Анимация вскрытия (флип 5 слотов) — уже была в прототипе (v2.3), сохранена.

## 3. Стартовые наборы (п.4.2)

5 наборов (по фракциям, `starter_<Fac>`): **💎400**, одноразовые (повтор → 409, кнопка «Куплен» неактивна).
Грант: 10 бустеров (`freeOpens+=10`) + 500 ◈ + эксклюзивный аватар `arch` (`purchases: ['ava_arch']`).
Пример из спеки — «Набор Некруса».

## 4. Косметика (п.4.3) + предпросмотр

Каталог (`GET /api/shop → cosmetics`): рубашки `back_classic/back_runes(◈300)/back_ember(◈500)/back_abyss(БП)/back_verdant(БП)`; столы `table_classic/table_terra(◈600)/table_necro(💎200)`; руны `rune_classic/rune_flame(💎150)`.
БП-предметы (`currency:'bp'`) не продаются → 403; кнопка неактивна.
**НОВОЕ — предпросмотр по клику 👁**: модалка `#cosmPreview` (z320, panelSpring):
- рубашка → большая карта 150×210 `.cardback.back-ID` + стопка «в руке»;
- стол → `.tablePrev` с градиентами `body[data-table]` (terra/necro/classic);
- руны → `.runeChip`×3, для flame — пульсация `@keyframes runePulse`.
Закрытие: кнопка ✕ или клик по оверлею. 10 кнопок предпросмотра (5+3+2) — смоук-проверено.

## 5. Сервер (meta_server :8081)

| Эндпоинт | Тело | Семантика |
|---|---|---|
| `GET /api/shop` | — | каталог: boosters/starters/cosmetics/craft/dust |
| `POST /api/shop/buy` | `{pid,itemId,faction?}` | 200 `{ok,item,grants?/drops?,shards,gems}`; 400 (pack_faction без faction), 402 (не хватает ◈/💎), 403 (bp), 404 (нет товара), 409 (повтор набора/косметики) |
| `POST /api/collection/add` | `{pid,ids[]}` | копии ≤4 → collection; излишек → ◈ по тарифу разбора. 200 `{added,converted,shards}` |
| `POST /api/craft` | `{pid,cardId}` | playset → 409, ◈ < цены → 402; 200 `{shards,copies}` |
| `POST /api/dust` | `{pid,cardId}` | нечего разбирать → 409; 200 `{shards,copies}` |

Покупки: `gp.purchases[]` (косметика + ava_arch), `gp.bundles[]` (стартовые наборы), `gp.freeOpens`, `gp.cosmetics` (pass-through зеркала клиента: backs/tables/runes/backEq/tableSkin/runeSkin).
Профиль-дефолты для новых pid: ◈1200, 💎100. `rollPack(faction)` — серверный генератор (3C+1R+1E/12.5%L), идентичен клиентскому.
Live-проверка curl: **12/12 сценариев** (включая все коды ошибок).

## 6. Прототип (v2.4.2)

- Перетарификация: CRAFT_COST/DUST_GAIN/CONVERT; подпись пилюли ◈: «Пыль ◈ (золото): бустеры, крафт (5/20/100/400) и разбор (1/5/20/100)»; jl-примечание вкладки «Крафт».
- `syncProfile` отправляет: shards, gems, freeOpens, bundles, cosmetics.
- Смоук: конверсия дубликата `>=1`, крафт `−5`/разбор `+1`, regex тарифов, live-поток 👁→модалка→«Рубашка»→закрытие. **🎉 ПРОЙДЕН**.

## 7. Unity C# (Assets/Scripts/UI/) — не скомпилировано

- **`ShopController.cs`** (Промпт 1): GET /api/shop → DTO `ShopCatalog`; 4 вкладки (SwitchTab); покупка `Buy(itemId, faction?)` → POST /api/shop/buy; 200 → кошелёк (PlayerPrefs `ec.wallet.shards/gems`), `OnPackOpened(drops)` + `PackGenerator.AddToCollection`, `OnBundleBought`, `OnPurchased`; ошибка → тост (префаб toastAchievement из §2). БП-товары: кнопка неактивна.
- **`PackGenerator.cs`** (Промпт 2): `Generate(BoosterType, Faction?, db, rng?)` → 3C+1R+1E/12.5%L, пул расширения (`ExpansionIds()` читает `meta.expansionIds` из Cards.json напрямую — в `CardsFileMeta` поля пока нет, добавить при догоне порта BLOCK 2); фракционный фильтр ≥5 карт; `AddToCollection` → POST /api/collection/add.
- **`CraftingController.cs`** (Промпт 3): `SelectCard(c, copies)` → стоимость/доход; «Создать» → локальная проверка ◈ → POST /api/craft; «Разобрать» → панель подтверждения → POST /api/dust; тарифы-зеркала `CraftCost/DustGain`; события `OnCardSelected/OnCollectionChanged`; `SetCardArt(sprite)` — арт назначает список коллекции.
- **`MenuContext.cs`** (НОВОЕ, правка латентной ошибки §2): компонент общих зависимостей (database/achievements/quests) — `ProfileScreen` уже ссылался на него, теперь класс существует. Повесить на UIRoot.

Интеграция в сцене: ShopController + CraftingController + MenuContext на UIRoot; `baseUrl` = адрес meta_server; префаб itemShop («Name»/«Price»/«Tag»/«BuyButton»), confirmDust («Text»/«YesButton»/«NoButton»).

## 8. Отклонения от спеки (документированы)

1. Цена стартового набора **💎400** (в спеке 500) — решение пользователя.
2. Пыль — не новая валюта, а существующая ◈ — решение пользователя.
3. «Реальные деньги» в прототипе не реализованы (нет платёжного провайдера); наборы покупаются за 💎.

## 9. v2.5.2 — Арена-витрина (редизайн по скрину MTG Arena, 2026-09-22)

Верстка/стилистика — «как на скринах» в нашей тёпло-золотой манере (решение пользователя):

1. **Панель-арена** `#shopModal .packPanel.shopArena` — широкая `min(1180px,96vw)`, тёмно-фиолетовый фон с верхним сиянием.
2. **Топ-бар** `.shTop`: заголовок «🛒 МАГАЗИН» `.shTitle` (Philosopher, трекинг .14em) + кошелёк `.shWallet` (пилюли 💎/🪙/◈).
3. **Горизонтальные ленты** `.ofRow` (overflow-x, scroll-snap): карточки `.ofCard` (192px, `.sm` 172px) — арт-окно `.ofArt` (108px: веер рубашек `.ofFan i` ×3 для бустеров/наборов, сигил фракции `.ofSig` на фракционном градиенте `f-*`, эмодзи `.ofBig` для бандлов), имя `.ofName`, подстрочник `.ofSub`, ряд покупки `.ofBuy`.
4. **Ценники-пилюли** `button.btn.price.gold|.price.gem` — градиенты золото/гем (как в пропуске); `:disabled` — grayscale. Бустеры: `#buyPack`, `.buyFacPack` (фракционные, 5 шт.), `#buyBundle11`; наборы: `#btnStarter` (💎400), `.buyBundle`.
5. **Косметика** — сетка `.ofGrid` с группами `.ofGroup` («Рубашки»/«Столы»/«Руны»), превью-свотчи `.ofSw` (t-terra/t-necro/t-classic; r-flame/r-classic), кнопки `.cosmPrev` (👁 предпросмотр — контракт смоука ≥10) + `.backBtn/.tableBtn/.runeBtn` сохранены.
6. **Крафт** — строки `.cfRow` (`.cfName` + тарифы + `.craftBtn2`), тарифы спеки: крафт 5/20/100/400, разбор 1/5/20/100 (пыль ◈).
7. **Нижние вкладки** `.shTabs > button.btn.shTab.stab` (Коллекция/Крафт/Наборы) — класс `stab` обязателен: переключение через существующее делегирование `closest('.stab')` с `data-stab`; активная — `.sel`.
8. Кнопка `btnPackNew` и все обработчики покупок сохранены (смоук зелёный).

## 10. v2.5.3 — Дроп-ин папки косметики и наборов (art_raw/cosm)

Пользовательский арт подхватывается без пересборки: файл кладётся в папку — сразу виден
в магазине (свотч/арт-окно карточки), в 👁-предпросмотре и (для НАДЕТОГО скина) в бою.
Пока файла нет — CSS-фолбэк (градиент/сигил/веер), заглушек нет ( standing-правило).

| Категория | Папка | Точные имена файлов | Размер |
|---|---|---|---|
| Рубашки карт | `art_raw/cosm/backs/` | classic, runes, ember, abyss, verdant `.png` | 512×720 |
| Скины игрового стола | `art_raw/cosm/tables/` | classic, terra, necro `.png` | 1920×1080 |
| Анимации рун | `art_raw/cosm/runes/` | classic, flame `.png` (+ опц. кадры `<id>/01..16.png` для Unity) | 512×512 RGBA |
| Предложения | `art_raw/cosm/offers/` | booster, pack_<Фракция> ×5, bundle11 `.png` | 768×432 |
| Наборы | `art_raw/cosm/bundles/` | starter, <Фракция> ×5 `.png` | 768×432 |

Фракции: Aurites, Necrus, Terramorph, Pyromancer, Ethereal. Допустимы .png/.jpg/.jpeg/.webp.

**Роут**: `tools/serve.js` → `GET /cosm/<kind>/<id>` (kind ∈ backs|tables|runes|offers|bundles,
id санитизируется; 404 содержит подсказку куда положить файл).

**Прототип**: `cosmImg(kind,id,cls)` — `<img … onerror="this.remove()">` поверх фолбэка
(оффер-карточки `offers/booster`, `offers/pack_*`, `offers/bundle11`, `bundles/starter`,
`bundles/<F>`; свотчи косметики `.cbArt/.ofSwImg/.rcImg`; модалка 👁). Надетый арт в бою —
`applyCosmArt()`: HEAD-проба `/cosm/{backs,tables,runes}/<надетый-id>` → `<style id="cosmArtStyle">`
(рубашки `#hand/#enemyBacks .cardback`, стол `#board`, чипы рун `.runeChip`); вызов из
`applySettings()` и из equip-рубашки; в jsdom (нет fetch) — молчаливый пропуск.

**Unity-зеркало**: `Assets/Resources/Cosm/{Backs,Tables,Runes,Offers,Bundles}/` (README
в каждой; загрузка `Resources.Load<Texture2D>("Cosm/Backs/<id>")`).

### 10.1. v2.5.4 — hardening дроп-ина (2026-09-22)

Репорт: «картинки не подтягиваются» — диагностика: файлы не попадали в workspace песочницы
(дроп на локальной машине невидим серверу; workspace — единственный источник). Усиления:
1. Роут `/cosm/<kind>/<id>` регистронезависим (`Classic.PNG` = `classic.png`), ищет также
   подпапку кадров `<id>/` (первый файл) и Unity-зеркало `Assets/Resources/Cosm/<Kind>/`.
2. Кэш-баст `?t=<ts>` в `cosmImg()` и в инжекте `applyCosmArt()` — замена файла видна
   при следующем открытии магазина без hard-refresh.
3. `openShop()` вызывает `applyCosmArt()` — надетый скин освежается при каждом открытии.
**Доставка файлов пользователем**: вложение в чат (landing `/home/user/uploads/`) → агент
раскладывает в `art_raw/cosm/<kind>/` под точными именами; либо дроп в сам workspace.

### 10.2. v2.5.5 — корректное применение надетых скинов в бою (2026-09-22)

Репорт: «поле применяется некорректно (шов), рубашка не применяется на карты».
Причины и фиксы в `applyCosmArt()` (инжект `<style id="cosmArtStyle">`):
1. **Шов стола**: арт инжектился в `#board` (только верхние зоны), тогда как весь стол
   в бою — полноэкранный `#backdrop .bgArt` (дефолт `board_arena.png`); панель руки
   оставалась дефолтной → видимый шов. Теперь арт стола инжектится в `#backdrop .bgArt`
   (center/cover, анимация bgBreath сохраняется).
2. **Рубашка**: стопы колод — это `.pbacks .cardback` (вне `#hand`/`#enemyBacks`), а темовые
   правила `body[data-back="runes"|"ember"] …` имели бóльшую специфичность и перебивали
   инжект. Теперь селектор: `#hand .cardback, #enemyBacks .cardback, .pbacks .cardback`
   с `!important` (обе стопы + обе руки). Свотчи магазина (`.cardback.mini/.big`) не touched.
