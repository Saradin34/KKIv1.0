/* =====================================================================
   Юнит-проверка слоя настоящего арта (src/ui/art.ts).
   Сборка: npx esbuild tools/artcheck_unit.ts --bundle --platform=node
           --outfile=/tmp/artunit.js && node /tmp/artunit.js
   Проверяет, что:
     • artUrlFor строит /art/<Faction>/<id>.png из artworkPath;
     • cardArt вставляет слой <image href=…> и объявляет xmlns:xlink;
     • карта без artworkPath не ломается (остаётся процедурный слой).
   ===================================================================== */

import { cardArt, artUrlFor } from '../src/ui/art';
import { CardData } from '../src/engine/types';
import cards from '../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';

const file = cards as unknown as { cards: CardData[]; tokens: CardData[] };
const by = new Map<string, CardData>();
for (const c of [...file.cards, ...file.tokens]) by.set(c.id, c);

const ids = ['aur_01', 'nec_01', 'ter_01', 'pyr_01', 'eth_01', 'tkn_spark'];
let ok = 0;
for (const id of ids) {
  const card = by.get(id)!;
  const url = artUrlFor(card);
  const svg = cardArt(card, 220, 104);
  const hasImage = url !== null && svg.includes(`<image href="${url}"`);
  const hasXlink = svg.includes('xmlns:xlink');
  if (hasImage && hasXlink) ok++;
  console.log(`${id}: url=${url} | слой <image>: ${hasImage} | xmlns:xlink: ${hasXlink}`);
}

const src = by.get('aur_01')!;
const noPath = { ...src, artworkPath: undefined, art: undefined } as unknown as CardData;
const urlNo = artUrlFor(noPath);
const svgNo = cardArt(noPath, 100, 100);
console.log(`без artworkPath: url=${String(urlNo)} | svg без <image>: ${!svgNo.includes('<image')}`);

console.log(ok === ids.length && urlNo === null && !svgNo.includes('<image')
  ? 'OK: слой настоящего арта работает и корректно отключается'
  : 'FAIL: слой арта сломан');
