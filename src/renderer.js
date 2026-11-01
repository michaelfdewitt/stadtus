// Three.js renderer for the city. Buildings, caps and spires are InstancedMeshes
// (one draw call each), district plates another. Picking uses instanceId.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GHOST, SELECTION } from './palette.js';

const PLATE_H = 0.35;
const CAP_H = 0.3;            // flat cap on every building
const SPIRE_W = 0.22;         // spire thickness
const SPIRE_MAX = 0.5;        // longest spire as a fraction of the tallest building
const SPIRE_COLOR = 0xe6e8ec;
const STUB_H = 0.25;
const SKY = 0xa9b6c2;            // hazy daylight horizon
const ASPHALT = 0x35383d, CONCRETE = 0x6b6f76;
const TREE_COUNT = 14000;
const TILE = 2;                  // forest texture tile = TILE x city side
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const isTyping = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName);

export class CityRenderer {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.labelDepth = 3;
    this.maxHeight = 30;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'city-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    this.camera.position.set(80, 70, 90);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;

    // WASD / QE fly navigation (keys held, applied per frame)
    this.keys = new Set();
    window.addEventListener('keydown', e => { if (!isTyping(e) && KEYS.has(e.code)) { this.keys.add(e.code); this.tween = null; e.preventDefault(); } });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    this.hemi = new THREE.HemisphereLight(0xdfe8f0, 0x3d5a3a, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x3a5a34, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.boxGeo.translate(0, 0.5, 0); // origin at the base

    this.hoverMesh = new THREE.Mesh(this.boxGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false }));
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDirty = false;
    this.pointerInside = false;
    this.hit = null;
    this.tween = null;
    this.labels = [];

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', e => { this.setPointer(e); this.pointerDirty = true; this.pointerInside = true; });
    el.addEventListener('pointerleave', () => { this.pointerInside = false; this.setHit(null); });
    el.addEventListener('pointerdown', e => { this.downAt = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]);
      this.downAt = null;
      if (moved < 4) { this.setPointer(e); this.pick(); this.handlers.onClick?.(this.hit, e); }
    });
    el.addEventListener('dblclick', e => { this.setPointer(e); this.pick(); this.handlers.onDoubleClick?.(this.hit, e); });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- data ----------

  setLayout(layout, { maxHeight } = {}) {
    this.clearLayout();
    this.layout = layout;
    const side = layout.side;
    this.maxHeight = maxHeight || Math.max(20, side * 0.09);
    this.scene.fog = new THREE.Fog(SKY, side * 1.2, side * 4);
    this.ground.scale.set(side * 8, side * 8, 1);
    this.ground.material.map?.dispose();
    this.ground.material.map = forestTexture(side);
    this.ground.material.map.repeat.set(8 / TILE, 8 / TILE);
    this.ground.material.needsUpdate = true;
    this.ground.position.y = -0.01;
    this.plantForest(side);
    this.camera.far = side * 6;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = 2;
    this.controls.maxDistance = side * 3;

    this.sunDir = new THREE.Vector3(0.35, 1.1, 0.25).normalize(); // high sun: short shadows
    this.updateShadowFrustum(true);

    // district plates
    const D = layout.districts;
    this.plates = new THREE.InstancedMesh(this.boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), D.length);
    this.plates.receiveShadow = true;
    this.plates.frustumCulled = false;
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const dark = new THREE.Color(ASPHALT), light = new THREE.Color(CONCRETE);
    for (let i = 0; i < D.length; i++) {
      const d = D[i], r = d.rect;
      m.makeScale(r.w, PLATE_H, r.d).setPosition(r.x + r.w / 2, d.depth * PLATE_H, r.z + r.d / 2);
      this.plates.setMatrixAt(i, m);
      c.copy(dark).lerp(light, Math.min(1, d.depth / Math.max(1, layout.maxDepth)));
      this.plates.setColorAt(i, c);
    }
    this.plates.instanceMatrix.needsUpdate = true;
    if (this.plates.instanceColor) this.plates.instanceColor.needsUpdate = true;
    this.scene.add(this.plates);

    // buildings, caps, spires
    const N = layout.buildings.length;
    this.bodies = new THREE.InstancedMesh(this.boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }), N);
    this.caps = new THREE.InstancedMesh(this.boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 }), N);
    this.spires = new THREE.InstancedMesh(this.boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }), N);
    for (const mesh of [this.bodies, this.caps, this.spires]) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; this.scene.add(mesh); }
    this.selMesh = new THREE.InstancedMesh(this.boxGeo, new THREE.MeshBasicMaterial({ color: SELECTION, transparent: true, opacity: 0.45, depthWrite: false }), Math.max(1, N));
    this.selMesh.count = 0; this.selMesh.frustumCulled = false;
    this.scene.add(this.selMesh);
    this.heights = new Float32Array(N);
    this.topH = new Float32Array(N); // cap + spire above the body

    // labels
    this.buildLabels();
    this.resetView(false);
  }

  // Canopy blobs around the city, placed where the ground texture says forest,
  // so the 3D canopy and the painted canopy agree.
  plantForest(side) {
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    geo.translate(0, 0.4, 0);
    this.trees = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), TREE_COUNT);
    this.trees.castShadow = true; this.trees.receiveShadow = true; this.trees.frustumCulled = false;
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const inner = side * 0.55, outer = side * 1.8;
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let n = 0, tries = 0;
    while (n < TREE_COUNT && tries++ < TREE_COUNT * 8) {
      const x = (rnd() * 2 - 1) * outer, z = (rnd() * 2 - 1) * outer;
      if (Math.max(Math.abs(x), Math.abs(z)) < inner) continue;
      const f = forestAt(x, z, side);
      if (f.canopy * f.canopy < rnd()) continue;        // clustered in dense canopy, none in clearings
      const w = 3 + rnd() * 4, h = w * (0.5 + rnd() * 0.4);
      m.makeScale(w, h, w).setPosition(x, 0, z);
      this.trees.setMatrixAt(n, m);
      c.setRGB(f.r, f.g, f.b, THREE.SRGBColorSpace).offsetHSL(0, 0.04, (rnd() - 0.5) * 0.08);
      this.trees.setColorAt(n, c);
      n++;
    }
    this.trees.count = n;
    this.scene.add(this.trees);
  }

  clearLayout() {
    for (const k of ['plates', 'bodies', 'caps', 'spires', 'selMesh', 'trees']) {
      if (this[k]) { this.scene.remove(this[k]); this[k].material.dispose(); this[k].dispose?.(); this[k] = null; }
    }
    for (const l of this.labels) { this.scene.remove(l.pivot); l.material.map.dispose(); l.material.dispose(); l.geometry.dispose(); }
    this.labels = [];
    this.hoverMesh.visible = false;
    this.hit = null;
  }

  // District names are painted flat on the road in front of each district,
  // like street names: sized by the road width (so top-level names are big
  // and deep ones small).
  buildLabels() {
    for (const l of this.labels) { this.scene.remove(l.pivot); l.material.map.dispose(); l.material.dispose(); l.geometry.dispose(); }
    this.labels = [];
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    for (const d of this.layout.districts) {
      if (d.depth < 1 || d.depth > this.labelDepth || !d.node.name) continue;
      const { texture, aspect } = textTexture(d.node.name, aniso);
      let textH = d.road * 0.7, w = textH * aspect;
      if (w > d.rect.w * 0.92) { w = d.rect.w * 0.92; textH = w / aspect; }
      const geometry = new THREE.PlaneGeometry(w, textH);
      // decal on the road: polygon offset keeps it from z-fighting with the plate
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const plane = new THREE.Mesh(geometry, material);
      plane.rotation.x = -Math.PI / 2;
      const pivot = new THREE.Object3D();
      pivot.position.set(d.rect.x + d.rect.w / 2, d.depth * PLATE_H + 0.03, d.rect.z + d.rect.d + d.road / 4);
      pivot.add(plane);
      this.scene.add(pivot);
      this.labels.push({ pivot, geometry, material, textH, district: d });
    }
  }

  setLabelDepth(n) { this.labelDepth = n; if (this.layout) this.buildLabels(); }

  // visuals: arrays indexed by building index
  // heights: normalized 0..1 (NaN = missing); colors: hex strings;
  // spires: normalized 0..1 spire length (NaN = none);
  // visible: Uint8Array (0 = filtered out, drawn as a gray stub);
  // emphasis: optional Uint8Array (0 = brushed out, drawn gray at full height)
  update({ heights, colors, spires, visible, emphasis, ghostMode = 'ghost' }) {
    if (!this.layout) return;
    const B = this.layout.buildings;
    const m = new THREE.Matrix4(), c = new THREE.Color(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const ghost = new THREE.Color(GHOST), spireGhost = new THREE.Color(GHOST).offsetHSL(0, 0, 0.15), spireColor = new THREE.Color(SPIRE_COLOR);
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      const base = (b.depth + 1) * PLATE_H;
      const vis = !visible || visible[i];
      let h;
      if (!vis && ghostMode === 'hide') h = 0;
      else if (!vis) h = STUB_H;
      else { const t = heights[i]; h = Number.isFinite(t) ? STUB_H + t * this.maxHeight : STUB_H; }
      this.heights[i] = h;
      this.topH[i] = 0;
      if (h <= 0) { this.bodies.setMatrixAt(i, zero); this.caps.setMatrixAt(i, zero); this.spires.setMatrixAt(i, zero); continue; }
      const dim = !vis || (emphasis && !emphasis[i]);
      m.makeScale(b.w, h, b.d).setPosition(b.x, base, b.z);
      this.bodies.setMatrixAt(i, m);
      c.set(dim ? GHOST : colors[i]);
      this.bodies.setColorAt(i, c);
      if (!vis) { this.caps.setMatrixAt(i, zero); this.spires.setMatrixAt(i, zero); continue; }
      m.makeScale(b.w * 1.06, CAP_H, b.d * 1.06).setPosition(b.x, base + h + 0.02, b.z);
      this.caps.setMatrixAt(i, m);
      this.caps.setColorAt(i, dim ? ghost : c.offsetHSL(0, 0, 0.12)); // sunlit cap: lighter shade of the body
      const t = spires ? spires[i] : NaN;
      const L = Number.isFinite(t) ? t * this.maxHeight * SPIRE_MAX : 0;
      if (L > 0.05) {
        m.makeScale(SPIRE_W, L, SPIRE_W).setPosition(b.x, base + h + CAP_H, b.z);
        this.spires.setMatrixAt(i, m);
        this.spires.setColorAt(i, dim ? spireGhost : spireColor);
      } else this.spires.setMatrixAt(i, zero);
      this.topH[i] = CAP_H + L;
    }
    for (const mesh of [this.bodies, this.caps, this.spires]) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    if (this.hit?.type === 'building') this.placeHover(this.hit.index);
  }

  setSelection(buildingIndices) {
    if (!this.layout) return;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const i of buildingIndices) {
      const b = this.layout.buildings[i];
      const h = this.heights[i];
      if (h <= 0) continue;
      // a tall translucent beacon, so the selection is findable from any distance
      m.makeScale(b.w + 0.7, h + this.topH[i] + this.maxHeight * 0.45, b.d + 0.7).setPosition(b.x, (b.depth + 1) * PLATE_H - 0.02, b.z);
      this.selMesh.setMatrixAt(n++, m);
    }
    this.selMesh.count = n;
    this.selMesh.instanceMatrix.needsUpdate = true;
  }

  placeHover(i) {
    const b = this.layout.buildings[i];
    const h = this.heights[i];
    if (h <= 0) { this.hoverMesh.visible = false; return; }
    this.hoverMesh.scale.set(b.w + 0.5, h + this.topH[i] + 0.3, b.d + 0.5);
    this.hoverMesh.position.set(b.x, (b.depth + 1) * PLATE_H - 0.01, b.z);
    this.hoverMesh.visible = true;
  }

  // ---------- picking ----------

  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.lastEvent = e;
  }

  pick() {
    if (!this.layout) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    let hit = null;
    const hb = this.raycaster.intersectObjects([this.bodies, this.caps, this.spires], false);
    if (hb.length) hit = { type: 'building', index: hb[0].instanceId };
    else {
      {
        const hp = this.raycaster.intersectObject(this.plates, false);
        if (hp.length) {
          // the plate closest to the camera is the deepest one hit at that point; prefer deepest district
          let best = hp[0];
          for (const h of hp) if (this.layout.districts[h.instanceId].depth > this.layout.districts[best.instanceId].depth) best = h;
          hit = { type: 'district', index: best.instanceId };
        }
      }
    }
    this.setHit(hit);
  }

  setHit(hit) {
    const same = (a, b) => (!a && !b) || (a && b && a.type === b.type && a.index === b.index);
    if (same(hit, this.hit)) return;
    this.hit = hit;
    if (hit?.type === 'building') this.placeHover(hit.index); else this.hoverMesh.visible = false;
    this.handlers.onHover?.(hit, this.lastEvent);
  }

  // ---------- camera ----------

  focusRect(rect, { animate = true, elevation = 0.75 } = {}) {
    const cx = rect.x + rect.w / 2, cz = rect.z + rect.d / 2;
    const size = Math.max(rect.w, rect.d, 4);
    const dist = (size / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.15;
    const target = new THREE.Vector3(cx, (rect.y ?? 0), cz);
    // keep current azimuth
    const cur = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    cur.y = 0;
    if (cur.lengthSq() < 1e-6) cur.set(0.6, 0, 0.8);
    cur.normalize();
    const dir = new THREE.Vector3(cur.x * Math.cos(elevation), Math.sin(elevation), cur.z * Math.cos(elevation));
    const pos = target.clone().addScaledVector(dir, dist);
    this.flyTo(pos, target, animate);
  }

  focusBuilding(i, opts) {
    const b = this.layout.buildings[i];
    const h = this.heights[i] || 1;
    const s = Math.max(b.w, b.d) * 6 + h * 0.8;
    this.focusRect({ x: b.x - s / 2, z: b.z - s / 2, w: s, d: s, y: (b.depth + 1) * PLATE_H + h / 2 }, { elevation: 0.55, ...opts });
  }

  resetView(animate = true) {
    if (!this.layout) return;
    this.focusRect(this.layout.bounds, { animate, elevation: 0.85 });
  }

  flyTo(pos, target, animate = true) {
    if (!animate) { this.camera.position.copy(pos); this.controls.target.copy(target); this.controls.update(); return; }
    this.tween = { t0: performance.now(), dur: 750, p0: this.camera.position.clone(), p1: pos, t0v: this.controls.target.clone(), t1v: target };
  }

  // ---------- loop ----------

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    if (this.keys.size) this.fly(dt);
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      this.controls.target.lerpVectors(this.tween.t0v, this.tween.t1v, e);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();
    if (this.pointerDirty && this.pointerInside && !this.downAt) { this.pointerDirty = false; this.pick(); }
    if ((this.frameNo = (this.frameNo || 0) + 1) % 6 === 0) {
      const d = this.districtAt(this.controls.target.x, this.controls.target.z);
      if (d !== this.lookDistrict) { this.lookDistrict = d; this.handlers.onLook?.(d); }
    }
    this.updateLabels();
    this.updateShadowFrustum();
    this.renderer.render(this.scene, this.camera);
  }

  // The shadow camera follows the look-at point and shrinks as you zoom in,
  // so shadow texels stay fine where you are looking (no acne on building tops).
  updateShadowFrustum(force = false) {
    if (!this.layout) return;
    const side = this.layout.side, t = this.controls.target;
    const dist = this.camera.position.distanceTo(t);
    const half = Math.min(side * 0.7, Math.max(30, dist * 1.1));
    const key = `${Math.round(t.x / 5)},${Math.round(t.z / 5)},${Math.round(half / 5)}`;
    if (!force && key === this.shadowKey) return;
    this.shadowKey = key;
    this.sun.target.position.set(t.x, 0, t.z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, half * 3);
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = half; sc.far = half * 5;
    sc.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
  }

  // Move camera and orbit target together, relative to the camera heading on
  // the ground plane. Speed scales with distance to the target (zoom level).
  fly(dt) {
    const k = this.keys;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x); // fwd x up
    const move = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
    if (k.has('KeyE')) move.y += 1;
    if (k.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    let speed = Math.max(dist, 4) * 1.2;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) speed *= 3;
    move.normalize().multiplyScalar(speed * dt);
    const minY = 1.5;
    if (this.camera.position.y + move.y < minY) move.y = minY - this.camera.position.y;
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  // Deepest district whose plate contains the ground point (x, z).
  districtAt(x, z) {
    if (!this.layout) return null;
    let node = this.layout.districts[0].node, d = node._district;
    const inside = (r, x, z) => x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d;
    if (!inside(d.rect, x, z)) return null;
    for (;;) {
      let next = null;
      for (const c of node.children.values()) if (inside(c._district.rect, x, z)) { next = c; break; }
      if (!next) return d;
      node = next; d = node._district;
    }
  }

  // Labels run along their road; flip them when the camera is on the far side
  // so they never read upside down. Hide ones too small to read.
  updateLabels() {
    if (!this.labels.length) return;
    const h = this.renderer.domElement.clientHeight || 1;
    const k = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const cam = this.camera.position, t = this.controls.target;
    const yaw = cam.z - t.z >= 0 ? 0 : Math.PI;
    for (const l of this.labels) {
      const p = l.pivot.position;
      const dist = Math.hypot(cam.x - p.x, cam.y - p.y, cam.z - p.z);
      l.pivot.visible = l.textH * k / Math.max(dist, 1) > 9;
      l.pivot.rotation.y = yaw;
    }
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  screenshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

function textTexture(text, anisotropy) {
  const font = '600 64px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width = Math.max(16, tw + 24); canvas.height = 88;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8e7e2';
  ctx.fillText(text, 12, 46);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return { texture, aspect: canvas.width / canvas.height };
}

// ---------- forest ----------
// Value noise + fbm; cheap and deterministic.
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const hash = (i, j) => { const t = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return t - Math.floor(t); };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x, y) { return 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2.03 + 7, y * 2.01 + 3) + 0.125 * vnoise(x * 4.1 + 13, y * 3.9 + 5) + 0.0625 * vnoise(x * 8.2 + 1, y * 7.9 + 9); }
const lerp = (a, b, t) => a + (b - a) * t;

// What the land looks like at world (x, z): canopy density 0..1 and a color.
// Periodic in the texture tile so the painted ground and the blobs line up.
function forestAt(x, z, side) {
  const tile = side * TILE;
  const u = ((x % tile) + tile) % tile / tile, v = ((z % tile) + tile) % tile / tile;
  const broad = fbm(u * 6, v * 6);                 // forest vs. open land
  const fine = Math.min(1, Math.max(0, (fbm(u * 40 + 31, v * 40 + 17) - 0.3) / 0.4)); // canopy lumps, stretched
  const clearing = Math.max(0, (broad - 0.57) * 5); // 0 = forest, 1 = field
  // forest: dark to mid greens by canopy; fields: dry yellow-greens (sRGB)
  const r = lerp(0.17, 0.42, fine), g = lerp(0.33, 0.56, fine), b = lerp(0.14, 0.26, fine);
  const fr = lerp(0.50, 0.68, fine), fg = lerp(0.52, 0.62, fine), fb = lerp(0.26, 0.34, fine);
  const k = Math.min(1, clearing);
  return { canopy: (1 - k) * (0.35 + 0.65 * fine), r: lerp(r, fr, k), g: lerp(g, fg, k), b: lerp(b, fb, k) };
}

function forestTexture(side) {
  const size = 1024, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  const tile = side * TILE;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const f = forestAt(px / size * tile, py / size * tile, side);
    const grain = 0.92 + 0.16 * vnoise(px * 0.9, py * 0.9); // per-pixel grain
    const o = (py * size + px) * 4;
    d[o] = f.r * 255 * grain; d[o + 1] = f.g * 255 * grain; d[o + 2] = f.b * 255 * grain; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
