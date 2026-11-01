#!/usr/bin/env python3
"""Species observations from GBIF (gbif.org) as a city: one building per record.

    python3 adapters/gbif.py --country DK --year 2025 --limit 10000 -o data/observations-dk.json

Hierarchy is the taxonomy (class / order / family by default); buildings are
observations named by species. Height = how often that species appears in the
set (log), color = IUCN Red List category, spire = day of the year observed.
Defaults to iNaturalist research-grade records; pass --dataset '' for all of GBIF.
GBIF data is CC0 / CC BY; the document records the query for attribution.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import stadtus  # noqa: E402

API = "https://api.gbif.org/v1/occurrence/search"
INAT = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"  # iNaturalist research-grade observations
IUCN = ["LC", "NT", "VU", "EN", "CR"]


def fetch(params, limit):
    out, offset, page = [], 0, 300
    while len(out) < limit:
        q = dict(params, limit=min(page, limit - len(out)), offset=offset)
        url = API + "?" + urllib.parse.urlencode({k: v for k, v in q.items() if v not in (None, "")})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = json.load(r)
                break
            except Exception as e:  # rate limit or hiccup: back off
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
        results = data.get("results", [])
        out.extend(results)
        print(f"  {len(out):6d} / {min(limit, data.get('count', limit))}", file=sys.stderr, end="\r")
        offset += len(results)
        if data.get("endOfRecords") or not results:
            break
    print(file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", default="DK", help="ISO country code")
    ap.add_argument("--year", default="2025")
    ap.add_argument("--taxon", default=None, help="GBIF taxonKey to restrict to (e.g. 212 = birds)")
    ap.add_argument("--dataset", default=INAT, help="GBIF datasetKey ('' for any)")
    ap.add_argument("--path", default="class,order,family", help="taxonomic ranks that form the hierarchy")
    ap.add_argument("--limit", type=int, default=10000)
    ap.add_argument("-o", "--out", default="data/observations.json")
    a = ap.parse_args()

    ranks = a.path.split(",")
    params = {"country": a.country, "year": a.year, "taxonKey": a.taxon, "datasetKey": a.dataset,
              "hasCoordinate": "true", "occurrenceStatus": "PRESENT"}
    # GBIF returns records in date order, so a single page run would cover only
    # the first weeks of the year. Spread the budget evenly over the months.
    print(f"fetching up to {a.limit} records from GBIF…", file=sys.stderr)
    records = []
    for month in range(1, 13):
        records += fetch(dict(params, month=month), a.limit // 12)

    items = []
    for r in records:
        species = r.get("species")
        if not species or not all(r.get(k) for k in ranks):
            continue
        date = (r.get("eventDate") or "")[:10]
        try:
            doy = dt.date.fromisoformat(date).timetuple().tm_yday
        except ValueError:
            doy = None
        iucn = r.get("iucnRedListCategory")
        items.append({
            "id": str(r.get("gbifID", r.get("key"))),
            "name": species,
            "path": [r[k] for k in ranks],
            "species": species,
            "kingdom": r.get("kingdom"),
            "genus": r.get("genus"),
            "date": date or None,
            "day_of_year": doy,
            "month": r.get("month"),
            "iucn": iucn if iucn in IUCN else None,
            "individuals": r.get("individualCount"),
            "latitude": r.get("decimalLatitude"),
            "longitude": r.get("decimalLongitude"),
            "coordinate_uncertainty_m": r.get("coordinateUncertaintyInMeters"),
        })
    # how common each species is within this set
    freq = {}
    for it in items:
        freq[it["species"]] = freq.get(it["species"], 0) + 1
    for it in items:
        it["species_observations"] = freq[it["species"]]

    place = a.country
    doc = stadtus.city(
        f"Species observations, {place} {a.year}", items,
        fields={
            "species_observations": {"label": "observations of this species", "scale": "log"},
            "iucn": {"type": "category", "label": "IUCN Red List", "order": IUCN},
            "day_of_year": {"label": "day of year"},
            "coordinate_uncertainty_m": {"label": "coordinate uncertainty", "unit": "m", "scale": "log"},
            "kingdom": {"type": "category"},
            "genus": {"type": "string"},
            "species": {"type": "string"},
        },
        defaults={"height": "species_observations", "color": "kingdom", "spire": "day_of_year", "label": "species", "time": "date"},
    )
    doc["source"] = {"name": "GBIF.org occurrence download via API", "url": API + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v}), "license": "CC0 / CC BY (per dataset)", "fetched": dt.date.today().isoformat()}
    stadtus.write(doc, a.out)
    print(f"{len(freq)} species, {len({tuple(i['path'][:1]) for i in items})} classes", file=sys.stderr)


if __name__ == "__main__":
    main()
