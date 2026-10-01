import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1500);
const res = await pg.evaluate(() => {
  const sh = [...document.styleSheets].find(s => s.href === null);
  const rules = sh.cssRules;
  const info = [];
  for (let i = 0; i < Math.min(6, rules.length); i++) {
    const r = rules[i];
    info.push({ i, ctor: r.constructor.name, type: r.type, hasCssRules: !!r.cssRules, sel: r.selectorText ? String(r.selectorText).slice(0, 40) : null, css: String(r.cssText || '').slice(0, 60) });
  }
  const idx = [];
  for (let i = 0; i < rules.length; i++) { try { if (String(rules[i].cssText).includes('stepTrack')) idx.push(i); } catch {} }
  const st = idx.map(i => ({ i, css: String(rules[i].cssText).slice(0, 150) }));
  return { info, stepTrackIdx: idx.slice(0, 5), st };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
