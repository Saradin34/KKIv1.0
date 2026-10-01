// v3.17: аудит боевки — скрины фаз, метрики симметрии, «Атака всеми»
import { chromium } from 'playwright';

const SH = '/home/user/KKIv1.0/shots/v317';
const out = { errors: [], checks: {} };
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
pg.on('pageerror', e => out.errors.push('pageerror: ' + e.message));
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(900);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); });
await pg.reload(); await pg.waitForTimeout(1600);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));
await pg.evaluate(() => {
  const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus';
  const df = document.getElementById('difficulty'); if (df) df.value = '0.8';
  document.getElementById('btnPlay')?.click();
});
let mull = false;
for (let i = 0; i < 60; i++) {
  mull = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden'));
  if (mull) break;
  await pg.waitForTimeout(200);
}
out.checks.mulligan = mull;
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1400);
out.checks.battle_visible = await pg.evaluate(() => !document.getElementById('battle').classList.contains('hidden'));

// заполнить поле существами (симметрия)
await pg.evaluate(() => {
  const B = window.__battle, e = B.engine;
  for (const sd of [0, 1]) {
    const pl = e.p(sd);
    const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3);
    for (const id of ids) e.summon(sd, e.db.get(id));
    pl.creatures.forEach(c => { c.justPlayed = false; c.attacksThisTurn = 0; });
  }
  B.renderAll();
});
await pg.waitForTimeout(600);

// ── метрики «карт на поле» ──
out.checks.factionLabels = await pg.evaluate(() => ({
  enemy: document.getElementById('enemyFac').textContent,
  player: document.getElementById('playerFac').textContent,
  enemyTitleLen: (document.getElementById('enemyFac').title || '').length
}));
out.checks.sizes = await pg.evaluate(() => {
  const r = sel => { const n = document.querySelector(sel); if (!n) return null; const bb = n.getBoundingClientRect(); return { w: +bb.width.toFixed(1), h: +bb.height.toFixed(1), x: +bb.x.toFixed(1), y: +bb.y.toFixed(1) }; };
  return {
    unit: r('#playerBoard .unit'),
    enemyBack: r('#enemyBacks .cardback'),
    enemyBackCount: document.querySelectorAll('#enemyBacks .cardback').length,
    graveRow: r('#playerGraveZone'),
    deckBack: r('#playerDeckPile .cardback'),
    handCard: r('#hand .card')
  };
});
out.checks.handBottom = await pg.evaluate(() => {
  const cards = [...document.querySelectorAll('#hand .card')]; if (!cards.length) return null;
  const c = cards[Math.floor(cards.length / 2)]; // центральная (без поворота веера)
  const r = c.getBoundingClientRect(); return { bottom: +r.bottom.toFixed(1), top: +r.top.toFixed(1), vh: innerHeight, visiblePct: +((innerHeight - r.top) / r.height * 100).toFixed(0) };
});
out.checks.corners = await pg.evaluate(() => {
  const r = id => { const n = document.getElementById(id); const bb = n.getBoundingClientRect(); return { x: +bb.x.toFixed(1), y: +bb.y.toFixed(1), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) }; };
  return { enemyCorner: r('enemyCorner'), playerCorner: r('playerCorner') };
});
await pg.screenshot({ path: SH + '/01_board_main.png' });

// ── фаза боя: завершить ход → окно атак ──
await pg.evaluate(() => document.getElementById('btnEndTurn')?.click());
const t0 = Date.now();
let inCombat = false;
while (Date.now() - t0 < 20000) {
  inCombat = await pg.evaluate(() => window.__battle?.inCombatWindow === true);
  if (inCombat) break;
  await pg.waitForTimeout(250);
}
out.checks.inCombatWindow = inCombat;
if (inCombat) {
  await pg.waitForTimeout(900);
  out.checks.btnAttackAll_visible = await pg.evaluate(() => !document.getElementById('btnAttackAll').classList.contains('hidden'));
  out.checks.readyCount = await pg.evaluate(() => document.querySelectorAll('#playerBoard .unit.ready').length);
  await pg.screenshot({ path: SH + '/02_combat_window.png' });

  if (out.checks.btnAttackAll_visible) {
    await pg.evaluate(() => document.getElementById('btnAttackAll').click());
    await pg.waitForTimeout(450);
    out.checks.mass_hint = await pg.evaluate(() => document.getElementById('actionHint').textContent);
    out.checks.mass_selected = await pg.evaluate(() => window.__battle.pendingAttack !== null);
    out.checks.targets_highlighted = await pg.evaluate(() => document.querySelectorAll('#enemyBoard .unit.targetable, #enemyHero.droppable').length);
    await pg.screenshot({ path: SH + '/03_mass_attack_targeting.png' });

    const heroOk = await pg.evaluate(() => document.getElementById('enemyHero').classList.contains('droppable'));
    if (heroOk) await pg.evaluate(() => document.getElementById('enemyHero').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    else await pg.evaluate(() => document.querySelector('#enemyBoard .unit')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await pg.waitForTimeout(1600);
    out.checks.after_attack = await pg.evaluate(() => ({ mass: window.__battle.massAttack, pending: window.__battle.pendingAttack, hint: document.getElementById('actionHint').textContent }));
    await pg.screenshot({ path: SH + '/04_mass_after_first.png' });

    for (let i = 0; i < 6; i++) {
      const st = await pg.evaluate(() => ({
        mass: window.__battle.massAttack,
        pending: window.__battle.pendingAttack,
        hero: document.getElementById('enemyHero').classList.contains('droppable'),
        unit: !!document.querySelector('#enemyBoard .unit.targetable')
      }));
      if (!st.mass || st.pending === null) break;
      if (st.hero) await pg.evaluate(() => document.getElementById('enemyHero').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      else if (st.unit) await pg.evaluate(() => document.querySelector('#enemyBoard .unit.targetable').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      else break;
      await pg.waitForTimeout(1700);
    }
    out.checks.mass_final = await pg.evaluate(() => ({ mass: window.__battle.massAttack, inCombat: window.__battle.inCombatWindow }));
    await pg.screenshot({ path: SH + '/05_mass_done.png' });
  }
}

// ── тёмные оверлеи ──
await pg.waitForTimeout(800);
out.checks.darkCheck = await pg.evaluate(() => {
  const W = innerWidth, H = innerHeight;
  const bad = [];
  for (const el of document.body.children) {
    if (!el.getBoundingClientRect) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || parseFloat(st.opacity) < 0.45) continue;
    const r = el.getBoundingClientRect();
    if (r.width < W * 0.55 || r.height < H * 0.55) continue;
    const m = st.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) continue;
    const a = m[4] === undefined ? 1 : +m[4];
    if (a < 0.45) continue;
    const lum = (0.2125 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) * a;
    if (lum <= 55 && el.id !== 'backdrop' && el.id !== 'tableSurface') bad.push({ id: el.id, lum: Math.round(lum) });
  }
  return bad;
});

await pg.screenshot({ path: SH + '/06_final.png' });
await b.close();
console.log(JSON.stringify(out, null, 1));
