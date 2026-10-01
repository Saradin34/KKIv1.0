import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

// --- 1. МАГАЗИН: купить бустер, остаться в магазине ---
await pg.evaluate(() => document.querySelector('.topTab[data-tab="store"]').click());
await pg.waitForTimeout(600);
const before = await pg.evaluate(() => ({
  shopOpen: !document.getElementById('shopModal').classList.contains('hidden'),
  boosterOpen: !document.getElementById('boosterModal').classList.contains('hidden'),
  free: JSON.parse(localStorage.getItem('ec_meta_v1')||'{}').freeOpens ?? 0
}));
await pg.evaluate(() => document.getElementById('buyPack')?.click());
await pg.waitForTimeout(700);
const afterBuy = await pg.evaluate(() => ({
  shopOpen: !document.getElementById('shopModal').classList.contains('hidden'),
  boosterOpen: !document.getElementById('boosterModal').classList.contains('hidden'),
  free: JSON.parse(localStorage.getItem('ec_meta_v1')||'{}').freeOpens ?? 0
}));
console.log('SHOP:', JSON.stringify({ before, afterBuy }));

// --- 2. ВСКРЫТИЕ: левая панель видна ---
await pg.evaluate(() => document.getElementById('btnBoosters')?.click() || document.querySelector('.topTab[data-tab="packs"]')?.click());
await pg.waitForTimeout(700);
const selInv = await pg.evaluate(() => { const c = document.querySelector('#boosterInventory .boosterInvCard.has-stock'); if (c) c.click(); return !!c; });
await pg.waitForTimeout(500);
const openSealed = await pg.evaluate(() => { const s = document.getElementById('packSealed'); if (s && !s.classList.contains('hidden')) s.click(); return true; });
await pg.waitForTimeout(2500);
const openState = await pg.evaluate(() => {
  const shelf = document.querySelector('.boosterShelf');
  const stage = document.getElementById('packStage');
  const cs = shelf ? getComputedStyle(shelf) : null;
  const slots = [...document.querySelectorAll('#packRow .packSlot')].map(s => { const bb = s.getBoundingClientRect(); return { w: Math.round(bb.width), x: Math.round(bb.x) }; });
  const stageBB = document.getElementById('packStage')?.getBoundingClientRect();
  const row = document.getElementById('packRow')?.getBoundingClientRect();
  return { shelfVisible: cs ? cs.display !== 'none' && shelf.getBoundingClientRect().width > 0 : false,
    hasResults: stage?.classList.contains('hasResults'), slotCount: slots.length,
    slots, stageRight: stageBB ? Math.round(stageBB.right) : null, rowRight: row ? Math.round(row.right) : null,
    overflow: row && stageBB ? row.right - stageBB.right : null };
});
console.log('OPEN:', JSON.stringify({ selInv, openSealed, ...openState }));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/14_booster_open.png' });

// --- 3. Бой: подсветка раздумья ---
await pg.evaluate(() => { document.getElementById('btnPackClose')?.click(); });
await pg.waitForTimeout(500);
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; const df = document.getElementById('difficulty'); if (df) df.value = '0.8'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1500);
const think0 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length, hint: document.getElementById('actionHint')?.textContent }));
await pg.waitForTimeout(7500);
const think1 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length, hint: document.getElementById('actionHint')?.textContent, total: document.querySelectorAll('#hand .card').length, playable: document.querySelectorAll('#hand .card:not(.unplayable)').length }));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/15_think_hint.png' });
// действие → сброс
await pg.evaluate(() => { const c = [...document.querySelectorAll('#hand .card:not(.unplayable)')].find(x => x.classList.contains('instantReady')); if (c) c.click(); });
await pg.waitForTimeout(2500);
const think2 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length }));
console.log('THINK:', JSON.stringify({ think0, think1, afterAction: think2 }));
await b.close();
