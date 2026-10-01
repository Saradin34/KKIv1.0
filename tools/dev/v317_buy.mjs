import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; m.shards = 5000; m.gems = 500; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1300);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => document.querySelector('.topTab[data-tab="store"]').click());
await pg.waitForTimeout(500);
const r = await pg.evaluate(() => {
  const m0 = JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');
  const btn = document.querySelector('.buyPackOffer');
  const before = { free: m0.freeOpens??0, prem: m0.premOpens??0, shards: m0.shards, gems: m0.gems, offerBtn: btn ? btn.dataset.offer+'/'+btn.dataset.cur+'/'+btn.textContent.trim() : null };
  btn?.click();
  return before;
});
await pg.waitForTimeout(600);
const after = await pg.evaluate(() => {
  const m1 = JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');
  return { free: m1.freeOpens??0, prem: m1.premOpens??0, shards: m1.shards, gems: m1.gems,
    shop: !document.getElementById('shopModal').classList.contains('hidden'),
    boosters: !document.getElementById('boosterModal').classList.contains('hidden'),
    toast: document.querySelector('.toast')?.textContent ?? null };
});
console.log(JSON.stringify({ before: r, after }, null, 1));
await b.close();
