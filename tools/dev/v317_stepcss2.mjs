import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1500);
const res = await pg.evaluate(() => {
  const n = document.getElementById('stepTrack');
  const out = [];
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch { continue; }
    const src = sh.href || 'inline';
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules) { walk(r.cssRules); continue; }
        if (!r.selectorText) continue;
        try {
          if (n.matches(r.selectorText) && r.style.position) out.push({ src, sel: r.selectorText.slice(0, 80), pos: r.style.position, media: r.parentRule?.conditionText || '' });
        } catch { /* no */ }
      }
    };
    walk(rules);
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await b.close();
