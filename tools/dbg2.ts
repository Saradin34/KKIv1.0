import * as fs from 'fs'; import * as path from 'path';
import { buildDatabase, CardsFile, DeckFile } from '../src/engine/db';
import { GameEngine } from '../src/engine/engine';
import { Faction, GameEventType, Phase, Side, GameResult } from '../src/engine/types';
const ROOT = '/home/user/echo-citadel';
const ASSETS = path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets');
const cardsFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Cards.json'), 'utf-8')) as CardsFile;
const decksFile = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Decks.json'), 'utf-8')) as DeckFile;
const { db } = buildDatabase(cardsFile);
const decks: Record<string, string[]> = {};
for (const d of decksFile.decks) decks[d.id] = d.cards;
const evs: string[] = [];
const e = new GameEngine(db, [decks[Faction.Pyromancer], decks[Faction.Necrus]], {
  factions: [Faction.Pyromancer, Faction.Necrus], seed: 701, names: ['A', 'B'],
  hooks: { onEvent: (ev) => {
    if (ev.type === GameEventType.TurnStarted) evs.push(`S${ev.side}`);
    else if (ev.type === GameEventType.PhaseChanged) evs.push(String((ev as { phase?: Phase }).phase));
    else if (ev.type === GameEventType.CardDrawn) evs.push(`D${ev.side}`);
  } },
});
e.setup();
e.mulligan(Side.Player, [0,1,2,3,4]); e.mulligan(Side.Opponent, [0,1,2,3,4]);
let g = 0;
while (e.result === GameResult.Ongoing && e.turn <= 4 && g++ < 20) {
  e.runTurn();
  if (e.phase === Phase.Main && e.result === GameResult.Ongoing) e.finishMainPhase();
}
console.log(evs.join(' '));
