/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — снятие эталона для сверки C#-порта.
   Запускается НА TypeScript-движке (источник истины) и пишет
   tools/csharp/expected.json: значения ГПСЧ на нескольких сидах,
   распределение базы карт, разбор контрольной карты, ауры рун,
   результаты валидации колод.

   Пересобрать и переснять эталон (нужны node_modules: npm i):
     npx esbuild tools/csharp/rngref.ts --bundle --platform=node \
       --outfile=/tmp/rngref.js && node /tmp/rngref.js > tools/csharp/expected.json

   После этого:  npm run verify:cs   — сверит C#-ядро с новым эталоном.
   ===================================================================== */
import { Rng } from '../../src/engine/types';
import { buildDatabase, CardsFile, DeckFile, validateDeck } from '../../src/engine/db';
import cardsRaw from '../../unity/EchoCitadel/Assets/StreamingAssets/Cards.json';
import decksRaw from '../../unity/EchoCitadel/Assets/StreamingAssets/Decks.json';
const out: any = { rng: {} as any, db: {} as any, decks: [] as any[] };
for (const seed of [1, 7, 42, 12345, 20260903, -987654321, 2147483647]) {
  const r = new Rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < 12; i++) vals.push(r.next());
  out.rng[String(seed)] = { first12: vals.map(v => v.toPrecision(17)), ints: (() => { const rr = new Rng(seed); return [rr.int(10), rr.int(40), rr.int(7), rr.range(1, 6)]; })(), shuffle: (() => { const rr = new Rng(seed); return rr.shuffle(['a','b','c','d','e','f','g','h']); })() };
}
const { db, tokens } = buildDatabase(cardsRaw as unknown as CardsFile);
const dist: any = { total: db.size, tokens: tokens.size };
for (const c of db.values()) { dist[c.type] = (dist[c.type] ?? 0) + 1; dist[c.rarity] = (dist[c.rarity] ?? 0) + 1; dist[c.faction] = (dist[c.faction] ?? 0) + 1; }
out.db.dist = dist;
out.db.sample = ((): any => { const c = db.get('aur_01')!; return { id: c.id, name: c.name, faction: c.faction, type: c.type, rarity: c.rarity, cost: c.cost, attack: c.attack, health: c.health, element: c.element, keywords: c.keywords, target: c.target, effectCount: (c.effects ?? []).length }; })();
const runes = [...db.values()].filter(c => c.type === 'Rune');
out.db.runeAuraSample = runes.slice(0, 3).map(r => ({ id: r.id, aura: (r as any).aura, runeLimit: (r as any).runeLimit, duration: (r as any).duration }));
for (const d of (decksRaw as unknown as DeckFile).decks) {
  out.decks.push({ id: d.id, name: d.name, faction: d.faction, size: d.cards.length, errors: validateDeck(d.cards, db, 40) });
}
console.log(JSON.stringify(out));
