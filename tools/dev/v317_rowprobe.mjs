import { chromium } from 'playwright';
const kids = () => pg.evaluate(() => {
  const bt = document.getElementById('battle');
  return [...bt.children].map(n => {
    const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return { name: n.id || n.className.split(' ')[0], tag: n.tagName, pos: s.position, disp: s.display,
      y: +b.y.toFixed(1), h: +b.height.toFixed(1), gridRow: s.gridRowStart };
  });
});
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
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
await pg.evaluate(() => { const B = window.__battle, e = B.engine; for (const sd of [0, 1]) { const pl = e.p(sd); const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3); for (const id of ids) e.summon(sd, e.db.get(id)); pl.creatures.forEach(c => { c.justPlayed = false; }); } B.renderAll(); });
await pg.waitForTimeout(400);
const main = await kids();
await pg.evaluate(() => document.getElementById('btnEndTurn')?.click());
const t0 = Date.now();
while (Date.now() - t0 < 15000) { const ic = await pg.evaluate(() => window.__battle?.inCombatWindow === true); if (ic) break; await pg.waitForTimeout(250); }
await pg.waitForTimeout(800);
const combat = await kids();
const names = new Set(main.map(k => k.name));
console.log('=== children only/changed in COMBAT ===');
for (const c of combat) {
  const m = main.find(k => k.name === c.name);
  if (!m) { console.log('NEW:', JSON.stringify(c)); continue; }
  const diff = Object.keys(c).filter(k => m[k] !== c[k]).map(k => `${k}: ${m[k]} -> ${c[k]}`).join(', ');
  if (diff) console.log('CHG:', c.name, '|', diff);
}
console.log('=== main phase list ===');
console.log(main.map(k => `${k.name}(${k.pos},${k.disp},row=${k.gridRow},h=${k.h})`).join('\n'));
await b.close();
