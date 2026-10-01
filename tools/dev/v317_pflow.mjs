import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => {
  const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}');
  m.tutDone = true; m.shards = 10000; m.gems = 5000; m.tablesOwned = ['tide', 'grove'];
  localStorage.setItem('ec_meta_v1', JSON.stringify(m));
});
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

// --- 1. ПРОФИЛЬ: клик по чипу стола надевает его (не предпросмотр) ---
await pg.evaluate(() => window.ecNavigate && window.ecNavigate('profile'));
await pg.waitForTimeout(600);
let r = await pg.evaluate(() => {
  if (document.getElementById('profileModal')?.classList.contains('hidden') || !document.getElementById('profileModal')) {
    // запасной путь — значок профиля
    document.querySelector('.topTab[data-tab="profile"]')?.click();
  }
  return true;
});
await pg.waitForTimeout(400);
await pg.evaluate(() => document.querySelector('.ptab[data-ptab="cosm"]')?.click());
await pg.waitForTimeout(400);
const chipInfo = await pg.evaluate(() => {
  const chips = [...document.querySelectorAll('.cosmSkinChip[data-kind="table"]')];
  return chips.map(c => ({ id: c.dataset.id, sel: c.classList.contains('sel'), locked: c.classList.contains('locked') }));
});
const equip1 = await pg.evaluate(() => {
  document.querySelector('.cosmSkinChip[data-kind="table"][data-id="tide"]')?.click();
  return true;
});
await pg.waitForTimeout(500);
const afterEquip = await pg.evaluate(() => ({
  table: document.body.dataset.table,
  meta: JSON.parse(localStorage.getItem('ec_meta_v1') || '{}').tableSkin,
  previewOpen: !document.getElementById('cosmPreview')?.classList.contains('hidden'),
  toast: [...document.querySelectorAll('div')].find(d => d.className?.toString?.().includes('toast'))?.textContent?.slice(0, 40) ?? null,
  selChip: document.querySelector('.cosmSkinChip.sel[data-kind="table"]')?.dataset.id
}));
// заблокированный чип → предпросмотр
const lockedPrev = await pg.evaluate(() => {
  const c = document.querySelector('.cosmSkinChip.locked[data-kind="table"]');
  if (!c) return 'no-locked-chip';
  c.click();
  return true;
});
await pg.waitForTimeout(400);
const prevState = await pg.evaluate(() => !document.getElementById('cosmPreview')?.classList.contains('hidden'));
await pg.evaluate(() => document.getElementById('cosmPrevClose')?.click() || document.getElementById('cosmPreview')?.classList.add('hidden'));
console.log('PROFILE:', JSON.stringify({ chipInfo, afterEquip, lockedPrev, previewOpenedForLocked: prevState }));

// --- 2. БОЙ: стол применяется ---
await pg.evaluate(() => { document.getElementById('profileModal')?.classList.add('hidden'); });
await pg.waitForTimeout(300);
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1500);
const battle1 = await pg.evaluate(() => ({
  tint: getComputedStyle(document.getElementById('backdrop'), '::before').opacity,
  img: document.getElementById('battleBgImg')?.getAttribute('src') || null
}));
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/21_profile_tide.png' });

// --- 3. «Ещё бой»: стол применяется заново ---
await pg.evaluate(() => {
  const bt = window.__battle; const e = bt.engine;
  e.p(1).health = 1;
  e.damageHero(1, 99, { source: 'test-gameover' });
});
for (let i = 0; i < 40; i++) { const s = await pg.evaluate(() => !document.getElementById('gameover').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnAgain')?.click());
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1500);
const battle2 = await pg.evaluate(() => ({
  tint: getComputedStyle(document.getElementById('backdrop'), '::before').opacity,
  img: document.getElementById('battleBgImg')?.getAttribute('src') || null,
  table: document.body.dataset.table
}));
console.log('BATTLE:', JSON.stringify({ battle1, afterAgain: battle2 }));
await b.close();
