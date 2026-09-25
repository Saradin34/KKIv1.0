# UI-арт: генерация и интеграция (Часть 1)

Статус: **выполнено**. Все ассеты — зона ответственности агента (фоны/UI/иконки);
карты и портреты героев по-прежнему дропает пользователь в `art_raw/`.

## Пайплайн

1. Генерация (DALL-E-класс) → `prototype/img/raw/<name>.png` (промпты ниже).
2. Пост-обработка: `python3 tools/process_ui_art.py`
   - фоны меню: crop-to-fill 1920×1080 → `prototype/img/menu_<fac>.jpg` (q84);
   - рамка: белый ключ (min-channel 200–232 feather) → альфа, bbox-crop, 380×532 →
     `prototype/img/card_frame.png` (центр полностью прозрачен: alpha=0);
   - листы иконок: чёрный ключ (max-channel 18–48 feather) → альфа, автонарезка по
     пустым колонкам (фолбэк — равномерная сетка), 96×96 → `ico_cur_0..4 / ico_fac_0..4 / ico_ach_0..5`.
3. Интеграция (см. ниже) + фолбэки: у каждого `<img>` есть `onerror` (глиф/CSS-фон).

## Задачи и промпты (адаптация промптов ревью под пайплайн)

### 1. Фоны главного меню по фракциям → `menu_<fac>.jpg`
База: *"Dark fantasy game UI background, main menu screen of a collectible card game:
<локация>, доминирующая палитра <FACCOLOR>, cinematic lighting, volumetric fog,
Hearthstone-style painterly detail, 4k, UI background, darker empty space in the center
for buttons, no text/characters/logos, 16:9"*
- aurites: цитадельный зал, HOLY GOLD, солнечные лучи;
- necrus: костяные катакомбы, necrotic PURPLE, души-огоньки;
- terramorph: терраса живого камня, NATURE GREEN, споры;
- pyromancer: кузница углей, FIRE RED, искры;
- ethereal: коридор пустоты, ETHEREAL BLUE, звёздная пыль.
**Интеграция:** `applyMenuBg()` в buildMenu — фон `.menuBg` переключается по выбранной
фракции; при отсутствии файла — прежний `board_arena.png`.

### 2. Рамки карт → `card_frame.png` (оверлей)
*"Trading card game card frame overlay, ornate gold and dark metal border with runic
engravings, thick decorative border with corner ornaments, ENTIRE inner center is a pure
solid white empty rectangle for artwork, Hearthstone-like layout, portrait 5:7, isolated
on pure white, 4k, no text"*
**Интеграция:** `<img class="frameOv">` в каждой `.card` (рука/коллекция/зум/бустер):
z-index 2 — поверх арта, ПОД текстом (ctype z3, chead/cfoot z4) ⇒ читаемость не страдает;
фракционная идентификация сохранена (кольцо artBox, facIco, цвета рамок ART_SPEC).

### 3. Иконки валют → `ico_cur_0..4.png`
*"ONE horizontal row of exactly 5 icons: gold coin with runic symbol, blue crystal gem,
purple dust swirl, battle pass ticket scroll, silver shard; fantasy, glowing, 3D render,
pure black background, 4k"*
**Интеграция:** `ico_cur_0` = ◈ золото, `ico_cur_1` = 💎 гемы — верхняя панель меню и
шапка магазина (глиф-фолбэк через onerror). 2–4 (пыль/билет/осколок) — резерв под
дашборд/пропуск.

### 4. Иконки фракций → `ico_fac_0..4.png`
*"ONE row of exactly 5 glowing minimal icons: golden sun, purple skull, green tree,
red flame, blue crystal; pure black background, 4k"*
**Интеграция:** шапки регионов карты кампании (`.facIcoWrap`, сигил-глиф за img как
фолбэк и для дальтоник-режима). Порядок = FACTION_IDS: Aurites…Ethereal.

### 5. Иконки квестов/достижений → `ico_ach_0..5.png`
*"ONE row of exactly 6 icons: crossed swords, shield, open book, potion flask, crown,
laurel wreath; gold and dark iron, 3D render, pure black background, 4k"*
**Интеграция:** список достижений профиля (мечи=Первая победа, корона=10 побед,
книга=10 бустеров); резерв 1/3/5 под недельные задания и BP-бейджи.

## Проверки
- Смоук-чек «UI-арт ч.1»: файлы на диске + вшитость в бандл/HTML.
- Альфа-контроль: центр рамки alpha=0, бордюр alpha=255; нарезка листов 5/5/6 без фолбэка.
- Все `<img>` UI-арта с `onerror`-фолбэком: отсутствующий файл не ломает верстку.

## Готово к Части 2 (когда пришлёте)
Свободные слоты пайплайна: спрайты эффектов (вспышки урона/лечения), рубашки бустеров
для 3D-пака, текстуры столов под скины (сейчас градиенты), аватары-рамки профиля.
