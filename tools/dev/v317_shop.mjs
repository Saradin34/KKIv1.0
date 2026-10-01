import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1568, height: 709 }, deviceScaleFactor: 1.25 });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => document.querySelector('.topTab[data-tab="store"]').click());
await pg.waitForTimeout(800);
await pg.evaluate(() => document.querySelector('[data-stab="cosm"]').click());
await pg.waitForTimeout(700);
const g = await pg.evaluate(() => {
  const t = document.querySelector('.ofCard:has(.a-cosm)');
  if (!t) return { err: 'no cosm tile', shop: !!document.getElementById('shopScreen'), tabs: [...document.querySelectorAll('[data-stab]')].map(x=>x.dataset.stab) };
  const r = el => { if (!el) return null; const bb = el.getBoundingClientRect(); return { x: +bb.x.toFixed(0), y: +bb.y.toFixed(0), w: +bb.width.toFixed(0), h: +bb.height.toFixed(0) }; };
  return { tile: r(t), art: r(t.querySelector('.ofArt')), back: r(t.querySelector('.cardback.mini')), name: r(t.querySelector('.ofName')), sub: r(t.querySelector('.ofSub')), buy: r(t.querySelector('.ofBuy')),
    zlBuy: getComputedStyle(t.querySelector('.ofBuy')).zIndex, tiles: document.querySelectorAll('.ofCard:has(.a-cosm)').length };
});
console.log(JSON.stringify(g, null, 1));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/11_shop_cosm.png' });
await b.close();
