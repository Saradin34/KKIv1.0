/* Автономный матч-сервер (порт 8080). Та же логика встроена в meta-server по пути /match —
   достаточно запустить только npm run server:meta. */
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { attachMatchRelay, matchRoomsCount } from './match_relay';
const http = createServer((req, res) => {
  const cors: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: matchRoomsCount() }));
    return;
  }
  // совместимость: заявка PvE-матча для телеметрии/реплеев
  if (req.url === '/api/match/start' && req.method === 'POST') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, match_id: randomUUID(), seed: Math.floor(Math.random() * 2147483647) }));
    return;
  }
  res.writeHead(404, cors); res.end();
});
attachMatchRelay(http, null);
const PORT = Number(process.env.PORT || 8080);
http.listen(PORT, '0.0.0.0', () => console.log(`[match-server] ws://0.0.0.0:${PORT}`));
