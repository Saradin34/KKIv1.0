import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1500);
const res = await pg.evaluate(() => {
  const n = document.getElementById('stepTrack');
  const sh = [...document.styleSheets].find(s => s.href === null); // first inline
  const rules = sh.cssRules;
  let total = 0, withSel = 0, matched = [], posRules = [], err = 0;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    total++;
    if (r.cssRules) continue; // не рекурсия — плоский уровень
    if (r.selectorText) {
      withSel++;
      try {
        if (n.matches(r.selectorText)) {
          matched.push(r.selectorText.slice(0, 60));
          if (r.style.position) posRules.push({ sel: r.selectorText.slice(0, 60), pos: r.style.position });
        }
      } catch (e) { err++; }
    }
  }
  // отдельно: все правила с position, содержащие 'stepTrack' в селекторе (рекурсивно через поиск cssText)
  const allPosStep = [];
  const scan = (list) => { for (const r of list) { if (r.cssRules) { scan(r.cssRules); continue; } if (r.cssText && r.cssText.includes('stepTrack') && r.cssText.includes('position')) allPosStep.push(r.cssText.slice(0, 140)); } };
  for (const s of document.styleSheets) { try { scan(s.cssRules); } catch {} }
  return { total, withSel, matched, posRules, err, allPosStep };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
