import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { UrbanFeature } from "../lib/types";
import type { DatasetRow, SpatialAnomaly } from "../lib/workflow";
import type { AiAnswer, PipeRoute } from "../lib/ai";
import { fetchDemGrid, fetchBuildingHeights, type DemGrid } from "../lib/dem";
import { colorForCategory } from "../lib/categoryColors";

interface Props {
  features: UrbanFeature[];
  classMap: Record<string, string>;
  anomalies: SpatialAnomaly[];
  manholeAnswer: AiAnswer | null;
  datasets: DatasetRow[];
  activeDatasetIds: string[];
  onClose: () => void;
}

const DEFAULT_BUILDING_HEIGHT_M = 6; // stated fallback when DSM/DTM sampling has no value here — never silently 0
const MANHOLE_TOTAL_H = 3.0; // slab + chamber + shaft — lid tops out at this height above the chamber base
const PIPE_RADIUS_M = 0.35;

// Depth-based pipe color ramp (in scene-local metres below ground). Shallow
// pipes are warm/light, deep pipes cool/dark — so the network reads as a
// layered underground cross-section at a glance.
function pipeDepthColor(depthM: number): THREE.Color {
  const t = Math.max(0, Math.min(1, depthM / 8)); // ramp over 0..8 m
  const shallow = new THREE.Color(0x38bdf8); // sky blue
  const deep = new THREE.Color(0x1e3a8a); // navy
  return shallow.clone().lerp(deep, t);
}

const ANOMALY_COLOR: Record<string, number> = {
  red: 0xdc2626,
  yellow: 0xeab308,
  green: 0x16a34a,
};
const PROPOSED_MANHOLE_COLOR = 0x22c55e;
const PIPE_ROUTE_COLOR = 0x3aa1ff;

interface Projector {
  toLocal: (lon: number, lat: number) => [number, number]; // -> [x, z] metres
}

// Light, solar, and bare power poles all share ONE canonical class on the
// backend (Illumination_Asset) — the raw survey category text is the only
// place the real distinction still lives (seen in this dataset: "Light
// Pole", "Solar Light", "Power Pole", "Power Pole With Light"). "Power
// Pole" alone (no light fixture) must resolve to the power-pole bucket, not
// silently fall into light-pole — a combo pole ("...With Light") still has
// a light fixture, so it stays in the light bucket.
function classifyIlluminationSubtype(rawCategory: string | null): "light" | "solar" | "power" {
  const norm = (rawCategory ?? "").trim().toLowerCase();
  if (norm.includes("solar")) return "solar";
  if (norm.includes("power") && !norm.includes("light")) return "power";
  return "light";
}

// Bold, maximally-distinct hues picked by hand for these three pole
// subtypes — the generic hash-based category palette (colorForCategory)
// produced an orange/gold pair that read as near-identical at a glance,
// especially at the small marker scale used in the 3D view. Shared between
// the chip swatches/legend and the actual 3D marker colors so they always
// match.
const LIGHT_POLE_HEX = "#fbbf24"; // amber — warm light
const SOLAR_POLE_HEX = "#22c55e"; // green — solar/eco
const POWER_POLE_HEX = "#a855f7"; // violet — bare power pole

// Human-readable category name shown when an element is clicked (no redirect,
// no heavy tooltip — just the layer name + id).
const KIND_LABEL: Record<string, string> = {
  terrain: "Terrain",
  building: "Building",
  manhole: "Manhole",
  "proposed-manhole": "Proposed manhole",
  pipe: "Pipe connection",
  drain: "Drainage asset",
  pole: "Lighting pole",
  "light-pole": "Light pole",
  "solar-pole": "Solar pole",
  "power-pole": "Power pole",
  road: "Concrete road",
  powerline: "Power line",
  utilitypole: "Utility pole",
};

function makeProjector(centerLon: number, centerLat: number): Projector {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return {
    toLocal: (lon, lat) => [(lon - centerLon) * metersPerDegLon, -(lat - centerLat) * metersPerDegLat],
  };
}

/** Bilinear-sample the DTM grid at an arbitrary lon/lat — used to seat
 * buildings/manholes/pipes on the real terrain surface instead of at a
 * flat y=0, and to find each new vertex's real elevation. */
function sampleGrid(grid: DemGrid, lon: number, lat: number): number {
  const { min_lon, max_lon, min_lat, max_lat } = grid.bounds;
  const n = grid.resolution;
  const fx = ((lon - min_lon) / (max_lon - min_lon)) * (n - 1);
  const fy = ((max_lat - lat) / (max_lat - min_lat)) * (n - 1); // row 0 = north
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (r: number, c: number) => grid.elevations[r]?.[c] ?? 0;
  const top = v(y0, x0) * (1 - tx) + v(y0, x1) * tx;
  const bottom = v(y1, x0) * (1 - tx) + v(y1, x1) * tx;
  return top * (1 - ty) + bottom * ty;
}

function buildTerrainMesh(grid: DemGrid, projector: Projector, baseElevation: number): THREE.Mesh {
  const n = grid.resolution;
  const { min_lon, max_lon, min_lat, max_lat } = grid.bounds;
  const positions = new Float32Array(n * n * 3);
  let validSum = 0, validCount = 0;
  for (const row of grid.elevations) for (const v of row) if (v !== null) { validSum += v; validCount++; }
  const fallback = validCount > 0 ? validSum / validCount : baseElevation;

  for (let i = 0; i < n; i++) {
    const lat = max_lat - ((max_lat - min_lat) * i) / (n - 1);
    for (let j = 0; j < n; j++) {
      const lon = min_lon + ((max_lon - min_lon) * j) / (n - 1);
      const elev = (grid.elevations[i][j] ?? fallback) - baseElevation;
      const [x, z] = projector.toLocal(lon, lat);
      const idx = (i * n + j) * 3;
      positions[idx] = x;
      positions[idx + 1] = elev;
      positions[idx + 2] = z;
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0xcbb894,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.kind = "terrain";
  mesh.userData.baseOpacity = material.opacity;
  return mesh;
}

// Build a building volume whose BASE follows the real terrain at every
// footprint vertex (using elevAt), so the building sits exactly on the ground
// the pipes are routed against — no centroid-only lift that makes pipes look
// like they pass under/over the wrong footprint. Handles a single ring.
function buildBuildingMesh(
  ring: [number, number][],
  heightM: number,
  projector: Projector,
  elevAt: (lon: number, lat: number) => number,
  estimated: boolean,
  color: string = "#6b8caf"
): THREE.Mesh | null {
  if (ring.length < 3) return null;

  // Sample each footprint vertex at its real ground elevation. Because the
  // ring may not be closed, append the first point to close the loop for the
  // wall quads.
  const pts = ring.map(([lon, lat]) => {
    const [x, z] = projector.toLocal(lon, lat);
    return new THREE.Vector3(x, elevAt(lon, lat), z);
  });
  const closed = pts.concat([pts[0].clone()]);

  const positions: number[] = [];
  // Walls: for each edge, a quad from ground to ground+height.
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i];
    const b = closed[i + 1];
    const ah = a.y + heightM;
    const bh = b.y + heightM;
    // two triangles per wall segment
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, b.x, bh, b.z);
    positions.push(a.x, a.y, a.z, b.x, bh, b.z, a.x, ah, a.z);
  }
  // Roof: a fan from the first vertex's top across the top ring.
  const top = closed.map((p) => new THREE.Vector3(p.x, p.y + heightM, p.z));
  const roofAnchor = top[0];
  for (let i = 1; i < top.length - 1; i++) {
    positions.push(roofAnchor.x, roofAnchor.y, roofAnchor.z, top[i].x, top[i].y, top[i].z, top[i + 1].x, top[i + 1].y, top[i + 1].z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: estimated,
    opacity: estimated ? 0.6 : 0.92,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.kind = "building";
  mesh.userData.baseOpacity = material.opacity;
  return mesh;
}

function buildPipeTube(
  coords: [number, number][],
  yStart: number,
  yEnd: number,
  projector: Projector,
  color: THREE.Color = new THREE.Color(PIPE_ROUTE_COLOR),
  radius: number = PIPE_RADIUS_M
): THREE.Mesh {
  const points = coords.map(([lon, lat], idx) => {
    const [x, z] = projector.toLocal(lon, lat);
    const t = coords.length > 1 ? idx / (coords.length - 1) : 0;
    const y = yStart + (yEnd - yStart) * t;
    return new THREE.Vector3(x, y, z);
  });
  const curve = new THREE.CatmullRomCurve3(points.length > 1 ? points : [points[0], points[0]]);
  const geometry = new THREE.TubeGeometry(curve, Math.max(2, points.length * 4), radius, 14, false);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25 });
  const mesh = new THREE.Mesh(geometry, material);
  // Joint rings at regular spacing along the pipe, for a realistic segmented
  // pipe look (child meshes inherit the parent's userData on raycast via the
  // parent walk in the click handler).
  const ringMat = new THREE.MeshStandardMaterial({ color: color.clone().offsetHSL(0, 0, -0.2), roughness: 0.7 });
  const step = 6;
  for (let i = step; i < points.length - 1; i += step) {
    const p = points[i];
    const prev = points[i - 1];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dir = next.clone().sub(prev);
    if (dir.lengthSq() < 1e-6) continue;
    dir.normalize();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.12, radius * 0.22, 6, 14), ringMat);
    ring.position.copy(p);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    mesh.add(ring);
  }
  mesh.userData.kind = "pipe";
  return mesh;
}

// Realistic underground manhole: a concrete base slab, a cylindrical chamber
// wall, a conical access shaft rising to a cast-iron lid at the top. The group
// is centred so `y` is the chamber base; the lid sits at ground level when the
// manhole is seated at its real depth.
function buildManholeMarker(
  x: number,
  y: number,
  z: number,
  color: number,
  kind: string,
  id: string,
  chamberH: number = MANHOLE_TOTAL_H
): THREE.Group {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.95 });
  const wallColor = kind === "proposed-manhole" ? 0x2f9e44 : 0x9aa0a6;
  const wall = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.7 });

  const CHAMBER_R = 1.4;
  const SHAFT_R = 0.6;
  const SHAFT_H = Math.min(0.9, Math.max(0.4, chamberH * 0.25));

  // Base slab
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(CHAMBER_R + 0.4, CHAMBER_R + 0.4, 0.3, 24), concrete);
  slab.position.y = 0.15;
  group.add(slab);

  // Chamber wall (open-top cylinder, rendered double-sided so the interior
  // reads as a hollow chamber when viewed from above in underground mode)
  const chamber = new THREE.Mesh(
    new THREE.CylinderGeometry(CHAMBER_R, CHAMBER_R, chamberH, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.7, side: THREE.DoubleSide })
  );
  chamber.position.y = 0.3 + chamberH / 2;
  group.add(chamber);

  // Chamber floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(CHAMBER_R, 28), wall);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.3 + 0.01;
  group.add(floor);

  // Benching (invert channel slope hint) — a small inner ring at the floor
  const bench = new THREE.Mesh(new THREE.TorusGeometry(CHAMBER_R * 0.6, 0.12, 8, 24), concrete);
  bench.rotation.x = Math.PI / 2;
  bench.position.y = 0.5;
  group.add(bench);

  // Conical access shaft
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(SHAFT_R, CHAMBER_R, SHAFT_H, 24, 1, true), wall);
  shaft.position.y = 0.3 + chamberH + SHAFT_H / 2;
  group.add(shaft);

  // Cast-iron lid at the top
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(SHAFT_R + 0.15, SHAFT_R + 0.15, 0.18, 24),
    new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.4, metalness: 0.6 })
  );
  lid.position.y = 0.3 + chamberH + SHAFT_H + 0.09;
  group.add(lid);

  // Status ring around the lid (colored by anomaly) so the audit state reads
  const ring = new THREE.Mesh(new THREE.TorusGeometry(SHAFT_R + 0.25, 0.1, 8, 24), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3 + chamberH + SHAFT_H + 0.18;
  group.add(ring);

  group.position.set(x, y, z);
  group.userData = { kind, id };
  return group;
}

// Static flow-direction cones placed at even intervals along a pipe route.
// Each cone points along the local tangent (downstream), so the connection's
// flow direction is visible even when the surface is cut away.
function buildFlowArrows(
  route: PipeRoute,
  yStart: number,
  yEnd: number,
  projector: Projector,
  pipeColor: THREE.Color,
  radius = PIPE_RADIUS_M
): THREE.Group {
  const group = new THREE.Group();
  const coords = route.coordinates;
  if (!coords || coords.length < 2) return group;

  const points = coords.map(([lon, lat], idx) => {
    const [x, z] = projector.toLocal(lon, lat);
    const t = idx / (coords.length - 1);
    return new THREE.Vector3(x, yStart + (yEnd - yStart) * t, z);
  });

  const coneGeo = new THREE.ConeGeometry(Math.max(0.6, radius * 1.8), Math.max(1.4, radius * 4), 12);
  const mat = new THREE.MeshStandardMaterial({ color: pipeColor.clone().offsetHSL(0, -0.1, 0.15), roughness: 0.4 });

  const count = Math.max(1, Math.round(points.length / 3));
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);
    const i = Math.min(points.length - 1, Math.floor(t * (points.length - 1)));
    const a = points[i];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dir = b.clone().sub(a);
    if (dir.lengthSq() < 1e-6) continue;
    dir.normalize();
    const cone = new THREE.Mesh(coneGeo, mat);
    cone.position.copy(a);
    // ConeGeometry points +Y by default; orient it along the flow tangent.
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cone.userData = { kind: "flow-arrow", id: route.from_id };
    group.add(cone);
  }
  return group;
}

export function ManholePlan3D({ features, classMap, anomalies, manholeAnswer, datasets, activeDatasetIds, onClose }: Props) {

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: string; id: string; x?: number; y?: number } | null>(null);
  const [terrainAvailable, setTerrainAvailable] = useState(true);
  // Underground view: fade the surface (terrain + buildings) to a translucent
  // shell so the pipes + manholes seated at their real depths show through,
  // while the buildings still read as context floating above the network.
  const [underground, setUnderground] = useState(false);
  // Per-category visibility toggles (shown as chips beside the Underground
  // button). Each category lives in its own THREE.Group so toggling is a live
  // show/hide with no scene rebuild.
  type CatKey =
    | "terrain"
    | "buildings"
    | "manholes"
    | "pipes"
    | "drains"
    | "polesLight"
    | "polesSolar"
    | "polesPower"
    | "roads"
    | "powerlines";
  const [visible, setVisible] = useState<Record<CatKey, boolean>>({
    terrain: true,
    buildings: true,
    manholes: true,
    pipes: true,
    drains: true,
    polesLight: true,
    polesSolar: true,
    polesPower: true,
    roads: true,
    powerlines: true,
  });
  const groupRefs = useRef<Record<CatKey, THREE.Group | null>>({
    terrain: null,
    buildings: null,
    manholes: null,
    pipes: null,
    drains: null,
    polesLight: null,
    polesSolar: null,
    polesPower: null,
    roads: null,
    powerlines: null,
  });
  const surfaceMeshesRef = useRef<THREE.Mesh[]>([]);
  const camRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  // Lowest point of the underground network (most-negative Y), so the
  // underground view can re-frame the camera down onto the pipe network.
  const networkDepthRef = useRef(0);

  const wardDatasetId = activeDatasetIds[0];
  const dtmDataset = useMemo(
    () => datasets.find((d) => d.file_type === "geotiff" && /dtm/i.test(d.name)),
    [datasets]
  );
  const dsmDataset = useMemo(
    () => datasets.find((d) => d.file_type === "geotiff" && /dsm/i.test(d.name)),
    [datasets]
  );

  // Which GIS categories are actually present in the currently loaded
  // features — drives which layer chips show up below, the same way the
  // 2D Map Canvas's Layers panel only lists categories with real data,
  // instead of a fixed list that may not match what's in this ward.
  const categoryPresence = useMemo(() => {
    const present = new Set<string>();
    for (const f of features) present.add(classMap[f.properties.category ?? ""]);
    return present;
  }, [features, classMap]);

  // Light vs. solar poles share one canonical class (Illumination_Asset) on
  // the backend, so presence is checked separately here via the same raw
  // category text match used when rendering them below.
  const poleCategoryPresence = useMemo(() => {
    let light = false;
    let solar = false;
    let power = false;
    for (const f of features) {
      const cls = classMap[f.properties.category ?? ""];
      if (cls === "Illumination_Asset") {
        const subtype = classifyIlluminationSubtype(f.properties.category);
        if (subtype === "solar") solar = true;
        else if (subtype === "power") power = true;
        else light = true;
      } else if (cls === "Utility_Pole" && f.geometry.type === "Point") {
        power = true;
      }
    }
    return { light, solar, power };
  }, [features, classMap]);

  const chipDefs = useMemo(() => {
    const defs: [CatKey, string, string][] = [["terrain", "Terrain", "#cbb894"]];
    if (categoryPresence.has("Building")) defs.push(["buildings", "Buildings", colorForCategory("Building")]);
    if (categoryPresence.has("Access_Point")) defs.push(["manholes", "Manholes", colorForCategory("Access_Point")]);
    defs.push(["pipes", "Pipes", "#3aa1ff"]);
    if (categoryPresence.has("Drainage_Asset")) defs.push(["drains", "Drains", colorForCategory("Drainage_Asset")]);
    if (poleCategoryPresence.light) defs.push(["polesLight", "Light poles", LIGHT_POLE_HEX]);
    if (poleCategoryPresence.solar) defs.push(["polesSolar", "Solar poles", SOLAR_POLE_HEX]);
    if (poleCategoryPresence.power) defs.push(["polesPower", "Power poles", POWER_POLE_HEX]);
    if (categoryPresence.has("Road_Segment")) defs.push(["roads", "Concrete roads", colorForCategory("Road_Segment")]);
    if (categoryPresence.has("Power_Line")) defs.push(["powerlines", "Power lines", colorForCategory("Power_Line")]);
    return defs;
  }, [categoryPresence, poleCategoryPresence]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const cleanupFns: (() => void)[] = [];

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const buildings = features.filter((f) => classMap[f.properties.category ?? ""] === "Building");
        const manholes = features.filter((f) => classMap[f.properties.category ?? ""] === "Access_Point");

        if (buildings.length === 0 && manholes.length === 0) {
          setError("No buildings or manholes loaded for the active dataset(s) — select a dataset on the map first.");
          setLoading(false);
          return;
        }

        let grid: DemGrid | null = null;
        let heights: Record<string, { height_m: number | null; estimated: boolean }> = {};
        if (dtmDataset) {
          try {
            grid = await fetchDemGrid(dtmDataset.id, 120);
          } catch {
            grid = null;
          }
        }
        if (dtmDataset && dsmDataset && wardDatasetId) {
          try {
            const res = await fetchBuildingHeights(wardDatasetId, dsmDataset.id, dtmDataset.id);
            heights = res.heights;
          } catch {
            heights = {};
          }
        }
        if (disposed) return;
        setTerrainAvailable(grid !== null);

        // Centre the local coordinate system on the terrain bounds if we
        // have them, else on the buildings/manholes' own centroid.
        let centerLon: number, centerLat: number;
        if (grid) {
          centerLon = (grid.bounds.min_lon + grid.bounds.max_lon) / 2;
          centerLat = (grid.bounds.min_lat + grid.bounds.max_lat) / 2;
        } else {
          const allPts = manholes.length > 0 ? manholes : buildings;
          const first = allPts[0]?.geometry;
          const pt =
            first?.type === "Point"
              ? first.coordinates
              : first?.type === "Polygon"
              ? first.coordinates[0][0]
              : [75.919, 14.477];
          [centerLon, centerLat] = pt as [number, number];
        }
        const projector = makeProjector(centerLon, centerLat);

        // ---- three.js scene setup ----
        const width = container.clientWidth;
        const height = container.clientHeight;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xe8e4da);
        const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 5000);
        camera.position.set(0, 220, 260);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        container.innerHTML = "";
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0);
        controls.enableDamping = true;
        camRef.current = camera;
        controlsRef.current = controls;

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 0.8);
        sun.position.set(200, 300, 100);
        scene.add(sun);

        const clickable: THREE.Object3D[] = [];

        // Real elevations here are absolute (e.g. ~575 m above sea level),
        // which would place the whole scene far outside any sane camera
        // frustum if used as-is. Every Y coordinate in the scene (terrain,
        // buildings, manholes, pipes) is real elevation MINUS this baseline
        // — the shape of the terrain is still exact, just re-zeroed locally.
        let baseElevation = 0;
        if (grid) {
          let sum = 0, count = 0;
          for (const row of grid.elevations) for (const v of row) if (v !== null) { sum += v; count++; }
          baseElevation = count > 0 ? sum / count : 0;
        }

        const surfaceMeshes: THREE.Mesh[] = [];

        // One group per category so the visibility chips can toggle each live.
        const groups: Record<CatKey, THREE.Group> = {
          terrain: new THREE.Group(),
          buildings: new THREE.Group(),
          manholes: new THREE.Group(),
          pipes: new THREE.Group(),
          drains: new THREE.Group(),
          polesLight: new THREE.Group(),
          polesSolar: new THREE.Group(),
          polesPower: new THREE.Group(),
          roads: new THREE.Group(),
          powerlines: new THREE.Group(),
        };
        Object.entries(groups).forEach(([k, g]) => {
          g.name = `group-${k}`;
          scene.add(g);
          groupRefs.current[k as CatKey] = g;
        });

        if (grid) {
          const terrain = buildTerrainMesh(grid, projector, baseElevation);
          groups.terrain.add(terrain);
          surfaceMeshes.push(terrain);
        } else {
          const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(1000, 1000),
            new THREE.MeshStandardMaterial({ color: 0xd8d2c2, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
          );
          ground.rotation.x = -Math.PI / 2;
          groups.terrain.add(ground);
          surfaceMeshes.push(ground);
        }

        const elevAt = (lon: number, lat: number) => (grid ? sampleGrid(grid, lon, lat) - baseElevation : 0);

        // Case-insensitive attribute reader for real surveyed values.
        const readAttr = (attrs: Record<string, unknown>, key: string): number | null => {
          const k = Object.keys(attrs).find((a) => a.toLowerCase() === key.toLowerCase());
          if (!k) return null;
          const v = attrs[k];
          const n = typeof v === "number" ? v : parseFloat(String(v));
          return Number.isFinite(n) ? n : null;
        };

        for (const b of buildings) {
          const geom = b.geometry;
          // Collect EVERY footprint polygon (MultiPolygon can have several
          // parts — using only coordinates[0][0] previously dropped the rest
          // and produced a wrong/incomplete footprint that pipes seemed to
          // pass under).
          const rings: [number, number][][] =
            geom.type === "Polygon"
              ? [geom.coordinates[0] as [number, number][]]
              : geom.type === "MultiPolygon"
              ? (geom.coordinates as unknown as number[][][][]).map((poly) => poly[0] as [number, number][])
              : [];
          const attrs = b.properties.attributes ?? {};
          const h = heights[b.properties.id];
          // Prefer real surveyed height: floors × storey height, or an explicit
          // height attribute; else fall back to DSM−DTM sampling.
          const floors = readAttr(attrs, "floors") ?? readAttr(attrs, "no_of_floors") ?? readAttr(attrs, "num_floors");
          const attrHeight = readAttr(attrs, "height") ?? readAttr(attrs, "building_height") ?? readAttr(attrs, "elevation");
          const heightM =
            attrHeight ?? (floors ? floors * 3.2 : h?.height_m ?? DEFAULT_BUILDING_HEIGHT_M);
          const estimated = !(attrHeight || floors) && h ? h.estimated : !(attrHeight || floors);
          const bColor = colorForCategory(b.properties.category);
          for (const ring of rings) {
            if (ring.length < 3) continue;
            const mesh = buildBuildingMesh(ring, heightM, projector, elevAt, estimated, bColor);
            if (mesh) {
              mesh.userData = { kind: "building", id: b.properties.id, extra: `${b.properties.label || b.properties.id}\nCategory: ${b.properties.category}\nHeight: ${heightM.toFixed(1)} m${estimated ? " (estimated)" : ""}` };
              groups.buildings.add(mesh);
              clickable.push(mesh);
              surfaceMeshes.push(mesh);
            }
          }
        }
        surfaceMeshesRef.current = surfaceMeshes;

        const anomalyByManhole = new Map(
          anomalies.filter((a) => a.anomaly_type === "manhole_status").map((a) => [a.feature_ids[0], a])
        );
        const manholeColor = new THREE.Color(colorForCategory("Access_Point")).getHex();
        for (const m of manholes) {
          if (m.geometry.type !== "Point") continue;
          const [lon, lat] = m.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          const anomaly = anomalyByManhole.get(m.properties.id);
          // Status ring uses the audit color; the chamber body uses the same
          // category color as the 2D map so the two views stay consistent.
          const color = anomaly ? ANOMALY_COLOR[anomaly.color] ?? manholeColor : manholeColor;
          const attrs = m.properties.attributes ?? {};
          // Real surveyed chamber depth / invert when present, else the
          // standard chamber height so the lid still reaches ground.
          const attrDepth = readAttr(attrs, "depth") ?? readAttr(attrs, "chamber_depth") ?? readAttr(attrs, "invert_depth");
          const chamberH = attrDepth ?? MANHOLE_TOTAL_H;
          // Seat the chamber so its cast-iron lid reaches ground level.
          const baseY = ground - chamberH;
          const mesh = buildManholeMarker(x, baseY, z, color, "manhole", m.properties.id, chamberH);
          const statusTxt = anomaly ? `Audit: ${anomaly.color}` : "Audit: no finding";
          mesh.userData.extra = `${m.properties.id}\nChamber depth ~${chamberH.toFixed(1)} m\nLid at ground ${ground.toFixed(1)} m\n${statusTxt}`;
          groups.manholes.add(mesh);
          clickable.push(mesh);
          networkDepthRef.current = Math.min(networkDepthRef.current, baseY);
        }

        if (manholeAnswer) {
          for (const loc of manholeAnswer.needed_locations ?? []) {
            const [x, z] = projector.toLocal(loc.lon, loc.lat);
            const ground = elevAt(loc.lon, loc.lat);
            const baseY = ground - MANHOLE_TOTAL_H;
            const mesh = buildManholeMarker(x, baseY, z, PROPOSED_MANHOLE_COLOR, "proposed-manhole", loc.id, MANHOLE_TOTAL_H);
            mesh.userData.extra = `${loc.id}\nProposed manhole\n${loc.reason}`;
            groups.manholes.add(mesh);
            clickable.push(mesh);
            networkDepthRef.current = Math.min(networkDepthRef.current, baseY);
          }
          for (const route of manholeAnswer.routes ?? []) {
            // Pipe radius scales with the real diameter (mm→m, half = radius),
            // clamped so even small service lines read as a proper pipe, not a
            // wire. Real sewers are 300–1200 mm, so this matches the field.
            const pipeR = Math.max(0.25, route.pipe_spec.diameter_mm / 2000);
            // Anchor each END of the pipe into its manhole chamber: the chamber
            // base sits at (ground - chamberH), and the invert enters a little
            // above the chamber floor — so the pipe plugs into the chamber wall
            // BELOW the lid instead of floating up near ground.
            const startGround = elevAt(route.coordinates[0][0], route.coordinates[0][1]);
            const yStart =
              route.pipe_spec.from_rl !== null
                ? route.pipe_spec.from_rl - baseElevation
                : startGround - MANHOLE_TOTAL_H + 0.6;
            const lastCoord = route.coordinates[route.coordinates.length - 1];
            const endGround = elevAt(lastCoord[0], lastCoord[1]);
            const yEnd =
              route.pipe_spec.to_rl !== null
                ? route.pipe_spec.to_rl - baseElevation
                : endGround - MANHOLE_TOTAL_H + 0.6;
            // Depth-based color: deeper pipe end drives the ramp so a steep
            // falling main reads clearly darker than a shallow service line.
            const depthM = Math.max(-yStart, -yEnd);
            const pipeColor = pipeDepthColor(depthM);
            const tube = buildPipeTube(route.coordinates, yStart, yEnd, projector, pipeColor, pipeR);
            tube.userData = {
              kind: "pipe",
              id: route.from_id,
              extra: `From: ${route.from_id}\nTo: ${route.to_id ?? "—"}\nMaterial: ${route.pipe_spec.material}\nDiameter: ${route.pipe_spec.diameter_mm.toFixed(0)} mm\nDepth: ~${depthM.toFixed(1)} m below ground\nFlow: ${route.flow_confirmed ? "confirmed" : "drawn"}${route.route_basis ? `\nBasis: ${route.route_basis}` : ""}`,
            };
            groups.pipes.add(tube);
            clickable.push(tube);
            // Flow-direction cones along the route (skip for bridge/estimated
            // stubs where the geometry is a near-direct line).
            const arrows = buildFlowArrows(route, yStart, yEnd, projector, pipeColor, pipeR);
            groups.pipes.add(arrows);
            networkDepthRef.current = Math.min(networkDepthRef.current, yStart, yEnd);
          }
        }

        // Real surveyed drainage assets (lines/polylines) drawn at terrain or
        // their surveyed invert, colored with the same category palette as the
        // 2D map. These are the existing drain lines from the GDO vector layer.
        const drains = features.filter((f) => classMap[f.properties.category ?? ""] === "Drainage_Asset");
        const drainColor = new THREE.Color(colorForCategory("Drainage_Asset"));
        for (const d of drains) {
          const geom = d.geometry;
          const lines: [number, number][][] =
            geom.type === "LineString"
              ? [geom.coordinates]
              : geom.type === "MultiLineString"
              ? (geom.coordinates as [number, number][][])
              : [];
          const attrs = d.properties.attributes ?? {};
          const dR = Math.max(0.15, (readAttr(attrs, "diameter") ?? 300) / 2000);
          for (const line of lines) {
            if (line.length < 2) continue;
            const ys = line.map(([lon, lat]) => elevAt(lon, lat) - 0.4);
            const pts = line.map(([lon, lat], i) => {
              const [x, z] = projector.toLocal(lon, lat);
              return new THREE.Vector3(x, ys[i], z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), dR, 8, false);
            const mat = new THREE.MeshStandardMaterial({ color: drainColor, roughness: 0.5, metalness: 0.2 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData = {
              kind: "drain",
              id: d.properties.id,
              extra: `${d.properties.label || d.properties.id}\nCategory: Drainage_Asset${readAttr(attrs, "diameter") ? `\nDiameter: ${readAttr(attrs, "diameter")!.toFixed(0)} mm` : ""}`,
            };
            groups.drains.add(mesh);
            clickable.push(mesh);
          }
        }

        // Real surveyed poles, split into three visually distinct GIS
        // categories for THIS VIEW ONLY: light pole, solar pole, and bare
        // power pole. The backend still classifies light/solar poles as one
        // canonical class (Illumination_Asset) and bare power poles as a
        // separate one (Utility_Pole) — solar vs. light is told apart here
        // purely by matching the raw survey category text (e.g. "Solar
        // Light"), a display-only distinction that never touches the
        // classification pipeline or the AI pole-redundancy detector.
        //
        // Shapes/materials aim for the real-world look of each pole type
        // rather than an abstract color-coded marker: galvanized-steel mast
        // + curved arm + small lamp for light poles, the same mast + a
        // tilted solar panel for solar poles, and a weathered wooden pole
        // with a crossarm + ceramic insulators (no lamp) for bare power
        // poles — each one's actual real-life silhouette.
        const STEEL_MAST_COLOR = 0x8b95a1;
        const WOOD_MAST_COLOR = 0x6b4a34;
        const LAMP_GLASS_COLOR = 0xfde68a;
        const SOLAR_PANEL_COLOR = 0x1e3a5f;
        const INSULATOR_COLOR = 0xe5e7eb;

        const buildPoleMarker = (
          p: UrbanFeature,
          group: THREE.Group,
          kind: "light-pole" | "solar-pole" | "power-pole",
          categoryLabel: string
        ) => {
          if (p.geometry.type !== "Point") return;
          const [lon, lat] = p.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          const attrs = p.properties.attributes ?? {};
          // Real pole height when surveyed, else a typical 7 m street pole.
          const poleH = readAttr(attrs, "height") ?? readAttr(attrs, "pole_height") ?? readAttr(attrs, "elevation") ?? 7;
          const g = new THREE.Group();
          const isPowerPole = kind === "power-pole";
          const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(isPowerPole ? 0.15 : 0.11, isPowerPole ? 0.2 : 0.14, poleH, 10),
            new THREE.MeshStandardMaterial({
              color: isPowerPole ? WOOD_MAST_COLOR : STEEL_MAST_COLOR,
              roughness: isPowerPole ? 0.9 : 0.5,
              metalness: isPowerPole ? 0 : 0.5,
            })
          );
          mast.position.y = ground + poleH / 2;
          g.add(mast);

          if (kind === "light-pole" || kind === "solar-pole") {
            // Curved arm reaching out over the road, topped with a small
            // downward-facing lamp — the ordinary streetlight silhouette.
            const arm = new THREE.Mesh(
              new THREE.CylinderGeometry(0.05, 0.06, 0.9, 8),
              new THREE.MeshStandardMaterial({ color: STEEL_MAST_COLOR, roughness: 0.5, metalness: 0.5 })
            );
            arm.rotation.z = Math.PI / 2.3;
            arm.position.set(0.4, ground + poleH - 0.05, 0);
            g.add(arm);

            const shade = new THREE.Mesh(
              new THREE.ConeGeometry(0.22, 0.28, 10),
              new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.6, metalness: 0.4 })
            );
            shade.rotation.x = Math.PI;
            shade.position.set(0.75, ground + poleH - 0.35, 0);
            g.add(shade);

            const lamp = new THREE.Mesh(
              new THREE.SphereGeometry(0.12, 10, 10),
              new THREE.MeshStandardMaterial({
                color: LAMP_GLASS_COLOR,
                emissive: LAMP_GLASS_COLOR,
                emissiveIntensity: 0.9,
                roughness: 0.3,
              })
            );
            lamp.position.set(0.75, ground + poleH - 0.48, 0);
            g.add(lamp);

            if (kind === "solar-pole") {
              const panel = new THREE.Mesh(
                new THREE.BoxGeometry(0.9, 0.06, 0.55),
                new THREE.MeshStandardMaterial({ color: SOLAR_PANEL_COLOR, roughness: 0.25, metalness: 0.6 })
              );
              panel.position.set(-0.15, ground + poleH + 0.05, 0);
              panel.rotation.x = Math.PI / 6;
              panel.rotation.z = Math.PI / 24;
              g.add(panel);
            }
          } else {
            // Bare power/utility pole: a wooden crossarm carrying ceramic
            // insulators, no lamp — the real silhouette of a distribution
            // pole, easy to tell apart from a streetlight at a glance.
            const crossarm = new THREE.Mesh(
              new THREE.BoxGeometry(1.8, 0.12, 0.12),
              new THREE.MeshStandardMaterial({ color: WOOD_MAST_COLOR, roughness: 0.85 })
            );
            crossarm.position.y = ground + poleH - 0.3;
            g.add(crossarm);
            for (const dx of [-0.75, 0, 0.75]) {
              const insulator = new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.09, 0.22, 8),
                new THREE.MeshStandardMaterial({ color: INSULATOR_COLOR, roughness: 0.4 })
              );
              insulator.position.set(dx, ground + poleH - 0.18, 0);
              g.add(insulator);
            }
          }

          g.position.set(x, 0, z);
          g.userData = {
            kind,
            id: p.properties.id,
            extra: `${p.properties.label || p.properties.id}\nCategory: ${categoryLabel}\nHeight: ${poleH.toFixed(1)} m`,
          };
          group.add(g);
          clickable.push(g);
        };

        const illuminationPoles = features.filter((f) => classMap[f.properties.category ?? ""] === "Illumination_Asset");
        for (const p of illuminationPoles) {
          const subtype = classifyIlluminationSubtype(p.properties.category);
          if (subtype === "solar") {
            buildPoleMarker(p, groups.polesSolar, "solar-pole", "Illumination_Asset (solar)");
          } else if (subtype === "power") {
            // Bare "Power Pole" text under the Illumination_Asset class —
            // no light fixture, same crossarm marker as a Utility_Pole below.
            buildPoleMarker(p, groups.polesPower, "power-pole", "Illumination_Asset (power pole)");
          } else {
            buildPoleMarker(p, groups.polesLight, "light-pole", "Illumination_Asset (light)");
          }
        }

        // Bare power poles (Utility_Pole) that are standalone survey points
        // (not just support masts along an overhead line — those stay in
        // the power-lines rendering below) get their own "power pole" marker.
        const standalonePowerPoles = features.filter(
          (f) => classMap[f.properties.category ?? ""] === "Utility_Pole" && f.geometry.type === "Point"
        );
        for (const p of standalonePowerPoles) {
          buildPoleMarker(p, groups.polesPower, "power-pole", "Utility_Pole");
        }

        // Real surveyed concrete roads (Road_Segment centerlines) drawn as a
        // flat ribbon just above the terrain, in the map's road color.
        const roads = features.filter((f) => classMap[f.properties.category ?? ""] === "Road_Segment");
        const roadColor = new THREE.Color(colorForCategory("Road_Segment"));
        for (const r of roads) {
          const geom = r.geometry;
          const lines: [number, number][][] =
            geom.type === "LineString"
              ? [geom.coordinates]
              : geom.type === "MultiLineString"
              ? (geom.coordinates as [number, number][][])
              : [];
          for (const line of lines) {
            if (line.length < 2) continue;
            const pts = line.map(([lon, lat]) => {
              const [x, z] = projector.toLocal(lon, lat);
              return new THREE.Vector3(x, elevAt(lon, lat) + 0.15, z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 1.6, 6, false);
            // Flatten the tube into a road ribbon by scaling Y.
            geo.scale(1, 0.12, 1);
            const mat = new THREE.MeshStandardMaterial({ color: roadColor, roughness: 0.95 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData = {
              kind: "road",
              id: r.properties.id,
              extra: `${r.properties.label || r.properties.id}\nCategory: Road_Segment`,
            };
            groups.roads.add(mesh);
            clickable.push(mesh);
          }
        }

        // Real surveyed power lines (Power_Line) drawn as an overhead
        // conductor line on support masts at a typical height, in the map's
        // power-line category color. Standalone Utility_Pole points are
        // rendered separately above as their own "power pole" markers.
        const powerLines = features.filter((f) => classMap[f.properties.category ?? ""] === "Power_Line");
        const powerColor = new THREE.Color(colorForCategory("Power_Line"));
        const POLE_H = 8;
        for (const pl of powerLines) {
          const geom = pl.geometry;
          const lines: [number, number][][] =
            geom.type === "LineString"
              ? [geom.coordinates]
              : geom.type === "MultiLineString"
              ? (geom.coordinates as [number, number][][])
              : geom.type === "Point"
              ? [[pl.geometry.coordinates as [number, number], pl.geometry.coordinates as [number, number]]]
              : [];
          for (const line of lines) {
            if (line.length < 2) continue;
            const pts = line.map(([lon, lat]) => {
              const [x, z] = projector.toLocal(lon, lat);
              return new THREE.Vector3(x, elevAt(lon, lat) + POLE_H, z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.12, 6, false);
            const mat = new THREE.MeshStandardMaterial({ color: powerColor, roughness: 0.5, metalness: 0.4 });
            const mesh = new THREE.Mesh(geo, mat);
            // Small support poles at each vertex for context.
            const g = new THREE.Group();
            g.add(mesh);
            line.forEach(([lon, lat]) => {
              const [x, z] = projector.toLocal(lon, lat);
              const mast = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.13, POLE_H, 8),
                new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.8 })
              );
              mast.position.set(x, elevAt(lon, lat) + POLE_H / 2, z);
              g.add(mast);
            });
            g.userData = {
              kind: "powerline",
              id: pl.properties.id,
              extra: `${pl.properties.label || pl.properties.id}\nCategory: ${pl.properties.category}`,
            };
            groups.powerlines.add(g);
            clickable.push(g);
          }
        }


        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        // Walk up from the hit child mesh to the group carrying userData.kind
        // (manholes are Groups of meshes, pipes carry it on the mesh itself).
        const resolveHit = (hits: THREE.Intersection[]): { kind: string; id: string; extra?: string } | null => {
          if (hits.length === 0) return null;
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && !(obj.userData && obj.userData.kind)) obj = obj.parent;
          if (!obj) return null;
          const u = obj.userData as { kind: string; id: string; extra?: string };
          return { kind: u.kind, id: u.id, extra: u.extra };
        };
        // Only a DOUBLE-click reveals the element's category name — a single
        // click does nothing, so orbiting/inspecting never pops a tooltip.
        const handleDblClick = (e: MouseEvent) => {
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = resolveHit(raycaster.intersectObjects(clickable, true));
          if (!hit) return;
          setSelected({ kind: hit.kind, id: hit.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
        };
        renderer.domElement.addEventListener("dblclick", handleDblClick);
        cleanupFns.push(() => renderer.domElement.removeEventListener("dblclick", handleDblClick));

        let raf = 0;
        const animate = () => {
          controls.update();
          renderer.render(scene, camera);
          raf = requestAnimationFrame(animate);
        };
        animate();
        cleanupFns.push(() => cancelAnimationFrame(raf));

        const handleResize = () => {
          const w = container.clientWidth, h = container.clientHeight;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        };
        window.addEventListener("resize", handleResize);
        cleanupFns.push(() => window.removeEventListener("resize", handleResize));
        cleanupFns.push(() => {
          renderer.dispose();
          controls.dispose();
        });

        setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      cleanupFns.forEach((fn) => fn());
      container.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live category visibility — toggle each group's shown state with no scene
  // rebuild. Terrain + buildings are the "surface" that the Underground view
  // fades to a translucent shell so the network reads as the subject.
  useEffect(() => {
    Object.entries(groupRefs.current).forEach(([k, g]) => {
      if (g) g.visible = visible[k as CatKey];
    });
  }, [visible]);

  // Underground view: fade the surface (terrain + buildings) to a translucent
  // shell and re-frame the camera down onto the pipe network, so the manholes
  // + pipes seated at their real depths read as the subject (the surface
  // becomes a faint cap floating above). No scene rebuild — opacity + camera
  // are adjusted live.
  useEffect(() => {
    for (const mesh of surfaceMeshesRef.current) {
      const mat = (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (!mat) continue;
      const base = (mesh.userData.baseOpacity as number) ?? (mesh.userData.kind === "terrain" ? 0.55 : 0.9);
      mat.transparent = true;
      mat.opacity = underground ? (mesh.userData.kind === "terrain" ? 0.12 : 0.18) : base;
      mat.depthWrite = !underground; // let underground geometry show through
      mat.needsUpdate = true;
    }
    const cam = camRef.current;
    const controls = controlsRef.current;
    if (cam && controls) {
      if (underground) {
        // Aim the orbit target at mid-network depth and pull the camera in
        // close to the underground level for a real "down in the pipes" feel.
        const focusY = networkDepthRef.current * 0.5;
        controls.target.set(0, focusY, 0);
        cam.position.set(0, focusY + 90, 150);
      } else {
        controls.target.set(0, 0, 0);
        cam.position.set(0, 220, 260);
      }
      controls.update();
    }
  }, [underground]);

  return (
    <div className="manhole-3d-overlay" data-testid="manhole-plan-3d">
      <header className="manhole-3d-overlay__head">
        <div>
          <h3>3D Manhole Plan</h3>
          <span className="manhole-3d-overlay__hint">
            {terrainAvailable ? "Real DTM terrain + DSM building heights" : "No DTM/DSM dataset selected — flat reference ground shown"}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="manhole-3d-overlay__legend">
        <span><i style={{ background: "#dc2626" }} /> Manhole status: red</span>
        <span><i style={{ background: "#eab308" }} /> yellow</span>
        <span><i style={{ background: "#16a34a" }} /> green / proposed</span>
        <span><i style={{ background: "linear-gradient(90deg,#38bdf8,#1e3a8a)" }} /> Pipe depth (shallow→deep)</span>
        <span><i style={{ background: "#22d3ee" }} /> Flow direction</span>
      </div>
      <div className="manhole-3d-overlay__cut">
        <button
          type="button"
          className={underground ? "btn btn--active" : "btn"}
          onClick={() => setUnderground((v) => !v)}
          aria-pressed={underground}
        >
          {underground ? "Surface view" : "Underground view"}
        </button>
        <div className="manhole-3d-overlay__cats">
          {chipDefs.map(([key, label, swatch]) => (
            <button
              key={key}
              type="button"
              className={`manhole-3d-overlay__chip${visible[key] ? " is-on" : ""}`}
              onClick={() => setVisible((v) => ({ ...v, [key]: !v[key] }))}
              aria-pressed={visible[key]}
            >
              <i style={{ background: swatch }} />
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading && <div className="manhole-3d-overlay__status">Building 3D scene from real survey + terrain data…</div>}
      {error && <div className="manhole-3d-overlay__status manhole-3d-overlay__status--error">{error}</div>}
      <div ref={containerRef} className="manhole-3d-overlay__canvas" />
      {selected && (
        <div className="manhole-3d-overlay__info" style={{ left: (selected.x ?? 20) + 14, top: (selected.y ?? 20) + 14 }}>
          {KIND_LABEL[selected.kind] ?? selected.kind}
        </div>
      )}
    </div>
  );
}
