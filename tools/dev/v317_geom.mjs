import { chromium } from 'playwright';
const b = await chromium.launch();
const VPS = [ [1600,900], [1254,599], [1218,576], [1366,700], [1024,640] ];
for (const [vw, vh] of VPS) {
  const pg = await b.newPage({ viewport: { width: vw, height: vh } });
  await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
  await pg.goto('http://localhost:5173/');
  await pg.waitForTimeout(700);
  await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
  await pg.reload(); await pg.waitForTimeout(1300);
  await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
  await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
  for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
  await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
  await pg.waitForTimeout(1200);
  // 6 карт: завершить ход, дождаться своего второго хода
  await pg.evaluate(() => document.getElementById('btnEndTurn')?.click());
  for (let i = 0; i < 100; i++) {
    const s = await pg.evaluate(() => ({ n: document.querySelectorAll('#hand .card').length, mine: (document.getElementById('actionHint')?.textContent ?? '').startsWith('Перетащите') }));
    if (s.mine && s.n >= 6) break;
    await pg.waitForTimeout(300);
  }
  const g = await pg.evaluate(() => {
    const r = sel => { const n = document.querySelector(sel); if (!n) return null; const bb = n.getBoundingClientRect(); return { y: +bb.y.toFixed(1), bot: +(bb.y+bb.height).toFixed(1), h: +bb.height.toFixed(1) }; };
    const battle = document.getElementById('battle');
    const H = parseFloat(getComputedStyle(battle).getPropertyValue('--hand-card-h'));
    const card = document.querySelector('#hand .card');
    const cs = getComputedStyle(card);
    const cards = [...document.querySelectorAll('#hand .card')].map(c => c.getBoundingClientRect().top);
    const name = r('#playerHero .medalName'); const med = r('#playerHero .medal');
    const bar = r('#playerHero');
    return { vh: innerHeight, H: +H.toFixed(1), cardH: +parseFloat(cs.height).toFixed(1), cardW: +parseFloat(cs.width).toFixed(1),
      barBot: bar.bot, expectBarBot: +(innerHeight - (H*.92+22)).toFixed(1),
      medBot: med?.bot, nameBot: name?.bot, cardTop: +Math.min(...cards).toFixed(1), n: cards.length };
  });
  const gap = +(g.cardTop - (g.nameBot ?? 0)).toFixed(1);
  console.log(`${vw}x${vh}: H=${g.H} cardH=${g.cardH} cardW=${g.cardW} n=${g.n} | barBot=${g.barBot} expect=${g.expectBarBot} | medalBot=${g.medBot} nameBot=${g.nameBot} cardTop=${g.cardTop} GAP=${gap} ${gap >= 8 ? 'OK' : 'FAIL'}`);
  if (vw === 1254) await pg.screenshot({ path: '/home/user/KKIv1.0/shots/v317/16_user6.png' });
  await pg.close();
}
await b.close();
