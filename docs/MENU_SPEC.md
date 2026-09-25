# Спека «1. Главное меню» — статус реализации (v2.4.0)

Дата: 2026-09-21. Треки: **A — HTML-прототип** (проверен смоуком) и **B — Unity C#**
(код написан, компиляция — на машине с Unity; песочница Unity не запускает).
Единый источник данных фракций: `unity/EchoCitadel/Assets/StreamingAssets/factions.json`
(прототип импортирует его как Cards.json; Unity читает `FactionCatalog.Load()`).

## Пункт за пунктом

| Спека | Прототип (трек A) | Unity (трек B) |
|---|---|---|
| 1.1 Карусель фракций вверху, золотая подсветка активной | `#menuHeroes.heroRow.facCarousel` — 5 чипов: сигил + аватар героя (/heroes/) + иконка фракции (ico_fac_N) + имя; `.heroChip.sel` подсвечивается цветом фракции | `MainMenuController.BuildCarousel()`, chipPrefab (Sel-подсветка), клик → `PickFaction()` |
| 1.1 Смена фона + палитры UI | `applyMenuBg()`: кроссфейд 0.5с через слой `#menuBgFx` (.menuBgFx.show, CSS transition) + CSS-переменные `--fac/--fac2` на `#menu` (свечение menuBox/кнопок/рамок в цвет фракции) | `CrossfadeBackground()` (CanvasGroup bgFade↔bgCurrent, 0.5с), `ApplyPalette()` (paletteTargets), фон `Resources/UI/menu_<fac>` |
| 1.1 Звук whoosh | `Audio_.whoosh()` — синтез (полосовой шум 420→2800Гц + тон), src/ui/audio.ts | `sfxSource.PlayOneShot(whooshClip)` (клип назначается в инспекторе) |
| 1.1 Сохранение выбора между запусками | `localStorage["ec.pickedFaction"]` (PICK_KEY), восстановление при старте | `PlayerPrefs["ec.faction"]` — тот же ключ |
| 1.2 Панель «Ваша фракция»: 5 карточек, активная с золотой рамкой | `#playerFactions` — 5 fcard, `.fcard.sel` в палитре фракции | `BuildFactionPanel()`, factionCardPrefab |
| 1.2 Клик → модалка с описанием/механикой/советами/примерами | `#factionModal` (overlay z320 + пружина panelSpring): сигил, название, тэглайн, полное описание, механика пассивки, 3 совета, 3 примера карт (самые дешёвые фракции, renderCard), кнопка «Играть за …» = выбор фракции | `OpenFactionModal()`: те же поля (facSigil/facName/…/facTipsRoot/facExamplesRoot), btnFactionPlay → PickFaction |
| 1.2 Данные из factions.json | `FACTION_INFO` из StreamingAssets/factions.json (фолбэк PASSIVE_TEXT) | `FactionCatalog.Load()` из того же файла |
| 1.3 Противник: 5 фракций + «Случайно» | `#enemyFaction` (своя фракция исключена + `__random`) — было | `BuildEnemyDropdown()` (ids + `__random`; случай выбирается в PlayFlow) |
| 1.3 Сложность ИИ | `#difficulty` — **4 уровня** (см. отклонения) | `BuildDifficultyDropdown()` (DiffNames/DiffValues) |
| 1.3 Выбор колоды + «Создать колоду» | `#deckPick` (базовые + мои из localStorage) + новая кнопка `#btnMakeDeck` → Коллекция · вкладка «Конструктор» (при отсутствии колод сразу `btnDbNew`) | `BuildDeckDropdown()` (пока базовые колоды; пользовательские — TODO BLOCK 2, DeckStorage) + `OnMakeDeck()` (deckBuilderRoot) |
| 1.3 Чекбокс «Тренировка» | `#chkPractice` — без рейтинга/наград, **опыт пропуска начисляется** (bpXp 60/25) — было | `practiceToggle` + `PlayerPrefs["ec.practice"]` |
| 1.4 Гейт валидности колоды | `updatePlayGate()`: ровно **40 карт**, лимиты 4/1 легендарка (`validateDeckSize` в deckstore.ts); невалидна → `btnPlay.disabled` + подсказка в title «Колода не собрана: …» | `UpdatePlayGate()`/`ValidateSelectedDeck()` (40 карт, 4/1), `btnPlay.interactable` + `playHint` |
| 1.4 POST /api/match/start → match_id | `requestMatchStart()`: fetch на `http://<host>:8080/api/match/start` (payload: playerFaction/enemyFaction/difficulty/deckId/practice/mmr), таймаут 700мс; **сервер недоступен → локальный бой** (matchId=null); match_id пишется в телеметрию (meta.telem[].matchId) | `PlayFlow()`: UnityWebRequest POST (timeout 1с), `_lastMatchId`, затем `SceneManager.LoadScene(battleSceneName)` |
| 1.4 REST на сервере | `server/match_server.ts`: `POST /api/match/start` → `{ok, match_id (UUID), seed}`, CORS (*) + OPTIONS 204, pending-карта (≤512, FIFO-чистка), `/health` дополнен `pending` | — (клиент) |
| 1.5 Нижняя панель навигации | `#menuNav` — 8 кнопок (Коллекция/Бустеры/Профиль/Магазин/Кампания/Обучение/Пропуск/Правила), выезд `navRise` при загрузке меню | `navButtons` + `overlayPanels` (1:1), `OpenOverlay()` |
| 1.5 Панели — overlay с пружиной, не сцены | Все модалки — фикс-оверлеи z320 (правило v2.3.2) + `panelSpring` .5s cubic-bezier(.22,1.4,.36,1) на `.packPanel` | `SpringPanel()`: coroutine, выезд снизу (-560px) с перелётом (AnimationCurve), scale .97→1, alpha |

## Отклонения от спеки (согласованы с пользователем 2026-09-21)

1. **Колода 40 карт, не 30** (п.1.4): всё ТЗ, экономика и баланс (10k-прогоны 45–55%)
   построены на 40 картах / playset 4 / 1 легендарка. «30» в спеке трактуется как опечатка.
2. **4 уровня сложности, не 3** (п.1.3): Ученик(0.6)/Адепт(0.8)/Магистр(0.95)/Мифический(1.05,
   lookahead). «Ученик» сохранён для обучения и новичков; «Мастер» спеки = наш «Магистр».
3. **Чистота фракции не входит в гейт «В бой»**: базовые колоды Decks.json содержат сплэши
   чужих фракций и отбалансированы в таком виде; гейт проверяет только размер/лимиты копий
   (`validateDeckSize`). Правило «только своя фракция + нейтральные» остаётся в конструкторе
   пользовательских колод (`validateDeck`).
4. **Разделение кликов (п.1.1 vs 1.2)**: карусель сверху = мгновенный выбор; клик по карточке
   в панели «Ваша фракция» = модалка подробностей, выбор — её кнопкой «Играть за …».
5. **Бой остаётся локальным (PvE)**: сервер выдаёт match_id/seed для телеметрии и реплеев;
   серверно-авторитетный PvP — отдельный блок (match_server WS уже есть).

## Ключи сохранений (одинаковые имена в обоих треках)

| Данные | Прототип (localStorage) | Unity (PlayerPrefs) |
|---|---|---|
| Фракция игрока | `ec.pickedFaction` | `ec.faction` |
| Фракция противника | значение `#enemyFaction` (сессия) | `ec.enemy` |
| Сложность (индекс) | значение `#difficulty` (сессия) | `ec.difficulty` |
| Колода | значение `#deckPick` (сессия) | `ec.deck` |
| Тренировка | `#chkPractice` (сессия) | `ec.practice` |
| Мета/коллекция | `ec.meta`, `ec.owned`, `ec.shards`, … | TODO BLOCK 2 (MetaStorage) |

## Проверка

- Прототип: `npm run typecheck` чисто; `node tools/smoke_prototype.js` — 🎉, включая новые
  проверки «Меню v2.4» (карусель 5 чипов, #menuNav 8 кнопок, btnMakeDeck, гейт В-бой активен
  на базовой колоде, #menuBgFx, overlay-правило с #factionModal, panelSpring/navRise, модалка
  фракции: описание >80 симв., 3 примера карт, 3 совета, выбор+закрытие, localStorage) и
  раздел [4] теперь выбирает фракцию через модалку.
- Сервер: `curl -X POST :8080/api/match/start` → `{"ok":true,"match_id":"<uuid>","seed":…}`,
  OPTIONS → 204 (CORS), `/health` → `{ok,rooms,pending}`.
- Unity: код не компилировался в песочнице (Unity отсутствует). Порядок проверки на машине:
  открыть проект → NuGet: System.Text.Json → повесить `MainMenuController` на UIRoot в
  Main.unity → назначить ссылки (соглашения по префабам — в шапке MainMenuController.cs) →
  скопировать `prototype/img/menu_*.jpg`/`ico_fac_*.png` в `Assets/Resources/UI/` (jpg→png
  конвертация не требуется, импорт как Sprite/Texture2D) → Play.
