if (typeof console === "undefined") globalThis.console = { log: (...a) => print(a.join(" ")) };
import { loadCity, makeColorScale } from '../src/model.js';
import { layoutCity } from '../src/layout.js';
for (const f of ['data/bugs.json', 'data/expenses.json', 'data/python-stdlib.json']) {
  const doc = JSON.parse(readFile(f));
  const t0 = Date.now();
  const city = loadCity(doc);
  const L = layoutCity(city.tree);
  const fp = L.buildings.map(b => b.w).sort((a, b) => a - b);
  const q = p => fp[Math.floor(p * (fp.length - 1))].toFixed(2);
  console.log(`${f}: ${city.items.length} items, ${L.districts.length} districts, depth ${L.maxDepth}, side ${L.side.toFixed(0)}, undersized ${L.undersized}, footprint p0/p50 ${q(0)}/${q(.5)}, ${Date.now() - t0}ms`);
  console.log('  fields: ' + Object.values(city.fields).map(f => `${f.key}:${f.type}${f.scale ? '/' + f.scale : ''}${f.categories ? '(' + f.categories.length + ')' : ''}`).join(' '));
  console.log('  defaults: ' + JSON.stringify(city.defaults));
  const cs = makeColorScale(city.fields[city.defaults.color]);
  if (cs.legend.entries) console.log('  color legend: ' + cs.legend.entries.map(e => e.value).join(', '));
  for (const b of L.buildings) { const r = b.item._node._district.rect; if (b.x - b.w / 2 < r.x - 1e-6 || b.x + b.w / 2 > r.x + r.w + 1e-6 || b.z - b.d / 2 < r.z - 1e-6 || b.z + b.d / 2 > r.z + r.d + 1e-6) throw new Error('building outside district in ' + f); }
}
console.log('SAMPLES OK');
