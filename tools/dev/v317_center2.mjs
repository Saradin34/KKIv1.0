import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1568, height: 709 }, deviceScaleFactor: 1.25 });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; const df = document.getElementById('difficulty'); if (df) df.value = '0.8'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1400);
const g = await pg.evaluate(() => {
  const r = sel => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0), left: cs.left, pos: cs.position, tf: cs.transform, zl: cs.zIndex }; };
  const cards = [...document.querySelectorAll('#hand .card')].map(c => { const b = c.getBoundingClientRect(); return +(b.x + b.width / 2).toFixed(0); });
  return { bar: r('#playerHero'), hand: r('#hand'), zoneP: r('#zonePlayer .zoneInner') || r('#zonePlayer'), enemyBar: r('#enemyHero'), cardCenters: cards, mid: innerWidth / 2 };
});
console.log(JSON.stringify(g, null, 1));
await b.close();
