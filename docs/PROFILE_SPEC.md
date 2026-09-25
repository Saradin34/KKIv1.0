# Спека «2. 👤 Профиль» — статус реализации (v2.4.1)

Дата: 2026-09-21. Треки: **A — HTML-прототип** (смоук 🎉) и **B — Unity C#** (3 скрипта
по промптам спеки + общий HTTP-клиент; компиляция — на машине с Unity).

## Пункт за пунктом

| Спека | Прототип (трек A) | Unity (трек B) |
|---|---|---|
| 2.1 Аватар: галерея (5 фракционных + премиум), сохранение | было в v2.3: `.avaBtn` × 5 + PREMIUM_AVATARS (🔒 до условия); теперь каждый выбор синхронизируется на сервер (`syncProfile()` → POST /api/profile) | `ProfileScreen.RefreshHeader()` (avatarImage из Resources/Heroes), `SaveProfile()` |
| 2.1 Никнейм: клик → редактирование, 3–16 симв., без мата, уникальность | **новое**: сохранение по `change`; `invalidNick()` (длина 3–16, допустимые символы, мат-фильтр RU/EN); уникальность — `GET /api/profile/nick` (занят → откат ника + тост); maxlength=16 | `OnNickEdited()` + `CheckNickFree()` — та же валидация (Regex), откат при 409/free:false |
| 2.1 Уровень/XP: прогресс-бар + анимация Level Up с частицами | было: бар XP (500/уровень); **новое**: `levelUpFx()` — оверлей `#levelUpFx` (z400): «Уровень N!» luPop + 26 частиц luFly (CSS --dx/--dy), звук `Audio_.levelUp()` (триада+блеск); срабатывает из `metaRewards()` при lvlAfter>lvlBefore | `PlayLevelUp()`: levelUpFx GameObject + ParticleSystem.Play + клип, авто-скрытие 2.6с |
| 2.1 Ранг + прогресс до следующего | было: `rankOf(mmr)` (Ученик→Легенда, дивизионы III/II/I) + второй бар | `RankOf()` — та же лестница, rankBar.fillAmount |
| 2.2 Общая: матчи, винрейт, любимая фракция, средняя длина (ходы/сек), «чаще застревают» | было в v2.3: всё перечисленное, включая top-3 «застревающих» карт из телеметрии (`stuck`) | вкладки-панели (tabPanels), данные из ProfileDto/истории |
| 2.2 Фракции: круговая диаграмма + клик → винрейт против каждой | было: donut conic-gradient + строки; **новое**: строки кликабельны (`.mfRow[data-mf]`) → панель `.facDetail` «vs каждая фракция W–L %» из meta.history (fac/efac/win) | **по промпту**: 5 сегментов `Image.fillAmount` + поворот на накопленный угол; клик по строке → `ShowMatchups()` (matchupRowPrefab) |
| 2.2 История: 20 матчей (дата, противник, фракция, результат, длительность) + «Реплей» | было: 20 строк + кнопка ▶ Реплей (локальные логи 3 последних) | `RefreshHistory()`: префабы **MatchHistoryItem** (Date/Foe/EFac/Result/Duration/ReplayButton) |
| 2.2 Друзья: онлайн/офлайн, «Пригласить в лобби», «Удалить», «Добавить по ID» | было: всё (демо-статус онлайн, приглашение = товарищеский матч без рейтинга) | `RefreshFriends()` (friendRowPrefab: Dot/Invite/Remove), добавление по нику (лимит 20) |
| 2.3 Задания дня: 3 шт., ротация 24ч, типы спеки, ◈ + XP пропуска, «Забрать» только при выполнении | было в v2.3: win_fac(2)/runes(6)/pack(1) — ровно типы спеки; ротация по questDate; клейм ◈+150 BP; **новое**: клейм дублируется `POST /api/quests/claim` (сервер валидирует prog≥goal, повтор → 409) | `QuestSystem`: GET /api/quests, ротация Today()/ISOWeek, `Claim()` → POST /api/quests/claim, кнопка interactable только при prog≥goal |
| 2.4 Задания недели: 3 шт., ротация неделя, ◈ + BP | было: w_win3(3)/w_runes(15)/w_dmg(300), ◈300/250/350 +250 BP | те же id/цели в QuestSystem (weekly) |
| 2.5 Достижения: список с прогрессом, тост с иконкой и звуком, награда | было: 3 достижения без тоста; **новое**: `ACH_DEFS` (4 шт. — добавлено «Все боссы кампании» ◈500+💎50), прогресс p/g в списке, `checkAchs()` в конце матча/открытии бустера, `achToast()` — иконка ico_ach_N + `Audio_.achievement()` + награда сразу (◈/💎) | `AchievementSystem`: **achievements.json** (StreamingAssets), проверка на событиях GameEvents, Toast-префаб (Icon+Text) + звук, POST /api/profile {ach} |
| 2.6 Рамки аватара: все доступные, заблокированные с 🔒 и условием, клик → выбор | было: FRAME_DEFS (bronze/silver·10 побед/gold·10 бустеров/…) — 🔒 + условие в title, клик по доступной = выбор | поле frame в ProfileDto/SaveProfile; UI рамок — на стороне художника (BLOCK 2) |
| Событийная шина | questBump() в движке UI (было) | **новое**: `GameEvents` (OnMatchWin/OnCardPlayed/OnDamageDealt/OnBoosterOpened/OnBossDefeated) — движок боя публикует после порта |
| Серверное сохранение | **новое**: `scheduleSync()` (троттлинг 1.5с) → POST /api/profile при каждом metaSave(); pid = `ec-…` в localStorage; meta_server: GET/POST /api/profile, /api/profile/nick, /api/quests, /api/quests/claim, CORS | `MetaApi` (GET/POST, таймаут 2с, pid в PlayerPrefs «ec.pid»), офлайн-кэш PlayerPrefs |

## Отклонения и решения

1. **Local-first, сервер — зеркало**: localStorage/PlayerPrefs остаются источником истины
   (офлайн-игра обязательна); сервер хранит копию профиля, реестр никнеймов и клеймы квестов.
   Server-authoritative экономика — только в мета-серверных операциях (бустеры/крафт, уже было).
2. **Недельные цели** (3 победы/15 рун/300 урона) — из утверждённого v2.3 баланса наград,
   примеры спеки (10 побед/50 рун) не взяты; награды ◈300/250/350 + 250 BP сохранены.
3. **Ранги**: лестница Ученик/Адепт/Магистр/Архимаг/Легенда (v2.3), а не «Адепт/Мастер/Мифический»
   из спеки — согласовано с решением по сложностям в разделе 1 (docs/MENU_SPEC.md).
4. **Реплеи**: локальные логи 3 последних матчей (кнопка ▶ при наличии), серверное хранилище
   реплеев — roadmap (match_id из POST /api/match/start уже пишется в телеметрию).
5. Награды достижений в Unity логируются (кошелёк MetaWallet — BLOCK 2); в прототипе начисляются сразу.

## Проверка

- Прототип: `npx tsc --noEmit` чисто; смоук 🎉 + 4 новых проверки «Профиль v2.4» (4 достижения
  с прогрессом, валидация ника «ab»/мат/«Воин_42», клик фракции → facDetail, levelUpFx/luFly/
  checkAchs/syncProfile//api/profile/nick//api/quests/claim в бандле).
- meta_server (живой тест): POST /api/profile → merge-дефолты; GET → полный профиль;
  nick чужой → free:false, свой → free:true, POST с занятым → 409; /api/quests → daily/weekly;
  claim: prog<goal → 422, prog≥goal → 200, повтор → 409; OPTIONS → 204 (CORS).
- Unity: `Scripts/UI/MetaApi.cs`, `ProfileScreen.cs`, `QuestSystem.cs`, `AchievementSystem.cs`,
  `StreamingAssets/achievements.json`. Не компилировалось в песочнице; на машине: повесить
  ProfileScreen/QuestSystem/AchievementSystem на UIRoot в Main.unity, назначить ссылки
  (конвенции префабов — в шапках файлов), baseUrl = адрес meta_server.
