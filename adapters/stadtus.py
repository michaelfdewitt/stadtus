"""Tiny helper for writing Stadtus city JSON documents.

A city document is:
    {"name": str, "fields": {key: {"type", "label", "scale", "unit", "order"}},
     "defaults": {"height": key, "color": key, "spire": key, "label": key},
     "items": [{"name": str, "path": [str, ...], ...metadata}]}

Only "items" is required; the browser infers field types. "actions" lists edits
users may apply to selected items in the UI; the UI exports them as a diff:
    {"id": "fix", "label": "Mark fixed", "set": {"status": "fixed"}, "when": {"status": ["open"]}}
    {"id": "assign", "label": "Reassign", "field": "assignee"} Declare fields when
inference would guess wrong (e.g. a numeric status code that is really a
category) or to set labels, units, log scale, or an explicit category order.
"""
import json
from typing import Any, Dict, Iterable, List, Optional


def city(name: str, items: Iterable[Dict[str, Any]], fields: Optional[Dict[str, Dict[str, Any]]] = None,
         defaults: Optional[Dict[str, str]] = None, actions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    doc: Dict[str, Any] = {"name": name, "items": list(items)}
    if fields:
        doc["fields"] = fields
    if defaults:
        doc["defaults"] = defaults
    if actions:
        doc["actions"] = actions
    return doc


def write(doc: Dict[str, Any], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path}: {len(doc['items'])} items")
