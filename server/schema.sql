-- =====================================================================
--  ЭХО-Цитадель — PostgreSQL: профили, коллекции, бустеры, лор, матчи
--  + адаптер meta-server (DATABASE_URL): accounts / sessions /
--    game_profiles / nick_registry / telemetry_log  (server/meta_server.ts)
--  Порядок: только CREATE → потом ALTER/ссылки/вью (fresh-initdb совместим;
--  прежняя версия звала ALTER TABLE decks раньше CREATE — initdb падал).
--  Идемпотентно (IF NOT EXISTS) — можно применять повторно на живой БД.
--  Применяется автоматически docker-compose (initdb.d) или:
--    psql $DATABASE_URL -f server/schema.sql
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---- профили (классическая схема) ----------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text UNIQUE NOT NULL,
  email         text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  password_hash text
);

-- ---- словари --------------------------------------------------------
CREATE TABLE IF NOT EXISTS factions_dict (
  id         text PRIMARY KEY,          -- Aurites | Necrus | Terramorph | Pyromancer | Ethereal
  name_ru    text NOT NULL,
  passive_ru text NOT NULL
);

CREATE TABLE IF NOT EXISTS cards_dict (  -- зеркало Cards.json для серверных проверок
  id       text PRIMARY KEY,             -- aur_01
  faction  text NOT NULL REFERENCES factions_dict(id),
  type     text NOT NULL,
  rarity   text NOT NULL,
  cost     int  NOT NULL,
  set_code text NOT NULL DEFAULT 'BASE'  -- BASE | ECH1 | ...
);

-- ---- владение и валюта ----------------------------------------------
CREATE TABLE IF NOT EXISTS collection (  -- playset 4 + фойлы
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card_id    text NOT NULL REFERENCES cards_dict(id),
  copies     smallint NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 4),
  foil       smallint NOT NULL DEFAULT 0 CHECK (foil  BETWEEN 0 AND 4),
  PRIMARY KEY (profile_id, card_id)
);

CREATE TABLE IF NOT EXISTS currency (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  shards     bigint NOT NULL DEFAULT 1200 CHECK (shards >= 0)
);

CREATE TABLE IF NOT EXISTS booster_packs (  -- журнал покупок/открытий (аудит дропа)
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  set_code   text NOT NULL,
  price      int  NOT NULL,
  drops      jsonb NOT NULL,             -- [{card, rarity, foil, converted}]
  opened_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- колоды -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS decks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name       text NOT NULL,
  faction    text NOT NULL REFERENCES factions_dict(id),
  is_base    boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT false,
  cards      jsonb NOT NULL,             -- [{id, copies}] — валидатор: минимум 60 карт, без потолка, ≤4 копии
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deck_cards (  -- нормализованные карты колод (вместо jsonb)
  deck_id  uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id  text NOT NULL REFERENCES cards_dict(id),
  count    smallint NOT NULL DEFAULT 1 CHECK (count BETWEEN 1 AND 4),
  PRIMARY KEY (deck_id, card_id)
);

-- ---- матчи -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  seat_a          uuid REFERENCES profiles(id),
  seat_b          uuid REFERENCES profiles(id),
  winner_seat     smallint,
  turns           smallint,
  duration_seconds integer,
  log_ref         text                   -- ключ снапшота лога в object storage / Redis
);

CREATE TABLE IF NOT EXISTS match_card_events (  -- телеметрия: розыгрыши и застревания карт
  match_id uuid NOT NULL REFERENCES match_history(id) ON DELETE CASCADE,
  card_id  text NOT NULL REFERENCES cards_dict(id),
  turn     smallint NOT NULL,
  kind     text NOT NULL,                -- played | stuck
  ts       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lore_entries (  -- лор Цитадели: карточки истории, флавор
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_code  text NOT NULL,
  card_id   text REFERENCES cards_dict(id),
  title_ru  text NOT NULL,
  body_ru   text NOT NULL,
  published boolean NOT NULL DEFAULT false
);

-- ---- meta-server адаптер (DATABASE_URL → server/meta_server.ts) --------
-- Горячий путь — in-memory Map; эти таблицы — персистентность:
-- аккаунты scrypt, сессии-токены, игровые профили (jsonb-зеркало клиента),
-- реестр никнеймов, кольцо телеметрии (поддержка LIMIT 500/5000).
CREATE TABLE IF NOT EXISTS accounts (
  login   text PRIMARY KEY,             -- lower-case,3–20 символов
  salt    text NOT NULL,
  hash    text NOT NULL,                -- scrypt(pw, salt) hex
  pid     text NOT NULL UNIQUE,         -- привязанный игровой прогресс
  created timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (   -- токен30 дней; рестарт не разлогинивает
  token text PRIMARY KEY,
  login text NOT NULL,
  exp   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS game_profiles (
  pid        text PRIMARY KEY,
  nick       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL,            -- полный GameProfile (структура клиента)
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nick_registry (  -- уникальность нижнего регистра ника
  low_nick text PRIMARY KEY,
  pid      text NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_log (  -- append-only; кольцо500 на GET
  id  bigserial PRIMARY KEY,
  ts  timestamptz NOT NULL DEFAULT now(),
  pid text,
  e   jsonb
);

-- ---- дашборд-вью (после match_history + match_card_events) ------------
CREATE OR REPLACE VIEW v_card_winrate AS
SELECT e.card_id,
       count(*) FILTER (WHERE e.kind = 'played')                              AS times_played,
       count(*) FILTER (WHERE e.kind = 'played' AND m.winner_seat = 0)        AS wins_when_played,
       round(100.0 * count(*) FILTER (WHERE e.kind = 'played' AND m.winner_seat = 0)
             / nullif(count(*) FILTER (WHERE e.kind = 'played'), 0), 1)       AS winrate_when_played,
       round(avg(m.turns), 1)                                                 AS avg_turns
FROM match_card_events e JOIN match_history m ON m.id = e.match_id
GROUP BY e.card_id;

-- ---- индексы ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_collection_card     ON collection(card_id);
CREATE INDEX IF NOT EXISTS idx_packs_profile       ON booster_packs(profile_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_decks_profile       ON decks(profile_id);
CREATE INDEX IF NOT EXISTS idx_matches_profile     ON match_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mce_card            ON match_card_events(card_id, kind);
CREATE INDEX IF NOT EXISTS idx_sessions_exp        ON sessions(exp);
CREATE INDEX IF NOT EXISTS idx_telemetry_pid       ON telemetry_log(pid);
CREATE INDEX IF NOT EXISTS idx_game_profiles_nick  ON game_profiles(nick);
