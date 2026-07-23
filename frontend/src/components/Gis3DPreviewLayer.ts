import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import type { mat4 } from "gl-matrix";
import * as THREE from "three";
import type { UrbanFeature, FeatureGeometry } from "../lib/types";
import { colorForCategory } from "../lib/categoryColors";

const METERS_PER_DEGREE_LAT = 111_320;
const DEFAULT_BUILDING_HEIGHT_M = 6;
const DEFAULT_POLE_HEIGHT_M = 7;
const DEFAULT_ROAD_WIDTH_M = 6;
const DEFAULT_DRAIN_WIDTH_M = 1.2;
const OVERHEAD_LINE_H = 8; // typical conductor height when no real pole is nearby

interface ModelTransform {
  translateX: number;
  translateY: number;
  translateZ: number;
  scale: number;
}

type LocalProjector = (lon: number, lat: number) => [number, number];
type LocalPoint = { x: number; y: number };
type PolePosition = { x: number; y: number; topZ: number };

// Every real coordinate a feature's geometry touches, regardless of geometry
// type — used to find the loaded features' own bounding box so the local
// metre projection can be centred on them.
function flattenCoords(geom: FeatureGeometry): [number, number][] {
  switch (geom.type) {
    case "Point":
      return [geom.coordinates];
    case "MultiPoint":
    case "LineString":
      return geom.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geom.coordinates.flat();
    case "MultiPolygon":
      return geom.coordinates.flat(2);
    default:
      return [];
  }
}

// Every individual line a (Multi)LineString geometry is made of.
function toLines(geom: FeatureGeometry): [number, number][][] {
  if (geom.type === "LineString") return [geom.coordinates];
  if (geom.type === "MultiLineString") return geom.coordinates;
  return [];
}

// A case-insensitive scan for a real surveyed numeric attribute, under
// whatever naming convention this dataset happens to use.
function readNumericAttr(attrs: Record<string, unknown>, keys: string[]): number | null {
  for (const key of Object.keys(attrs)) {
    if (!keys.includes(key.toLowerCase())) continue;
    const v = Number(attrs[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// Real surveyed conductor count ("Ways" attribute: 1, 2, or 3) — some
// overhead runs are a single service wire, some a two-wire span, and only
// the real 3-phase distribution lines carry all three. Falls back to the
// standard 3-phase spacing when the attribute is absent or unrecognised —
// same convention as the full Map3DViewer modal.
function wireOffsetsForWays(ways: number | null): number[] {
  if (ways === 1) return [0];
  if (ways === 2) return [-0.4, 0.4];
  return [-0.75, 0, 0.75];
}

// Four real pole types share ONE canonical class (Illumination_Asset) — the
// raw survey category text is the only place the real distinction still
// lives ("Light Pole", "Solar Light", "Power Pole", "Power Pole With
// Light"), same classification the full Map3DViewer modal uses.
function classifyPoleKind(rawCategory: string | null): "light" | "solar" | "power" | "power-light" {
  const norm = (rawCategory ?? "").trim().toLowerCase();
  if (norm.includes("solar")) return "solar";
  if (norm.includes("power") && norm.includes("light")) return "power-light";
  if (norm.includes("power")) return "power";
  return "light";
}

function readRealHeight(attrs: Record<string, unknown>): number | null {
  const direct = readNumericAttr(attrs, ["height", "building_height", "pole_height"]);
  if (direct !== null) return direct;
  const floors = readNumericAttr(attrs, ["stories", "floors", "num_floors"]);
  return floors !== null ? floors * 3 : null; // ~3 m per floor, a stated approximation
}

// A flat extruded ribbon (thin box) following a polyline, in the X(east)/
// Y(north) plane, with a small Z thickness so it reads as a surface strip
// rather than a zero-thickness plane. Used for roads and drains — both
// rendered here as SURFACE features only (no buried depth/chamber modeling,
// which is intentionally the one thing this lightweight map-layer preview
// doesn't attempt — see the full Map3DViewer modal for that).
function buildRibbonGeometry(points: LocalPoint[], width: number, thickness: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  if (points.length < 2) return geo;
  const half = width / 2;
  const positions: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const px = -dy * half, py = dx * half;
    const p = points[i];
    positions.push(p.x + px, p.y + py, thickness, p.x - px, p.y - py, thickness);
  }
  const indices: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// A live MapLibre 3D layer that draws the real surveyed GIS features
// directly on the 2D map at their true lat/lon — buildings, poles, roads,
// sagging overhead power lines, trees, signage, drains, and manhole
// markers. A lighter, always-on-the-map alternative to the full free-orbit
// Map3DViewer modal; it intentionally never models anything BELOW the
// surface (buried pipe depth, manhole chambers) — this is a surface-only
// preview. Uses the exact same real-mercator-coordinate draping technique
// already proven by Obj3DMapLayer for the photogrammetry mesh: build
// geometry in small local metre offsets from a chosen origin (raw mercator
// units are too coarse for building-scale detail in 32-bit float), then
// re-project that origin onto the map's own matrix every frame.
export class Gis3DPreviewLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private features: UrbanFeature[];
  private classMap: Record<string, string>;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private transform: ModelTransform | null = null;

  constructor(id: string, features: UrbanFeature[], classMap: Record<string, string>) {
    this.id = id;
    this.features = features;
    this.classMap = classMap;
  }

  onAdd(_map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const f of this.features) {
      for (const [lon, lat] of flattenCoords(f.geometry)) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLon)) return; // nothing real to draw
    const originLon = (minLon + maxLon) / 2;
    const originLat = (minLat + maxLat) / 2;
    const metersPerDegLon = METERS_PER_DEGREE_LAT * Math.cos((originLat * Math.PI) / 180);
    // World (X, Y, Z) here follows Obj3DMapLayer's own convention, NOT
    // three.js's usual Y-up authoring convention: X = east, Y = north (left
    // un-flipped — render()'s -scale on Y is what converts it to mercator's
    // south-positive Y), Z = elevation (up). Every builder below authors
    // directly in that space (rotating only where a THREE geometry's own
    // default long-axis needs standing up onto Z), matching the render()
    // matrix's plain scale+translate (no rotation) exactly.
    const toLocal: LocalProjector = (lon, lat) => [
      (lon - originLon) * metersPerDegLon,
      (lat - originLat) * METERS_PER_DEGREE_LAT,
    ];

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0, -1, 1);
    scene.add(sun);

    // Pass 1: buildings + poles. Pole positions/heights are collected here
    // (solar poles excluded — they're off-grid, a line has no real reason
    // to run through one) so pass 2's power lines can snap their real
    // overhead conductors onto the real supports that are actually there.
    const polePositions: PolePosition[] = [];
    for (const f of this.features) {
      const cls = this.classMap[f.properties.category ?? ""];
      if (cls === "Building") {
        this.addBuilding(scene, f, toLocal);
      } else if (cls === "Illumination_Asset" || cls === "Utility_Pole") {
        // Utility_Pole (standalone bare power poles) always classify as
        // "power"; Illumination_Asset splits 4 ways by its own raw category
        // text — same real distinction the full Map3DViewer modal draws.
        const kind = cls === "Utility_Pole" ? "power" : classifyPoleKind(f.properties.category);
        if (f.geometry.type === "Point" && kind !== "solar") {
          const [lon, lat] = f.geometry.coordinates;
          const [x, y] = toLocal(lon, lat);
          const height = readRealHeight(f.properties.attributes) ?? DEFAULT_POLE_HEIGHT_M;
          const isWoodPole = kind === "power" || kind === "power-light";
          // The real attachment point is the crossarm's ceramic insulators
          // (wood poles) or an approximate point below the bare mast tip
          // (steel light poles have no crossarm) — not the very top.
          polePositions.push({ x, y, topZ: height - (isWoodPole ? 0.18 : 0.3) });
        }
        this.addPole(scene, f, toLocal, kind);
      }
    }

    // Pass 2: everything else, including power lines that need the pole
    // positions collected above.
    for (const f of this.features) {
      const cls = this.classMap[f.properties.category ?? ""];
      const raw = (f.properties.category ?? "").toLowerCase();
      if (cls === "Road_Segment") {
        const isPipeLike = raw.includes("sewage") || raw.includes("sewer") || raw.includes("pipe") || raw.includes("drain") || raw.includes("culvert");
        this.addLineFeature(scene, f, toLocal, {
          width: isPipeLike ? DEFAULT_DRAIN_WIDTH_M : DEFAULT_ROAD_WIDTH_M,
          thickness: isPipeLike ? 0.08 : 0.15,
        });
      } else if (cls === "Drainage_Asset") {
        this.addLineFeature(scene, f, toLocal, { width: DEFAULT_DRAIN_WIDTH_M, thickness: 0.1 });
      } else if (cls === "Power_Line") {
        if (raw.includes("water") || raw.includes("electric")) {
          // Buried in the full modal — here (surface-only) just a thin
          // ground-level line, not modeled at any real depth.
          this.addLineFeature(scene, f, toLocal, { width: 0.5, thickness: 0.06 });
        } else {
          this.addPowerLine(scene, f, toLocal, polePositions);
        }
      } else if (cls === "Vegetation") {
        this.addTree(scene, f, toLocal);
      } else if (cls === "Signage") {
        this.addSignage(scene, f, toLocal);
      } else if (cls === "Access_Point") {
        this.addManholeMarker(scene, f, toLocal);
      }
    }

    const origin = MercatorCoordinate.fromLngLat({ lng: originLon, lat: originLat }, 0);
    this.transform = {
      translateX: origin.x,
      translateY: origin.y,
      translateZ: origin.z,
      scale: origin.meterInMercatorCoordinateUnits(),
    };

    this.scene = scene;
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas as HTMLCanvasElement,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  private addBuilding(scene: THREE.Scene, f: UrbanFeature, toLocal: LocalProjector): void {
    const geom = f.geometry;
    const rings: [number, number][][] =
      geom.type === "Polygon" ? [geom.coordinates[0]] :
      geom.type === "MultiPolygon" ? geom.coordinates.map((poly) => poly[0]) :
      [];
    if (rings.length === 0) return;
    const height = readRealHeight(f.properties.attributes) ?? DEFAULT_BUILDING_HEIGHT_M;
    const color = new THREE.Color(colorForCategory(f.properties.category));
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const shape = new THREE.Shape(ring.map(([lon, lat]) => {
        const [x, y] = toLocal(lon, lat);
        return new THREE.Vector2(x, y);
      }));
      // ExtrudeGeometry extrudes the shape's local XY plane along +Z — which
      // is exactly "up" (elevation) in this layer's world axes, so no
      // rotation is needed (unlike a standard three.js Y-up scene).
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      scene.add(new THREE.Mesh(geo, mat));
    }
  }

  // Draws the real silhouette for each of the 4 real pole types this
  // dataset's raw category text distinguishes (see classifyPoleKind) —
  // same real distinction the full Map3DViewer modal draws, condensed for
  // this lighter always-on-the-map preview layer.
  private addPole(
    scene: THREE.Scene,
    f: UrbanFeature,
    toLocal: LocalProjector,
    kind: "light" | "solar" | "power" | "power-light"
  ): void {
    if (f.geometry.type !== "Point") return;
    const [lon, lat] = f.geometry.coordinates;
    const [x, y] = toLocal(lon, lat);
    const height = readRealHeight(f.properties.attributes) ?? DEFAULT_POLE_HEIGHT_M;
    const isWoodPole = kind === "power" || kind === "power-light";

    // Mast: wooden (power/power-light) vs steel (light/solar) — the same
    // real material distinction as the modal.
    const mastGeo = new THREE.CylinderGeometry(isWoodPole ? 0.15 : 0.11, isWoodPole ? 0.2 : 0.14, height, 10);
    mastGeo.rotateX(Math.PI / 2); // stand the default Y-axis cylinder upright onto Z
    const mast = new THREE.Mesh(mastGeo, new THREE.MeshStandardMaterial({
      color: isWoodPole ? 0x6b4a34 : 0x8b95a1,
      roughness: isWoodPole ? 0.9 : 0.5,
      metalness: isWoodPole ? 0 : 0.5,
    }));
    mast.position.set(x, y, height / 2);
    scene.add(mast);

    if (kind === "light" || kind === "solar") {
      // Steel arm reaching out (a plain offset box stands in for the real
      // curved arm) topped with a small glowing lamp head — the ordinary
      // streetlight silhouette.
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.06, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x8b95a1, roughness: 0.5, metalness: 0.5 })
      );
      arm.position.set(x + 0.3, y, height - 0.1);
      scene.add(arm);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xfff2c8, emissiveIntensity: 0.6, roughness: 0.4 })
      );
      lamp.position.set(x + 0.58, y, height - 0.28);
      scene.add(lamp);

      if (kind === "solar") {
        // A tilted flat panel near the top reads as a solar panel at a
        // glance — BoxGeometry(width,depth,height) params map directly
        // onto this layer's (X,Y,Z), so only a slight tilt is needed.
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(0.9, 0.55, 0.06),
          new THREE.MeshStandardMaterial({ color: 0x1f2a44, roughness: 0.25, metalness: 0.6 })
        );
        panel.rotation.x = Math.PI / 7;
        panel.position.set(x - 0.15, y, height + 0.08);
        scene.add(panel);
      }
    } else {
      // Power / power-light pole: a wooden crossarm carrying 3 ceramic
      // insulators — the real silhouette of a distribution pole, easy to
      // tell apart from a streetlight at a glance.
      const crossarmZ = height - 0.3;
      const crossarm = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.12, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x6b4a34, roughness: 0.85 })
      );
      crossarm.position.set(x, y, crossarmZ);
      scene.add(crossarm);
      for (const dx of [-0.65, 0, 0.65]) {
        const insGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.2, 8);
        insGeo.rotateX(Math.PI / 2);
        const insulator = new THREE.Mesh(insGeo, new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.4 }));
        insulator.position.set(x + dx, y, crossarmZ + 0.16);
        scene.add(insulator);
      }

      if (kind === "power-light") {
        // A short bracket above the crossarm carrying a small streetlamp —
        // still a wooden power pole, but also doing streetlight duty.
        const lamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.13, 10, 10),
          new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xfff2c8, emissiveIntensity: 0.5, roughness: 0.4 })
        );
        lamp.position.set(x + 0.2, y, height + 0.1);
        scene.add(lamp);
      }
    }
  }

  // Roads, drains, and buried-service lines — all just a flat colored
  // surface ribbon here (real width where surveyed, sane default otherwise).
  // No depth/chamber modeling for anything, by design (see class docstring).
  private addLineFeature(
    scene: THREE.Scene,
    f: UrbanFeature,
    toLocal: LocalProjector,
    opts: { width: number; thickness: number }
  ): void {
    const width = readNumericAttr(f.properties.attributes, ["width", "road_width", "carriageway_width"]) ?? opts.width;
    const color = new THREE.Color(colorForCategory(f.properties.category));
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide });
    for (const line of toLines(f.geometry)) {
      if (line.length < 2) continue;
      const pts = line.map(([lon, lat]) => {
        const [x, y] = toLocal(lon, lat);
        return { x, y };
      });
      const geo = buildRibbonGeometry(pts, width, opts.thickness);
      scene.add(new THREE.Mesh(geo, mat));
    }
  }

  // A real overhead 3-phase conductor hanging from whatever real grid poles
  // are actually there, sagging between supports the same way the full
  // Map3DViewer modal's power lines do (a parabolic droop scaled to each
  // span's own real horizontal length).
  private addPowerLine(
    scene: THREE.Scene,
    f: UrbanFeature,
    toLocal: LocalProjector,
    polePositions: PolePosition[]
  ): void {
    const color = new THREE.Color(colorForCategory(f.properties.category));
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4 });
    const nearestPoleTopZ = (x: number, y: number): number => {
      let best = Infinity, bestZ = OVERHEAD_LINE_H;
      for (const p of polePositions) {
        const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d < best) { best = d; bestZ = p.topZ; }
      }
      return bestZ;
    };
    const segClosest = (p: LocalPoint, a: LocalPoint, b: LocalPoint): { t: number; dist: number } => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + vx * t, cy = a.y + vy * t;
      return { t, dist: Math.hypot(cx - p.x, cy - p.y) };
    };
    const POLE_SNAP_TOL = 4;

    for (const line of toLines(f.geometry)) {
      if (line.length < 2) continue;
      const vlocal = line.map(([lon, lat]) => {
        const [x, y] = toLocal(lon, lat);
        const z = polePositions.length ? nearestPoleTopZ(x, y) : OVERHEAD_LINE_H;
        return { x, y, z };
      });
      // Real poles near each segment, inserted at their true walking order
      // (sorted by t) — the wire's own x/y stays on the real surveyed line
      // path (interpolated, never snapped sideways onto the pole's own
      // coordinates), only the height comes from the pole.
      const out: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < vlocal.length; i++) {
        out.push(vlocal[i]);
        if (i === vlocal.length - 1) continue;
        const a = vlocal[i], b = vlocal[i + 1];
        const hits: { t: number; x: number; y: number; z: number }[] = [];
        for (const p of polePositions) {
          const c = segClosest(p, a, b);
          if (c.t > 0.02 && c.t < 0.98 && c.dist <= POLE_SNAP_TOL) {
            hits.push({ t: c.t, x: a.x + (b.x - a.x) * c.t, y: a.y + (b.y - a.y) * c.t, z: p.topZ });
          }
        }
        hits.sort((h1, h2) => h1.t - h2.t);
        for (const h of hits) out.push({ x: h.x, y: h.y, z: h.z });
      }

      // Parabolic sag between supports, scaled to each span's real length —
      // same approximation the full modal uses.
      const SAG_RATIO = 0.035, MIN_SAG_M = 0.12, MAX_SAG_M = 1.8;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < out.length; i++) {
        const a = out[i];
        pts.push(new THREE.Vector3(a.x, a.y, a.z));
        if (i === out.length - 1) continue;
        const b = out[i + 1];
        const spanLen = Math.hypot(b.x - a.x, b.y - a.y);
        const sag = Math.min(MAX_SAG_M, Math.max(MIN_SAG_M, spanLen * SAG_RATIO));
        const steps = Math.max(3, Math.min(12, Math.round(spanLen / 4)));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const droop = 4 * sag * t * (1 - t);
          pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t - droop));
        }
      }
      if (pts.length < 2) continue;

      const waysCount = readNumericAttr(f.properties.attributes, ["ways"]);
      for (const off of wireOffsetsForWays(waysCount)) {
        const cpts = pts.map((p, i) => {
          const prev = pts[Math.max(0, i - 1)];
          const next = pts[Math.min(pts.length - 1, i + 1)];
          const t = new THREE.Vector3().subVectors(next, prev);
          if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
          // Perpendicular in the horizontal (X/Y) plane only — Z (sag) is
          // left alone so all 3 conductors droop together.
          const perp = new THREE.Vector3(-t.y, t.x, 0).normalize().multiplyScalar(off);
          return new THREE.Vector3(p.x + perp.x, p.y + perp.y, p.z);
        });
        const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cpts), Math.max(2, Math.min(400, cpts.length)), 0.035, 6, false);
        scene.add(new THREE.Mesh(geo, mat));
      }
    }
  }

  private addTree(scene: THREE.Scene, f: UrbanFeature, toLocal: LocalProjector): void {
    const geom = f.geometry;
    const pt = geom.type === "Point" ? geom.coordinates : geom.type === "Polygon" ? geom.coordinates[0][0] : null;
    if (!pt) return;
    const [x, y] = toLocal(pt[0], pt[1]);
    const trunkH = 3.2, crownH = 2.6;
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, trunkH, 6);
    trunkGeo.rotateX(Math.PI / 2);
    const trunk = new THREE.Mesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a34, roughness: 0.9 }));
    trunk.position.set(x, y, trunkH / 2);
    scene.add(trunk);

    const color = new THREE.Color(colorForCategory(f.properties.category));
    const crownGeo = new THREE.ConeGeometry(1.4, crownH, 8);
    crownGeo.rotateX(Math.PI / 2);
    const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    crown.position.set(x, y, trunkH + crownH / 2 - 0.3);
    scene.add(crown);
  }

  private addSignage(scene: THREE.Scene, f: UrbanFeature, toLocal: LocalProjector): void {
    if (f.geometry.type !== "Point") return;
    const [lon, lat] = f.geometry.coordinates;
    const [x, y] = toLocal(lon, lat);
    const postH = 1.8;
    const postGeo = new THREE.CylinderGeometry(0.04, 0.05, postH, 6);
    postGeo.rotateX(Math.PI / 2);
    const post = new THREE.Mesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.4 }));
    post.position.set(x, y, postH / 2);
    scene.add(post);

    // BoxGeometry(width, depth, height) parameters map straight onto this
    // layer's (X=east, Y=north, Z=up) axes — a thin (Y), wide (X), tall (Z)
    // panel already stands upright with no rotation needed.
    const color = new THREE.Color(colorForCategory(f.properties.category));
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.06, 0.4),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
    );
    board.position.set(x, y, postH + 0.05);
    scene.add(board);
  }

  // Real manhole chambers/depth are a full-modal-only thing (see class
  // docstring) — here just a flat cast-iron-colored disc at ground level,
  // enough to mark real surveyed positions on the surface preview.
  private addManholeMarker(scene: THREE.Scene, f: UrbanFeature, toLocal: LocalProjector): void {
    if (f.geometry.type !== "Point") return;
    const [lon, lat] = f.geometry.coordinates;
    const [x, y] = toLocal(lon, lat);
    // CircleGeometry's default normal already faces +Z (this layer's "up"),
    // so it sits flush on the ground with no rotation needed.
    const geo = new THREE.CircleGeometry(0.4, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, 0.02);
    scene.add(mesh);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: mat4): void {
    if (!this.renderer || !this.scene || !this.camera || !this.transform) return;
    const t = this.transform;
    const m = new THREE.Matrix4().fromArray(Array.from(matrix));
    const l = new THREE.Matrix4()
      .makeTranslation(t.translateX, t.translateY, t.translateZ)
      .scale(new THREE.Vector3(t.scale, -t.scale, t.scale));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    // Same convention as Obj3DMapLayer: this layer only ever paints
    // underneath, never occludes, the 2D vector layers drawn after it (a
    // building's roof shouldn't win a depth test against a marker at the
    // same lon/lat just because it happens to be "closer" in 3D).
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  onRemove(): void {
    this.scene?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    this.renderer?.dispose();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.transform = null;
  }
}
