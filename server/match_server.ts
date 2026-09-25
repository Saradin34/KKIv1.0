/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — матч-сервер PvP (WebSocket), скелет v1
   ---------------------------------------------------------------------
   Движок (src/engine) платформо-независимый и синхронный: сервер держит
   по инстансу Engine на матч и является ЕДИНСТВЕННЫМ источником истины.
   Клиенты шлют намерения, сервер валидирует их engine.canPlay() и
   рассылает обоим игрокам поток GameEvent (onEvent).
   Протокол (JSON):
     → {t:'join',  match, seat:0|1, deck:string[]}
     → {t:'act',   action: {kind:'mulligan', keep:number[]}
                        | {kind:'play', handIndex, targetUid?, targetSide?}
                        | {kind:'endMain'} | {kind:'endTurn'} | {kind:'runTurn'}}
     ← {t:'event', e:GameEvent} | {t:'state', snapshot} | {t:'err', msg}
   Масштабирование (docs/DEPLOYMENT.md §4): состояние матча живёт в памяти
   процесса; при росте — Redis (ioredis) для снапшотов + pub/sub для роуминга
   сокетов между нодами (sticky sessions на LB).
   Запуск: npm run server:match  (PORT=8080)
   ===================================================================== */
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { buildDatabase, CardsFile, DeckFile } from '../src/engine/db';
import { GameEngine } from '../src/engine/engine';
import { GameEvent, Side } from '../src/engine/types';
import cardsRaw from '../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';
import decksRaw from '../unity/EchoCitadel/Assets/StreamingAssets/Decks.json';

const { db } = buildDatabase(cardsRaw as unknown as CardsFile);
const baseDecks = (decksRaw as unknown as DeckFile).decks;

interface Room {
  engine: GameEngine;
  seats: [WebSocket | null, WebSocket | null];
  decks: [string[] | null, string[] | null];
  started: boolean;
}
const rooms = new Map<string, Room>();

function roomOf(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    r = { engine: null as unknown as GameEngine, seats: [null, null], decks: [null, null], started: false };
    rooms.set(id, r);
  }
  return r;
}
function broadcast(r: Room, e: GameEvent): void {
  const msg = JSON.stringify({ t: 'event', e });
  for (const ws of r.seats) if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
}

/* REST-ручки (спека «1. Главное меню» п.1.4): создание матча по запросу клиента.
   PvE-бой прототип ведёт локально; match_id используется для телеметрии/реплеев.
   Карта pending — лёгкая заявка матча (seed+параметры), TTL чистится по размеру. */
interface PendingMatch { seed: number; ts: number; params: Record<string, unknown> }
const pendingMatches = new Map<string, PendingMatch>();

const http = createServer((req, res) => {
  const cors: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, pending: pendingMatches.size }));
    return;
  }
  if (req.url === '/api/match/start' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>; } catch { /* невалидный JSON — пустые параметры */ }
      const matchId = randomUUID();
      const seed = Math.floor(Math.random() * 2147483647);
      pendingMatches.set(matchId, { seed, ts: Date.now(), params });
      if (pendingMatches.size > 512) {
        const oldest = pendingMatches.keys().next().value as string | undefined;
        if (oldest) pendingMatches.delete(oldest);
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, match_id: matchId, seed }));
    });
    return;
  }
  res.writeHead(404, cors); res.end();
});
const wss = new WebSocketServer({ server: http });

wss.on('connection', ws => {
  let myRoom: Room | null = null;
  let mySeat: Side = Side.Player;

  ws.on('message', raw => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { ws.send(JSON.stringify({ t: 'err', msg: 'bad json' })); return; }
    if (m.t === 'join') {
      myRoom = roomOf(String(m.match || 'default'));
      mySeat = (m.seat === 1 ? Side.Opponent : Side.Player);
      myRoom.seats[mySeat] = ws;
      const deck = Array.isArray(m.deck) ? m.deck : baseDecks.find(d => d.id === m.deckId)?.cards;
      if (deck) myRoom.decks[mySeat] = deck;
      const other = myRoom.decks[mySeat === Side.Player ? Side.Opponent : Side.Player];
      if (!myRoom.started && myRoom.decks[0] && myRoom.decks[1] && other) {
        myRoom.engine = new GameEngine(db, [myRoom.decks[0], myRoom.decks[1]], {
          onEvent: e => broadcast(myRoom as Room, e),
        });
        myRoom.engine.setup();
        myRoom.started = true;
        broadcast(myRoom, { type: 'GameStarted', turn: 0, text: 'Матч начался' } as unknown as GameEvent);
      }
      ws.send(JSON.stringify({ t: 'joined', seat: mySeat, started: myRoom.started }));
      return;
    }
    if (m.t !== 'act' || !myRoom || !myRoom.started) return;
    const e = myRoom.engine;
    const a = m.action ?? {};
    let ok = false;
    try {
      switch (a.kind) {
        case 'mulligan': e.mulligan(mySeat, a.keep ?? []); ok = true; break;
        case 'play': {
          const chk = e.canPlay(mySeat, a.handIndex);
          ok = chk.ok && e.playCard(mySeat, a.handIndex, a.targetUid, a.targetSide);
          if (!chk.ok) ws.send(JSON.stringify({ t: 'err', msg: chk.reason }));
          break;
        }
        case 'endMain': e.finishMainPhase(); ok = true; break;
        case 'runTurn': e.runTurn(); ok = true; break;
        case 'endTurn': e.closeInstantWindow(); e.finishMainPhase(); ok = true; break;
        default: ws.send(JSON.stringify({ t: 'err', msg: 'unknown action' }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ t: 'err', msg: String(err) }));
    }
    if (ok) ws.send(JSON.stringify({ t: 'ack' }));
  });

  ws.on('close', () => {
    if (myRoom) {
      myRoom.seats[mySeat] = null;
      broadcast(myRoom, { type: 'TurnEnded', turn: -1, text: 'Игрок отключился' } as unknown as GameEvent);
    }
  });
});

const PORT = Number(process.env.PORT || 8080);
http.listen(PORT, '0.0.0.0', () => console.log(`[match-server] ws://0.0.0.0:${PORT}`));
