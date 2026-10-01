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
await pg.waitForTimeout(1400);
const g = await pg.evaluate(() => {
  const r = sel => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); const z = getComputedStyle(n).zIndex; return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), z, cx: +(b.x + b.width/2).toFixed(1), cy: +(b.y + b.height/2).toFixed(1) }; };
  const cards = [...document.querySelectorAll('#hand .card')].map(c => { const b = c.getBoundingClientRect(); return { cx: +(b.x + b.width/2).toFixed(0), top: +b.top.toFixed(0), bottom: +b.bottom.toFixed(0) }; });
  return {
    playerHeroBar: r('#playerHero'),
    playerMedalWrap: r('#playerHero .medalWrap'),
    playerMedal: r('#playerHero .medal'),
    playerMedalName: r('#playerHero .medalName'),
    playerHp: r('#playerHero .hbHp'),
    enemyHeroBar: r('#enemyHero'),
    enemyMedalWrap: r('#enemyHero .medalWrap'),
    enemyMedal: r('#enemyHero .medal'),
    enemyBacks: r('#enemyBacks'),
    enemyBacksFirst: r('#enemyBacks .cardback:first-child'),
    enemyBackCount: document.querySelectorAll('#enemyBacks .cardback').length,
    handCards: cards,
    handArea: r('#handArea'),
    vh: innerHeight
  };
});
console.log(JSON.stringify(g, null, 1));
await b.close();
