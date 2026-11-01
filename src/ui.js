// Sidebar (inspector, legend-as-filter, range filters, encoding, data),
// top bar (breadcrumb, filter chips, count), tooltip, empty state, and the
// JSON-array import wizard.
import { formatValue, fieldValue, summarize, histogram, findNode } from './model.js';

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
};
const fmtN = n => n.toLocaleString();
// DOM append stringifies null; this one drops it, so conditionals can be inline.
const append = (el, ...kids) => el.append(...kids.flat(Infinity).filter(Boolean));
const ACCENT = '#3987e5', MUTED = '#4a4e5a';

export function buildUI(app, els) {
  const { sidebar, tooltip, topbar, viewport } = els;
  const S = {};

  // ----- top bar -----
  S.chips = h('div', { class: 'chips' });
  topbar.append(
    h('div', { class: 'brand' }, 'Stadtus'),
    h('div', { class: 'dataset' }),
    S.chips,
    h('div', { class: 'top-actions' },
      h('button', { class: 'btn ghost', title: 'Reset camera (R)', onclick: () => app.resetView() }, 'Reset view'),
      h('button', { class: 'btn ghost', title: 'Help', onclick: () => els.help.classList.toggle('open') }, '?'),
    ),
  );

  // ----- sidebar, ordered by how often each part is used -----
  S.inspector = section('Selection');
  S.legend = section('Legend');
  S.filters = section('Filters');
  S.encode = section('Encoding');
  S.data = section('Data');
  sidebar.append(S.inspector.el, S.legend.el, S.filters.el, S.encode.el, S.data.el);

  // ----- empty state + one-time hint, inside the viewport -----
  S.empty = h('div', { class: 'empty' });
  S.where = h('div', { class: 'where' });
  viewport.append(S.empty, S.where);

  renderData(); renderEmpty(); renderInspector();

  app.on('data', () => { renderData(); renderEmpty(); renderEncoding(); renderLegend(); renderFilters(); renderInspector(); renderTop(); renderWhere(); showHintOnce(); topbar.querySelector('.dataset').textContent = app.city.name; });
  app.on('update', () => { renderLegend(); renderTop(); renderWhere(); if (app.selection.size) renderInspector(); });
  app.on('selection', () => { renderInspector(); renderTop(); renderWhere(); });
  app.on('where', renderWhere);
  app.on('hover', ({ hit, event }) => renderTooltip(hit, event));
  app.on('samples', () => { renderData(); renderEmpty(); });
  app.on('filters', renderFilters);
  app.on('status', msg => { S.status.textContent = msg || ''; });

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: e => { const f = e.target.files[0]; if (f) app.loadFile(f); e.target.value = ''; } });
  document.body.append(fileInput);
  const sampleLinks = () => app.samples.map((s, i) => [i ? ' · ' : null, h('a', { href: '#', title: s.description || '', onclick: e => { e.preventDefault(); app.loadUrl(s.file); } }, s.name)]);

  // ----- Data -----
  function renderData() {
    const body = S.data.body; body.replaceChildren();
    S.status = h('div', { class: 'status' });
    append(body, 
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Open JSON…'),
        app.city ? h('a', { href: '#', class: 'quiet', onclick: e => { e.preventDefault(); app.snapshot(); } }, 'Save PNG') : null),
      app.samples.length ? h('div', { class: 'hint' }, 'Samples: ', sampleLinks()) : null,
      app.city?.source ? h('div', { class: 'hint' }, 'Source: ', app.city.source.url ? h('a', { href: app.city.source.url, target: '_blank', rel: 'noopener' }, app.city.source.name || app.city.source.url) : app.city.source.name,
        app.city.source.license ? ` · ${app.city.source.license}` : null, app.city.source.fetched ? ` · fetched ${app.city.source.fetched}` : null) : null,
      h('div', { class: 'hint' }, 'Drop a .json file anywhere. It is read in this tab only and never uploaded.'),
      S.status,
    );
  }

  function renderEmpty() {
    S.empty.style.display = app.city ? 'none' : 'flex';
    if (app.city) return;
    S.empty.replaceChildren(h('div', { class: 'empty-box' },
      h('h1', {}, 'Stadtus'),
      h('p', {}, 'Every object in your data becomes a building. The hierarchy decides where it stands; three fields decide its height, color, and spire.'),
      h('p', {}, h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Open JSON…'), ' or drop a file here'),
      app.samples.length ? h('div', { class: 'samples' }, app.samples.map(s => h('a', { href: '#', class: 'sample', onclick: e => { e.preventDefault(); app.loadUrl(s.file); } },
        h('b', {}, s.name), s.description ? h('span', {}, s.description) : null))) : null,
      h('p', { class: 'hint' }, 'Your data stays in this browser tab.'),
    ));
  }

  function showHintOnce() {
    let seen = false;
    try { seen = localStorage.getItem('stadtus.hint') === '1'; } catch { /* storage unavailable */ }
    if (seen) return;
    try { localStorage.setItem('stadtus.hint', '1'); } catch { /* ignore */ }
    const strip = h('div', { class: 'hint-strip', onclick: () => strip.remove() },
      h('span', {}, h('kbd', {}, 'W'), h('kbd', {}, 'A'), h('kbd', {}, 'S'), h('kbd', {}, 'D'), ' fly'), h('span', {}, h('kbd', {}, 'Q'), h('kbd', {}, 'E'), ' down / up'),
      h('span', {}, 'drag to orbit · wheel to zoom'), h('span', {}, 'click selects · double-click zooms in'), h('span', {}, h('kbd', {}, '?'), ' help'));
    viewport.append(strip);
    setTimeout(() => strip.classList.add('fade'), 9000);
    setTimeout(() => strip.remove(), 10000);
  }

  // ----- Encoding -----
  function renderEncoding() {
    const body = S.encode.body; body.replaceChildren();
    if (!app.city) return;
    const F = Object.values(app.city.fields);
    const numeric = F.filter(f => f.type === 'number' || f.type === 'date');
    const m = app.mapping;
    const fieldSelect = (key, options, allowNone) => h('select', { class: 'sel', onchange: e => app.setMapping({ [key]: e.target.value || null }) },
      allowNone ? h('option', { value: '', selected: !m[key] }, '(none)') : null,
      options.map(f => h('option', { value: f.key, selected: m[key] === f.key }, f.label)));
    append(body, 
      labeled('Height', h('div', { class: 'row nowrap' }, fieldSelect('height', numeric, true),
        h('select', { class: 'sel narrow', title: 'Height scale', onchange: e => app.setMapping({ heightScale: e.target.value }) },
          ['linear', 'sqrt', 'log'].map(s => h('option', { value: s, selected: m.heightScale === s }, s))))),
      labeled('Color', fieldSelect('color', F, true)),
      labeled('Spire', fieldSelect('spire', numeric, true)),
      labeled('Label', fieldSelect('label', [{ key: 'name', label: 'name' }, ...F.filter(f => f.type !== 'number')], false)),
    );
  }

  // ----- Legend (doubles as the category filter) -----
  function renderLegend() {
    const body = S.legend.body; body.replaceChildren();
    if (!app.city) return;
    append(body, legendBlock('Color', app.colorScale, app.mapping.color));
    const hf = app.city.fields[app.mapping.height], sf = app.city.fields[app.mapping.spire];
    if (hf) append(body, h('div', { class: 'legend-block' }, h('div', { class: 'legend-title' }, 'Height ', h('b', {}, hf.label), h('span', { class: 'quiet' }, ` ${formatValue(hf.min, hf)} to ${formatValue(hf.max, hf)}, ${app.mapping.heightScale}`))));
    if (sf) append(body, h('div', { class: 'legend-block' }, h('div', { class: 'legend-title' }, 'Spire ', h('b', {}, sf.label), h('span', { class: 'quiet' }, ` ${formatValue(sf.min, sf)} to ${formatValue(sf.max, sf)}, ${sf.scale}`))));
  }

  function legendBlock(title, scale, fieldKey) {
    const field = app.city.fields[fieldKey];
    const block = h('div', { class: 'legend-block' });
    block.append(h('div', { class: 'legend-title' }, title + ' ', field ? h('b', {}, field.label) : h('i', {}, 'none')));
    if (!scale || scale.legend.type === 'none') return block;
    const L = scale.legend;
    const swatchClass = 'swatch';
    const mark = e => h('span', { class: swatchClass, style: `--c:${e.color}` });
    if (L.type === 'sequential') {
      if (L.min === L.max) { block.append(h('div', { class: 'legend-row' }, h('span', { class: swatchClass, style: `--c:${scale.colorOf({ [field.key]: L.min })}` }), h('span', { class: 'legend-label' }, 'all ', formatValue(L.min, field)))); return block; }
      const grad = `linear-gradient(90deg, ${L.ramp.join(',')})`;
      block.append(h('div', { class: 'legend-gradient', style: `background:${grad}` }),
        h('div', { class: 'legend-range' }, h('span', {}, formatValue(L.min, field)), L.scale === 'log' ? h('span', {}, 'log') : null, h('span', {}, formatValue(L.max, field))));
      return block;
    }
    const flt = app.filters.get('set:' + field.key);
    const shown = visibleCounts(field);
    for (const e of L.entries) {
      const active = !flt || (e.missing ? !flt.excludeMissing : e.members ? e.members.some(v => flt.values.has(v)) : flt.values.has(e.value));
      const vis = e.missing ? shown.missing : (e.members || [e.value]).reduce((n, v) => n + (shown.counts.get(v) || 0), 0);
      block.append(h('div', {
        class: 'legend-row' + (active ? '' : ' inactive'),
        title: 'Click to hide or show. Shift-click to show only this. Hover to highlight.',
        onclick: ev => toggleCategory(field, e, ev.shiftKey),
        onmouseenter: () => app.setBrush({ field: field.key, values: new Set(e.missing ? [] : e.members || [e.value]), missing: !!e.missing }),
        onmouseleave: () => app.setBrush(null),
      }, mark(e), h('span', { class: 'legend-label' }, e.value),
        h('span', { class: 'legend-count' }, fmtN(vis), vis !== e.count ? h('span', { class: 'of' }, ` / ${fmtN(e.count)}`) : null)));
    }
    return block;
  }

  // How many currently visible items carry each value of a category field.
  function visibleCounts(field) {
    const counts = new Map(); let missing = 0;
    const items = app.city.items, vis = app.visible;
    for (let i = 0; i < items.length; i++) {
      if (!vis[i]) continue;
      const v = fieldValue(items[i], field);
      if (v === undefined) missing++; else counts.set(v, (counts.get(v) || 0) + 1);
    }
    return { counts, missing };
  }

  function toggleCategory(field, entry, only) {
    const key = 'set:' + field.key;
    const all = field.categories.map(c => c.value);
    const flt = app.filters.get(key);
    const values = new Set(flt ? flt.values : all);
    let excludeMissing = flt ? !!flt.excludeMissing : false;
    const members = entry.missing ? [] : entry.members || [entry.value];
    if (only) { values.clear(); for (const v of members) values.add(v); excludeMissing = !entry.missing; }
    else if (entry.missing) excludeMissing = !excludeMissing;
    else { const on = members.some(v => values.has(v)); for (const v of members) on ? values.delete(v) : values.add(v); }
    if (values.size === all.length && !excludeMissing) app.removeFilter(key);
    else app.setFilter(key, { type: 'set', field: field.key, values, excludeMissing });
  }

  // ----- Filters: search + one histogram slider per numeric field -----
  function renderFilters() {
    const body = S.filters.body; body.replaceChildren();
    if (!app.city) return;
    const search = app.filters.get('search');
    append(body, h('input', { class: 'inp', type: 'search', placeholder: 'Search names, paths, text', value: search?.text || '', oninput: e => app.setFilter('search', e.target.value ? { type: 'search', text: e.target.value } : null) }));
    for (const f of Object.values(app.city.fields)) if (f.type === 'number' || f.type === 'date') append(body, rangeFilter(f));
  }

  function rangeFilter(f) {
    const key = 'range:' + f.key;
    const cur = app.filters.get(key);
    const bins = histogram(app.city.items, f, 32);
    const peak = Math.max(1, ...bins);
    const canvas = h('canvas', { class: 'hist', width: 320, height: 28 });
    const lo = h('input', { type: 'range', min: 0, max: 1000, value: norm(cur?.min ?? f.min) });
    const hi = h('input', { type: 'range', min: 0, max: 1000, value: norm(cur?.max ?? f.max) });
    const vals = h('div', { class: 'legend-range' });
    function norm(v) { return Math.round(((v - f.min) / ((f.max - f.min) || 1)) * 1000); }
    function denorm(t) { return f.min + (t / 1000) * (f.max - f.min); }
    function draw() {
      const a = +lo.value / 1000, b = +hi.value / 1000;
      const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, bw = W / bins.length;
      ctx.clearRect(0, 0, W, H);
      bins.forEach((n, i) => {
        const x0 = i / bins.length, x1 = (i + 1) / bins.length;
        ctx.fillStyle = x1 > a && x0 < b ? ACCENT : MUTED;
        const bh = Math.max(n ? 1 : 0, (n / peak) * (H - 2));
        ctx.fillRect(i * bw + 0.5, H - bh, bw - 1, bh);
      });
      const A = denorm(+lo.value), B = denorm(+hi.value);
      vals.replaceChildren(h('span', {}, formatValue(A, f)), h('span', {}, formatValue(B, f)));
    }
    const apply = () => {
      if (+lo.value > +hi.value) lo.value = hi.value;
      if (+hi.value < +lo.value) hi.value = lo.value;
      draw();
      const a = +lo.value, b = +hi.value;
      if (a <= 0 && b >= 1000) app.removeFilter(key); else app.setFilter(key, { type: 'range', field: f.key, min: denorm(a), max: denorm(b) });
    };
    lo.addEventListener('input', apply); hi.addEventListener('input', apply);
    lo.addEventListener('dblclick', () => { lo.value = 0; hi.value = 1000; apply(); });
    hi.addEventListener('dblclick', () => { lo.value = 0; hi.value = 1000; apply(); });
    draw();
    return h('div', { class: 'range-filter' },
      h('div', { class: 'legend-title' }, h('b', {}, f.label), h('span', { class: 'quiet' }, f.type === 'date' ? ' date' : f.unit ? ` ${f.unit}` : '')),
      canvas, h('div', { class: 'dual-range' }, lo, hi), vals);
  }

  // ----- Inspector -----
  function renderInspector() {
    const body = S.inspector.body; body.replaceChildren();
    if (!app.city) { append(body, h('div', { class: 'hint' }, 'Nothing loaded.')); return; }
    const sel = [...app.selection].map(i => app.city.items[i]);
    if (!sel.length) { append(body, h('div', { class: 'hint' }, 'Click a building to inspect it.')); return; }
    const link = (label, title, fn) => h('a', { href: '#', class: 'quiet', title, onclick: e => { e.preventDefault(); fn(); } }, label);
    const actions = h('div', { class: 'row quiet-actions' },
      link('Fly to', 'F', () => app.flyToSelection()), link('Export JSON', 'Download the selected items', () => app.exportSelection()), link('Clear', 'Esc', () => app.clearSelection()));
    const edits = actionBar(sel);
    if (sel.length === 1) {
      const it = sel[0];
      append(body, ...[h('div', { class: 'insp-title' }, app.labelOf(it)), h('div', { class: 'tt-path' }, it.path.join(' / ') || '(root)'),
        app.visible[it._i] ? null : h('div', { class: 'hint warn' }, 'Hidden by the current filters.'),
        detailTable(it), edits, actions].filter(Boolean));
      return;
    }
    const hf = app.city.fields[app.mapping.height];
    const stats = summarize(sel, hf);
    const modified = sel.filter(it => app.changes.has(it._i)).length;
    append(body, h('div', { class: 'insp-title' }, fmtN(sel.length), ' items', modified ? h('span', { class: 'quiet' }, ` · ${fmtN(modified)} modified`) : null),
      stats && stats.n ? h('div', { class: 'stats' }, h('span', {}, hf.label, ' sum ', h('b', {}, formatValue(stats.sum, hf))), h('span', {}, 'mean ', h('b', {}, formatValue(stats.mean, hf))), h('span', {}, 'max ', h('b', {}, formatValue(stats.max, hf)))) : null,
      edits, actions);
    const list = h('div', { class: 'sel-list' });
    for (const it of sel.slice(0, 100)) list.append(h('div', { class: 'sel-item', onclick: () => app.focusItem(it._i), title: it.path.join(' / ') }, h('span', { class: 'swatch', style: `--c:${app.colorScale.colorOf(it)}` }), app.labelOf(it)));
    if (sel.length > 100) list.append(h('div', { class: 'hint' }, `and ${fmtN(sel.length - 100)} more`));
    append(body, list);
  }

  // Buttons for actions every selected item can take; a select for choice actions.
  function actionBar(sel) {
    const avail = app.availableActions();
    if (!avail.length && !sel.some(it => app.changes.has(it._i))) return null;
    const bar = h('div', { class: 'row actions' });
    for (const a of avail) {
      if (a.set) bar.append(h('button', { class: 'btn', onclick: () => app.applyAction(a) }, a.label));
      else bar.append(h('select', { class: 'sel auto', onchange: e => { if (e.target.value !== '') app.applyAction(a, e.target.value === '\0' ? null : e.target.value); } },
        h('option', { value: '' }, a.label + '…'), a.choices.map(v => h('option', { value: v }, v)), h('option', { value: '\0' }, '(clear)')));
    }
    if (sel.length === 1 && app.changes.has(sel[0]._i)) bar.append(h('a', { href: '#', class: 'quiet', onclick: e => { e.preventDefault(); app.revert(sel[0]._i); } }, 'revert'));
    return bar;
  }

  function detailTable(it) {
    const rows = [];
    const ch = app.changes.get(it._i);
    for (const f of Object.values(app.city.fields)) {
      const rec = ch?.get(f.key);
      const v = fieldValue(it, f);
      const val = formatValue(v, f);
      const bar = (f.type === 'number' || f.type === 'date') && f.max > f.min && v !== undefined
        ? h('span', { class: 'bar', title: `${formatValue(f.min, f)} to ${formatValue(f.max, f)}` }, h('i', { style: `left:${(100 * (v - f.min) / (f.max - f.min)).toFixed(1)}%` })) : null;
      rows.push([f.label, [rec ? h('span', { class: 'changed' }, h('s', {}, formatValue(rec.from === null ? undefined : rec.from, f)), ' → ', val) : val, bar]]);
    }
    return h('table', { class: 'detail' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
  }

  // ----- Tooltip: what is it, and the three encoded values -----
  function renderTooltip(hit, event) {
    if (!hit || !app.city) { tooltip.style.display = 'none'; return; }
    tooltip.replaceChildren();
    const F = app.city.fields, m = app.mapping;
    if (hit.type === 'building') {
      const it = app.layout.buildings[hit.index].item;
      tooltip.append(h('div', { class: 'tt-title' }, app.labelOf(it)), h('div', { class: 'tt-path' }, it.path.join(' / ') || '(root)'));
      const shown = new Set();
      for (const key of [m.height, m.color, m.spire]) {
        const f = F[key]; if (!f || shown.has(key)) continue; shown.add(key);
        tooltip.append(h('div', { class: 'tt-row' }, h('span', {}, f.label), h('b', {}, formatValue(fieldValue(it, f), f))));
      }
      if (!app.visible[it._i]) tooltip.append(h('div', { class: 'tt-note' }, 'filtered out'));
    } else {
      const d = app.layout.districts[hit.index];
      tooltip.append(h('div', { class: 'tt-title' }, d.node.name || app.city.name), h('div', { class: 'tt-path' }, d.node.path.join(' / ') || '(root)'),
        h('div', { class: 'tt-row' }, h('span', {}, 'items'), h('b', {}, fmtN(d.node.count))));
    }
    tooltip.style.display = 'block';
    const pad = 14, vw = window.innerWidth, vh = window.innerHeight;
    const r = tooltip.getBoundingClientRect();
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + r.width > vw - 8) x = event.clientX - r.width - pad;
    if (y + r.height > vh - 8) y = event.clientY - r.height - pad;
    tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  }

  // ----- Top bar: breadcrumb, filter chips, count -----
  // Floating "where am I": the selected item's place in the hierarchy, else
  // the focused district, else the district under the camera's look-at point.
  function renderWhere() {
    S.where.replaceChildren();
    if (!app.city) { S.where.style.display = 'none'; return; }
    const sel = [...app.selection].map(i => app.city.items[i]);
    let path, leaf = null, tail = null;
    if (sel.length === 1) { path = sel[0].path; leaf = app.labelOf(sel[0]); }
    else if (sel.length > 1) { path = commonPrefix(sel.map(it => it.path)); tail = `${fmtN(sel.length)} items`; }
    else path = app.focusPath.length ? app.focusPath : app.look;
    S.where.style.display = 'flex';
    const crumb = (label, p) => h('a', { href: '#', class: 'crumb', onclick: e => { e.preventDefault(); app.focusNode(p); } }, label);
    // Every separator is a menu of that level's districts, so you can move
    // sideways (Bug tracker › [any component]) as well as down.
    const menu = (prefix, current) => {
      const node = findNode(app.city.tree, prefix);
      if (!node || !node.children.size) return null;
      const kids = [...node.children.values()].sort((a, b) => b.count - a.count);
      return h('select', { class: 'crumb-menu', title: prefix.length ? `Districts in ${prefix[prefix.length - 1]}` : 'Districts', onchange: e => { if (e.target.value) app.focusNode([...prefix, e.target.value]); } },
        h('option', { value: '' }, '›'),
        kids.map(k => h('option', { value: k.name }, `${k.name === current ? '• ' : ''}${k.name}  (${fmtN(k.count)})`)));
    };
    S.where.append(crumb(app.city.name, []));
    path.forEach((seg, i) => S.where.append(menu(path.slice(0, i), seg) || h('span', { class: 'crumb-sep' }, '›'), crumb(seg, path.slice(0, i + 1))));
    const deeper = menu(path, null);
    if (deeper) S.where.append(deeper);
    if (leaf) S.where.append(h('span', { class: 'crumb-sep' }, '›'), h('span', { class: 'crumb current' }, leaf));
    if (tail) S.where.append(h('span', { class: 'crumb-sep' }, '·'), h('span', { class: 'crumb current' }, tail));
  }
  function commonPrefix(paths) {
    const out = [];
    for (let i = 0; ; i++) { const seg = paths[0][i]; if (seg === undefined || !paths.every(p => p[i] === seg)) return out; out.push(seg); }
  }

  function renderTop() {
    S.chips.replaceChildren();
    if (!app.city) return;

    const F = app.city.fields;
    for (const [key, f] of app.filters) {
      let text;
      if (f.type === 'search') text = `“${f.text}”`;
      else if (f.type === 'range') text = `${F[f.field].label} ${formatValue(f.min, F[f.field])} to ${formatValue(f.max, F[f.field])}`;
      else if (f.type === 'set') text = `${F[f.field].label}: ${f.values.size <= 3 ? [...f.values].join(', ') || '(none)' : `${f.values.size} of ${F[f.field].categories.length}`}`;
      else continue;
      S.chips.append(h('span', { class: 'chip' }, text, h('button', { class: 'x', title: 'Remove filter', onclick: () => { app.removeFilter(key); renderFilters(); } }, '×')));
    }
    if (app.filters.size > 1) S.chips.append(h('a', { href: '#', class: 'quiet', title: 'Esc', onclick: e => { e.preventDefault(); app.clearFilters(); } }, 'clear all'));
    if (app.changes.size) S.chips.append(h('span', { class: 'chip edits' }, `${fmtN(app.changes.size)} changed`,
      h('a', { href: '#', onclick: e => { e.preventDefault(); app.exportChanges(); } }, 'export'),
      h('a', { href: '#', onclick: e => { e.preventDefault(); app.revert(); } }, 'revert all')));
    const total = app.city.items.length;
    const count = app.visibleCount === total ? `${fmtN(total)} items` : `${fmtN(app.visibleCount)} of ${fmtN(total)}`;
    S.chips.append(h('span', { class: 'counts' }, count + (app.selection.size ? ` · ${fmtN(app.selection.size)} selected` : '')));
  }

  function section(title) {
    const body = h('div', { class: 'sec-body' });
    return { el: h('section', { class: 'sec' }, h('h2', {}, title), body), body };
  }
  function labeled(label, control) { return h('label', { class: 'field' }, h('span', {}, label), control); }
}

// Wizard for a plain JSON array: choose which keys form the hierarchy and the name.
export function columnWizard(columns, sample, host) {
  return new Promise(resolve => {
    const chosen = [];
    const order = h('div', { class: 'wiz-order' });
    const renderOrder = () => { order.replaceChildren(chosen.length ? chosen.map((c, i) => h('span', { class: 'chip' }, `${i + 1}. ${c}`)) : h('i', {}, 'no hierarchy yet: all buildings in one district')); };
    const list = h('div', { class: 'check-list' }, columns.map(c => h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: e => { if (e.target.checked) chosen.push(c); else chosen.splice(chosen.indexOf(c), 1); renderOrder(); } }),
      h('span', { class: 'legend-label' }, c), h('span', { class: 'legend-count' }, String(sample?.[c] ?? '').slice(0, 24)))));
    renderOrder();
    const nameSel = h('select', { class: 'sel' }, h('option', { value: '' }, '(none: use row number)'), columns.map(c => h('option', { value: c, selected: /^(name|title|label|id|file)$/i.test(c) }, c)));
    const split = h('input', { class: 'inp small', value: '/', title: 'If a chosen key holds a full path like "a/b/c", split it on this character' });
    const dlg = h('div', { class: 'modal' }, h('div', { class: 'modal-box' },
      h('h2', {}, 'Import JSON array'),
      h('p', {}, 'This file is a list of objects with no ', h('code', {}, 'path'), '. Pick the keys that form the hierarchy, in order, outermost first.'),
      list, order,
      h('label', { class: 'field' }, h('span', {}, 'Name key'), nameSel),
      h('label', { class: 'field' }, h('span', {}, 'Split paths on'), split),
      h('div', { class: 'row right' }, h('button', { class: 'btn ghost', onclick: () => { dlg.remove(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn', onclick: () => { dlg.remove(); resolve({ pathKeys: [...chosen], nameKey: nameSel.value || null, split: split.value || null }); } }, 'Build city')),
    ));
    host.append(dlg);
  });
}

export function downloadDataUrl(url, filename) {
  const a = document.createElement('a'); a.href = url; a.download = filename; document.append(body, a); a.click(); a.remove();
}
export function downloadText(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  downloadDataUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
