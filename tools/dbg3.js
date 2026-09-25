/* dbg3.js — реплей пользовательских кликов в jsdom: фракция, профиль, магазин, пропуск, кампания, обучение */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'prototype', 'index.html'), 'utf-8');
const js = fs.readFileSync(path.join(root, 'prototype', 'prototype.js'), 'utf-8');

const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
// «живая» мета пользователя (старая схема v2 + новые поля частично)
window.localStorage.setItem('ec_meta_v1', JSON.stringify({
  xp: 1240, wins: 9, losses: 6, mmr: 1108, packs: 7,
  facW: { Aurites: 5, Necrus: 2, Pyromancer: 2 }, facL: { Aurites: 3, Necrus: 2, Ethereal: 1 },
  history: [{ ts: Date.now() - 86400000, win: true, fac: 'Aurites', turns: 12 }],
  tutDone: true, campaign: { Necrus: true }, starter: true,
  backsOwned: ['classic', 'runes'], backEq: 'runes',
  questDate: new Date().toISOString().slice(0, 10),
  quests: [{ id: 'win_fac', prog: 1, goal: 2, claimed: false }, { id: 'runes', prog: 0, goal: 6, claimed: false }, { id: 'pack', prog: 0, goal: 1, claimed: false }],
  ach: { first_win: true }, bpClaimed: [1, 2],
  telem: [{ ts: Date.now(), fac: 'Aurites', win: true, turns: 12, secs: 300, played: [['aur_01', 2]], stuck: ['aur_05'] }],
}));
window.localStorage.setItem('echo-citadel.owned.v1', JSON.stringify({ aur_01: 2 }));
const errors = [];
window.addEventListener('error', e => errors.push('window.onerror: ' + (e.error?.stack || e.message)));
window.eval(js);

const $ = id => window.document.getElementById(id);
const click = n => { if (!n) { errors.push('нет узла для клика'); return; } n.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); };
const vis = id => $(id) && !$(id).classList.contains('hidden');

setTimeout(() => {
  const report = [];
  // 1. клик по карточке фракции Пироманты
  const fcards = [...window.document.querySelectorAll('.fcard')];
  report.push(`fcard-ов: ${fcards.length}`);
  const pyr = fcards.find(n => /Пироманты/.test(n.textContent));
  try { click(pyr); } catch (e) { errors.push('клик Пироманты: ' + e.stack); }
  report.push(`после клика Пироманты sel: ${[...window.document.querySelectorAll('.fcard')].findIndex(n => n.classList.contains('sel'))}`);
  // 2. кнопки меню
  for (const [bid, mid] of [['btnProfile', 'profileModal'], ['btnShop', 'shopModal'], ['btnBP', 'bpModal'], ['btnCampaign', 'campaignModal'], ['btnTour', 'tutModal'], ['btnBoosters', 'boosterModal'], ['btnCollection', 'collModal']]) {
    try {
      click($(bid));
      report.push(`${bid} → ${mid}: ${vis(mid) ? 'ОТКРЫТ' : 'ЗАКРЫТ'}`);
      const cls = $('btn' + bid.slice(3) + 'Close');
      if (cls) click(cls); else if ($(mid)) $(mid).classList.add('hidden');
    } catch (e) { errors.push(`${bid}: ` + e.stack); }
  }
  // 3. вкладки профиля
  try {
    click($('btnProfile'));
    for (const t of ['facs', 'hist', 'fr', 'gen']) {
      const b = [...window.document.querySelectorAll('.ptab')].find(x => x.dataset.ptab === t);
      click(b);
      report.push(`профиль таб ${t}: ${( $('profBody').textContent || '').length} симв.`);
    }
  } catch (e) { errors.push('вкладки профиля: ' + e.stack); }
  console.log(report.join('\n'));
  console.log(errors.length ? '\n=== ОШИБКИ ===\n' + errors.join('\n---\n') : '\n=== ОШИБОК НЕТ ===');
  process.exit(0);
}, 1200);
