// Runs under JavaScriptCore (jsc -m). Exercises model + layout on synthetic data.
if (typeof console === "undefined") globalThis.console = { log: (...a) => print(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
import { loadCity, makeHeightScale, makeColorScale, applyFilters, summarize, walkNodes } from '../src/model.js';
import { layoutCity } from '../src/layout.js';

function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const r = rnd(42);
const comps = ['core', 'ui', 'api', 'infra', 'docs'];
const subs = ['auth', 'billing', 'search', 'render', 'storage', 'net', 'cli'];
const items = [];
for (let i = 0; i < 3000; i++) {
  const depth = 1 + Math.floor(r() * 3);
  const path = [comps[Math.floor(r() * r() * comps.length)]];
  for (let d = 1; d < depth; d++) path.push(subs[Math.floor(r() * subs.length)]);
  items.push({ id: 'BUG-' + i, name: 'Bug ' + i, path, age_days: Math.floor(Math.pow(r(), 2) * 900), severity: ['low', 'medium', 'high', 'critical'][Math.floor(r() * 4)], status: r() < 0.7 ? 'open' : 'closed', opened: '2024-0' + (1 + Math.floor(r() * 9)) + '-1' + Math.floor(r() * 9) });
}
const city = loadCity({ name: 'test', items });
const fields = city.fields;
console.log('fields:', Object.values(fields).map(f => `${f.key}:${f.type}${f.scale ? '/' + f.scale : ''}`).join(' '));
console.log('defaults:', JSON.stringify(city.defaults));
if (fields.age_days.type !== 'number' || fields.severity.type !== 'category' || fields.opened.type !== 'date') throw new Error('type inference wrong');

let nodes = 0; for (const n of walkNodes(city.tree)) nodes++;
console.log('tree nodes:', nodes, 'root count:', city.tree.count);

const t0 = Date.now();
const L = layoutCity(city.tree);
console.log('layout ms:', Date.now() - t0, 'side:', L.side.toFixed(1), 'buildings:', L.buildings.length, 'districts:', L.districts.length, 'maxDepth:', L.maxDepth, 'undersized cells:', L.undersized);
if (L.buildings.length !== items.length) throw new Error('lost buildings');
const fp = L.buildings.map(b => b.w).sort((a, b) => a - b);
const q = p => fp[Math.floor(p * (fp.length - 1))].toFixed(2);
console.log('footprint p0/p10/p50/p90/p100:', q(0), q(.1), q(.5), q(.9), q(1));
// containment + overlap checks
const inside = (b, r) => b.x - b.w / 2 >= r.x - 1e-6 && b.x + b.w / 2 <= r.x + r.w + 1e-6 && b.z - b.d / 2 >= r.z - 1e-6 && b.z + b.d / 2 <= r.z + r.d + 1e-6;
for (const b of L.buildings) if (!inside(b, b.item._node._district.rect)) throw new Error(`building outside its district: ${b.item.id} at ${b.x},${b.z}`);
for (const d of L.districts) if (d.node.parent && !rectInside(d.rect, d.node.parent._district.rect)) throw new Error('district outside parent');
function rectInside(a, b) { return a.x >= b.x - 1e-6 && a.z >= b.z - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.z + a.d <= b.z + b.d + 1e-6; }
// brute-force overlap on a sample grid
let overlaps = 0;
const bs = L.buildings;
for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
  const a = bs[i], b = bs[j];
  if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-6) overlaps++;
}
console.log('overlapping building pairs:', overlaps);
if (overlaps) throw new Error('overlaps');

const h = makeHeightScale(fields.age_days, 'log');
const hs = items.map(h); console.log('height range:', Math.min(...hs).toFixed(2), Math.max(...hs).toFixed(2));
const cs = makeColorScale(fields.severity); console.log('legend:', JSON.stringify(cs.legend.entries.map(e => [e.value, e.color, e.count])));
const seq = makeColorScale(fields.age_days); console.log('seq color of item0:', seq.colorOf(items[0]), seq.legend.type);
const { count } = applyFilters(city.items, [{ type: 'set', field: 'status', values: new Set(['open']) }, { type: 'range', field: 'age_days', min: 100, max: null }, { type: 'path', prefix: ['core'] }, { type: 'search', text: 'bug 1' }], fields);
console.log('filtered count:', count);
console.log('summary:', JSON.stringify(summarize(city.items, fields.age_days)));
console.log('ALL OK');
