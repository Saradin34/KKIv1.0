#!/usr/bin/env node
/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — нагрузочный тест «10 000+ пользователей» (v3.16)
   ---------------------------------------------------------------------
   Запускается ПРОТИВ отдельного инстанса meta-server (не трогаем боевой):

     mkdir -p /tmp/kki-load && cd /tmp/kki-load
     RATE_LIMIT=0 PORT=8090 node /home/user/KKIv1.0/build/meta_server.js &
     node tools/load/load10k.mjs        # настройки через env LOAD_*

   Фазы:
     A. REST: 10 000 виртуальных игроков (guest-пиды — как гостевая игра)
        синхронизируют профиль (POST /api/profile, дельт-тело ~2 КБ) + читают
        /api/leaderboard, /api/profile; пул авторизованных жмёт /api/friends,
        /api/presence. Длительность и параллельность — env.
     B. WS: N одновременных WebSocket-соединений на /match
        (верхняя граница: в игре WS живут только во время матча).
     C. РЕАЛЬНЫЕ матчи: очередь → билет → WS join → ходы → результат → elo,
        раундами по ~50 параллельных матчей.
   Метрики: req/s, p50/p95/p99, ошибки, память.
   ===================================================================== */
import http from 'http';
import { readFileSync, readdirSync } from 'fs';
import { WebSocket } from 'ws';

const PORT = Number(process.env.LOAD_PORT || 8090);
const WSURL = `ws://127.0.0.1:${PORT}/match`;
const N_USERS = Number(process.env.LOAD_USERS || 10_000);
const CONC = Number(process.env.LOAD_CONC || 200);
const DUR_MS = Number(process.env.LOAD_DUR || 30_000);
const WS_N = Number(process.env.LOAD_WS || 10_000);
const MATCHES = Number(process.env.LOAD_MATCHES || 500);
const ACCOUNTS = Number(process.env.LOAD_ACCT || 100);
const PW = 'loadpass123';

/* ---------- валидная колода 60 карт (≤4 копии карты) ---------- */
const cards = JSON.parse(readFileSync('/home/user/KKIv1.0/unity/EchoCitadel/Assets/StreamingAssets/Cards.json', 'utf8'));
const cardList = (cards.cards ?? cards).filter(c => c && typeof c.id === 'string');
const deck = [];
for (const c of cardList) while (deck.filter(x => x === c.id).length < 4 && deck.length < 60) deck.push(c.id);
while (deck.length < 60) deck.push(cardList[deck.length % cardList.length].id);

/* ---------- реалистичное дельт-тело синка профиля (~2 КБ) ---------- */
function profileBody(pid, nick, shards, dShards) {
  return JSON.stringify({
    pid, nick, level: 3, xp: 1450, bestMmr: 1250,
    mmr: 1200, dMmr: 0, wins: 12, dWins: 0, losses: 8, dLosses: 0,
    avatarFac: 'Aurites', frame: 'bronze', ach: { w1: true, w2: false },
    shards, dShards, gems: 100, dGems: 0, freeOpens: 1, dFreeOpens: 0,
    bundles: [], bpXp: 40, dBpXp: 0, bpPremium: false, bpClaimed: [1, 2], bpClaimedP: [],
    foilTokens: 2, premOpens: 1, avatarsOwned: ['a1'], tutStage: 5, tutDone: true,
    tutReward: 'Aurites', tutClaims: ['final'],
    cosmetics: { backs: ['b1'], tables: ['t1'], runes: ['r1'], backEq: 'classic', tableSkin: 'classic', runeSkin: 'classic' },
    questDate: '2026-09-29', wquestWeek: '2026-W39',
    quests: { daily: [1, 2, 3, 4, 5].map(i => ({ id: 'd' + i, prog: i, goal: 3, claimed: i < 2, fac: 'Aurites' })),
              weekly: [{ id: 'w1', prog: 2, goal: 3, claimed: false }] },
    history: [{ ts: Date.now() - 60_000, win: true, fac: 'Aurites', foe: 'X', turns: 14 }],
  });
}

/* ---------- raw http (keep-alive агент на потоке) ---------- */
function raw(method, path, body, tok, agent) {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, agent,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) } },
      rs => {
        let n = 0, x = '';
        rs.on('data', c => { n += c.length; if (x.length < 4096) x += c; });
        rs.on('end', () => resolve({ code: rs.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: n, body: x }));
      });
    r.on('error', e => resolve({ code: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: e.message }));
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

const stats = { n: 0, err: 0, lat: [], bytes: 0 };
const tick = (code, ms, bytes = 0) => { stats.n++; stats.bytes += bytes; if (code >= 400 || code === 0) stats.err++; if (ms < 5000) stats.lat.push(ms); };
function report(title) {
  const l = stats.lat.sort((a, b) => a - b);
  const p = q => l.length ? l[Math.min(l.length - 1, Math.floor(q * l.length))] : 0;
  console.log(`\n== ${title} ==`);
  console.log(`запросов: ${stats.n} · ошибок: ${stats.err} · трафик: ${(stats.bytes / 1e6).toFixed(1)} МБ`);
  console.log(`p50=${p(.5).toFixed(1)}ms p95=${p(.95).toFixed(1)}ms p99=${p(.99).toFixed(1)}ms · req/s=${(stats.n / (DUR_MS / 1000)).toFixed(0)}`);
  console.log(`heap клиента: ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} МБ`);
  stats.n = 0; stats.err = 0; stats.lat = [];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= ФАЗА A: REST, 10 000 виртуальных игроков ================= */
async function phaseA() {
  console.log(`\n--- ФАЗА A: REST, ${N_USERS} вирт.игроков, параллельность ${CONC}, ${DUR_MS / 1000}с ---`);
  // пул авторизованных аккаунтов (social-ручки требуют JWT)
  const auth = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 8 });
  for (let i = 0; i < ACCOUNTS; i++) {
    const login = `load${i}`;
    let r = await raw('POST', '/api/auth/register', JSON.stringify({ login, password: PW }), null, agent);
    if (r.code === 409) r = await raw('POST', '/api/auth/login', JSON.stringify({ login, password: PW }), null, agent);
    if (r.code === 200) { const j = JSON.parse(r.body); auth.push(j); }
  }
  console.log(`авторизован пул: ${auth.length}/${ACCOUNTS}`);

  /* Реалистичная модель: N_USERS виртуальных пользователей ОНЛАЙН всё окно DUR_MS,
     каждый шлёт ~1.1 req/s (дельта-синк профиля на каждое действие в игре + редкие
     чит-запросы). Клиентские соединения мультиплексируются: CLIENTS потоков,
     каждый ведёт VIRT вирт.пользователей (серверу всё равно, какой процесс шлёт
     запрос — нагрузка та же; а одноядерный node-клиент с 10k сокетами сам
     упирается в CPU и искажал бы замер латентности). Стартовые тайминги
     размазаны — как в жизни, когда игроки заходят постепенно. */
  const CLIENTS = Math.min(1000, N_USERS);
  const VIRT = Math.ceil(N_USERS / CLIENTS);
  const start = Date.now();
  const cpuBefore = serverCpu();
  async function worker(cid) {
    const myVirts = Array.from({ length: VIRT }, (_, v) => {
      const uid = cid * VIRT + v;
      return {
        uid,
        pid: `loadpid${uid.toString(36)}${(uid % 997).toString(36)}`,
        nick: `Player${uid}`,
        shards: 1000 + (uid % 500),
      };
    });
    for (const vv of myVirts) await sleep((vv.uid % 2000) * 1.25); // размаз входа: 0..2.5с
    const until = start + DUR_MS;
    while (Date.now() < until) {
      for (const vv of myVirts) {
        if (Date.now() >= until) break;
        // основной трафик: дельта-синк профиля
        let r = await raw('POST', '/api/profile', profileBody(vv.pid, vv.nick, vv.shards, -((vv.uid % 7) + 1)), null, agent);
        tick(r.code, r.ms, r.bytes);
        if (r.code === 200) { vv.shards -= (vv.uid % 7) + 1; if (vv.shards <= 0) vv.shards = 1500; }
        if (vv.uid % 5 === 0) { r = await raw('GET', '/api/profile?pid=' + vv.pid, null, null, agent); tick(r.code, r.ms, r.bytes); }
        if (vv.uid % 10 === 0) { r = await raw('GET', '/api/leaderboard', null, null, agent); tick(r.code, r.ms, r.bytes); }
        // авторизованные аккаунты: friends/presence (heartbeat онлайн-функций)
        if (vv.uid < auth.length && vv.uid % 3 === 0) {
          r = await raw('GET', '/api/friends', null, auth[vv.uid].accessToken, agent); tick(r.code, r.ms, r.bytes);
          r = await raw('POST', '/api/presence', JSON.stringify({ status: vv.uid % 2 ? 'online' : 'in_match' }), auth[vv.uid].accessToken, agent); tick(r.code, r.ms, r.bytes);
        }
        await sleep(95 + (vv.uid % 40)); // ~90мс на вирт.пользователя → ~1.1 req/s с каждого
      }
    }
  }
  await Promise.all(Array.from({ length: CLIENTS }, (_, i) => worker(i)));
  const cpu = serverCpu(cpuBefore);
  report(`ФАЗА A: ${N_USERS} онлайн-игроков (~1.1 req/s каждый, суммарно ${Math.round(N_USERS * 1.1 / 1000)}К req/s), окно ${DUR_MS / 1000}с`);
  if (cpu) console.log(`CPU сервера за фазу: ${cpu.toFixed(0)}% · RSS: ${Math.round(cpuRss() / 1048576)} МБ`);
  agent.destroy();
}

/* CPU/RSS серверного процесса (по /proc, best-effort — только в том же хосте) */
function findServerPid() {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (!cmd.includes('meta_server.js')) continue;
      const env = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (env.includes(`PORT=${PORT}`)) return Number(d);
    } catch { }
  }
  return null;
}
const _clktck = 100;
function serverCpu(prev) {
  const pid = findServerPid();
  if (!pid) return prev ? 0 : null;
  const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  const utime = Number(parts[13]) + Number(parts[14]);
  const now = Date.now();
  if (prev && now > prev.now) {
    const dt = (now - prev.now) / 1000;
    const dCpu = (utime - prev.utime) / _clktck / dt * 100;
    return Math.max(0, dCpu);
  }
  return { now, utime };
}
function cpuRss() {
  const pid = findServerPid();
  if (!pid) return 0;
  const st = readFileSync(`/proc/${pid}/status`, 'utf8');
  const m = st.match(/VmRSS:\s+(\d+) kB/);
  return m ? Number(m[1]) * 1024 : 0;
}

/* ================= ФАЗА A2: БУРСТ — волна новых соединений ================= */
async function phaseBurst() {
  console.log(`\n--- ФАЗА A2: БУРСТ — 5000 НОВЫХ TCP-соединений за 1с (worst case переподключений) ---`);
  const BURST = 5000;
  const burstAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
  const lat = []; let ok = 0, err = 0;
  async function one(i) {
    const r = await raw('POST', '/api/profile', profileBody(`burst${i}`, `Burst${i}`, 1200, -1), null, burstAgent);
    if (r.code === 200) ok++; else err++;
    lat.push(r.ms);
  }
  const t0 = Date.now();
  // 50 волн по 100 запросов, каждые 20мс → вся волна новых соединений за 1с
  await Promise.all(Array.from({ length: 50 }, (_, w) => new Promise(res =>
    setTimeout(() => Promise.all(Array.from({ length: 100 }, (_, k) => one(w * 100 + k))).then(res), w * 20))));
  const dt = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const q = p => lat[Math.floor(lat.length * p)] ?? 0;
  console.log(`новых соединений: ${BURST} · ok=${ok} err=${err} · за ${dt.toFixed(1)}с`);
  console.log(`p50=${q(.5).toFixed(1)}ms p95=${q(.95).toFixed(1)}ms p99=${q(.99).toFixed(1)}ms · heap: ${Math.round(process.memoryUsage().heapUsed / 1048576)} МБ`);
  burstAgent.destroy();
}

/* ================= ФАЗА B: N WebSocket-соединений ================= */
function phaseB() {
  return new Promise(resolve => {
    console.log(`\n--- ФАЗА B: ${WS_N} WS-соединений на /match (верхняя граница online) ---`);
    let opened = 0, failed = 0;
    const t0 = Date.now();
    const sockets = [];
    let i = 0;
    function connectNext() {
      if (i >= WS_N) {
        setTimeout(() => {
          console.log(`подключено: ${opened}/${WS_N} · ошибок: ${failed} · время разгона+удержания: ${((Date.now() - t0) / 1000).toFixed(1)}с`);
          for (const s of sockets) { try { s.close(); } catch { } }
          resolve();
        }, 5000); // держим пул 5с
        return;
      }
      const id = i++;
      try {
        const ws = new WebSocket(WSURL, { handshakeTimeout: 8000, perMessageDeflate: false });
        sockets.push(ws);
        ws.on('open', () => { opened++; if (id % 2000 === 0) console.log(`  +${id} (up ${opened}, fail ${failed})`); });
        ws.on('error', () => { failed++; });
      } catch { failed++; }
      if (i % 200 === 0) setTimeout(connectNext, 5);
      else connectNext();
    }
    connectNext();
  });
}

/* ================= ФАЗА C: реальные матчи (полный конвейер) ================= */
async function oneMatch(a, b, idx, agent) {
  const fail = m => { console.log(`  матч ${idx}: FAIL ${m}`); return false; };
  const q1 = await raw('POST', '/api/mm/queue', JSON.stringify({ mode: 'casual', deckId: 'd' }), a.accessToken, agent);
  if (q1.code !== 200) return fail(`queue a ${q1.code}`);
  const q2 = await raw('POST', '/api/mm/queue', JSON.stringify({ mode: 'casual', deckId: 'd' }), b.accessToken, agent);
  if (q2.code !== 200) return fail(`queue b ${q2.code}`);
  let ja = null, jb = null;
  for (let i = 0; i < 20 && (!ja || !jb); i++) {
    if (!ja) { const r = await raw('GET', '/api/mm/status', null, a.accessToken, agent); if (r.code === 200) { const j = JSON.parse(r.body); if (j.state === 'found') ja = j; } }
    if (!jb) { const r = await raw('GET', '/api/mm/status', null, b.accessToken, agent); if (r.code === 200) { const j = JSON.parse(r.body); if (j.state === 'found') jb = j; } }
    if (!ja || !jb) await sleep(500);
  }
  if (!ja || !jb) return fail('ticket not found');
  const ws1 = new WebSocket(ja.wsUrl ?? WSURL, { handshakeTimeout: 8000 });
  const ws2 = new WebSocket(jb.wsUrl ?? WSURL, { handshakeTimeout: 8000 });
  const ev = { s1: false, s2: false, o1: null, o2: null };
  ws1.on('message', d => { const m = JSON.parse(d); if (m.t === 'start') ev.s1 = true; if (m.t === 'over') ev.o1 = m; });
  ws2.on('message', d => { const m = JSON.parse(d); if (m.t === 'start') ev.s2 = true; if (m.t === 'over') ev.o2 = m; });
  await sleep(600);
  ws1.send(JSON.stringify({ t: 'join', ticket: ja.ticket, deck, faction: 'Aurites', name: 'LA' }));
  ws2.send(JSON.stringify({ t: 'join', ticket: jb.ticket, deck, faction: 'Necrus', name: 'LB' }));
  for (let i = 0; i < 30 && (!ev.s1 || !ev.s2); i++) await sleep(100);
  if (!ev.s1 || !ev.s2) return fail('start not received');
  ws1.send(JSON.stringify({ t: 'net', m: { k: 'turn', n: 1 } }));
  await sleep(120);
  ws1.send(JSON.stringify({ t: 'net', m: { k: 'turn', n: 2 } }));
  await sleep(120);
  ws1.send(JSON.stringify({ t: 'result', winnerSeat: 0 }));
  ws2.send(JSON.stringify({ t: 'result', winnerSeat: 0 }));
  let over = false;
  for (let i = 0; i < 40 && !(ev.o1 && ev.o2); i++) { await sleep(100); over = !!(ev.o1 && ev.o2); }
  ws1.close(); ws2.close();
  return over ? true : fail('no over');
}
async function phaseC() {
  console.log(`\n--- ФАЗА C: ${MATCHES} реальных матчей, параллельные раунды ---`);
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 8 });
  const toks = [];
  for (let i = 0; i < ACCOUNTS * 2; i++) {
    const login = `mc${i}`;
    let r = await raw('POST', '/api/auth/login', JSON.stringify({ login, password: PW }), null, agent);
    if (r.code !== 200) {
      const reg = await raw('POST', '/api/auth/register', JSON.stringify({ login, password: PW }), null, agent);
      if (reg.code !== 200) continue;
      r = await raw('POST', '/api/auth/login', JSON.stringify({ login, password: PW }), null, agent);
    }
    if (r.code === 200) toks.push(JSON.parse(r.body));
  }
  const pairs = Math.floor(toks.length / 2);
  const ROUNDS = 5;
  const perRound = Math.max(1, Math.ceil(MATCHES / ROUNDS));
  let ok = 0, bad = 0;
  const mt0 = Date.now();
  for (let rnd = 0; rnd < ROUNDS; rnd++) {
    const n = Math.min(perRound, pairs);
    const jobs = [];
    for (let m = 0; m < n; m++) jobs.push(oneMatch(toks[2 * m], toks[2 * m + 1], rnd * perRound + m, agent).then(x => (x ? ok++ : bad++)));
    await Promise.all(jobs);
    console.log(`  раунд ${rnd + 1}/${ROUNDS}: ок=${ok} fail=${bad}`);
  }
  console.log(`матчей сыграно: ${ok + bad} · успешно: ${ok} · провалено: ${bad} · за ${((Date.now() - mt0) / 1000).toFixed(1)}с`);
  agent.destroy();
}

/* ================= main ================= */
(async () => {
  const h = await raw('GET', '/health');
  if (h.code !== 200) {
    console.error('load-инстанс не отвечает на :' + PORT + '. Запуск: cd /tmp/kki-load && RATE_LIMIT=0 PORT=' + PORT + ' node /home/user/KKIv1.0/build/meta_server.js');
    process.exit(1);
  }
  await phaseA();
await phaseBurst();
  await phaseB();
  await phaseC();
  console.log('\n=== LOAD TEST ЗАВЕРШЁН ===');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
