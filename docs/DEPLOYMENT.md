# Эхо-Цитадель — план развертывания (2026-09-21)

Архитектура под нашим полным контролем: веб-прототип (Node 20), платформо-независимый
движок `src/engine` (TS, синхронный), Unity-клиент `unity/EchoCitadel`, ассеты художника
в `art_raw` → `_processed` → `Assets/Resources`.

## 1. Веб-бэкенд (контейнер)
- `Dockerfile`: multi-stage (build: npm ci + build:proto → runtime: node:20-alpine,
  `node tools/serve.js --port 5173`, слушает 0.0.0.0 — требование PaaS/Cloud Run).
  В образ включены `art_raw/` и `unity/` — маршруты `/art/*` и `/heroes/*` работают в проде.
- `docker-compose.yml`: web + `postgres:16-alpine` (схема применяется из
  `server/schema.sql` через initdb.d) + `redis:7-alpine`. Переменные: `DATABASE_URL`, `REDIS_URL`.
- **Compose v2 (LAUNCH: Docker Compose-прод,2026-09-24):** сервисы `web` (runtime-proto),
  `meta` :8081 (runtime-meta: auth scrypt + telemetry + **rate-limit** auth10/мин, POST60/мин —
  env `RATE_LIMIT=0` отключает; **snapshot.json** в volume `metadata`: дамп60с + при смене профиля +
  на SIGTERM — in-memory состояние переживает рестарт; **PG-адаптер**: env `DATABASE_URL`
  → аккаунты/сессии/профили/ники/телеметрия в PostgreSQL, без него — файловый режим;
  `depends_on: db (service_healthy)`), `match` :8080 (runtime-match, ws-bundle),
  `db`, `cache` и **`backup`**: цикл24ч → `server/backup.sh` (pg_dump + snapshot.json + accounts.json
  → volume `backups`, ротация7 дней). Запуск: `docker compose up -d --build`;
  ручной бэкап: `docker compose exec backup sh /backup.sh`;
  восстановление БД: `gunzip -c backups/db_<stamp>.sql.gz | docker compose exec -T db psql -U echo -d echo_citadel`.
- Хостинг старта: **Render / Railway / Fly.io** (docker buildpack, health-check `/`),
  масштабирование: **Cloud Run / AWS ECS** (stateless-веб; состояние матчей — ниже).

## 2. База данных
- **PostgreSQL** (Supabase / Neon на старте): `server/schema.sql` — profiles, factions_dict,
  cards_dict (зеркало Cards.json с set_code BASE/ECH1), collection (playset 4 + foil,
  CHECK-ограничения!), currency (осколки), booster_packs (аудит дропа jsonb), decks,
  match_history, lore_entries. Индексы под профиль/ленту. Схема **идемпотентна**
  (IF NOT EXISTS / CREATE OR REPLACE): порядок «CREATE → ALTER/ссылки/вью» — свежий
  `initdb` через compose/initdb.d применяется без ошибок (фикс2026-09-24: раньше
  `ALTER TABLE decks` шёл раньше `CREATE TABLE decks`).
- **PG-адаптер meta-server (2026-09-24):** env `DATABASE_URL` → in-memory Map
  персистируются в `accounts` / `sessions` / `game_profiles` (jsonb) / `nick_registry` /
  `telemetry_log`; включение без правки маршрутов, ретрай подключения30с, merge файл↔PG
  по `updatedAt`, автозаливка из snapshot.json/accounts.json при пустых таблицах,
  `/health` отдаёт `db: postgres|file`. Без `DATABASE_URL` — прежний файловый режим.
  DDL-подмножество сервер применяет сам (`CREATE TABLE IF NOT EXISTS` в initPg) —
  работает и на пустом Neon без ручного `psql -f`.
- **Redis**: снапшоты активных матчей и pub/sub матч-сервера; очередь бустер-дропов.

## 3. Матч-сервер (PvP, WebSocket)
- `server/match_server.ts` (скелет v1, `npm run server:match`, PORT=8080, `/health`):
  комната = инстанс `GameEngine`; сервер — единственный источник истины: валидация
  намерений через `engine.canPlay()`, рассылка `GameEvent` обоим сиденьям (hooks.onEvent).
  Протокол: join/act(mulligan|play|endMain|runTurn|endTurn)/event/ack/err.
- Рост: stateless-фронт + sticky sessions на LB; снапшот комнаты в Redis (TTL партии),
  роуминг сокетов через Redis pub/sub; далее — отдельный микросервис (ECS task per pool).

## 4. CI/CD
- `.github/workflows/ci.yml`: npm ci → typecheck → build:proto → smoke → audit:abilities
  → баланс-коридор (2 000 матчей, падение при «❌») → артефакт docs/balance/.
  Отдельная job `docker`: контроль собираемости образа на каждый пуш.
- `.github/workflows/unity-build.yml`: **GameCI** (game-ci/unity-builder@v3), кэш Library,
  матрица StandaloneWindows64/Android на каждый коммит в main, затрагивающий
  `unity/**` или `src/engine/**`. Секреты: UNITY_LICENSE, UNITY_EMAIL, UNITY_PASSWORD.
- Дистрибуция закрытого теста: Android — r0adkll/upload-google-play@v1, трек `internal`,
  секрет SERVICE_ACCOUNT_JSON; iOS — TestFlight через fastlane pilot в отдельной job
  (macos-latest) после сборки Xcode-проекта из Unity-экспорта.

## 5. Пайплайн ассетов (art_raw → _processed)
- `npm run art:process` (`tools/process_art.py`, Pillow): карты cover-crop 3:4 → 512×720
  в `_processed/cards/<Faction>/` + `Assets/Resources/Cards/<Faction>/`; герои 512×512 →
  `_processed/heroes/` + `Assets/Resources/Heroes/`; фоны/UI ≤2048 → `_processed/ui/`.
  Идемпотентен (sha256 в `_processed/.state.json`), пишет `_processed/manifest.csv`.
  В CI не запускается (ассеты — артифакт релиза), в релиз-пайпе Unity — обязателен перед билдом.
- Drop-зоны художника неизменны: `art_raw/<id>.png`, `art_raw/heroes/<Faction>/`;
  прототип подхватывает сразу (serve.js), пайплайн нормализует для Unity и стора.

## 6. Порядок выхода в прод (чек-лист)
1. Neon/Supabase: применить schema.sql, сид factions_dict/cards_dict из Cards.json (скрипт-зеркало).
2. Render/Fly: деплой образа веб+матч-сервера (два сервиса: web :5173, match :8080).
3. Redis: включить снапшоты матчей (feature-flag REDIS_URL).
4. GameCI: добавить секреты, первый зелёный прогон unity-build → internal testing.
5. Мониторинг: /health матч-сервера + метрики комнат; алерт на средний лен партии >16 ходов.

## 7. Разделение серверов по обзору архитектуры (2026-09-21)
- **Meta-Server REST** `server/meta_server.ts` (PORT=8081, `npm run server:meta`): профили,
  коллекция, покупка бустеров, крафт/даст — вся экономика считается на сервере
  (server-authoritative), клиент лишь отображает. Проверено живьём: POST /profiles →
  /boosters/open (−300, дроп только ECH1) → /craft (−100) → /dust базы = 409.
- **Game-Server WS** `server/match_server.ts` (PORT=8080): только матчи, валидация canPlay.
- Хранилище: in-memory → PostgreSQL (schema.sql) без смены маршрутов; Redis — roadmap
  (сессии/матчмейкинг/снапшоты матчей).
- CI: джоба `servers` собирает оба бандла esbuild на каждый пуш.

## 8. Телеметрия и дашборды (v2.2)

- Клиент: `meta.telem` (localStorage, кап 40 матчей): played:[cardId,turn], stuck,
  duration_seconds. Отправка на сервер — roadmap: `POST /telemetry` meta-server →
  `match_card_events` (schema.sql).
- PG-вью `v_card_winrate` — источник панелей Metabase (вопрос по вью) и Grafana
  (PG data source): winrate карт, `match_history.duration_seconds`, retention D1/D7/D30
  по `profiles.created_at`.
- Оффлайн-контур (до серверов): `npm run balance` → `npm run autonerf` →
  docs/balance/nerf_proposals.md (предложения, apply вручную) → `npm run dashboard` →
  docs/balance/dashboard.md. Порядок применения — в LAUNCH_PLAN.md §1.
