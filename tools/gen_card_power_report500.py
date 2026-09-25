#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор card_power_report.csv на 500 карт (+7 токенов опционально)
- берёт Cards.json (500)
- пересчитывает power по BALANCE_MODEL.md (как в generate_cards.py)
- добавляет колонки с размерами карты и окна под арт из ART_SPEC.md
Выхлоп: docs/balance/card_power_report.csv  и  card_power_report.csv (корень — для удобства)
"""
import json, os, csv, re
from collections import Counter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CARDS_PATH = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
OUT1 = os.path.join(ROOT, 'docs', 'balance', 'card_power_report.csv')
OUT2 = os.path.join(ROOT, 'card_power_report.csv')

# ---- BALANCE MODEL (скопировано из generate_cards.py, чтобы отчёт был «как раньше») ----
KEYWORD_POWER = {"Taunt":0.7,"Lifesteal":1.3,"Deathrattle":0.0,"Rush":1.2,"Windfury":2.2,"Unblockable":1.1,"Trample":1.0,"SpellDamage":1.8}
PER_UNIT_POWER = {"damage":1.0,"heal":0.7,"buffAttack":1.0,"buffHealth":1.0,"debuffAttack":0.9,"debuffHealth":0.8,"damageAllEnemyCreatures":1.6,"damageAllFriendlyCreatures":1.2,"damageAllCreatures":1.1,"healAllFriendlyCreatures":0.6,"setAttack":0.8}
STATUS_PER_UNIT = {"Burn":1.1,"Poison":2.6,"Freeze":1.5,"Shield":1.0,"Fury":1.1,"Silence":1.8}
FIXED_POWER_OPS = {"destroyCreature":4.5,"stealCreature":5.0,"stealCard":2.0,"returnToHand":2.0,"silence":1.2,"gainMaxMana":3.0,"gainMana":1.4,"sacrifice":-1.2,"gainEcho":2.2,"summonToken":1.0,"draw":1.8,"opponentDraw":-0.8,"mill":1.0,"reduceIncomingDamage":1.6,"increaseSpellDamage":2.2,"copyLastSpell":2.0,"restoreHealthByAttack":1.0}
RUNE_LIFETIME=2.6
AOE_EXPECTED=2.4
RITUAL_BONUS=1.25

AOE_OPS={"damageAllEnemyCreatures","damageAllFriendlyCreatures","damageAllCreatures","healAllFriendlyCreatures","freezeAllEnemies","burnAllEnemies","shieldAllFriendlies"}
def _aoe_targets(eff):
    op=eff.get("op")
    if op in AOE_OPS: return AOE_EXPECTED
    flt=eff.get("filter") or {}
    n=flt.get("count") or 1
    if flt.get("random") or flt.get("lowestHealth") or flt.get("highestAttack") or n>1: return float(n)
    return 1.0
def effect_power(eff):
    op=eff.get("op")
    if op=="applyStatus":
        st=eff.get("status","Burn")
        base=STATUS_PER_UNIT.get(st,1.2)
        dur=eff.get("value",1) or 1
        if dur<0: dur=2
        p=base*(1.0+0.35*max(0,dur-1))
        if eff.get("statusValue"): p*=float(eff.get("statusValue"))
        p*=_aoe_targets(eff)
    elif op in PER_UNIT_POWER:
        p=PER_UNIT_POWER[op]*float(eff.get("value",1) or 1)*_aoe_targets(eff)
    elif op=="destroyCreature":
        p=FIXED_POWER_OPS["destroyCreature"]*_aoe_targets(eff)
    elif op=="summonToken":
        t=eff.get("token") or {}
        p=(float(t.get("attack",1))+float(t.get("health",1)))*0.55
        for kw in t.get("keywords",[]) or []: p+=KEYWORD_POWER.get(kw,0.4)*0.6
    elif op in FIXED_POWER_OPS:
        p=FIXED_POWER_OPS[op]*float(eff.get("value",1) or 1) if op in ("draw","opponentDraw","stealCard","mill","gainMana","gainMaxMana","gainEcho") else FIXED_POWER_OPS[op]
    else: p=1.0
    rep=eff.get("repeat",1) or 1
    if rep>1: p*=1.0+0.85*(rep-1)
    if eff.get("if"): p*=0.75
    if eff.get("then"): p+=effect_power(eff["then"])*0.9
    return p
def aura_power(aura):
    op=aura.get("op")
    if op=="buffAttackHealth": base=(float(aura.get("atk",0))+float(aura.get("hp",0)))*1.25
    elif op in ("buffAttack","buffHealth"): base=float(aura.get("value",0))*1.25
    elif op=="debuffAttackEnemy": base=float(aura.get("value",0))*1.15
    elif op=="spellDamage": base=float(aura.get("value",0))*2.4
    elif op=="heroProtection": base=float(aura.get("value",0))*2.6
    elif op=="healReduction": base=float(aura.get("value",0))*2.4
    elif op=="extraMana": base=float(aura.get("value",1))*2.6
    elif op=="extraCard": base=float(aura.get("value",1))*2.0*RUNE_LIFETIME
    elif op=="drawOnResource": base=float(aura.get("value",1))*2.0*RUNE_LIFETIME
    else: base=2.0
    return base
def heal_reduction_power(card):
    hr=card.get("healReduction",0) or 0
    return hr*(2.2 if card["type"]=="Rune" else 1.6)

def card_power(card):
    if card["type"]=="Creature":
        total=float(card.get("attack",0)+card.get("health",0))
        for kw in card.get("keywords",[]): total+=KEYWORD_POWER.get(kw,0.5)
        for eff in card.get("effects",[]): total+=effect_power(eff)*0.9
        for eff in card.get("onDeath",[]): total+=effect_power(eff)*0.85
        for eff in card.get("onTurnStart",[])+card.get("onTurnEnd",[]): total+=effect_power(eff)*2.2
        for eff in card.get("onDamageTaken",[]): total+=effect_power(eff)*1.2
        for eff in card.get("onSpellCast",[]): total+=effect_power(eff)*1.6
        return total+heal_reduction_power(card)
    if card["type"]=="Spell":
        total=sum(effect_power(e) for e in card.get("effects",[]))
        if card.get("subtype")=="Ritual": total*=RITUAL_BONUS
        return total
    total=0.0
    if card.get("aura"): total+=aura_power(card["aura"])
    for eff in card.get("onTurnStart",[]): total+=effect_power(eff)*RUNE_LIFETIME
    for eff in card.get("onPlay",[]): total+=effect_power(eff)
    dur=card.get("duration")
    if dur and dur>0: total*=min(1.0,(dur/6.0)+0.25)
    return total+heal_reduction_power(card)

def target_power(cost): return 2.0*cost+1.2
def ability_power(card):
    pw=card_power(card)
    if card["type"]=="Creature": return round(pw - (card.get("attack",0)+card.get("health",0)),2)
    return round(pw,2)

# ---- ART SPEC ----
CARD_SIZE="512×720"  # файл-оригинал PNG
ART_SIZE="512×720"
VISIBLE_WINDOW="512×432 (x0 y72–x512 y504 | 10–70% высоты)"  # видимое окно
SAFE_ZONE="430×374 (x41 y101–x471 y475)"  # безопасная зона сюжета
FOCUS="центр сюжета (256,274) object-position 50% 38%"
DISPLAY_SIZES="рука 150–196 · поле 100–142 · коллекция 158–190 · модалка 300–380 · пак 122–164"
RUNE_LIMIT="3 одновременно"

def main():
    d=json.load(open(CARDS_PATH,encoding="utf-8"))
    pool=d["cards"]
    # сортировка как в старом отчёте — по id
    pool_sorted=sorted(pool, key=lambda c: c["id"])
    # подготовим выход
    header=["id","name","faction","type","rarity","cost","attack","health","power","power_per_cost","ability_power","designed_cost","drift","cardSize","artSize","visibleArtWindow","safeZone","focusPoint","displaySizes","abilityText","flavor","artPath"]
    rows=[]
    for c in pool_sorted:
        pw=round(card_power(c),2)
        ppc=round(pw/max(1,c["cost"]),3)
        ap=ability_power(c)
        drift=round(pw-target_power(c["cost"]),2)
        designed=c.get("_designedCost","")  # у ECH2 нет, оставим пусто — стоимость уже фикс
        # fallback: если _designedCost пусто, покажем cost как designed
        rows.append([
            c["id"],
            c["name"],
            c["faction"],
            c["type"],
            c["rarity"],
            c["cost"],
            c.get("attack",""),
            c.get("health",""),
            pw,
            ppc,
            ap,
            designed,
            drift,
            CARD_SIZE,
            c.get("artSize", ART_SIZE),
            VISIBLE_WINDOW,
            SAFE_ZONE,
            FOCUS,
            DISPLAY_SIZES,
            (c.get("abilityText","") or "").replace("\n"," ").strip(),
            (c.get("flavor","") or "").replace("\n"," ").strip(),
            c.get("art",""),
        ])
    # запись двух файлов
    for out in (OUT1, OUT2):
        os.makedirs(os.path.dirname(out), exist_ok=True) if os.path.dirname(out) else None
        # BOM для Excel
        with open(out,"w",encoding="utf-8-sig",newline="") as f:
            w=csv.writer(f, quoting=csv.QUOTE_MINIMAL)
            w.writerow(header)
            w.writerows(rows)
        print(f"✔ {out}: {len(rows)} строк + заголовок")
    # сводка
    print("распределение по фракциям:", dict(Counter(c["faction"] for c in pool)))
    print("по типам:", dict(Counter(c["type"] for c in pool)))
    print("по редкостям:", dict(Counter(c["rarity"] for c in pool)))
    # пример
    for r in rows[:3]:
        print(r[:9])

if __name__=="__main__":
    main()
