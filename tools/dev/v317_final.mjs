import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; m.shards = 5000; m.gems = 500; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1300);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

// 1. МАГАЗИН: покупка бустера (обычного и оффера) — остаёмся в магазине
await pg.evaluate(() => document.querySelector('.topTab[data-tab="store"]').click());
await pg.waitForTimeout(500);
const buy1 = await pg.evaluate(() => { const m0 = JSON.parse(localStorage.getItem('ec_meta_v1')||'{}').freeOpens??0; document.getElementById('buyPack')?.click(); return m0; });
await pg.waitForTimeout(500);
const s1 = await pg.evaluate(() => ({ shop: !document.getElementById('shopModal').classList.contains('hidden'),
  boosters: !document.getElementById('boosterModal').classList.contains('hidden'),
  free: JSON.parse(localStorage.getItem('ec_meta_v1')||'{}').freeOpens??0 }));
await pg.evaluate(() => document.querySelector('.buyPackOffer')?.click());
await pg.waitForTimeout(500);
const s2 = await pg.evaluate(() => ({ shop: !document.getElementById('shopModal').classList.contains('hidden'),
  boosters: !document.getElementById('boosterModal').classList.contains('hidden') }));
console.log('BUY:', JSON.stringify({ buy1free: buy1, afterPack: s1, afterOffer: s2 }));

// 2. ВСКРЫТИЕ: левая панель на месте, карты не выходят за сцену
await pg.evaluate(() => document.querySelector('.topTab[data-tab="packs"]')?.click());
await pg.waitForTimeout(600);
await pg.evaluate(() => document.querySelector('#boosterInventory .boosterInvCard.has-stock')?.click());
await pg.waitForTimeout(400);
await pg.evaluate(() => { const s = document.getElementById('packSealed'); if (s && !s.classList.contains('hidden')) s.click(); });
await pg.waitForTimeout(2500);
const o = await pg.evaluate(() => {
  const shelf = document.querySelector('.boosterShelf'); const sb = shelf.getBoundingClientRect();
  const stage = document.getElementById('packStage').getBoundingClientRect();
  const row = document.getElementById('packRow').getBoundingClientRect();
  const slots = [...document.querySelectorAll('#packRow .packSlot')].map(s => Math.round(s.getBoundingClientRect().width));
  return { shelfW: Math.round(sb.width), shelfVisible: sb.width > 0 && getComputedStyle(shelf).display !== 'none',
    hasResults: document.getElementById('packStage').classList.contains('hasResults'),
    slotW: slots, overflowPx: Math.round(row.right - stage.right) };
});
console.log('OPEN:', JSON.stringify(o));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/17_booster_shelf.png' });

// 3. Бой: подсказка при раздумье → появление через 7с → гашение касанием
await pg.evaluate(() => document.getElementById('btnPackClose')?.click());
await pg.waitForTimeout(400);
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1500);
const t0 = await pg.evaluate(() => document.querySelectorAll('#hand .card.thinkHint').length);
await pg.waitForTimeout(7300);
const t1 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length, hint: document.getElementById('actionHint')?.textContent }));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/18_think.png' });
await pg.mouse.click(400, 300); // касание в пустое поле
await pg.waitForTimeout(300);
const t2 = await pg.evaluate(() => document.querySelectorAll('#hand .card.thinkHint').length);
console.log('THINK:', JSON.stringify({ t0, t1, afterTouch: t2 }));
await b.close();
