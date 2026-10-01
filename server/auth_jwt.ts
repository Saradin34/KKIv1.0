/* =====================================================================
   Собственная JWT-авторизация (без внешних зависимостей, HS256 на node:crypto).
   - access-токен: короткий (по умолчанию 15 мин), в заголовке Authorization: Bearer …
   - refresh-токен: длинный (30 дней), одноразовый (ротация), с jti — отзывается
     при logout и при повторном использовании (защита от кражи refresh-токена).
   Секрет: env JWT_SECRET (обязательно в проде, ≥32 символа); иначе генерируется
   и сохраняется в server/data/jwt_secret (только для локальной разработки).
   ===================================================================== */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface AccessClaims { sub: string; pid: string; typ: 'access'; iat: number; exp: number; iss: string }
export interface RefreshClaims { sub: string; pid: string; typ: 'refresh'; jti: string; iat: number; exp: number; iss: string }
type Claims = AccessClaims | RefreshClaims | { typ: 'match'; exp: number; iss: string };

export const ACCESS_TTL_SEC = Number(process.env.JWT_ACCESS_TTL || 15 * 60);
export const REFRESH_TTL_SEC = Number(process.env.JWT_REFRESH_TTL || 30 * 24 * 3600);
const ISS = 'echo-citadel';

function loadSecret(): Buffer {
  const env = process.env.JWT_SECRET;
  if (env) {
    if (env.length < 32) console.warn('[auth] JWT_SECRET короче 32 символов — небезопасно');
    return Buffer.from(env, 'utf8');
  }
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET обязателен в production');
  const dir = join(process.cwd(), 'server', 'data');
  const f = join(dir, 'jwt_secret');
  try { if (existsSync(f)) return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex'); } catch { /* сгенерируем */ }
  const s = randomBytes(48);
  try { mkdirSync(dir, { recursive: true }); writeFileSync(f, s.toString('hex'), { mode: 0o600 }); } catch { /* read-only fs */ }
  console.warn('[auth] JWT_SECRET не задан — сгенерирован dev-секрет в server/data/jwt_secret');
  return s;
}
const SECRET = loadSecret();

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const HEADER = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const sig = (data: string): Buffer => createHmac('sha256', SECRET).update(data).digest();

export function sign(payload: object): string {
  const body = `${HEADER}.${b64u(JSON.stringify(payload))}`;
  return `${body}.${sig(body).toString('base64url')}`;
}

/** Проверка подписи/алгоритма/срока/issuer. null — токен недействителен. */
export function verify<T extends Claims>(token: string, typ: T['typ']): T | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const hdr = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    if (hdr.alg !== 'HS256') return null;                       // запрет alg:none / подмены алгоритма
    const want = sig(`${h}.${p}`);
    const got = Buffer.from(s, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as T;
    const now = Math.floor(Date.now() / 1000);
    if (c.typ !== typ || c.iss !== ISS || typeof c.exp !== 'number' || c.exp <= now) return null;
    return c;
  } catch { return null; }
}

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; refreshJti: string; refreshExp: number }

export function issueTokens(login: string, pid: string): TokenPair {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomBytes(16).toString('hex');
  const accessToken = sign({ sub: login, pid, typ: 'access', iat: now, exp: now + ACCESS_TTL_SEC, iss: ISS });
  const refreshExp = now + REFRESH_TTL_SEC;
  const refreshToken = sign({ sub: login, pid, typ: 'refresh', jti, iat: now, exp: refreshExp, iss: ISS });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC, refreshJti: jti, refreshExp: refreshExp * 1000 };
}

/** Достаёт access-claims из заголовка Authorization: Bearer <jwt>. */
export function bearer(authHeader: string | undefined): AccessClaims | null | undefined {
  if (!authHeader) return undefined;                           // заголовка нет
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  return verify<AccessClaims>(m[1], 'access');                  // null — есть, но невалиден
}

/* ---- Билет на матч: meta-server выдаёт, match-server проверяет (общий секрет) ---- */
export interface MatchTicket { sub: string; pid: string; typ: 'match'; match: string; seat: 0 | 1; mode: 'ranked' | 'casual' | 'friendly'; deckId: string; iat: number; exp: number; iss: string }
export function issueMatchTicket(t: Omit<MatchTicket, 'typ' | 'iat' | 'exp' | 'iss'>): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ ...t, typ: 'match', iat: now, exp: now + 5 * 60, iss: ISS });
}
export function verifyMatchTicket(token: string): MatchTicket | null {
  return verify<MatchTicket & { typ: 'match' }>(token, 'match' as never) as MatchTicket | null;
}
/** Ключ для server→server вызовов (match-server → meta-server). env INTERNAL_KEY или производный от секрета. */
export const INTERNAL_KEY = process.env.INTERNAL_KEY || createHmac('sha256', SECRET).update('internal').digest('hex');
