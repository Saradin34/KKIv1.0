/* =====================================================================
   Онлайн-слой meta-server: друзья, присутствие, рейтинг (Elo + ранги),
   матчмейкинг (рейтинговый / обычный), вызовы друзей, таблица лидеров.
   Все ручки — только для авторизованных (JWT access, см. auth_jwt.ts).
   Итог рейтингового матча принимается ТОЛЬКО от match-server
   (POST /api/internal/match-result с ключом INTERNAL_KEY) — клиент
   не может сам себе записать победу.
   Спецификация: docs/ONLINE_SPEC.md
   ===================================================================== */
import { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AccessClaims, bearer, issueMatchTicket, INTERNAL_KEY } from './auth_jwt';

type Json = (res: ServerResponse, code: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;
export interface SocialCtx {
  json: Json; readBody: ReadBody;
  /** логин существует? (регистр не важен) → каноничный логин */
  findLogin: (login: string) => string | null;
  /** ник/аватар профиля по логину (для списков), если есть */
  profileOf: (login: string) => { nick?: string; avatarFac?: string; frame?: string } | null;
  /** все логины (поиск) */
  allLogins: () => string[];
}

/* ------------------------------ хранилище ------------------------------ */
interface Rating { mmr: number; peak: number; games: number; wins: number; losses: number; season: number; streak: number }
interface SocialState {
  friends: Record<string, string[]>;                 // login → [login]
  requests: Array<{ from: string; to: string; ts: number }>;
  ratings: Record<string, Rating>;
  history: Array<{ id: string; mode: string; a: string; b: string; winner: string | null; dA: number; dB: number; ts: number }>;
}
const FILE = join(process.cwd(), 'server', 'data', 'social.json');
const st: SocialState = { friends: {}, requests: [], ratings: {}, history: [] };
try { if (existsSync(FILE)) Object.assign(st, JSON.parse(readFileSync(FILE, 'utf8'))); } catch { /* пусто */ }
let saveT: NodeJS.Timeout | null = null;
function save(): void {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true }); writeFileSync(FILE, JSON.stringify(st)); } catch { /* read-only */ }
  }, 300);
}

export const SEASON = Number(process.env.SEASON || 4);
const START_MMR = 1200;
const MAX_FRIENDS = 200;

/* v3.16: горизонтальное масштабирование матч-тиера.
   env MATCH_SHARDS="ws://m1:8080/match,ws://m2:8080/match,..." — пул WebSocket-шардов.
   Шард выбирается детерминированно по id матча (оба игрока одного матча всегда
   попадают в ОДИН и тот же шард — ретрансляция работает в пределах шарда).
   Без env — штатный встроенный /match на этом же сервере (1 шард). */
const MATCH_SHARDS: string[] = (process.env.MATCH_SHARDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
export function wsUrlFor(match: string): string | undefined {
  if (!MATCH_SHARDS.length) return undefined;
  let h = 0;
  for (let i = 0; i < match.length; i++) h = (h * 31 + match.charCodeAt(i)) | 0;
  return MATCH_SHARDS[Math.abs(h) % MATCH_SHARDS.length];
}

/* ------------------------------ рейтинг ------------------------------ */
export function ratingOf(login: string): Rating {
  let r = st.ratings[login];
  if (!r || r.season !== SEASON) {
    // мягкий сброс сезона: половина пути к стартовому рейтингу
    const prev = r?.mmr ?? START_MMR;
    r = { mmr: Math.round(START_MMR + (prev - START_MMR) / 2), peak: 0, games: 0, wins: 0, losses: 0, season: SEASON, streak: 0 };
    r.peak = r.mmr;
    st.ratings[login] = r;
  }
  return r;
}
const TIERS: Array<[number, string]> = [[0, 'Бронза'], [1100, 'Серебро'], [1300, 'Золото'], [1500, 'Платина'], [1700, 'Алмаз'], [1900, 'Мифик']];
export function rankOf(mmr: number): { tier: string; div: number | null; label: string } {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (mmr >= TIERS[k][0]) i = k;
  const tier = TIERS[i][1];
  if (tier === 'Мифик') return { tier, div: null, label: `Мифик · ${mmr}` };
  const base = i === 0 ? 900 : TIERS[i][0];
  const top = TIERS[i + 1][0];
  const step = (top - base) / 4;
  const div = Math.max(1, Math.min(4, 4 - Math.floor((mmr - base) / step)));
  return { tier, div, label: `${tier} ${div}` };
}
/** Elo: K=40 первые 20 игр (калибровка), затем 24; бонус серии +4 за 3+ побед подряд (не ниже Алмаза). */
function applyElo(winner: string, loser: string): { dW: number; dL: number } {
  const w = ratingOf(winner), l = ratingOf(loser);
  const exp = 1 / (1 + 10 ** ((l.mmr - w.mmr) / 400));
  const kW = w.games < 20 ? 40 : 24, kL = l.games < 20 ? 40 : 24;
  w.streak = Math.max(0, w.streak) + 1; l.streak = Math.min(0, l.streak) - 1;
  const bonus = w.streak >= 3 && w.mmr < 1700 ? 4 : 0;
  const dW = Math.max(1, Math.round(kW * (1 - exp))) + bonus;
  const dL = -Math.max(1, Math.round(kL * (1 - exp)));
  w.mmr += dW; l.mmr = Math.max(0, l.mmr + dL);
  w.games++; l.games++; w.wins++; l.losses++;
  w.peak = Math.max(w.peak, w.mmr);
  return { dW, dL };
}

/* ------------------------------ присутствие ------------------------------ */
type Status = 'online' | 'searching' | 'in_match' | 'offline';
const presence = new Map<string, { ts: number; status: Status }>();
const ONLINE_MS = 70_000;
export function touch(login: string, status?: Status): void {
  const p = presence.get(login);
  presence.set(login, { ts: Date.now(), status: status ?? (p && p.status !== 'offline' ? p.status : 'online') });
}
export function statusOf(login: string): Status {
  const p = presence.get(login);
  if (!p || Date.now() - p.ts > ONLINE_MS) return 'offline';
  return p.status;
}
export function presenceInfo(login: string): { status: Status; ts: number } | null {
  const p = presence.get(login);
  if (!p || Date.now() - p.ts > ONLINE_MS) return null;
  return { status: p.status, ts: p.ts };
}

/* ------------------------------ матчмейкинг ------------------------------ */
interface Ticket { login: string; pid: string; mode: 'ranked' | 'casual'; deckId: string; mmr: number; since: number }
const queue: Ticket[] = [];
interface Found { match: string; seat: 0 | 1; mode: 'ranked' | 'casual' | 'friendly'; opponent: string; ticket: string; ts: number }
const found = new Map<string, Found>();           // login → найденный матч (ждёт, пока клиент заберёт)
const liveMatches = new Map<string, { a: string; b: string; mode: string; ts: number }>();
/** Окно подбора по рейтингу растёт со временем ожидания: ±50 → до ±400 (рейтинг), обычный — ±1000. */
function windowOf(t: Ticket): number {
  const waited = (Date.now() - t.since) / 1000;
  return t.mode === 'ranked' ? Math.min(400, 50 + waited * 10) : 1000;
}
function makeMatch(a: { login: string; pid: string; deckId: string }, b: { login: string; pid: string; deckId: string }, mode: Found['mode']): void {
  const match = randomBytes(10).toString('hex');
  const seatA: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  const seatB: 0 | 1 = seatA === 0 ? 1 : 0;
  found.set(a.login, { match, seat: seatA, mode, opponent: b.login, ts: Date.now(),
    ticket: issueMatchTicket({ sub: a.login, pid: a.pid, match, seat: seatA, mode, deckId: a.deckId }) });
  found.set(b.login, { match, seat: seatB, mode, opponent: a.login, ts: Date.now(),
    ticket: issueMatchTicket({ sub: b.login, pid: b.pid, match, seat: seatB, mode, deckId: b.deckId }) });
  liveMatches.set(match, { a: a.login, b: b.login, mode, ts: Date.now() });
  touch(a.login, 'in_match'); touch(b.login, 'in_match');
}
export function pairQueue(): void {
  queue.sort((x, y) => x.since - y.since);
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    let best = -1, bestD = Infinity;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (b.mode !== a.mode) continue;
      const d = Math.abs(a.mmr - b.mmr);
      if (d <= Math.min(windowOf(a), windowOf(b)) && d < bestD) { best = j; bestD = d; }
    }
    if (best >= 0) {
      const b = queue[best];
      queue.splice(best, 1); queue.splice(i, 1); i--;
      makeMatch(a, b, a.mode);
    }
  }
  // чистка: протухшие найденные матчи (клиент не забрал за 2 мин) и зависшие live-матчи (>2 ч)
  const now = Date.now();
  for (const [k, f] of found) if (now - f.ts > 120_000) found.delete(k);
  for (const [k, m] of liveMatches) if (now - m.ts > 2 * 3600_000) liveMatches.delete(k);
}
setInterval(pairQueue, 1000).unref?.();

/* ------------------------------ вызовы друзей ------------------------------ */
interface Challenge { id: string; from: string; to: string; fromPid: string; fromDeck: string; ts: number }
const challenges = new Map<string, Challenge>();

/* ------------------------------ helpers ------------------------------ */
function friendsOf(login: string): string[] { return st.friends[login] ?? (st.friends[login] = []); }
function card(ctx: SocialCtx, login: string): Record<string, unknown> {
  const r = ratingOf(login); const p = ctx.profileOf(login) ?? {};
  return { login, nick: p.nick ?? login, avatarFac: p.avatarFac ?? 'Aurites', frame: p.frame ?? 'bronze',
    status: statusOf(login), lastSeen: presence.get(login)?.ts ?? 0, mmr: r.mmr, rank: rankOf(r.mmr).label, wins: r.wins, losses: r.losses };
}

/* ------------------------------ роутер ------------------------------ */
export async function handleSocial(req: IncomingMessage, res: ServerResponse, path: string, url: string, ctx: SocialCtx): Promise<boolean> {
  const { json } = ctx;
  const isSocial = path.startsWith('/api/friends') || path.startsWith('/api/mm/') || path.startsWith('/api/presence')
    || path.startsWith('/api/users/') || path.startsWith('/api/rating') || path === '/api/leaderboard'
    || path.startsWith('/api/challenge') || path.startsWith('/api/internal/');
  if (!isSocial) return false;

  /* ---- server→server: итог матча от match-server ---- */
  if (req.method === 'POST' && path === '/api/internal/match-result') {
    if (req.headers['x-internal-key'] !== INTERNAL_KEY) { json(res, 403, { error: 'forbidden' }); return true; }
    const b = await ctx.readBody(req);
    const m = liveMatches.get(String(b.match ?? ''));
    if (!m) { json(res, 404, { error: 'match not found' }); return true; }
    liveMatches.delete(String(b.match));
    const winner = b.winner === m.a || b.winner === m.b ? String(b.winner) : null;   // null — ничья/техническая
    let dA = 0, dB = 0;
    if (m.mode === 'ranked' && winner) {
      const loser = winner === m.a ? m.b : m.a;
      const d = applyElo(winner, loser);
      dA = winner === m.a ? d.dW : d.dL; dB = winner === m.b ? d.dW : d.dL;
    }
    st.history.unshift({ id: String(b.match), mode: m.mode, a: m.a, b: m.b, winner, dA, dB, ts: Date.now() });
    st.history.length = Math.min(st.history.length, 2000);
    touch(m.a, 'online'); touch(m.b, 'online');
    save();
    json(res, 200, { ok: true, dA, dB });
    return true;
  }

  /* ---- публичное: таблица лидеров ---- */
  if (req.method === 'GET' && path === '/api/leaderboard') {
    const top = Object.entries(st.ratings).filter(([, r]) => r.season === SEASON && r.games > 0)
      .sort((x, y) => y[1].mmr - x[1].mmr).slice(0, 100)
      .map(([login, r], i) => ({ place: i + 1, ...card(ctx, login), games: r.games, peak: r.peak }));
    json(res, 200, { season: SEASON, top });
    return true;
  }

  const me = bearer(req.headers.authorization) as AccessClaims | null | undefined;
  if (!me) { json(res, 401, { error: 'Войдите в аккаунт, чтобы играть онлайн', code: 'auth_required' }); return true; }
  const login = me.sub;
  touch(login);

  if (req.method === 'POST' && path === '/api/presence') {
    const b = await ctx.readBody(req);
    const s = String(b.status ?? 'online');
    touch(login, (['online', 'in_match', 'offline'].includes(s) ? s : 'online') as Status);  // offline — закрыл игру/вышел
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && path === '/api/rating/me') {
    const r = ratingOf(login);
    const hist = st.history.filter(h => h.a === login || h.b === login).slice(0, 20).map(h => ({
      id: h.id, mode: h.mode, opponent: h.a === login ? h.b : h.a,
      result: h.winner == null ? 'draw' : h.winner === login ? 'win' : 'loss', delta: h.a === login ? h.dA : h.dB, ts: h.ts }));
    const place = Object.values(st.ratings).filter(x => x.season === SEASON && x.games > 0 && x.mmr > r.mmr).length + 1;
    json(res, 200, { ...r, rank: rankOf(r.mmr), place: r.games ? place : null, history: hist });
    return true;
  }

  /* ---- поиск игроков ---- */
  if (req.method === 'GET' && path === '/api/users/search') {
    const q = (new URLSearchParams(url.split('?')[1] ?? '').get('q') ?? '').trim().toLowerCase();
    if (q.length < 2) { json(res, 200, { users: [] }); return true; }
    const mine = new Set(friendsOf(login));
    const users = ctx.allLogins().filter(l => l !== login && (l.includes(q) || (ctx.profileOf(l)?.nick ?? '').toLowerCase().includes(q)))
      .slice(0, 20).map(l => ({ ...card(ctx, l), friend: mine.has(l),
        pending: st.requests.some(r => (r.from === login && r.to === l) || (r.from === l && r.to === login)) }));
    json(res, 200, { users });
    return true;
  }

  /* ---- друзья ---- */
  if (req.method === 'GET' && path === '/api/friends') {
    const list = friendsOf(login).map(l => card(ctx, l))
      .sort((a, b) => Number(b.status !== 'offline') - Number(a.status !== 'offline') || String(a.nick).localeCompare(String(b.nick)));
    json(res, 200, {
      friends: list,
      incoming: st.requests.filter(r => r.to === login).map(r => ({ ...card(ctx, r.from), ts: r.ts })),
      outgoing: st.requests.filter(r => r.from === login).map(r => ({ ...card(ctx, r.to), ts: r.ts })),
      challenges: [...challenges.values()].filter(c => c.to === login && Date.now() - c.ts < 120_000)
        .map(c => ({ id: c.id, ...card(ctx, c.from), ts: c.ts })),
    });
    return true;
  }
  if (req.method === 'POST' && path === '/api/friends/request') {
    const b = await ctx.readBody(req);
    const to = ctx.findLogin(String(b.to ?? ''));
    if (!to) { json(res, 404, { error: 'Игрок не найден' }); return true; }
    if (to === login) { json(res, 400, { error: 'Нельзя добавить себя' }); return true; }
    if (friendsOf(login).includes(to)) { json(res, 409, { error: 'Уже в друзьях' }); return true; }
    if (friendsOf(login).length >= MAX_FRIENDS) { json(res, 400, { error: `Лимит друзей: ${MAX_FRIENDS}` }); return true; }
    // встречная заявка → сразу дружба
    const back = st.requests.findIndex(r => r.from === to && r.to === login);
    if (back >= 0) {
      st.requests.splice(back, 1);
      friendsOf(login).push(to); friendsOf(to).push(login); save();
      json(res, 200, { ok: true, friends: true }); return true;
    }
    if (st.requests.some(r => r.from === login && r.to === to)) { json(res, 409, { error: 'Заявка уже отправлена' }); return true; }
    if (st.requests.filter(r => r.from === login).length >= 50) { json(res, 429, { error: 'Слишком много исходящих заявок' }); return true; }
    st.requests.push({ from: login, to, ts: Date.now() }); save();
    json(res, 200, { ok: true, pending: true });
    return true;
  }
  if (req.method === 'POST' && (path === '/api/friends/accept' || path === '/api/friends/decline')) {
    const b = await ctx.readBody(req);
    const from = ctx.findLogin(String(b.from ?? '')) ?? '';
    const i = st.requests.findIndex(r => r.from === from && r.to === login);
    if (i < 0) { json(res, 404, { error: 'Заявка не найдена' }); return true; }
    st.requests.splice(i, 1);
    if (path.endsWith('accept') && !friendsOf(login).includes(from)) { friendsOf(login).push(from); friendsOf(from).push(login); }
    save(); json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && path === '/api/friends/cancel') {
    const b = await ctx.readBody(req);
    const to = ctx.findLogin(String(b.to ?? '')) ?? '';
    st.requests = st.requests.filter(r => !(r.from === login && r.to === to)); save();
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && path === '/api/friends/remove') {
    const b = await ctx.readBody(req);
    const who = ctx.findLogin(String(b.login ?? '')) ?? '';
    st.friends[login] = friendsOf(login).filter(x => x !== who);
    st.friends[who] = friendsOf(who).filter(x => x !== login);
    save(); json(res, 200, { ok: true });
    return true;
  }

  /* ---- вызов друга на дружеский матч (без рейтинга) ---- */
  if (req.method === 'POST' && path === '/api/challenge') {
    const b = await ctx.readBody(req);
    const to = ctx.findLogin(String(b.to ?? ''));
    if (!to || !friendsOf(login).includes(to)) { json(res, 403, { error: 'Вызвать можно только друга' }); return true; }
    if (statusOf(to) === 'offline') { json(res, 409, { error: 'Друг не в сети' }); return true; }
    if (statusOf(to) === 'in_match') { json(res, 409, { error: 'Друг сейчас в матче' }); return true; }
    const id = randomBytes(8).toString('hex');
    challenges.set(id, { id, from: login, to, fromPid: me.pid, fromDeck: String(b.deckId ?? ''), ts: Date.now() });
    json(res, 200, { ok: true, id });
    return true;
  }
  if (req.method === 'POST' && (path === '/api/challenge/accept' || path === '/api/challenge/decline')) {
    const b = await ctx.readBody(req);
    const c = challenges.get(String(b.id ?? ''));
    if (!c || c.to !== login || Date.now() - c.ts > 120_000) { json(res, 404, { error: 'Вызов истёк' }); return true; }
    challenges.delete(c.id);
    if (path.endsWith('accept')) makeMatch({ login: c.from, pid: c.fromPid, deckId: c.fromDeck }, { login, pid: me.pid, deckId: String(b.deckId ?? '') }, 'friendly');
    json(res, 200, { ok: true });
    return true;
  }

  /* ---- очередь ---- */
  if (req.method === 'POST' && path === '/api/mm/queue') {
    const b = await ctx.readBody(req);
    const mode = b.mode === 'casual' ? 'casual' : 'ranked';
    if (found.has(login)) { json(res, 409, { error: 'Матч уже найден' }); return true; }
    const idx = queue.findIndex(t => t.login === login);
    if (idx >= 0) queue.splice(idx, 1);
    queue.push({ login, pid: me.pid, mode, deckId: String(b.deckId ?? ''), mmr: ratingOf(login).mmr, since: Date.now() });
    touch(login, 'searching');
    pairQueue();
    json(res, 200, { ok: true, state: found.has(login) ? 'found' : 'searching' });
    return true;
  }
  if (req.method === 'POST' && path === '/api/mm/cancel') {
    const idx = queue.findIndex(t => t.login === login);
    if (idx >= 0) queue.splice(idx, 1);
    touch(login, 'online');
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && path === '/api/mm/status') {
    const f = found.get(login);
    if (f) {
      found.delete(login);   // билет отдаётся один раз
      json(res, 200, { state: 'found', match: f.match, seat: f.seat, mode: f.mode, ticket: f.ticket,
        opponent: card(ctx, f.opponent),
        /* v3.16: адрес шарда матч-тиера (если задан MATCH_SHARDS) — клиент идёт туда напрямую */
        wsUrl: wsUrlFor(f.match) });
      return true;
    }
    const t = queue.find(x => x.login === login);
    if (!t) { json(res, 200, { state: 'idle' }); return true; }
    json(res, 200, { state: 'searching', mode: t.mode, waited: Math.round((Date.now() - t.since) / 1000),
      window: Math.round(windowOf(t)), inQueue: queue.filter(x => x.mode === t.mode).length });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
