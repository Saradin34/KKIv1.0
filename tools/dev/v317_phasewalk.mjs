// v3.17: фазовый облёт — авто-ходы + пиксельная выборка центра/углов на тёмные кадры
import { chromium } from 'playwright';

const out = { errors: [], dark: [], minLum: 255, frames: 0 };
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
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(1400);
// существа на поле для «живого» боя
await pg.evaluate(() => {
  const B = window.__battle, e = B.engine;
  for (const sd of [0, 1]) {
    const pl = e.p(sd);
    const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3);
    for (const id of ids) e.summon(sd, e.db.get(id));
    pl.creatures.forEach(c => { c.justPlayed = false; });
  }
  B.renderAll();
});

// ин-пейдж сэмплер: base64 скрин центра → canvas → средняя люм + доля тёмных пикселей
const sample = async () => {
  const buf = await pg.screenshot({ clip: { x: 550, y: 150, width: 500, height: 600 } });
  const b64 = buf.toString('base64');
  return await pg.evaluate(async (data) => {
    try {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0, dark = 0;
      for (let i = 0; i < d.length; i += 16) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l; if (l < 60) dark++;
      }
      return { lum: +(sum / (d.length / 16)).toFixed(1), darkPct: +(dark / (d.length / 16) * 100).toFixed(1) };
    } catch { return null; }
  }, b64);
};

const T0 = Date.now();
let lastEnd = 0;
while (Date.now() - T0 < 45000) {
  const s = await sample();
  if (s) {
    out.frames++;
    out.minLum = Math.min(out.minLum, s.lum);
    if (s.lum < 100) {
      out.dark.push({ t: +((Date.now() - T0) / 1000).toFixed(1), ...s });
    }
  }
  // авто-прокачка: окно боя → авто-бой (разыграть атаки); основная → завершить ход
  const st = await pg.evaluate(() => ({
    inCombat: window.__battle?.inCombatWindow === true,
    canEnd: (() => { const et = document.getElementById('btnEndTurn'); return et && !et.disabled && !et.classList.contains('hidden'); })()
  }));
  if (st.inCombat && Date.now() - lastEnd > 500) {
    lastEnd = Date.now();
    await pg.evaluate(() => {
      const b = document.getElementById('btnAutoBattle');
      if (b && !b.classList.contains('hidden')) b.click();
    });
  } else if (st.canEnd && Date.now() - lastEnd > 900) {
    lastEnd = Date.now();
    await pg.evaluate(() => document.getElementById('btnEndTurn')?.click());
  }
  await pg.waitForTimeout(120);
}
// журнал тёмных оверлеев из watchdog
out.watchdogLog = await pg.evaluate(() => localStorage.getItem('ec_darklog') || 'none');
out.battleVisible = await pg.evaluate(() => !document.getElementById('battle').classList.contains('hidden'));
await b.close();
console.log(JSON.stringify(out, null, 1));
