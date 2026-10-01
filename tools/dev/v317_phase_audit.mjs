// v3.17: аудит стабильности layout по всем фазам — какие контейнеры «прыгают» между стадиями
import { chromium } from 'playwright';
const SH = '/home/user/KKIv1.0/shots/v317';
const IDS = ['topbar','stepTrack','enemyHero','playerHero','enemyBoard','playerBoard','centerLine','enemyCorner','playerCorner','handArea','actionDock','hand'];
const PH_RU = ['Начало','Ресурсы','Основная','Битва','Конец'];

const geo = () => pg.evaluate((ids) => {
  const o = {};
  for (const id of ids) {
    const n = document.getElementById(id);
    if (!n) { o[id] = null; continue; }
    const b = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    if (st.display === 'none') { o[id] = { hidden: true }; continue; }
    o[id] = { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  }
  const ban = document.getElementById('phaseBanner');
  o.__banner = ban ? !ban.classList.contains('hidden') || (ban.classList && ban.className.includes('show')) : null;
  o.__phase = window.__battle?.engine?.phase;
  return o;
}, IDS);

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
pg.on('pageerror', e => errors.push(e.message));
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => {
  const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus';
  const df = document.getElementById('difficulty'); if (df) df.value = '0.8';
  document.getElementById('btnPlay')?.click();
});
for (let i = 0; i < 60; i++) {
  const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden'));
  if (s) break;
  await pg.waitForTimeout(200);
}
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1200);
// существа на обе стороны
await pg.evaluate(() => {
  const B = window.__battle, e = B.engine;
  for (const sd of [0, 1]) {
    const pl = e.p(sd);
    const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3);
    for (const id of ids) e.summon(sd, e.db.get(id));
    pl.creatures.forEach(c => { c.justPlayed = false; });
  }
  B.renderAll();
});

const firstSeen = {};       // phase -> first geometry
const phaseShot = {};       // phase -> shot taken
const T0 = Date.now();
let lastAct = 0;
while (Date.now() - T0 < 55000) {
  const g = await geo();
  const ph = g.__phase;
  if (ph !== undefined && ph !== null && !firstSeen[ph]) {
    firstSeen[ph] = g;
    phaseShot[ph] = true;
    await pg.screenshot({ path: SH + `/ph_${ph}.png` });
  }
  // автопрокачка
  const st = await pg.evaluate(() => ({
    inCombat: window.__battle?.inCombatWindow === true,
    canEnd: (() => { const et = document.getElementById('btnEndTurn'); return et && !et.disabled && !et.classList.contains('hidden'); })(),
    over: !document.getElementById('gameover')?.classList.contains('hidden')
  }));
  if (st.over) break;
  if (st.inCombat && Date.now() - lastAct > 500) { lastAct = Date.now(); await pg.evaluate(() => document.getElementById('btnAutoBattle')?.click()); }
  else if (st.canEnd && Date.now() - lastAct > 900) { lastAct = Date.now(); await pg.evaluate(() => document.getElementById('btnEndTurn')?.click()); }
  await pg.waitForTimeout(110);
}
await pg.screenshot({ path: SH + '/ph_end_game.png' });

// отчёт: для каждой фазы — смещения контейнеров относительно фазы «Основная» (базы)
const base = firstSeen[2] || Object.values(firstSeen)[0];
const report = {};
for (const [ph, g] of Object.entries(firstSeen)) {
  const d = {};
  for (const id of IDS) {
    const a = base[id], c = g[id];
    if (!a || !c || a.hidden || c.hidden) continue;
    const dx = +(c.x - a.x).toFixed(1), dy = +(c.y - a.y).toFixed(1), dw = +(c.w - a.w).toFixed(1), dh = +(c.h - a.h).toFixed(1);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(dw) > 0.5 || Math.abs(dh) > 0.5) d[id] = { dx, dy, dw, dh };
  }
  report[PH_RU[ph] || ph] = { banner: g.__banner, moved: d };
}
console.log(JSON.stringify({ phases: Object.keys(firstSeen).map(p => PH_RU[p] || p), report, errors: errors.slice(0,5) }, null, 1));
await b.close();
