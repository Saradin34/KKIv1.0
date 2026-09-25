#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — Расширение I: доводит коллекцию до 300 карт (+144).
Метод: «клон-донор» — новая карта берёт форму у проверенной карты того же
фракционного типа (только опы/цели, которые знает движок), затем_MUT-ится:
новая стоимость/статы по бюджетной модели docs/BALANCE_MODEL.md
(power = 2*cost + 1.2), новые имя/флейвор/ид. Детерминирован (SEED).
Мгновенные заклинания (subtype Instant) и масс-зачистки (damageAllCreatures /
burnAllEnemies / damageAllEnemyCreatures) включены в пул расширения.
"""
import json, os, random, copy, collections

SEED = 20260921
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
PATH = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')

rng = random.Random(SEED)

KW_POWER = {'Taunt': .5, 'Rush': 1.0, 'Trample': .8, 'Unblockable': .7,
            'Lifesteal': 1.0, 'Windfury': 1.5, 'SpellDamage': .8, 'Deathrattle': .8, 'Battlecry': .6}
OP_POWER = {'damage': .9, 'heal': .7, 'draw': 1.6, 'buffAttack': .8, 'buffHealth': .8,
            'buffAttackHealth': 1.4, 'debuffAttack': .7, 'damageAllCreatures': 2.6,
            'damageAllEnemyCreatures': 2.0, 'burnAllEnemies': 2.2, 'freezeAllEnemies': 2.0,
            'shieldAllFriendlies': 1.8, 'healAllFriendlyCreatures': 1.6, 'mill': 1.2,
            'silence': 1.2, 'returnToHand': 1.3, 'destroyCreature': 2.4, 'gainEcho': 1.0,
            'gainMana': 1.2, 'damageHeroes': 1.5, 'sacrifice': 1.6, 'copyLastSpell': 1.8,
            'extraCard': 1.4, 'reduceIncomingDamage': 1.2, 'heroProtection': 1.6,
            'increaseSpellDamage': 1.2, 'restoreHealthByAttack': 1.2, 'applyStatus': 1.2,
            'removeStatus': .8, 'debuffAttackEnemy': .8, 'opponentDraw': -1.0, 'endTurn': 0,
            'extraMana': 1.2, 'gainMaxMana': 1.4, 'manualAttack': 1.0, 'activate': 1.0,
            'playCard': 1.5, 'mulliganKeep': 0}

NAMES = {
 'Aurites': (['Светоносный', 'Золотопёрый', 'Обетный', 'Рассветный', 'Сияющий', 'Храмовый', 'Лучезарный', 'Клятвенный'],
             ['клирик', 'бастион', 'грифон', 'оракул', 'пилгрим', 'монолит', 'герольд', 'хранитель']),
 'Necrus': (['Гниющий', 'Костяной', 'Могильный', 'Чумной', 'Пепельный', 'Склепный', 'Тленний', 'Вороний'],
            ['жнец', 'некромант', 'упырь', 'саркофаг', 'фетиш', 'призрак', 'мародёр', 'червь']),
 'Terramorph': (['Каменный', 'Корневой', 'Глиняный', 'Гранитный', 'Споровый', 'Железняковый', 'Дубравный', 'Тектонический'],
                ['голем', 'колосс', 'корнеплёт', 'валун', 'грибник', 'рудокоп', 'древень', 'панцирь']),
 'Pyromancer': (['Пылающий', 'Угольный', 'Искровой', 'Лавовый', 'Дымный', 'Огнерождённый', 'Факельный', 'Пиромантийный'],
                ['элементаль', 'феникс', 'поджигатель', 'вулкан', 'факельщик', 'саламандр', 'вимпел', 'жернов']),
 'Ethereal': (['Эфирный', 'Мерцающий', 'Звёздный', 'Туманный', 'Астральный', 'Лунный', 'Фантомный', 'Сумеречный'],
              ['скиталец', 'мираж', 'осколок', 'портал', 'шёпот', 'сонм', 'маяк', 'вуаль']),
 'Neutral': (['Странствующий', 'Наёмный', 'Торговый', 'Пыльный', 'Битый', 'Серый'],
             ['налётчик', 'контрабандист', 'ветеран', 'фургон', 'меняла', 'картограф']),
}
FLAVOR = [
 '«Эхо помнит даже то, что Цитадель предпочла забыть.»',
 '«Цена силы — след, который она оставляет.»',
 '«Между ударами сердца есть дверь. Я видел её.»',
 '«Руины — это не конец. Это черновик.»',
 '«Свет не спорит с тьмой. Он просто приходит.»',
 '«Корни глубже стен. Всегда глубже.»',
 '«Пепел честнее золота: он не притворяется.»',
 '«Тишина перед бурей — это тоже буря.»',
]

def eff_power(effects):
    p = 0.0
    for e in effects or []:
        base = OP_POWER.get(e.get('op', ''), 1.0)
        v = e.get('value', 1) or 1
        if e.get('op') in ('damage', 'heal', 'mill', 'buffAttack', 'buffHealth', 'debuffAttack',
                           'damageAllCreatures', 'damageAllEnemyCreatures', 'burnAllEnemies',
                           'damageHeroes', 'buffAttackHealth', 'debuffAttackEnemy'):
            p += base * max(1, abs(v)) ** 0.85
        elif e.get('op') in ('draw', 'extraCard'):
            p += base * max(1, abs(v))
        else:
            p += base
    return p

def kw_power(kws):
    return sum(KW_POWER.get(k, .5) for k in kws or [])

def cost_of(power):
    return max(1, min(7, round((power - 1.2) / 2 + 0.6)))

def mutate_value(op, v):
    d = rng.choice([-1, 0, 0, 1])
    nv = max(1, (v or 1) + d)
    if op in ('damageAllCreatures', 'burnAllEnemies', 'damageAllEnemyCreatures'):
        nv = max(1, min(6, nv))
    if op in ('draw', 'extraCard', 'mill'):
        nv = max(1, min(4, nv))
    return nv

def new_name(fac, used):
    adj, noun = NAMES[fac]
    for _ in range(60):
        n = f'{rng.choice(adj)} {rng.choice(noun)}'
        if n not in used:
            used.add(n)
            return n
    return f'{rng.choice(adj)} {rng.choice(noun)} {rng.randint(2, 9)}'

def make_art_fields(c):
    fac = c['faction']
    c['art'] = f'Resources/Cards/{fac}/{c["id"]}.png'
    c['artworkPath'] = c['art']
    c['artSize'] = '512x720'
    return c

def main():
    d = json.load(open(PATH, encoding='utf-8'))
    cards, tokens = d['cards'], d['tokens']
    used_names = {c['name'] for c in cards}
    by_fac = collections.defaultdict(list)
    for c in cards:
        by_fac[c['faction']].append(c)

    added = []
    seq = collections.defaultdict(int)

    def next_id(fac, kind):
        pre = {'Aurites': 'aur', 'Necrus': 'nec', 'Terramorph': 'ter',
               'Pyromancer': 'pyr', 'Ethereal': 'eth', 'Neutral': 'neu'}[fac]
        seq[(fac, kind)] += 1
        n = seq[(fac, kind)]
        if kind == 'c':
            while any(c['id'] == f'{pre}_{30 + n:02d}' for c in cards + added): n += 1; seq[(fac, kind)] = n
            return f'{pre}_{30 + n:02d}'
        if kind == 's':
            while any(c['id'] == f'{pre}_s{9 + n:02d}' for c in cards + added): n += 1; seq[(fac, kind)] = n
            return f'{pre}_s{9 + n:02d}'
        while any(c['id'] == f'{pre}_r{6 + n:02d}' for c in cards + added): n += 1; seq[(fac, kind)] = n
        return f'{pre}_r{6 + n:02d}'

    # гарантированные доноры масс-зачисток и мгновенных
    wipe_donors = [c for c in cards if any(e.get('op') in ('damageAllCreatures', 'burnAllEnemies',
                                                           'damageAllEnemyCreatures') for e in c.get('effects', []))]
    inst_donors = [c for c in cards if c['type'] == 'Spell' and c.get('subtype') == 'Instant']

    for fac in ['Aurites', 'Necrus', 'Terramorph', 'Pyromancer', 'Ethereal']:
        pool = by_fac[fac]
        creatures = [c for c in pool if c['type'] == 'Creature']
        spells = [c for c in pool if c['type'] == 'Spell']
        runes = [c for c in pool if c['type'] == 'Rune']

        # --- 14 существ: клон-донор + ребаланс статов по бюджету ---
        for i in range(14):
            donor = rng.choice(creatures)
            c = copy.deepcopy(donor)
            c['id'] = next_id(fac, 'c')
            c['name'] = new_name(fac, used_names)
            c['cost'] = max(1, min(7, donor['cost'] + rng.choice([-1, 0, 0, 1])))
            kw = c.get('keywords', [])
            effs = c.get('effects', [])
            for e in effs:
                if 'value' in e: e['value'] = mutate_value(e.get('op'), e['value'])
            body = 2 * c['cost'] + 1.2 - kw_power(kw) - eff_power(effs)
            body = max(2, round(body))
            share = rng.choice([0.4, 0.5, 0.5, 0.6])
            atk = max(1, round(body * share)); hp = max(1, body - atk)
            c['attack'], c['health'] = atk, hp
            c['flavor'] = rng.choice(FLAVOR)
            c['rarity'] = rng.choices(['Common', 'Rare', 'Epic', 'Legendary'], [60, 25, 10, 5])[0]
            added.append(make_art_fields(c))

        # --- 9 заклинаний: 4 мгновенных + 5 ритуальных, из них 1 масс-зачистка ---
        for i in range(9):
            if i == 0 and wipe_donors:                      # эпическая зачистка фракции
                donor = rng.choice(wipe_donors)
            elif i < 4 and inst_donors:
                donor = rng.choice(inst_donors)
            else:
                donor = rng.choice(spells)
            c = copy.deepcopy(donor)
            c['id'] = next_id(fac, 's')
            c['name'] = new_name(fac, used_names)
            c['type'] = 'Spell'
            c['subtype'] = 'Instant' if i < 4 else rng.choice(['Instant', 'Ritual'])
            for e in c.get('effects', []):
                if 'value' in e: e['value'] = mutate_value(e.get('op'), e['value'])
            c['cost'] = cost_of(eff_power(c.get('effects', [])))
            c['flavor'] = rng.choice(FLAVOR)
            c['rarity'] = 'Epic' if i == 0 else rng.choices(['Common', 'Rare', 'Epic', 'Legendary'], [55, 28, 12, 5])[0]
            added.append(make_art_fields(c))

        # --- 5 рун: клон рун фракции ---
        for i in range(5):
            donor = rng.choice(runes)
            c = copy.deepcopy(donor)
            c['id'] = next_id(fac, 'r')
            c['name'] = new_name(fac, used_names)
            for e in c.get('effects', []):
                if 'value' in e: e['value'] = mutate_value(e.get('op'), e['value'])
            c['cost'] = max(1, min(7, cost_of(eff_power(c.get('effects', [])) + kw_power(c.get('keywords', []))) ))
            c['flavor'] = rng.choice(FLAVOR)
            c['rarity'] = rng.choices(['Common', 'Rare', 'Epic'], [50, 35, 15])[0]
            added.append(make_art_fields(c))

    # --- 4 нейтральных: существа-«наёмники» ---
    neuts = [c for c in by_fac['Neutral'] if c['type'] == 'Creature'] or [c for c in cards if c['type'] == 'Creature']
    for i in range(4):
        donor = rng.choice(neuts)
        c = copy.deepcopy(donor)
        c['id'] = next_id('Neutral', 'c')
        c['faction'] = 'Neutral'
        c['name'] = new_name('Neutral', used_names)
        c['cost'] = max(1, min(7, donor['cost'] + rng.choice([-1, 0, 1])))
        body = max(2, round(2 * c['cost'] + 1.2 - kw_power(c.get('keywords', [])) - eff_power(c.get('effects', []))))
        atk = max(1, round(body * 0.5)); c['attack'], c['health'] = atk, body - atk
        c['flavor'] = rng.choice(FLAVOR)
        c['rarity'] = rng.choices(['Common', 'Rare'], [70, 30])[0]
        added.append(make_art_fields(c))

    ids = [c['id'] for c in cards + added]
    dup = [i for i, n in collections.Counter(ids).items() if n > 1]
    assert not dup, f'dup ids: {dup}'
    names = [c['name'] for c in cards + added]
    dupn = [n for n, k in collections.Counter(names).items() if k > 1]
    assert not dupn, f'dup names: {dupn}'

    d['cards'] = cards + added
    m = d['meta']
    m['version'] = '2.0.0'
    m['totalCards'] = len([c for c in d['cards'] if c['faction'] != 'Neutral']) + len(
        [c for c in d['cards'] if c['faction'] == 'Neutral'])
    m['generatedAt'] = '2026-09-21'
    m['expansion'] = {'set': 'Эхо-Цитадель: Расширение I', 'code': 'ECH1',
                      'added': len(added),
                      'note': 'Мгновенные заклинания (Instant) и масс-зачистки по этапам MTG; '
                              'бустеры MTG-распределения; лимит 4 копии.'}
    dist = collections.Counter(c['type'] for c in d['cards'])
    m['distribution']['types'] = dict(dist)
    m['distribution']['rarities'] = dict(collections.Counter(c['rarity'] for c in d['cards']))
    json.dump(d, open(PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'✔ Cards.json: {len(cards)} → {len(cards) + len(added)} карт (+{len(added)})')
    print('  типов:', dict(dist))
    print('  мгновенных в расширении:', sum(1 for c in added if c.get('subtype') == 'Instant'))
    print('  зачисток в расширении:', sum(1 for c in added if any(
        e.get('op') in ('damageAllCreatures', 'burnAllEnemies', 'damageAllEnemyCreatures') for e in c.get('effects', []))))

if __name__ == '__main__':
    main()
