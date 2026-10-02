/* =====================================================================
   Юнит-проверка слоя настоящего арта (src/ui/art.ts).
   Сборка: npx esbuild tools/artcheck_unit.ts --bundle --platform=node
           --outfile=/tmp/artunit.js && node /tmp/artunit.js
   Проверяет, что:
     • artUrlFor строит /art/<Faction>[/<Subfamily>]/<id>.png из artworkPath;
     • cardArt вставляет слой <image href=…> и объявляет xmlns:xlink;
     • карта без artworkPath не ломается (остаётся процедурный слой).
   ===================================================================== */

import { cardArt, artUrlFor } from '../src/ui/art';
import { CardData } from '../src/engine/types';
import cards from '../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';

const file = cards as unknown as { cards: CardData[]; tokens: CardData[] };
const by = new Map<string, CardData>();
for (const c of [...file.cards, ...file.tokens]) by.set(c.id, c);

const ids = ['aur_01', 'nec_01', 'ter_01', 'pyr_01', 'eth_01', 'tkn_spark',
  'meh_01', 'grm_01', 'spr_01', 'vmp_01', 'cnb_01', 'scc_01', 'ent_01',
  'pal_01', 'sbd_01', 'wtc_01', 'asp_01', 'wtd_01', 'nsu_01'];
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

const expectedNested: Record<string, string> = {
  meh_01: '/art/Aurites/Mechanoids/meh_01.png',
  grm_01: '/art/Pyromancer/Gremlins/grm_01.png',
  spr_01: '/art/Ethereal/Sprites/spr_01.png',
  vmp_01: '/art/Necrus/Vampires/vmp_01.png',
  cnb_01: '/art/Pyromancer/Cannibals/cnb_01.png',
  scc_01: '/art/Ethereal/Succubi/scc_01.png',
  ent_01: '/art/Terramorph/Ents/ent_01.png',
  pal_01: '/art/Aurites/PaladinBrotherhood/pal_01.png',
  sbd_01: '/art/Neutral/SacredBrotherhood/sbd_01.png',
  wtc_01: '/art/Necrus/Witches/wtc_01.png',
  asp_01: '/art/Terramorph/Aspids/asp_01.png',
  wtd_01: '/art/Neutral/Withered/wtd_01.png',
  nsu_01: '/art/Neutral/Mercenaries/nsu_01.png',
};
const nestedOk = Object.entries(expectedNested).every(([id, expected]) => artUrlFor(by.get(id)!) === expected);
console.log(`семейные artUrl: ${Object.keys(expectedNested).length}/13 точных вложенных путей ${nestedOk ? 'OK' : 'FAIL'}`);

const src = by.get('aur_01')!;
const noPath = { ...src, artworkPath: undefined, art: undefined } as unknown as CardData;
const urlNo = artUrlFor(noPath);
const svgNo = cardArt(noPath, 100, 100);
console.log(`без artworkPath: url=${String(urlNo)} | svg без <image>: ${!svgNo.includes('<image')}`);

console.log(ok === ids.length && nestedOk && urlNo === null && !svgNo.includes('<image')
  ? 'OK: слой настоящего арта работает и корректно отключается'
  : 'FAIL: слой арта сломан');
