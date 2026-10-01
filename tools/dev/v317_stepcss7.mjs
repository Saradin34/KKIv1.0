import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1500);
const res = await pg.evaluate(() => {
  const n = document.getElementById('stepTrack');
  const out = [];
  const scan = (list, media) => {
    for (const r of list) {
      if (r.type === 4 || r.type === 6) { scan(r.cssRules, media ? media : (r.conditionText || r.media?.mediaText || '')); continue; }
      const sel = r.selectorText;
      if (!sel) continue;
      try {
        if (n.matches(sel)) out.push({ sel: sel.slice(0, 90), pos: r.style.position, disp: r.style.display, media: media || '' });
      } catch {}
    }
  };
  for (const sh of document.styleSheets) { try { scan(sh.cssRules, ''); } catch {} }
  return { computed: { pos: getComputedStyle(n).position, disp: getComputedStyle(n).display }, rules: out };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
