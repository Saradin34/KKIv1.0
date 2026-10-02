/* Повторяемый интеграционный тест онлайна: запустить npm run server:meta (RATE_LIMIT=0) и npm run server:match, затем node tools/online_test.js. Логины и pid уникальны для каждого запуска. */
const WebSocket = require(process.cwd() + '/node_modules/ws');
const A = process.env.META || 'http://127.0.0.1:8081';
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const loginA = `alice${runId}`;
const loginB = `bob${runId}`;
const loginC = `logout${runId}`;
const j = async (m, p, body, tok) => { const r = await fetch(A + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, b: await r.json() }; };
const ok = (c, name, extra = '') => { console.log((c ? '✅ ' : '❌ ') + name + (extra ? ' — ' + extra : '')); if (!c) process.exitCode = 1; };
(async () => {
  const weak = await j('POST', '/api/auth/register', { login: 'shortpw', password: 'pass1', pid: 'weak' });
  ok(weak.s === 400, 'регистрация блокирует слишком короткий пароль');
  const regA = await j('POST', '/api/auth/register', { login: loginA, password: 'pass1pass', pid: `pa-${runId}` });
  const regB = await j('POST', '/api/auth/register', { login: loginB, password: 'pass2pass', pid: `pb-${runId}` });
  let a = regA.b;
  const b = regB.b;
  ok(regA.s === 200 && regB.s === 200 && a.accessToken && b.accessToken, 'регистрация двух игроков', `${loginA} / ${loginB}`);
  const spentRefresh = a.refreshToken;
  const [refreshA, refreshB] = await Promise.all([
    j('POST', '/api/auth/refresh', { refreshToken: spentRefresh }),
    j('POST', '/api/auth/refresh', { refreshToken: spentRefresh }),
  ]);
  ok(refreshA.s === 200 && refreshB.s === 200 && refreshA.b.refreshToken === refreshB.b.refreshToken,
    'параллельная ротация refresh в соседних вкладках идемпотентна');
  a = refreshA.b;
  const pidA = `pa-${runId}`;
  const introDraft = await j('POST', '/api/profile', {
    pid: pidA, nick: loginA, tutStage: 4, tutDone: true, tutReward: '',
    introComplete: false, starterDecksUnlocked: false, introStep: 3, introFaction: 'Ethereal',
    introFactionsSeen: ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal'],
  }, a.accessToken);
  const introDraftRead = await j('GET', `/api/profile?pid=${encodeURIComponent(pidA)}`, null, a.accessToken);
  ok(introDraft.s === 200 && introDraftRead.b.introComplete === false
    && introDraftRead.b.starterDecksUnlocked === false && introDraftRead.b.introStep === 3
    && introDraftRead.b.tutStage === 4 && introDraftRead.b.introFactionsSeen?.length === 5,
    'сервер сохраняет пролог между устройствами, не открывая колоды до выбора награды');
  const introRewardSync = await j('POST', '/api/profile', {
    pid: pidA, nick: loginA, tutStage: 4, tutDone: true, tutReward: 'Pyromancer',
    introComplete: true, starterDecksUnlocked: true, introStep: 3, introFaction: 'Pyromancer',
    introFactionsSeen: ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal'],
  }, a.accessToken);
  const introRewardRead = await j('GET', `/api/profile?pid=${encodeURIComponent(pidA)}`, null, a.accessToken);
  ok(introRewardSync.s === 200 && introRewardRead.b.introComplete === true
    && introRewardRead.b.starterDecksUnlocked === true && introRewardRead.b.introFaction === 'Pyromancer'
    && introRewardRead.b.tutReward === 'Pyromancer', 'сервер синхронизирует завершение пролога и выбранную колоду');
  const regC = await j('POST', '/api/auth/register', { login: loginC, password: 'pass3pass', pid: `pc-${runId}` });
  const oldRefreshC = regC.b.refreshToken;
  const rotatedC = await j('POST', '/api/auth/refresh', { refreshToken: oldRefreshC });
  const logoutC = await j('POST', '/api/auth/logout', { refreshToken: rotatedC.b.refreshToken });
  const replayAfterLogout = await j('POST', '/api/auth/refresh', { refreshToken: oldRefreshC });
  ok(regC.s === 200 && rotatedC.s === 200 && logoutC.s === 200 && replayAfterLogout.s === 401,
    'выход отзывает replay старого refresh и не позволяет воскресить сессию');
  ok((await j('GET', '/api/friends')).s === 401, 'без токена онлайн-ручки закрыты');
  const srch = await j('GET', '/api/users/search?q=' + encodeURIComponent(loginB), null, a.accessToken);
  ok(srch.b.users?.some(u => u.login === loginB), 'поиск игрока по логину');
  ok((await j('POST', '/api/friends/request', { to: loginB }, a.accessToken)).b.pending, 'заявка в друзья отправлена');
  const fb = await j('GET', '/api/friends', null, b.accessToken);
  ok(fb.b.incoming.length === 1 && fb.b.incoming[0].login === loginA, 'у Боба входящая заявка');
  await j('POST', '/api/friends/accept', { from: loginA }, b.accessToken);
  const fa = await j('GET', '/api/friends', null, a.accessToken);
  ok(fa.b.friends.length === 1 && fa.b.friends[0].status === 'online', 'дружба + статус «в сети»', fa.b.friends[0]?.status);
  // вызов друга
  const ch = await j('POST', '/api/challenge', { to: loginB, deckId: 'Aurites' }, a.accessToken);
  const chl = await j('GET', '/api/friends', null, b.accessToken);
  ok(ch.b.id && chl.b.challenges.length === 1, 'вызов на дружеский матч дошёл');
  await j('POST', '/api/challenge/accept', { id: ch.b.id, deckId: 'Necrus' }, b.accessToken);
  const fsA = await j('GET', '/api/mm/status', null, a.accessToken);
  ok(fsA.b.state === 'found' && fsA.b.mode === 'friendly', 'дружеский матч создан');
  const fsB = await j('GET', '/api/mm/status', null, b.accessToken);
  // рейтинговая очередь
  await j('POST', '/api/mm/queue', { mode: 'ranked', deckId: 'Aurites' }, a.accessToken);
  const s1 = await j('GET', '/api/mm/status', null, a.accessToken);
  ok(s1.b.state === 'searching', 'один в очереди — поиск', JSON.stringify(s1.b));
  await j('POST', '/api/mm/queue', { mode: 'ranked', deckId: 'Necrus' }, b.accessToken);
  const ra = await j('GET', '/api/mm/status', null, a.accessToken);
  const rb = await j('GET', '/api/mm/status', null, b.accessToken);
  ok(ra.b.state === 'found' && rb.b.state === 'found' && ra.b.match === rb.b.match && ra.b.seat !== rb.b.seat, 'рейтинговый матч подобран, места разные');
  // match-server: билеты
  const decks = require(process.cwd() + '/unity/EchoCitadel/Assets/StreamingAssets/Decks.json').decks;
  const join = (tk, deck) => new Promise(res => { const ws = new WebSocket('' + (process.env.MATCH_WS || 'ws://127.0.0.1:8080') + ''); const got = []; ws.on('message', m => { got.push(JSON.parse(String(m))); }); ws.on('open', () => ws.send(JSON.stringify({ t: 'join', ticket: tk, deck }))); setTimeout(() => res({ ws, got }), 700); });
  const bad = await join('garbage', decks[0].cards);
  ok(bad.got.some(m => m.t === 'err'), 'match-server: без билета не пускает');
  const wa = await join(ra.b.ticket, decks[0].cards);
  const wb = await join(rb.b.ticket, decks[1].cards);
  ok(wb.got.some(m => m.t === 'start') && wa.got.some(m => m.t === 'start'), 'match-server: оба вошли по билетам, матч стартовал', JSON.stringify(wb.got.find(m => m.t === 'start')));
  // уход игрока A → техпоражение через 60 с (проверяем короче: закрываем и ждём отчёт вручную не будем) — итог шлём как match-server
  const key = require('crypto').createHmac('sha256', Buffer.from(require('fs').readFileSync((process.env.META_CWD || process.cwd()) + '/server/data/jwt_secret', 'utf8').trim(), 'hex')).update('internal').digest('hex');
  const forged = await j('POST', '/api/internal/match-result', { match: ra.b.match, winner: loginA });
  ok(forged.s === 403, 'клиент не может записать себе победу');
  const rep = await j('POST', '/api/internal/match-result', { match: ra.b.match, winner: loginA }).then(() => fetch(A + '/api/internal/match-result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': key }, body: JSON.stringify({ match: ra.b.match, winner: loginA }) }).then(r => r.json()));
  ok(rep.ok && rep.dA > 0 && rep.dB < 0, 'итог от match-server: Elo начислен', JSON.stringify(rep));
  const me = await j('GET', '/api/rating/me', null, a.accessToken);
  ok(me.b.mmr > 1200 && me.b.wins === 1 && me.b.history[0].result === 'win', 'рейтинг Алисы', `${me.b.mmr} ${me.b.rank.label} место ${me.b.place}`);
  const lb = await j('GET', '/api/leaderboard');
  ok(lb.b.top.some(u => u.login === loginA) && lb.b.top.some(u => u.login === loginB), 'таблица лидеров');
  await j('POST', '/api/friends/remove', { login: loginB }, a.accessToken);
  ok((await j('GET', '/api/friends', null, b.accessToken)).b.friends.length === 0, 'удаление из друзей — у обоих');
  wa.ws.close(); wb.ws.close(); bad.ws.close();
  process.exit();
})();
