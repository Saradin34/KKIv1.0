import { chromium } from 'playwright';
const SH = '/home/user/KKIv1.0/shots/v317';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

// 1) муллиган
await pg.evaluate(() => {
  const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus';
  const df = document.getElementById('difficulty'); if (df) df.value = '0.8';
  document.getElementById('btnPlay')?.click();
});
for (let i = 0; i < 60; i++) {
  const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden'));
  if (s) break;
  await pg.waitForTimeout(200);
}
await pg.waitForTimeout(400);
await pg.screenshot({ path: SH + '/07_mulligan.png' });
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1000);

// 2) профиль → косметика (рука/рубашки крупнее)
await pg.evaluate(() => {
  // в бою: открыть профиль через значок или напрямую
  const pf = document.getElementById('profileModal');
  window.__openProfile?.();
  return !!pf;
});
await pg.waitForTimeout(600);
const pfState = await pg.evaluate(() => ({ visible: !document.getElementById('profileModal').classList.contains('hidden') }));
console.log('profile state:', JSON.stringify(pfState));
await b.close();
