import { chromium } from 'playwright';
const kids = () => pg.evaluate(() => {
  const out = [];
  const bd = document.getElementById('board');
  const st = getComputedStyle(bd);
  out.push({ name: 'BOARD', y: +bd.getBoundingClientRect().y.toFixed(1), h: +bd.getBoundingClientRect().height.toFixed(1),
    padB: st.paddingBottom, rows: st.gridTemplateRows, hCss: st.height });
  for (const n of bd.children) {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    out.push({ name: n.id || n.className.split(' ')[0], y: +b.y.toFixed(1), h: +b.height.toFixed(1), minH: s.minHeight, hCss: s.height, disp: s.display, hidden: s.display === 'none' });
  }
  // #battle дети
  const bt = document.getElementById('battle');
  out.push({ name: 'BATTLE', y: +bt.getBoundingClientRect().y.toFixed(1), h: +bt.getBoundingClientRect().height.toFixed(1), rows: getComputedStyle(bt).gridTemplateRows, of: getComputedStyle(bt).overflow });
  for (const n of bt.children) {
    const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    if (s.position === 'static' && s.display !== 'none') out.push({ name: 'bt:' + (n.id || n.className.split(' ')[0]), y: +b.y.toFixed(1), h: +b.height.toFixed(1), pos: s.position });
  }
  return out;
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
const mm = new Map(main.map(r => [r.name, r]));
for (const c of combat) {
  const m = mm.get(c.name);
  if (!m) { console.log('NEW in combat:', JSON.stringify(c)); continue; }
  const dy = +(c.y - m.y).toFixed(1), dh = +(c.h - m.h).toFixed(1);
  const other = Object.keys(c).filter(k => !['name','y','h'].includes(k) && c[k] !== m[k]).map(k => `${k}: ${m[k]} -> ${c[k]}`).join(', ');
  if (Math.abs(dy) > 0.5 || Math.abs(dh) > 0.5 || other) console.log(`${c.name}: dy=${dy} dh=${dh} ${other}`);
}
await b.close();
