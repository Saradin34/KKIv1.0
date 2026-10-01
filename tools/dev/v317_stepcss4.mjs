import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
await pg.addInitScript('window.EC_NO_AUTH_GATE=true');
await pg.goto('http://localhost:5173/');
await pg.waitForTimeout(1500);
const res = await pg.evaluate(() => {
  const n = document.getElementById('stepTrack');
  const sheets = [...document.styleSheets].map(sh => {
    let count = -1, sample = '';
    try {
      count = sh.cssRules.length;
      const found = [...sh.cssRules].find(r => r.selectorText && r.selectorText.includes('stepTrack'));
      sample = found ? found.cssText.slice(0, 120) : '';
    } catch (e) { sample = 'ERR: ' + e.message; }
    return { src: (sh.href || 'inline').slice(-40), count, sample };
  });
  return { testDirect: n.matches('.stepTrack'), sheets };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
