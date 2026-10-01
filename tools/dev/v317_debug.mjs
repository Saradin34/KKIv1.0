import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
pg.on('pageerror', e => console.log('PAGEERROR:', e.message));
pg.on('console', m => { if (m.type() === 'error') console.log('CONSOLE_ERR:', m.text().slice(0, 200)); });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1200);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1800);
await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')");
console.log('menu state:', await pg.evaluate(`() => ({
  menu: !document.getElementById('menu')?.classList.contains('hidden'),
  btnPlay: !!document.getElementById('btnPlay'),
  enemyFaction: !!document.getElementById('enemyFaction'),
  subs: document.getElementById('subsLine')?.textContent || ''
})`));
await pg.evaluate(`() => {
  const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus';
  const df = document.getElementById('difficulty'); if (df) df.value = '0.8';
  document.getElementById('btnPlay')?.click();
}`);
for (let i = 0; i < 30; i++) {
  await pg.waitForTimeout(400);
  const st = await pg.evaluate(`() => ({
    mulligan: !document.getElementById('mulligan')?.classList.contains('hidden'),
    battle: !document.getElementById('battle')?.classList.contains('hidden'),
    subs: document.getElementById('subsLine')?.textContent || '',
    toast: document.querySelector('.toast')?.textContent || ''
  })`);
  if (st.mulligan || st.battle) { console.log('after', i, 'steps:', JSON.stringify(st)); break; }
}
await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/debug.png' });
await b.close();
