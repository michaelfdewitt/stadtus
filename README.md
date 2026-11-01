# Stadtus

A 3D city view of any hierarchical dataset, in the spirit of the file-system
city in *Jurassic Park*. Every object is a building. The hierarchy decides
where it stands; three metadata fields decide how tall it is, its color, and
the length of the spire on its roof (a second continuous measure). Filters and selection let you work the data, not just look at it.

Runs entirely in the browser. Data is read from a local file and never leaves
your machine. No build step, no backend, no dependencies beyond Three.js from a CDN.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000/?data=data/bugs.json
```

Or open `dist/stadtus.html` directly from disk (regenerate it with `python3 build.py`).
Any static host (GitHub Pages, S3, a shared folder) serves it as is.

Load data with **Open JSON…**, by dropping a `.json` file on the page, with
`?data=<url>`, or from the sample dropdown.

## Data format

```json
{
  "name": "Bug tracker",
  "items": [
    { "name": "BUG-1042", "path": ["backend", "auth"], "severity": "high", "age_days": 31, "status": "open" }
  ],
  "fields":   { "severity": { "type": "category", "order": ["low", "medium", "high", "critical"] },
                "age_days": { "label": "age (days)", "scale": "sqrt" } },
  "defaults": { "height": "age_days", "color": "severity", "spire": "comments", "label": "name" }
}
```

Only `items` is required. An optional `source` (`name`, `url`, `license`,
`fetched`) is shown for attribution. Each item has a `path` (array, or `"a/b/c"` string)
and any flat metadata. Field types (`number`, `category`, `string`, `date`) are
inferred; declare a field only to override the type, label, unit, scale
(`linear`, `sqrt`, `log`) or category order. A plain JSON array of objects also
loads: you are asked which keys form the hierarchy.

## Actions and diffs

A document can declare edits users may apply to selected buildings. The city
updates immediately; the top bar counts the changes, and **export** writes them
as a diff you can feed back into the system of record.

```json
"actions": [
  { "id": "fix",    "label": "Mark fixed", "set": { "status": "fixed" }, "when": { "status": ["open", "in progress"] } },
  { "id": "assign", "label": "Reassign",   "field": "assignee" }
]
```

`set` applies a fixed patch; `field` offers a choice (`choices` defaults to the
field's values). `when` limits an action to items in a given state; an item may
also list `"actions": ["fix", "assign"]` to restrict itself. The exported diff is
`{ "changes": [ { "id", "path", "field", "from", "to" } ] }`.

## Adapters

Small Python scripts that produce city JSON. Add your own with
`adapters/stadtus.py` (`city(...)`, `write(...)`).

```sh
python3 adapters/filesystem.py ~/src/myproject -o data/myproject.json   # one building per file
python3 adapters/gbif.py --country DK --year 2025 --limit 10000         # species observations from GBIF, by taxonomy
python3 adapters/samples.py                                            # synthetic bugs + expenses
```

## How it works

| File | Role |
|---|---|
| `src/model.js` | Normalizes items, infers fields, builds the tree, height/color scales, filter predicates |
| `src/layout.js` | Hierarchical quadtree-style layout. Bottom-up sizing, then recursive guillotine cuts weighted by area, never thinner than the largest child, so leaf footprints stay uniform. Roads between districts get narrower with depth |
| `src/renderer.js` | Three.js scene: buildings, caps, spires and district plates are instanced meshes; district names painted on the roads; picking by instance id; WASD flight and camera fly-to |
| `src/ui.js` | Sidebar (selection, legend-as-filter, histogram range filters, encoding, data), tooltip, breadcrumb with filter chips, import wizard |
| `src/main.js` | App state and wiring |
| `build.py` | Concatenates the above into `dist/stadtus.html` |

Layout depends only on the hierarchy, so the city stays put while you change
encodings or filters. Filtered-out buildings become gray stubs. Ordered
categories (declared `order`, or recognizable sets like low/medium/high/critical)
get an ordered color ramp; everything else gets fixed categorical hues. Navigate with WASD (QE for
height, Shift for speed), drag to orbit, wheel to zoom toward the cursor.

## Tests

No Node needed; the pure modules run under macOS's JavaScriptCore:

```sh
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
$JSC -m test/run.js        # synthetic 3000-item city: inference, layout invariants, filters
$JSC -m test/samples.js    # the datasets in data/
$JSC -m test/changes.js    # actions and diff tracking
python3 test/drive.py      # drives headless Chrome over DevTools: keys, drag, wheel, hover, click, Esc
```
