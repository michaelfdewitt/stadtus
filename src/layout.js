// Hierarchical quadtree-style layout: the hierarchy decides where buildings go.
//
// Every tree node owns a rectangle of ground (its "district"). The city is
// built in two passes:
//
//  1. Bottom-up sizing. Each leaf needs a `unit` x `unit` cell. Each node needs
//     a square big enough to hold its children's squares plus padding.
//  2. Top-down placement. A node's rectangle is recursively cut into pieces for
//     its children. Each cut is a guillotine cut across the longer axis, with
//     the two sides sized by the area the children on each side need - and
//     never thinner than the largest child on that side. Two cuts per level
//     give the 4-quadrant look of a quadtree while guaranteeing no slivers.
//
// The layout depends only on the hierarchy - never on filters or the visual
// mapping - so the city stays put while you explore it.

export const DEFAULT_LAYOUT = {
  unit: 3.6,          // ground units per leaf cell (footprint + air)
  gap: 1.4,           // air between a building and its cell edge (total per axis)
  sidewalk: 0.6,      // strip inside a district plate before its contents
  packSlack: 1.2,     // extra area factor for imperfect packing
  maxFootprint: 2.2,  // building footprint clamp
  minFootprint: 0.3,
  roadMin: 1.4,       // narrowest road (deep in the tree)
};

// Road width between sibling districts at a given depth: wide avenues between
// top-level districts, halving each level down. Scaled to the city size.
export function roadWidth(depth, count, o = DEFAULT_LAYOUT) {
  const base = Math.min(30, Math.max(8, Math.sqrt(count) * 0.5));
  return Math.max(o.roadMin, base / Math.pow(2, depth - 1));
}

export function layoutCity(root, options = {}) {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const buildings = [];
  const districts = [];
  let maxDepth = 0;
  let undersized = 0;

  const road = depth => roadWidth(depth, root.count, o);
  const need = new Map(); // node -> required plate side (without its road)
  sizeNode(root);
  const side = need.get(root);
  placeNode(root, { x: -side / 2, z: -side / 2, w: side, d: side }, 0);

  function sizeNode(node) {
    let area = node.items.length * o.unit * o.unit;
    let maxChild = node.items.length ? o.unit : 0;
    for (const c of node.children.values()) { const s = sizeNode(c) + road(c.depth); area += s * s; if (s > maxChild) maxChild = s; }
    const s = Math.max(maxChild, Math.sqrt(area) * o.packSlack) + 2 * o.sidewalk;
    need.set(node, s);
    return s;
  }

  function placeNode(node, rect, depth) {
    if (depth > maxDepth) maxDepth = depth;
    const district = { node, rect, depth, road: depth ? road(depth) : 0, index: districts.length };
    districts.push(district);
    node._district = district;
    const inner = inset(rect, Math.min(o.sidewalk, rect.w / 4, rect.d / 4));
    const children = [];
    for (const c of node.children.values()) children.push({ kind: 'node', node: c, side: need.get(c) + road(c.depth) });
    for (const it of node.items) children.push({ kind: 'leaf', item: it, side: o.unit });
    children.sort((a, b) => b.side - a.side);
    pack(children, inner, depth);
  }

  function pack(children, rect, depth) {
    if (!children.length) return;
    if (children.length === 1) return placeChild(children[0], rect, depth);
    // Two groups, balanced by required area (heaviest first, add to lighter).
    const A = [], B = []; let aA = 0, aB = 0, mA = 0, mB = 0;
    for (const c of children) {
      const a = c.side * c.side;
      if (aA <= aB) { A.push(c); aA += a; mA = Math.max(mA, c.side); } else { B.push(c); aB += a; mB = Math.max(mB, c.side); }
    }
    const horizontal = rect.w >= rect.d;          // cut across the longer axis
    const L = horizontal ? rect.w : rect.d;
    let f = aA / (aA + aB);
    // Guarantee each side is at least as thick as its biggest child.
    const minA = mA / L, minB = mB / L;
    if (minA + minB <= 1) f = Math.min(1 - minB, Math.max(minA, f));
    else f = minA / (minA + mB / L);              // cannot satisfy both: split proportionally to needs
    const r1 = horizontal ? { x: rect.x, z: rect.z, w: rect.w * f, d: rect.d } : { x: rect.x, z: rect.z, w: rect.w, d: rect.d * f };
    const r2 = horizontal ? { x: rect.x + rect.w * f, z: rect.z, w: rect.w * (1 - f), d: rect.d } : { x: rect.x, z: rect.z + rect.d * f, w: rect.w, d: rect.d * (1 - f) };
    if (A.length === 1) placeChild(A[0], r1, depth); else pack(A, r1, depth);
    if (B.length === 1) placeChild(B[0], r2, depth); else pack(B, r2, depth);
  }

  function placeChild(c, rect, depth) {
    if (c.kind === 'node') {
      // Half the road on each side of the cell; the plate fills what remains.
      placeNode(c.node, inset(rect, road(depth + 1) / 2), depth + 1);
    } else {
      const cell = Math.min(rect.w, rect.d);
      if (cell < o.unit - 1e-6) undersized++;
      const s = clamp(cell - o.gap, o.minFootprint, o.maxFootprint);
      const b = { item: c.item, x: rect.x + rect.w / 2, z: rect.z + rect.d / 2, w: s, d: s, depth, index: buildings.length };
      c.item._building = b;
      buildings.push(b);
    }
  }

  return { buildings, districts, side, maxDepth, undersized, bounds: { x: -side / 2, z: -side / 2, w: side, d: side } };
}

function inset(r, p) {
  p = Math.min(p, r.w / 2 - 0.01, r.d / 2 - 0.01);
  if (p < 0) p = 0;
  return { x: r.x + p, z: r.z + p, w: r.w - 2 * p, d: r.d - 2 * p };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
