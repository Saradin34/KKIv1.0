#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
 ЭХО-ЦИТАДЕЛЬ — генератор карточной базы (ТЗ п.7.1)
=====================================================================
 Производит 150 карт (30 на каждую из 5 фракций):
   • 50% существа (75), 30% заклинания (45), 20% руны (30)
   • редкости: 60% обычных, 25% редких, 10% эпических, 5% легендарных
   • стоимость 1..7, авто-баланс статов по «бюджету силы»
   • flavor text, abilityText, artworkPath и промпт для Midjourney/SD

 Модель баланса (docs/BALANCE_MODEL.md):
   budget(cost) = 2*cost + 1.2        — «ванильный» бюджет тела существа
   атомарные эффекты стоят «очков силы»; стоимость = (тело + эффекты)/2 - 0.6

 Детерминирован (SEED) — повторный запуск даёт идентичный Cards.json.
 Опционально обогащает flavor'ы через OpenAI-совместимый API:
   OPENAI_API_KEY=... python3 tools/generator/generate_cards.py --llm
=====================================================================
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

SEED = 20260903
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
BALANCE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "faction_balance.json")


def load_coefficients() -> Dict[str, Dict[str, float]]:
    """Коэффициенты авто-баланса фракций (подбираются solve_balance.ts)."""
    default = {"bodyMul": 1.0, "spellMul": 1.0, "runeMul": 1.0, "passiveMul": 1.0}
    try:
        with open(BALANCE_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        out = {}
        for k, v in raw.items():
            if k.startswith("_") or not isinstance(v, dict):
                continue
            out[k] = {**default, **{kk: float(vv) for kk, vv in v.items() if kk in default}}
        return out
    except Exception:
        return {}


COEF = load_coefficients()


def coef(faction: str, key: str) -> float:
    return float(COEF.get(faction, {}).get(key, 1.0))

# ---------------------------------------------------------------------------
# Справочники
# ---------------------------------------------------------------------------

FACTIONS = ["Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal"]

FACTION_RU = {
    "Aurites": "Ауриты", "Necrus": "Некрусы", "Terramorph": "Терраморфы",
    "Pyromancer": "Пироманты", "Ethereal": "Эфирные", "Neutral": "Нейтральные",
}

FACTION_STYLE = {
    "Aurites":    {"elements": ["None", "Air"],    "keywords": ["Taunt", "SpellDamage"],
                  "ops": ["heal", "shieldAllFriendlies", "draw", "silence", "reduceIncomingDamage", "buffHealth"],
                  "mood": "защита, контроль, исцеление"},
    "Necrus":     {"elements": ["Chaos", "None"],  "keywords": ["Lifesteal", "Deathrattle"],
                  "ops": ["drain", "stealCard", "sacrifice", "destroyCreature", "draw", "buffAttack"],
                  "mood": "агрессия, жертвоприношения, грабёж"},
    "Terramorph": {"elements": ["Earth", "None"],  "keywords": ["Taunt", "Trample"],
                  "ops": ["gainMaxMana", "gainMana", "buffAttackHealth", "heal", "summonToken"],
                  "mood": "рампа, большие существа, медленный старт"},
    "Pyromancer": {"elements": ["Fire", "None"],   "keywords": ["Rush", "SpellDamage"],
                  "ops": ["damage", "damageAllEnemyCreatures", "burnAllEnemies", "damageHeroes"],
                  "mood": "прямой урон, агрессия"},
    "Ethereal":   {"elements": ["Air", "Water"],   "keywords": ["Unblockable", "Windfury"],
                  "ops": ["returnToHand", "stealCard", "freezeAllEnemies", "silence", "draw", "stealCreature"],
                  "mood": "контроль поля, кража, уклонение"},
}

RARITY_PLAN = (
    [("Common", 12), ("Rare", 8), ("Epic", 2), ("Legendary", 1)]  # x5 фракций = 150
)
# на фракцию: 12 обычных, 8 редких, 2 эпических, 1 легендарная
# всего: 60 / 40 / 10 / 5  -> 40% / 26.7% / 6.7% / 3.3%
# ТЗ требует 60/25/10/5 => корректируем глобально в FINAL_RARITY_FIX ниже.

TYPE_PLAN_PER_FACTION = {"Creature": 15, "Spell": 9, "Rune": 6}   # 30 карт

ELEMENT_RU = {"None": "—", "Fire": "Огонь", "Water": "Вода", "Earth": "Земля",
              "Air": "Воздух", "Chaos": "Хаос"}

# ---------------------------------------------------------------------------
# Модель баланса
# ---------------------------------------------------------------------------

def vanilla_budget(cost: int) -> float:
    """Суммарная сила тела существа (atk+hp) без способностей."""
    return 2.0 * cost + 1.2


def split_stats(budget: float, rng: random.Random, archetype: str) -> Tuple[int, int]:
    """Распределение бюджета в атаку/здоровье по архетипу."""
    b = max(2.0, budget)
    if archetype == "brute":     share = rng.uniform(0.60, 0.70)
    elif archetype == "tank":    share = rng.uniform(0.30, 0.40)
    elif archetype == "balanced":share = rng.uniform(0.45, 0.55)
    else:                        share = rng.uniform(0.45, 0.60)
    atk = int(round(b * share))
    hp = int(round(b - atk))
    atk = max(1, atk)
    hp = max(1, hp)
    return atk, hp


# «стоимость» атомарных эффектов в очках силы (см. docs/BALANCE_MODEL.md)
EFFECT_POWER = {
    "damage": 1.0,                 # за 1 урона (к любой цели)
    "heal": 0.7,                   # за 1 здоровья
    "draw": 2.0,                   # за карту
    "opponentDraw": -1.0,          # противник добирает — это минус
    "destroyCreature": 4.0,        # уничтожение (с ограничением по стоимости цели)
    "buffAttack": 1.0,
    "buffHealth": 1.0,
    "debuffAttack": 0.9,
    "applyStatus": 1.4,            # за «сильный» статус
    "silence": 1.8,
    "returnToHand": 2.6,
    "stealCard": 2.4,
    "stealCreature": 5.0,
    "gainMana": 1.2,
    "gainMaxMana": 2.2,
    "summonToken": 1.0,            # за 1/1 токен
    "sacrifice": -1.4,
    "damageAllEnemyCreatures": 1.6,
    "damageAllCreatures": 1.2,
    "freezeAllEnemies": 1.5,
    "burnAllEnemies": 1.3,
    "shieldAllFriendlies": 1.2,
    "gainEcho": 2.0,
    "mill": 1.1,
    "reduceIncomingDamage": 1.3,
    "increaseSpellDamage": 2.0,
    "restoreHealthByAttack": 0.8,
}

KEYWORD_POWER = {
    "Taunt": 0.7, "Lifesteal": 1.3, "Deathrattle": 0.0,  # считаем по эффекту onDeath
    "Rush": 1.2, "Windfury": 2.2, "Unblockable": 1.1, "Trample": 1.0,
    "SpellDamage": 1.8,
}

STATUS_POWER = {"Burn": 1.2, "Poison": 3.0, "Freeze": 1.6, "Shield": 1.1,
                "Fury": 1.2, "Silence": 1.8}


RUNE_LIFETIME = 2.6      # ожидаемое число «срабатываний» руны за партию
AOE_EXPECTED = 2.4       # ожидаемое число существ на столе под AoE
RITUAL_BONUS = 1.25      # ритуал сильнее мгновенного за задержку

# Какие поля эффекта можно подстраивать авто-балансировщиком (в порядке приоритета)
SCALABLE_FIELDS = ["statusValue", "value", "atk", "hp", "repeat"]
# Эффекты, которые не масштабируются числом (их «сила» фиксирована)
FIXED_POWER_OPS = {
    "destroyCreature": 4.5, "stealCreature": 5.0, "stealCard": 2.0,
    "returnToHand": 2.0, "silence": 1.2, "gainMaxMana": 3.0, "gainMana": 1.4,
    "sacrifice": -1.2, "gainEcho": 2.2, "summonToken": 1.0, "draw": 1.8,
    "opponentDraw": -0.8, "mill": 1.0, "reduceIncomingDamage": 1.6,
    "increaseSpellDamage": 2.2, "copyLastSpell": 2.0, "restoreHealthByAttack": 1.0,
}
PER_UNIT_POWER = {
    "damage": 1.0, "heal": 0.7, "buffAttack": 1.0, "buffHealth": 1.0,
    "debuffAttack": 0.9, "damageAllEnemyCreatures": 1.6, "damageAllFriendlyCreatures": 1.2,
    "damageAllCreatures": 1.1, "healAllFriendlyCreatures": 0.6, "setAttack": 0.8,
}
STATUS_PER_UNIT = {"Burn": 1.1, "Poison": 2.6, "Freeze": 1.5, "Shield": 1.0, "Fury": 1.1, "Silence": 1.8}

# Ожидаемое число целей для «массовых» ops
AOE_OPS = {"damageAllEnemyCreatures", "damageAllFriendlyCreatures", "damageAllCreatures",
           "healAllFriendlyCreatures", "freezeAllEnemies", "burnAllEnemies", "shieldAllFriendlies"}


def _aoe_targets(eff: Dict[str, Any]) -> float:
    op = eff.get("op")
    if op in AOE_OPS:
        return AOE_EXPECTED
    flt = eff.get("filter") or {}
    n = flt.get("count") or 1
    if flt.get("random") or flt.get("lowestHealth") or flt.get("highestAttack") or n > 1:
        return float(n)
    return 1.0


def effect_power(eff: Dict[str, Any]) -> float:
    """Сила эффекта в «очках баланса» с учётом числа целей, повторов и условий."""
    op = eff.get("op")
    if op == "applyStatus":
        st = eff.get("status", "Burn")
        base = STATUS_PER_UNIT.get(st, 1.2)
        dur = eff.get("value", 1) or 1
        if dur < 0: dur = 2
        p = base * (1.0 + 0.35 * max(0, dur - 1))
        if op and eff.get("statusValue"):
            p *= float(eff.get("statusValue"))
        p *= _aoe_targets(eff)
    elif op in PER_UNIT_POWER:
        p = PER_UNIT_POWER[op] * float(eff.get("value", 1) or 1) * _aoe_targets(eff)
    elif op == "destroyCreature":
        p = FIXED_POWER_OPS["destroyCreature"] * _aoe_targets(eff)
        flt = eff.get("filter") or {}
        if flt.get("highestAttack") or (eff.get("to") == "AllEnemies"):
            p *= 1.0
    elif op == "summonToken":
        t = eff.get("token") or {}
        p = (float(t.get("attack", 1)) + float(t.get("health", 1))) * 0.55
        for kw in t.get("keywords", []) or []:
            p += KEYWORD_POWER.get(kw, 0.4) * 0.6
    elif op in FIXED_POWER_OPS:
        p = FIXED_POWER_OPS[op] * float(eff.get("value", 1) or 1) if op in ("draw", "opponentDraw", "stealCard", "mill", "gainMana", "gainMaxMana", "gainEcho") else FIXED_POWER_OPS[op]
    else:
        p = 1.0
    rep = eff.get("repeat", 1) or 1
    if rep > 1:
        p *= 1.0 + 0.85 * (rep - 1)
    if eff.get("if"):
        p *= 0.75
    if eff.get("then"):
        p += effect_power(eff["then"]) * 0.9
    return p


def aura_power(aura: Dict[str, Any]) -> float:
    op = aura.get("op")
    if op == "buffAttackHealth":
        base = (float(aura.get("atk", 0)) + float(aura.get("hp", 0))) * 1.25
    elif op in ("buffAttack", "buffHealth"):
        base = float(aura.get("value", 0)) * 1.25
    elif op == "debuffAttackEnemy":
        base = float(aura.get("value", 0)) * 1.15
    elif op == "spellDamage":
        base = float(aura.get("value", 0)) * 2.4
    elif op == "heroProtection":
        base = float(aura.get("value", 0)) * 2.6
    elif op == "healReduction":
        base = float(aura.get("value", 0)) * 2.4
    elif op == "extraMana":
        base = float(aura.get("value", 1)) * 2.6
    elif op == "extraCard":
        base = float(aura.get("value", 1)) * 2.0 * RUNE_LIFETIME
    elif op == "drawOnResource":
        base = float(aura.get("value", 1)) * 2.0 * RUNE_LIFETIME
    else:
        base = 2.0
    return base


def heal_reduction_power(card: Dict[str, Any]) -> float:
    hr = card.get("healReduction", 0) or 0
    # классовый анти-хил: 1.6 очка за единицу, руны дороже (постоянно на столе)
    return hr * (2.2 if card["type"] == "Rune" else 1.6)


def card_power(card: Dict[str, Any]) -> float:
    """Суммарная сила карты (тело + ключевые слова + эффекты)."""
    if card["type"] == "Creature":
        total = float(card.get("attack", 0) + card.get("health", 0))
        for kw in card.get("keywords", []):
            total += KEYWORD_POWER.get(kw, 0.5)
        for eff in card.get("effects", []):
            total += effect_power(eff) * 0.9
        for eff in card.get("onDeath", []):
            total += effect_power(eff) * 0.85
        for eff in card.get("onTurnStart", []) + card.get("onTurnEnd", []):
            total += effect_power(eff) * 2.2
        for eff in card.get("onDamageTaken", []):
            total += effect_power(eff) * 1.2
        for eff in card.get("onSpellCast", []):
            total += effect_power(eff) * 1.6
        return total + heal_reduction_power(card)

    if card["type"] == "Spell":
        total = sum(effect_power(e) for e in card.get("effects", []))
        if card.get("subtype") == "Ritual":
            total *= RITUAL_BONUS
        return total

    # Rune
    total = 0.0
    if card.get("aura"):
        total += aura_power(card["aura"])
    for eff in card.get("onTurnStart", []):
        total += effect_power(eff) * RUNE_LIFETIME
    for eff in card.get("onPlay", []):
        total += effect_power(eff)
    dur = card.get("duration")
    if dur and dur > 0:
        total *= min(1.0, (dur / 6.0) + 0.25)
    return total + heal_reduction_power(card)


def cost_from_power(power: float) -> int:
    """Обратная формула: сила -> стоимость маны (1..7)."""
    return max(1, min(7, int(round((power - 1.2) / 2.0))))


def target_power_for_cost(cost: int) -> float:
    return 2.0 * cost + 1.2
    return 2.0 * cost + 1.2


# ---------------------------------------------------------------------------
# Шаблоны имён и лора по фракциям
# ---------------------------------------------------------------------------

NAME_PARTS = {
    "Aurites": {
        "prefix": ["Сияющий", "Белый", "Златый", "Небесный", "Лучезарный", "Святой", "Рассветный", "Хранитель", "Страж", "Часовой"],
        "noun": ["Аврелион", "Серафим", "Реликварий", "Гимн", "Купол", "Маяк", "Завет", "Псалтырь", "Нимб", "Престол", "Хорал", "Обет", "Алтарь", "Скиния", "Венец"],
    },
    "Necrus": {
        "prefix": ["Гнилостный", "Кровавый", "Полуночный", "Могильный", "Тленный", "Скорбный", "Чумной", "Безмолвный", "Костяной", "Жнец"],
        "noun": ["Мортис", "Склеп", "Жнец", "Вурдалак", "Некромант", "Ламия", "Упырь", "Обелиск", "Реквием", "Саван", "Червь", "Прах", "Гуль", "Лихо", "Мрак"],
    },
    "Terramorph": {
        "prefix": ["Каменный", "Корневой", "Древний", "Гранитный", "Мшистый", "Янтарный", "Тектонический", "Первозданный", "Утёсный", "Глиняный"],
        "noun": ["Голем", "Энт", "Колосс", "Менгир", "Терновник", "Древень", "Валун", "Сейсм", "Росток", "Титан", "Короед", "След", "Пласт", "Матёрый", "Оплот"],
    },
    "Pyromancer": {
        "prefix": ["Пепельный", "Раскалённый", "Искристый", "Угольный", "Пламенный", "Огненный", "Воспламеняющий", "Жаркий", "Горнильный", "Смоляной"],
        "noun": ["Ифрит", "Саламандр", "Вулкан", "Горн", "Феникс", "Пиромант", "Угли", "Взрыв", "Магма", "Пепел", "Факел", "Зной", "Искра", "Костёр", "Жар"],
    },
    "Ethereal": {
        "prefix": ["Эфирный", "Призрачный", "Туманный", "Серебристый", "Неуловимый", "Миражный", "Прозрачный", "Ветряной", "Мерцающий", "Бесплотный"],
        "noun": ["Сильф", "Фантом", "Вихрь", "Мираж", "Шёпот", "Джинн", "Зефир", "Спектр", "Вуаль", "Отголосок", "Иллюзия", "Туман", "Скиталец", "Пар", "Ветер"],
    },
}

FLAVOR = {
    "Aurites": [
        "«Свет не спорит с тьмой. Он просто встаёт раньше.»",
        "«Щит — это обещание, которое держат даже после смерти.»",
        "«Там, где гаснут свечи, зажигают веру.»",
        "«Цитадель помнит каждого, кто её защищал.»",
        "«Исцеление — самая медленная форма мужества.»",
        "«Золото не блестит в темноте. Блестит память о нём.»",
        "«Мы не просим прощения у бури. Мы строим стены.»",
        "«Первый луч всегда находит трещину.»",
        "«Хор поёт даже тогда, когда никто не слушает.»",
        "«Обет тяжелее меча, если знаешь, кому его давал.»",
    ],
    "Necrus": [
        "«Смерть — это просто смена хозяина.»",
        "«Кровь помнит всё. Особенно тех, кто её пролил.»",
        "«Мы не грабим мёртвых. Мы берём взаймы.»",
        "«Каждый павший — это страница в нашей книге.»",
        "«Тьма щедра: она возвращает то, что свет отнял.»",
        "«Жатва не спрашивает, колос ты или сорняк.»",
        "«Прах к праху. А карты — нам.»",
        "«В склепе тихо. Это единственное честное место.»",
        "«Ты умрёшь дважды: сначала в бою, потом в чужой руке.»",
        "«Мы любим гостей. Особенно тех, кто остаётся.»",
    ],
    "Terramorph": [
        "«Гора не спешит. Гора просто есть.»",
        "«Корни глубже, чем башни.»",
        "«Три хода молчания — и земля заговорит.»",
        "«Камень терпеливее любого меча.»",
        "«Мы растём медленно. Зато нас не вырубить.»",
        "«Янтарь хранит то, что время не смогло съесть.»",
        "«Сейсм — это земля, которая вспомнила обиду.»",
        "«Посади одного — получишь лес.»",
        "«Мох растёт на всём, включая амбиции.»",
        "«Терпение — тоже оружие. Просто очень тяжёлое.»",
    ],
    "Pyromancer": [
        "«Гори ярко. Живи коротко. Бей первым.»",
        "«Пепел — единственная честная валюта.»",
        "«Мы платим своей кровью. Мелочью.»",
        "«Огонь не лечит. Огонь объясняет.»",
        "«Искра дешевле меча, если знаешь, куда бросать.»",
        "«Феникс не воскресает. Он просто не успевает умереть.»",
        "«Жар спорит только с тем, кто ещё дышит.»",
        "«Мы горим изнутри. Снаружи — тоже.»",
        "«Магма не спрашивает разрешения подняться.»",
        "«Каждое заклинание стоит одного удара сердца.»",
    ],
    "Ethereal": [
        "«Тебя не ударили. Ты просто забыл, что уже был ранен.»",
        "«Туман берёт своё без единого звука.»",
        "«Украсть проще, чем заработать.»",
        "«Мы не сражаемся. Мы переписываем результат.»",
        "«Мираж дешевле крепости и держится дольше.»",
        "«Ветер всегда знает, где открыто.»",
        "«Твоя карта теперь моя. Это было её решением.»",
        "«Уклонение — вежливая форма отказа умереть.»",
        "«Ты видишь нас ровно настолько, насколько мы это позволяем.»",
        "«Серебро отражает. Даже то, чего нет.»",
    ],
}

# ---------------------------------------------------------------------------
# Вспомогательные конструкторы карт
# ---------------------------------------------------------------------------

def E(op: str, **kw) -> Dict[str, Any]:
    d: Dict[str, Any] = {"op": op}
    d.update(kw)
    return d


def F(**kw) -> Dict[str, Any]:
    return dict(kw)


def creature(cid, name, faction, cost, atk, hp, element="None", keywords=None,
             target="None", effects=None, on_death=None, on_turn_start=None,
             on_turn_end=None, on_dmg=None, on_spell_cast=None,
             heal_reduction=None, rarity="Common", tags=None) -> Dict[str, Any]:
    c: Dict[str, Any] = {
        "id": cid, "name": name, "faction": faction, "type": "Creature",
        "rarity": rarity, "cost": cost, "attack": atk, "health": hp,
        "element": element, "keywords": keywords or [], "target": target,
        "effects": effects or [], "abilityText": "", "flavor": "", "tags": tags or [],
    }
    if on_death: c["onDeath"] = on_death
    if on_turn_start: c["onTurnStart"] = on_turn_start
    if on_turn_end: c["onTurnEnd"] = on_turn_end
    if on_dmg: c["onDamageTaken"] = on_dmg
    if on_spell_cast: c["onSpellCast"] = on_spell_cast
    if heal_reduction: c["healReduction"] = heal_reduction
    return c


def spell(cid, name, faction, cost, subtype="Instant", element="None", target="None",
          effects=None, rarity="Common", tags=None) -> Dict[str, Any]:
    s: Dict[str, Any] = {
        "id": cid, "name": name, "faction": faction, "type": "Spell",
        "subtype": subtype, "rarity": rarity, "cost": cost, "element": element,
        "keywords": [], "target": target, "effects": effects or [],
        "abilityText": "", "flavor": "", "tags": tags or [],
    }
    if subtype == "Ritual":
        s["ritualDelay"] = 1
    return s


def rune(cid, name, faction, cost, element="None", aura=None, on_turn_start=None,
         on_play=None, duration=None, heal_reduction=None,
         rarity="Common", tags=None) -> Dict[str, Any]:
    r: Dict[str, Any] = {
        "id": cid, "name": name, "faction": faction, "type": "Rune",
        "rarity": rarity, "cost": cost, "element": element, "keywords": [],
        "target": "None", "effects": [], "abilityText": "", "flavor": "", "tags": tags or [],
    }
    if aura: r["aura"] = aura
    if on_turn_start: r["onTurnStart"] = on_turn_start
    if on_play: r["onPlay"] = on_play
    if duration: r["duration"] = duration
    if heal_reduction: r["healReduction"] = heal_reduction
    r["runeLimit"] = 3
    return r


def token(cid, name, faction, atk, hp, element="None", keywords=None) -> Dict[str, Any]:
    return {
        "id": cid, "name": name, "faction": faction, "type": "Creature",
        "rarity": "Common", "cost": 1, "attack": atk, "health": hp,
        "element": element, "keywords": keywords or [], "target": "None",
        "effects": [], "abilityText": "Токен", "flavor": "", "isToken": True, "tags": ["token"],
    }


# ===========================================================================
#  ПУЛ КАРТ. Каждая запись создаётся конструкторами creature()/spell()/rune().
#  Стоимость существ задаётся дизайнером, затем авто-подгоняется под бюджет
#  силы (см. auto_balance()). Стоимость заклинаний/рун вычисляется из силы.
# ===========================================================================

TOKENS: List[Dict[str, Any]] = [
    token("tkn_spark",       "Искра",            "Pyromancer", 1, 1, "Fire"),
    token("tkn_ash",          "Пепельный дух",    "Pyromancer", 2, 2, "Fire"),
    token("tkn_sapling",      "Росток",           "Terramorph", 1, 2, "Earth", ["Taunt"]),
    token("tkn_golem",        "Каменный страж",   "Terramorph", 3, 3, "Earth", ["Taunt"]),
    token("tkn_light",        "Лучник света",     "Aurites",    2, 2, "None"),
    token("tkn_skeleton",     "Скелет-прислужник","Necrus",     1, 1, "Chaos"),
    token("tkn_wisp",         "Эфирный огонёк",   "Ethereal",   1, 1, "Air", ["Unblockable"]),
]
TOKEN_MAP = {t["id"]: t for t in TOKENS}


def build_pool() -> List[Dict[str, Any]]:
    pool: List[Dict[str, Any]] = []

    # =======================================================================
    #  АУРИТЫ — Свет: защита, контроль, исцеление
    # =======================================================================
    A = "Aurites"
    pool += [
        creature("aur_01", "Послушник Света", A, 1, 1, 2, "None", ["Taunt"], tags=["vanilla"]),
        creature("aur_02", "Златокрылый страж", A, 2, 2, 3, "None", ["Taunt"], tags=["tank"]),
        creature("aur_03", "Рассветный капеллан", A, 2, 2, 2, "None", ["Battlecry"],
                 target="FriendlyHero", effects=[E("heal", value=3, to="FriendlyHero")], tags=["heal"]),
        creature("aur_04", "Хранитель реликвий", A, 3, 2, 4, "None", ["Battlecry"],
                 effects=[E("draw", value=1)], tags=["card"]),
        creature("aur_05", "Сияющая стража", A, 3, 3, 3, "None", ["Taunt"], tags=["vanilla"]),
        creature("aur_06", "Купольный маг", A, 3, 2, 4, "None", ["SpellDamage"], tags=["spellpower"]),
        creature("aur_07", "Небесный центурион", A, 4, 3, 5, "None", ["Taunt"], tags=["tank"]),
        creature("aur_08", "Безмолвный арбитр", A, 4, 3, 4, "Air", ["Battlecry"],
                 target="EnemyCreature", effects=[E("silence", to="EnemyCreature")], tags=["control"]),
        creature("aur_09", "Серафим Зари", A, 5, 4, 5, "Air", ["Battlecry"],
                 effects=[E("shieldAllFriendlies")], tags=["heal"]),
        creature("aur_10", "Гранитный бастион", A, 5, 4, 6, "None", ["Taunt"], tags=["tank"]),
        creature("aur_11", "Молчаливая монахиня", A, 5, 2, 8, "None", ["Taunt"],
                 on_turn_start=[E("heal", value=2, to="FriendlyHero")], tags=["heal", "tank"]),
        creature("aur_15", "Крылатый страж порога", A, 5, 4, 5, "Air", ["Taunt"],
                 effects=[E("heal", value=3, to="FriendlyHero")], tags=["tank", "heal"]),
        creature("aur_12", "Архангел Завета", A, 6, 5, 6, "Air", ["Taunt", "Lifesteal"], tags=["tank"]),
        creature("aur_13", "Первосвященник Ауры", A, 6, 4, 7, "None", ["Battlecry"],
                 effects=[E("heal", value=5, to="FriendlyHero"), E("shieldAllFriendlies")], tags=["heal"]),
        creature("aur_14", "Престол Вечного Света", A, 7, 6, 8, "None", ["Taunt"],
                 on_turn_start=[E("heal", value=3, to="FriendlyHero")], rarity="Legendary", tags=["tank", "legend"]),

        spell("aur_s01", "Луч Рассвета", A, 1, "Instant", "None", "None",
              [E("heal", value=4, to="FriendlyHero")], tags=["heal"]),
        spell("aur_s02", "Освящение", A, 2, "Instant", "None", "AllEnemies",
              [E("damageAllEnemyCreatures", value=2)], tags=["aoe"]),
        spell("aur_s03", "Священное вмешательство", A, 2, "Instant", "None", "FriendlyCreature",
              [E("applyStatus", status="Shield", value=2, to="FriendlyCreature"), E("buffHealth", value=2, to="FriendlyCreature")],
              tags=["buff"]),
        spell("aur_s04", "Приговор Света", A, 3, "Instant", "None", "EnemyCreature",
              [E("damage", value=4, to="EnemyCreature")], tags=["removal"]),
        spell("aur_s05", "Благословение Ауры", A, 3, "Instant", "None", "FriendlyCreature",
              [E("buffAttack", value=2, to="FriendlyCreature"), E("buffHealth", value=3, to="FriendlyCreature"),
               E("applyStatus", status="Shield", value=1, to="FriendlyCreature")], tags=["buff"]),
        spell("aur_s06", "Молитва Хранителя", A, 4, "Ritual", "None", "None",
              [E("draw", value=2), E("heal", value=5, to="FriendlyHero")], tags=["card", "heal", "ritual"]),
        spell("aur_s07", "Небесный суд", A, 5, "Instant", "None", "AllEnemies",
              [E("damageAllEnemyCreatures", value=3), E("heal", value=3, to="FriendlyHero")], tags=["aoe"]),
        spell("aur_s08", "Купол Безмолвия", A, 5, "Instant", "None", "EnemyCreature",
              [E("silence", to="EnemyCreature"), E("returnToHand", to="EnemyCreature")],
              rarity="Epic", tags=["control"]),
        spell("aur_s09", "Откровение Вечности", A, 6, "Ritual", "None", "None",
              [E("draw", value=3), E("heal", value=8, to="FriendlyHero"), E("reduceIncomingDamage", value=2)],
              rarity="Legendary", tags=["card", "heal", "ritual", "legend"]),

        rune("aur_r01", "Руна Рассвета", A, 2, "None", aura={"op": "extraMana", "value": 1},
             tags=["mana"]),
        rune("aur_r02", "Руна Милосердия", A, 3, "None", on_turn_start=[E("heal", value=2, to="FriendlyHero")],
             tags=["heal"]),
        rune("aur_r03", "Руна Небесного Покрова", A, 4, "Air", aura={"op": "heroProtection", "value": 2},
             tags=["protection"]),
        rune("aur_r04", "Руна Золотого Хора", A, 5, "None", aura={"op": "extraCard", "value": 1},
             rarity="Epic", tags=["card"]),
        rune("aur_r05", "Руна Вечного Купола", A, 6, "None", aura={"op": "buffAttackHealth", "atk": 0, "hp": 2},
             rarity="Epic", tags=["buff"]),
        rune("aur_r06", "Руна Последнего Света", A, 7, "None",
             aura={"op": "heroProtection", "value": 2},
             on_turn_start=[E("heal", value=3, to="FriendlyHero"), E("shieldAllFriendlies")],
             rarity="Legendary", tags=["protection", "heal", "legend"]),
    ]

    # =======================================================================
    #  НЕКРУСЫ — Тьма: агрессия, жертвы, грабёж
    # =======================================================================
    N = "Necrus"
    pool += [
        creature("nec_01", "Костяной прислужник", N, 1, 2, 1, "Chaos", [], tags=["aggro"]),
        creature("nec_02", "Склеповая крыса", N, 1, 1, 1, "Chaos", [],
                 effects=[E("applyStatus", status="Poison", value=1, to="EnemyCreature")],
                 target="EnemyCreature", tags=["poison"]),
        creature("nec_03", "Упырь-мародёр", N, 2, 3, 2, "Chaos", ["Lifesteal"], tags=["aggro"]),
        creature("nec_04", "Ламия Скорби", N, 2, 2, 2, "Chaos", ["Deathrattle"],
                 on_death=[E("draw", value=1)], tags=["card"]),
        creature("nec_05", "Могильный жнец", N, 3, 4, 3, "Chaos", ["Rush"], tags=["aggro"]),
        creature("nec_06", "Чумной разносчик", N, 3, 2, 3, "Chaos", ["Battlecry"],
                 target="EnemyCreature",
                 effects=[E("applyStatus", status="Poison", value=1, to="EnemyCreature",
                            filter=F(random=True, count=1))], tags=["poison"]),
        creature("nec_07", "Полуночный душитель", N, 3, 3, 3, "Chaos", [], tags=["vanilla"]),
        creature("nec_08", "Кровавый архонт", N, 4, 4, 3, "Chaos", ["Lifesteal"], tags=["aggro"]),
        creature("nec_09", "Некромант Склепа", N, 4, 3, 4, "Chaos", ["Battlecry"],
                 effects=[E("summonToken", token=TOKEN_MAP["tkn_skeleton"])], tags=["tokens"]),
        creature("nec_10", "Пожиратель праха", N, 4, 5, 3, "Chaos", ["Rush"],
                 effects=[E("damage", value=1, to="FriendlyHero")], tags=["aggro"]),
        creature("nec_11", "Лихо Болотное", N, 5, 5, 4, "Chaos", ["Deathrattle"],
                 on_death=[E("damageAllEnemyCreatures", value=2)], rarity="Rare", tags=["aoe"]),
        creature("nec_12", "Вурдалак-охотник", N, 5, 5, 5, "Chaos", ["Lifesteal"], tags=["aggro"]),
        creature("nec_13", "Костяной дракон", N, 6, 6, 5, "Chaos", ["Battlecry"],
                 target="EnemyCreature",
                 effects=[E("damage", value=3, to="EnemyCreature"), E("heal", value=3, to="FriendlyHero")],
                 tags=["removal"]),
        creature("nec_14", "Владыка Могильника", N, 6, 5, 5, "Chaos", ["Deathrattle", "Lifesteal"],
                 on_death=[E("summonToken", token=TOKEN_MAP["tkn_skeleton"]),
                           E("summonToken", token=TOKEN_MAP["tkn_skeleton"])],
                 rarity="Epic", tags=["tokens"]),
        creature("nec_15", "Жнец Тысячи Голосов", N, 7, 7, 6, "Chaos", ["Lifesteal", "Rush"],
                 on_turn_start=[E("stealCard", value=1)], rarity="Legendary", tags=["steal", "legend"]),

        spell("nec_s01", "Кровавый обмен", N, 1, "Instant", "Chaos", "None",
              [E("sacrifice"), E("draw", value=2), E("heal", value=2, to="FriendlyHero")], tags=["card"]),
        spell("nec_s02", "Тлетворное касание", N, 2, "Instant", "Chaos", "EnemyCreature",
              [E("damage", value=3, to="EnemyCreature"),
               E("applyStatus", status="Poison", value=1, to="EnemyCreature")], tags=["poison", "removal"]),
        spell("nec_s03", "Кража души", N, 2, "Instant", "Chaos", "EnemyCreature",
              [E("damage", value=2, to="EnemyCreature"), E("heal", value=3, to="FriendlyHero")], tags=["drain"]),
        spell("nec_s04", "Жатва", N, 3, "Instant", "Chaos", "None",
              [E("destroyCreature", to="EnemyCreature", filter=F(highestAttack=True, count=1)),
               E("draw", value=1)], rarity="Rare", tags=["removal"]),
        spell("nec_s05", "Чёрный контракт", N, 3, "Instant", "Chaos", "None",
              [E("stealCard", value=1), E("draw", value=1), E("damage", value=2, to="FriendlyHero")], tags=["steal"]),
        spell("nec_s06", "Проклятие Тлена", N, 4, "Ritual", "Chaos", "EnemyCreature",
              [E("applyStatus", status="Burn", statusValue=2, value=3, to="AllEnemies")], tags=["burn"]),
        spell("nec_s07", "Пир Праха", N, 5, "Instant", "Chaos", "None",
              [E("destroyCreature", to="AnyCreature", filter=F(lowestHealth=True, count=1)),
               E("draw", value=2), E("heal", value=4, to="FriendlyHero")], rarity="Rare", tags=["removal"]),
        spell("nec_s08", "Полночный реквием", N, 6, "Ritual", "Chaos", "None",
              [E("damageAllEnemyCreatures", value=4), E("draw", value=2)], rarity="Epic", tags=["aoe", "ritual"]),
        spell("nec_s09", "Абсолютная Тьма", N, 7, "Instant", "Chaos", "None",
              [E("destroyCreature", to="AllEnemies"), E("heal", value=6, to="FriendlyHero")],
              rarity="Legendary", tags=["removal", "legend"]),

        rune("nec_r01", "Руна Крови", N, 2, "Chaos", aura={"op": "buffAttack", "value": 1}, tags=["buff"]),
        rune("nec_r02", "Руна Тлена", N, 3, "Chaos", on_turn_start=[E("damage", value=1, to="EnemyHero")], tags=["burn"]),
        rune("nec_r03", "Руна Голода", N, 4, "Chaos", on_turn_start=[E("stealCard", value=1)], rarity="Epic", tags=["steal"]),
        rune("nec_r04", "Руна Вечной Жатвы", N, 5, "Chaos", aura={"op": "extraCard", "value": 1}, rarity="Epic", tags=["card"]),
        rune("nec_r05", "Руна Некроза", N, 6, "Chaos", on_turn_start=[E("burnAllEnemies", statusValue=2, value=2)], rarity="Epic", tags=["burn"]),
        rune("nec_r06", "Руна Абсолютной Тьмы", N, 7, "Chaos", aura={"op": "buffAttack", "value": 2},
             on_turn_start=[E("damage", value=2, to="EnemyHero")], rarity="Legendary", tags=["buff", "burn", "legend"]),
    ]

    # =======================================================================
    #  ТЕРРАМОРФЫ — Земля: рампа, большие существа, медленный старт
    # =======================================================================
    T = "Terramorph"
    pool += [
        creature("ter_01", "Каменный росток", T, 1, 1, 3, "Earth", ["Taunt"], tags=["tank"]),
        creature("ter_02", "Глиняный страж", T, 2, 2, 4, "Earth", ["Taunt"], tags=["tank"]),
        creature("ter_03", "Корневой опутыватель", T, 2, 2, 3, "Earth", ["Battlecry"],
                 target="EnemyCreature",
                 effects=[E("applyStatus", status="Freeze", value=1, to="EnemyCreature")], tags=["control"]),
        creature("ter_04", "Янтарный жук", T, 3, 3, 3, "Earth", [], tags=["vanilla"]),
        creature("ter_05", "Мшистый великан", T, 3, 3, 4, "Earth", [], tags=["vanilla"]),
        creature("ter_06", "Сейсмический шаман", T, 3, 2, 4, "Earth", ["Battlecry"],
                 effects=[E("gainMana", value=1)], tags=["mana"]),
        creature("ter_07", "Гранитный колосс", T, 4, 3, 6, "Earth", ["Taunt"], tags=["tank"]),
        creature("ter_08", "Древний энт", T, 4, 4, 5, "Earth", [], tags=["vanilla"]),
        creature("ter_09", "Матёрый древень", T, 4, 2, 7, "Earth", ["Taunt"],
                 on_turn_start=[E("buffHealth", value=1, to="FriendlyCreature", filter=F(highestHealth=True, count=1))],
                 tags=["tank", "buff"]),
        creature("ter_10", "Тектонический страж", T, 5, 4, 7, "Earth", ["Taunt", "Trample"], tags=["tank"]),
        creature("ter_11", "Первозданный титан", T, 5, 5, 6, "Earth", ["Trample"], tags=["brute"]),
        creature("ter_12", "Утёсный исполин", T, 6, 6, 7, "Earth", ["Taunt", "Trample"], tags=["tank"]),
        creature("ter_13", "Мать Леса", T, 6, 5, 8, "Earth", ["Battlecry"],
                 effects=[E("summonToken", token=TOKEN_MAP["tkn_sapling"]),
                          E("summonToken", token=TOKEN_MAP["tkn_sapling"])], rarity="Epic", tags=["tokens"]),
        creature("ter_14", "Владыка Недр", T, 7, 8, 8, "Earth", ["Taunt", "Trample"],
                 on_turn_start=[E("gainMana", value=1)], rarity="Legendary", tags=["mana", "legend"]),
        creature("ter_15", "Сердце Горы", T, 7, 7, 10, "Earth", ["Taunt"],
                 effects=[E("damageAllEnemyCreatures", value=2)], tags=["aoe", "tank"]),

        spell("ter_s01", "Дар Земли", T, 1, "Instant", "Earth", "None",
              [E("gainMana", value=2)], tags=["mana"]),
        spell("ter_s02", "Корневая хватка", T, 2, "Instant", "Earth", "FriendlyCreature",
              [E("buffAttack", value=1, to="FriendlyCreature"), E("buffHealth", value=3, to="FriendlyCreature")],
              tags=["buff"]),
        spell("ter_s03", "Пробуждение корней", T, 3, "Instant", "Earth", "None",
              [E("buffAttack", value=1, to="AllFriendlies"),
               E("buffHealth", value=1, to="AllFriendlies")], tags=["buff"]),
        spell("ter_s04", "Сейсмический толчок", T, 3, "Instant", "Earth", "AllEnemies",
              [E("damageAllEnemyCreatures", value=2),
               E("applyStatus", status="Freeze", value=1, to="AllEnemies")], tags=["aoe", "control"]),
        spell("ter_s05", "Каменная кожа", T, 4, "Instant", "Earth", "FriendlyCreature",
              [E("buffHealth", value=6, to="FriendlyCreature"),
               E("applyStatus", status="Shield", value=1, to="FriendlyCreature")], tags=["buff"]),
        spell("ter_s06", "Зов Предков", T, 5, "Instant", "Earth", "None",
              [E("draw", value=3)], tags=["card"]),
        spell("ter_s07", "Пробуждение Колосса", T, 6, "Ritual", "Earth", "None",
              [E("summonToken", token=TOKEN_MAP["tkn_golem"]), E("gainMaxMana", value=1)],
              rarity="Epic", tags=["tokens", "mana", "ritual"]),
        spell("ter_s08", "Гнев Недр", T, 6, "Ritual", "Earth", "None",
              [E("damageAllEnemyCreatures", value=5), E("heal", value=5, to="FriendlyHero")],
              rarity="Epic", tags=["aoe", "ritual"]),
        spell("ter_s09", "Сердце Мира", T, 7, "Ritual", "Earth", "None",
              [E("damageAllCreatures", value=4), E("gainMaxMana", value=2), E("draw", value=2)],
              rarity="Legendary", tags=["aoe", "mana", "legend"]),

        rune("ter_r01", "Руна Плодородия", T, 2, "Earth", aura={"op": "extraMana", "value": 1}, tags=["mana"]),
        rune("ter_r02", "Руна Коры", T, 3, "Earth", aura={"op": "buffHealth", "value": 1}, tags=["buff"]),
        rune("ter_r03", "Руна Тяжести", T, 4, "Earth", aura={"op": "debuffAttackEnemy", "value": 1}, tags=["debuff"]),
        rune("ter_r04", "Руна Янтаря", T, 5, "Earth", aura={"op": "buffAttackHealth", "atk": 1, "hp": 1}, rarity="Epic", tags=["buff"]),
        rune("ter_r05", "Руна Глубинных Корней", T, 6, "Earth", aura={"op": "extraMana", "value": 1},
             on_turn_start=[E("draw", value=1)], rarity="Epic", tags=["mana", "card"]),
        rune("ter_r06", "Руна Первозданной Земли", T, 7, "Earth", aura={"op": "buffAttackHealth", "atk": 2, "hp": 2},
             rarity="Legendary", tags=["buff", "legend"]),
    ]

    # =======================================================================
    #  ПИРОМАНТЫ — Огонь: прямой урон, агрессия
    # =======================================================================
    P = "Pyromancer"
    pool += [
        creature("pyr_01", "Ученик искры", P, 1, 2, 1, "Fire", [], tags=["aggro"]),
        creature("pyr_02", "Пепельный бес", P, 1, 1, 2, "Fire", ["Rush"], tags=["aggro"]),
        creature("pyr_03", "Саламандра-поджигатель", P, 2, 3, 2, "Fire", ["Battlecry"],
                 target="EnemyHero", effects=[E("damage", value=1, to="EnemyHero")], tags=["burn"]),
        creature("pyr_04", "Угольный элементаль", P, 2, 2, 3, "Fire", ["SpellDamage"], tags=["spellpower"]),
        creature("pyr_05", "Факельщик", P, 3, 3, 2, "Fire", ["Rush"], tags=["aggro"]),
        creature("pyr_06", "Горнильный мастер", P, 3, 2, 4, "Fire", ["SpellDamage"],
                 heal_reduction=1, tags=["spellpower", "antiheal"]),
        creature("pyr_07", "Огненная стена", P, 3, 2, 5, "Fire", ["Taunt"],
                 on_dmg=[E("damage", value=2, to="EnemyHero")], tags=["tank"]),
        creature("pyr_08", "Ифрит Пепла", P, 4, 5, 4, "Fire", ["Rush"],
                 heal_reduction=1, tags=["aggro", "antiheal"]),
        creature("pyr_09", "Феникс-птенцы", P, 4, 3, 3, "Fire", ["Deathrattle"],
                 on_death=[E("summonToken", token=TOKEN_MAP["tkn_ash"])], tags=["tokens"]),
        creature("pyr_10", "Магматический голем", P, 4, 4, 4, "Fire", ["Battlecry"],
                 effects=[E("damageAllEnemyCreatures", value=2)], tags=["aoe"]),
        creature("pyr_11", "Феникс Возрождённый", P, 5, 4, 3, "Fire", ["Deathrattle", "Rush"],
                 on_death=[E("summonToken", token=TOKEN_MAP["tkn_spark"]), E("heal", value=3, to="FriendlyHero")],
                 rarity="Rare", tags=["tokens"]),
        creature("pyr_12", "Вулканический колосс", P, 6, 6, 5, "Fire", ["Rush", "Trample"],
                 effects=[E("damageAllEnemyCreatures", value=2)], heal_reduction=1,
                 rarity="Epic", tags=["aoe", "aggro", "antiheal"]),
        creature("pyr_13", "Пепельный титан", P, 6, 5, 6, "Fire", ["SpellDamage"],
                 on_spell_cast=[E("damage", value=2, to="EnemyHero")], tags=["spellpower"]),
        creature("pyr_14", "Избранник Огня", P, 7, 7, 5, "Fire", ["Rush", "Lifesteal"],
                 effects=[E("damageAllEnemyCreatures", value=3)], rarity="Legendary", tags=["aoe", "legend"]),
        creature("pyr_15", "Горнило Ярости", P, 5, 4, 5, "Fire", ["SpellDamage"],
                 on_spell_cast=[E("damage", value=2, to="EnemyHero")], heal_reduction=1,
                 rarity="Rare", tags=["spellpower", "antiheal"]),

        spell("pyr_s01", "Огненный снаряд", P, 1, "Instant", "Fire", "AnyCreature",
              [E("damage", value=2)], tags=["removal"]),
        spell("pyr_s02", "Вспышка", P, 2, "Instant", "Fire", "None",
              [E("damage", value=3, to="EnemyHero")], tags=["burn"]),
        spell("pyr_s03", "Поджог", P, 2, "Instant", "Fire", "EnemyCreature",
              [E("damage", value=2, to="EnemyCreature"),
               E("applyStatus", status="Burn", statusValue=1, value=2, to="EnemyCreature")], tags=["burn"]),
        spell("pyr_s04", "Огненный шар", P, 3, "Instant", "Fire", "None",
              [E("damage", value=5, to="EnemyHero")], tags=["burn"]),
        spell("pyr_s10", "Раскалённые угли", P, 2, "Instant", "Fire", "None",
              [E("damage", value=2, to="EnemyHero"), E("damageAllEnemyCreatures", value=1)], tags=["burn"]),
        spell("pyr_s06", "Пепельный ливень", P, 4, "Instant", "Fire", "None",
              [E("damage", value=2, to="EnemyHero"), E("burnAllEnemies", statusValue=1, value=2)], tags=["burn", "aoe"]),
        spell("pyr_s07", "Метеоритный дождь", P, 5, "Instant", "Fire", "None",
              [E("damage", value=2, to="EnemyHero", repeat=3)], rarity="Rare", tags=["burn"]),
        spell("pyr_s08", "Инферно", P, 6, "Ritual", "Fire", "None",
              [E("damageAllCreatures", value=4), E("damage", value=3, to="EnemyHero")], rarity="Epic",
              tags=["aoe", "ritual"]),
        spell("pyr_s09", "Зов Вулкана", P, 7, "Ritual", "Fire", "None",
              [E("damage", value=8, to="EnemyHero"), E("damageAllEnemyCreatures", value=4)],
              rarity="Legendary", tags=["burn", "legend"]),

        rune("pyr_r01", "Руна Жара", P, 2, "Fire", aura={"op": "spellDamage", "value": 1}, tags=["spellpower"]),
        rune("pyr_r02", "Руна Пепла", P, 3, "Fire", on_turn_start=[E("damage", value=2, to="EnemyHero")], tags=["burn"]),
        rune("pyr_r03", "Руна Горения", P, 4, "Fire", on_turn_start=[E("burnAllEnemies", statusValue=1, value=2)], tags=["burn"]),
        rune("pyr_r04", "Руна Великого Горна", P, 5, "Fire", aura={"op": "spellDamage", "value": 1},
             heal_reduction=1, rarity="Epic", tags=["spellpower", "antiheal"]),
        rune("pyr_r05", "Руна Извержения", P, 6, "Fire", on_turn_start=[E("damageAllEnemyCreatures", value=3)], rarity="Epic", tags=["aoe"]),
        rune("pyr_r06", "Руна Вечного Пламени", P, 7, "Fire", aura={"op": "spellDamage", "value": 2},
             on_turn_start=[E("damage", value=3, to="EnemyHero"), E("damageAllEnemyCreatures", value=1)],
             rarity="Legendary", tags=["spellpower", "burn", "legend"]),
    ]

    # =======================================================================
    #  ЭФИРНЫЕ — Воздух: контроль поля, кража, уклонение
    # =======================================================================
    Eth = "Ethereal"
    pool += [
        creature("eth_01", "Эфирный разведчик", Eth, 1, 1, 2, "Air", ["Unblockable"], tags=["evasion"]),
        creature("eth_02", "Туманный скиталец", Eth, 1, 2, 1, "Air", [], tags=["aggro"]),
        creature("eth_03", "Сильф-вор", Eth, 2, 2, 2, "Air", ["Unblockable", "Deathrattle"],
                 on_death=[E("draw", value=1)], tags=["evasion", "card"]),
        creature("eth_04", "Ветряной джинн", Eth, 2, 3, 2, "Air", ["Rush"], tags=["aggro"]),
        creature("eth_05", "Ткач иллюзий", Eth, 3, 2, 3, "Air", ["Battlecry"],
                 target="EnemyCreature", effects=[E("returnToHand", to="EnemyCreature")], tags=["control"]),
        creature("eth_06", "Миражный страж", Eth, 3, 3, 3, "Air", ["Rush"], tags=["tempo"]),
        creature("eth_07", "Серебристый иллюзионист", Eth, 4, 3, 4, "Air", ["Battlecry"],
                 effects=[E("stealCard", value=1)], tags=["steal"]),
        creature("eth_08", "Шёпот тумана", Eth, 4, 4, 3, "Air", ["SpellDamage"], tags=["spellpower"]),
        creature("eth_09", "Повелитель ветров", Eth, 4, 3, 5, "Air", ["Windfury"], tags=["evasion"]),
        creature("eth_10", "Призрачный ассасин", Eth, 5, 5, 4, "Air", ["Rush"],
                 effects=[E("silence", to="EnemyCreature", filter=F(highestAttack=True, count=1))],
                 tags=["tempo", "control"]),
        creature("eth_11", "Зеркальный двойник", Eth, 5, 3, 6, "Water", ["Battlecry"],
                 effects=[E("draw", value=2)], tags=["card"]),
        creature("eth_12", "Эхо-повелитель", Eth, 5, 4, 5, "Air", ["SpellDamage"],
                 on_spell_cast=[E("draw", value=1)], rarity="Epic", tags=["spellpower", "card"]),
        creature("eth_13", "Фантомный колосс", Eth, 6, 6, 6, "Air", ["Unblockable", "Windfury"], rarity="Epic", tags=["evasion"]),
        creature("eth_14", "Похититель пустоты", Eth, 6, 5, 5, "Chaos", ["Battlecry"],
                 target="EnemyCreature", effects=[E("stealCreature", to="EnemyCreature")], rarity="Epic", tags=["steal"]),
        creature("eth_15", "Серебряный архонт", Eth, 7, 6, 7, "Air", ["Windfury", "Unblockable"],
                 effects=[E("stealCard", value=2)], rarity="Legendary", tags=["steal", "legend"]),

        spell("eth_s01", "Шёпот", Eth, 1, "Instant", "Air", "None",
              [E("draw", value=1), E("opponentDraw", value=1)], tags=["card"]),
        spell("eth_s02", "Вуаль тумана", Eth, 2, "Instant", "Air", "EnemyCreature",
              [E("returnToHand", to="EnemyCreature")], tags=["control"]),
        spell("eth_s03", "Иллюзорный двойник", Eth, 2, "Instant", "Air", "FriendlyCreature",
              [E("buffAttack", value=2, to="FriendlyCreature"),
               E("applyStatus", status="Shield", value=1, to="FriendlyCreature")], tags=["buff"]),
        spell("eth_s04", "Похищение разума", Eth, 3, "Instant", "Air", "None",
              [E("stealCard", value=2)], tags=["steal"]),
        spell("eth_s05", "Ледяной ветер", Eth, 3, "Instant", "Water", "AllEnemies",
              [E("freezeAllEnemies", value=1), E("damageAllEnemyCreatures", value=1)], tags=["control"]),
        spell("eth_s06", "Серебряная клетка", Eth, 4, "Instant", "Air", "EnemyCreature",
              [E("silence", to="EnemyCreature"), E("returnToHand", to="EnemyCreature")],
              rarity="Rare", tags=["control"]),
        spell("eth_s07", "Ветер перемен", Eth, 5, "Instant", "Air", "None",
              [E("returnToHand", to="EnemyCreature", filter=F(highestAttack=True, count=2)), E("draw", value=1)],
              rarity="Rare", tags=["control"]),
        spell("eth_s08", "Абсолютная иллюзия", Eth, 6, "Ritual", "Air", "EnemyCreature",
              [E("stealCreature", to="EnemyCreature")], rarity="Epic", tags=["steal", "ritual"]),
        spell("eth_s09", "Танец тысячи вуалей", Eth, 7, "Ritual", "Air", "None",
              [E("stealCard", value=2), E("returnToHand", to="EnemyCreature", filter=F(random=True, count=2)),
               E("draw", value=2)], rarity="Legendary", tags=["steal", "control", "legend"]),

        rune("eth_r01", "Руна Тумана", Eth, 2, "Air", aura={"op": "debuffAttackEnemy", "value": 1}, tags=["debuff"]),
        rune("eth_r02", "Руна Ветра", Eth, 3, "Air", aura={"op": "extraCard", "value": 1}, tags=["card"]),
        rune("eth_r03", "Руна Зеркал", Eth, 4, "Air", aura={"op": "extraMana", "value": 1}, tags=["mana"]),
        rune("eth_r04", "Руна Невесомости", Eth, 5, "Air", on_turn_start=[E("freezeAllEnemies", value=1)],
             duration=4, rarity="Epic", tags=["control"]),
        rune("eth_r05", "Руна Тысячи Шёпотов", Eth, 6, "Air", on_turn_start=[E("stealCard", value=1)],
             rarity="Epic", tags=["steal"]),
        rune("eth_r06", "Руна Абсолютной Иллюзии", Eth, 7, "Chaos",
             aura={"op": "extraCard", "value": 1},
             on_turn_start=[E("returnToHand", to="EnemyCreature", filter=F(highestAttack=True, count=1))],
             duration=5,
             rarity="Legendary", tags=["control", "legend"]),
    ]

    # =======================================================================
    #  НЕЙТРАЛЬНЫЕ ванильные существа + токены (вне квоты 150)
    # =======================================================================
    pool += [
        creature("neu_01", "Странник Цитадели", "Neutral", 1, 1, 2, "None", [], tags=["vanilla"]),
        creature("neu_02", "Наёмник Предместья", "Neutral", 2, 3, 2, "None", [], tags=["vanilla"]),
        creature("neu_03", "Ветеран Осады", "Neutral", 3, 3, 4, "None", [], tags=["vanilla"]),
        creature("neu_04", "Рыцарь Без Знамени", "Neutral", 4, 4, 5, "None", [], tags=["vanilla"]),
        creature("neu_05", "Стражник Врат", "Neutral", 5, 5, 6, "None", [], tags=["vanilla"]),
        creature("neu_06", "Эхо-архивариус", "Neutral", 3, 2, 4, "None", ["Battlecry"],
                 effects=[E("gainEcho", value=1)], tags=["echo"]),
    ]

    return pool


# ---------------------------------------------------------------------------
# Генерация русского текста способности из декларативных эффектов
# ---------------------------------------------------------------------------

KW_RU = {"Taunt": "Провокация", "Lifesteal": "Вампиризм", "Deathrattle": "Предсмертный хрип",
         "Battlecry": "Боевой клич", "Rush": "Рывок", "Windfury": "Буря",
         "Unblockable": "Неуловимость", "Trample": "Прорыв", "SpellDamage": "Урон заклинаний +1"}

TARGET_RU = {"None": "", "EnemyCreature": "вражеское существо", "FriendlyCreature": "ваше существо",
             "AnyCreature": "любое существо", "EnemyHero": "вражеский герой",
             "FriendlyHero": "ваш герой", "AnyHero": "любой герой",
             "AllEnemies": "всех врагов", "AllFriendlies": "всех ваших существ",
             "AllCreatures": "все существа"}


def _filter_ru(f: Optional[Dict[str, Any]]) -> str:
    if not f: return ""
    if f.get("lowestHealth"): return " с наименьшим здоровьем"
    if f.get("lowestAttack"): return " с наименьшей атакой"
    if f.get("highestAttack"): return " с наибольшей атакой"
    if f.get("highestHealth"): return " с наибольшим здоровьем"
    if f.get("random"): return f" случайное ({f.get('count', 1)} шт.)"
    return ""


def eff_ru(e: Dict[str, Any]) -> str:
    op = e.get("op"); v = e.get("value", 1); to = TARGET_RU.get(e.get("to", ""), "")
    flt = _filter_ru(e.get("filter"))
    rep = e.get("repeat", 1) or 1
    st = e.get("status")
    if op == "damage":
        base = f"Нанесите {v} урона"
        if to: base = f"Наносит {v} урона ({to})"
        if rep > 1: base += f", {rep} раза"
        return base
    if op == "heal":            return f"Восстановите {v} здоровья ({to})" if to else f"Восстановите {v} здоровья"
    if op == "draw":            return f"Возьмите {v} карт(у)"
    if op == "opponentDraw":    return f"Противник берёт {v} карт(у)"
    if op == "destroyCreature": return f"Уничтожьте{flt} ({to})" if to else f"Уничтожьте существо{flt}"
    if op == "buffAttack":      return f"+{v} к атаке ({to})" if to else f"+{v} к атаке"
    if op == "buffHealth":      return f"+{v} к здоровью ({to})" if to else f"+{v} к здоровью"
    if op == "debuffAttack":    return f"-{v} к атаке ({to})" if to else f"-{v} к атаке"
    if op == "applyStatus":
        turns = v if v and v > 0 else 0
        s = f"{status_ru(st)}"
        if e.get("statusValue"): s += f" {e['statusValue']}"
        if turns: s += f" на {turns} ход(а)"
        return f"{s} ({to})" if to else s
    if op == "silence":         return f"Немота на{flt} ({to})" if to else "Немота"
    if op == "returnToHand":    return f"Верните{flt} в руку ({to})" if to else "Верните существо в руку"
    if op == "stealCard":       return f"Украдите {v} случайную(ых) карту(ы) из руки противника"
    if op == "stealCreature":   return f"Перехватите{flt} ({to})" if to else "Перехватите существо противника"
    if op == "gainMana":        return f"Получите {v} маны"
    if op == "gainMaxMana":     return f"+{v} к максимуму маны"
    if op == "gainEcho":        return f"Получите {v} Эхо-очко"
    if op == "summonToken":
        t = e.get("token") or {}
        return f"Призовите «{t.get('name','токен')}» {t.get('attack',0)}/{t.get('health',0)}"
    if op == "sacrifice":       return "Пожертвуйте своим существом с наименьшей суммой силы"
    if op == "damageAllEnemyCreatures": return f"Нанесите {v} урона всем вражеским существам"
    if op == "damageAllFriendlyCreatures": return f"Нанесите {v} урона всем вашим существам"
    if op == "damageAllCreatures": return f"Нанесите {v} урона всем существам"
    if op == "healAllFriendlyCreatures": return f"Восстановите {v} здоровья всем вашим существам"
    if op == "freezeAllEnemies": return f"Заморозьте всех врагов на {v} ход(а)"
    if op == "burnAllEnemies":   return f"Подожгите всех врагов ({e.get('statusValue',1)} урона, {v} ход(а))"
    if op == "shieldAllFriendlies": return "Все ваши существа получают Щит"
    if op == "reduceIncomingDamage": return f"Снижение входящего урона героя на {v}"
    if op == "increaseSpellDamage": return f"+{v} к урону ваших заклинаний"
    return op


def status_ru(s: Optional[str]) -> str:
    return {"Burn": "Горение", "Poison": "Яд", "Freeze": "Заморозка", "Shield": "Щит",
            "Fury": "Ярость", "Silence": "Немота"}.get(s or "", s or "")


def build_ability_text(c: Dict[str, Any]) -> str:
    parts: List[str] = []
    kws = [KW_RU.get(k, k) for k in c.get("keywords", [])]
    if c["type"] == "Creature":
        if c.get("effects"):
            parts.append("Боевой клич: " + "; ".join(eff_ru(e) for e in c["effects"]) + ".")
        if c.get("onDeath"):
            parts.append("Предсмертный хрип: " + "; ".join(eff_ru(e) for e in c["onDeath"]) + ".")
        if c.get("onTurnStart"):
            parts.append("В начале вашего хода: " + "; ".join(eff_ru(e) for e in c["onTurnStart"]) + ".")
        if c.get("onTurnEnd"):
            parts.append("В конце вашего хода: " + "; ".join(eff_ru(e) for e in c["onTurnEnd"]) + ".")
        if c.get("onDamageTaken"):
            parts.append("При получении урона: " + "; ".join(eff_ru(e) for e in c["onDamageTaken"]) + ".")
        if c.get("onSpellCast"):
            parts.append("Когда вы разыгрываете заклинание: " + "; ".join(eff_ru(e) for e in c["onSpellCast"]) + ".")
        if "SpellDamage" in c.get("keywords", []):
            parts.append("Ваши заклинания наносят на 1 урон больше.")
    elif c["type"] == "Spell":
        if c.get("subtype") == "Ritual":
            parts.append("Ритуал: разрешается в начале вашего следующего хода.")
        parts.append("; ".join(eff_ru(e) for e in c.get("effects", [])) + ".")
    else:  # Rune
        aura = c.get("aura")
        if aura:
            op = aura.get("op")
            if op == "buffAttackHealth":
                parts.append(f"Аура: ваши существа получают +{aura.get('atk',0)}/+{aura.get('hp',0)}.")
            elif op == "buffAttack":
                parts.append(f"Аура: +{aura.get('value',0)} к атаке ваших существ.")
            elif op == "buffHealth":
                parts.append(f"Аура: +{aura.get('value',0)} к здоровью ваших существ.")
            elif op == "debuffAttackEnemy":
                parts.append(f"Аура: -{aura.get('value',0)} к атаке вражеских существ.")
            elif op == "spellDamage":
                parts.append(f"Аура: ваши заклинания наносят на {aura.get('value',0)} урона больше.")
            elif op == "heroProtection":
                parts.append(f"Аура: входящий урон вашему герою снижен на {aura.get('value',0)}.")
            elif op == "healReduction":
                parts.append(f"Аура: входящее лечение противника снижено на {aura.get('value',0)}.")
            elif op == "extraMana":
                parts.append(f"Аура: +{aura.get('value',0)} к максимуму маны.")
            elif op == "extraCard":
                parts.append(f"Аура: +{aura.get('value',0)} карта в начале вашего хода.")
        if c.get("onTurnStart"):
            parts.append("В начале вашего хода: " + "; ".join(eff_ru(e) for e in c["onTurnStart"]) + ".")
        if c.get("onPlay"):
            parts.append("При установке: " + "; ".join(eff_ru(e) for e in c["onPlay"]) + ".")
        if c.get("duration"):
            parts.append(f"Длительность: {c['duration']} ход(а).")
        else:
            parts.append("Действует до конца игры.")
        parts.append("Руну нельзя уничтожить обычными заклинаниями.")
    if c.get("healReduction"):
        parts.append(f"Выжигание: входящее лечение противника снижено на {c['healReduction']}.")
    if kws:
        parts.append(" / ".join(kws) + ".")
    txt = " ".join(p for p in parts if p)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt


# ---------------------------------------------------------------------------
# Арт-промпты (Midjourney / Stable Diffusion), ТЗ п.7.2 — 512x720 (3:4)
# ---------------------------------------------------------------------------

ART_STYLE = {
    "Aurites": "radiant white marble citadel, golden filigree, soft god-rays, pale blue holy light, "
               "feathered wings, polished brass armor, luminous runes floating in air",
    "Necrus":  "decaying gothic crypt, deep purple and blood red, black mist, bone reliquaries, "
               "green necrotic glow, tattered burial shrouds, iron chains",
    "Terramorph": "ancient moss-covered stone, amber crystals growing from rock, giant roots, "
                  "emerald forest light, weathered granite, prehistoric trees",
    "Pyromancer": "molten lava cracks, ember storm, scorched obsidian, orange-red fire magic, "
                  "smoke and ash, glowing forge runes",
    "Ethereal":  "silver mist and teal aurora, translucent ghostly forms, floating silk veils, "
                 "moonlit sky, mirror shards, weightless particles",
    "Neutral":   "weathered stone hall of the Echo Citadel, neutral torchlight, dusty banners, "
                 "ancient carved reliefs",
}

RARITY_ART = {
    "Common": "", "Rare": "intricate detailing, ",
    "Epic": "epic cinematic composition, volumetric light, ",
    "Legendary": "legendary masterpiece composition, dramatic rim light, particle effects, ",
}

NEGATIVE_PROMPT = ("text, letters, watermark, signature, ui, frame, border, extra limbs, deformed hands, "
                   "lowres, blurry, jpeg artifacts, modern clothing, photograph, 3d render plastic look")


def art_prompt(c: Dict[str, Any]) -> str:
    faction = c["faction"]
    type_word = {"Creature": "a single heroic creature character", "Spell": "a burst of magical energy",
                 "Rune": "an ancient glowing rune sigil carved on stone"}[c["type"]]
    subject = c["name"]
    elem = {"Fire": "fire element", "Water": "water element", "Earth": "earth element",
            "Air": "air element", "Chaos": "chaos/void element", "None": ""}.get(c["element"], "")
    rarity = RARITY_ART.get(c["rarity"], "")
    base = (f"{rarity}dark fantasy trading card game illustration, {type_word}: \"{subject}\", "
            f"{ART_STYLE.get(faction, ART_STYLE['Neutral'])}")
    if elem: base += f", {elem}"
    base += ", centered composition, rich color grading, painterly brushwork, high detail --ar 3:4 --style raw --v 6"
    return base


# ---------------------------------------------------------------------------
# Авто-балансировка
# ---------------------------------------------------------------------------

def auto_balance_creature(c: Dict[str, Any], rng: random.Random) -> Dict[str, Any]:
    """Подгоняет атаку/здоровье существа под бюджет его стоимости."""
    cost = max(1, min(7, c["cost"]))
    c["cost"] = cost
    target_total = vanilla_budget(cost)
    tags = c.get("tags", [])
    archetype = "brute" if "brute" in tags or "aggro" in tags else ("tank" if "tank" in tags else "balanced")

    ability_power = 0.0
    for kw in c.get("keywords", []):
        ability_power += KEYWORD_POWER.get(kw, 0.5)
    for e in c.get("effects", []):        ability_power += effect_power(e) * 0.9
    for e in c.get("onDeath", []):        ability_power += effect_power(e) * 0.8
    for e in c.get("onTurnStart", []):    ability_power += effect_power(e) * 1.2
    for e in c.get("onTurnEnd", []):      ability_power += effect_power(e) * 1.2
    for e in c.get("onDamageTaken", []):  ability_power += effect_power(e) * 0.9
    for e in c.get("onSpellCast", []):    ability_power += effect_power(e) * 1.1

    # Пол тела: дорогие карты с сильными эффектами не должны быть «стеклянными»
    stats_target = max(target_total * 0.62, target_total - ability_power)
    stats_target = max(2.0, stats_target)
    # фракционный коэффициент авто-баланса
    stats_target *= coef(c["faction"], "bodyMul")

    share_lo, share_hi = {"brute": (0.50, 0.68), "tank": (0.25, 0.45),
                          "balanced": (0.40, 0.60)}[archetype]

    total = int(round(stats_target))
    total = max(2, total)
    atk = int(round(total * rng.uniform(share_lo, share_hi)))
    atk = max(1, min(total - 1, atk))
    hp = total - atk

    # Жёсткие ограничения по стоимости.
    # ВАЖНО: в авто-бою (ТЗ 2.2, фаза «Битва») цель выбирается по НАИМЕНЬШЕМУ здоровью,
    # поэтому существо с hp < cost+1 умирает, не успев атаковать. Пол здоровья обязателен.
    max_atk = max(1, cost + 3)
    max_hp = max(1, cost + 6)
    min_atk = max(1, (cost + 1) // 2)
    min_hp = max(1, cost + 1, (cost + 1) // 2)
    atk = max(min_atk, min(max_atk, atk))
    hp = max(min_hp, min(max_hp, hp))

    c["attack"], c["health"] = atk, hp
    c["_abilityPower"] = round(ability_power, 2)
    c["_statsTarget"] = round(stats_target, 2)
    return c


# ===========================================================================
#  ЖЁСТКИЕ ПРЕДЕЛЫ И СТОИМОСТНЫЕ МИНИМУМЫ (анти-«сломанные комбинации»)
# ===========================================================================

SCALABLE_OPS = {
    "damage": ("value", 1, 10),
    "heal": ("value", 1, 12),
    "buffAttack": ("value", 1, 5),
    "buffHealth": ("value", 1, 8),
    "debuffAttack": ("value", 1, 4),
    "damageAllEnemyCreatures": ("value", 1, 6),
    "damageAllFriendlyCreatures": ("value", 1, 6),
    "damageAllCreatures": ("value", 1, 6),
    "healAllFriendlyCreatures": ("value", 1, 6),
    "reduceIncomingDamage": ("value", 1, 3),
    "increaseSpellDamage": ("value", 1, 3),
    "gainMana": ("value", 1, 2),
}
STATUS_VALUE_CAP = {"Burn": 3, "Poison": 1, "Freeze": 1, "Shield": 2, "Fury": 1, "Silence": 1}
STATUS_DURATION_CAP = {"Burn": 3, "Poison": 2, "Freeze": 1, "Shield": 3, "Fury": 1, "Silence": 1}

# Максимальное значение ауры в зависимости от стоимости руны (ключ -> [cost] = max)
AURA_MAX_BY_COST = {
    "extraMana":        {1:0, 2:0, 3:1, 4:1, 5:1, 6:2, 7:2},
    "extraCard":        {1:0, 2:0, 3:1, 4:1, 5:1, 6:2, 7:2},
    "drawOnResource":   {1:0, 2:0, 3:1, 4:1, 5:1, 6:1, 7:1},
    "buffAttack":       {1:0, 2:1, 3:1, 4:1, 5:1, 6:2, 7:2},
    "buffHealth":       {1:0, 2:1, 3:1, 4:2, 5:2, 6:2, 7:3},
    "debuffAttackEnemy":{1:0, 2:1, 3:1, 4:1, 5:1, 6:2, 7:2},
    "spellDamage":      {1:0, 2:1, 3:1, 4:1, 5:2, 6:2, 7:2},
    "heroProtection":   {1:0, 2:1, 3:1, 4:2, 5:2, 6:3, 7:3},
    "healReduction":    {1:0, 2:0, 3:1, 4:1, 5:1, 6:2, 7:2},
    "buffAttackHealth_atk": {1:0, 2:0, 3:1, 4:1, 5:1, 6:2, 7:2},
    "buffAttackHealth_hp":  {1:0, 2:0, 3:1, 4:1, 5:1, 6:2, 7:2},
}

# Минимальная стоимость руны с такой аурой: cost >= base + per*value
AURA_MIN_COST = {
    "extraMana":        (3.0, 2.0),
    "extraCard":        (3.0, 2.0),
    "drawOnResource":   (3.0, 2.0),
    "buffAttack":       (2.0, 2.0),
    "buffHealth":       (2.0, 1.2),
    "debuffAttackEnemy":(3.0, 1.8),
    "spellDamage":      (2.0, 2.0),
    "heroProtection":   (2.0, 1.5),
    "buffAttackHealth": (4.0, 2.0),
    "healReduction":    (3.0, 1.5),
}

# Минимальная стоимость руны с триггером «в начале хода»
# Минимальная стоимость ЗАКЛИНАНИЯ, содержащего данный эффект: cost >= base + per*value
SPELL_MIN_COST = {
    "destroyCreature":          (5.0, 1.5),
    "stealCreature":            (6.0, 0.0),
    "returnToHand":             (3.0, 0.0),
    "silence":                  (2.0, 0.0),
    "stealCard":                (2.0, 1.0),
    "draw":                     (1.0, 1.0),
    "sacrifice":                (1.0, 0.0),
    "gainMaxMana":              (3.0, 2.0),
    "freezeAllEnemies":         (3.0, 1.0),
    "damageAllEnemyCreatures":  (2.0, 1.0),
    "damageAllCreatures":       (2.0, 0.8),
    "burnAllEnemies":           (3.0, 1.2),
    "shieldAllFriendlies":      (2.0, 0.5),
    "heal":                     (1.0, 0.35),
    "damage":                   (1.0, 0.6),
    "gainMana":                 (1.0, 1.0),
    "reduceIncomingDamage":     (2.0, 1.0),
}

TICK_MIN_COST = {
    "heal":                     (2.0, 0.5),   # value = кол-во лечения
    "damage":                   (1.0, 1.0),   # value = урон вражескому герою
    "damageAllEnemyCreatures":  (3.0, 1.5),
    "damageAllCreatures":       (2.5, 1.2),
    "burnAllEnemies":           (3.0, 1.6),
    "freezeAllEnemies":         (5.0, 0.0),
    "stealCard":                (3.0, 2.0),
    "returnToHand":             (4.0, 1.5),
    "draw":                     (3.0, 1.5),
    "gainMana":                 (2.0, 1.5),
}


def clamp_int(v: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(v))))


def _tick_value(eff: Dict[str, Any]) -> float:
    op = eff.get("op")
    if op == "burnAllEnemies":
        return float(eff.get("statusValue", 1))
    if op == "returnToHand":
        return float((eff.get("filter") or {}).get("count", 1))
    if op in ("damageAllEnemyCreatures", "damageAllCreatures", "healAllFriendlies"):
        return float(eff.get("value", 1))
    return float(eff.get("value", 1) or 1)


def spell_min_cost(c: Dict[str, Any]) -> float:
    """Минимальная «честная» стоимость заклинания по его составу."""
    mc = 1.0
    for eff in c.get("effects", []) or []:
        op = eff.get("op")
        if op in SPELL_MIN_COST:
            base, per = SPELL_MIN_COST[op]
            n = _aoe_targets(eff) if op in ("destroyCreature", "returnToHand", "stealCreature") else 1.0
            v = float(eff.get("value", 1) or 1) if op in ("draw", "stealCard", "damage", "heal",
                                                           "damageAllEnemyCreatures", "damageAllCreatures",
                                                           "burnAllEnemies", "freezeAllEnemies",
                                                           "gainMana", "gainMaxMana", "reduceIncomingDamage") else 1.0
            mc = max(mc, base + per * v + (n - 1) * 1.5)
        else:
            mc = max(mc, 1.0 + effect_power(eff) / 2.0)
    return mc


def rune_min_cost(c: Dict[str, Any]) -> float:
    """Минимальная «честная» стоимость руны по её составу."""
    mc = 0.0
    aura = c.get("aura")
    if aura:
        op = aura.get("op")
        if op == "buffAttackHealth":
            base, per = AURA_MIN_COST["buffAttackHealth"]
            v = float(aura.get("atk", 0)) + float(aura.get("hp", 0))
            mc = max(mc, base + per * v)
        elif op in AURA_MIN_COST:
            base, per = AURA_MIN_COST[op]
            mc = max(mc, base + per * float(aura.get("value", 1) or 1))
    for eff in c.get("onTurnStart", []) or []:
        op = eff.get("op")
        if op in TICK_MIN_COST:
            base, per = TICK_MIN_COST[op]
            mc = max(mc, base + per * _tick_value(eff))
        else:
            mc = max(mc, 1.0 + effect_power(eff) / 2.0)
    for eff in c.get("onPlay", []) or []:
        mc = max(mc, 1.0 + effect_power(eff) / 2.0)
    return mc


def cap_aura_to_cost(c: Dict[str, Any], cost: int) -> bool:
    """Обрезает значения ауры под максимум для данной стоимости."""
    aura = c.get("aura")
    if not aura:
        return False
    op = aura.get("op")
    changed = False
    if op == "buffAttackHealth":
        for k in ("atk", "hp"):
            cap = AURA_MAX_BY_COST[f"buffAttackHealth_{k}"].get(cost, 1)
            if isinstance(aura.get(k), (int, float)) and aura[k] > cap:
                aura[k] = cap; changed = True
    elif op in AURA_MAX_BY_COST:
        cap = AURA_MAX_BY_COST[op].get(cost, 1)
        if isinstance(aura.get("value"), (int, float)) and aura["value"] > cap:
            aura["value"] = cap; changed = True
    return changed


def scale_card_effects(c: Dict[str, Any], factor: float, only_down: bool = True) -> bool:
    """Масштабирует числовые параметры эффектов (по умолчанию — только вниз)."""
    changed = False
    for bucket in ("effects", "onTurnStart", "onPlay"):
        for eff in c.get(bucket, []) or []:
            op = eff.get("op")
            if op == "applyStatus":
                st = eff.get("status", "Burn")
                if "statusValue" in eff and st in ("Burn", "Shield"):
                    cap = STATUS_VALUE_CAP.get(st, 3)
                    raw = eff["statusValue"] * factor
                    new = clamp_int(raw if not only_down else min(raw, eff["statusValue"]), 1, cap)
                    if new != eff["statusValue"]:
                        eff["statusValue"] = new; changed = True
                cap = STATUS_DURATION_CAP.get(st, 2)
                if isinstance(eff.get("value"), int):
                    raw = eff["value"] * factor
                    new = clamp_int(raw if not only_down else min(raw, eff["value"]), 1, cap)
                    if new != eff["value"]:
                        eff["value"] = new; changed = True
                continue
            if op in ("freezeAllEnemies", "burnAllEnemies", "shieldAllFriendlies"):
                if op == "burnAllEnemies" and "statusValue" in eff:
                    raw = eff["statusValue"] * factor
                    new = clamp_int(raw if not only_down else min(raw, eff["statusValue"]), 1, STATUS_VALUE_CAP["Burn"])
                    if new != eff["statusValue"]:
                        eff["statusValue"] = new; changed = True
                cap = 1 if op == "freezeAllEnemies" else (3 if op == "burnAllEnemies" else 2)
                if isinstance(eff.get("value"), int):
                    raw = eff["value"] * factor
                    new = clamp_int(raw if not only_down else min(raw, eff["value"]), 1, cap)
                    if new != eff["value"]:
                        eff["value"] = new; changed = True
                continue
            if op in SCALABLE_OPS:
                fld, lo, hi = SCALABLE_OPS[op]
                if isinstance(eff.get(fld), (int, float)):
                    raw = eff[fld] * factor
                    new = clamp_int(raw if not only_down else min(raw, eff[fld]), lo, hi)
                    if new != eff[fld]:
                        eff[fld] = new; changed = True
    aura = c.get("aura")
    if aura and not only_down:
        op = aura.get("op")
        if op == "buffAttackHealth":
            for k in ("atk", "hp"):
                cap = AURA_MAX_BY_COST[f"buffAttackHealth_{k}"].get(int(c.get("cost", 3)), 1)
                new = clamp_int(aura[k] * factor, 0, cap)
                if new != aura[k]:
                    aura[k] = new; changed = True
        elif op in AURA_MAX_BY_COST:
            cap = AURA_MAX_BY_COST[op].get(int(c.get("cost", 3)), 1)
            new = clamp_int(aura["value"] * factor, 1, cap)
            if new != aura["value"]:
                aura["value"] = new; changed = True
    return changed


IMMUTABLE_OPS = {"destroyCreature", "stealCreature", "stealCard", "returnToHand", "silence",
                 "draw", "opponentDraw", "sacrifice", "gainMaxMana", "summonToken", "gainEcho",
                 "mill", "copyLastSpell", "stealCard"}


def fixed_power(c: Dict[str, Any]) -> float:
    """Сила НЕмасштабируемых эффектов — они задают «пол» стоимости."""
    total = 0.0
    for bucket in ("effects", "onTurnStart", "onPlay"):
        for eff in c.get(bucket, []) or []:
            if eff.get("op") in IMMUTABLE_OPS:
                total += effect_power(eff)
    if c["type"] == "Spell" and c.get("subtype") == "Ritual":
        total *= RITUAL_BONUS
    return total


def fit_to_cost(c: Dict[str, Any], lo: Optional[int] = None) -> Dict[str, Any]:
    """
    1) Стоимость задаётся дизайнером (кривая маны сохраняется).
    2) Числовые параметры эффектов подгоняются ВНИЗ под бюджет 2*cost+1.2.
    3) Стоимость повышается только если немасштабируемые эффекты (уничтожение,
       кража, добор, призыв токена) не помещаются в бюджет — это защита от
       «сломанных комбинаций» (ТЗ п.7.1).
    """
    designer = int(c.get("cost", 3))
    snapshot = json.loads(json.dumps(c, ensure_ascii=False))

    fp = fixed_power(c)
    min_cost_fixed = cost_from_power(fp)
    if c["type"] == "Rune":
        min_cost_fixed = max(min_cost_fixed, int(math.ceil(rune_min_cost(snapshot))))
    else:
        min_cost_fixed = max(min_cost_fixed, int(math.ceil(spell_min_cost(snapshot))))
    start_cost = max(1, min(7, designer, max(1, min_cost_fixed)))
    if lo is not None:
        start_cost = max(start_cost, lo)

    best = None
    for cost in range(start_cost, 8):
        c.clear(); c.update(json.loads(json.dumps(snapshot, ensure_ascii=False)))
        c["cost"] = cost
        cap_aura_to_cost(c, cost)
        target = target_power_for_cost(cost)
        # фракционный коэффициент: <1 ослабляет карту, >1 усиливает
        mult = coef(c.get("faction", "Neutral"), "runeMul" if c["type"] == "Rune" else "spellMul")
        target *= max(0.4, min(2.0, mult))
        for _ in range(8):
            cur = card_power(c)
            if cur <= 0:
                break
            if cur <= target * 1.08:
                break
            if not scale_card_effects(c, target / cur, only_down=True):
                break
        final = card_power(c)
        over = max(0.0, fp - target * 1.15)          # неизменяемые эффекты не влезают
        dev = abs(final - target) + over * 2.0
        score = dev + abs(cost - designer) * 3.0
        if best is None or score < best[0]:
            best = (score, cost, final, json.loads(json.dumps(c, ensure_ascii=False)))

    c.clear(); c.update(best[3])
    c["_power"] = round(best[2], 2)
    c["_fixedPower"] = round(fp, 2)
    c["_targetPower"] = round(target_power_for_cost(c["cost"]), 2)
    c["_designedCost"] = designer
    return c


def fix_rarities(pool: List[Dict[str, Any]]) -> Dict[str, int]:
    """Приводит распределение редкостей к ТЗ: 60% / 25% / 10% / 5%."""
    main = [c for c in pool if c["faction"] in FACTIONS]
    target = {"Common": 90, "Rare": 38, "Epic": 15, "Legendary": 7}
    counts = Counter(c["rarity"] for c in main)
    report = dict(counts)

    def by_power(c):
        return card_power(c)

    # Легендарные
    while counts["Legendary"] > target["Legendary"]:
        cand = sorted([c for c in main if c["rarity"] == "Legendary"], key=by_power)
        cand[0]["rarity"] = "Epic"; counts["Legendary"] -= 1; counts["Epic"] += 1
    while counts["Legendary"] < target["Legendary"]:
        cand = sorted([c for c in main if c["rarity"] == "Epic"], key=by_power, reverse=True)
        cand[0]["rarity"] = "Legendary"; counts["Epic"] -= 1; counts["Legendary"] += 1
    # Эпические
    while counts["Epic"] > target["Epic"]:
        cand = sorted([c for c in main if c["rarity"] == "Epic"], key=by_power)
        cand[0]["rarity"] = "Rare"; counts["Epic"] -= 1; counts["Rare"] += 1
    while counts["Epic"] < target["Epic"]:
        cand = sorted([c for c in main if c["rarity"] == "Rare"], key=by_power, reverse=True)
        cand[0]["rarity"] = "Epic"; counts["Rare"] -= 1; counts["Epic"] += 1
    # Редкие
    while counts["Rare"] > target["Rare"]:
        cand = sorted([c for c in main if c["rarity"] == "Rare"], key=by_power)
        cand[0]["rarity"] = "Common"; counts["Rare"] -= 1; counts["Common"] += 1
    while counts["Rare"] < target["Rare"]:
        cand = sorted([c for c in main if c["rarity"] == "Common"], key=by_power, reverse=True)
        cand[0]["rarity"] = "Rare"; counts["Common"] -= 1; counts["Rare"] += 1

    report["after"] = dict(counts)
    return report


# ---------------------------------------------------------------------------
# Колоды (ТЗ п.7.3)
# ---------------------------------------------------------------------------

def build_decks(pool: List[Dict[str, Any]], rng: random.Random) -> Dict[str, List[str]]:
    main = [c for c in pool if c["faction"] in FACTIONS]
    neutral = [c for c in pool if c["faction"] == "Neutral"]
    decks: Dict[str, List[str]] = {}

    for fac in FACTIONS:
        fac_cards = [c for c in main if c["faction"] == fac]
        creatures = [c for c in fac_cards if c["type"] == "Creature"]
        spells    = [c for c in fac_cards if c["type"] == "Spell"]
        runes     = [c for c in fac_cards if c["type"] == "Rune"]
        deck: List[str] = []

        # 18 существ (по кривой стоимости), 14 заклинаний, 4 руны, 4 нейтральных = 40
        curve_creature = [1,1,1,2,2,2,3,3,3,3,4,4,4,5,5,5,6,7]
        for want in curve_creature:
            cands = [c for c in creatures if c["cost"] == want] or \
                    sorted(creatures, key=lambda c: abs(c["cost"] - want))
            deck.append(rng.choice(cands)["id"])
        curve_spell = [1,1,2,2,2,3,3,3,4,4,4,5,5,6]
        for want in curve_spell:
            cands = [c for c in spells if c["cost"] == want] or \
                    sorted(spells, key=lambda c: abs(c["cost"] - want))
            deck.append(rng.choice(cands)["id"])
        for _ in range(4):
            deck.append(rng.choice(runes)["id"])
        for _ in range(4):
            deck.append(rng.choice(neutral)["id"])

        # дубликаты: максимум 2 копии одной карты (легендарные — 1)
        deck = apply_copy_limit(deck, pool, rng)
        decks[fac] = deck

    # Стартовая колода новичка: микс с упором на Ауритов (по ТЗ — «упор на одну основную»)
    starter: List[str] = []
    aur = [c for c in main if c["faction"] == "Aurites"]
    for _ in range(22): starter.append(rng.choice(aur)["id"])
    others = [c for c in main if c["faction"] != "Aurites"]
    for _ in range(14): starter.append(rng.choice(others)["id"])
    for _ in range(4):  starter.append(rng.choice(neutral)["id"])
    starter = apply_copy_limit(starter, pool, rng)
    decks["Starter"] = starter
    return decks


def apply_copy_limit(deck: List[str], pool: List[Dict[str, Any]], rng: random.Random) -> List[str]:
    by_id = {c["id"]: c for c in pool}
    counts: Counter = Counter()
    out: List[str] = []
    alternates = [c["id"] for c in pool if c["faction"] in FACTIONS]
    for cid in deck:
        limit = 1 if by_id[cid]["rarity"] == "Legendary" else 2
        tries = 0
        while counts[cid] >= limit and tries < 40:
            cid = rng.choice(alternates)
            limit = 1 if by_id[cid]["rarity"] == "Legendary" else 2
            tries += 1
        counts[cid] += 1
        out.append(cid)
    # добиваем до 40
    while len(out) < 40:
        cid = rng.choice(alternates)
        limit = 1 if by_id[cid]["rarity"] == "Legendary" else 2
        if counts[cid] < limit:
            counts[cid] += 1; out.append(cid)
    return out[:40]


# ---------------------------------------------------------------------------
# Валидация (ТЗ п.10, критерий 7)
# ---------------------------------------------------------------------------

def validate(pool: List[Dict[str, Any]]) -> List[str]:
    errs: List[str] = []
    ids = [c["id"] for c in pool]
    dup = [i for i, n in Counter(ids).items() if n > 1]
    if dup: errs.append(f"Дубликаты id: {dup}")

    main = [c for c in pool if c["faction"] in FACTIONS]
    if len(main) != 150: errs.append(f"Основных карт {len(main)}, требуется 150")

    per_f = Counter(c["faction"] for c in main)
    for f in FACTIONS:
        if per_f[f] != 30: errs.append(f"{f}: {per_f[f]} карт, требуется 30")

    per_t = Counter(c["type"] for c in main)
    exp = {"Creature": 75, "Spell": 45, "Rune": 30}
    for t, n in exp.items():
        if per_t[t] != n: errs.append(f"Тип {t}: {per_t[t]}, требуется {n}")

    per_r = Counter(c["rarity"] for c in main)
    exp_r = {"Common": 90, "Rare": 38, "Epic": 15, "Legendary": 7}
    for r, n in exp_r.items():
        if per_r[r] != n: errs.append(f"Редкость {r}: {per_r[r]}, требуется {n}")

    for c in main:
        if not (1 <= c["cost"] <= 7): errs.append(f"{c['id']}: cost={c['cost']} вне 1..7")
        if c["type"] == "Creature":
            if c.get("attack", 0) < 1: errs.append(f"{c['id']}: attack < 1")
            if c.get("health", 0) < 1: errs.append(f"{c['id']}: health < 1")
            if c.get("attack", 0) + c.get("health", 0) > 2 * c["cost"] + 6:
                errs.append(f"{c['id']}: подозрительно сильное тело")
        if not c.get("name"): errs.append(f"{c['id']}: нет имени")
        if not c.get("flavor"): errs.append(f"{c['id']}: нет flavor-текста")
        if not c.get("abilityText") and (c.get("effects") or c.get("aura") or c.get("keywords")
                                          or c.get("onDeath") or c.get("onTurnStart")):
            errs.append(f"{c['id']}: пустой abilityText при наличии эффектов")
    return errs


# ---------------------------------------------------------------------------
# Опциональное LLM-обогащение (OpenAI-совместимый API)
# ---------------------------------------------------------------------------

LLM_SYSTEM = (
    "Ты — нарративный дизайнер коллекционной карточной игры в жанре тёмного фэнтези. "
    "Для каждой карты придумай одну лоровую фразу (flavor text) на русском, 4-12 слов, "
    "в кавычках-ёлочках, атмосферную, без игровых цифр и механик. "
    "Верни СТРОГО JSON-массив строк той же длины, что и входной список."
)


def llm_enrich(cards: List[Dict[str, Any]], model: str = "gpt-4o-mini",
               base_url: str = "https://api.openai.com/v1", api_key: str = "") -> int:
    """Переписывает flavor'ы через LLM батчами по 30 карт. Возвращает число обновлённых."""
    try:
        import urllib.request
    except Exception:
        return 0
    updated = 0
    for i in range(0, len(cards), 30):
        batch = cards[i:i + 30]
        payload = [{
            "id": c["id"], "name": c["name"], "faction": FACTION_RU.get(c["faction"], c["faction"]),
            "type": c["type"], "ability": c.get("abilityText", ""),
        } for c in batch]
        body = json.dumps({
            "model": model,
            "messages": [
                {"role": "system", "content": LLM_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            "temperature": 0.9,
            "response_format": {"type": "json_object"},
        }).encode("utf-8")
        req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {api_key}"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                resp = json.loads(r.read().decode("utf-8"))
            text = resp["choices"][0]["message"]["content"]
            data = json.loads(text)
            lines = data.get("flavors") or data.get("result") or data
            if isinstance(lines, dict): lines = list(lines.values())
            for c, line in zip(batch, lines):
                if isinstance(line, str) and line.strip():
                    c["flavor"] = "«" + line.strip().strip('«»"') + "»"
                    updated += 1
        except Exception as ex:
            print(f"  [LLM] батч {i}: {ex} — оставляю локальные flavor'ы", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Генератор карт «Эхо-Цитадель»")
    ap.add_argument("--llm", action="store_true", help="обогатить flavor-тексты через OpenAI-совместимый API")
    ap.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
    ap.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    pool = build_pool()
    print(f"[1/7] Сгенерировано записей: {len(pool)} (включая нейтральные и токены)")

    # токены — отдельный список, не входят в квоту 150
    tokens = [t for t in TOKENS]

    # балансировка
    for c in pool:
        if c["type"] == "Creature":
            auto_balance_creature(c, rng)
        else:
            fit_to_cost(c)
    print("[2/7] Авто-балансировка статов и стоимости завершена")

    # редкости -> 60/25/10/5
    r_report = fix_rarities(pool)
    print(f"[3/7] Редкости: {r_report}")

    # тексты, лор, арт
    neutral_flavor = [
        "«Цитадель слышит каждое эхо. И каждое — помнит.»",
        "«Здесь заканчиваются карты и начинается память.»",
        "«Стены сложены из тех, кто не отступил.»",
        "«Эхо возвращается всегда. Вопрос — чьим голосом.»",
    ]
    for c in pool:
        c["abilityText"] = build_ability_text(c)
        if not c.get("flavor"):
            src = FLAVOR.get(c["faction"], neutral_flavor)
            c["flavor"] = rng.choice(src)
        # арты лежат ПО ФРАКЦИЯМ: Assets/Resources/Cards/<Faction>/<id>.png
        # (папки и манифесты создаёт tools/generator/make_art_folders.py)
        c["art"] = f"Resources/Cards/{c['faction']}/{c['id']}.png"
        c["artworkPath"] = c["art"]
        c["artPrompt"] = art_prompt(c)
        c["negativePrompt"] = NEGATIVE_PROMPT
        c["artSize"] = "512x720"

    if args.llm:
        key = os.environ.get("OPENAI_API_KEY", "")
        if not key:
            print("[LLM] OPENAI_API_KEY не задан — пропускаю обогащение", file=sys.stderr)
        else:
            n = llm_enrich([c for c in pool if c["faction"] in FACTIONS], args.model, args.base_url, key)
            print(f"[LLM] Обновлено flavor-текстов: {n}")

    # валидация
    errs = validate(pool)
    if errs:
        print("[4/7] ВАЛИДАЦИЯ — найдены проблемы:")
        for e in errs: print("   -", e)
    else:
        print("[4/7] Валидация: OK (150 карт, 30/фракция, 50/30/20 по типам, 60/25/10/5 по редкостям)")

    # запись Cards.json
    out = {
        "meta": {
            "game": "Эхо-Цитадель", "version": "1.0.0",
            "generatedAt": "2026-09-03", "seed": args.seed,
            "totalCards": len([c for c in pool if c["faction"] in FACTIONS]),
            "totalTokens": len(tokens),
            "distribution": {
                "types": dict(Counter(c["type"] for c in pool if c["faction"] in FACTIONS)),
                "rarities": dict(Counter(c["rarity"] for c in pool if c["faction"] in FACTIONS)),
                "factions": dict(Counter(c["faction"] for c in pool if c["faction"] in FACTIONS)),
            },
            "balanceModel": "power = body + keywords + effects; cost = round((power-1.2)/2)",
            "factionCoefficients": COEF,
        },
        "cards": [strip_private(c) for c in pool],
        "tokens": [strip_private(t) for t in tokens],
    }
    cards_path = os.path.join(OUT_DIR, "unity", "EchoCitadel", "Assets", "StreamingAssets", "Cards.json")
    os.makedirs(os.path.dirname(cards_path), exist_ok=True)
    with open(cards_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"[5/7] Записан {cards_path} ({len(out['cards'])} карт + {len(tokens)} токенов)")

    # отчёт баланса
    rep_path = os.path.join(OUT_DIR, "docs", "balance", "card_power_report.csv")
    os.makedirs(os.path.dirname(rep_path), exist_ok=True)
    with open(rep_path, "w", encoding="utf-8") as f:
        f.write("id,name,faction,type,rarity,cost,attack,health,power,power_per_cost,ability_power,designed_cost,drift\n")
        for c in pool:
            pw = card_power(c)
            ppc = round(pw / max(1, c["cost"]), 3)
            f.write(f"{c['id']},{c['name']},{c['faction']},{c['type']},{c['rarity']},{c['cost']},"
                    f"{c.get('attack','')},{c.get('health','')},{round(pw,2)},{ppc},"
                    f"{c.get('_abilityPower','')},{c.get('_designedCost','')},{round(pw - target_power_for_cost(c['cost']),2)}\n")
    print(f"[6/7] Записан {rep_path}")

    # арт-промпты
    art_path = os.path.join(OUT_DIR, "docs", "art_prompts.csv")
    with open(art_path, "w", encoding="utf-8") as f:
        f.write("id,name,faction,rarity,size,folder,file,prompt,negative\n")
        for c in pool:
            pr = c["artPrompt"].replace('"', "'")
            ng = NEGATIVE_PROMPT.replace('"', "'")
            folder = f"Resources/Cards/{c['faction']}"
            f.write(f'{c["id"]},"{c["name"]}",{c["faction"]},{c["rarity"]},512x720,'
                    f'{folder},{folder}/{c["id"]}.png,"{pr}","{ng}"\n')
    print(f"[7/7] Записан {art_path}")

    # колоды
    decks = build_decks(pool, random.Random(args.seed + 7))
    deck_out = {
        "meta": {"deckSize": 40, "copyLimit": 2, "legendaryCopyLimit": 1},
        "decks": [{"id": k, "name": deck_name(k), "faction": k, "cards": v} for k, v in decks.items()],
    }
    deck_path = os.path.join(OUT_DIR, "unity", "EchoCitadel", "Assets", "StreamingAssets", "Decks.json")
    with open(deck_path, "w", encoding="utf-8") as f:
        json.dump(deck_out, f, ensure_ascii=False, indent=2)
    print(f"      Записан {deck_path} ({len(decks)} колод)")

    # сводка по фракциям
    print("\n=== СВОДКА БАЛАНСА ПО ФРАКЦИЯМ (модельная сила) ===")
    print(f"{'Фракция':<14}{'Существ':>8}{'Закл.':>7}{'Рун':>6}{'Σ сила':>10}{'ср/карту':>10}")
    for f_ in FACTIONS + ["Neutral"]:
        fc = [c for c in pool if c["faction"] == f_]
        tot = sum(card_power(c) for c in fc)
        print(f"{FACTION_RU[f_]:<14}{sum(1 for c in fc if c['type']=='Creature'):>8}"
              f"{sum(1 for c in fc if c['type']=='Spell'):>7}{sum(1 for c in fc if c['type']=='Rune'):>6}"
              f"{tot:>10.1f}{tot/max(1,len(fc)):>10.2f}")
    return 0 if not errs else 1


def deck_name(key: str) -> str:
    return {
        "Aurites": "Оплот Света (Ауриты)", "Necrus": "Кровавая Жатва (Некрусы)",
        "Terramorph": "Корни Земли (Терраморфы)", "Pyromancer": "Пламя Возмездия (Пироманты)",
        "Ethereal": "Тысяча Вуалей (Эфирные)", "Starter": "Стартовая колода Цитадели",
    }.get(key, key)


def strip_private(c: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in c.items() if not k.startswith("_")}


if __name__ == "__main__":
    raise SystemExit(main())
