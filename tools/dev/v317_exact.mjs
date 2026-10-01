import { chromium } from 'playwright';
// Точный экран пользователя: физ. 1568×749, DPI-scale 125% → CSS 1254×599
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1254, height: 599 }, deviceScaleFactor: 1.25 });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; const df = document.getElementById('difficulty'); if (df) df.value = '0.8'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1500);
const g = await pg.evaluate(() => {
  const r = sel => { const n = document.querySelector(sel); if (!n) return null; const bb = n.getBoundingClientRect(); return { x: +bb.x.toFixed(0), y: +bb.y.toFixed(0), w: +bb.width.toFixed(0), h: +bb.height.toFixed(0) }; };
  const cards = [...document.querySelectorAll('#hand .card')].map(c => { const bb = c.getBoundingClientRect(); return { x: +(bb.x+bb.width/2).toFixed(0), top: +bb.y.toFixed(0) }; });
  return { vw: innerWidth, vh: innerHeight, bar: r('#playerHero'), medal: r('#playerHero .medal'), name: r('#playerHero .medalName'),
    cardTop: Math.min(...cards.map(c=>c.top)), handW: getComputedStyle(document.querySelector('#battle')).getPropertyValue('--hand-w'),
    heroH: getComputedStyle(document.querySelector('#battle')).getPropertyValue('--hero-h'), cardCenters: cards.map(c=>c.x) };
});
console.log(JSON.stringify(g, null, 1));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/13_exact_user.png' });
await b.close();
