#!/usr/bin/env node
/* v3.17: охота за «чёрным экраном» в бою.
   Стартуем бой, авто-завершение ходов (триггер фаз), кадры каждые ~150мс;
   тёмные кадры (люм < 60) — фиксация + дамп тёмных оверлеев. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/home/user/shots/blackhunt';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
pg.on('pageerror', e => errors.push(String(e)));
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/', { waitUntil: 'load' });
await pg.waitForTimeout(900);
await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()");
await pg.reload();
await pg.waitForTimeout(1600);
await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')");
await pg.evaluate(() => { document.getElementById('btnPlay').click(); });
await pg.waitForTimeout(1800);
await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
await pg.waitForTimeout(800);
console.log('battle:', await pg.evaluate(() => !document.getElementById('battle').classList.contains('hidden')));

// авто-смена ходов: жмём «Завершить ход», когда доступно (триггер фаз)
await pg.evaluate(() => {
  window.__clickerTimer = setInterval(() => {
    const b2 = document.getElementById('btnEndTurn');
    if (b2 && !b2.disabled && document.getElementById('battle').offsetWidth > 0) b2.click();
  }, 700);
});

const lumOf = async () => {
  const buf = await pg.screenshot({ type: 'png', clip: { x: 0, y: 90, width: 1600, height: 660 } });
  return pg.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 16 * 4) { s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    return s / n;
  }, buf.toString('base64'));
};

let darkFrames = 0, i = 0;
const lums = [];
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  const lum = await lumOf();
  lums.push(lum);
  if (lum < 60) {
    darkFrames++;
    await pg.screenshot({ path: `${OUT}/dark_${i}.png` });
    const dbg = await pg.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 800 || r.height < 400) continue;
        const m = cs.backgroundColor.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
        if (!m) continue;
        const a = m[4] === undefined ? 1 : +m[4];
        const lumBg = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
        if (a > 0.5 && lumBg < 60) out.push(`${el.id || el.className.toString().slice(0, 24)} z=${cs.zIndex} a=${a} lum=${lumBg.toFixed(0)}`);
      }
      return out;
    });
    const state = await pg.evaluate(() => ({ phase: document.querySelector('.pstep.active')?.textContent, who: document.getElementById('whoTurn')?.textContent }));
    console.log(`T+${((Date.now() - t0) / 1000).toFixed(1)}s люм=${lum.toFixed(1)} ТЁМНЫЙ! оверлеи: ${JSON.stringify(dbg)} state: ${JSON.stringify(state)}`);
  }
  i++;
  await pg.waitForTimeout(150);
}
await pg.evaluate('clearInterval(window.__clickerTimer)');
const min = Math.min(...lums), max = Math.max(...lums);
const below80 = lums.filter(l => l < 80).length;
console.log(`кадров: ${i}, тёмных(<60): ${darkFrames}, ниже80: ${below80}, люм min=${min.toFixed(1)} max=${max.toFixed(1)}`);
console.log('pageerrors:', errors.length ? errors : 'none');
await b.close();
