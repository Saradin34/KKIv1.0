#!/usr/bin/env node
/* v3.16.1: фон боя — стабильность (не «прыгает») + яркость.
   1) стартуем бой (без авторизации, туториал пропущен);
   2) пока поле пустое, 4 кадра участка стола (left-marginal, без карт)
      в течение 5с, с перемещениями мыши между кадрами (триггер параллакса);
   3) полный скрин для оценки яркости.
   Сравнение кадров — tools/dev/v3161_bg_diff.py (PIL).
   Запуск: node tools/dev/v3161_bg_stability.mjs   (нужен сайт :5173) */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/home/user/shots/bgcheck';
mkdirSync(OUT, { recursive: true });
const REGION = { x: 60, y: 240, width: 160, height: 180 }; // участок стола без карт

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
// стартерная колода (starter_aurites) выбрана по умолчанию и валидна — НЕ менять
const playInfo = await pg.evaluate(() => { const bp = document.getElementById('btnPlay'); return { disabled: bp ? bp.disabled : 'NO_BTN', title: bp ? bp.title : null }; });
if (playInfo.disabled) { console.log('btnPlay DISABLED:', playInfo.title); await b.close(); process.exit(1); }
await pg.evaluate(() => { const ef=document.getElementById('enemyFaction'); if(ef) ef.value='Necrus'; const df=document.getElementById('difficulty'); if(df) df.value='0.8'; document.getElementById('btnPlay')?.click(); });
for (let i = 0; i < 60; i++) {
  const shown = await pg.evaluate("!document.getElementById('mulligan').classList.contains('hidden')");
  if (shown) break;
  await pg.waitForTimeout(200);
}
await pg.evaluate("document.getElementById('btnMullConfirm')?.click()");
await pg.waitForTimeout(1200);
const battleVisible = await pg.evaluate("!document.getElementById('battle').classList.contains('hidden')");
console.log('battle_visible:', battleVisible);
if (!battleVisible) { console.log('ERRORS:', errors); await b.close(); process.exit(1); }

// 4 кадра фона с движением мыши (старый параллакс реагировал на pointermove)
const pts = [[150, 150], [1450, 800], [200, 750], [1400, 200], [800, 450]];
for (let k = 0; k < 4; k++) {
  const p = pts[k];
  await pg.mouse.move(p[0], p[1], { steps: 8 });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: `${OUT}/frame${k}.png`, clip: REGION });
  if (k < 3) await pg.waitForTimeout(1000);
}
await pg.screenshot({ path: `${OUT}/battle_full.png` });

// индикаторы в DOM: есть ли зерно/виньетка, какие классы
const dom = await pg.evaluate(() => ({
  grain: !!document.getElementById('postGrain'),
  vignette: !!document.getElementById('postVignette'),
  grainAnim: document.getElementById('postGrain')?.style.animation || 'n/a',
  backdropAnims: [...document.querySelectorAll('#backdrop .bl, #backdrop .aurora, #backdrop .mist')].map(el => getComputedStyle(el).animationName),
}));
console.log('dom:', JSON.stringify(dom));
console.log('errors:', errors.length ? errors : 'none');
await b.close();
