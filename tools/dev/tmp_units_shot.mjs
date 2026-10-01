import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/', { waitUntil: 'load' });
await pg.waitForTimeout(900);
await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()");
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')");
await pg.evaluate(() => { document.getElementById('btnPlay').click(); });
await pg.waitForTimeout(1800);
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1000);
await pg.evaluate(() => {
  const B = window.__battle, e = B.engine;
  for (const sd of [0, 1]) {
    const pl = e.p(sd);
    const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 4);
    for (const id of ids) e.summon(sd, e.db.get(id));
  }
  B.renderAll();
});
await pg.waitForTimeout(800);
await pg.screenshot({ path: '/home/user/shots/bgcheck/units_full.png' });
for (const [sel, file] of [['#enemyBoard .unit', 'unit_zoom.png'], ['#playerBoard .unit', 'unit_zoom_player.png']]) {
  const box = await pg.evaluate((s) => {
    const u = document.querySelector(s);
    if (!u) return null;
    const r = u.getBoundingClientRect();
    return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 };
  }, sel);
  if (box) await pg.screenshot({ path: '/home/user/shots/bgcheck/' + file, clip: box });
}
console.log('units:', await pg.evaluate(() => document.querySelectorAll('#enemyBoard .unit').length + '/' + document.querySelectorAll('#playerBoard .unit').length));
await b.close();
