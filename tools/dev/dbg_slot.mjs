import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; m.shards = 5000; m.freeOpens = 3; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => document.getElementById('btnBoosters')?.click() || document.querySelector('.topTab[data-tab="packs"]')?.click());
await pg.waitForTimeout(600);
const r = await pg.evaluate(() => {
  const c = document.querySelector('#boosterInventory .boosterInvCard.has-stock');
  if (c) c.click();
  return !!c;
});
await pg.waitForTimeout(400);
const o = await pg.evaluate(() => { const s = document.getElementById('packSealed'); if (s && !s.classList.contains('hidden')) s.click(); return true; });
await pg.waitForTimeout(2200);
const g = await pg.evaluate(() => {
  const s = document.querySelector('#packRow .packSlot');
  if (!s) return { err: 'no slot', meta: JSON.parse(localStorage.getItem('ec_meta_v1')||'{}').shards };
  const cs = getComputedStyle(s);
  return { w: cs.width, slotW: cs.getPropertyValue('--slot-w'), h: cs.height, children: s.parentElement.childElementCount,
    stageW: document.getElementById('packStage')?.getBoundingClientRect().width,
    cssV: document.querySelector('link[rel=stylesheet]')?.href };
});
console.log(JSON.stringify({ r, o, ...g }, null, 1));
await b.close();
