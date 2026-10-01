/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — Meta-Server (REST), скелет v1
   ---------------------------------------------------------------------
   Отдельный от матч-сервера CRUD: профили, коллекция, бустеры, крафт.
   Экономика считается ЗДЕСЬ (server-authoritative): клиент не решает,
   сколько осколков заработать/потратить.
   Хранилище: in-memory Map; при DATABASE_URL — адаптер PostgreSQL
   (schema: server/schema.sql) подключается без изменения маршрутов.
   Redis (ROADMAP): кэш сессий и очередь матчмейкинга матч-сервера.
   Маршруты:
     GET  /health
     POST /profiles            {handle}            → {id, profile}
     GET  /profiles/:id                              → профиль+коллекция+◈
     POST /boosters/open       {profileId}          → {drops, shards}
     POST /craft               {profileId, cardId}  → {shards, copies}
     POST /dust                {profileId, cardId}  → {shards, copies}
   Запуск: npm run server:meta  (PORT=8081)
   ===================================================================== */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { attachMatchRelay } from './match_relay';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { gzipSync } from 'zlib';
import { issueTokens, verify, bearer, RefreshClaims } from './auth_jwt';
import { handleSocial, SocialCtx, statusOf, presenceInfo, touch, wsUrlFor } from './social';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { mkdir, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { Pool } from 'pg';
import { buildDatabase, CardsFile } from '../src/engine/db';
import { Rarity } from '../src/engine/types';
import cardsRaw from '../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';

const { db } = buildDatabase(cardsRaw as unknown as CardsFile);

const PACK_PRICE = 300;
const PLAYSET = 4;
/* Тарифы спеки «3. Магазин» п.4.4 (решение пользователя: пыль = золото ◈): 5/20/100/400 и 1/5/20/100. */
const CRAFT_COST: Record<string, number> = { Common: 5, Rare: 20, Epic: 100, Legendary: 400 };
const DUST_GAIN: Record<string, number> = { Common: 1, Rare: 5, Epic: 20, Legendary: 100 };
const FACTIONS5 = ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal'];
const EXPANSION = new Set(
  ((cardsRaw as unknown as { meta?: { expansionIds?: string[] } }).meta?.expansionIds) ?? []);

interface Profile { id: string; handle: string; shards: number; owned: Map<string, number>; created: number }
const profiles = new Map<string, Profile>();
let seq = 1;

/* ---- Игровой профиль (спека «2. Профиль»): клиент — источник истины (localStorage),
   сервер — зеркало для уникальности ников, квестов и будущего кросс-девайса.
   Хранилище in-memory; PostgreSQL-адаптер — server/schema.sql без смены маршрутов. ---- */
interface QRow { id: string; prog: number; goal: number; claimed: boolean; fac?: string }
interface GameProfile {
  pid: string; nick: string; level: number; xp: number; mmr: number; bestMmr: number;
  wins: number; losses: number; avatarFac: string; frame: string;
  ach: Record<string, boolean>;
  quests: { daily: QRow[]; weekly: QRow[] };
  questDate?: string; wquestWeek?: string;
  history: Array<{ ts: number; win: boolean; fac: string; efac?: string; foe?: string; turns: number; practice?: boolean }>;
  shards: number; gems: number; freeOpens: number; bundles: string[];
  cosmetics: unknown;                 // зеркало клиентской косметики (форма клиента)
  purchases: string[];                // покупки через /api/shop/buy (server-side учёт)
  collection: Record<string, number>; // копии карт (для /api/craft, /api/dust, /api/collection/add)
  bpXp: number; bpPremium: boolean;   // спека «5. Боевой пропуск» (v2.5.0)
  bpClaimed: number[]; bpClaimedP: number[];
  foilTokens: number; premOpens: number; avatarsOwned: string[];
  banned?: boolean;   // v3.13: бан администратором
  tutStage: number; tutDone: boolean; tutReward: string; tutClaims: number[];   // спека «6. Обучение» (v2.5.1)
  updatedAt: number;
}
const gameProfiles = new Map<string, GameProfile>();
const kickedLogins = new Set<string>();   // v3.13: кикнутые админом — доступ до повторного логина
/* v3.13: минимальный профиль для правок админа до первой синхронизации клиента */
function blankGameProfile(pid: string, nick: string): GameProfile {
  return { pid, nick, level: 1, xp: 0, mmr: 1000, bestMmr: 1000, wins: 0, losses: 0,
    avatarFac: 'Aurites', frame: 'bronze', ach: {}, quests: { daily: [], weekly: [] },
    questDate: '', wquestWeek: '', history: [], shards: 1200, gems: 100, freeOpens: 0,
    bundles: [], cosmetics: null, purchases: [], collection: {}, bpXp: 0, bpPremium: false,
    bpClaimed: [], bpClaimedP: [], foilTokens: 0, premOpens: 0, avatarsOwned: [],
    tutStage: 0, tutDone: false, tutReward: '', tutClaims: [], updatedAt: Date.now() };
}
const nicks = new Map<string, string>();   // lower(nick) → pid: занятость никнейма

/* ---- Аккаунты (LAUNCH_PLAN: регистрация/логин через meta-server).
   Пароль — scrypt+salt (хэш в server/data/accounts.json); сессия — токен30 дней.
   PostgreSQL-адаптер позже: schema добавляется без смены маршрутов. ---- */
interface Account { login: string; salt: string; hash: string; pid: string; created: number }
const AUTH_FILE = join(process.cwd(), 'server', 'data', 'accounts.json');
const accounts = new Map<string, Account>();          // lower(login) → аккаунт
const sessions = new Map<string, { login: string; exp: number }>(); // jti refresh-токена → сессия (JWT, ротация)
function hashPw(pw: string, salt: string): string { return scryptSync(pw, salt, 32).toString('hex'); }
function saveAccounts(): void {
  try { mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true }); writeFileSync(AUTH_FILE, JSON.stringify([...accounts.values()], null, 2)); } catch { /* read-only fs */ }
}
try { if (existsSync(AUTH_FILE)) for (const a of JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Account[]) accounts.set(a.login.toLowerCase(), a); } catch { /* пусто */ }

/* ---- Телеметрия боёв (LAUNCH_PLAN: POST /telemetry вместо только localStorage) ---- */
const telemRing: Array<{ ts: number; pid?: string; e?: unknown }> = [];

/* ---- Snapshot: персист in-memory состояния в server/data/snapshot.json.
   v3.16: КОАЛЕСЦЕНЦИЯ + асинхронная атомарная запись (tmp+rename).
   Раньше: полный синхронный дамп ВСЕХ профилей при КАЖДОМ синке профиля —
   на 10k пользователей это блокировало event loop на сотни мс и грело диск.
   Теперь: изменения помечают dirty; дамп ≤1 раз в 5с (фоновый интервал — страховка),
   запись — write+rename в отдельном потоке (libuv), файл всегда целый. ---- */
const SNAP_FILE = join(process.cwd(), 'server', 'data', 'snapshot.json');
const SNAP_DIR = join(process.cwd(), 'server', 'data');
let snapDirty = false;
let snapWriting = false;
let snapTimer: NodeJS.Timeout | null = null;
async function writeSnapshot(): Promise<void> {
  if (snapWriting) return;
  snapWriting = true;
  try {
    if (!snapDirty) return;
    snapDirty = false;
    /* v3.16: сериализация КУСКАМИ с уступкой event loop'у (setImmediate каждые ~500
       профилей). На 10k профилей это ~20 МБ: один синхронный JSON.stringify на
       event loop'е давал лаг-спайк на сотни мс — теперь каждый кусок <5 мс. */
    const profiles = [...gameProfiles.values()];
    let data = '{"v":1,"ts":' + Date.now() + ',"profiles":[';
    for (let i = 0; i < profiles.length; i++) {
      if (i) data += ',';
      data += JSON.stringify(profiles[i]);
      if (i % 500 === 499) await new Promise<void>(r => setImmediate(r));
    }
    data += '],"nicks":' + JSON.stringify([...nicks.entries()]) + ',"telem":' + JSON.stringify(telemRing) + '}';
    await mkdir(SNAP_DIR, { recursive: true }).catch(() => { /* уже есть */ });
    const tmp = `${SNAP_FILE}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, SNAP_FILE);   // атомарная замена — бэкап-сервис не застанет «половину» файла
  } catch { /* read-only fs — не критично, повторим при следующем dirty */ }
  finally {
    snapWriting = false;
    if (snapDirty && !snapTimer) {
      snapTimer = setTimeout(() => { snapTimer = null; void writeSnapshot(); }, 5000);
      snapTimer.unref?.();
    }
  }
}
function markDirty(): void {
  snapDirty = true;
  if (!snapTimer) {
    snapTimer = setTimeout(() => { snapTimer = null; void writeSnapshot(); }, 5000);
    snapTimer.unref?.();
  }
}
/** Синхронный финальный дамп (shutdown): дождаемся полной записи. */
async function flushSnapshot(): Promise<void> {
  snapDirty = true;
  await writeSnapshot();
}
function loadSnapshot(): void {
  try {
    if (!existsSync(SNAP_FILE)) return;
    const s = JSON.parse(readFileSync(SNAP_FILE, 'utf8')) as {
      profiles?: GameProfile[]; nicks?: Array<[string, string]>; telem?: typeof telemRing;
    };
    for (const p of s.profiles ?? []) gameProfiles.set(p.pid, p);
    for (const [k, v] of s.nicks ?? []) nicks.set(k, v);
    for (const e of s.telem ?? []) telemRing.push(e);
    while (telemRing.length > 500) telemRing.shift();
  } catch { /* повреждённый снапшот — стартуем с нуля */ }
}
loadSnapshot();

/* ---- PostgreSQL-адаптер (DATABASE_URL) — маршруты НЕ меняются.
   Включение: env DATABASE_URL=postgres://… — тогда PG становится персистентностью
   (accounts / sessions / game_profiles / nick_registry / telemetry_log;
   DDL в initPg — идемпотентное подмножество server/schema.sql, полная схема
   применяется compose/initdb.d или вручную). Без DATABASE_URL — прежний
   файловый режим (snapshot.json + accounts.json).
   Инициализация: ретрай30с (compose: db стартует параллельно), merge файл↔PG
   (побеждает более свежий updatedAt), автозаливка из файлов, если таблицы пусты.
   Далее flushPg вызывается в тех же точках, что и saveSnapshot. ---- */
const PG_URL = process.env.DATABASE_URL ?? '';
const pool = PG_URL ? new Pool({ connectionString: PG_URL, max: 10 }) : null;
let pgReady = false;
if (pool) pool.on('error', e => console.error('[meta-server] pg pool:', e.message));

/* v3.16: PG-флеш только изменённых записей (dirty-набор), а не всего массива.
   Раньше каждый синк профиля переписывал ВСЕ 10k строк в transaction — O(N) на запрос. */
const pgDirtyPids = new Set<string>();
const pgDirtyNicks = new Set<string>();
async function flushPg(reason = ''): Promise<void> {
  if (!pool || !pgReady) return;
  if (pgDirtyPids.size === 0 && pgDirtyNicks.size === 0 && reason !== 'shutdown' && reason !== 'migrate-files') return;
  const dirtyPids = [...pgDirtyPids];
  const dirtyNicks = [...pgDirtyNicks];
  // shutdown/миграция — полный прогон (гарантия консистентности)
  const full = reason === 'shutdown' || reason === 'migrate-files';
  const pids = full ? [...gameProfiles.keys()] : dirtyPids;
  const nickList = full ? [...nicks.entries()] : dirtyNicks.map(k => [k, nicks.get(k)!] as [string, string]).filter(([, v]) => v);
  const client = await pool.connect().catch(() => null);
  if (!client) return;
  try {
    await client.query('BEGIN');
    for (const pid of pids) {
      const gp = gameProfiles.get(pid);
      if (!gp) continue;
      await client.query(
        `INSERT INTO game_profiles (pid, nick, data, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (pid) DO UPDATE SET nick = EXCLUDED.nick, data = EXCLUDED.data, updated_at = now()`,
        [gp.pid, gp.nick, JSON.stringify(gp)]);
    }
    for (const [low, pid] of nickList) {
      await client.query(
        `INSERT INTO nick_registry (low_nick, pid) VALUES ($1, $2)
         ON CONFLICT (low_nick) DO UPDATE SET pid = EXCLUDED.pid`,
        [low, pid]);
    }
    await client.query('COMMIT');
    for (const p of dirtyPids) pgDirtyPids.delete(p);
    for (const n of dirtyNicks) pgDirtyNicks.delete(n);
  } catch (e) {
    // dirty НЕ снимаем — повторим при следующем flush (данные не теряются)
    try { await client.query('ROLLBACK'); } catch { /* уже откатили */ }
    console.error(`[meta-server] pg flush (${reason}):`, (e as Error).message);
  } finally {
    client.release();
  }
  // телеметрия: в PG держим хвост5000 (GET отдаёт памятные500)
  await pool.query(
    `DELETE FROM telemetry_log WHERE id <=
       (SELECT id FROM telemetry_log ORDER BY id DESC OFFSET 5000 LIMIT 1)`
  ).catch(() => { /* строк меньше — не беда */ });
}

async function initPg(): Promise<void> {
  if (!pool) return;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    try { await pool.query('SELECT 1'); ok = true; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!ok) {
    console.error(`[meta-server] FATAL: DATABASE_URL недоступен после30с: ${PG_URL.replace(/:[^:@/]+@/, ':***@')}`);
    process.exit(1);
  }
  // DDL-подмножество server/schema.sql (идемпотентно — работает и без initdb.d)
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    login text PRIMARY KEY, salt text NOT NULL, hash text NOT NULL,
    pid text NOT NULL UNIQUE, created timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY, login text NOT NULL, exp timestamptz NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS game_profiles (
    pid text PRIMARY KEY, nick text NOT NULL DEFAULT '',
    data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS nick_registry (
    low_nick text PRIMARY KEY, pid text NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS telemetry_log (
    id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
    pid text, e jsonb)`);

  // --- load: PG поверх файлов (побеждает более свежий updatedAt) ---
  const accRes = await pool.query('SELECT login, salt, hash, pid, created FROM accounts');
  for (const r of accRes.rows) accounts.set(r.login,
    { login: r.login, salt: r.salt, hash: r.hash, pid: r.pid, created: new Date(r.created).getTime() });
  const sRes = await pool.query('SELECT token, login, exp FROM sessions WHERE exp > now()');
  for (const r of sRes.rows) sessions.set(r.token, { login: r.login, exp: new Date(r.exp).getTime() });
  const gpRes = await pool.query('SELECT pid, data FROM game_profiles');
  for (const r of gpRes.rows) {
    const fromDb = r.data as GameProfile;
    const fromFile = gameProfiles.get(fromDb.pid);
    if (!fromFile || (fromDb.updatedAt ?? 0) >= (fromFile.updatedAt ?? 0)) gameProfiles.set(fromDb.pid, fromDb);
  }
  const nRes = await pool.query('SELECT low_nick, pid FROM nick_registry');
  for (const r of nRes.rows) if (!nicks.has(r.low_nick)) nicks.set(r.low_nick, r.pid);
  const tRes = await pool.query('SELECT ts, pid, e FROM telemetry_log ORDER BY id DESC LIMIT 500');
  if (tRes.rows.length) {
    for (const r of tRes.rows.reverse()) telemRing.push({ ts: new Date(r.ts).getTime(), pid: r.pid ?? undefined, e: r.e });
    while (telemRing.length > 500) telemRing.shift();
  }
  pgReady = true;
  console.log(`[meta-server] storage: postgres (${accRes.rowCount ?? 0} accounts, ${gpRes.rowCount ?? 0} profiles)`);

  // --- автозаливка: файлы содержат данные, а таблицы пусты (первая откатка на PG) ---
  try {
    if (!gpRes.rowCount && gameProfiles.size) await flushPg('migrate-files');
    if (!accRes.rowCount && accounts.size) {
      for (const a of accounts.values()) {
        await pool.query(
          `INSERT INTO accounts (login, salt, hash, pid, created)
           VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0))
           ON CONFLICT (login) DO UPDATE SET salt=EXCLUDED.salt, hash=EXCLUDED.hash, pid=EXCLUDED.pid`,
          [a.login, a.salt, a.hash, a.pid, a.created]);
      }
      console.log(`[meta-server] pg: мигрировано аккаунтов из accounts.json: ${accounts.size}`);
    }
  } catch (e) { console.error('[meta-server] pg migrate:', (e as Error).message); }
}

async function shutdown(code = 0): Promise<never> {
  await flushSnapshot();   // v3.16: гарантированный полный дамп перед остановкой
  if (pool) {
    try { await flushPg('shutdown'); } catch { /* залогировано выше */ }
    try { await pool.end(); } catch { /* нет соединений */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
/* v3.16: фоновая страховка — дописываем dirty-состояние и PG не чаще раза в 10с */
setInterval(() => { if (snapDirty) void writeSnapshot(); void flushPg('interval'); }, 10_000).unref();

function baseOwned(): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of db.values()) if (!EXPANSION.has(c.id)) m.set(c.id, 1);
  return m;
}
function json(res: ServerResponse, code: number, body: unknown): void {
  // v3.16: gzip для крупных ответов (сетка 10k пользователей), security-заголовки,
  // CORS только для разрешённого origin (вычисляется в обработчике и висит на res).
  let s = JSON.stringify(body);
  const r2 = res as ServerResponse & { _req?: IncomingMessage; _corsOrigin?: string | null };
  const h: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (r2._corsOrigin) { h['access-control-allow-origin'] = r2._corsOrigin; h['vary'] = 'origin'; }
  if (r2._req && /gzip/.test(String(r2._req.headers['accept-encoding'] ?? '')) && s.length > 1024) {
    const z = gzipSync(Buffer.from(s, 'utf8'), { level: 6 });
    res.writeHead(code, { ...h, 'content-encoding': 'gzip', 'content-length': z.length, 'vary': 'accept-encoding, origin' });
    res.end(z);
    return;
  }
  res.writeHead(code, { ...h, 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/* v3.16: лимит тела запроса — 256 КБ. Игровые синки ~2-8 КБ; больше — мусор/атака (413). */
const MAX_BODY = 256 * 1024;
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  /* v3.16: тело читается ОДИН раз (вверху handler-а) и кэшируется в req._body —
     повторный вызов из роута возвращает кэш, иначе поток уже исчерпан и промис виснет. */
  const q = req as IncomingMessage & { _body?: Record<string, unknown>; _tooLarge?: boolean };
  if (q._body) return Promise.resolve(q._body);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, over = false, done = false;
    const finish = (parsed: Record<string, unknown>): void => {
      if (done) return; done = true;
      q._body = parsed; resolve(parsed);
    };
    req.on('data', c => {
      const b = c as Buffer; size += b.length;
      if (over) return;                       // уже превысили — больше не читаем
      if (size > MAX_BODY) {
        over = true; q._tooLarge = true;
        req.pause();                           // стоп-поток: дальше не буферизуем (413 выдаст топ-уровень)
        finish({});
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      if (over) { finish({}); return; }
      /* декодируем UTF-8 (String(buffer) рвал многобайтовые символы — русские ники
         хранились на сервере кракозябрами) */
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { parsed = {}; }
      finish(parsed);
    });
    req.on('error', () => finish(q._body ?? {}));
  });
}

/* v3.16: CORS — только «свой» хост (игра и API на разных портах одного хоста —
   штатная схема) или явный allowlist META_ALLOWED_ORIGINS (прод: https-домены). */
const EXTRA_ORIGINS = (process.env.META_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
function corsAllow(req: IncomingMessage): string | null {
  const o = String(req.headers.origin ?? '');
  if (!o) return null;                                  // не браузер (сервер-клиент) — CORS не нужен
  if (EXTRA_ORIGINS.includes(o)) return o;
  try {
    const ou = new URL(o);
    const rh = String(req.headers.host ?? '').split(':')[0];
    if (ou.hostname === rh) return o;
  } catch { /* кривой origin */ }
  return null;
}

/* ---- Rate-limit (LAUNCH план: прод) — token bucket по IP.
   auth-эндпоинты:10/мин (защита от перебора), прочие POST:60/мин.
   RATE_LIMIT=0 — отключить (локальная разработка/тесты). ---- */
/* v3.16: админ-ключ — «безопасно по умолчанию». env ADMIN_KEY в приоритете;
   иначе генерируется один раз и хранится в server/data/admin_key (chmod 600).
   Старый хардкод 'echo-admin' из исходника убран: без ключа админку не открыть. */
const ADMIN_KEY_FILE = join(process.cwd(), 'server', 'data', 'admin_key');
function loadAdminKey(): Buffer {
  const env = process.env.ADMIN_KEY;
  if (env) {
    if (env.length < 16) console.warn('[meta-server] ADMIN_KEY короче 16 символов — небезопасно');
    return Buffer.from(env, 'utf8');
  }
  try { if (existsSync(ADMIN_KEY_FILE)) return Buffer.from(readFileSync(ADMIN_KEY_FILE, 'utf8').trim(), 'utf8'); } catch { /* сгенерируем */ }
  const k = `ec-${randomBytes(18).toString('hex')}`;
  try { mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true }); writeFileSync(ADMIN_KEY_FILE, k, { mode: 0o600 }); } catch { /* read-only fs */ }
  console.log(`[meta-server] ADMIN_KEY не задан — сгенерирован новый админ-ключ: ${k}`);
  console.log(`[meta-server]   (хранится в server/data/admin_key, 0600; свой ключ — env ADMIN_KEY; в клиенте: админка → «Система → Ключ»)`);
  return Buffer.from(k, 'utf8');
}
const ADMIN_KEY = loadAdminKey();
function adminOk(key: string | undefined | null): boolean {
  const b = Buffer.from(String(key ?? ''), 'utf8');
  return b.length === ADMIN_KEY.length && timingSafeEqual(b, ADMIN_KEY);
}

const RL_ON = process.env.RATE_LIMIT !== '0';
const rlBuckets = new Map<string, { n: number; t: number }>();
function rateLimit(req: IncomingMessage, scope: string, max: number, windowMs: number): boolean {
  if (!RL_ON) return true;
  const ip = req.socket.remoteAddress ?? '?';
  const k = `${scope}|${ip}`;
  const now = Date.now();
  let b = rlBuckets.get(k);
  if (!b || now - b.t > windowMs) { b = { n: 0, t: now }; rlBuckets.set(k, b); }
  b.n += 1;
  if (rlBuckets.size > 4000) {
    for (const [kk, vv] of rlBuckets) if (now - vv.t > windowMs * 2) rlBuckets.delete(kk);
  }
  return b.n <= max;
}

function openBooster(p: Profile): { drops: Array<{ id: string; rarity: string; converted: number }>; shards: number } {
  const pool = [...db.values()].filter(c => EXPANSION.has(c.id));
  const comp: Rarity[] = [Rarity.Common, Rarity.Common, Rarity.Common, Rarity.Rare,
    Math.random() < 0.125 ? Rarity.Legendary : Rarity.Epic];
  const drops: Array<{ id: string; rarity: string; converted: number }> = [];
  for (const rar of comp) {
    const cand = pool.filter(c => c.rarity === rar);
    const c = cand[Math.floor(Math.random() * cand.length)] ?? pool[0];
    const have = p.owned.get(c.id) ?? 0;
    let converted = 0;
    if (have < PLAYSET) p.owned.set(c.id, have + 1);
    else { converted = DUST_GAIN[c.rarity] ?? 20; p.shards += converted; }
    drops.push({ id: c.id, rarity: c.rarity, converted });
  }
  return { drops, shards: p.shards };
}

/* Генерация бустера (спека п.4.1): 3 обычных + 1 редкая + 1 эпическая (12.5% легендарная).
   Фракционный бустер — пул только выбранной фракции. Тот же состав, что в прототипе и PackGenerator.cs. */
function rollPack(faction: string | null, premium = false): string[] {
  const all = [...db.values()].filter(c => EXPANSION.has(c.id));
  let pool = faction ? all.filter(c => c.faction === faction) : all;
  if (pool.length === 0) pool = all;
  const pick = (r: Rarity): string => {
    const cand = pool.filter(c => c.rarity === r);
    const from = cand.length ? cand : pool;
    return from[Math.floor(Math.random() * from.length)]?.id ?? '';
  };
  const ep = (): Rarity => (Math.random() < 0.125 ? Rarity.Legendary : Rarity.Epic);
  // premium (спека «5», решение пользователя): 2C+1R+2E/L — два слота эпик+ по 12.5% легендарки
  const comp: Rarity[] = premium
    ? [Rarity.Common, Rarity.Common, Rarity.Rare, ep(), ep()]
    : [Rarity.Common, Rarity.Common, Rarity.Common, Rarity.Rare, ep()];
  return comp.map(pick).filter(Boolean);
}

/* ---- Спека «5. 🎟 Боевой пропуск» (v2.5.0): 50 уровней, две ветки, премиум 💎500 ---- */
const BP_LEVELS = 50;
const BP_STEP = 400;                    // опыта пропуска на уровень
const BP_XP: Record<string, number> = { win: 120, loss: 60, daily: 150, weekly: 250 };
interface BpRw { ru: string; shards?: number; pack?: number; premPack?: number; gems?: number; back?: string; foil?: number; ava?: string }
function bpReward(lvl: number): { free: BpRw; prem: BpRw } {
  const free: BpRw = { ru: `◈${50 + lvl * 3}`, shards: 50 + lvl * 3 };
  if (lvl % 10 === 0) { free.ru = 'Бустер ECH1'; free.pack = 1; free.shards = 0; }
  if (lvl === 50) { free.ru = 'Бустер ECH1 ×2'; free.pack = 2; free.shards = 0; }
  const prem: BpRw = { ru: `◈${90 + lvl * 5} пыли`, shards: 90 + lvl * 5 };
  if (lvl === 5) { prem.ru = '🌟 Фойл-жетон'; prem.foil = 1; prem.shards = 0; }
  if (lvl === 10) { prem.ru = '💎 30 гемов'; prem.gems = 30; prem.shards = 0; }
  if (lvl === 15) { prem.ru = '🌟 Премиум-бустер (2 эпика+)'; prem.premPack = 1; prem.shards = 0; }
  if (lvl === 20) { prem.ru = 'Бустер ECH1'; prem.pack = 1; prem.shards = 0; }
  if (lvl === 25) { prem.ru = 'Рубашка «Бездна»'; prem.back = 'abyss'; prem.shards = 0; }
  if (lvl === 30) { prem.ru = '💎 50 гемов'; prem.gems = 50; prem.shards = 0; }
  if (lvl === 35) { prem.ru = 'Рубашка «Вердант»'; prem.back = 'verdant'; prem.shards = 0; }
  if (lvl === 40) { prem.ru = '☾ Аватар «Лунный Архонт»'; prem.ava = 'lunar'; prem.shards = 0; }
  if (lvl === 45) { prem.ru = '💎 120 + рамка «Кристалл»'; prem.gems = 120; prem.shards = 0; }
  if (lvl === 50) { prem.ru = 'Бустер ×2 + 💎 200'; prem.pack = 2; prem.gems = 200; prem.shards = 0; }
  return { free, prem };
}
/* ---- Спека «6. 🎓 Обучение» (v2.5.1): награды уроков и финальный подарок ---- */
const TUT_LESSON_REWARD: Record<number, number> = { 1: 100, 2: 100, 3: 150, 4: 100 };   // ◈ за урок (однократно)
function bpLevel(xp: number): number { return Math.min(BP_LEVELS, Math.floor(xp / BP_STEP) + 1); }
function bpApply(gp: GameProfile, rw: BpRw): void {
  if (rw.shards) gp.shards += rw.shards;
  if (rw.gems) gp.gems += rw.gems;
  if (rw.pack) gp.freeOpens += rw.pack;
  if (rw.premPack) gp.premOpens += rw.premPack;
  if (rw.foil) gp.foilTokens += rw.foil;
  if (rw.back && !gp.purchases.includes(`back_${rw.back}`)) gp.purchases.push(`back_${rw.back}`);
  if (rw.ava && !gp.avatarsOwned.includes(rw.ava)) gp.avatarsOwned.push(rw.ava);
}

/* Каталог магазина (GET /api/shop) — цены как в прототипе (v2.3 + перетарификация пыли v2.4.2). */
const SHOP_CATALOG = {
  /* v3.3: цены = ECONOMY в src/ui/prototype.ts (держать синхронно) */
  boosters: [
    { id: 'pack', name: 'Бустер «Эхо-Цитадель» (ECH1)', price: 300, currency: 'shards', cards: 5,
      composition: '3 обычных, 1 редкая, 1 эпическая (12.5% легендарная)' },
    { id: 'pack_faction', name: 'Бустер фракции', price: 350, currency: 'shards', cards: 5, requiresFaction: true },
    { id: 'bundle11', name: '11 бустеров по цене 10', price: 3000, currency: 'shards', cards: 55 },
  ],
  starters: FACTIONS5.map(f => ({
    id: `starter_${f}`, name: `Стартовый набор «${f}»`, price: 1200, currency: 'gems',
    grants: { boosters: 10, shards: 500, avatar: 'arch' },
  })),
  cosmetics: {
    backs: [
      { id: 'back_classic', name: 'Рубашка «Классика (золото)»', price: 0, currency: 'shards' },
      { id: 'back_runes', name: 'Рубашка «Руны Цитадели»', price: 600, currency: 'shards' },
      { id: 'back_ember', name: 'Рубашка «Угли Пиромантов»', price: 900, currency: 'shards' },
      { id: 'back_abyss', name: 'Рубашка «Бездна»', price: 0, currency: 'bp', note: 'награда боевого пропуска' },
      { id: 'back_verdant', name: 'Рубашка «Вердант»', price: 0, currency: 'bp', note: 'награда боевого пропуска' },
    ],
    tables: [
      { id: 'table_classic', name: 'Классический стол', price: 0, currency: 'shards' },
      { id: 'table_terra', name: 'Стол Терраморфов (мох и камень)', price: 1500, currency: 'shards' },
      { id: 'table_necro', name: 'Стол Некрусов (кость и тень)', price: 1000, currency: 'gems' },
    ],
    runes: [
      { id: 'rune_classic', name: 'Классические руны', price: 0, currency: 'shards' },
      { id: 'rune_flame', name: 'Руны «Пламя» (анимация)', price: 400, currency: 'gems' },
    ],
  },
  craft: CRAFT_COST,
  dust: DUST_GAIN,
};


/* ---- JWT-сессии: храним только jti refresh-токенов (отзыв/ротация) ---- */
function persistSession(jti: string, login: string, exp: number): void {
  if (pool && pgReady) {
    void pool.query(`INSERT INTO sessions (token, login, exp) VALUES ($1,$2, to_timestamp($3/1000.0))
       ON CONFLICT (token) DO UPDATE SET exp = EXCLUDED.exp`, [jti, login, exp])
      .catch(err => console.error('[meta-server] pg session:', (err as Error).message));
    void pool.query('DELETE FROM sessions WHERE exp < now()').catch(() => { /* фоновая чистка */ });
  }
}
function dropSession(jti: string): void {
  sessions.delete(jti);
  if (pool && pgReady) void pool.query('DELETE FROM sessions WHERE token = $1', [jti]).catch(() => { /* ok */ });
}
function revokeAll(login: string): void {
  for (const [k, v] of sessions) if (v.login === login) sessions.delete(k);
  if (pool && pgReady) void pool.query('DELETE FROM sessions WHERE login = $1', [login]).catch(() => { /* ok */ });
}
let lastSessionSweep = 0;
function startSession(login: string, pid: string): Record<string, unknown> {
  const t = issueTokens(login, pid);
  /* v3.16: чистка просроченных сессий не на каждый логин, а не чаще раза в минуту
     (на 10k одновременных логинов полный проход по сессиям = лишний O(N)) */
  const now = Date.now();
  if (now - lastSessionSweep > 60_000) {
    lastSessionSweep = now;
    for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  }
  sessions.set(t.refreshJti, { login, exp: t.refreshExp });
  persistSession(t.refreshJti, login, t.refreshExp);
  return { ok: true, login, pid, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresIn: t.expiresIn, token: t.accessToken };
}

const socialCtx: SocialCtx = {
  json, readBody,
  findLogin: l => { const a = accounts.get(String(l).trim().toLowerCase()); return a ? a.login : null; },
  profileOf: l => { const a = accounts.get(l); const gp = a ? gameProfiles.get(a.pid) : undefined;
    return gp ? { nick: gp.nick, avatarFac: gp.avatarFac, frame: gp.frame } : null; },
  allLogins: () => [...accounts.values()].map(a => a.login),
};

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const [path] = url.split('?');
  /* v3.16: origin/CORS и ссылка на req — вешаем на res, json() использует */
  const r2 = res as ServerResponse & { _req?: IncomingMessage; _corsOrigin?: string | null };
  r2._req = req;
  r2._corsOrigin = corsAllow(req);
  if (req.method === 'OPTIONS') {
    if (!r2._corsOrigin) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"origin not allowed"}'); return; }
    res.writeHead(204, {
      'access-control-allow-origin': r2._corsOrigin,
      'access-control-allow-headers': 'content-type, authorization, x-admin-key',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'vary': 'origin',
    });
    res.end();
    return;
  }
  /* v3.16: POST-тело читаем один раз тут (лимит 256 КБ, кэш в req._body для роутов);
     слишком большое — немедленный 413, дальше запрос не обрабатывается. */
  if (req.method === 'POST') {
    await readBody(req).catch(() => ({}));
    if ((req as IncomingMessage & { _tooLarge?: boolean })._tooLarge) {
      return json(res, 413, { error: 'Тело запроса слишком большое (макс. 256 КБ)', code: 'body_too_large' });
    }
  }
  /* rate-limit: только POST, auth — ужесточенно (перебор паролей) */
  if (req.method === 'POST') {
    const isAuth = path.startsWith('/api/auth/');
    if (!rateLimit(req, isAuth ? 'auth' : 'post', isAuth ? 10 : 60, 60_000)) {
      res.setHeader('retry-after', '60');
      return json(res, 429, { error: 'Слишком много запросов — попробуйте через минуту' });
    }
  }
  /* ---- v3.13: админ-ручки (x-admin-key; v3.16: ключ генерируется/env, сравнение
       в константное время) ---- */
  if (path.startsWith('/api/admin/')) {
    if (!adminOk(req.headers['x-admin-key'])) return json(res, 403, { error: 'admin key required', code: 'admin_key_invalid' });
    if (req.method === 'GET' && path === '/api/admin/users') {
      const users = [...accounts.values()].map(a => {
        const gp = gameProfiles.get(a.pid);
        const pres = presenceInfo(a.login);
        return {
          login: a.login, pid: a.pid,
          nick: gp?.nick ?? nicks.get(a.pid) ?? a.login,
          avatarFac: gp?.avatarFac ?? 'Aurites', frame: gp?.frame ?? 'bronze',
          level: gp?.level ?? 1, mmr: gp?.mmr ?? 1000, wins: gp?.wins ?? 0, losses: gp?.losses ?? 0,
          shards: gp?.shards ?? 0, gems: gp?.gems ?? 0, banned: !!gp?.banned,
          status: statusOf(a.login), lastSeen: pres?.ts ?? 0,
        };
      });
      /* apiVersion:3 — маркер дельта-протокола v3.15.3+. Админ-UI по его отсутствию
         понимает, что сервер старый, и показывает баннер «обновите meta-server». */
      return json(res, 200, { users, apiVersion: 3 });
    }
    if (req.method === 'POST' && path === '/api/admin/adjust') {
      const b = await readBody(req);
      const a = accounts.get(String(b.login ?? '').toLowerCase());
      if (!a) return json(res, 404, { error: 'no such user' });
      let gp = gameProfiles.get(a.pid);
      if (!gp) { gp = blankGameProfile(a.pid, a.login); gameProfiles.set(a.pid, gp); }
      const num = (k: string): number | null => (typeof b[k] === 'number' && isFinite(b[k] as number) ? Math.max(0, Math.floor(b[k] as number)) : null);
      const mmr = num('mmr'); if (mmr !== null) gp.mmr = mmr;
      const wins = num('wins'); if (wins !== null) gp.wins = wins;
      const losses = num('losses'); if (losses !== null) gp.losses = losses;
      const shards = num('shards'); if (shards !== null) gp.shards = shards;
      const gems = num('gems'); if (gems !== null) gp.gems = gems;
      const packs = num('freeOpens'); if (packs !== null) gp.freeOpens = packs;
      const bpXp = num('bpXp'); if (bpXp !== null) gp.bpXp = bpXp;
      if (typeof b.nick === 'string' && b.nick.trim()) gp.nick = b.nick.trim().slice(0, 24);
      if (typeof b.banned === 'boolean') { gp.banned = b.banned; if (b.banned) kickedLogins.add(a.login); else kickedLogins.delete(a.login); }
      gp.updatedAt = Date.now();
      pgDirtyPids.add(a.pid); markDirty();   // v3.16: выдача сразу в персист (≤5с)
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/admin/kick') {
      const b = await readBody(req);
      const login = String(b.login ?? '').toLowerCase();
      if (!accounts.has(login)) return json(res, 404, { error: 'no such user' });
      kickedLogins.add(login); touch(login, 'offline');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'unknown admin route' });
  }

  /* ---- JWT-гард: если pid привязан к аккаунту — нужен валидный access-токен этого аккаунта.
     Гостевые pid (без аккаунта) работают как раньше — локальная игра не ломается. ---- */
  if (!path.startsWith('/api/auth/') && path !== '/api/telemetry' && (req.method === 'POST' || path === '/api/profile')) {
    const claims = bearer(req.headers.authorization);
    if (claims === null) return json(res, 401, { error: 'Токен недействителен или истёк', code: 'token_invalid' });
    let pid = '';
    if (req.method === 'POST') {
      const b = await readBody(req);
      (req as IncomingMessage & { _body?: Record<string, unknown> })._body = b;
      pid = String(b.pid ?? '');
    } else {
      pid = new URLSearchParams(url.split('?')[1] ?? '').get('pid') ?? '';
    }
    const owned = pid && [...accounts.values()].some(a => a.pid === pid);
    if (claims && pid && claims.pid !== pid) return json(res, 403, { error: 'Токен выдан для другого профиля', code: 'pid_mismatch' });
    if (owned && !claims) return json(res, 401, { error: 'Нужна авторизация', code: 'auth_required' });
    if (claims) {
      const acc = [...accounts.values()].find(a => a.pid === claims.pid);
      if (acc && kickedLogins.has(acc.login)) return json(res, 401, { error: 'Вы отключены администратором — войдите снова', code: 'kicked' });
    }
  }
  /* ---- Онлайн: друзья / присутствие / рейтинг / матчмейкинг (server/social.ts) ---- */
  if (await handleSocial(req, res, path, url, socialCtx)) return;
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, profiles: profiles.size, db: pool ? 'postgres' : 'file' });

  if (req.method === 'POST' && path === '/profiles') {
    const b = await readBody(req);
    const id = `p${seq++}`;
    const prof: Profile = { id, handle: String(b.handle ?? 'Игрок'), shards: 1200, owned: baseOwned(), created: Date.now() };
    profiles.set(id, prof);
    return json(res, 200, { id, profile: { handle: prof.handle, shards: prof.shards } });
  }

  const mGet = path.match(/^\/profiles\/([\w-]+)$/);
  if (req.method === 'GET' && mGet) {
    const p = profiles.get(mGet[1]);
    if (!p) return json(res, 404, { error: 'profile not found' });
    return json(res, 200, {
      handle: p.handle, shards: p.shards,
      collection: [...p.owned.entries()].map(([id, n]) => ({ id, copies: n })),
    });
  }

  if (req.method === 'POST' && path === '/boosters/open') {
    const b = await readBody(req);
    const p = profiles.get(String(b.profileId ?? ''));
    if (!p) return json(res, 404, { error: 'profile not found' });
    if (p.shards < PACK_PRICE) return json(res, 402, { error: 'not enough shards', shards: p.shards });
    p.shards -= PACK_PRICE;
    return json(res, 200, openBooster(p));
  }

  if (req.method === 'POST' && (path === '/craft' || path === '/dust')) {
    const b = await readBody(req);
    const p = profiles.get(String(b.profileId ?? ''));
    const card = db.get(String(b.cardId ?? ''));
    if (!p || !card) return json(res, 404, { error: 'profile or card not found' });
    const have = p.owned.get(card.id) ?? 0;
    if (path === '/craft') {
      const cost = CRAFT_COST[card.rarity] ?? 100;
      if (have >= PLAYSET) return json(res, 409, { error: 'playset limit' });
      if (p.shards < cost) return json(res, 402, { error: 'not enough shards' });
      p.shards -= cost; p.owned.set(card.id, have + 1);
      return json(res, 200, { shards: p.shards, copies: have + 1 });
    }
    const min = EXPANSION.has(card.id) ? 0 : 1;
    if (have <= min) return json(res, 409, { error: 'cannot dust' });
    p.owned.set(card.id, have - 1);
    p.shards += DUST_GAIN[card.rarity] ?? 20;
    return json(res, 200, { shards: p.shards, copies: have - 1 });
  }

  /* ---- Спека «2. Профиль»: GET/POST /api/profile, ник-уникальность, квесты, клейм ---- */
  const qs = new URLSearchParams(url.split('?')[1] ?? '');

  if (req.method === 'GET' && path === '/api/profile/nick') {
    const nick = String(qs.get('nick') ?? '').trim().toLowerCase();
    const pid = String(qs.get('pid') ?? '');
    if (!nick) return json(res, 400, { error: 'empty nick' });
    const owner = nicks.get(nick);
    return json(res, 200, { free: !owner || owner === pid });
  }

  if (req.method === 'GET' && path === '/api/profile') {
    const gp = gameProfiles.get(String(qs.get('pid') ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    return json(res, 200, gp);
  }

  if (req.method === 'POST' && path === '/api/profile') {
    const b = await readBody(req);
    const pid = String(b.pid ?? '');
    if (!pid) return json(res, 400, { error: 'pid required' });
    const prev = gameProfiles.get(pid);
    const nick = String(b.nick ?? prev?.nick ?? 'Гость');
    const lowNick = nick.trim().toLowerCase();
    const owner = nicks.get(lowNick);
    if (lowNick && owner && owner !== pid) return json(res, 409, { error: 'nick taken' });
    if (lowNick) nicks.set(lowNick, pid);
    /* v3.15.3: валюта/рейтинг — merge по дельте клиента (d*):
       есть профиль на сервере → база + дельта (выдачи админки /api/admin/adjust НЕ затираются);
       профиля нет → абсолютное значение из запроса либо дефолт (первый синк/миграция). */
    const numD = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
    const merge = (prevV: unknown, absV: unknown, dV: unknown, fallback: number, floor = 0): number => {
      const prevN = numD(prevV);
      if (prevN != null) return Math.max(floor, prevN + (numD(dV) ?? 0));
      return Math.max(floor, numD(absV) ?? fallback);
    };
    const mShards = merge(prev?.shards, b.shards, b.dShards, 1200);
    const mGems = merge(prev?.gems, b.gems, b.dGems, 100);
    const mFreeOpens = merge(prev?.freeOpens, b.freeOpens, b.dFreeOpens, 0);
    const mMmr = merge(prev?.mmr, b.mmr, b.dMmr, 1000, 800);
    const mWins = merge(prev?.wins, b.wins, b.dWins, 0);
    const mLosses = merge(prev?.losses, b.losses, b.dLosses, 0);
    const mBpXp = merge(prev?.bpXp, b.bpXp, b.dBpXp, 0);
    const mBestMmr = Math.max(mMmr, merge(prev?.bestMmr, b.bestMmr, undefined, 1000, 800));
    const gp: GameProfile = {
      pid, nick,
      level: Number(b.level ?? prev?.level ?? 1),
      xp: Number(b.xp ?? prev?.xp ?? 0),
      mmr: mMmr,
      bestMmr: mBestMmr,
      wins: mWins,
      losses: mLosses,
      avatarFac: String(b.avatarFac ?? prev?.avatarFac ?? 'Aurites'),
      frame: String(b.frame ?? prev?.frame ?? 'bronze'),
      ach: (b.ach as Record<string, boolean> | undefined) ?? prev?.ach ?? {},
      quests: (b.quests as GameProfile['quests'] | undefined) ?? prev?.quests ?? { daily: [], weekly: [] },
      questDate: String(b.questDate ?? prev?.questDate ?? ''),
      wquestWeek: String(b.wquestWeek ?? prev?.wquestWeek ?? ''),
      history: (b.history as GameProfile['history'] | undefined) ?? prev?.history ?? [],
      shards: mShards,
      gems: mGems,
      freeOpens: mFreeOpens,
      bundles: (b.bundles as string[] | undefined) ?? prev?.bundles ?? [],
      cosmetics: b.cosmetics ?? prev?.cosmetics ?? null,
      purchases: prev?.purchases ?? [],
      collection: prev?.collection ?? {},
      bpXp: mBpXp,
      bpPremium: b.bpPremium != null ? !!b.bpPremium : (prev?.bpPremium ?? false),
      bpClaimed: (b.bpClaimed as number[] | undefined) ?? prev?.bpClaimed ?? [],
      bpClaimedP: (b.bpClaimedP as number[] | undefined) ?? prev?.bpClaimedP ?? [],
      foilTokens: Number(b.foilTokens ?? prev?.foilTokens ?? 0),
      premOpens: Number(b.premOpens ?? prev?.premOpens ?? 0),
      avatarsOwned: (b.avatarsOwned as string[] | undefined) ?? prev?.avatarsOwned ?? [],
      tutStage: Number(b.tutStage ?? prev?.tutStage ?? 0),
      tutDone: b.tutDone != null ? !!b.tutDone : (prev?.tutDone ?? false),
      tutReward: String(b.tutReward ?? prev?.tutReward ?? ''),
      tutClaims: (b.tutClaims as number[] | undefined) ?? prev?.tutClaims ?? [],
      updatedAt: Date.now(),
    };
    gameProfiles.set(pid, gp);
    /* v3.16: коалесценция записи — не дамп на каждый синк, а dirty-пометка +
       фоновая асинхронная запись (≤1 раз в 5с) и точечный PG-флеш этого pid. */
    pgDirtyPids.add(pid);
    if (lowNick) pgDirtyNicks.add(lowNick);
    markDirty();
    void flushPg('profile');  // fire-and-forget: UI не ждёт диск/PG
    /* apiVersion — маркер версии протокола: клиент по нему видит, что сервер понимает
       дельта-синк (v3.15.3+). Старый сервер не вернёт это поле — клиент предупредит. */
    return json(res, 200, { ok: true, apiVersion: 3, profile: gp });
  }

  if (req.method === 'GET' && path === '/api/quests') {
    const gp = gameProfiles.get(String(qs.get('pid') ?? ''));
    return json(res, 200, gp?.quests ?? { daily: [], weekly: [] });
  }

  if (req.method === 'POST' && path === '/api/quests/claim') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const kind = String(b.kind ?? 'daily') === 'weekly' ? 'weekly' : 'daily';
    const row = gp.quests[kind].find(x => x.id === String(b.id ?? ''));
    if (!row) return json(res, 404, { error: 'quest not found' });
    if (row.claimed) return json(res, 409, { error: 'already claimed' });
    const prog = Number(b.prog ?? row.prog);
    if (prog < row.goal) return json(res, 422, { error: 'quest not complete', prog, goal: row.goal });
    row.claimed = true;
    row.prog = prog;
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, id: row.id, kind });
  }

  /* ---- Спека «3. Магазин»: каталог, покупки, коллекция, крафт/разбор ---- */

  if (req.method === 'GET' && path === '/api/shop') return json(res, 200, SHOP_CATALOG);

  if (req.method === 'POST' && path === '/api/shop/buy') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const item = String(b.itemId ?? '');
    const spend = (cur: string, price: number): string | null => {
      if (price <= 0) return null;
      if (cur === 'gems') {
        if (gp.gems < price) return `недостаточно 💎 (нужно ${price}, есть ${gp.gems})`;
        gp.gems -= price;
      } else {
        if (gp.shards < price) return `недостаточно ◈ (нужно ${price}, есть ${gp.shards})`;
        gp.shards -= price;
      }
      return null;
    };
    if (item === 'pack' || item === 'pack_faction') {
      const faction = item === 'pack_faction' ? String(b.faction ?? '') : null;
      if (item === 'pack_faction' && !FACTIONS5.includes(faction ?? ''))
        return json(res, 400, { error: 'faction required' });
      const err = spend('shards', item === 'pack' ? 300 : 350);
      if (err) return json(res, 402, { error: err });
      const drops = rollPack(faction);
      gp.updatedAt = Date.now();
      return json(res, 200, { ok: true, item, drops, shards: gp.shards, gems: gp.gems });
    }
    if (item === 'bundle11') {
      const err = spend('shards', 2700);
      if (err) return json(res, 402, { error: err });
      gp.freeOpens += 11;
      gp.updatedAt = Date.now();
      return json(res, 200, { ok: true, item, grants: { freeOpens: 11 }, shards: gp.shards, gems: gp.gems });
    }
    if (item.startsWith('starter_')) {
      const fac = item.slice('starter_'.length);
      if (!FACTIONS5.includes(fac)) return json(res, 404, { error: 'unknown item' });
      if (gp.bundles.includes(fac)) return json(res, 409, { error: 'already purchased' });
      const err = spend('gems', 400);
      if (err) return json(res, 402, { error: err });
      gp.bundles.push(fac);
      gp.freeOpens += 10; gp.shards += 500;
      if (!gp.purchases.includes('ava_arch')) gp.purchases.push('ava_arch');
      gp.updatedAt = Date.now();
      return json(res, 200, { ok: true, item, grants: { freeOpens: 10, shards: 500, avatar: 'arch' },
        shards: gp.shards, gems: gp.gems });
    }
    const cosm = [...SHOP_CATALOG.cosmetics.backs, ...SHOP_CATALOG.cosmetics.tables, ...SHOP_CATALOG.cosmetics.runes]
      .find(x => x.id === item) as { id: string; price: number; currency: string } | undefined;
    if (cosm) {
      if (gp.purchases.includes(item)) return json(res, 409, { error: 'already owned' });
      if (cosm.currency === 'bp') return json(res, 403, { error: 'награда боевого пропуска — не продаётся' });
      const err = spend(cosm.currency, cosm.price);
      if (err) return json(res, 402, { error: err });
      gp.purchases.push(item);
      gp.updatedAt = Date.now();
      return json(res, 200, { ok: true, item, shards: gp.shards, gems: gp.gems });
    }
    return json(res, 404, { error: 'unknown item' });
  }

  /* Добавление карт в коллекцию (использует PackGenerator.cs после вскрытия):
     копии ≤ 4 идут в коллекцию, излишек автоматически конвертируется в ◈ по тарифу разбора. */
  if (req.method === 'POST' && path === '/api/collection/add') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(String) : [];
    const added: Array<{ id: string; copies: number }> = [];
    const converted: Array<{ id: string; dust: number }> = [];
    for (const id of ids) {
      const card = db.get(id);
      if (!card) continue;
      const have = gp.collection[id] ?? 0;
      if (have < PLAYSET) {
        gp.collection[id] = have + 1;
        added.push({ id, copies: have + 1 });
      } else {
        const dust = DUST_GAIN[card.rarity] ?? 1;
        gp.shards += dust;
        converted.push({ id, dust });
      }
    }
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, added, converted, shards: gp.shards });
  }

  /* Крафт/разбор по спеке п.4.4 — те же тарифы, что у старого /craft и /dust (profileId),
     но поверх игрового профиля (pid) и его коллекции. */
  if (req.method === 'POST' && (path === '/api/craft' || path === '/api/dust')) {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    const card = db.get(String(b.cardId ?? ''));
    if (!gp || !card) return json(res, 404, { error: 'profile or card not found' });
    const have = gp.collection[card.id] ?? 0;
    if (path === '/api/craft') {
      const cost = CRAFT_COST[card.rarity] ?? 5;
      if (have >= PLAYSET) return json(res, 409, { error: 'playset limit' });
      if (gp.shards < cost) return json(res, 402, { error: 'not enough ◈', shards: gp.shards });
      gp.shards -= cost;
      gp.collection[card.id] = have + 1;
      gp.updatedAt = Date.now();
      return json(res, 200, { ok: true, shards: gp.shards, copies: have + 1 });
    }
    const min = EXPANSION.has(card.id) ? 0 : 1;
    if (have <= min) return json(res, 409, { error: 'cannot dust' });
    gp.collection[card.id] = have - 1;
    gp.shards += DUST_GAIN[card.rarity] ?? 1;
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, shards: gp.shards, copies: have - 1 });
  }

  /* ---- Спека «5. Боевой пропуск»: эндпоинты для Unity (BattlePassController/BattlePassXP) ---- */

  if (req.method === 'GET' && path === '/api/battlepass') {
    const gp = gameProfiles.get(String(qs.get('pid') ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const rewards = Array.from({ length: BP_LEVELS }, (_, i) => {
      const lv = i + 1;
      const r = bpReward(lv);
      return { lvl: lv, free: r.free, prem: r.prem };
    });
    return json(res, 200, { ok: true, levels: BP_LEVELS, xpStep: BP_STEP, rates: BP_XP,
      xp: gp.bpXp, level: bpLevel(gp.bpXp), premium: gp.bpPremium,
      claimedFree: gp.bpClaimed, claimedPrem: gp.bpClaimedP, rewards });
  }

  if (req.method === 'POST' && path === '/api/battlepass/addxp') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const reason = String(b.reason ?? '');
    const amount = b.amount != null ? Math.max(0, Number(b.amount)) : (BP_XP[reason] ?? 0);
    if (!(amount > 0)) return json(res, 400, { error: 'amount or reason (win|loss|daily|weekly) required' });
    const before = bpLevel(gp.bpXp);
    gp.bpXp += amount;
    const after = bpLevel(gp.bpXp);
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, xp: gp.bpXp, level: after, levelUps: Math.max(0, after - before),
      newLevels: Array.from({ length: Math.max(0, after - before) }, (_, i) => before + i + 1) });
  }

  if (req.method === 'POST' && path === '/api/battlepass/buy') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    if (gp.bpPremium) return json(res, 409, { error: 'premium already active' });
    if (gp.gems < 500) return json(res, 402, { error: `недостаточно 💎 (нужно 500, есть ${gp.gems})` });
    gp.gems -= 500;
    gp.bpPremium = true;
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, premium: true, gems: gp.gems });
  }

  if (req.method === 'POST' && path === '/api/battlepass/claim') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const lvl = Number(b.level);
    const track = String(b.track ?? 'free');
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > BP_LEVELS || (track !== 'free' && track !== 'prem'))
      return json(res, 400, { error: 'level 1..50 и track free|prem обязательны' });
    if (track === 'prem' && !gp.bpPremium) return json(res, 403, { error: 'премиум-ветка не куплена' });
    const cur = bpLevel(gp.bpXp);
    if (lvl > cur) return json(res, 409, { error: `уровень не достигнут (текущий ${cur})` });
    const list = track === 'prem' ? gp.bpClaimedP : gp.bpClaimed;
    if (list.includes(lvl)) return json(res, 409, { error: 'награда уже получена' });
    const rw = bpReward(lvl)[track === 'prem' ? 'prem' : 'free'];
    list.push(lvl);
    bpApply(gp, rw);
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, level: lvl, track, reward: rw,
      shards: gp.shards, gems: gp.gems, freeOpens: gp.freeOpens, premOpens: gp.premOpens, foilTokens: gp.foilTokens });
  }

  if (req.method === 'POST' && path === '/api/battlepass/claimall') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const cur = bpLevel(gp.bpXp);
    let n = 0;
    const totals = { shards: 0, gems: 0, packs: 0, premPacks: 0, foils: 0, backs: 0, avatars: 0 };
    for (let lv = 1; lv <= cur; lv++) {
      const r = bpReward(lv);
      if (!gp.bpClaimed.includes(lv)) {
        gp.bpClaimed.push(lv); bpApply(gp, r.free); n += 1;
        totals.shards += r.free.shards ?? 0; totals.gems += r.free.gems ?? 0; totals.packs += r.free.pack ?? 0;
      }
      if (gp.bpPremium && !gp.bpClaimedP.includes(lv)) {
        gp.bpClaimedP.push(lv); bpApply(gp, r.prem); n += 1;
        totals.shards += r.prem.shards ?? 0; totals.gems += r.prem.gems ?? 0; totals.packs += r.prem.pack ?? 0;
        totals.premPacks += r.prem.premPack ?? 0; totals.foils += r.prem.foil ?? 0;
        if (r.prem.back) totals.backs += 1;
        if (r.prem.ava) totals.avatars += 1;
      }
    }
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, claimed: n, totals,
      shards: gp.shards, gems: gp.gems, freeOpens: gp.freeOpens, premOpens: gp.premOpens, foilTokens: gp.foilTokens });
  }

  /* Вскрытие запасённых бустеров: free (freeOpens) / premium (premOpens, 2C+1R+2E/L).
     Дроп регистрируется в коллекции через POST /api/collection/add. */
  if (req.method === 'POST' && path === '/api/packs/open') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const type = String(b.type ?? 'free');
    if (type === 'premium') {
      if (gp.premOpens <= 0) return json(res, 402, { error: 'нет премиум-бустеров в запасе' });
      gp.premOpens -= 1;
    } else if (type === 'free') {
      if (gp.freeOpens <= 0) return json(res, 402, { error: 'нет бесплатных бустеров в запасе' });
      gp.freeOpens -= 1;
    } else return json(res, 400, { error: 'type free|premium' });
    const drops = rollPack(null, type === 'premium');
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, type, drops, freeOpens: gp.freeOpens, premOpens: gp.premOpens });
  }

  /* ---- Спека «6. Обучение»: состояние уроков, награда, гейт тренировки (Unity: TutorialController) ---- */

  if (req.method === 'GET' && path === '/api/tutorial') {
    const gp = gameProfiles.get(String(qs.get('pid') ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    return json(res, 200, { ok: true, stage: gp.tutStage, done: gp.tutDone, reward: gp.tutReward,
      claims: gp.tutClaims, lessonRewards: TUT_LESSON_REWARD,
      finalReward: { boosters: 5, gems: 100, deckCards: 10 } });
  }

  if (req.method === 'POST' && path === '/api/tutorial/complete') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    const lesson = Number(b.lesson);
    if (!Number.isInteger(lesson) || lesson < 1 || lesson > 4) return json(res, 400, { error: 'lesson 1..4' });
    gp.tutStage = Math.max(gp.tutStage, lesson);
    gp.tutDone = true;
    let granted = 0;
    if (!gp.tutClaims.includes(lesson)) {          // однократно: повторное прохождение не фармит ◈
      gp.tutClaims.push(lesson);
      granted = TUT_LESSON_REWARD[lesson] ?? 0;
      gp.shards += granted;
    }
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, lesson, stage: gp.tutStage, granted, shards: gp.shards });
  }

  /* Финальная награда (спека 6.2): выбор фракции → стартовая колода (10 дешевейших базовых ×2)
     + 5 бустеров + 💎100. Одноразово; доступна после всех 4 уроков. */
  if (req.method === 'POST' && path === '/api/tutorial/reward') {
    const b = await readBody(req);
    const gp = gameProfiles.get(String(b.pid ?? ''));
    if (!gp) return json(res, 404, { error: 'profile not found' });
    if (gp.tutStage < 4) return json(res, 409, { error: 'сначала пройдите все 4 урока' });
    const fac = String(b.faction ?? '');
    if (!FACTIONS5.includes(fac)) return json(res, 400, { error: 'faction required' });
    if (gp.tutReward) return json(res, 409, { error: 'награда уже получена' });
    gp.tutReward = fac;
    gp.freeOpens += 5;
    gp.gems += 100;
    const cheap = [...db.values()].filter(c => c.faction === fac && !EXPANSION.has(c.id))
      .sort((x, y) => x.cost - y.cost).slice(0, 10);
    const deck: string[] = [];
    for (const c of cheap) {
      gp.collection[c.id] = Math.min(PLAYSET, (gp.collection[c.id] ?? 0) + 2);
      deck.push(c.id);
    }
    gp.updatedAt = Date.now();
    return json(res, 200, { ok: true, faction: fac, freeOpens: gp.freeOpens, gems: gp.gems, deck });
  }

  /* ---- Аккаунты: POST /api/auth/register | /api/auth/login → {login, pid, token} ---- */
  if (req.method === 'POST' && path === '/api/auth/register') {
    const b = await readBody(req);
    const login = String(b.login ?? '').trim().toLowerCase();
    const pw = String(b.password ?? '');
    const pid = String(b.pid ?? '').trim();
    if (!/^[a-z0-9_.-]{3,20}$/.test(login)) return json(res, 400, { error: 'Логин:3–20 символов, латиница/цифры/_.-' });
    /* v3.16: минимум8 символов (4 — слабый уровень; старые аккаунты с короче — работают,
       при следующей смене пароля требование обязательное) */
    if (pw.length < 8) return json(res, 400, { error: 'Пароль: минимум 8 символов' });
    if (accounts.has(login)) return json(res, 409, { error: 'Логин уже занят' });
    if (pid && [...accounts.values()].some(a => a.pid === pid)) return json(res, 409, { error: 'Этот прогресс уже привязан к другому логину' });
    const salt = randomBytes(16).toString('hex');
    const acc: Account = { login, salt, hash: hashPw(pw, salt), pid: pid || randomBytes(8).toString('hex'), created: Date.now() };
    if (pool && pgReady) {
      // PG первым: уникальность login/pid страхует гонки (23505 → 409)
      try {
        await pool.query(
          `INSERT INTO accounts (login, salt, hash, pid, created)
           VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0))`,
          [acc.login, acc.salt, acc.hash, acc.pid, acc.created]);
      } catch (e) {
        const er = e as { code?: string; constraint?: string; message?: string };
        if (er.code === '23505') {
          return json(res, 409, { error: er.constraint === 'accounts_pid_key'
            ? 'Этот прогресс уже привязан к другому логину' : 'Логин уже занят' });
        }
        console.error('[meta-server] pg register:', er.message);
        return json(res, 500, { error: 'Не удалось сохранить аккаунт' });
      }
    }
    accounts.set(login, acc); saveAccounts();
    return json(res, 200, startSession(login, acc.pid));
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const b = await readBody(req);
    const login = String(b.login ?? '').trim().toLowerCase();
    const pw = String(b.password ?? '');
    const acc = accounts.get(login);
    if (!acc) return json(res, 401, { error: 'Неверный логин или пароль' });
    const got = Buffer.from(hashPw(pw, acc.salt), 'hex');
    const want = Buffer.from(acc.hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return json(res, 401, { error: 'Неверный логин или пароль' });
    kickedLogins.delete(login);   // v3.13: повторный вход снимает кик
    const gpBan = gameProfiles.get(acc.pid);
    if (gpBan?.banned) return json(res, 403, { error: 'Аккаунт заблокирован администратором', code: 'banned' });
    return json(res, 200, startSession(login, acc.pid));
  }

  /* ---- JWT: обновление пары (ротация refresh), выход, текущий пользователь ---- */
  if (req.method === 'POST' && path === '/api/auth/refresh') {
    const b = await readBody(req);
    const c = verify<RefreshClaims>(String(b.refreshToken ?? ''), 'refresh');
    if (!c) return json(res, 401, { error: 'Refresh-токен недействителен', code: 'refresh_invalid' });
    const sess = sessions.get(c.jti);
    if (!sess || sess.login !== c.sub) {
      // повторное использование уже погашенного refresh → отзываем все сессии пользователя
      revokeAll(c.sub);
      return json(res, 401, { error: 'Сессия отозвана — войдите снова', code: 'refresh_reused' });
    }
    dropSession(c.jti);
    const acc = accounts.get(c.sub);
    if (!acc) return json(res, 401, { error: 'Аккаунт не найден', code: 'refresh_invalid' });
    return json(res, 200, startSession(acc.login, acc.pid));
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    const b = await readBody(req);
    const c = verify<RefreshClaims>(String(b.refreshToken ?? ''), 'refresh');
    if (c) { if (b.all) revokeAll(c.sub); else dropSession(c.jti); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/api/auth/me') {
    const c = bearer(req.headers.authorization);
    if (!c) return json(res, 401, { error: 'Нужна авторизация', code: 'auth_required' });
    return json(res, 200, { ok: true, login: c.sub, pid: c.pid, exp: c.exp });
  }

  /* ---- Телеметрия: POST /api/telemetry {pid, e} → кольцевой буфер500, GET — отладка ---- */
  if (req.method === 'POST' && path === '/api/telemetry') {
    const b = await readBody(req);
    telemRing.push({ ts: Date.now(), pid: String(b.pid ?? ''), e: b.e ?? b });
    while (telemRing.length > 500) telemRing.shift();
    if (pool && pgReady) {
      const tPid = String(b.pid ?? '');
      const tE = b.e ?? b;
      void pool.query('INSERT INTO telemetry_log (pid, e) VALUES ($1, $2)', [tPid, JSON.stringify(tE)])
        .catch(err => console.error('[meta-server] pg telem:', (err as Error).message));
    }
    return json(res, 200, { ok: true, n: telemRing.length });
  }
  /* v3.16: телеметрия содержит pid игроков — отдаём только по админ-ключу (отладка) */
  if (req.method === 'GET' && path === '/api/telemetry') {
    if (!adminOk(req.headers['x-admin-key'])) return json(res, 403, { error: 'admin key required', code: 'admin_key_invalid' });
    return json(res, 200, telemRing);
  }

  return json(res, 404, { error: 'not found' });
});

const PORT = Number(process.env.PORT || 8081);
async function main(): Promise<void> {
  try { await initPg(); } catch (e) {
    console.error('[meta-server] FATAL initPg:', (e as Error).message);
    process.exit(1);
  }
  attachMatchRelay(server, '/match');   // PvP-бои на том же порту: ws://host:8081/match
  /* v3.16: сетевые тайминги для 10k+ соединений — keep-alive длиннее LB-таймаута,
     вешний запрос не висит дольше 30с, пустой keep-alive не держит fd вечно. */
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 30_000;
  server.maxRequestsPerSocket = 1000;
  /* v3.16: backlog 65535 — при волне переподключений (10k+ новых TCP за секунду)
     дефолтный 511 ронял SYN-пакеты, и клиенты переупаковывали их через 1с/3с
     (видно было как скачки p50~1.5s / p95~3.5s в нагрузочном тесте). */
  server.listen({ port: PORT, host: '0.0.0.0', backlog: 65535 }, () => {
    const storage = pool ? 'postgres (DATABASE_URL)' : 'file snapshot.json+accounts.json';
    const shards = process.env.MATCH_SHARDS ? ` · match-shards: ${process.env.MATCH_SHARDS.split(',').length}` : '';
    console.log(`[meta-server] http://0.0.0.0:${PORT} · pvp: ws /match${shards} · rate-limit:${RL_ON ? 'on (auth10/мин, POST60/мин)' : 'off'} · storage: ${storage}`);
    console.log(`[meta-server] v3.16: CORS same-host+allowlist · body≤256КБ · gzip · snapshot: коалесценция+atomic · admin-key: ${process.env.ADMIN_KEY ? 'env' : 'сгенерирован (см. выше)'} · пароли: scrypt`);
  });
}
void main();
