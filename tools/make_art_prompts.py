#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
 ЭХО-ЦИТАДЕЛЬ — art_prompts.csv для карт Расширения I (ECH1)
=====================================================================
 Строка на каждую новую карту (144): id, faction, name, type, rarity,
 cost, keywords, ability_ru, flavor_ru, art_prompt, negative_prompt,
 size, save_as, template, zone_note.
 Промпт = базовый стиль + мотив типа + имя + мотивы keywords/эффектов +
 пейзаж фракции (из Cards.json) + напоминание о безопасной зоне
 (docs/ART_SPEC.md: видимое окно y 10–70%, фокус 50/38).
 Запуск: python3 tools/make_art_prompts.py  →  art_prompts.csv (корень)
=====================================================================
"""
import csv, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
OUT = os.path.join(ROOT, 'art_prompts.csv')
EXP = None  # граница расширения берётся из meta.expansionIds

KW_MOTIF = {
    'Taunt': 'imposing guardian stance shielding allies behind',
    'Rush': 'lunging forward in mid-charge, motion blur',
    'Trample': 'crushing through broken defenses, debris flying',
    'Lifesteal': 'wisps of drained essence flowing toward it',
    'Windfury': 'twin blurred strikes in a single swing',
    'Unblockable': 'phasing half-transparent through shadows',
    'Deathrattle': 'ominous death-omen aura ready to burst',
    'Battlecry': 'erupting war cry shockwave at arrival',
    'SpellDamage': 'floating amplification runes circling it',
}
OP_MOTIF = {
    'damage': 'a focused burst of destructive energy lancing toward a single foe',
    'damageAllCreatures': 'a cataclysm sweeping the ENTIRE battlefield, all ranks engulfed',
    'damageAllEnemyCreatures': 'a destruction wave rolling over enemy ranks only',
    'burnAllEnemies': 'rain of embers and cinders over enemy lines',
    'heal': 'gentle restorative golden light knitting wounds',
    'healAllFriendlyCreatures': 'a washing tide of healing light over allied ranks',
    'draw': 'streams of knowledge runes flying into an open hand',
    'freezeAllEnemies': 'creeping frost locking enemy ranks in ice',
    'shieldAllFriendlies': 'a domed shimmering barrier rising over allies',
    'mill': 'graveside vortex dragging memories into oblivion',
    'silence': 'sealing runes clamping shut over a mouthed scream',
    'returnToHand': 'a recall whirlwind lifting a warrior off the field',
    'destroyCreature': 'an annihilation beam erasing a single foe',
    'gainEcho': 'concentric echo sigils resonating outward',
    'buffAttackHealth': 'a surge of growth muscles and steel on a champion',
    'buffAttack': 'sharpened blades gleaming with newfound menace',
    'buffHealth': 'bark-and-stone plating thickening over armor',
    'debuffAttack': 'enfeebling shadows gnawing at enemy weapons',
    'damageHeroes': 'a piercing bolt arcing straight at the opposing hero',
    'sacrifice': 'a ritual blade descending over a willing offering',
}
TYPE_MOTIF = {
    'Creature': 'a single heroic creature character',
    'Spell': 'a burst of magical energy',
    'Rune': 'an engraved floating rune emblem',
}
ZONE = ('centered composition, key subject inside the central safe band '
        '(vertical 10%-70% of frame, focus at 50%/38%), keep top 10% and bottom 30% '
        'calm and uncluttered for card name and text plates')

def motifs(card):
    out = []
    for k in card.get('keywords', []) or []:
        if k in KW_MOTIF: out.append(KW_MOTIF[k])
    for e in card.get('effects', []) or []:
        op = e.get('op')
        if op in OP_MOTIF: out.append(OP_MOTIF[op])
    return out

def build_prompt(card):
    base = card.get('artPrompt', '')
    mot = motifs(card)
    tmot = TYPE_MOTIF.get(card['type'], 'a dark fantasy scene')
    # вставка мотивов перед 'centered composition' + зона безопасности
    if 'centered composition' in base:
        head, tail = base.split('centered composition', 1)
        prompt = head + ', '.join(m for m in mot[:2]) + (', ' if mot else '') + ZONE + tail
    else:
        prompt = base + ', ' + ', '.join(mot[:2]) + ', ' + ZONE
    prompt = prompt.replace(f': "{card["name"]}",', f': "{card["name"]}", {tmot}:', 1) if tmot not in prompt else prompt
    return prompt

def main():
    d = json.load(open(CARDS, encoding='utf-8'))
    rows = []
    expset = set(d.get('meta', {}).get('expansionIds', []))
    for c in d['cards']:
        if c['id'] not in expset:
            continue
        rows.append({
            'id': c['id'],
            'faction': c['faction'],
            'name': c['name'],
            'type': c['type'] + (f"·{c['subtype']}" if c.get('subtype') else ''),
            'rarity': c['rarity'],
            'cost': c['cost'],
            'keywords': ' '.join(c.get('keywords', []) or []),
            'ability_ru': (c.get('abilityText') or '').replace('\n', ' '),
            'flavor_ru': (c.get('flavor') or '').strip('«»'),
            'art_prompt': build_prompt(c),
            'negative_prompt': c.get('negativePrompt', ''),
            'size': c.get('artSize', '512x720'),
            'save_as': f'art_raw/{c["id"]}.png',
            'template': '_processed/templates/card_template_512x720.png',
            'zone_note': 'видимое окно y72-504; безопасная зона x41-471 y101-475; фокус (256,274)',
        })
    with open(OUT, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f'✔ art_prompts.csv: {len(rows)} строк (ECH1)')
    from collections import Counter
    print('  по фракциям:', dict(Counter(r['faction'] for r in rows)))
    print('  с мотивами эффектов/ключей:', sum(1 for r in rows if r['art_prompt'].count(',') > 8))

if __name__ == '__main__':
    main()
