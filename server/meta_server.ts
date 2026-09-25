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
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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
interface QRow { id: string; prog: number; goal: number; claimed: boolean }
interface GameProfile {
  pid: string; nick: string; level: number; xp: number; mmr: number; bestMmr: number;
  wins: number; losses: number; avatarFac: string; frame: string;
  ach: Record<string, boolean>;
  quests: { daily: QRow[]; weekly: QRow[] };
  history: Array<{ ts: number; win: boolean; fac: string; efac?: string; foe?: string; turns: number; practice?: boolean }>;
  shards: number; gems: number; freeOpens: number; bundles: string[];
  cosmetics: unknown;                 // зеркало клиентской косметики (форма клиента)
  purchases: string[];                // покупки через /api/shop/buy (server-side учёт)
  collection: Record<string, number>; // копии карт (для /api/craft, /api/dust, /api/collection/add)
  bpXp: number; bpPremium: boolean;   // спека «5. Боевой пропуск» (v2.5.0)
  bpClaimed: number[]; bpClaimedP: number[];
  foilTokens: number; premOpens: number; avatarsOwned: string[];
  tutStage: number; tutDone: boolean; tutReward: string; tutClaims: number[];   // спека «6. Обучение» (v2.5.1)
  updatedAt: number;
}
const gameProfiles = new Map<string, GameProfile>();
const nicks = new Map<string, string>();   // lower(nick) → pid: занятость никнейма

/* ---- Аккаунты (LAUNCH_PLAN: регистрация/логин через meta-server).
   Пароль — scrypt+salt (хэш в server/data/accounts.json); сессия — токен30 дней.
   PostgreSQL-адаптер позже: schema добавляется без смены маршрутов. ---- */
interface Account { login: string; salt: string; hash: string; pid: string; created: number }
const AUTH_FILE = join(process.cwd(), 'server', 'data', 'accounts.json');
const accounts = new Map<string, Account>();          // lower(login) → аккаунт
const sessions = new Map<string, { login: string; exp: number }>(); // token → сессия
function hashPw(pw: string, salt: string): string { return scryptSync(pw, salt, 32).toString('hex'); }
function saveAccounts(): void {
  try { mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true }); writeFileSync(AUTH_FILE, JSON.stringify([...accounts.values()], null, 2)); } catch { /* read-only fs */ }
}
try { if (existsSync(AUTH_FILE)) for (const a of JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Account[]) accounts.set(a.login.toLowerCase(), a); } catch { /* пусто */ }

/* ---- Телеметрия боёв (LAUNCH_PLAN: POST /telemetry вместо только localStorage) ---- */
const telemRing: Array<{ ts: number; pid?: string; e?: unknown }> = [];

/* ---- Snapshot: персист in-memory состояния в server/data/snapshot.json.
   Дамп каждые60с + при смене профиля + на SIGINT/SIGTERM — файл и есть
   артефакт для бэкапов (docker-compose: backup service копирует metadata:/). ---- */
const SNAP_FILE = join(process.cwd(), 'server', 'data', 'snapshot.json');
function saveSnapshot(): void {
  try {
    mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true });
    writeFileSync(SNAP_FILE, JSON.stringify({
      v: 1, ts: Date.now(),
      profiles: [...gameProfiles.values()],
      nicks: [...nicks.entries()],
      telem: telemRing,
    }));
  } catch { /* read-only fs */ }
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

async function flushPg(reason = ''): Promise<void> {
  if (!pool || !pgReady) return;
  const client = await pool.connect().catch(() => null);
  if (!client) return;
  try {
    await client.query('BEGIN');
    for (const gp of gameProfiles.values()) {
      await client.query(
        `INSERT INTO game_profiles (pid, nick, data, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (pid) DO UPDATE SET nick = EXCLUDED.nick, data = EXCLUDED.data, updated_at = now()`,
        [gp.pid, gp.nick, JSON.stringify(gp)]);
    }
    for (const [low, pid] of nicks) {
      await client.query(
        `INSERT INTO nick_registry (low_nick, pid) VALUES ($1, $2)
         ON CONFLICT (low_nick) DO UPDATE SET pid = EXCLUDED.pid`,
        [low, pid]);
    }
    await client.query('COMMIT');
  } catch (e) {
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
  saveSnapshot();
  if (pool) {
    try { await flushPg('shutdown'); } catch { /* залогировано выше */ }
    try { await pool.end(); } catch { /* нет соединений */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
setInterval(() => { saveSnapshot(); void flushPg('interval'); }, 60_000).unref();

function baseOwned(): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of db.values()) if (!EXPANSION.has(c.id)) m.set(c.id, 1);
  return m;
}
function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(s);
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(res => {
    let buf = '';
    req.on('data', c => { buf += String(c); });
    req.on('end', () => { try { res(JSON.parse(buf || '{}')); } catch { res({}); } });
  });
}

/* ---- Rate-limit (LAUNCH план: прод) — token bucket по IP.
   auth-эндпоинты:10/мин (защита от перебора), прочие POST:60/мин.
   RATE_LIMIT=0 — отключить (локальная разработка/тесты). ---- */
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
  boosters: [
    { id: 'pack', name: 'Бустер «Эхо-Цитадель» (ECH1)', price: 300, currency: 'shards', cards: 5,
      composition: '3 обычных, 1 редкая, 1 эпическая (12.5% легендарная)' },
    { id: 'pack_faction', name: 'Бустер фракции', price: 350, currency: 'shards', cards: 5, requiresFaction: true },
    { id: 'bundle11', name: '11 бустеров по цене 10', price: 2700, currency: 'shards', cards: 55 },
  ],
  starters: FACTIONS5.map(f => ({
    id: `starter_${f}`, name: `Стартовый набор «${f}»`, price: 400, currency: 'gems',
    grants: { boosters: 10, shards: 500, avatar: 'arch' },
  })),
  cosmetics: {
    backs: [
      { id: 'back_classic', name: 'Рубашка «Классика (золото)»', price: 0, currency: 'shards' },
      { id: 'back_runes', name: 'Рубашка «Руны Цитадели»', price: 300, currency: 'shards' },
      { id: 'back_ember', name: 'Рубашка «Угли Пиромантов»', price: 500, currency: 'shards' },
      { id: 'back_abyss', name: 'Рубашка «Бездна»', price: 0, currency: 'bp', note: 'награда боевого пропуска' },
      { id: 'back_verdant', name: 'Рубашка «Вердант»', price: 0, currency: 'bp', note: 'награда боевого пропуска' },
    ],
    tables: [
      { id: 'table_classic', name: 'Классический стол', price: 0, currency: 'shards' },
      { id: 'table_terra', name: 'Стол Терраморфов (мох и камень)', price: 600, currency: 'shards' },
      { id: 'table_necro', name: 'Стол Некрусов (кость и тень)', price: 200, currency: 'gems' },
    ],
    runes: [
      { id: 'rune_classic', name: 'Классические руны', price: 0, currency: 'shards' },
      { id: 'rune_flame', name: 'Руны «Пламя» (анимация)', price: 150, currency: 'gems' },
    ],
  },
  craft: CRAFT_COST,
  dust: DUST_GAIN,
};

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const [path] = url.split('?');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }
  /* rate-limit: только POST, auth — ужесточенно (перебор паролей) */
  if (req.method === 'POST') {
    const isAuth = path.startsWith('/api/auth/');
    if (!rateLimit(req, isAuth ? 'auth' : 'post', isAuth ? 10 : 60, 60_000)) {
      res.setHeader('retry-after', '60');
      return json(res, 429, { error: 'Слишком много запросов — попробуйте через минуту' });
    }
  }
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
    const gp: GameProfile = {
      pid, nick,
      level: Number(b.level ?? prev?.level ?? 1),
      xp: Number(b.xp ?? prev?.xp ?? 0),
      mmr: Number(b.mmr ?? prev?.mmr ?? 1000),
      bestMmr: Number(b.bestMmr ?? prev?.bestMmr ?? 1000),
      wins: Number(b.wins ?? prev?.wins ?? 0),
      losses: Number(b.losses ?? prev?.losses ?? 0),
      avatarFac: String(b.avatarFac ?? prev?.avatarFac ?? 'Aurites'),
      frame: String(b.frame ?? prev?.frame ?? 'bronze'),
      ach: (b.ach as Record<string, boolean> | undefined) ?? prev?.ach ?? {},
      quests: (b.quests as GameProfile['quests'] | undefined) ?? prev?.quests ?? { daily: [], weekly: [] },
      history: (b.history as GameProfile['history'] | undefined) ?? prev?.history ?? [],
      shards: Number(b.shards ?? prev?.shards ?? 1200),
      gems: Number(b.gems ?? prev?.gems ?? 100),
      freeOpens: Number(b.freeOpens ?? prev?.freeOpens ?? 0),
      bundles: (b.bundles as string[] | undefined) ?? prev?.bundles ?? [],
      cosmetics: b.cosmetics ?? prev?.cosmetics ?? null,
      purchases: prev?.purchases ?? [],
      collection: prev?.collection ?? {},
      bpXp: Number(b.bpXp ?? prev?.bpXp ?? 0),
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
    saveSnapshot();   // профиль — событие бэкапа: дамп сразу (не ждём60с интервала)
    await flushPg('profile');  // та же точка — в PG (при DATABASE_URL)
    return json(res, 200, { ok: true, profile: gp });
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
    if (pw.length < 4) return json(res, 400, { error: 'Пароль: минимум4 символа' });
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
    const token = randomBytes(24).toString('hex');
    const expAt = Date.now() + 30 * 24 * 3600_000;
    sessions.set(token, { login, exp: expAt });
    if (pool && pgReady) {
      void pool.query('INSERT INTO sessions (token, login, exp) VALUES ($1,$2, to_timestamp($3/1000.0))',
        [token, login, expAt]).catch(err => console.error('[meta-server] pg session:', (err as Error).message));
    }
    return json(res, 200, { ok: true, login, pid: acc.pid, token });
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const b = await readBody(req);
    const login = String(b.login ?? '').trim().toLowerCase();
    const pw = String(b.password ?? '');
    const acc = accounts.get(login);
    if (!acc) return json(res, 401, { error: 'Нет такого логина' });
    const got = Buffer.from(hashPw(pw, acc.salt), 'hex');
    const want = Buffer.from(acc.hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return json(res, 401, { error: 'Неверный пароль' });
    const token = randomBytes(24).toString('hex');
    const expAt = Date.now() + 30 * 24 * 3600_000;
    sessions.set(token, { login, exp: expAt });
    for (const [k, v] of sessions) if (v.exp < Date.now()) sessions.delete(k);
    if (pool && pgReady) {
      void pool.query(
        `INSERT INTO sessions (token, login, exp) VALUES ($1,$2, to_timestamp($3/1000.0))
         ON CONFLICT (token) DO UPDATE SET exp = EXCLUDED.exp`,
        [token, login, expAt]).catch(err => console.error('[meta-server] pg session:', (err as Error).message));
      void pool.query('DELETE FROM sessions WHERE exp < now()').catch(() => { /* фоновая чистка */ });
    }
    return json(res, 200, { ok: true, login, pid: acc.pid, token });
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
  if (req.method === 'GET' && path === '/api/telemetry') return json(res, 200, telemRing);

  return json(res, 404, { error: 'not found' });
});

const PORT = Number(process.env.PORT || 8081);
async function main(): Promise<void> {
  try { await initPg(); } catch (e) {
    console.error('[meta-server] FATAL initPg:', (e as Error).message);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => {
    const storage = pool ? 'postgres (DATABASE_URL)' : 'file snapshot.json+accounts.json';
    console.log(`[meta-server] http://0.0.0.0:${PORT} · rate-limit:${RL_ON ? 'on (auth10/мин, POST60/мин)' : 'off'} · storage: ${storage}`);
  });
}
void main();
