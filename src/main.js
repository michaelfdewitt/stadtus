// App shell: owns state (city, mapping, filters, selection, focus), wires the
// renderer and UI together, and handles loading JSON.
import { loadCity, makeHeightScale, makeColorScale, applyFilters, findNode, fieldValue, actionApplies, applyChange, revertChanges, changeList, recount } from './model.js';
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
    this.samples = [];

    this.renderer = new CityRenderer(els.viewport, {
      onHover: (hit, event) => this.emit('hover', { hit, event }),
      onClick: (hit, event) => this.onClick(hit, event),
      onDoubleClick: hit => this.onDoubleClick(hit),
      onLook: d => { this.look = d ? d.node.path : []; this.emit('where'); },
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
      await this.loadDocument(await r.json(), url.split('/').pop());
    } catch (e) { console.error(e); this.status(`Could not load ${url}: ${e.message}`); }
  }

  async loadFile(file) {
    this.status(`Reading ${file.name}…`);
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
    this.renderer.setLayout(this.layout);
    document.title = `${this.city.name} · Stadtus`;
    this.status('');
    this.refresh();
    this.emit('data');
  }

  // ---------- state changes ----------

  refresh() {
    if (!this.city) return;
    const { items, fields } = this.city;
    const active = [...this.filters.values()];
    if (this.focusPath.length) active.push({ type: 'path', prefix: this.focusPath });
    const { mask, count } = applyFilters(items, active, fields);
    this.visible = mask; this.visibleCount = count;

    const m = this.mapping;
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
    if (!this.brush) this.emit('update');
  }

  setMapping(patch) { Object.assign(this.mapping, patch); this.refresh(); }
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
