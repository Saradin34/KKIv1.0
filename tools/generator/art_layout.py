#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Canonical card-art subfaction layout shared by the data and folder generators."""
from __future__ import annotations

SUBFACTIONS = {
    "meh": {"folder": "Mechanoids", "name": "Мехи / механоиды", "faction": "Aurites", "direction": "агро"},
    "grm": {"folder": "Gremlins", "name": "Гремлины", "faction": "Pyromancer", "direction": "агро"},
    "spr": {"folder": "Sprites", "name": "Спрайты", "faction": "Ethereal", "direction": "агро"},
    "vmp": {"folder": "Vampires", "name": "Вампиры", "faction": "Necrus", "direction": "отжор"},
    "cnb": {"folder": "Cannibals", "name": "Каннибалы", "faction": "Pyromancer", "direction": "отжор"},
    "scc": {"folder": "Succubi", "name": "Суккубы", "faction": "Ethereal", "direction": "отжор"},
    "ent": {"folder": "Ents", "name": "Энты", "faction": "Terramorph", "direction": "токены"},
    "pal": {"folder": "PaladinBrotherhood", "name": "Братство паладинов", "faction": "Aurites", "direction": "токены"},
    "sbd": {"folder": "SacredBrotherhood", "name": "Священное братство / священники", "faction": "Neutral", "direction": "токены"},
    "wtc": {"folder": "Witches", "name": "Ведьмы", "faction": "Necrus", "direction": "яд и порча"},
    "asp": {"folder": "Aspids", "name": "Аспиды", "faction": "Terramorph", "direction": "яд и порча"},
    "wtd": {"folder": "Withered", "name": "Иссохшие", "faction": "Neutral", "direction": "яд и порча"},
    "nsu": {"folder": "Mercenaries", "name": "Наёмники", "faction": "Neutral", "direction": "поддержка"},
}


def subfaction_code(card: dict) -> str | None:
    """Resolve a family from explicit tags first, then from the stable card-id prefix."""
    for tag in card.get("tags", []) or []:
        if tag in SUBFACTIONS:
            return tag
    prefix = str(card.get("id", "")).split("_", 1)[0]
    return prefix if prefix in SUBFACTIONS else None


def resource_card_path(faction: str, card_id: str, family: str | None = None) -> str:
    """Return the Unity Resources path used by Cards.json and the browser art route."""
    spec = SUBFACTIONS.get(family or "")
    if spec and spec["faction"] == faction:
        return f"Resources/Cards/{faction}/{spec['folder']}/{card_id}.png"
    return f"Resources/Cards/{faction}/{card_id}.png"


def art_layout_metadata() -> dict:
    """JSON-friendly map documented beside the faction roots in Cards.json."""
    return {
        code: {
            "name": spec["name"],
            "faction": spec["faction"],
            "direction": spec["direction"],
            "folder": f"Assets/Resources/Cards/{spec['faction']}/{spec['folder']}",
        }
        for code, spec in SUBFACTIONS.items()
    }


def subfaction_by_folder() -> dict[str, dict]:
    return {spec["folder"]: {"code": code, **spec} for code, spec in SUBFACTIONS.items()}
