const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('prototype/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, url: 'http://localhost:5173/' });
const w = dom.window;
w.addEventListener('error', e => console.log('page error:', e.message));
setTimeout(() => {
  const b = w.__battle;
  if (!b) { console.log('FAIL: __battle нет'); process.exit(1); }
  b.playerFaction = 'Aurites'; b.playerDeckId = 'Aurites'; b.enemyFaction = 'Necrus';
  b.start().then(() => {
    setTimeout(() => {
      const imgs = [...w.document.querySelectorAll('#hand .cart svg image')].map(i => i.getAttribute('href'));
      const zoom = w.document.getElementById('zoomPreview');
      const set = w.document.getElementById('settingsPanel');
      console.log('арт-слоёв в руке:', imgs.length);
      console.log('пример href:', imgs.slice(0, 3).join(' | '));
      console.log('все href начинаются с /art/:', imgs.length > 0 && imgs.every(h => h && h.startsWith('/art/')));
      console.log('контейнер предпросмотра:', !!zoom, '| панель настроек:', !!set, '| кнопка ⚙:', !!w.document.getElementById('btnSettings'));
      const why = w.document.querySelectorAll('#hand .whyNot').length;
      console.log('подсказок «почему нельзя» в руке:', why);
      process.exit(0);
    }, 900);
  }).catch(e => { console.log('start error', e); process.exit(1); });
}, 1200);
