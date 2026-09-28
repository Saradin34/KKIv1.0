#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — спуск на уровне колод (deck-level descent).
Не трогает статы карт: для фракций вне коридора 45–55% меняет до 2 карт
в колоде за раунд — по вкладу RelativeWinRate из docs/balance/balance_report.csv.
Ядро архетипов ECH2 (7 cheapest + 2 легенды) неприкосновенно; замена той же
стоимости ±1; лимиты копий; пул — своя фракция + нейтральные существа.
Итерация: python3 tools/tune_decks.py && npm run balance
"""
import json, os, csv, collections

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
DECKS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Decks.json')
REPORT = os.path.join(ROOT, 'docs', 'balance', 'balance_report.csv')
FREPORT = os.path.join(ROOT, 'docs', 'balance', 'faction_report.csv')
BROKEN = {'aur_r09', 'aur_r10', 'aur_r11', 'nec_r09', 'nec_r08', 'nec_r07', 'ter_r09'}
SWAPS_PER_ROUND = 2

# Стартовые 30-карточные преконструкты собираются только из базовой коллекции:
# берём базовые карты соответствующей 60-карточной колоды, затем балансируем кривую.
STARTER_PATCH = {
    'Aurites':    {'add': ['aur_01', 'aur_02', 'aur_s01', 'aur_05'], 'remove': []},
    'Necrus':     {'add': ['nec_01', 'nec_02'], 'remove': ['nec_s09', 'nec_r05']},
    'Terramorph': {'add': ['ter_s01', 'ter_r01'], 'remove': ['ter_11', 'ter_13', 'ter_07', 'ter_10']},
    'Pyromancer': {'add': ['pyr_01', 'pyr_02', 'pyr_04', 'pyr_06', 'pyr_s01', 'pyr_s03'], 'remove': ['pyr_r06']},
    'Ethereal':   {'add': ['eth_s01', 'eth_s02', 'eth_s03'], 'remove': ['eth_r06']},
}
STARTER_NAMES = {
    'Aurites': 'Стартовая: Оплот Света',
    'Necrus': 'Стартовая: Кровавая Жатва',
    'Terramorph': 'Стартовая: Корни Земли',
    'Pyromancer': 'Стартовая: Пламя Возмездия',
    'Ethereal': 'Стартовая: Тысяча Вуалей',
}

KW_POWER = {'Taunt': .5, 'Rush': 1.0, 'Trample': .8, 'Unblockable': .7,
            'Lifesteal': 1.0, 'Windfury': 1.5, 'SpellDamage': .8, 'Deathrattle': .8, 'Battlecry': .6}
OP_POWER = {'damage': .9, 'heal': .7, 'draw': 1.6, 'buffAttack': .8, 'buffHealth': .8,
            'debuffAttack': .7, 'debuffHealth': .8, 'applyStatus': 1.2, 'silence': 1.2,
            'returnToHand': 1.3, 'destroyCreature': 2.4, 'gainEcho': 1.0, 'sacrifice': 1.6,
            'restoreHealthByAttack': 1.2, 'damageAllEnemyCreatures': 2.0, 'burnAllEnemies': 2.2,
            'freezeAllEnemies': 2.0, 'shieldAllFriendlies': 1.8, 'healAllFriendlyCreatures': 1.6,
            'mill': 1.2, 'stealCard': 1.5, 'stealCreature': 3.0, 'damageHeroes': 1.5,
            'summonToken': 0.0, 'extraCard': 1.4, 'opponentDraw': -1.0}

def eff_power(effects):
    p = 0.0
    for e in effects or []:
        op = e.get('op')
        if op == 'summonToken':
            t = e.get('token') or {}
            p += (t.get('attack', 0) + t.get('health', 0)) * 0.45 + sum(KW_POWER.get(k, 0) for k in t.get('keywords', []))
        else:
            p += OP_POWER.get(op, 0.0) * (1.0 if e.get('value') in (None, 1) else min(1.6, 0.6 + 0.2 * (e.get('value') or 1)))
        if e.get('filter'):
            p *= 0.85
    return p

def power(c):
    p = 0.0
    if c['type'] == 'Creature':
        p += (c.get('attack') or 0) + (c.get('health') or 0)
    p += sum(KW_POWER.get(k, 0) for k in c.get('keywords', []))
    p += eff_power(c.get('effects')) + 0.8 * eff_power(c.get('onDeath'))
    return p - (2 * c['cost'] + 1.2)

def build_starter_decks(deck_file, cards_file):
    """Добавляет отдельный учебный формат 30 карт, не меняя MTG Constructed (60+)."""
    by = {c['id']: c for c in cards_file['cards']}
    expansion_ids = set(cards_file.get('meta', {}).get('expansionIds', []))
    base_decks = {deck['id']: deck for deck in deck_file['decks'] if deck.get('format') != 'starter'}
    starters = []
    for faction, patch in STARTER_PATCH.items():
        source = base_decks.get(faction)
        if not source:
            raise ValueError(f'Не найдена базовая колода фракции {faction}')
        ids = [cid for cid in source['cards'] if cid not in expansion_ids]
        for cid in patch['remove']:
            try:
                ids.remove(cid)
            except ValueError as exc:
                raise ValueError(f'{faction}: нельзя удалить {cid} из базового состава') from exc
        ids.extend(patch['add'])
        counts = __import__('collections').Counter(ids)
        if len(ids) != 30:
            raise ValueError(f'{faction}: стартовая колода должна содержать 30 карт, получено {len(ids)}')
        if any(n > 4 for n in counts.values()):
            raise ValueError(f'{faction}: нарушен playset ×4')
        for cid in ids:
            card = by.get(cid)
            if not card:
                raise ValueError(f'{faction}: неизвестная карта {cid}')
            if cid in expansion_ids:
                raise ValueError(f'{faction}: расширение не может входить в стартовую колоду: {cid}')
            if card['faction'] not in (faction, 'Neutral'):
                raise ValueError(f'{faction}: чужая фракция в стартовой колоде: {cid}')
        starters.append({
            'id': 'starter_' + faction.lower(), 'name': STARTER_NAMES[faction],
            'faction': faction, 'format': 'starter', 'cards': ids,
        })
    deck_file['decks'] = [d for d in deck_file['decks'] if d.get('format') != 'starter'] + starters
    deck_file.setdefault('meta', {})['starterDeckSize'] = 30
    deck_file['meta']['updated'] = '2026-09-28'
    deck_file['meta']['note'] = ('v8: MTG Constructed — минимум 60 карт, без верхнего лимита, до 4 копий; '
                                  'отдельные стартовые колоды — 30 карт, 5 фракций')


def main():
    d = json.load(open(CARDS, encoding='utf-8'))
    dk = json.load(open(DECKS, encoding='utf-8'))
    by = {c['id']: c for c in d['cards']}
    rel = {}
    raw = {}
    for r in csv.DictReader(open(REPORT, encoding='utf-8')):
        try:
            rel[r['CardName']] = float(r['RelativeWinRate'])
        except ValueError:
            pass
        try:
            raw[r['CardName']] = float(r['WinRateWhenPlayed'])
        except ValueError:
            pass
    fwr = {}
    for r in csv.DictReader(open(FREPORT, encoding='utf-8')):
        fwr[r['Faction']] = float(r['WinRate'])
    total_swaps = 0
    for deck in dk['decks']:
        if deck['id'] == 'Starter' or deck.get('format') == 'starter':
            continue
        fac = deck.get('faction') or deck['id']
        wr = fwr.get(fac)
        if wr is None:
            continue
        if 0.45 <= wr <= 0.55:
            print(f'{fac}: {wr:.1%} в коридоре — пропуск')
            continue
        need_weaker = wr > 0.55
        n_swaps = 4 if (wr >= 0.70 or wr <= 0.30) else (3 if (wr >= 0.60 or wr <= 0.40) else SWAPS_PER_ROUND)
        # ядро ECH2: 7 cheapest не-лег + 2 cheapest леги своей фракции из ECH2
        mine = [c for c in d['cards'] if c['faction'] == fac and '_' in c['id']
                and c['id'].split('_')[0] in ('meh', 'grm', 'spr', 'vmp', 'cnb', 'scc', 'ent', 'pal', 'sbd', 'wtc', 'asp', 'wtd', 'nsu')]
        cms = sorted([c for c in mine if c['rarity'] != 'Legendary'], key=lambda c: (c['cost'], c['id']))[:7]
        legs = sorted([c for c in mine if c['rarity'] == 'Legendary'], key=lambda c: c['cost'])[:2]
        protected = {c['id'] for c in cms + legs}
        cnt = collections.Counter(deck['cards'])
        # кандидаты на выход: не ядро, сортируем по вкладу
        out_cands = sorted({cid for cid in deck['cards'] if cid not in protected},
                           key=lambda cid: (raw.get(by[cid]['name'], 0.5), by[cid]['cost'], cid),
                           reverse=need_weaker)
        pool = [c for c in d['cards'] if (c['faction'] == fac or (c['faction'] == 'Neutral' and c['type'] == 'Creature'))
                and not c.get('isToken') and c['id'] not in BROKEN]
        done = 0
        for out_id in out_cands:
            if done >= n_swaps:
                break
            out = by[out_id]
            alts = [c for c in pool if c['id'] != out_id and abs(c['cost'] - out['cost']) <= 1
                    and cnt[c['id']] < 4]
            if not alts:
                continue
            alts.sort(key=lambda c: (raw.get(c['name'], 0.5 + power(c) / 40.0)), reverse=not need_weaker)
            inn = alts[0]
            if inn['id'] == out_id:
                continue
            deck['cards'].remove(out_id)
            deck['cards'].append(inn['id'])
            cnt[out_id] -= 1
            cnt[inn['id']] += 1
            done += 1
            total_swaps += 1
            print(f'{fac} ({wr:.1%}): {"-" if need_weaker else "+"} {out["name"]} c{out["cost"]} '
                  f'(вклад {rel.get(out["name"], 0.0):+.3f}) → {"+" if need_weaker else "-"} {inn["name"]} c{inn["cost"]} '
                  f'(вклад {rel.get(inn["name"], 0.0):+.3f})')
        assert len(deck['cards']) >= 60, (fac, len(deck['cards']))
    build_starter_decks(dk, d)
    dk['meta'] = dk.get('meta', {})
    dk['meta']['tuned'] = dk['meta'].get('tuned', 0) + 1
    json.dump(dk, open(DECKS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'✔ свопов: {total_swaps}')

if __name__ == '__main__':
    main()
