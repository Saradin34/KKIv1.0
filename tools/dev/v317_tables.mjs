import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(700);
await pg.evaluate(() => { const m = JSON.parse(localStorage.getItem('ec_meta_v1') || '{}'); m.tutDone = true; m.shards = 10000; m.gems = 5000; localStorage.setItem('ec_meta_v1', JSON.stringify(m)); localStorage.setItem('ec_shards_v1', '10000'); });
await pg.reload(); await pg.waitForTimeout(1500);
await pg.evaluate(() => document.getElementById('tourOverlay')?.classList.add('hidden'));

async function equip(id) {
  await pg.evaluate(() => document.querySelector('.topTab[data-tab="store"]').click());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => document.querySelector('.stab[data-stab="cosm"]')?.click());
  await pg.waitForTimeout(500);
  const ok = await pg.evaluate((id) => {
    const btn = document.querySelector(`.tableBtn[data-id="${id}"]`);
    if (!btn) return { ok: false, where: 'no button' };
    btn.click();
    return { ok: true, label: btn.textContent.trim() };
  }, id);
  await pg.waitForTimeout(500);
  const state = await pg.evaluate(() => ({
    table: document.body.dataset.table,
    meta: JSON.parse(localStorage.getItem('ec_meta_v1') || '{}').tableSkin,
    owned: JSON.parse(localStorage.getItem('ec_meta_v1') || '{}').tablesOwned
  }));
  // в бой
  await pg.evaluate(() => { document.getElementById('shopModal')?.classList.add('hidden'); document.querySelector('.topTab[data-tab="home"]')?.click(); });
  await pg.waitForTimeout(400);
  await pg.evaluate(() => { const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus'; document.getElementById('btnPlay')?.click(); });
  for (let i = 0; i < 60; i++) { const s = await pg.evaluate(() => !document.getElementById('mulligan').classList.contains('hidden')); if (s) break; await pg.waitForTimeout(200); }
  await pg.evaluate(() => document.getElementById('btnMullConfirm')?.click());
  await pg.waitForTimeout(1600);
  const bg = await pg.evaluate(() => ({
    tint: getComputedStyle(document.getElementById('backdrop'), '::before').opacity,
    hasTableArt: document.getElementById('backdrop').classList.contains('hasTableArt'),
    img: document.getElementById('battleBgImg')?.getAttribute('src') || null
  }));
  const shot = `/home/user/KKIv1.0/shots/v317/20_table_${id}.png`;
  await pg.screenshot({ path: shot });
  // выйти в меню
  await pg.evaluate(() => document.getElementById('btnMenu')?.click());
  await pg.waitForTimeout(500);
  return { id, ...ok, ...state, ...bg, shot };
}

const results = [];
for (const id of ['classic', 'ash', 'tide', 'grove', 'aurum', 'terra', 'necro']) results.push(await equip(id));
for (const r of results) console.log(JSON.stringify(r));

// попиксельное сравнение «поле боя» (центр экрана, без доков)
const { execSync } = await import('child_process');
execSync(`python3 - << 'PY'
from PIL import Image, ImageChops
import itertools, math
ids = ['classic','ash','tide','grove','aurum','terra','necro']
imgs = {}
for i in ids:
    im = Image.open(f'/home/user/KKIv1.0/shots/v317/20_table_{i}.png').convert('RGB')
    imgs[i] = im.crop((300, 250, 1300, 750))
base = imgs['classic']
for i in ids:
    if i == 'classic': continue
    diff = ImageChops.difference(base, imgs[i])
    h = diff.histogram()
    total = sum(sum(h[c*256 + v]*v for v in range(256)) for c in range(3)) / (3*1000*500)
    print(f'delta classic→{i}: {total:.1f} (0-255) {"OK" if total > 4 else "МЕРТВЫЙ"}')
PY`);
await b.close();
