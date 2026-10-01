import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; const df = document.getElementById('difficulty'); if (df) df.value = '0.8'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1200);
const r = await pg.evaluate(() => {
  const n = document.getElementById('playerHero');
  const st = getComputedStyle(n);
  const mw = n.querySelector('.medalWrap'); const mst = mw ? getComputedStyle(mw) : null;
  return {
    barBg: st.backgroundImage.slice(0, 60), barBgColor: st.backgroundColor, barPos: st.position, barZ: st.zIndex, barPE: st.pointerEvents,
    mwPos: mst?.position, mwZ: mst?.zIndex, mwTf: mst?.transform
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
