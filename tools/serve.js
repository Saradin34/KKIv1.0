/* =====================================================================
   Статический сервер прототипа «Эхо-Цитадель».
   ---------------------------------------------------------------------
   Отдаёт prototype/index.html + prototype.js на 0.0.0.0 (нужно для
   live-preview песочницы). Без зависимостей.

   Дополнительно монтирует папку артов:
       /art/<Faction>/<id>.png  →  unity/EchoCitadel/Assets/Resources/Cards/<Faction>/<id>.png
   То есть художник кладёт PNG в папку фракции внутри Unity-проекта —
   и прототип в браузере подхватывает его без копирования и пересборки.
   Пока файла нет, карта рисуется процедурной заглушкой (src/ui/art.ts).

   Запуск: node tools/serve.js [--port 5173]
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'prototype');
const ART_ROOT = path.resolve(__dirname, '..', 'unity', 'EchoCitadel', 'Assets', 'Resources', 'Cards');
// Drop-in папки художника: файл art_raw/<id>.png подхватывается сразу, без копирования.
// Приоритет: art_raw (свежийドロップ) → Resources/Cards (нормализованные для Unity).
const RAW_DIRS = [path.resolve(__dirname, '..', 'art_raw'), path.resolve(__dirname, '..', '..', 'art_raw')];
const RAW_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

/** Варианты имени: aur_2 → aur_02 (и обратно), чтобы опечатки в цифрах не ломали маппинг. */
function idVariants(idBase) {
  const out = [idBase];
  const m = idBase.match(/^([a-zA-Z]+)_(\d{1,2})$/);
  if (m) {
    out.push(m[1] + '_' + String(Number(m[2])).padStart(2, '0'));
    out.push(m[1] + '_' + String(Number(m[2])));
  }
  return out;
}

/** Ищет дропнутый файл арта: art_raw/<id>{.png|.jpg|.jpeg|.webp}. */
function findRawArt(idBase) {
  for (const dir of RAW_DIRS) {
    for (const cand of idVariants(idBase)) {
      for (const ext of RAW_EXT) {
        const p = path.join(dir, cand + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch { /* нет файла — пробуем дальше */ }
      }
    }
  }
  return null;
}
const i = process.argv.indexOf('--port');
const PORT = Number(i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Безопасное соединение: не выпускает запрос за пределы базового каталога. */
function safeJoin(base, urlPath) {
  const rel = path.normalize(urlPath).replace(/^([/\\])+/, '').replace(/^(\.\.[/\\])+/, '');
  const full = path.join(base, rel);
  return full.startsWith(base) ? full : null;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // /art/… → папка артов внутри Unity-проекта (одна копия файлов на все клиенты)
  if (urlPath.startsWith('/locale/')) {
    const f = safeJoin(path.resolve(__dirname, '..', 'data', 'locale'), urlPath.slice('/locale/'.length));
    if (!f) return send(res, 403, '403: Forbidden');
    fs.readFile(f, (err, data) => {
      if (err) return send(res, 404, '404: ' + urlPath);
      send(res, 200, data, 'application/json; charset=utf-8');
    });
    return;
  }

  if (urlPath.startsWith('/art/') || urlPath === '/art') {
    const rel = urlPath.slice('/art'.length) || '/';
    const idBase = path.basename(rel).replace(/\.[^.]*$/, '');
    const raw = idBase ? findRawArt(idBase) : null;          // 1) свежий файл из art_raw
    const proc = safeJoin(path.resolve(__dirname, '..', '_processed', 'cards'), rel); // 2) пайплайн-нормализация
    const file = raw ?? (proc && fs.existsSync(proc) ? proc : null) ?? safeJoin(ART_ROOT, rel); // 3) арт Unity
    if (!file) return send(res, 403, '403: Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, '404: ' + urlPath);
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
    return;
  }

  // /heroes/<Faction> — аватар героя из папки художника art_raw/heroes/<Faction>/ (любой png/jpg)
  if (urlPath.startsWith('/heroes/')) {
    const name = urlPath.slice('/heroes/'.length).replace(/[^a-zA-Zа-яА-я0-9_-]/g, '');
    let file = null;
    const roots = [
      path.resolve(__dirname, '..', 'art_raw', 'heroes'),
      path.resolve(__dirname, '..', '..', 'art_raw', 'heroes'),
    ];
    for (const base of roots) {
    const dir = path.join(base, name);
    if (dir.startsWith(base) && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const inside = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()[0];
      if (inside) file = path.join(dir, inside);
    }
    if (!file) {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const cand = path.join(base, name + ext);
        if (cand.startsWith(base) && fs.existsSync(cand)) { file = cand; break; }
      }
    }
    if (file) break;
    }
    if (!file) return send(res, 404, '404: аватар героя не найден (положите png в art_raw/heroes/' + name + '/)');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, '404: ' + urlPath);
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
    return;
  }

  // /cosm/<kind>/<id> — арт косметики и ключ-арты наборов (v2.5.3, hardened v2.5.4).
  // Ищем: art_raw/cosm/<kind>/<id>.<ext> (регистр НЕ важен) → подпапка <id>/ (первый кадр)
  // → Unity-зеркало Assets/Resources/Cosm/<Kind>/. Имя файла берётся из readdir — traversal исключён.
  if (urlPath.startsWith('/cosm/')) {
    const COSM_KINDS = ['backs', 'tables', 'runes', 'offers', 'bundles', 'bp', 'quests'];
    const parts = urlPath.slice('/cosm/'.length).split('/');
    const kind = (parts[0] || '').replace(/[^a-z]/g, '');
    const id = (parts[1] || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!COSM_KINDS.includes(kind) || !id) return send(res, 404, '404: формат /cosm/<kind>/<id>, kind: ' + COSM_KINDS.join('|'));
    const EXT_RE = /\.(png|jpe?g|webp)$/i;
    // v2.5.4: имя файла нормализуется — отбрасывается ЛЮБАЯ цепочка расширений
    // (classic.png.png → classic) и все разделители (pack aurites.PNG → pack_Aurites).
    const norm = s => s.toLowerCase().replace(/(?:\.[a-z0-9]+)+$/, '').replace(/[^a-z0-9]/g, '');
    const idN = norm(id);
    const roots = RAW_DIRS.map(d => path.join(d, 'cosm', kind));
    const cap = kind[0].toUpperCase() + kind.slice(1);
    roots.push(path.resolve(__dirname, '..', 'unity', 'EchoCitadel', 'Assets', 'Resources', 'Cosm', cap));
    let file = null;
    for (const base of roots) {
      let entries = [];
      try { entries = fs.readdirSync(base); } catch { continue; }
      const direct = entries.find(f => {
        const p = path.join(base, f);
        return EXT_RE.test(f) && norm(f) === idN && fs.statSync(p).isFile();
      });
      if (direct) { file = path.join(base, direct); break; }
      const sub = entries.find(f => norm(f) === idN && fs.statSync(path.join(base, f)).isDirectory());
      if (sub) {
        const frames = fs.readdirSync(path.join(base, sub)).filter(f => EXT_RE.test(f)).sort();
        if (frames.length) { file = path.join(base, sub, frames[0]); break; }
      }
    }
    if (!file) return send(res, 404, '404: арт не найден (положите файл в art_raw/cosm/' + kind + '/' + id + '.png — регистр имени не важен)');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, '404: ' + urlPath);
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
    return;
  }

  // /bg/<category>/<id> — фоны меню/боя/Home (v2.20.0). Поддержка статики и видео.
  // Приоритет: art_raw/backgrounds/<cat>/<id>.* → art_raw/backgrounds_animated/<cat>/<id>.* → prototype/img/backgrounds/<cat>/<id>.*
  if (urlPath.startsWith('/bg/')) {
    const BG_CATS = ['menu','battle','home','decks','animated'];
    const parts = urlPath.slice('/bg/'.length).split('/').filter(Boolean);
    // поддержка /bg/animated/menu/menu  и /bg/menu/menu
    let cat = (parts[0] || '').replace(/[^a-z]/g,'');
    let id = (parts[1] || '').replace(/[^a-zA-Z0-9_-]/g,'');
    // если animated: /bg/animated/menu/menu → cat=animated, parts[1]=menu, parts[2]=menu
    if (cat === 'animated' && parts.length >= 3) {
      cat = (parts[1] || '').replace(/[^a-z]/g,'');
      id = (parts[2] || '').replace(/[^a-zA-Z0-9_-]/g,'');
      // ищем в backgrounds_animated
      const BG_ANIM_ROOTS = RAW_DIRS.map(d => path.join(d, 'backgrounds_animated', cat));
      BG_ANIM_ROOTS.push(path.join(ROOT, 'img', 'backgrounds', cat));
      const normA = s => s.toLowerCase().replace(/(?:\.[a-z0-9]+)+$/, '').replace(/[^a-z0-9]/g,'');
      const idNA = normA(id);
      const EXT_RE_A = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
      let fileA = null;
      for (const base of BG_ANIM_ROOTS) {
        let entries=[]; try{entries=fs.readdirSync(base);}catch{continue;}
        const direct = entries.find(f => EXT_RE_A.test(f) && normA(f)===idNA && fs.statSync(path.join(base,f)).isFile());
        if (direct) { fileA = path.join(base, direct); break; }
      }
      if (!fileA) return send(res, 404, '404: фон не найден (положите файл в art_raw/backgrounds_animated/'+cat+'/'+id+'.mp4)');
      fs.readFile(fileA, (err,data)=>{
        if(err) return send(res,404,'404: '+urlPath);
        const ext = path.extname(fileA).toLowerCase();
        const mime = ext==='.mp4'?'video/mp4':ext==='.webm'?'video/webm':MIME[ext]||'application/octet-stream';
        send(res,200,data,mime);
      });
      return;
    }
    if (!BG_CATS.includes(cat) || !id) return send(res, 404, '404: формат /bg/<category>/<id>  category: menu|battle|home|decks|animated/menu');
    const BG_EXT = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
    const norm = s => s.toLowerCase().replace(/(?:\.[a-z0-9]+)+$/, '').replace(/[^a-z0-9]/g,'');
    const idN = norm(id);
    const roots = [];
    // 1) свежий drop art_raw/backgrounds/<cat>
    for (const d of RAW_DIRS) roots.push(path.join(d, 'backgrounds', cat));
    // 2) фолбэк prototype/img/backgrounds/<cat>
    roots.push(path.join(ROOT, 'img', 'backgrounds', cat));
    // 3) если запросили menu_aurites — пробуем и точное имя, и общий menu
    let file = null;
    for (const base of roots) {
      let entries=[]; try{entries=fs.readdirSync(base);}catch{continue;}
      const direct = entries.find(f => BG_EXT.test(f) && norm(f)===idN && fs.statSync(path.join(base,f)).isFile());
      if (direct) { file = path.join(base, direct); break; }
    }
    // фолбэк: если per-фракция не найдена, пробуем общий <cat> (menu)
    if (!file && id.includes('_')) {
      const baseId = id.split('_')[0];
      const baseN = norm(baseId);
      for (const base of roots) {
        let entries=[]; try{entries=fs.readdirSync(base);}catch{continue;}
        const direct = entries.find(f => BG_EXT.test(f) && norm(f)===baseN && fs.statSync(path.join(base,f)).isFile());
        if (direct) { file = path.join(base, direct); break; }
      }
    }
    if (!file) return send(res, 404, '404: фон не найден (положите файл в art_raw/backgrounds/'+cat+'/'+id+'.jpg — или '+cat+'.jpg)');
    fs.readFile(file, (err,data)=>{
      if(err) return send(res,404,'404: '+urlPath);
      const ext = path.extname(file).toLowerCase();
      const mime = ext==='.mp4'?'video/mp4':ext==='.webm'?'video/webm':MIME[ext]||'application/octet-stream';
      send(res,200,data,mime);
    });
    return;
  }

  const file = safeJoin(ROOT, urlPath);
  if (!file) return send(res, 403, '403: Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '404: ' + urlPath);
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Эхо-Цитадель] прототип: http://0.0.0.0:${PORT}/  (корень ${ROOT})`);
  console.log(`[Эхо-Цитадель] арты:     http://0.0.0.0:${PORT}/art/<Faction>/<id>.png  (${ART_ROOT})`);
  console.log(`[Эхо-Цитадель] drop-in:  art_raw/<id>.png подхватывается сразу  (${RAW_DIRS.join(' | ')})`);
  console.log(`[Эхо-Цитадель] косметика: /cosm/<kind>/<id>  (art_raw/cosm/{backs,tables,runes,offers,bundles,bp,quests})`);
});
