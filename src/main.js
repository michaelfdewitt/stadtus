// App shell: owns state (city, mapping, filters, selection, focus), wires the
// renderer and UI together, and handles loading JSON.
import { loadCity, makeHeightScale, makeColorScale, applyFilters, findNode, fieldValue, toNumber, actionApplies, applyChange, revertChanges, changeList, recount } from './model.js';
import { layoutCity } from './layout.js';
import { CityRenderer } from './renderer.js';
import { buildUI, columnWizard, downloadText, downloadDataUrl } from './ui.js';

export class CityApp {
  constructor(els) {
    this.els = els;
    this.listeners = new Map();
    this.city = null; this.layout = null; this.mapping = null;
    this.filters = new Map();
    this.selection = new Set();
    this.visible = new Uint8Array(0); this.visibleCount = 0;
    this.focusPath = [];
    this.brush = null;      // { field, values:Set, missing:bool } while hovering a legend row
    this.changes = new Map(); // edits made through actions: itemIndex -> field -> {from, to}
    this.time = { cutoff: null }; // time scrubber: items whose mapping.time value is after cutoff do not exist yet
    this.dataUrl = null;          // where the current document came from, if a URL
    this.pendingView = parseView(location.hash); // a shared view to apply once data loads
    this.samples = [];

    this.renderer = new CityRenderer(els.viewport, {
      onHover: (hit, event) => this.emit('hover', { hit, event }),
      onClick: (hit, event) => this.onClick(hit, event),
      onDoubleClick: hit => this.onDoubleClick(hit),
      onLook: d => { this.look = d ? d.node.path : []; this.emit('where'); },
      onCameraRest: () => this.writeHash(),
    });
    this.look = []; // path of the district under the camera's look-at point
    buildUI(this, els);

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.loadFile(f); });
    window.addEventListener('keydown', e => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'Escape') this.clearAll();
      else if (e.key === 'r') this.resetView();
      else if (e.key === 'f') this.flyToSelection();
      else if (e.key === 'p' && this.city) this.snapshot();
      else if (e.key === 'j') this.step(1);
      else if (e.key === 'k') this.step(-1);
      else if (e.key === ' ' && this.city && this.mapping.time) { e.preventDefault(); this.emit('time-toggle'); }
      else if (/^[1-9]$/.test(e.key) && this.selection.size) { const a = this.availableActions().filter(a => a.set)[+e.key - 1]; if (a) this.applyAction(a); }
    });
  }

  on(evt, fn) { (this.listeners.get(evt) || this.listeners.set(evt, []).get(evt)).push(fn); }
  emit(evt, payload) { for (const fn of this.listeners.get(evt) || []) fn(payload); }
  status(msg) { this.emit('status', msg); }

  // ---------- loading ----------

  async loadSamplesIndex(url = 'data/index.json') {
    try { const r = await fetch(url); if (r.ok) { this.samples = await r.json(); this.emit('samples'); } } catch { /* no samples available */ }
  }

  async loadUrl(url) {
    this.status(`Loading ${url}…`);
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      this.dataUrl = url;
      await this.loadDocument(await r.json(), url.split('/').pop());
    } catch (e) { console.error(e); this.status(`Could not load ${url}: ${e.message}`); }
  }

  async loadFile(file) {
    this.status(`Reading ${file.name}…`);
    this.dataUrl = null;
    try { await this.loadDocument(JSON.parse(await file.text()), file.name.replace(/\.json$/i, '')); }
    catch (e) { console.error(e); this.status(`Could not read ${file.name}: ${e.message}`); }
  }

  async loadDocument(doc, source = 'data') {
    if (Array.isArray(doc)) doc = { name: source, items: doc };
    if (!doc || !Array.isArray(doc.items) || !doc.items.length) { this.status('Expected a JSON object with a non-empty "items" array, or a JSON array of objects.'); return; }
    if (!doc.items.some(it => it && it.path != null)) {
      const columns = [...new Set(doc.items.flatMap(it => Object.keys(it || {})))];
      const choice = await columnWizard(columns, doc.items[0], document.body);
      if (!choice) { this.status('Import cancelled.'); return; }
      doc = { ...doc, items: doc.items.map((it, i) => {
        const path = [];
        for (const k of choice.pathKeys) { const v = it[k]; if (v == null || v === '') continue; for (const seg of (choice.split ? String(v).split(choice.split) : [String(v)])) if (seg) path.push(seg); }
        const out = { ...it, path, name: choice.nameKey ? String(it[choice.nameKey] ?? i) : String(i + 1) };
        for (const k of choice.pathKeys) delete out[k];
        return out;
      }) };
    }
    this.city = loadCity({ name: source, ...doc });
    this.layout = layoutCity(this.city.tree);
    this.mapping = { ...this.city.defaults };
    this.filters.clear(); this.selection.clear(); this.focusPath = []; this.brush = null; this.changes.clear();
    this.time = { cutoff: null };
    this.renderer.setLayout(this.layout);
    document.title = `${this.city.name} · Stadtus`;
    this.status('');
    const view = this.pendingView; this.pendingView = null;
    if (view && (!view.name || view.name === this.city.name)) this.applyView(view);
    this.refresh();
    this.emit('data');
    if (view?.camera) this.renderer.setCamera(view.camera.p, view.camera.t);
    this.writeHash();
  }

  // ---------- state changes ----------

  refresh() {
    if (!this.city) return;
    const { items, fields } = this.city;
    const m = this.mapping;
    const active = [...this.filters.values()];
    if (this.focusPath.length) active.push({ type: 'path', prefix: this.focusPath });
    const { mask, count } = applyFilters(items, active, fields);
    this.visible = mask; this.visibleCount = count;
    const tf = fields[m.time];
    if (tf && this.time.cutoff != null && this.time.cutoff < tf.max) {
      for (let i = 0; i < items.length; i++) {
        const v = fieldValue(items[i], tf);
        if (v !== undefined && v > this.time.cutoff) { if (mask[i]) this.visibleCount--; mask[i] = 2; }
      }
    }

    this.heightScale = makeHeightScale(fields[m.height], m.heightScale);
    this.colorScale = makeColorScale(fields[m.color]);
    this.spireScale = makeHeightScale(fields[m.spire], fields[m.spire]?.scale);

    const B = this.layout.buildings, n = B.length;
    const heights = new Float32Array(n), colors = new Array(n), spires = new Float32Array(n), visible = new Uint8Array(n);
    const bf = this.brush && fields[this.brush.field];
    const emphasis = bf ? new Uint8Array(n) : null;
    for (let i = 0; i < n; i++) {
      const it = B[i].item;
      heights[i] = this.heightScale(it);
      colors[i] = this.colorScale.colorOf(it);
      spires[i] = fields[m.spire] ? this.spireScale(it) : NaN;
      visible[i] = mask[it._i];
      if (bf) { const v = fieldValue(it, bf); emphasis[i] = v === undefined ? this.brush.missing : this.brush.values.has(v); }
    }
    this.renderer.update({ heights, colors, spires, visible, emphasis });
    this.syncSelection();
    if (!this.brush) { this.emit('update'); this.writeHash(); }
  }

  setMapping(patch) {
    Object.assign(this.mapping, patch);
    if ('time' in patch) { this.time = { cutoff: null }; this.emit('time'); }
    this.refresh();
  }
  // Time scrubber: cutoff in the time field's units (ms for dates); null = everything.
  setTimeCutoff(cutoff) { this.time = { cutoff }; this.refresh(); this.emit('time'); }
  setFilter(key, filter) { if (filter) this.filters.set(key, filter); else this.filters.delete(key); this.refresh(); }
  removeFilter(key) { this.setFilter(key, null); }
  clearFilters() { this.filters.clear(); this.refresh(); this.emit('filters'); }
  // Esc: back to the whole city, nothing filtered or selected.
  clearAll() {
    if (!this.city) return;
    this.selection.clear(); this.filters.clear(); this.focusPath = []; this.brush = null;
    this.refresh(); this.emit('filters'); this.emit('selection');
  }
  setBrush(brush) { this.brush = brush; this.refresh(); }

  select(indices, { additive = false } = {}) {
    if (!additive) this.selection.clear();
    if (additive && indices.length === 1 && this.selection.has(indices[0])) this.selection.delete(indices[0]);
    else for (const i of indices) this.selection.add(i);
    this.syncSelection(); this.emit('selection');
  }
  clearSelection() { if (!this.selection.size) return; this.selection.clear(); this.syncSelection(); this.emit('selection'); }
  selectVisible() { const idx = []; for (let i = 0; i < this.visible.length; i++) if (this.visible[i]) idx.push(i); this.select(idx); }
  syncSelection() { this.renderer.setSelection([...this.selection].map(i => this.city.items[i]._building.index)); }

  onClick(hit, event) {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!hit) { if (!additive) this.clearSelection(); return; }
    if (hit.type === 'building') this.select([this.layout.buildings[hit.index].item._i], { additive });
    else {
      const node = this.layout.districts[hit.index].node;
      const idx = this.city.items.filter(it => this.visible[it._i] && under(it, node.path)).map(it => it._i);
      this.select(idx, { additive });
    }
  }
  onDoubleClick(hit) {
    if (!hit) return;
    if (hit.type === 'building') this.renderer.focusBuilding(hit.index);
    else this.focusNode(this.layout.districts[hit.index].node.path);
  }

  // J/K: walk the visible items in height order (tallest first).
  step(dir) {
    if (!this.city) return;
    const hf = this.city.fields[this.mapping.height];
    const order = this.city.items.filter(it => this.visible[it._i] === 1)
      .map(it => [it._i, hf ? (fieldValue(it, hf) ?? -Infinity) : 0])
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(x => x[0]);
    if (!order.length) return;
    const cur = this.selection.size === 1 ? order.indexOf([...this.selection][0]) : -1;
    const next = cur < 0 ? (dir > 0 ? 0 : order.length - 1) : (cur + dir + order.length) % order.length;
    this.focusItem(order[next]);
  }

  focusNode(path) {
    const node = findNode(this.city.tree, path);
    if (!node) return;
    this.focusPath = node.path;
    this.refresh();
    this.renderer.focusRect(node._district.rect);
  }
  focusItem(i) { this.select([i]); this.renderer.focusBuilding(this.city.items[i]._building.index); }
  flyToSelection() {
    if (!this.selection.size) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const i of this.selection) { const b = this.city.items[i]._building; x0 = Math.min(x0, b.x - b.w); z0 = Math.min(z0, b.z - b.d); x1 = Math.max(x1, b.x + b.w); z1 = Math.max(z1, b.z + b.d); }
    if (this.selection.size === 1) this.renderer.focusBuilding(this.city.items[[...this.selection][0]]._building.index);
    else this.renderer.focusRect({ x: x0 - 2, z: z0 - 2, w: x1 - x0 + 4, d: z1 - z0 + 4 });
  }
  resetView() { if (!this.city) return; this.focusPath = []; this.refresh(); this.renderer.resetView(); }

  snapshot() { downloadDataUrl(this.renderer.screenshot(), `${this.city.name}.png`); }

  // ---------- actions ----------
  // Actions every selected item can take right now.
  availableActions() {
    const sel = [...this.selection].map(i => this.city.items[i]);
    return sel.length ? this.city.actions.filter(a => sel.every(it => actionApplies(a, it))) : [];
  }
  applyAction(action, value) {
    const patch = action.set || { [action.field]: value };
    for (const i of this.selection) {
      const it = this.city.items[i];
      if (!actionApplies(action, it)) continue;
      for (const [f, v] of Object.entries(patch)) applyChange(this.changes, it, f, v);
    }
    this.afterEdit(Object.keys(patch));
  }
  revert(index = null) {
    const fields = new Set(); for (const [i, m] of this.changes) if (index === null || i === index) for (const f of m.keys()) fields.add(f);
    revertChanges(this.changes, this.city.items, index);
    this.afterEdit([...fields]);
  }
  afterEdit(fieldKeys) {
    for (const k of fieldKeys) if (this.city.fields[k]) recount(this.city.fields[k], this.city.items);
    this.refresh();
    this.emit('selection');
  }
  exportChanges() {
    downloadText(JSON.stringify({ name: this.city.name, changes: changeList(this.changes, this.city.items) }, null, 1), 'changes.json');
  }

  labelOf(it) { const k = this.mapping?.label; return k && k !== 'name' && it[k] != null ? String(it[k]) : it.name; }

  exportSelection() {
    const items = [...this.selection].map(i => { const o = {}; for (const [k, v] of Object.entries(this.city.items[i])) if (k[0] !== '_') o[k] = v; return o; });
    downloadText(JSON.stringify({ name: `${this.city.name} (selection)`, items }, null, 1), 'selection.json');
  }
}

// ---------- shareable views (URL hash) ----------
CityApp.prototype.serializeView = function () {
  if (!this.city) return null;
  const F = this.city.fields;
  const filters = [];
  for (const f of this.filters.values()) {
    if (f.type === 'search') filters.push({ t: 's', q: f.text });
    else if (f.type === 'range') filters.push({ t: 'r', f: f.field, a: f.min, b: f.max });
    else if (f.type === 'set') {
      const all = F[f.field].categories.map(c => c.value), inn = [...f.values];
      const out = all.filter(v => !f.values.has(v));
      filters.push(out.length < inn.length ? { t: 'c', f: f.field, out, m: f.excludeMissing ? 1 : 0 } : { t: 'c', f: f.field, in: inn, m: f.excludeMissing ? 1 : 0 });
    }
  }
  const v = { name: this.city.name, map: this.mapping, filters, focus: this.focusPath, camera: this.renderer.getCamera() };
  if (this.time.cutoff != null) v.time = this.time.cutoff;
  if (this.selection.size && this.selection.size <= 50) v.sel = [...this.selection].map(i => this.city.items[i].id);
  return v;
};
CityApp.prototype.applyView = function (v) {
  const F = this.city.fields;
  if (v.map) for (const [k, val] of Object.entries(v.map)) if (k === 'heightScale' || val === null || F[val] || (k === 'label' && val === 'name')) this.mapping[k] = val;
  for (const f of v.filters || []) {
    if (f.t === 's') this.filters.set('search', { type: 'search', text: f.q });
    else if (f.t === 'r' && F[f.f]) this.filters.set('range:' + f.f, { type: 'range', field: f.f, min: f.a, max: f.b });
    else if (f.t === 'c' && F[f.f]) {
      const all = F[f.f].categories.map(c => c.value);
      const values = new Set(f.in ? f.in : all.filter(x => !f.out.includes(x)));
      this.filters.set('set:' + f.f, { type: 'set', field: f.f, values, excludeMissing: !!f.m });
    }
  }
  if (Array.isArray(v.focus) && findNode(this.city.tree, v.focus)) this.focusPath = v.focus;
  if (v.time != null) this.time = { cutoff: v.time };
  if (Array.isArray(v.sel)) { const byId = new Map(this.city.items.map(it => [it.id, it._i])); for (const id of v.sel) if (byId.has(id)) this.selection.add(byId.get(id)); }
};
CityApp.prototype.writeHash = function () {
  clearTimeout(this.hashTimer);
  this.hashTimer = setTimeout(() => {
    const v = this.serializeView();
    if (!v) return;
    const q = this.dataUrl ? `?data=${encodeURIComponent(this.dataUrl)}` : location.search;
    history.replaceState(null, '', `${location.pathname}${q}#view=${encodeView(v)}`);
  }, 300);
};
function encodeView(v) { return btoa(unescape(encodeURIComponent(JSON.stringify(v)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function parseView(hash) {
  const m = /[#&]view=([^&]+)/.exec(hash || '');
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; }
}

function under(it, prefix) { if (it.path.length < prefix.length) return false; for (let i = 0; i < prefix.length; i++) if (it.path[i] !== prefix[i]) return false; return true; }

// ---------- boot ----------
const app = new CityApp({
  viewport: document.getElementById('viewport'),
  sidebar: document.getElementById('sidebar'),
  topbar: document.getElementById('topbar'),
  tooltip: document.getElementById('tooltip'),
  help: document.getElementById('help'),
});
window.stadtus = app;
app.loadSamplesIndex();
const param = new URLSearchParams(location.search).get('data');
if (param) app.loadUrl(param);
