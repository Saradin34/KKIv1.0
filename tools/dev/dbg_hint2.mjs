import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1300);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
// дождаться основной фазы (баннеры кончились), затем 7.5с бездействия
for (let i = 0; i < 40; i++) {
  const s = await pg.evaluate(() => (document.getElementById('actionHint')?.textContent ?? '').startsWith('Перетащите'));
  if (s) break; await pg.waitForTimeout(250);
}
const t0 = await pg.evaluate(() => document.getElementById('actionHint')?.textContent);
await pg.waitForTimeout(7500);
const t1 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length,
  hint: document.getElementById('actionHint')?.textContent,
  playable: [...document.querySelectorAll('#hand .card:not(.unplayable)')].map(c => getComputedStyle(c).animationName) }));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/19_think_gold.png' });
await pg.waitForTimeout(1500); // фоновые перерисовки не должны затирать
const t2 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length, hint: document.getElementById('actionHint')?.textContent }));
await pg.mouse.click(500, 300);
await pg.waitForTimeout(400);
const t3 = await pg.evaluate(() => ({ hinted: document.querySelectorAll('#hand .card.thinkHint').length, hint: document.getElementById('actionHint')?.textContent }));
console.log(JSON.stringify({ t0, t1, t2, t3 }, null, 1));
await b.close();
