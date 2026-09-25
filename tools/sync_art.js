/* =====================================================================
   Синк drop-in артов: art_raw/<id>.png → Resources/Cards/<Фракция>/<id>.png
   ---------------------------------------------------------------------
   Художник просто кидает файлы в art_raw/ (имя = id карты из Cards.json,
   например aur_01.png; aur_1.png тоже поймём → aur_01). Прототип подхватывает
   их сразу через serve.js, а эта команда раскладывает нормализованные
   копии (центр-кроп в квадрат, 768×768) в папки Unity-проекта — туда, куда
   указывает artworkPath в Cards.json. Без PIL — копирует как есть.

   Запуск: npm run art:sync
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAW_DIRS = [path.resolve(__dirname, '..', 'art_raw'), path.resolve(__dirname, '..', '..', 'art_raw')];
const CARDS_JSON = path.resolve(__dirname, '..', 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json');
const RAW_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

function idVariants(idBase) {
  const out = [idBase];
  const m = idBase.match(/^([a-zA-Z]+)_(\d{1,2})$/);
  if (m) {
    out.push(m[1] + '_' + String(Number(m[2])).padStart(2, '0'));
    out.push(m[1] + '_' + String(Number(m[2])));
  }
  return out;
}

const db = JSON.parse(fs.readFileSync(CARDS_JSON, 'utf8'));
const cards = Array.isArray(db) ? db : db.cards;
const byId = new Map(cards.map((c) => [c.id, c]));

let synced = 0, skipped = 0;
for (const dir of RAW_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;               // подпапки (_processed и т.п.) игнорируем
    const ext = path.extname(name).toLowerCase();
    if (!RAW_EXT.includes(ext)) continue;
    const base = path.basename(name, ext);
    const card = idVariants(base).map((v) => byId.get(v)).find(Boolean);
    if (!card) { console.log(`? ${name}: id не найден в Cards.json — пропуск`); skipped++; continue; }
    const rel = card.artworkPath || card.art;
    if (!rel) { console.log(`? ${name}: у карты ${card.id} нет artworkPath — пропуск`); skipped++; continue; }
    const dst = path.resolve(__dirname, '..', rel.replace(/^Resources\//, 'unity/EchoCitadel/Assets/Resources/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Нормализация в квадрат 768×768, если доступен Python+PIL; иначе копипаст.
    let how = 'copy';
    try {
      execFileSync('python3', ['-c', `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
w, h = im.size
if w != h:
    s = min(w, h); l = (w - s) // 2; t = (h - s) // 2
    im = im.crop((l, t, l + s, t + s))
im = im.resize((768, 768), Image.LANCZOS)
im.save(dst, 'PNG', optimize=True)
`, full, dst], { stdio: 'pipe' });
      how = '768×768';
    } catch {
      fs.copyFileSync(full, dst);
    }
    console.log(`✔ ${name} → ${path.relative(process.cwd(), dst)}  [${card.name}, ${how}]`);
    synced++;
  }
}
console.log(synced || skipped
  ? `\nСинхронизировано: ${synced}, пропущено: ${skipped}.`
  : '\nart_raw пуста: положите файлы вида <id>.png (например aur_01.png) — и запускайте снова.');
