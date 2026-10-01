import { chromium } from 'playwright';
const IDS = ['board','enemyBoard','playerBoard','centerLine','enemyRunes','playerRunes'];
const geo = () => pg.evaluate((ids) => {
  const o = {};
  for (const id of ids) {
    const n = document.getElementById(id); if (!n) { o[id] = null; continue; }
    const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    o[id] = { y: +b.y.toFixed(1), h: +b.height.toFixed(1), mt: st.marginTop, mb: st.marginBottom, pt: st.paddingTop, pb: st.paddingBottom, minH: st.minHeight, h_css: st.height, disp: st.display };
  }
  // zoneWrap'ы (не имеют id)
  const zw = [...document.querySelectorAll('#board .zoneWrap')];
  o.zoneWraps = zw.map(n => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n); return { h: +b.h?.toFixed?.(1) ?? +b.height.toFixed(1), gap: st.gap, pad: st.padding }; });
  return o;
}, IDS);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
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
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1400);
await pg.evaluate(() => {
  const B = window.__battle, e = B.engine;
  for (const sd of [0, 1]) { const pl = e.p(sd); const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3); for (const id of ids) e.summon(sd, e.db.get(id)); pl.creatures.forEach(c => { c.justPlayed = false; }); }
  B.renderAll();
});
await pg.waitForTimeout(400);
const main = await geo();
await pg.evaluate(() => document.getElementById('btnEndTurn')?.click());
const t0 = Date.now();
while (Date.now() - t0 < 15000) { const ic = await pg.evaluate(() => window.__battle?.inCombatWindow === true); if (ic) break; await pg.waitForTimeout(250); }
await pg.waitForTimeout(800);
const combat = await geo();
console.log(JSON.stringify({ main, combat }, null, 1));
await b.close();
