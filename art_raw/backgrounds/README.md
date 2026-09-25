# Фоны Эхо-Цитадели — drop-in как с картами

Кидай файлы прямо в эти папки, прототип и Unity подхватят их без пересборки.

```
art_raw/backgrounds/menu/      — главное меню (тёмный камень + руны)
art_raw/backgrounds/battle/    — стол боя (доска, виньетка)
art_raw/backgrounds/home/      — Home (дракон, Welcome)
art_raw/backgrounds/decks/     — Decks (сетка коробок)

art_raw/backgrounds_animated/menu/   — анимированные фоны меню
art_raw/backgrounds_animated/battle/ — анимированные фоны боя
```

### Поддерживается
- **Статика:** `.png` `.jpg` `.jpeg` `.webp` `.gif` — кладёшь `menu_aurites.png` или просто `menu.png`
- **Анимация:** `.mp4` `.webm` `.gif` — `menu.mp4` / `battle.webm` (autoplay loop muted, 30fps, до 12MB, 1920×1080)
- Регистр и расширения не важны: `Menu.PNG` = `menu.png`, `battle.mp4` = `BATTLE.MP4`
- Если файла нет — остаётся CSS-градиент + `board_arena.png` (фолбэк)

### Имена
- `menu.jpg` — общий фон меню
- `menu_aurites.jpg` / `menu_necrus.jpg` — per-фракция (подхватывается по `picked` фракции)
- `battle.jpg` — общий стол
- `battle_terra.jpg` — тёмный лес для Терраморфов etc.
- `home_dragon.png` — уже в `prototype/img/home_dragon.png`, можно заменить `art_raw/backgrounds/home/dragon.png`

### Роуты (serve.js)
```
/bg/menu/menu          → art_raw/backgrounds/menu/menu.* → prototype/img/backgrounds/menu/menu.*
/bg/menu/menu_aurites  → art_raw/backgrounds/menu/menu_aurites.* 
/bg/battle/battle      → art_raw/backgrounds/battle/battle.*
/bg/animated/menu/menu → art_raw/backgrounds_animated/menu/menu.mp4
```
Приоритет: `art_raw` (свежий drop) → `prototype/img/backgrounds` (закоммиченный фолбэк) → CSS-градиент.

### Рекомендации
- Статика: `1920×1080` или `2560×1440`, `jpg 80%` / `webp`, ~400–700KB
- Видео: `H.264 mp4` или `VP9 webm`, `1920×1080`, `3–6 сек` loop, **без звука**, `2–6MB`, `30fps`, `CRF 28`
- Тёмный оверлей уже в CSS (`radial #050a1a`), не делай фон слишком светлым
- Для меню — оставляй центр `50% 38%` посветлее (там карусель), края темнее

### Примеры (положи и обнови Ctrl+Shift+R)
```bash
cp ~/Downloads/my_menu.jpg art_raw/backgrounds/menu/menu.jpg
cp ~/Downloads/battle_loop.mp4 art_raw/backgrounds_animated/battle/battle.mp4
```

