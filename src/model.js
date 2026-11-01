// Data model: normalizes a city document, infers field types, builds the
// hierarchy tree, and provides scales (height/color) and filter predicates.
//
// City document format:
// {
//   "name": "Dataset name",
//   "fields":   { "<key>": { "type": "number|category|string|date", "label": "...", "scale": "linear|log|sqrt" } },  // optional
//   "defaults": { "height": "<key>", "color": "<key>", "spire": "<key>", "label": "<key>" },                             // optional
//   "items": [ { "id": "...", "name": "...", "path": ["a","b"] | "a/b", ...metadata } ],
//   "source":   { "name", "url", "license", "fetched" }                                                                     // optional attribution
// }

import { CATEGORICAL, OTHER, NEUTRAL, MISSING, SEQUENTIAL, SEQUENTIAL_2, STATUS, rampColor } from './palette.js';

// Category sets that carry an order even when the data doesn't declare one.
const KNOWN_ORDERS = [
  ['low', 'medium', 'high', 'critical'],
  ['trivial', 'minor', 'major', 'critical', 'blocker'],
  ['p4', 'p3', 'p2', 'p1', 'p0'],
];
const SEVERITY_STATUS = { low: STATUS.good, medium: STATUS.warning, high: STATUS.serious, critical: STATUS.critical };

export const RESERVED = new Set(['id', 'name', 'path']);
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/;

export function loadCity(doc) {
  if (!doc || !Array.isArray(doc.items)) throw new Error('City document needs an "items" array');
  const items = doc.items.map((raw, i) => {
    const it = { ...raw };
    it._i = i;
    if (typeof it.path === 'string') it.path = it.path.split('/').filter(Boolean);
    if (!Array.isArray(it.path)) it.path = [];
    it.path = it.path.map(String);
    if (it.name == null) it.name = it.id != null ? String(it.id) : `item ${i}`;
    if (it.id == null) it.id = [...it.path, it.name].join('/') + '#' + i;
    return it;
  });
  const fields = inferFields(items, doc.fields || {});
  const tree = buildTree(items);
  const defaults = pickDefaults(fields, doc.defaults || {});
  const actions = normalizeActions(doc.actions || [], fields);
  return { name: doc.name || 'Untitled city', items, fields, tree, defaults, actions, source: doc.source || null };
}

// ---------- fields ----------

export function inferFields(items, declared) {
  const keys = new Set();
  for (const it of items) for (const k of Object.keys(it)) if (!RESERVED.has(k) && k[0] !== '_') keys.add(k);
  for (const k of Object.keys(declared)) keys.add(k);
  const fields = {};
  for (const k of keys) {
    const decl = declared[k] || {};
    const vals = [];
    for (const it of items) { const v = it[k]; if (v != null && v !== '') vals.push(v); }
    if (!vals.length) continue; // a field with no values carries nothing
    let type = decl.type || detectType(vals, items.length);
    const f = { key: k, label: decl.label || k, type, description: decl.description };
    if (type === 'number' || type === 'date') {
      let min = Infinity, max = -Infinity, n = 0;
      for (const v of vals) { const x = toNumber(v, type); if (Number.isFinite(x)) { n++; if (x < min) min = x; if (x > max) max = x; } }
      f.min = n ? min : 0; f.max = n ? max : 0;
      f.scale = decl.scale || autoScale(f.min, f.max, type);
      f.unit = decl.unit;
    } else {
      const counts = new Map();
      for (const v of vals) { const s = String(v); counts.set(s, (counts.get(s) || 0) + 1); }
      f.categories = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
      if (type === 'string' && f.categories.length <= 60 && f.categories.length < items.length * 0.5) f.type = type = 'category';
      const order = decl.order || (type === 'category' && KNOWN_ORDERS.find(o => f.categories.length >= 2 && f.categories.every(c => o.includes(c.value.toLowerCase()))));
      if (order) { // ordinal: sort by declared/known order
        const rank = new Map(order.map((v, i) => [String(v).toLowerCase(), i]));
        f.categories.sort((a, b) => (rank.get(a.value.toLowerCase()) ?? 1e9) - (rank.get(b.value.toLowerCase()) ?? 1e9));
        f.ordinal = true;
      }
    }
    f.missing = items.length - vals.length;
    fields[k] = f;
  }
  return fields;
}

function detectType(vals, n) {
  if (!vals.length) return 'string';
  let nums = 0, dates = 0, bools = 0;
  for (const v of vals) {
    if (typeof v === 'number') nums++;
    else if (typeof v === 'boolean') bools++;
    else if (typeof v === 'string') {
      if (v.trim() !== '' && !isNaN(Number(v))) nums++;
      else if (DATE_RE.test(v) && !isNaN(Date.parse(v))) dates++;
    }
  }
  if (nums === vals.length) return 'number';
  if (dates === vals.length) return 'date';
  if (bools === vals.length) return 'category';
  const distinct = new Set(vals.map(String)).size;
  return distinct <= Math.max(30, n * 0.05) ? 'category' : 'string';
}

export function toNumber(v, type) {
  if (v == null || v === '') return NaN;
  if (type === 'date') return typeof v === 'number' ? v : Date.parse(v);
  return typeof v === 'number' ? v : Number(v);
}

function autoScale(min, max, type) {
  if (type === 'date') return 'linear';
  if (min >= 0 && max > 0 && max / Math.max(min, 1) > 1000) return 'log';
  return 'linear';
}

// value of a field for an item, typed (number/ms for numeric, string otherwise)
export function fieldValue(item, field) {
  if (!field) return undefined;
  const v = item[field.key];
  if (v == null || v === '') return undefined;
  if (field.type === 'number' || field.type === 'date') { const x = toNumber(v, field.type); return Number.isFinite(x) ? x : undefined; }
  return String(v);
}

export function formatValue(v, field) {
  if (v === undefined || v === null) return '—';
  if (!field) return String(v);
  if (field.type === 'date') { const d = new Date(typeof v === 'number' ? v : Date.parse(v)); return isNaN(d) ? String(v) : d.toISOString().slice(0, 10); }
  if (field.type === 'number') {
    const x = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(x)) return String(v);
    const s = Math.abs(x) >= 1e5 ? x.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })
      : Number.isInteger(x) ? x.toLocaleString() : x.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (!field.unit) return s;
    return /^[$€£¥]$/.test(field.unit) ? `${field.unit}${s}` : `${s} ${field.unit}`;
  }
  return String(v);
}

function pickDefaults(fields, given) {
  const list = Object.values(fields);
  const numeric = list.filter(f => f.type === 'number');
  const cats = list.filter(f => f.type === 'category');
  const ok = k => k && fields[k] ? k : null;
  const height = ok(given.height) || numeric[0]?.key || null;
  const color = ok(given.color) || cats[0]?.key || numeric.find(f => f.key !== height)?.key || null;
  const varying = numeric.filter(f => f.min < f.max);
  const spire = ok(given.spire) || varying.find(f => f.key !== height && f.key !== color)?.key || null;
  const label = ok(given.label) || 'name';
  return { height, color, spire, label, heightScale: given.heightScale || (height ? fields[height].scale : 'linear') };
}

// ---------- tree ----------

export function buildTree(items) {
  const root = { name: '', path: [], children: new Map(), items: [], count: 0, depth: 0, parent: null };
  for (const it of items) {
    let node = root;
    node.count++;
    for (const seg of it.path) {
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: [...node.path, seg], children: new Map(), items: [], count: 0, depth: node.depth + 1, parent: node };
        node.children.set(seg, child);
      }
      node = child;
      node.count++;
    }
    node.items.push(it);
    it._node = node;
  }
  return root;
}

export function findNode(root, path) {
  let node = root;
  for (const seg of path) { node = node.children.get(seg); if (!node) return null; }
  return node;
}

export function* walkNodes(node) {
  yield node;
  for (const c of node.children.values()) yield* walkNodes(c);
}

// ---------- scales ----------

// Returns item -> [0,1] normalized height (NaN when missing).
export function makeHeightScale(field, scale = 'linear') {
  if (!field || (field.type !== 'number' && field.type !== 'date')) return () => 0.5;
  const { min, max } = field;
  const span = max - min || 1;
  const tf = scale === 'log' ? (x => Math.log1p(Math.max(0, x - min)) / Math.log1p(span))
    : scale === 'sqrt' ? (x => Math.sqrt((x - min) / span))
      : (x => (x - min) / span);
  return item => { const v = fieldValue(item, field); return v === undefined ? NaN : tf(v); };
}

// Returns { colorOf(item) -> hex, legend }
// legend: { type:'categorical', entries:[{value,color,count}] } | { type:'sequential', min, max, ramp } | { type:'none' }
export function makeColorScale(field, { ramp = SEQUENTIAL, maxSlots = CATEGORICAL.length - 1 } = {}) {
  if (!field) return { colorOf: () => NEUTRAL, legend: { type: 'none' } };
  if (field.type === 'number' || field.type === 'date') {
    const { min, max } = field; const span = max - min || 1;
    const tf = field.scale === 'log' ? (x => Math.log1p(Math.max(0, x - min)) / Math.log1p(span)) : (x => (x - min) / span);
    return {
      colorOf: item => { const v = fieldValue(item, field); return v === undefined ? MISSING : rampColor(ramp, tf(v)); },
      legend: { type: 'sequential', field, min, max, ramp, scale: field.scale },
    };
  }
  const cats = field.categories || [];
  const map = new Map();
  const entries = [];
  if (field.ordinal) {
    // ordered categories: one hue light -> dark, or the status palette for severity-like values
    const severity = cats.every(c => SEVERITY_STATUS[c.value.toLowerCase()]);
    cats.forEach((c, i) => {
      const color = severity ? SEVERITY_STATUS[c.value.toLowerCase()] : rampColor(ramp.slice(3), cats.length > 1 ? i / (cats.length - 1) : 1);
      map.set(c.value, color);
      entries.push({ value: c.value, color, count: c.count });
    });
    if (field.missing > 0) entries.push({ value: '(missing)', color: MISSING, count: field.missing, missing: true });
    return {
      colorOf: item => { const v = fieldValue(item, field); return v === undefined ? MISSING : (map.get(v) || OTHER); },
      legend: { type: 'categorical', field, entries, ordinal: true },
    };
  }
  // categorical: fixed slot order by frequency rank; overflow folds into "Other"
  cats.forEach((c, i) => {
    const color = i < maxSlots ? CATEGORICAL[i] : OTHER;
    map.set(c.value, color);
    if (i < maxSlots) entries.push({ value: c.value, color, count: c.count });
  });
  if (cats.length > maxSlots) {
    const rest = cats.slice(maxSlots);
    entries.push({ value: 'Other', color: OTHER, count: rest.reduce((s, c) => s + c.count, 0), members: rest.map(c => c.value) });
  }
  if (field.missing > 0) entries.push({ value: '(missing)', color: MISSING, count: field.missing, missing: true });
  return {
    colorOf: item => { const v = fieldValue(item, field); return v === undefined ? MISSING : (map.get(v) || OTHER); },
    legend: { type: 'categorical', field, entries },
  };
}

export { SEQUENTIAL, SEQUENTIAL_2 };

// ---------- filters ----------
// filter shapes:
//   { type:'range',  field, min, max }           numeric/date, inclusive; null bound = open
//   { type:'set',    field, values:Set, excludeMissing? }  category/string; keep items whose value is in set
//   { type:'search', text }                        substring over name/path/string fields
//   { type:'path',   prefix:[...] }                keep items under hierarchy prefix
//   { type:'custom', test(item) }

export function compileFilters(filters, fields) {
  const tests = [];
  for (const f of filters) {
    if (!f || f.enabled === false) continue;
    if (f.type === 'range') {
      const field = fields[f.field]; if (!field) continue;
      const lo = f.min ?? -Infinity, hi = f.max ?? Infinity;
      if (lo <= field.min && hi >= field.max && !f.excludeMissing) continue;
      tests.push(it => { const v = fieldValue(it, field); return v === undefined ? !f.excludeMissing : v >= lo && v <= hi; });
    } else if (f.type === 'set') {
      const field = fields[f.field]; if (!field || !f.values) continue;
      const set = f.values;
      tests.push(it => { const v = fieldValue(it, field); return v === undefined ? !f.excludeMissing : set.has(v); });
    } else if (f.type === 'search') {
      const q = (f.text || '').trim().toLowerCase(); if (!q) continue;
      const textFields = Object.values(fields).filter(x => x.type === 'string' || x.type === 'category');
      tests.push(it => {
        if (it.name.toLowerCase().includes(q)) return true;
        if (it.path.join('/').toLowerCase().includes(q)) return true;
        for (const tf of textFields) { const v = it[tf.key]; if (v != null && String(v).toLowerCase().includes(q)) return true; }
        return false;
      });
    } else if (f.type === 'path') {
      const p = f.prefix || []; if (!p.length) continue;
      tests.push(it => { if (it.path.length < p.length) return false; for (let i = 0; i < p.length; i++) if (it.path[i] !== p[i]) return false; return true; });
    } else if (f.type === 'custom' && typeof f.test === 'function') {
      tests.push(f.test);
    }
  }
  return item => { for (const t of tests) if (!t(item)) return false; return true; };
}

export function applyFilters(items, filters, fields) {
  const test = compileFilters(filters, fields);
  const mask = new Uint8Array(items.length);
  let n = 0;
  for (let i = 0; i < items.length; i++) if (test(items[i])) { mask[i] = 1; n++; }
  return { mask, count: n };
}

// Counts of a numeric/date field in `bins` equal-width bins over [min, max].
export function histogram(items, field, bins = 24) {
  const counts = new Array(bins).fill(0);
  const span = field.max - field.min || 1;
  for (const it of items) {
    const v = fieldValue(it, field);
    if (v === undefined) continue;
    counts[Math.min(bins - 1, Math.floor(((v - field.min) / span) * bins))]++;
  }
  return counts;
}

// ---------- actions and changes ----------
// Document-level actions users can apply to selected items:
//   { "id", "label", "set": { field: value, ... } }          fixed patch
//   { "id", "label", "field": "<key>", "choices": [...] }    pick a value (choices default to the field's values)
// Optional "when": { field: value | [values] } limits an action to items in that state.
// An item may also list "actions": [ids] to restrict itself.

export function normalizeActions(list, fields) {
  return list.filter(a => a && a.id && (a.set || a.field)).map(a => ({
    id: String(a.id), label: a.label || a.id, set: a.set, field: a.field, when: a.when,
    choices: a.field ? (a.choices || fields[a.field]?.categories?.map(c => c.value) || []) : null,
  }));
}

export function actionApplies(action, item) {
  if (Array.isArray(item.actions) && !item.actions.includes(action.id)) return false;
  if (action.when) for (const [k, v] of Object.entries(action.when)) {
    const cur = item[k] == null ? null : String(item[k]);
    if (!(Array.isArray(v) ? v.map(String) : [String(v)]).includes(cur)) return false;
  }
  return true;
}

// changes: Map<itemIndex, Map<field, {from, to}>>. Returns true if the item changed.
export function applyChange(changes, item, field, to) {
  const from = item[field] === undefined ? null : item[field];
  if (from === to) return false;
  let m = changes.get(item._i);
  if (!m) changes.set(item._i, m = new Map());
  const rec = m.get(field);
  if (rec) { if (rec.from === to) m.delete(field); else rec.to = to; } else m.set(field, { from, to });
  if (to === null) delete item[field]; else item[field] = to;
  if (!m.size) changes.delete(item._i);
  return true;
}

export function revertChanges(changes, items, index = null) {
  const keys = index === null ? [...changes.keys()] : [index];
  for (const i of keys) {
    const m = changes.get(i); if (!m) continue;
    for (const [field, rec] of m) { if (rec.from === null) delete items[i][field]; else items[i][field] = rec.from; }
    changes.delete(i);
  }
}

export function changeList(changes, items) {
  const out = [];
  for (const [i, m] of changes) for (const [field, rec] of m) out.push({ id: items[i].id, path: items[i].path, field, from: rec.from, to: rec.to });
  return out;
}

// Refresh category counts after edits without reordering (colors follow the
// entity, never its rank). New values are appended.
export function recount(field, items) {
  if (!field.categories) return;
  const counts = new Map(field.categories.map(c => [c.value, 0]));
  let missing = 0;
  for (const it of items) { const v = it[field.key]; if (v == null || v === '') missing++; else { const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); } }
  field.categories = [...counts.entries()].map(([value, count]) => ({ value, count }));
  field.missing = missing;
}

// Summary statistics over a set of items for a numeric field
export function summarize(items, field) {
  if (!field || (field.type !== 'number' && field.type !== 'date')) return null;
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (const it of items) { const v = fieldValue(it, field); if (v === undefined) continue; n++; sum += v; if (v < min) min = v; if (v > max) max = v; }
  return n ? { n, sum, mean: sum / n, min, max } : { n: 0 };
}
