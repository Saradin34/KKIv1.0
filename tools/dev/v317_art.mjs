import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1568, height: 749 }, deviceScaleFactor: 1.25 });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => {
  const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}');
  m.tutDone = true; m.shards = 10000; m.gems = 5000; m.tablesOwned = ['tide', 'ash'];
  localStorage.setItem('ec_meta_v1', JSON.stringify(m));
});
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

async function battleWith(id) {
  await pg.evaluate((id) => { window.ecNavigate && window.ecNavigate('profile'); }, id);
  await pg.waitForTimeout(500);
  await pg.evaluate(() => document.querySelector('.ptab[data-ptab="cosm"]')?.click());
  await pg.waitForTimeout(300);
  await pg.evaluate((id) => document.querySelector(`.cosmSkinChip[data-kind="table"][data-id="${id}"]`)?.click(), id);
  await pg.waitForTimeout(400);
  await pg.evaluate(() => document.getElementById('profileModal')?.classList.add('hidden'));
  await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
  for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
  await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
  await pg.waitForTimeout(1500);
  const st = await pg.evaluate(() => ({
    table: document.body.dataset.table,
    img: document.getElementById('battleBgImg')?.getAttribute('src') || null,
    imgOpacity: getComputedStyle(document.getElementById('battleBgImg')).opacity,
    hasTableArt: document.getElementById('backdrop').classList.contains('hasTableArt'),
    tint: getComputedStyle(document.getElementById('backdrop'), '::before').opacity
  }));
  await pg.screenshot({ path: `/home/user/KKIv1.0/shots/v317/22_art_${id}.png` });
  await pg.evaluate(() => document.getElementById('btnMenu')?.click());
  await pg.waitForTimeout(400);
  return st;
}
console.log('TIDE (с вашим артом):', JSON.stringify(await battleWith('tide')));
console.log('ASH (без арта, CSS-образ):', JSON.stringify(await battleWith('ash')));
await b.close();
