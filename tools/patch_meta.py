# -*- coding: utf-8 -*-
"""Мета-игра v2.0: профиль/XP/лиги, крафт-даст, дейлики, магазин и рубашки,
кампания с боссами, стек инстантов, верёвка-таймер, пипсы ключевых слов,
туториал-тур, импорт/экспорт колод, фильтры стоимости/ключевых слов."""
import io

def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8').write(s)

p = 'src/ui/prototype.ts'; s = rd(p)

# ================= META STORE =================
old = "const OWNED_KEY = 'ec_owned_v2';"
new = """/* ---------------------------------------------------------------------- */
/*  Мета-игра: профиль, XP/лиги, дейлики, кампания, рубашки, история       */
/* ---------------------------------------------------------------------- */
interface Quest { id: string; prog: number; goal: number; claimed: boolean; fac?: string }
interface MetaState {
  xp: number; wins: number; losses: number; mmr: number; packs: number;
  facW: Record<string, number>; facL: Record<string, number>;
  history: Array<{ ts: number; win: boolean; fac: string; turns: number }>;
  tutDone: boolean; campaign: Record<string, boolean>; starter: boolean;
  backsOwned: string[]; backEq: string;
  questDate: string; quests: Quest[]; ach: Record<string, boolean>;
}
const META_KEY = 'ec_meta_v1';
const DAILY_REWARD: Record<string, number> = { win_fac: 200, runes: 120, pack: 80 };
const QUEST_RU: Record<string, (q: Quest) => string> = {
  win_fac: q => `Выиграйте ${q.goal} матча фракцией ${FACTION_RU[(q.fac ?? 'Aurites') as Faction]}`,
  runes: q => `Разыграйте ${q.goal} рун`,
  pack: q => `Откройте ${q.goal} бустер`,
};
function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function freshQuests(): Quest[] {
  const fac = FACTION_IDS[new Date().getDate() % FACTION_IDS.length];
  return [
    { id: 'win_fac', prog: 0, goal: 2, claimed: false, fac },
    { id: 'runes', prog: 0, goal: 6, claimed: false },
    { id: 'pack', prog: 0, goal: 1, claimed: false },
  ];
}
const META_DEFAULT: MetaState = {
  xp: 0, wins: 0, losses: 0, mmr: 1000, packs: 0, facW: {}, facL: {}, history: [],
  tutDone: false, campaign: {}, starter: false, backsOwned: ['classic'], backEq: 'classic',
  questDate: todayStr(), quests: freshQuests(), ach: {},
};
let meta: MetaState = META_DEFAULT;
function metaLoad(): void {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (raw) meta = { ...META_DEFAULT, ...(JSON.parse(raw) as Partial<MetaState>) };
  } catch { meta = META_DEFAULT; }
  if (meta.questDate !== todayStr()) { meta.questDate = todayStr(); meta.quests = freshQuests(); }
  if (!meta.quests?.length) meta.quests = freshQuests();
}
function metaSave(): void { try { window.localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { void 0; } }
metaLoad();
function questBump(id: string, n = 1): void {
  const q = meta.quests.find(x => x.id === id);
  if (q && !q.claimed) { q.prog = Math.min(q.goal, q.prog + n); metaSave(); }
}
function leagueOf(mmr: number): string {
  return mmr < 1050 ? 'Бронза' : mmr < 1200 ? 'Серебро' : mmr < 1400 ? 'Золото'
    : mmr < 1600 ? 'Платина' : 'Алмаз';
}
const CRAFT_COST: Record<string, number> = { Common: 100, Rare: 250, Epic: 800, Legendary: 1600 };
const DUST_GAIN: Record<string, number> = { Common: 20, Rare: 40, Epic: 80, Legendary: 150 };
(window as unknown as { ecMeta: () => MetaState }).ecMeta = () => meta;
(window as unknown as { ecSetShards: (n: number) => void }).ecSetShards = n => shardsSet(n);

const OWNED_KEY = 'ec_owned_v2';"""
assert s.count(old) == 1, 'meta store'
s = s.replace(old, new, 1)

# ================= крафт / даст =================
old = "function renderShards(): void {"
new = """function craftCard(id: string): string {
  const c = db.get(id);
  if (!c) return 'Карта не найдена';
  const have = ownedCount(id);
  const cost = CRAFT_COST[c.rarity] ?? 100;
  if (have >= PLAYSET) return 'Достигнут предел 4 копий';
  if (shardsGet() < cost) return `Нужно ◈${cost}`;
  shardsAdd(-cost);
  owned.set(id, have + 1); ownedSave(); renderShards();
  return `Создано за ◈${cost}`;
}
function dustCard(id: string): string {
  const c = db.get(id);
  if (!c) return 'Карта не найдена';
  const have = ownedCount(id);
  const min = isExpansionId(id) ? 0 : 1;          // база всегда остаётся открытой
  if (have <= min) return min === 1 ? 'Базовую карту разобрать нельзя' : 'Нет копий';
  owned.set(id, have - 1); ownedSave();
  shardsAdd(DUST_GAIN[c.rarity] ?? 20); renderShards();
  return `Разобрано: +◈${DUST_GAIN[c.rarity] ?? 20}`;
}

function renderShards(): void {"""
assert s.count(old) == 1, 'craft/dust'
s = s.replace(old, new, 1)

# ================= хуки: пак, руны, финал =================
old = "  ownedSave(); foilSave();\n  return out;\n}"
new = """  ownedSave(); foilSave();
  meta.packs += 1; questBump('pack'); metaSave();
  return out;
}"""
assert s.count(old) == 1, 'pack hook'
s = s.replace(old, new, 1)

old = """      case GameEventType.RunePlayed: {"""
new = """      case GameEventType.RunePlayed: {
        if (e.side === Side.Player) questBump('runes');"""
assert s.count(old) == 1, 'rune hook'
s = s.replace(old, new, 1)

old = """  private showGameOver(): void {
    Vfx.screenFlash('#ffd87a', 0.4, 620);
    Vfx.shake(9, undefined, 420);
    Vfx.vignettePulse('#d8b45a', 0.5);"""
new = """  private showGameOver(): void {
    Vfx.screenFlash('#ffd87a', 0.4, 620);
    Vfx.shake(9, undefined, 420);
    Vfx.vignettePulse('#d8b45a', 0.5);
    this.metaRewards();"""
assert s.count(old) == 1, 'gameover hook'
s = s.replace(old, new, 1)

old = "  private instantLabel = '';"
new = """  campaignBoss: string | null = null;

  /** Награды и прогресс мета-игры за матч. */
  private metaRewards(): void {
    const e = this.engine;
    if (!e || e.result === GameResult.Ongoing) return;
    const win = e.result === GameResult.PlayerWin;
    const fac = this.playerFaction as string;
    if (win) { meta.wins += 1; meta.facW[fac] = (meta.facW[fac] ?? 0) + 1; meta.mmr += 12;
      meta.xp += 80 + e.turn * 2; questBump('win_fac'); }
    else { meta.losses += 1; meta.facL[fac] = (meta.facL[fac] ?? 0) + 1; meta.mmr = Math.max(800, meta.mmr - 10);
      meta.xp += 20 + e.turn; }
    if (win && !meta.ach.first_win) meta.ach.first_win = true;
    if (meta.wins >= 10 && !meta.ach.win10) meta.ach.win10 = true;
    if (meta.packs >= 10 && !meta.ach.packs10) meta.ach.packs10 = true;
    let reward = 0;
    if (this.campaignBoss && win && !meta.campaign[this.campaignBoss]) {
      meta.campaign[this.campaignBoss] = true; reward += 250;
    }
    this.campaignBoss = null;
    meta.history.unshift({ ts: Date.now(), win, fac, turns: e.turn });
    while (meta.history.length > 12) meta.history.pop();
    metaSave();
    const go = $('goStats');
    if (go) {
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:.5rem;color:#ffe9b0;font-family:Philosopher,serif;font-size:.9rem';
      line.textContent = `Награды: +${win ? 80 + e.turn * 2 : 20 + e.turn} опыта, рейтинг ${meta.mmr} (${leagueOf(meta.mmr)})` +
        (reward ? `, ◈${reward} за босса` : '');
      go.appendChild(line);
    }
    if (reward) shardsAdd(reward);
  }

  private instantLabel = '';"""
assert s.count(old) == 1, 'metaRewards'
s = s.replace(old, new, 1)

# ================= стек инстантов =================
old = """      case GameEventType.SpellCast: {
        const card = this.engine?.db.get(e.cardId ?? '');"""
new = """      case GameEventType.SpellCast: {
        const card0 = this.engine?.db.get(e.cardId ?? '');
        if (card0?.subtype === SpellSubtype.Instant || this.engine?.instantWindow !== null) {
          const sl = $('stackList');
          if (sl) {
            sl.appendChild(el('div', 'stItem ' + (e.side === Side.Player ? 'me' : 'foe'),
              `${e.side === Side.Player ? 'Вы' : 'Противник'}: ${esc(card0?.name ?? '')}`));
            $('stackPanel')?.classList.remove('hidden');
          }
        }"""
assert s.count(old) == 1, 'stack push'
s = s.replace(old, new, 1)
old = """    const res = this.instantPassResolve;
    this.instantPassResolve = null;"""
new = """    $('stackPanel')?.classList.add('hidden');
    const sl0 = $('stackList'); if (sl0) sl0.innerHTML = '';
    const res = this.instantPassResolve;
    this.instantPassResolve = null;"""
assert s.count(old) == 1, 'stack clear'
s = s.replace(old, new, 1)

# ================= верёвка-таймер =================
old = "    e.runTurn();                                   // → фаза Main\n    await this.playPhaseBanners([Phase.Start, Phase.Resource]);"
new = """    e.runTurn();                                   // → фаза Main
    this.ropeStart();
    await this.playPhaseBanners([Phase.Start, Phase.Resource]);"""
assert s.count(old) == 1, 'rope start'
s = s.replace(old, new, 1)
old = "  campaignBoss: string | null = null;"
new = """  private ropeTimer = 0;
  private ropeLeft = 75;
  ropeStart(): void {
    this.ropeStop();
    if (!settings.rope) { $('ropeBar')?.classList.add('hidden'); return; }
    $('ropeBar')?.classList.remove('hidden');
    this.ropeLeft = 75;
    this.ropeTimer = window.setInterval(() => {
      if (this.busy || this.combatBusy || this.engine?.instantWindow !== null ||
          this.engine?.result !== GameResult.Ongoing) return;
      this.ropeLeft -= 0.25;
      const f = $('ropeFill');
      if (f) {
        f.style.width = `${Math.max(0, (this.ropeLeft / 75) * 100)}%`;
        f.style.background = this.ropeLeft < 15 ? '#e05545' : this.ropeLeft < 35 ? '#e0a545' : '#7ac060';
      }
      if (this.ropeLeft <= 0) { this.ropeStop(); this.endTurnNow(); }
    }, 250);
  }
  ropeStop(): void { if (this.ropeTimer) { window.clearInterval(this.ropeTimer); this.ropeTimer = 0; } }

  campaignBoss: string | null = null;"""
assert s.count(old) == 1, 'rope methods'
s = s.replace(old, new, 1)
old = "  endTurnNow(): void {\n    const e = this.engine;"
new = "  endTurnNow(): void {\n    this.ropeStop();\n    const e = this.engine;"
assert s.count(old) == 1, 'rope stop on end'
s = s.replace(old, new, 1)

# ================= пипсы ключевых слов на существах =================
old = "    const node = el('div', 'unit f-' + c.faction);\n    node.dataset.uid = String(c.uid);"
new = """    const node = el('div', 'unit f-' + c.faction);
    node.dataset.uid = String(c.uid);
    {
      const PIPS: Record<string, string> = { Taunt: '⛨', Lifesteal: '♥', Trample: '⇉', Windfury: '≋', Unblockable: '◌' };
      const card = this.engine?.db.get(c.cardId);
      const pips = (card?.keywords ?? []).map(k => PIPS[k] ? `<span class="pip" title="${KW_RU[k as Keyword] ?? k}">${PIPS[k]}</span>` : '').join('');
      if (pips) node.insertAdjacentHTML('beforeend', `<div class="pips">${pips}</div>`);
    }"""
assert s.count(old) == 1, 'pips'
s = s.replace(old, new, 1)
wr(p, s); print('✔ prototype.ts: мета-ядро, крафт, стек, верёвка, пипсы, награды')
