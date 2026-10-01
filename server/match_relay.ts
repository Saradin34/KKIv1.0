/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — матч-сервер PvP (WebSocket) v3.4
   ---------------------------------------------------------------------
   Вход — только по билету meta-server (JWT typ=match, общий JWT_SECRET):
   билет определяет матч, место (seat 0/1), режим и логин игрока.

   Модель синхронизации (docs/ONLINE_SPEC.md §6):
   · seat 0 создаёт стартовое состояние партии и ходит первым;
   · в свой ход игрок — источник истины: шлёт действие + снимок состояния,
     сервер ретранслирует сопернику, тот проигрывает анимацию и накладывает снимок;
   · итог: оба клиента присылают {t:'result'}; совпало — засчитывается,
     разошлось — матч без рейтинга; сдача/обрыв >60 с — поражение.

   Протокол (JSON):
     → {t:'join', ticket, deck:string[], faction, name}
     → {t:'net', m:{…}}              ретрансляция сопернику
     → {t:'result', winnerSeat}      отчёт клиента об итоге
     → {t:'concede'}
     ← {t:'joined', seat, waiting}
     ← {t:'start', seat, mode, you:{…}, opp:{…}, resume?}
     ← {t:'net', m} · {t:'oppLeft'} · {t:'oppBack'} · {t:'over', winnerSeat, reason} · {t:'err', msg}
   Запуск: npm run server:match  (PORT=8080, META_URL=http://127.0.0.1:8081)
   ===================================================================== */
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { buildDatabase, CardsFile, validateDeck } from '../src/engine/db';
import cardsRaw from '../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';
import { verifyMatchTicket, INTERNAL_KEY, MatchTicket } from './auth_jwt';

const { db } = buildDatabase(cardsRaw as unknown as CardsFile);
const META_URL = process.env.META_URL || 'http://127.0.0.1:8081';
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60_000);
const RESULT_WAIT_MS = 15_000;

interface SeatInfo { login: string; deck: string[]; faction: string; name: string }
interface Room {
  id: string; mode: string;
  seats: [WebSocket | null, WebSocket | null];
  info: [SeatInfo | null, SeatInfo | null];
  started: boolean; over: boolean;
  results: [number | null | undefined, number | null | undefined];   // undefined — ещё не прислал
  resultTimer: NodeJS.Timeout | null;
  dropTimers: [NodeJS.Timeout | null, NodeJS.Timeout | null];
  created: number;
}
const rooms = new Map<string, Room>();
function roomOf(id: string, mode: string): Room {
  let r = rooms.get(id);
  if (!r) {
    r = { id, mode, seats: [null, null], info: [null, null], started: false, over: false,
      results: [undefined, undefined], resultTimer: null, dropTimers: [null, null], created: Date.now() };
    rooms.set(id, r);
  }
  return r;
}
const send = (ws: WebSocket | null, m: unknown): void => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

async function finish(r: Room, winnerSeat: 0 | 1 | null, reason: string): Promise<void> {
  if (r.over) return;
  r.over = true;
  if (r.resultTimer) clearTimeout(r.resultTimer);
  for (const t of r.dropTimers) if (t) clearTimeout(t);
  for (const ws of r.seats) send(ws, { t: 'over', winnerSeat, reason });
  const winner = winnerSeat == null ? null : r.info[winnerSeat]?.login ?? null;
  if (r.info[0] && r.info[1]) {
    try {
      await fetch(`${META_URL}/api/internal/match-result`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
        body: JSON.stringify({ match: r.id, winner, reason }),
      });
    } catch (e) { console.error('[match-server] report:', (e as Error).message); }
  }
  setTimeout(() => rooms.delete(r.id), 30_000);
}
function startIfReady(r: Room, resumeSeat?: 0 | 1): void {
  if (!r.info[0] || !r.info[1] || !r.seats[0] || !r.seats[1]) return;
  const payload = (seat: 0 | 1, resume: boolean) => ({
    t: 'start', seat, mode: r.mode, match: r.id, resume,
    you: r.info[seat], opp: { ...r.info[seat === 0 ? 1 : 0]!, deck: r.info[seat === 0 ? 1 : 0]!.deck },
  });
  if (!r.started) {
    r.started = true;
    send(r.seats[0], payload(0, false));
    send(r.seats[1], payload(1, false));
  } else if (resumeSeat !== undefined) {
    send(r.seats[resumeSeat], payload(resumeSeat, true));
    // вернувшемуся нужен актуальный снимок — его пришлёт соперник
    send(r.seats[resumeSeat === 0 ? 1 : 0], { t: 'net', m: { k: 'needSync' } });
    send(r.seats[resumeSeat === 0 ? 1 : 0], { t: 'oppBack' });
  }
}

/* v3.16: maxPayload 64 КБ — снимок ходов ~1–4 КБ, 512 КБ было просто DoS-размахом. */
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
/** Подключить PvP-ретранслятор к любому HTTP-серверу. path=null — принимать апгрейд на любом пути. */
export function attachMatchRelay(server: Server, path: string | null = '/match'): void {
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url ?? '/').split('?')[0];
    if (path && p !== path) return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
}
export function matchRoomsCount(): number { return rooms.size; }

wss.on('connection', ws => {
  let room: Room | null = null;
  let seat: 0 | 1 = 0;
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 15_000);
  /* v3.16: rate-limit сообщений на соединение (token bucket: 20/с, burst 40).
     Игровой трафик ~1–5 msg/с; выше — флуд/атака → отключаем. */
  let rlN = 0; let rlT = Date.now();
  ws.on('message', raw => {
    const now = Date.now();
    if (now - rlT > 1000) { rlT = now; rlN = 0; }
    if (++rlN > 40) { ws.close(1008, 'rate limit'); return; }
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { send(ws, { t: 'err', msg: 'bad json' }); return; }

    if (m.t === 'join') {
      const tk: MatchTicket | null = verifyMatchTicket(String(m.ticket ?? ''));
      if (!tk) { send(ws, { t: 'err', msg: 'нужен действительный билет матча' }); ws.close(); return; }
      const r = roomOf(tk.match, tk.mode);
      if (r.over) { send(ws, { t: 'err', msg: 'матч уже завершён' }); ws.close(); return; }
      const cur = r.info[tk.seat];
      if (cur && cur.login !== tk.sub) { send(ws, { t: 'err', msg: 'место занято другим игроком' }); ws.close(); return; }
      if (!cur) {
        const deck = Array.isArray(m.deck) ? (m.deck as unknown[]).filter(x => typeof x === 'string') as string[] : [];
        const problems = validateDeck(deck, db);
        if (problems.length) { send(ws, { t: 'err', msg: `колода невалидна: ${problems[0]}` }); ws.close(); return; }
        r.info[tk.seat] = { login: tk.sub, deck, faction: String(m.faction ?? 'Aurites'), name: String(m.name ?? tk.sub).slice(0, 24) };
      }
      const prev = r.seats[tk.seat];
      if (prev && prev !== ws) prev.close();
      const dt = r.dropTimers[tk.seat];
      if (dt) { clearTimeout(dt); r.dropTimers[tk.seat] = null; }
      r.seats[tk.seat] = ws;
      room = r; seat = tk.seat;
      send(ws, { t: 'joined', seat, waiting: !r.seats[seat === 0 ? 1 : 0] });
      startIfReady(r, r.started ? seat : undefined);
      return;
    }
    if (!room || room.seats[seat] !== ws) return;
    const other = room.seats[seat === 0 ? 1 : 0];

    if (m.t === 'net') {
      if (room.over) return;
      send(other, { t: 'net', m: m.m });
      return;
    }
    if (m.t === 'concede') { void finish(room, seat === 0 ? 1 : 0, 'concede'); return; }
    if (m.t === 'result') {
      if (room.over) return;
      const w = m.winnerSeat === 0 || m.winnerSeat === 1 ? m.winnerSeat : null;
      room.results[seat] = w;
      const [a, b] = room.results;
      if (a !== undefined && b !== undefined) {
        void finish(room, a === b ? (a as 0 | 1 | null) : null, a === b ? 'game' : 'mismatch');
      } else if (!room.resultTimer) {
        const r = room;
        r.resultTimer = setTimeout(() => {   // второй клиент молчит — принимаем единственный отчёт
          const one = r.results[0] !== undefined ? r.results[0] : r.results[1];
          void finish(r, (one ?? null) as 0 | 1 | null, 'single-report');
        }, RESULT_WAIT_MS);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (!room || room.seats[seat] !== ws) return;
    const r = room, s = seat;
    r.seats[s] = null;
    if (r.over) return;
    send(r.seats[s === 0 ? 1 : 0], { t: 'oppLeft', graceSec: Math.round(RECONNECT_GRACE_MS / 1000) });
    r.dropTimers[s] = setTimeout(() => {
      if (r.seats[s]) return;
      void finish(r, r.started ? (s === 0 ? 1 : 0) : null, 'disconnect');
    }, RECONNECT_GRACE_MS);
  });
});

// чистка брошенных комнат (никто не пришёл за 10 мин)
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (!r.started && now - r.created > 600_000) rooms.delete(id);
}, 60_000).unref?.();
