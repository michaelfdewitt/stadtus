#!/usr/bin/env python3
"""Generate the sample datasets in data/: a bug tracker and personal expenses.

    python3 adapters/samples.py
"""
import datetime as dt
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import stadtus  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "data")


def bugs(rng: random.Random, n: int = 2500):
    """A bug tracker with planted stories, so the city has something to say:

    - dee sits on the oldest bugs and never closes them
    - bo only takes P0/P1 and closes them within days (the tank)
    - eli closes everything fast; fay only works docs bugs
    - frontend/editor has a fresh crash regression: a dense patch of young, severe, unassigned bugs
    - infra/ci bugs are flaky: huge comment threads, forever in progress
    - sdk/go is abandoned: everything is won't fix
    """
    components = {
        "frontend": ["editor", "dashboard", "settings", "onboarding", "mobile"],
        "backend": ["auth", "billing", "search", "sync", "notifications", "export"],
        "infra": ["ci", "deploy", "monitoring", "storage"],
        "data": ["pipeline", "warehouse", "reports"],
        "sdk": ["python", "js", "go"],
    }
    weights = [5, 6, 2, 2, 1.5]
    kinds = ["crash", "perf", "ui", "data loss", "security", "docs"]
    people = ["ana", "bo", "chen", "dee", "eli", "fay", "gus", "hana", "ivo", "jun"]
    severities = ["low", "medium", "high", "critical"]
    statuses = ["open", "in progress", "fixed", "won't fix"]
    today = dt.date(2026, 11, 1)
    items = []

    def make(i, comp, sub, kind, sev, status, age, assignee, priority=None, comments=None, reports=None):
        if priority is None:
            base = {"low": 3, "medium": 2, "high": 1, "critical": 0}[sev]
            priority = "P%d" % min(3, max(0, base + rng.choice([0, 0, 0, 1, -1])))
        if comments is None:
            comments = int(rng.expovariate(1 / 3)) + (2 if status != "open" else 0)
        if reports is None:
            reports = int(rng.expovariate(1 / (2 if sev in ("high", "critical") else 0.4)))
        return {
            "id": "BUG-%d" % (1000 + i),
            "name": "BUG-%d" % (1000 + i),
            "path": [comp, sub, kind],
            "title": "%s %s #%d" % (rng.choice(["Crash on", "Slow", "Wrong value in", "Cannot open", "Flaky", "Regression in", "Typo in"]), sub, i),
            "severity": sev,
            "priority": priority,
            "status": status,
            "age_days": age,
            "opened": (today - dt.timedelta(days=age)).isoformat(),
            "comments": comments,
            "assignee": assignee,
            "customer_reports": reports,
        }

    i = 0
    # --- the regression spike: frontend/editor crashes, opened in the last 10 days ---
    for _ in range(70):
        items.append(make(i, "frontend", "editor", "crash", rng.choice(["high", "critical", "critical"]), "open",
                          rng.randrange(0, 10), None if rng.random() < 0.7 else "ana", reports=int(rng.expovariate(1 / 6))))
        i += 1
    # --- flaky CI: medium, forever in progress, enormous threads ---
    for _ in range(60):
        items.append(make(i, "infra", "ci", "perf", "medium", "in progress", rng.randrange(60, 400),
                          rng.choice(["gus", "hana", "ivo"]), comments=rng.randrange(15, 45)))
        i += 1
    # --- sdk/go: abandoned ---
    for _ in range(35):
        items.append(make(i, "sdk", "go", rng.choice(kinds), "low", "won't fix", rng.randrange(200, 700), "jun"))
        i += 1
    # --- everything else, shaped by who owns it ---
    while i < n:
        comp = rng.choices(list(components), weights)[0]
        sub = rng.choice(components[comp])
        kind = rng.choices(kinds, [3, 2, 3, 1, 1, 2])[0]
        who = rng.choices(people + [None], [1, 1, 1, 1.4, 1, 0.8, 1, 1, 1, 0.6, 2])[0]
        if who == "dee":      # hoards the oldest bugs, never closes anything
            sev = rng.choices(severities, [3, 4, 2, 1])[0]
            status = rng.choices(["open", "in progress"], [4, 1])[0]
            age = rng.randrange(300, 700)
            items.append(make(i, comp, sub, kind, sev, status, age, who, comments=int(rng.expovariate(1 / 1.5))))
        elif who == "bo":     # the tank: only P0/P1, closes them within days
            sev = rng.choice(["high", "critical"])
            status = rng.choices(["fixed", "in progress"], [4, 1])[0]
            age = rng.randrange(0, 12) if status == "fixed" else rng.randrange(0, 5)
            items.append(make(i, comp, sub, kind, sev, status, age, who, priority=rng.choice(["P0", "P1"])))
        elif who == "eli":    # closes everything quickly
            sev = rng.choices(severities, [4, 4, 2, 1])[0]
            items.append(make(i, comp, sub, kind, sev, "fixed", rng.randrange(0, 25), who))
        elif who == "fay":    # docs only
            items.append(make(i, comp, sub, "docs", rng.choice(["low", "low", "medium"]), rng.choice(["fixed", "fixed", "open"]), rng.randrange(0, 120), who))
        else:                  # the background population
            sev = rng.choices(severities, [5, 6, 3, 1])[0]
            status = rng.choices(statuses, [5, 2, 5, 1])[0] if who else "open"
            age = int(rng.paretovariate(1.3) * 4) % 400
            items.append(make(i, comp, sub, kind, sev, status, age, who))
        i += 1

    return stadtus.city(
        "Bug tracker", items,
        fields={
            "severity": {"type": "category", "order": severities},
            "priority": {"type": "category", "order": ["P3", "P2", "P1", "P0"]},
            "age_days": {"label": "age (days)", "scale": "sqrt"},
            "customer_reports": {"label": "customer reports"},
        },
        defaults={"height": "age_days", "color": "severity", "spire": "customer_reports", "label": "title"},
        actions=[
            {"id": "fix", "label": "Mark fixed", "set": {"status": "fixed"}, "when": {"status": ["open", "in progress"]}},
            {"id": "wontfix", "label": "Won't fix", "set": {"status": "won't fix"}, "when": {"status": ["open", "in progress"]}},
            {"id": "start", "label": "Start", "set": {"status": "in progress"}, "when": {"status": "open"}},
            {"id": "reopen", "label": "Reopen", "set": {"status": "open"}, "when": {"status": ["fixed", "won't fix"]}},
            {"id": "assign", "label": "Reassign", "field": "assignee", "choices": people},
            {"id": "priority", "label": "Set priority", "field": "priority"},
            {"id": "severity", "label": "Set severity", "field": "severity"},
        ],
    )


def expenses(rng: random.Random):
    cats = {
        "housing": {"rent": (1, 2400, 2400), "utilities": (3, 40, 180), "maintenance": (0.5, 20, 600)},
        "food": {"groceries": (7, 12, 140), "restaurants": (5, 9, 120), "coffee": (12, 3, 9)},
        "transport": {"transit": (6, 2.5, 6), "rideshare": (3, 8, 45), "car": (1.5, 30, 400)},
        "health": {"pharmacy": (1, 8, 90), "gym": (1, 60, 60), "doctor": (0.3, 30, 400)},
        "fun": {"streaming": (1.2, 8, 20), "books": (1, 10, 40), "travel": (0.25, 150, 1800), "concerts": (0.3, 40, 250)},
        "shopping": {"clothes": (1.5, 15, 220), "electronics": (0.4, 20, 1500), "home": (1.5, 8, 300)},
    }
    methods = ["credit card", "debit card", "cash", "transfer"]
    items = []
    start = dt.date(2025, 11, 1)
    for week in range(52):
        for cat, subs in cats.items():
            for sub, (per_week, lo, hi) in subs.items():
                k = rng.poisson(per_week) if hasattr(rng, "poisson") else sum(rng.random() < per_week / 10 for _ in range(10))
                for _ in range(k):
                    day = start + dt.timedelta(days=week * 7 + rng.randrange(7))
                    amount = round(lo * (hi / lo) ** rng.random(), 2)
                    items.append({
                        "name": f"{sub} {day.isoformat()}",
                        "path": [cat, sub, day.strftime("%Y-%m")],
                        "amount": amount,
                        "date": day.isoformat(),
                        "method": rng.choices(methods, [6, 3, 1, 1])[0],
                        "merchant": f"{sub.title()} {rng.choice('ABCDE')}",
                        "recurring": sub in ("rent", "gym", "streaming", "utilities"),
                        "weekday": day.strftime("%a"),
                    })
    return stadtus.city(
        "Personal expenses", items,
        fields={"amount": {"unit": "$", "scale": "sqrt"}, "weekday": {"type": "category", "order": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}},
        defaults={"height": "amount", "color": "method", "spire": "date", "label": "merchant"},
    )


if __name__ == "__main__":
    rng = random.Random(7)
    os.makedirs(OUT, exist_ok=True)
    stadtus.write(bugs(rng), os.path.join(OUT, "bugs.json"))
    stadtus.write(expenses(rng), os.path.join(OUT, "expenses.json"))
