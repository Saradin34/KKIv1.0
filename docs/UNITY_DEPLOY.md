# Развертывание «Эхо-Цитадели» в Unity 2022.3 LTS

Версия 1.0 · 2026-09-21. Что уже лежит в репозитории и чего не хватает — ниже;
далее пошаговое развертывание на вашей машине и план догоняющего C#-порта.

## 0. Текущее состояние Unity-части

**Есть (`unity/EchoCitadel/Assets/`):**
- `Scripts/Core/` — C#-порт движка правил: `GameEngine.cs` (+ partial Effects/Statuses/Turn),
  `GameEnums.cs`, `GameTypes.cs`, `Rng.cs`, `MatchRunner.cs` (headless-матчи и `RunSimulation`
  для баланс-прогонов);
- `Scripts/AI/` — `AIController.cs`, `AIProfiles.cs` (приоритеты из ТЗ п.5.2);
- `Scripts/Data/` — `CardDatabase.cs` (читает **тот же** `StreamingAssets/Cards.json`, что и
  TS-прототип), `CardDataSO.cs` (ScriptableObject карты);
- `Editor/CardAssetGenerator.cs` — меню **EchoCitadel → Generate Card ScriptableObjects**;
- `Editor/SceneBootstrap.cs` — меню **EchoCitadel → Create Bootstrap Scene / Run Headless Demo**;
- `Scripts/Core/EchoBoot.cs` — рантайм-бутстрап: грузит Cards.json/Decks.json из StreamingAssets
  (Android — через UnityWebRequest), опционально headless-матч при старте сцены;
- `StreamingAssets/Cards.json` (500 карт, meta.expansionIds) + `Decks.json`;
- `Resources/Cards/` — обработанные арты 512×720 (+ превью 256×360), фолбэк-сигилы.

**Есть также:** `Packages/manifest.json` — URP 14.0.11, TextMeshPro 3.0.6, Test Framework,
NuGetForUnity (git-пакет) и полный набор модулей объявлены заранее: при первом открытии Unity
сам всё подтянет. `.gitignore` проекта (Library/ и пр. не коммитим).

**Создаётся Unity при первом открытии:** `ProjectSettings/`, `Library/`, `.meta`-файлы,
сцены (`.unity`). Папка — заготовка проекта: Unity сгенерирует недостающее сам.

**Догон v2.2 (2026-09-24):** C#-движок имеет LIFO-стек мгновенных (`Stack`, `ResolveStackTop`,
`PassStack`, `InteractiveStack=false` в симах), события `StackPushed`/`StackResolved`/
`InstantWindow`, lookahead-ИИ (`AIProfile.Lookahead`, `CloneForLookahead`, skill≥1 → «Мифический»).
`tools/csharp/verify.sh` собирает headless .NET 8 (без UnityEngine) и сверяет RNG/базу/колоды.
Мета-игра (профиль/магазин) по-прежнему пишется в Unity отдельно — раздел 7.4.

## 1. Установка окружения

1. Unity Hub → Install → **Unity 2022.3 LTS** (любой поздний patch). Модули: платформа цели
   (Windows/Android), при желании Android SDK/OpenJDK ставятся из Hub.
2. .NET SDK 8 (для parity-проверки порта из репозитория): `tools/csharp/verify.sh` ищет
   SDK в `~/.dotnet`; поставьте туда или в PATH.
3. Git-репозиторий проекта клонируйте/откройте как есть — Unity-папка внутри:
   `echo-citadel/unity/EchoCitadel/`.

## 2. Инициализация проекта

1. Unity Hub → **Add → Add project from disk** → выберите `unity/EchoCitadel`.
2. Откройте его Hub'ом в 2022.3 LTS. Первый импорт: Unity создаст `ProjectSettings/`,
   `Packages/`, `Library/` и `.meta` для всех ассетов (минуты 2–5 на артах).
3. В `Project Settings → Player`: Company/Product = EchoCitadel; API Compatibility
   Level = **.NET Standard 2.1** (System.Text.Json в CardDatabase требует его или .NET Framework
   profile — оставьте значение по умолчанию для 2022.3, оно подходит).

## 3. Пакеты (Window → Package Manager)

- **Universal RP 14.0.11**, **TextMeshPro 3.0.6**, **Test Framework**, **NuGetForUnity**
  уже объявлены в `Packages/manifest.json` — при первом открытии проекта Unity сам их
  подтянет (понадобится сеть). Пост-обработка — через **Volume/URP 14**, Post-Processing
  Stack НЕ ставим (решение зафиксировано в docs/VISUAL_STACK.md §7).
- **⚠ System.Text.Json**: `CardDatabase.cs` сериализует Cards.json через STJ, которого
  в Unity из коробки НЕТ. После первого открытия: меню **NuGet → Manage NuGet Packages** →
  найдите `System.Text.Json` → Install (версия 8.x, зависимости NuGetForUnity ставит сам:
  System.Memory, Buffers, Unsafe, Encodings.Web и т.д. — они лягут в `Assets/Packages/`).
  Альтернатива офлайн: положить те же DLL руками в `Assets/Plugins/`.
- **TextMeshPro**: при первом использовании TMP предложит **Import TMP Essentials** —
  согласитесь.
- Опционально под soft launch: Unity Gaming Services / собственная серверная обвязка
  (match-server WS :8080 и meta-server REST :8081 уже есть в `server/` — Unity-клиент ходит
  в них по HTTP/WS, см. docs/DEPLOYMENT.md §7).

## 4. Шрифты (кириллица)

TMP **не читает woff2** (в прототипе Philosopher/Alegreya лежат в woff2):
1. Конвертируйте в TTF/OTF (fonttools: `pyftsubset --flavor= --output-file=Philosopher.ttf ...`
   или возьмите оригинальные TTF у гарнитур — обе с кириллицей, OFL).
2. В Unity:Assets/Fonts/ → ПКМ → Create → TextMeshPro → Font Asset (atlas 2048,
   Character Set = Unicode Range 0020-04FF, чтобы влезла кириллица).
3. Назначьте в TMP-компонентах UI; fallback-шрифт для иконочных глифов (✦☠♨☾) — отдельный
   Font Asset с этими кодовыми точками.

## 5. Данные и стартовая сцена

1. **EchoCitadel → Generate Card ScriptableObjects**: генератор читает
   `StreamingAssets/Cards.json` и создаёт SO-карты (data-driven: правки баланса = правка JSON
   + регенерация, без ручного редактора).
2. **EchoCitadel → Create Bootstrap Scene**: создаёт `Assets/Scenes/Main.unity` с
   `GameCore (EchoBoot)` и заготовкой `UIRoot`. EchoBoot при старте грузит базу и (флаг
   `runHeadlessDemo`) прогонит headless-матч — смотрите Console.
3. **EchoCitadel → Run Headless Demo** — то же без входа в Play: быстрый смоук порта.
4. Play: в Console должно быть `[EchoBoot] База готова: карт = 300, колод = 6` и лог демо-матча.

## 6. Арт и визуал

- Арты карт: `Assets/Resources/Cards/<Faction>[/<Subfamily>]/<id>.png` 512×720 (ядро фракции — в корне, семейства — в подпапках; окно арта y 10–70% —
  docs/ART_SPEC.md); превью 256×360 для списков; загрузка в UI — `Resources.Load` или
  Addressables позже (на 300 карт Resources достаточно).
- Фоны/иконки UI (Часть 1 арт-задач): `prototype/img/*` — переложите в `Assets/Art/UI/`
  (menu_*.jpg как спрайты меню, card_frame.png — рамка-оверлей UI, ico_* — иконки).
  Генерация новых — пайплайн `tools/process_ui_art.py` (docs/UI_ART.md).
- Портреты героев: пользователь дропает в `/heroes` — в Unity кладите в `Assets/Art/Heroes/`.
- URP Volume: bloom/vignette по вкусу из VISUAL_STACK.md; на мобильных — профиль Quality
  с отключённым bloom (аналог нашего `settings.quality`).

## 7. Догоняющий C#-порт движка (BLOCK 2)

Порядок (зафиксирован в docs/EXPANSION.md, блок 2):
1. **Фич-фриз TS-движка** за 6 недель до Steam-релиза: новые правила после фриза — только
   сначала в C#, либо осознанно с пометкой «расходится».
2. Карта переноса (TS → C#) — **сделано 2026-09-24**:
   - `engine.ts` стек/окна → `GameEngine.Turn.cs` (`Stack`, `ResolveStackTop`, `PassStack`,
     `OpenInstantWindow`/`CloseInstantWindow`) + `GameEnums.cs` (StackPushed/StackResolved/InstantWindow);
   - `ai.ts` lookahead (топ-5 клонов + staticEval×0.6) → `AIController.ChooseBestAction` +
     `GameEngine.CloneForLookahead()`; skill≥1 включает Lookahead («Мифический»);
   - редкость `Uncommon` (45 карт волны архетипов) добавлена в C# `Rarity` и эталон `expected.json` (500 карт).
3. **Parity-контур**: `tools/csharp/verify.sh` собирает C#-движок dotnet'ом и сверяет логи
   матчей с TS-эталоном на фиксированных сидах; `--balance N SEED` — прогоны симуляций.
   Критерий: одинаковые сиды → одинаковые логи/винрейты в коридоре 45–55%.
4. Мета-игра (v2.3: профиль/магазин/кампания/пропуск) в Unity — **не портируется из TS**:
   пишется заново поверх `server/` (REST/WS) + локальный Save (ScriptableObject/JSON),
   телеметрия шлётся в `match_card_events` (docs/LAUNCH_PLAN.md §4).

## 8. Сборки

- **PC (Steam-цель)**: Build Settings → Windows x64; StreamingAssets копируются автоматически.
- **Android**: StreamingAssets лежат внутри APK — EchoBoot уже читает их через
  UnityWebRequest; target API 24+, scripting Backend IL2CPP для релиза.
- **WebGL**: не цель (web-версия = HTML-прототип на том же движке правил).
- Перед сборкой: Generate Card ScriptableObjects + прогон Run Headless Demo + `verify.sh`.

## 9. CI/CD

- В `.github/workflows/ci.yml` уже есть джобы TS (smoke/audit/tsc/servers). Unity-джоба —
  опционально: game-ci/unity-builder требует лицензию (активируйте Unity License в секретах)
  или оставляйте сборку ручной до soft launch; обязательный минимум в CI — `verify.sh --build`
  (dotnet 8, без Unity) после догона порта.

## 10. Чек-лист развертывания

- [ ] Unity Hub + 2022.3 LTS, .NET SDK 8
- [ ] Add project from disk → `unity/EchoCitadel`, первый импорт (URP/TMP из manifest.json)
- [ ] NuGet → Manage NuGet Packages → **System.Text.Json 8.x** (иначе CardDatabase не скомпилируется)
- [ ] TMP Essentials импортирован, ошибок компиляции в Console нет
- [ ] Шрифты TTF/OTF → TMP Font Asset (кириллица 0020-04FF)
- [ ] EchoCitadel → Generate Card ScriptableObjects (500 SO)
- [ ] EchoCitadel → Create Bootstrap Scene; Play: лог «База готова: карт = 500»
- [ ] Run Headless Demo: матч сыгран, ходов 8–20
- [x] `tools/csharp/verify.sh`: RNG + база 500 карт + колоды + коэффициенты (headless .NET 8)
- [ ] Build Settings → целевая платформа, тестовая сборка стартует
