#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
 ЭХО-ЦИТАДЕЛЬ — пайплайн ассетов: art_raw → _processed → Unity
=====================================================================
 Берёт всё новое из drop-зон художника (echo-citadel/art_raw и /home/user/art_raw),
 нормализует и раскладывает:
   • карты   : cover-crop в пропорцию 3:4 → 512×720 (artSize из Cards.json),
               _processed/cards/<Faction>/<id>.png + Assets/Resources/Cards/<Faction>/
   • герои   : cover-crop в квадрат → 512×512,
               _processed/heroes/<Faction>.png + Assets/Resources/Heroes/
   • фоны/UI : копируются в _processed/ui/ без изменений пропорций (ресайз ≤2048)
 Идемпотентен: sha256 источника хранится в _processed/.state.json — unchanged
 файлы не пересчитываются. Пишет manifest.csv (id, src, sha256, out, size).
 Запуск: npm run art:process   (или python3 tools/process_art.py)
=====================================================================
"""
from __future__ import annotations
import csv, hashlib, json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIRS = [os.path.join(ROOT, 'art_raw'), os.path.abspath(os.path.join(ROOT, '..', 'art_raw'))]
OUT = os.path.join(ROOT, '_processed')
ASSETS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets')
CARDS_JSON = os.path.join(ASSETS, 'StreamingAssets', 'Cards.json')
STATE = os.path.join(OUT, '.state.json')
EXT = ('.png', '.jpg', '.jpeg', '.webp')

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except ImportError:
    print('!! нет Pillow: файлы будут скопированы без нормализации (pip install pillow)')
    Image = None


def sha256(p: str) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def cover(src: str, dst: str, w: int, h: int) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if Image is None:
        shutil.copyfile(src, dst)
        return
    with Image.open(src) as im:
        im = im.convert('RGB') if im.mode in ('RGBA', 'P', 'LA') and dst.endswith('.jpg') else im.convert(im.mode if im.mode in ('RGB', 'RGBA') else 'RGB')
        sw, sh = im.size
        tr = w / h
        sr = sw / sh
        if sr > tr:                                   # шире цели → режем поля по бокам
            nw = int(sh * tr)
            box = ((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh)
        else:                                         # выше цели → режем сверху/снизу с фокусом 38%
            nh = int(sw / tr)
            top = max(0, min(sh - nh, int((sh - nh) * 0.38)))
            box = (0, top, sw, top + nh)
        im = im.crop(box).resize((w, h), Image.LANCZOS)
        im.save(dst, 'PNG', optimize=True)


def main() -> int:
    data = json.load(open(CARDS_JSON, encoding='utf-8'))
    by_id = {c['id']: c for c in data['cards']}
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE, encoding='utf-8'))
    new_state, manifest, done, skipped = {}, [], 0, 0

    # --- карты: art_raw/<id>.<ext> ---
    for raw in RAW_DIRS:
        if not os.path.isdir(raw):
            continue
        for fn in sorted(os.listdir(raw)):
            base, ext = os.path.splitext(fn)
            if ext.lower() not in EXT:
                continue
            cid = base.lower()
            if cid not in by_id:
                m = re_norm = None
                import re as _re
                m = _re.match(r'^([a-z]+)_(\d{1,2})$', cid)
                if m:
                    cid = f'{m.group(1)}_{int(m.group(2)):02d}'
                if cid not in by_id:
                    continue
            src = os.path.join(raw, fn)
            h = sha256(src)
            key = f'card:{cid}'
            if state.get(key) == h:
                skipped += 1
                new_state[key] = h
                continue
            card = by_id[cid]
            fac = card['faction']
            out = os.path.join(OUT, 'cards', fac, f'{cid}.png')
            uni = os.path.join(ASSETS, 'Resources', 'Cards', fac, f'{cid}.png')
            cover(src, out, 512, 720)
            thumb = os.path.join(OUT, 'thumbs', f'{cid}.png')
            cover(src, thumb, 256, 360)
            os.makedirs(os.path.dirname(uni), exist_ok=True)
            shutil.copyfile(out, uni)
            manifest.append(['card', cid, h, os.path.relpath(out, ROOT), f'{os.path.getsize(out)}B'])
            new_state[key] = h
            done += 1

    # --- герои: art_raw/heroes/<Faction>/<file> или <Faction>.<ext> ---
    for raw in RAW_DIRS:
        hroot = os.path.join(raw, 'heroes')
        if not os.path.isdir(hroot):
            continue
        for entry in sorted(os.listdir(hroot)):
            p = os.path.join(hroot, entry)
            files = []
            if os.path.isdir(p):
                files = [os.path.join(p, f) for f in sorted(os.listdir(p))
                         if os.path.splitext(f)[1].lower() in EXT][:1]
            elif os.path.splitext(entry)[1].lower() in EXT:
                files = [p]
            for src in files:
                fac = entry if os.path.isdir(p) else os.path.splitext(entry)[0]
                h = sha256(src)
                key = f'hero:{fac}'
                if state.get(key) == h:
                    skipped += 1
                    new_state[key] = h
                    continue
                out = os.path.join(OUT, 'heroes', f'{fac}.png')
                uni = os.path.join(ASSETS, 'Resources', 'Heroes', f'{fac}.png')
                cover(src, out, 512, 512)
                os.makedirs(os.path.dirname(uni), exist_ok=True)
                shutil.copyfile(out, uni)
                manifest.append(['hero', fac, h, os.path.relpath(out, ROOT), f'{os.path.getsize(out)}B'])
                new_state[key] = h
                done += 1

    # --- фоны/UI: любые прочие изображения в корне art_raw с префиксом bg_/ui_ ---
    for raw in RAW_DIRS:
        if not os.path.isdir(raw):
            continue
        for fn in sorted(os.listdir(raw)):
            base, ext = os.path.splitext(fn)
            if ext.lower() not in EXT or not base.lower().startswith(('bg_', 'ui_')):
                continue
            src = os.path.join(raw, fn)
            h = sha256(src)
            key = f'ui:{base}'
            if state.get(key) == h:
                skipped += 1
                new_state[key] = h
                continue
            out = os.path.join(OUT, 'ui', fn)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            if Image is not None:
                with Image.open(src) as im:
                    im.thumbnail((2048, 2048), Image.LANCZOS)
                    im.save(out, 'PNG', optimize=True)
            else:
                shutil.copyfile(src, out)
            manifest.append(['ui', base, h, os.path.relpath(out, ROOT), f'{os.path.getsize(out)}B'])
            new_state[key] = h
            done += 1

    # --- renorm: уже лежащие в Unity арты нестандартной пропорции → 512×720 / 512×512 ---
    for root, want in ((os.path.join(ASSETS, 'Resources', 'Cards'), (512, 720)),
                       (os.path.join(ASSETS, 'Resources', 'Heroes'), (512, 512))):
        if not os.path.isdir(root):
            continue
        for dp, _, fs_ in os.walk(root):
            for fn in sorted(fs_):
                if not fn.lower().endswith('.png'):
                    continue
                fp = os.path.join(dp, fn)
                h = sha256(fp)
                key = f'renorm:{os.path.relpath(fp, ROOT)}'
                if state.get(key) == h:
                    new_state[key] = h
                    continue
                if Image is not None:
                    with Image.open(fp) as im:
                        if im.size == want:
                            new_state[key] = h
                            continue
                        sw, sh = im.size
                        tr = want[0] / want[1]
                        if sw / sh > tr:
                            nw = int(sh * tr)
                            box = ((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh)
                        else:
                            nh = int(sw / tr)
                            top = max(0, min(sh - nh, int((sh - nh) * 0.38)))
                            box = (0, top, sw, top + nh)
                        im2 = im.crop(box).resize(want, Image.LANCZOS)
                        im2.save(fp, 'PNG', optimize=True)
                    manifest.append(['renorm', os.path.relpath(fp, ROOT), h, os.path.relpath(fp, ROOT), f'{os.path.getsize(fp)}B'])
                    new_state[os.path.relpath(fp, ROOT).join(['renorm:', ''])] = sha256(fp)
                    done += 1
                else:
                    new_state[key] = h

    # --- превью 256×360 для всех карточных артов Resources (витрина/коллекция) ---
    troot = os.path.join(OUT, 'thumbs')
    os.makedirs(troot, exist_ok=True)
    croot = os.path.join(ASSETS, 'Resources', 'Cards')
    if os.path.isdir(croot) and Image is not None:
        for dp, _, fs_ in os.walk(croot):
            for fn in sorted(fs_):
                if not fn.lower().endswith('.png'):
                    continue
                tp = os.path.join(troot, fn)
                if os.path.exists(tp):
                    continue
                with Image.open(os.path.join(dp, fn)) as im:
                    im.convert('RGB').resize((256, 360), Image.LANCZOS).save(tp, 'PNG', optimize=True)
                done += 1

    os.makedirs(OUT, exist_ok=True)
    json.dump(new_state, open(STATE, 'w', encoding='utf-8'), indent=1)
    with open(os.path.join(OUT, 'manifest.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['kind', 'id', 'sha256', 'out', 'size'])
        w.writerows(manifest)
    print(f'✔ пайплайн ассетов: обработано {done}, пропущено без изменений {skipped}')
    print(f'  _processed/: cards/, heroes/, ui/ + manifest.csv')
    return 0


if __name__ == '__main__':
    sys.exit(main())
