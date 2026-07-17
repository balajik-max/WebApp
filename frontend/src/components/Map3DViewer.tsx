import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { UrbanFeature } from "../lib/types";
import type { DatasetRow, SpatialAnomaly } from "../lib/workflow";
import type { AiAnswer, PipeRoute } from "../lib/ai";
import { fetchDemGrid, fetchBuildingHeights, type DemGrid, type DemBounds } from "../lib/dem";
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

// Four real pole types share ONE canonical class on the backend
// (Illumination_Asset) — the raw survey category text is the only place the
// real distinction still lives (seen in this dataset: "Light Pole", "Solar
// Light", "Power Pole", "Power Pole With Light"). "Power Pole" alone (no
// light fixture) is the bare power-pole bucket; "Power Pole With Light" is
// its own combo bucket (a real power pole that ALSO carries a light
// fixture) — it must not collapse into either the bare power-pole or the
// plain light-pole bucket, since it's visually and functionally both.
function classifyIlluminationSubtype(rawCategory: string | null): "light" | "solar" | "power" | "power-light" {
  const norm = (rawCategory ?? "").trim().toLowerCase();
  if (norm.includes("solar")) return "solar";
  if (norm.includes("power") && norm.includes("light")) return "power-light";
  if (norm.includes("power")) return "power";
  return "light";
}

function makeProjector(centerLon: number, centerLat: number): Projector {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return {
    toLocal: (lon, lat) => [(lon - centerLon) * metersPerDegLon, -(lat - centerLat) * metersPerDegLat],
  };
}

// Real road vertices can be tens of metres apart. Elevation is only ever
// sampled AT a line's own vertices, so a road ribbon built straight from the
// sparse original points is correct exactly at each vertex but can still dip
// below a terrain rise IN BETWEEN two of them — the ribbon has no idea that
// hump is there. Inserting extra points every few metres along each segment
// (linear lon/lat interpolation, accurate at this scale) means the ribbon's
// elevation is resampled from the real terrain continuously along its whole
// length, not just at the handful of original survey points.
function densifyLine(line: [number, number][], projector: Projector, maxStepM: number): [number, number][] {
  const out: [number, number][] = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const [lon0, lat0] = line[i];
    const [lon1, lat1] = line[i + 1];
    const [x0, z0] = projector.toLocal(lon0, lat0);
    const [x1, z1] = projector.toLocal(lon1, lat1);
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(segLen / maxStepM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t]);
    }
  }
  return out;
}

// A real coconut-palm frond is a long, tapering, ARCHING blade — not a
// rigid straight spike. A plain ConeGeometry (what earlier attempts used)
// always reads as a stiff horn/spike no matter how it's angled, because it
// has no curve along its own length. This bends a flat tapered blade
// (PlaneGeometry) into a droop by displacing each row of vertices further
// down the closer it is to the tip (a simple quadratic droop), and narrows
// the blade toward the tip so it comes to a point like a real leaf.
// Built ONCE and reused (scaled) across every frond on every tree — the
// shape is shared, only length/material differ per instance.
function buildFrondGeometry(length: number, width: number, droop: number): THREE.BufferGeometry {
  const segments = 8;
  const geo = new THREE.PlaneGeometry(width, length, 1, segments);
  geo.translate(0, length / 2, 0); // base at the geometry's own origin, tip at +Y = length
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / length; // 0 at base, 1 at the tip
    pos.setZ(i, pos.getZ(i) - droop * t * t);
    pos.setX(i, pos.getX(i) * (1 - t * 0.82)); // taper to a point at the tip
  }
  pos.needsUpdate = true;
  // Bake the length axis onto -Z and the droop onto -Y, so placing a frond
  // is just "position at the crown, rotate around Y to face outward" — no
  // extra per-instance rotation math needed to get the arch/droop right.
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// Rich per-object detail payload — mirrors what the 2D Map Canvas's own
// HoverTooltip shows (color swatch, category, real surveyed attributes),
// plus the real lon/lat, so a click in the 3D view gives the exact same
// information the 2D map already gives on hover, not just a bare kind label.
export interface Object3DDetail {
  kind: string;
  id: string;
  label: string;
  category: string;
  color: string;
  severity?: number;
  attributes: Record<string, unknown>;
  lon?: number;
  lat?: number;
}

// "Real world color" mode paints every category with a plausible real-life
// material color (concrete-grey buildings, asphalt roads, blue water, green
// vegetation, ...) instead of the arbitrary hash-based GIS category color —
// a quick way to see the model as it would actually look, not a color-coded
// diagram. Falls back to a neutral grey for anything unrecognized so
// nothing is ever left uncolored.
function realWorldColorFor(rawCategory: string | null | undefined): string {
  const raw = (rawCategory ?? "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => raw.includes(k));
  if (has("water")) return "#2b7fd6";
  if (has("sewage", "sewer", "drain", "culvert")) return "#6b6459";
  if (has("electric", "power")) return "#3a3a3a";
  if (has("road", "street", "carriageway", "centerline", "path", "lane")) return "#5b5f66";
  if (has("wall", "fence", "boundary", "compound")) return "#a89a7d";
  if (has("tree", "coconut", "palm", "vegetation", "plant", "shrub", "bush")) return "#2f7a3a";
  if (has("manhole", "chamber", "access", "inspection")) return "#8a8a8a";
  if (has("sign", "board")) return "#1d4ed8";
  if (has("pole", "light")) return "#8b95a1";
  if (has("contour")) return "#a8a094";
  if (has("temple", "church", "mosque")) return "#d8c9a3";
  if (has("shed", "hut")) return "#b0553d";
  if (has("building", "structure", "house", "extenstion", "extension", "school", "hospital", "office", "shop", "market", "hall")) {
    return "#c9c2b3";
  }
  return "#9aa3ad";
}

function featureDetail(
  f: UrbanFeature,
  kind: string,
  color: string,
  lon?: number,
  lat?: number
): Object3DDetail {
  return {
    kind,
    id: f.properties.id,
    label: f.properties.label || f.properties.id,
    category: f.properties.category ?? "Uncategorized",
    color,
    severity: f.properties.severity,
    attributes: f.properties.attributes ?? {},
    lon,
    lat,
  };
}

// First real geometry coordinate across the loaded features — used to centre
// the scene when no DTM grid is available, regardless of which categories are
// present (so the 3D view works for any GDP layer set, not just buildings).
function firstFeatureCoord(features: UrbanFeature[]): [number, number] {
  for (const f of features) {
    const g = f.geometry;
    if (g.type === "Point") return g.coordinates as [number, number];
    if (g.type === "Polygon") return g.coordinates[0][0] as [number, number];
    if (g.type === "MultiPolygon") return g.coordinates[0][0][0] as [number, number];
    if (g.type === "LineString") return g.coordinates[0] as [number, number];
    if (g.type === "MultiLineString") return g.coordinates[0][0] as [number, number];
  }
  return [75.919, 14.477];
}

// Bounding box (EPSG:4326) across all loaded features — used to guarantee the
// 3D ground plane covers every surveyed feature even if the DTM raster itself
// doesn't span the full surveyed extent.
function featureBBox(features: UrbanFeature[]): DemBounds | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const acc = (lon: number, lat: number) => {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  };
  for (const f of features) {
    const g = f.geometry;
    if (g.type === "Point") acc((g.coordinates as [number, number])[0], (g.coordinates as [number, number])[1]);
    else if (g.type === "LineString") (g.coordinates as [number, number][]).forEach((c) => acc(c[0], c[1]));
    else if (g.type === "MultiLineString") (g.coordinates as [number, number][][]).forEach((l) => l.forEach((c) => acc(c[0], c[1])));
    else if (g.type === "Polygon") (g.coordinates[0] as [number, number][]).forEach((c) => acc(c[0], c[1]));
    else if (g.type === "MultiPolygon") (g.coordinates as [number, number][][][]).forEach((p) => p[0].forEach((c) => acc(c[0], c[1])));
  }
  if (!isFinite(minLon)) return null;
  return { min_lon: minLon, min_lat: minLat, max_lon: maxLon, max_lat: maxLat };
}

// Real-life-ish fallback for any GDP category that has no bespoke 3D builder.
// Colored with the same palette the 2D Map Canvas uses for that category so
// the two views stay visually consistent:
//   • Point   → a post + glowing marker (e.g. asset / survey point)
//   • Line    → a tube following the surveyed centreline (road/pipe/edge)
//   • Polygon → an extruded footprint sitting on the terrain (building/plot)
// Smart, real-life-ish fallback for any GDP category that has no bespoke 3D
// builder. It inspects the raw category NAME (lowercased) + geometry type and
// picks a fitting real-world silhouette, reusing the same module-level builders
// the specialised manhole/building/etc. paths use, so the whole 3D view reads
// as one consistent, realistic city model rather than a set of abstract blobs.
function buildGenericFeature(
  f: UrbanFeature,
  projector: Projector,
  elevAt: (lon: number, lat: number) => number,
  color: string
): THREE.Object3D | null {
  const geom = f.geometry;
  const cat = ((f.properties.category ?? "").trim() || "uncategorized").toLowerCase();
  const colorObj = new THREE.Color(color);
  const has = (...keys: string[]) => keys.some((k) => cat.includes(k));

  // Stable per-feature pseudo-height so a category doesn't render a flat
  // monoculture — gives the model natural variation without surveyed data.
  const seed = Array.from(String(f.properties.id ?? cat)).reduce((a, c) => a + c.charCodeAt(0), 0);
  const vary = (base: number, spread: number) => base + ((seed % 7) / 7 - 0.5) * 2 * spread;

  // -------------------------------------------------------------- POLYGON
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    const rings: [number, number][][] =
      geom.type === "Polygon"
        ? [geom.coordinates[0] as [number, number][]]
        : (geom.coordinates as unknown as number[][][][]).map((poly) => poly[0] as [number, number][]);
    const group = new THREE.Group();
    for (const ring of rings) {
      if (ring.length < 3) continue;
      if (has("water", "river", "lake", "pond", "canal", "tank", "reservoir", "stream")) {
        // Water body: a thin, translucent blue slab draped on the terrain.
        const pts = ring.map(([lon, lat]) => {
          const [x, z] = projector.toLocal(lon, lat);
          return new THREE.Vector3(x, elevAt(lon, lat) + 0.12, z);
        });
        const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.z)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: 0x2b8fd6,
            transparent: true,
            opacity: 0.55,
            roughness: 0.15,
            metalness: 0.2,
          })
        );
        group.add(mesh);
      } else if (has("fence", "wall", "hedge", "boundary", "compound")) {
        // Wall / fence / boundary: a low solid extrusion with a distinct cap.
        const mesh = buildBuildingMesh(ring, vary(2.2, 0.4), projector, elevAt, false, color);
        if (mesh) group.add(mesh);
      } else if (
        has(
          "building", "structure", "footprint", "house", "shed", "room", "plot",
          "temple", "church", "mosque", "school", "college", "hospital", "office",
          "shop", "market", "hall", "hostel", "clinic", "bank", "hotel", "warehouse"
        )
      ) {
        // Building / structure: full-height extruded volume.
        const mesh = buildBuildingMesh(ring, vary(6, 2.5), projector, elevAt, false, color);
        if (mesh) group.add(mesh);
      } else {
        // Generic plot / area: a low extruded slab so it still reads as a volume.
        const mesh = buildBuildingMesh(ring, vary(1.4, 0.5), projector, elevAt, false, color);
        if (mesh) group.add(mesh);
      }
    }
    return group.children.length ? group : null;
  }

  // --------------------------------------------------------------- LINE
  if (geom.type === "LineString" || geom.type === "MultiLineString") {
    const lines: [number, number][][] =
      geom.type === "LineString"
        ? [geom.coordinates as [number, number][]]
        : (geom.coordinates as [number, number][][]);
    const group = new THREE.Group();
      for (const rawLine of lines) {
        if (rawLine.length < 2) continue;
        const isPipeLike = has("water", "river", "canal", "drain", "pipe", "sewer", "culvert", "channel");
        // Resample every ~3 m so the ribbon follows the real terrain relief
        // continuously instead of only at the sparse original survey points.
        const line = densifyLine(rawLine, projector, 3);
        const pts = line.map(([lon, lat]) => {
          const [x, z] = projector.toLocal(lon, lat);
          // Buried utilities sit below the terrain; surface features stay on it.
          // Road ribbons are flattened via geo.scale(1, 0.12, 1) below —
          // radius 1.4 * 0.12 = 0.168 m half-thickness, so a lift smaller than
          // that leaves the ribbon's underside below the terrain (the "road
          // sinks into the ground" bug). 0.4 m clears it with margin.
          const y = isPipeLike
            ? elevAt(lon, lat) - 2.2
            : has("road", "street", "path", "track", "lane", "footpath", "carriageway", "edge", "rail", "railway")
            ? elevAt(lon, lat) + 0.4
            : elevAt(lon, lat) - 1.8;
          return new THREE.Vector3(x, y, z);
        });
        const curve = new THREE.CatmullRomCurve3(pts);
        const mat = new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.7, metalness: 0.1 });
        if (has("road", "street", "path", "track", "lane", "footpath", "carriageway", "edge", "rail", "railway")) {
          // Road / path: a flat ribbon just above the terrain.
          const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 1.4, 6, false);
          geo.scale(1, 0.12, 1);
          group.add(new THREE.Mesh(geo, mat));
        } else if (has("fence", "wall", "hedge", "boundary")) {
          const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.18, 6, false);
          group.add(new THREE.Mesh(geo, mat));
        } else if (isPipeLike) {
          // Drainage / pipe / channel: a proper buried tube following the centreline.
          group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.4, 8, false), mat));
        } else {
          // Other (comms cable, etc.): buried just under the surface.
          const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.35, 8, false);
          group.add(new THREE.Mesh(geo, mat));
        }
      }
    return group.children.length ? group : null;
  }

  // --------------------------------------------------------------- POINT
  if (geom.type === "Point") {
    const [lon, lat] = geom.coordinates as [number, number];
    const [x, z] = projector.toLocal(lon, lat);
    const ground = elevAt(lon, lat);
    const g = new THREE.Group();

    if (has("tree", "plant", "vegetation", "palm", "shrub", "bush", "garden", "forest")) {
      // Tree / vegetation: trunk + canopy.
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.2, 1.2, 8),
        new THREE.MeshStandardMaterial({ color: 0x6b4a34, roughness: 0.9 })
      );
      trunk.position.y = ground + 0.6;
      g.add(trunk);
      const canopy = new THREE.Mesh(
        new THREE.SphereGeometry(1.3, 10, 10),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.8 })
      );
      canopy.position.y = ground + 2.1;
      canopy.scale.y = 1.15;
      g.add(canopy);
    } else if (has("flag")) {
      // Flag pole: a plain pole with a flag — no lamp head.
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.3 })
      );
      mast.position.y = ground + 4;
      g.add(mast);
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.7, 0.04),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.7, side: THREE.DoubleSide })
      );
      flag.position.set(0.6, ground + 7.3, 0);
      g.add(flag);
    } else if (has("microwave")) {
      // Microwave / communication tower: a tall mast with an equipment pod.
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.28, 18, 10),
        new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.4 })
      );
      mast.position.y = ground + 9;
      g.add(mast);
      const pod = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.6, 0.5),
        new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.6, metalness: 0.3 })
      );
      pod.position.y = ground + 16;
      g.add(pod);
    } else if (has("transformer")) {
      // Transformer: a ground-mounted cabinet on a small plinth.
      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.3, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.8 })
      );
      plinth.position.y = ground + 0.15;
      g.add(plinth);
      const cab = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 1.4, 0.8),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.5, metalness: 0.3 })
      );
      cab.position.y = ground + 1.0;
      g.add(cab);
    } else if (has("planter")) {
      // Planter box: a low rectangular planter with a green planting top.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.6, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.9 })
      );
      box.position.y = ground + 0.3;
      g.add(box);
      const plants = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x3f8f3f, roughness: 0.9 })
      );
      plants.position.y = ground + 0.75;
      plants.scale.set(1.4, 0.8, 1.4);
      g.add(plants);
    } else if (has("pole", "mast", "tower", "pylon", "light", "lamp", "streetlight", "solar")) {
      // Pole / light / mast: galvanised mast + small lamp head.
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.14, 7, 10),
        new THREE.MeshStandardMaterial({ color: 0x8b95a1, roughness: 0.5, metalness: 0.5 })
      );
      mast.position.y = ground + 3.5;
      g.add(mast);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        new THREE.MeshStandardMaterial({ color: colorObj, emissive: colorObj, emissiveIntensity: 0.6, roughness: 0.4 })
      );
      lamp.position.y = ground + 7;
      g.add(lamp);
    } else if (has("manhole", "chamber", "pit", "inspection", "cover")) {
      // Manhole / access chamber: reuse the realistic chamber builder.
      g.add(buildManholeMarker(x, ground - 3, z, colorObj.getHex(), "manhole", String(f.properties.id ?? "x"), 3));
    } else if (has("drain", "silt", "gully")) {
      // Drain point: a short grated box.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.4, 0.8),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.6, metalness: 0.2 })
      );
      box.position.y = ground + 0.2;
      g.add(box);
    } else if (has("sign", "board", "marker", "pillar", "post", "indicator")) {
      // Sign / board: post + flat board.
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6),
        new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.4 })
      );
      post.position.y = ground + 0.9;
      g.add(post);
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.4, 0.04),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.5, metalness: 0.2 })
      );
      board.position.y = ground + 1.75;
      g.add(board);
    } else if (has("water", "tank", "pump", "well", "reservoir")) {
      // Tank / pump: a cylinder on the ground.
      const tank = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 1.6, 16),
        new THREE.MeshStandardMaterial({ color: colorObj, roughness: 0.5, metalness: 0.3 })
      );
      tank.position.y = ground + 0.8;
      g.add(tank);
    } else {
      // Generic asset: a realistic slim pylon + coloured cap so it reads as a
      // surveyed point feature rather than an abstract dot.
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.14, 1.4, 8),
        new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.7, metalness: 0.3 })
      );
      post.position.y = ground + 0.7;
      g.add(post);
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 12, 12),
        new THREE.MeshStandardMaterial({ color: colorObj, emissive: colorObj, emissiveIntensity: 0.35, roughness: 0.5 })
      );
      cap.position.y = ground + 1.5;
      g.add(cap);
    }

    g.position.set(x, 0, z);
    return g;
  }

  return null;
}

// Exactly replicates buildTerrainMesh's own triangulation of each grid cell
// (corners a=(i,j), b=(i,j+1), c=(i+1,j), d=(i+1,j+1), split into triangles
// a-c-b and b-c-d) instead of true bilinear interpolation. Plain bilinear is
// NOT planar within a cell — it's a saddle surface — so it can diverge from
// the flat triangle the mesh actually renders there. Every feature seated via
// elevAt() must use THIS sampling, or a feature can sit slightly below the
// rendered terrain right at that divergence — the "road/feature sinks into
// the ground" bug. This guarantees an exact match, always, not just "usually
// close enough with a safety margin".
function sampleGridPlanar(grid: DemGrid, lon: number, lat: number): number {
  const { min_lon, max_lon, min_lat, max_lat } = grid.bounds;
  const n = grid.resolution;
  const fx = ((lon - min_lon) / (max_lon - min_lon)) * (n - 1);
  const fy = ((max_lat - lat) / (max_lat - min_lat)) * (n - 1);
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (r: number, c: number): number => {
    const raw = grid.elevations[r]?.[c];
    return raw == null ? NaN : raw;
  };
  const A = v(y0, x0); // corner (i, j)     — mesh vertex a
  const B = v(y0, x1); // corner (i, j+1)   — mesh vertex b
  const C = v(y1, x0); // corner (i+1, j)   — mesh vertex c
  const D = v(y1, x1); // corner (i+1, j+1) — mesh vertex d
  if (tx + ty <= 1) {
    // Triangle a-c-b (mirrors indices.push(a, c, b, ...) below).
    return A + tx * (B - A) + ty * (C - A);
  }
  // Triangle b-c-d (mirrors ..., b, c, d) below.
  const u = 1 - tx, w = 1 - ty;
  return D + u * (C - D) + w * (B - D);
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
    opacity: 0.5,
    depthWrite: false,
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
  bodyColor: number,
  kind: string,
  id: string,
  chamberH: number = MANHOLE_TOTAL_H,
  ringColor: number = bodyColor
): THREE.Group {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.95 });
  // Chamber wall/lid use this manhole's real category color (matching the 2D
  // Layers panel) — a proposed (AI-suggested) manhole isn't a real surveyed
  // category, so it keeps its own distinct green regardless of bodyColor.
  const wallColor = kind === "proposed-manhole" ? 0x2f9e44 : bodyColor;
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

  // Status ring around the lid (colored by anomaly when one exists, else the
  // same category color as the chamber) so the audit state reads separately
  // from the manhole's own category color underneath it.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(SHAFT_R + 0.25, 0.1, 8, 24), new THREE.MeshStandardMaterial({ color: ringColor, roughness: 0.5 }));
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

export function Map3DViewer({ features, classMap, anomalies, manholeAnswer, datasets, activeDatasetIds, onClose }: Props) {

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Selected object's details, shown in a fixed top-right panel (not a
  // tooltip that follows the cursor) — come straight off the clicked
  // object's userData (see resolveHit below), same shape as the 2D Map
  // Canvas's own HoverTooltip data.
  const [selected, setSelected] = useState<Object3DDetail | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  // Restores the selected object's own material(s) to their pre-selection
  // emissive state — set when a selection is made, called (and cleared) here
  // and from the click handler whenever the selection changes or is closed.
  const tintRestoreRef = useRef<(() => void) | null>(null);
  const clearSelection = () => {
    tintRestoreRef.current?.();
    tintRestoreRef.current = null;
    setSelected(null);
  };
  const [terrainAvailable, setTerrainAvailable] = useState(true);
  // Underground view: fade the surface (terrain + buildings) to a translucent
  // shell so the pipes + manholes seated at their real depths show through,
  // while the buildings still read as context floating above the network.
  const [underground, setUnderground] = useState(false);
  // Search filter for the Layers panel (mirrors the 2D Map Canvas panel).
  const [layerQuery, setLayerQuery] = useState("");
  // "default" = the same hash-based GIS category color the 2D Map Canvas
  // uses everywhere in this view; "realworld" = a plausible real-life
  // material color per category instead. Changing this rebuilds the whole
  // scene (it's a dependency of the main build effect below) since colors
  // are baked into each object's material at construction time.
  const [colorMode, setColorMode] = useState<"default" | "realworld">("default");
  const sceneColor = (raw: string | null | undefined) =>
    colorMode === "realworld" ? realWorldColorFor(raw) : colorForCategory(raw);
  // Per-category visibility toggles (shown as chips beside the Underground
  // button). Each category lives in its own THREE.Group so toggling is a live
  // show/hide with no scene rebuild.
  // Dynamic category key: every GIS layer present in the data (the same set
  // the 2D Map Canvas Layers panel lists) gets its own group + chip, not just
  // a hard-coded handful. The specialised manhole/building/etc. builders
  // below still own their canonical classes; anything else falls through to a
  // generic builder so NO surveyed category is ever silently dropped in 3D.
  const HANDLED_CANONICAL = new Set<string>([
    "Building", "Access_Point", "Drainage_Asset", "Illumination_Asset",
    "Utility_Pole", "Road_Segment", "Power_Line", "Vegetation",
    "Signage", "Elevation_Contour", "Drainage_Level_Point",
  ]);
  const [visible, setVisible] = useState<Record<string, boolean>>({
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
    vegetation: true,
    signage: true,
    contours: true,
    levelpoints: true,
  });
  const groupRefs = useRef<Record<string, THREE.Group | null>>({});
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

  // The full set of categories present in the loaded data, with counts and the
  // same colors the 2D Map Canvas Layers panel uses — this drives the 3D
  // Layers panel so it lists EXACTLY the same layers as the 2D map.
  const categoryList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of features) {
      const raw = (f.properties.category ?? "").trim();
      if (raw === "raster_pixel") continue;
      const cat = raw && raw !== "" ? raw : "uncategorized";
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([category, count]) => ({ category, count, color: sceneColor(category) }))
      .sort((a, b) => b.count - a.count);
  }, [features, colorMode]);

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

        if (features.length === 0) {
          setError("No features loaded for the active dataset(s) — select a dataset on the map first.");
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
          const firstPt = firstFeatureCoord(features);
          [centerLon, centerLat] = firstPt;
        }
        const projector = makeProjector(centerLon, centerLat);

        // ---- three.js scene setup ----
        const width = container.clientWidth;
        const height = container.clientHeight;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xe8e4da);
        sceneRef.current = scene;
        const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 5000);
        camera.position.set(0, 220, 260);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        container.innerHTML = "";
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0);
        controls.enableDamping = true;
        camRef.current = camera;
        controlsRef.current = controls;

        scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a86, 0.85));
        scene.add(new THREE.AmbientLight(0xffffff, 0.25));
        const sun = new THREE.DirectionalLight(0xfff4e0, 1.1);
        sun.position.set(220, 320, 120);
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

        // One group per CATEGORY (keyed by its raw name, exactly like the 2D
        // Map Canvas Layers panel) so every surveyed GDP layer gets its own
        // live show/hide toggle — no category is ever silently dropped in 3D.
        const groups: Record<string, THREE.Group> = {};
        const ensureGroup = (key: string): THREE.Group => {
          let g = groups[key];
          if (!g) {
            g = new THREE.Group();
            g.name = `group-${key}`;
            groups[key] = g;
            scene.add(g);
            groupRefs.current[key] = g;
          }
          return g;
        };
        // Group key for a feature's own raw category (mirrors the 2D panel).
        const gkey = (f: UrbanFeature) => `cat:${(f.properties.category ?? "").trim() || "uncategorized"}`;
        const gfor = (f: UrbanFeature) => ensureGroup(gkey(f));
        ensureGroup("terrain");
        for (const c of categoryList) ensureGroup(`cat:${c.category}`);
        if ((manholeAnswer?.routes?.length ?? 0) > 0) ensureGroup("pipes");

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

        // Guarantee visible ground beneath EVERY surveyed feature ONLY when
        // there's no real DTM at all. When a grid DOES exist but doesn't
        // quite span the full feature extent, sampleGridPlanar already
        // clamps out-of-bounds queries to the nearest edge cell (a sensible
        // real elevation, not NaN) — adding a SEPARATE flat floor on top of
        // the real (non-flat) terrain mesh in that case just produced two
        // visibly disjointed ground panels, one flat and one following the
        // real relief, stepping apart at their edges.
        const fb = featureBBox(features);
        if (fb && !grid) {
          const [x0, z0] = projector.toLocal(fb.min_lon, fb.min_lat);
          const [x1, z1] = projector.toLocal(fb.max_lon, fb.max_lat);
          const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.abs(x1 - x0) + 80, Math.abs(z1 - z0) + 80),
            new THREE.MeshStandardMaterial({
              color: 0xcbb894,
              transparent: true,
              opacity: 0.5,
              depthWrite: false,
              side: THREE.DoubleSide,
              roughness: 0.9,
            })
          );
          floor.rotation.x = -Math.PI / 2;
          floor.position.set((x0 + x1) / 2, -0.1, (z0 + z1) / 2);
          groups.terrain.add(floor);
          surfaceMeshes.push(floor);
        }

        // Seat features on the terrain surface. For nodata cells fall back to
        // the baseline (baseElevation) so a feature sits exactly on the flat
        // fallback terrain the mesh uses there — never 575 m below it.
        const elevAt = (lon: number, lat: number): number => {
          if (!grid) return 0;
          const e = sampleGridPlanar(grid, lon, lat);
          return (Number.isNaN(e) ? baseElevation : e) - baseElevation;
        };

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
          const bColor = sceneColor(b.properties.category);
          for (const ring of rings) {
            if (ring.length < 3) continue;
            const mesh = buildBuildingMesh(ring, heightM, projector, elevAt, estimated, bColor);
            if (mesh) {
              const centroidLon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
              const centroidLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
              const detail = featureDetail(b, "building", bColor, centroidLon, centroidLat);
              mesh.userData = {
                ...detail,
                attributes: {
                  ...detail.attributes,
                  "Height (m)": `${heightM.toFixed(1)}${estimated ? " (estimated)" : ""}`,
                },
              };
              gfor(b).add(mesh);
              clickable.push(mesh);
              surfaceMeshes.push(mesh);
            }
          }
        }
        surfaceMeshesRef.current = surfaceMeshes;

        const anomalyByManhole = new Map(
          anomalies.filter((a) => a.anomaly_type === "manhole_status").map((a) => [a.feature_ids[0], a])
        );
        for (const m of manholes) {
          if (m.geometry.type !== "Point") continue;
          const [lon, lat] = m.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          const anomaly = anomalyByManhole.get(m.properties.id);
          // Status ring uses the audit color; the chamber body otherwise uses
          // this manhole's OWN raw category color — the same string the 2D
          // Map Canvas / Layers panel colors it by, not the shared canonical
          // class name (a different string that hashes to a different color).
          const catColorHex = sceneColor(m.properties.category);
          const manholeColor = new THREE.Color(catColorHex).getHex();
          const ringColor = anomaly ? ANOMALY_COLOR[anomaly.color] ?? manholeColor : manholeColor;
          const attrs = m.properties.attributes ?? {};
          // Real surveyed chamber depth / invert when present, else the
          // standard chamber height so the lid still reaches ground.
          const attrDepth = readAttr(attrs, "depth") ?? readAttr(attrs, "chamber_depth") ?? readAttr(attrs, "invert_depth");
          const chamberH = attrDepth ?? MANHOLE_TOTAL_H;
          // Seat the chamber so its cast-iron lid reaches ground level.
          const baseY = ground - chamberH;
          const mesh = buildManholeMarker(x, baseY, z, manholeColor, "manhole", m.properties.id, chamberH, ringColor);
          const statusTxt = anomaly ? `Audit: ${anomaly.color}` : "Audit: no finding";
          const detail = featureDetail(m, "manhole", catColorHex, lon, lat);
          mesh.userData = {
            ...detail,
            attributes: { ...detail.attributes, "Chamber depth (m)": chamberH.toFixed(1), "Audit status": statusTxt },
          };
          gfor(m).add(mesh);
          clickable.push(mesh);
          networkDepthRef.current = Math.min(networkDepthRef.current, baseY);
        }

        if (manholeAnswer) {
          for (const loc of manholeAnswer.needed_locations ?? []) {
            const [x, z] = projector.toLocal(loc.lon, loc.lat);
            const ground = elevAt(loc.lon, loc.lat);
            const baseY = ground - MANHOLE_TOTAL_H;
            const mesh = buildManholeMarker(x, baseY, z, PROPOSED_MANHOLE_COLOR, "proposed-manhole", loc.id, MANHOLE_TOTAL_H);
            mesh.userData = {
              kind: "proposed-manhole",
              id: loc.id,
              label: loc.id,
              category: "Proposed manhole (AI-suggested)",
              color: "#22c55e",
              attributes: { Reason: loc.reason },
              lon: loc.lon,
              lat: loc.lat,
            } satisfies Object3DDetail;
            ensureGroup("proposed-manholes").add(mesh);
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
              label: `${route.from_id} → ${route.to_id ?? "—"}`,
              category: "Pipe connection (AI-suggested)",
              color: "#3aa1ff",
              attributes: {
                From: route.from_id,
                To: route.to_id ?? "—",
                Material: route.pipe_spec.material,
                "Diameter (mm)": route.pipe_spec.diameter_mm.toFixed(0),
                "Depth below ground (m)": depthM.toFixed(1),
                Flow: route.flow_confirmed ? "confirmed" : "drawn",
                ...(route.route_basis ? { Basis: route.route_basis } : {}),
              },
              lon: route.coordinates[0][0],
              lat: route.coordinates[0][1],
            } satisfies Object3DDetail;
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
          // This drain's OWN raw category color (e.g. "Closed Drain" vs "Open
          // Drain" can be different raw categories under one canonical class)
          // — matches whatever the 2D Map Canvas Layers panel shows for it.
          const drainColor = new THREE.Color(sceneColor(d.properties.category));
          for (const line of lines) {
            if (line.length < 2) continue;
            const ys = line.map(([lon, lat]) => elevAt(lon, lat) - 2.2);
            const pts = line.map(([lon, lat], i) => {
              const [x, z] = projector.toLocal(lon, lat);
              return new THREE.Vector3(x, ys[i], z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), dR, 8, false);
            const mat = new THREE.MeshStandardMaterial({ color: drainColor, roughness: 0.5, metalness: 0.2 });
            const mesh = new THREE.Mesh(geo, mat);
            const [firstLon, firstLat] = line[0];
            const detail = featureDetail(d, "drain", sceneColor(d.properties.category), firstLon, firstLat);
            mesh.userData = {
              ...detail,
              attributes: {
                ...detail.attributes,
                ...(readAttr(attrs, "diameter") ? { "Diameter (mm)": readAttr(attrs, "diameter")!.toFixed(0) } : {}),
              },
            };
            gfor(d).add(mesh);
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

        // A clearly-lit lamp: bright emissive globe plus a soft additive halo
        // so the fixture reads as "on" in the 3D scene without spawning dozens
        // of real (and expensive) PointLights.
        const addGlowLamp = (parent: THREE.Group, x: number, y: number, z: number, radius: number) => {
          const lamp = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 12, 12),
            new THREE.MeshStandardMaterial({
              color: LAMP_GLASS_COLOR,
              emissive: LAMP_GLASS_COLOR,
              emissiveIntensity: 1.8,
              roughness: 0.25,
            })
          );
          lamp.position.set(x, y, z);
          parent.add(lamp);
          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(radius * 2.6, 12, 12),
            new THREE.MeshBasicMaterial({
              color: LAMP_GLASS_COLOR,
              transparent: true,
              opacity: 0.32,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            })
          );
          halo.position.set(x, y, z);
          parent.add(halo);
        };

        // Every real pole's exact (x, z) and top height, recorded as each one
        // is built — used below to snap overhead power-line vertices exactly
        // onto the pole tops instead of floating past them at a flat height
        // (the line geometry and the pole points are two separately-surveyed
        // layers, so their coordinates don't line up on their own).
        const polePositions: { x: number; z: number; topY: number }[] = [];
        const powerPolePositions: { x: number; z: number; topY: number }[] = [];

        // Precompute road sample points (local coords) so each lamp-bearing pole
        // can aim its arm + lamp at the carriageway instead of the building side.
        const roadPts: [number, number][] = [];
        for (const f of features) {
          if (classMap[f.properties.category ?? ""] !== "Road_Segment") continue;
          const g = f.geometry;
          const push = (lon: number, lat: number) => {
            const [X, Z] = projector.toLocal(lon, lat);
            roadPts.push([X, Z]);
          };
          if (g.type === "LineString") (g.coordinates as [number, number][]).forEach((c) => push(c[0], c[1]));
          else if (g.type === "MultiLineString")
            (g.coordinates as [number, number][][]).forEach((l) => l.forEach((c) => push(c[0], c[1])));
          else if (g.type === "Point") push((g.coordinates as [number, number])[0], (g.coordinates as [number, number])[1]);
        }
        const angleToRoad = (x: number, z: number): number | null => {
          let best = Infinity, bx = 0, bz = 0;
          for (const [rx, rz] of roadPts) {
            const d = (rx - x) * (rx - x) + (rz - z) * (rz - z);
            if (d < best) { best = d; bx = rx; bz = rz; }
          }
          if (best === Infinity || (bx === x && bz === z)) return null;
          // Aim the local +X arm toward the nearest road point.
          return Math.atan2(-(bz - z), bx - x);
        };

        const buildPoleMarker = (
          p: UrbanFeature,
          group: THREE.Group,
          kind: "light-pole" | "solar-pole" | "power-pole" | "power-light-pole",
          categoryLabel: string
        ) => {
          if (p.geometry.type !== "Point") return;
          const [lon, lat] = p.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          const attrs = p.properties.attributes ?? {};
          // Real pole height when surveyed, else a typical 7 m street pole.
          const poleH = readAttr(attrs, "height") ?? readAttr(attrs, "pole_height") ?? readAttr(attrs, "elevation") ?? 7;
          polePositions.push({ x, z, topY: ground + poleH });
          // Power poles (bare or with a light) are the supports an overhead
          // power line actually hangs from — keep a separate list so the
          // conductor only snaps onto real power poles, not streetlights/solar.
          if (kind === "power-pole") powerPolePositions.push({ x, z, topY: ground + poleH });
          const g = new THREE.Group();
          // A power pole with a light fixture is still fundamentally a power
          // pole (wooden, carries a crossarm) — not a steel streetlight mast.
          const isWoodPole = kind === "power-pole" || kind === "power-light-pole";
          const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(isWoodPole ? 0.15 : 0.11, isWoodPole ? 0.2 : 0.14, poleH, 10),
            new THREE.MeshStandardMaterial({
              color: isWoodPole ? WOOD_MAST_COLOR : STEEL_MAST_COLOR,
              roughness: isWoodPole ? 0.9 : 0.5,
              metalness: isWoodPole ? 0 : 0.5,
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

            addGlowLamp(g, 0.75, ground + poleH - 0.48, 0, 0.18);

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
            // Power/utility pole: a wooden crossarm carrying ceramic
            // insulators — the real silhouette of a distribution pole, easy
            // to tell apart from a streetlight at a glance.
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

            if (kind === "power-light-pole") {
              // A real "power pole with light" combo fixture: a short
              // bracket above the crossarm carrying a small streetlamp —
              // still a wooden power pole, but also doing streetlight duty.
              const bracket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.05, 0.5, 6),
                new THREE.MeshStandardMaterial({ color: WOOD_MAST_COLOR, roughness: 0.7 })
              );
              bracket.rotation.z = Math.PI / 2.5;
              bracket.position.set(0.22, ground + poleH + 0.08, 0);
              g.add(bracket);
              addGlowLamp(g, 0.45, ground + poleH + 0.15, 0, 0.2);
            }
          }

          g.position.set(x, 0, z);
          // Aim the lamp arm at the nearest road so the light falls on the
          // carriageway, not the building side.
          const ang = angleToRoad(x, z);
          if (ang != null) g.rotation.y = ang;
          {
            const detail = featureDetail(p, kind, sceneColor(p.properties.category), lon, lat);
            g.userData = {
              ...detail,
              attributes: { ...detail.attributes, "Detected as": categoryLabel, "Pole height (m)": poleH.toFixed(1) },
            };
          }
          group.add(g);
          clickable.push(g);
        };

        const illuminationPoles = features.filter((f) => classMap[f.properties.category ?? ""] === "Illumination_Asset");
        for (const p of illuminationPoles) {
          const subtype = classifyIlluminationSubtype(p.properties.category);
          if (subtype === "solar") {
            buildPoleMarker(p, gfor(p), "solar-pole", "Illumination_Asset (solar)");
          } else if (subtype === "power-light") {
            // "Power Pole With Light" — a real power pole (crossarm,
            // insulators) that also carries a light fixture, its own
            // distinct 4th pole type, not collapsed into light or power.
            buildPoleMarker(p, gfor(p), "power-light-pole", "Illumination_Asset (power pole with light)");
          } else if (subtype === "power") {
            // Bare "Power Pole" text under the Illumination_Asset class —
            // no light fixture, same crossarm marker as a Utility_Pole below.
            buildPoleMarker(p, gfor(p), "power-pole", "Illumination_Asset (power pole)");
          } else {
            buildPoleMarker(p, gfor(p), "light-pole", "Illumination_Asset (light)");
          }
        }

        // Bare power poles (Utility_Pole) that are standalone survey points
        // (not just support masts along an overhead line — those stay in
        // the power-lines rendering below) get their own "power pole" marker.
        const standalonePowerPoles = features.filter(
          (f) => classMap[f.properties.category ?? ""] === "Utility_Pole" && f.geometry.type === "Point"
        );
        for (const p of standalonePowerPoles) {
          buildPoleMarker(p, gfor(p), "power-pole", "Utility_Pole");
        }

        // Real surveyed concrete roads (Road_Segment centerlines) drawn as a
        // flat ribbon just above the terrain, in the map's road color.
        const roads = features.filter((f) => classMap[f.properties.category ?? ""] === "Road_Segment");
        for (const r of roads) {
          // This feature's OWN raw category color ("Concrete Road" vs
          // "Sewage Line" vs "Road_Centerline" are different raw categories
          // sharing one canonical class) — matches the 2D Layers panel.
          const segColor = new THREE.Color(sceneColor(r.properties.category));
          const raw = (r.properties.category ?? "").toLowerCase();
          // A "sewage"/"pipe"/"drain" segment is an underground utility, not a
          // carriageway — render it as a draped pipe following the terrain
          // relief rather than flattening it into a road ribbon.
          const isPipe =
            raw.includes("sewage") || raw.includes("sewer") || raw.includes("pipe") ||
            raw.includes("drain") || raw.includes("culvert");
          const geom = r.geometry;
          const lines: [number, number][][] =
            geom.type === "LineString"
              ? [geom.coordinates]
              : geom.type === "MultiLineString"
              ? (geom.coordinates as [number, number][][])
              : [];
          for (const rawLine of lines) {
            if (rawLine.length < 2) continue;
            // Resample every ~3 m along the real line so the ribbon's
            // elevation follows the actual terrain relief continuously, not
            // just at the (possibly tens-of-metres-apart) original survey
            // vertices — otherwise it can dip below a rise in the terrain
            // that happens to fall between two of them.
            const line = densifyLine(rawLine, projector, 3);
            const pts = line.map(([lon, lat]) => {
              const [x, z] = projector.toLocal(lon, lat);
              // Sewage / pipe segments are buried utilities — sit them below
              // the terrain surface (deeper than power/water) so they show
              // through the transparent DTM as underground infrastructure.
              // Road ribbons are flattened via geo.scale(1, 0.12, 1) below —
              // radius 1.6 * 0.12 = 0.192 m half-thickness, so a +0.15 m lift
              // left the ribbon's underside ~0.04 m BELOW the terrain (the
              // "road sinks into the ground" bug). 0.4 m clears it with margin.
              return new THREE.Vector3(x, elevAt(lon, lat) + (isPipe ? -3.2 : 0.4), z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const [firstLon, firstLat] = line[0];
            if (isPipe) {
              const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.5, 10, false);
              const mat = new THREE.MeshStandardMaterial({ color: segColor, roughness: 0.5, metalness: 0.2 });
              const mesh = new THREE.Mesh(geo, mat);
              mesh.userData = featureDetail(r, "pipe", sceneColor(r.properties.category), firstLon, firstLat);
              gfor(r).add(mesh);
              clickable.push(mesh);
            } else {
              const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 1.6, 6, false);
              // Flatten the tube into a road ribbon by scaling Y.
              geo.scale(1, 0.12, 1);
              const mat = new THREE.MeshStandardMaterial({ color: segColor, roughness: 0.95 });
              const mesh = new THREE.Mesh(geo, mat);
              mesh.userData = featureDetail(r, "road", sceneColor(r.properties.category), firstLon, firstLat);
              gfor(r).add(mesh);
              clickable.push(mesh);
            }
          }
        }

        // Real surveyed power lines (Power_Line). The canonical class also
        // absorbs "Water Line" and "Electric Line", so we branch on the RAW
        // category — three genuinely different real-world things:
        //   • water line    → a buried blue pipe following the terrain
        //   • electric line → a buried service cable (underground wiring),
        //     NOT an overhead conductor
        //   • power line    → the actual OVERHEAD conductor that runs pole to
        //     pole. Its vertices are snapped onto the nearest real pole's
        //     exact top when one is close by, so the wire visibly lands on
        //     the poles instead of floating past them at a flat height (the
        //     line and the pole points are two separately-surveyed layers,
        //     so their raw coordinates never line up exactly on their own).
        const powerLines = features.filter((f) => classMap[f.properties.category ?? ""] === "Power_Line");
        const OVERHEAD_LINE_H = 8; // typical conductor height above ground when not on a pole
        // Closest point on segment a->b to point p (local x/z); returns the
        // fractional position t along the segment and the perpendicular distance.
        const segClosest = (
          p: { x: number; z: number },
          a: { x: number; z: number },
          b: { x: number; z: number }
        ): { t: number; dist: number } => {
          const vx = b.x - a.x, vz = b.z - a.z;
          const len2 = vx * vx + vz * vz;
          let t = len2 > 0 ? ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = a.x + vx * t, cz = a.z + vz * t;
          return { t, dist: Math.hypot(cx - p.x, cz - p.z) };
        };
        // Nearest power-pole top height for a point — used so the conductor rides
        // at the actual pole-top level between supports instead of floating a
        // fixed amount above them.
        const nearestPowerPoleTopY = (x: number, z: number): number => {
          let best = Infinity, bestY = 0;
          for (const p of powerPolePositions) {
            const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
            if (d < best) { best = d; bestY = p.topY; }
          }
          return bestY;
        };
        const buildBuriedLine = (
          pl: UrbanFeature,
          line: [number, number][],
          depth: number,
          radius: number,
          color: number | string,
          opacity: number,
          kind: string
        ) => {
          const pts = line.map(([lon, lat]) => {
            const [x, z] = projector.toLocal(lon, lat);
            return new THREE.Vector3(x, elevAt(lon, lat) - depth, z);
          });
          const curve = new THREE.CatmullRomCurve3(pts);
          const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), radius, 12, false);
          const mat = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.3,
            metalness: 0.1,
            transparent: opacity < 1,
            opacity,
          });
          const mesh = new THREE.Mesh(geo, mat);
          const [firstLon, firstLat] = line[0];
          const colorStr = typeof color === "string" ? color : `#${color.toString(16).padStart(6, "0")}`;
          mesh.userData = featureDetail(pl, kind, colorStr, firstLon, firstLat);
          gfor(pl).add(mesh);
          clickable.push(mesh);
        };
        for (const pl of powerLines) {
          const raw = (pl.properties.category ?? "").toLowerCase();
          const isWater = raw.includes("water");
          const isElectric = !isWater && raw.includes("electric");
          // This feature's OWN raw category color ("Water Line" / "Electric
          // Line" / "Power Line" are different raw categories sharing one
          // canonical class) — matches the 2D Layers panel exactly.
          const lineColor = sceneColor(pl.properties.category);
          const geom = pl.geometry;
          const lines: [number, number][][] =
            geom.type === "LineString"
              ? [geom.coordinates]
              : geom.type === "MultiLineString"
              ? (geom.coordinates as [number, number][][])
              : [];
          for (const line of lines) {
            if (line.length < 2) continue;
            if (isWater) {
              // Buried water main: translucent pipe following the terrain.
              buildBuriedLine(pl, line, 2.5, 0.55, lineColor, 0.85, "waterline");
            } else if (isElectric) {
              // Buried electric service cable — underground wiring, not an
              // overhead line.
              buildBuriedLine(pl, line, 2.0, 0.3, lineColor, 1, "electricline");
            } else {
              // Power line: a real OVERHEAD 3-phase conductor hanging from the
              // power poles. The poles are a separately-surveyed layer that lies
              // ON the line but not on its vertices, so we INSERT a pole-top
              // vertex wherever a power pole sits on a segment — the conductor
              // then visibly lands on every pole instead of floating past them.
              const POLE_SNAP_TOL = 4; // metres from the line to count as a support
              const vlocal = line.map(([lon, lat]) => {
                const [x, z] = projector.toLocal(lon, lat);
                const y = powerPolePositions.length
                  ? nearestPowerPoleTopY(x, z)
                  : elevAt(lon, lat) + OVERHEAD_LINE_H;
                return { x, z, y };
              });
              const out: { x: number; z: number; y: number }[] = [];
              for (let i = 0; i < vlocal.length; i++) {
                out.push(vlocal[i]);
                if (i < vlocal.length - 1) {
                  const a = vlocal[i], b = vlocal[i + 1];
                  for (const p of powerPolePositions) {
                    const c = segClosest(p, a, b);
                    if (c.t > 0.02 && c.t < 0.98 && c.dist <= POLE_SNAP_TOL) {
                      out.push({ x: p.x, z: p.z, y: p.topY });
                    }
                  }
                }
              }
              const pts = out.map((o) => new THREE.Vector3(o.x, o.y, o.z));
              const mat = new THREE.MeshStandardMaterial({ color: lineColor, roughness: 0.5, metalness: 0.4 });
              const [firstLon, firstLat] = line[0];
              const wireDetail = featureDetail(pl, "powerline", lineColor, firstLon, firstLat);
              for (const off of [-0.55, 0, 0.55]) {
                const cpts = pts.map((p, i) => {
                  const prev = pts[Math.max(0, i - 1)];
                  const next = pts[Math.min(pts.length - 1, i + 1)];
                  const t = new THREE.Vector3().subVectors(next, prev);
                  if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
                  const perp = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(off);
                  return new THREE.Vector3(p.x + perp.x, p.y, p.z + perp.z);
                });
                const geo = new THREE.TubeGeometry(
                  new THREE.CatmullRomCurve3(cpts),
                  Math.max(2, cpts.length * 3),
                  0.16,
                  6,
                  false
                );
                const mesh = new THREE.Mesh(geo, mat);
                mesh.userData = wireDetail;
                gfor(pl).add(mesh);
                clickable.push(mesh);
              }
            }
          }
        }

        // Real surveyed vegetation (trees) — a realistic coconut-style tree at
        // each surveyed point: a tall slender trunk with a crown of drooping
        // fronds, tinted with the same category color used on the 2D map.
        // Heights vary a little so the grove looks natural rather than cloned.
        const vegetation = features.filter((f) => classMap[f.properties.category ?? ""] === "Vegetation");
        // Built once and reused (scaled) for every frond on every tree.
        const frondGeo = buildFrondGeometry(4.2, 0.6, 1.6);
        for (const v of vegetation) {
          const geom = v.geometry;
          const pt =
            geom.type === "Point"
              ? geom.coordinates
              : geom.type === "Polygon"
              ? geom.coordinates[0][0]
              : null;
          if (!pt) continue;
          const [lon, lat] = pt;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          // This tree's OWN raw category color — matches the 2D Layers panel.
          // DoubleSide because each frond is a flat blade — a plane is
          // invisible from behind without it.
          const frondMat = new THREE.MeshStandardMaterial({
            color: sceneColor(v.properties.category),
            roughness: 0.8,
            side: THREE.DoubleSide,
          });
          const g = new THREE.Group();
          const seed = Math.abs(Number(v.properties.id) || 0) % 6;
          const h = 11 + seed; // 11–16 m coconut palm
          const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.3, h, 8),
            new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 })
          );
          trunk.position.y = ground + h / 2;
          g.add(trunk);
          // A real coconut palm has NO round crown ball — just a small growing
          // bud where a starburst of long arching fronds emerges, plus a
          // cluster of coconuts underneath it. The earlier sphere "crown" was
          // what made trees read as a spiky pom-pom/sea urchin instead of a
          // tree; removed in favour of just the bud + fronds.
          const crownY = ground + h;
          const bud = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 8, 8),
            new THREE.MeshStandardMaterial({ color: 0x5b3a1f, roughness: 0.9 })
          );
          bud.position.y = crownY;
          g.add(bud);
          const coconutMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.85 });
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + seed;
            const coconut = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), coconutMat);
            coconut.position.set(Math.cos(a) * 0.4, crownY - 0.35, Math.sin(a) * 0.4);
            g.add(coconut);
          }
          // Each frond is a flattened cone (elliptical cross-section, not
          // round) so it reads as a blade rather than a spike, with a
          // slightly different length/droop per frond so the crown looks
          // like a natural cluster instead of a perfectly uniform wheel.
          const frondCount = 12;
          for (let i = 0; i < frondCount; i++) {
            const aAngle = (i / frondCount) * Math.PI * 2;
            const lenScale = 0.85 + ((i % 4) * 0.08); // slight variety so the crown isn't a perfectly uniform wheel
            const frond = new THREE.Mesh(frondGeo, frondMat);
            frond.scale.setScalar(lenScale);
            frond.position.set(0, crownY, 0);
            frond.rotation.y = -aAngle; // the geometry's own baked droop/taper does the rest
            g.add(frond);
          }
          g.position.set(x, 0, z);
          g.userData = featureDetail(v, "vegetation", sceneColor(v.properties.category), lon, lat);
          gfor(v).add(g);
          clickable.push(g);
        }

        // Real surveyed signage (road signs, markers) — a thin post with a
        // small flat board, colored with the map's category color.
        const signage = features.filter((f) => classMap[f.properties.category ?? ""] === "Signage");
        for (const s of signage) {
          if (s.geometry.type !== "Point") continue;
          const [lon, lat] = s.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          // This sign's OWN raw category color — matches the 2D Layers panel.
          const signColor = new THREE.Color(sceneColor(s.properties.category));
          const g = new THREE.Group();
          const post = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6),
            new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.4 })
          );
          post.position.y = ground + 0.9;
          g.add(post);
          const board = new THREE.Mesh(
            new THREE.BoxGeometry(0.55, 0.4, 0.04),
            new THREE.MeshStandardMaterial({ color: signColor, roughness: 0.5, metalness: 0.2 })
          );
          board.position.y = ground + 1.75;
          g.add(board);
          g.position.set(x, 0, z);
          g.userData = featureDetail(s, "signage", sceneColor(s.properties.category), lon, lat);
          gfor(s).add(g);
          clickable.push(g);
        }

        // Real surveyed elevation contour lines, draped directly on the
        // terrain surface (no lift) as thin ribbons in the map's category color.
        const contours = features.filter((f) => classMap[f.properties.category ?? ""] === "Elevation_Contour");
        for (const c of contours) {
          // This contour's OWN raw category color — matches the 2D Layers panel.
          const contourColor = new THREE.Color(sceneColor(c.properties.category));
          const geom = c.geometry;
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
              // Tube radius is 0.08 m below, so a 0.05 m lift left the
              // underside ~0.03 m under the terrain — bump to 0.15 m to clear.
              return new THREE.Vector3(x, elevAt(lon, lat) + 0.15, z);
            });
            const curve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curve, Math.max(2, pts.length * 3), 0.08, 6, false);
            const mat = new THREE.MeshStandardMaterial({ color: contourColor, roughness: 0.7 });
            const mesh = new THREE.Mesh(geo, mat);
            const [firstLon, firstLat] = line[0];
            mesh.userData = featureDetail(c, "contour", sceneColor(c.properties.category), firstLon, firstLat);
            gfor(c).add(mesh);
            clickable.push(mesh);
          }
        }

        // Real surveyed drain/manhole level-reading points (invert/top
        // level, pipe type, condition) — a small flat disc marker at each
        // surveyed point, distinct from the Access_Point/Drainage_Asset
        // geometry it was measured at.
        const levelPoints = features.filter((f) => classMap[f.properties.category ?? ""] === "Drainage_Level_Point");
        for (const lp of levelPoints) {
          if (lp.geometry.type !== "Point") continue;
          const [lon, lat] = lp.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          // This point's OWN raw category color — matches the 2D Layers panel.
          const levelColor = new THREE.Color(sceneColor(lp.properties.category));
          const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.3, 0.12, 12),
            new THREE.MeshStandardMaterial({ color: levelColor, roughness: 0.5, metalness: 0.3 })
          );
          mesh.position.set(x, ground + 0.3, z);
          mesh.userData = featureDetail(lp, "levelpoint", sceneColor(lp.properties.category), lon, lat);
          gfor(lp).add(mesh);
          clickable.push(mesh);
        }

        // ---- Generic catch-all: every category present in the data that has
        // no bespoke 3D builder (i.e. not one of the canonical classes handled
        // above) is still drawn, grouped under its own raw-category chip, so
        // the 3D view shows the SAME set of layers the 2D Map Canvas Layers
        // panel shows — no surveyed GDP category is ever silently dropped.
        for (const f of features) {
          const raw = (f.properties.category ?? "").trim() || "uncategorized";
          if (raw === "raster_pixel") continue;
          const canonical = classMap[raw];
          if (canonical && HANDLED_CANONICAL.has(canonical)) continue; // handled above
          const key = `cat:${raw}`;
          if (!groups[key]) {
            const g = new THREE.Group();
            g.name = `group-${key}`;
            groups[key] = g;
            scene.add(g);
            groupRefs.current[key] = g;
          }
          const color = sceneColor(raw);
          const obj = buildGenericFeature(f, projector, elevAt, color);
          if (obj) {
            const fg = f.geometry;
            let flon: number, flat: number;
            if (fg.type === "Point") [flon, flat] = fg.coordinates;
            else if (fg.type === "LineString") [flon, flat] = fg.coordinates[0];
            else if (fg.type === "MultiLineString") [flon, flat] = fg.coordinates[0][0];
            else if (fg.type === "Polygon") [flon, flat] = fg.coordinates[0][0];
            else if (fg.type === "MultiPolygon") [flon, flat] = fg.coordinates[0][0][0];
            else [flon, flat] = fg.coordinates[0];
            obj.userData = featureDetail(f, raw, color, flon, flat);
            groups[key].add(obj);
            clickable.push(obj);
          }
        }

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        // Exactly the set of objects actually registered as selectable —
        // used below so a click always resolves to the SAME object that
        // carries the rich detail (see featureDetail), not some inner child.
        const clickableSet = new Set(clickable);
        // Walk up from the hit child mesh to the nearest ancestor that is
        // itself a registered clickable object. Some composite builders (the
        // generic "manhole"-keyword fallback wraps a buildManholeMarker
        // sub-group, which carries its OWN bare {kind, id} userData) have an
        // inner object with a truthy userData.kind that isn't the one with
        // the real category/color/attributes — stopping at "first kind
        // found" would resolve to that bare inner object instead of the rich
        // outer one. Stopping at clickable-membership instead guarantees we
        // always land on the one object every builder actually attaches full
        // detail to.
        const resolveHit = (hits: THREE.Intersection[]): (Object3DDetail & { object: THREE.Object3D }) | null => {
          if (hits.length === 0) return null;
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && !clickableSet.has(obj)) obj = obj.parent;
          if (!obj) return null;
          const u = obj.userData as Partial<Object3DDetail>;
          // No real category/label on this object — rather than pop up a
          // near-empty panel, treat it as "nothing selectable was hit".
          if (!u.category) return null;
          return { ...(u as Object3DDetail), object: obj };
        };
        // A real click (pointerdown+up within a few pixels — NOT a
        // drag-to-orbit/pan gesture) selects the object under the cursor: its
        // own materials get a bright emissive glow, and its details show in
        // the fixed detail panel. Clicking empty space clears the selection.
        let downX = 0, downY = 0;
        const handlePointerDown = (e: PointerEvent) => {
          downX = e.clientX;
          downY = e.clientY;
        };
        // Tints every mesh inside the selected object with a bright emissive
        // glow so the selection is unmistakable at typical zoomed-out scene
        // scale. Returns a function that restores each mesh's original
        // emissive color/intensity exactly.
        const applyHighlightTint = (object: THREE.Object3D): (() => void) => {
          const restores: (() => void)[] = [];
          object.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of materials) {
              const std = m as THREE.MeshStandardMaterial;
              if (!std || !("emissive" in std)) continue;
              const prevEmissive = std.emissive.clone();
              const prevIntensity = std.emissiveIntensity;
              std.emissive.set(0x22d3ee);
              std.emissiveIntensity = Math.max(prevIntensity, 0.55);
              restores.push(() => {
                std.emissive.copy(prevEmissive);
                std.emissiveIntensity = prevIntensity;
              });
            }
          });
          return () => restores.forEach((r) => r());
        };
        const handlePointerUp = (e: PointerEvent) => {
          const dx = e.clientX - downX, dy = e.clientY - downY;
          if (dx * dx + dy * dy > 25) return; // moved >5px — an orbit/pan drag, not a click
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = resolveHit(raycaster.intersectObjects(clickable, true));
          tintRestoreRef.current?.();
          tintRestoreRef.current = null;
          if (!hit) {
            setSelected(null);
            return;
          }
          tintRestoreRef.current = applyHighlightTint(hit.object);
          const { object: _obj, ...detail } = hit;
          setSelected(detail);
        };
        renderer.domElement.addEventListener("pointerdown", handlePointerDown);
        renderer.domElement.addEventListener("pointerup", handlePointerUp);
        cleanupFns.push(() => {
          renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
          renderer.domElement.removeEventListener("pointerup", handlePointerUp);
        });

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
      sceneRef.current = null;
      tintRestoreRef.current = null;
    };
    // colorMode is intentionally the only extra dependency here — every
    // color in the scene is baked into materials at build time, so toggling
    // Default/Real-world rebuilds the whole scene from scratch to repaint it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode]);

  // Live category visibility — toggle each group's shown state with no scene
  // rebuild. Terrain + buildings are the "surface" that the Underground view
  // fades to a translucent shell so the network reads as the subject.
  useEffect(() => {
    Object.entries(groupRefs.current).forEach(([k, g]) => {
      if (g) g.visible = visible[k] !== false;
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

  const displayedLayers = (() => {
    const q = layerQuery.trim().toLowerCase();
    return q ? categoryList.filter((c) => c.category.toLowerCase().includes(q)) : categoryList;
  })();

  return (
    <div className="manhole-3d-overlay" data-testid="manhole-plan-3d">
      <header className="manhole-3d-overlay__head">
        <div>
          <h3>3D Map View</h3>
          <span className="manhole-3d-overlay__hint">
            {terrainAvailable ? "Real DTM terrain + DSM building heights" : "No DTM/DSM dataset selected — flat reference ground shown"}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="manhole-3d-overlay__body">
      <div className="manhole-3d-overlay__panel">
        <div className="manhole-3d-overlay__colormode" role="radiogroup" aria-label="Color mode">
          <button
            type="button"
            role="radio"
            aria-checked={colorMode === "default"}
            className={`manhole-3d-overlay__colormode-btn${colorMode === "default" ? " is-active" : ""}`}
            onClick={() => setColorMode("default")}
          >
            Default color
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={colorMode === "realworld"}
            className={`manhole-3d-overlay__colormode-btn${colorMode === "realworld" ? " is-active" : ""}`}
            onClick={() => setColorMode("realworld")}
          >
            Real world color
          </button>
        </div>
        <div className="command-center__section">
          <div className="command-center__section-head">
            <span className="command-center__section-title">Layers</span>
            <button
              type="button"
              className="command-center__text-btn"
              onClick={() => {
                const allOn =
                  visible.terrain !== false &&
                  categoryList.every((c) => visible[`cat:${c.category}`] !== false) &&
                  ((manholeAnswer?.routes?.length ?? 0) === 0 || visible.pipes !== false);
                setVisible((v) => {
                  const next = { ...v };
                  next.terrain = !allOn;
                  for (const c of categoryList) next[`cat:${c.category}`] = !allOn;
                  if ((manholeAnswer?.routes?.length ?? 0) > 0) next.pipes = !allOn;
                  return next;
                });
              }}
            >
              {categoryList.every((c) => visible[`cat:${c.category}`] !== false) && visible.terrain !== false ? "Hide all" : "Show all"}
            </button>
          </div>
          <div className="layer-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
            <input
              type="search"
              value={layerQuery}
              onChange={(e) => setLayerQuery(e.target.value)}
              placeholder="Search layers..."
              aria-label="Search layers"
            />
            {layerQuery && (
              <button type="button" className="layer-search__clear" onClick={() => setLayerQuery("")} aria-label="Clear layer search">×</button>
            )}
          </div>
          <div className="layer-list">
            <div
              className={`layer-row${visible.terrain !== false ? "" : " layer-row--hidden"}`}
              onClick={() => setVisible((v) => ({ ...v, terrain: v.terrain === false ? true : false }))}
            >
              <div className={`layer-row__checkbox${visible.terrain !== false ? " layer-row__checkbox--checked" : ""}`}>
                <svg className="layer-row__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <span className="layer-row__swatch" style={{ background: "#cbb894" }} />
              <span className="layer-row__name">Terrain</span>
              <span className="layer-row__count" />
            </div>
            {displayedLayers.map((c) => {
              const key = `cat:${c.category}`;
              const on = visible[key] !== false;
              return (
                <div
                  key={c.category}
                  className={`layer-row${on ? "" : " layer-row--hidden"}`}
                  onClick={() => setVisible((v) => ({ ...v, [key]: v[key] === false ? true : false }))}
                >
                  <div className={`layer-row__checkbox${on ? " layer-row__checkbox--checked" : ""}`}>
                    <svg className="layer-row__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <span className="layer-row__swatch" style={{ background: c.color }} />
                  <span className="layer-row__name">{c.category}</span>
                  <span className="layer-row__count">{c.count}</span>
                </div>
              );
            })}
            {(manholeAnswer?.routes?.length ?? 0) > 0 && (() => {
              const on = visible.pipes !== false;
              return (
                <div
                  className={`layer-row${on ? "" : " layer-row--hidden"}`}
                  onClick={() => setVisible((v) => ({ ...v, pipes: v.pipes === false ? true : false }))}
                >
                  <div className={`layer-row__checkbox${on ? " layer-row__checkbox--checked" : ""}`}>
                    <svg className="layer-row__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <span className="layer-row__swatch" style={{ background: "#3aa1ff" }} />
                  <span className="layer-row__name">Pipes (AI suggested)</span>
                  <span className="layer-row__count" />
                </div>
              );
            })()}
            {displayedLayers.length === 0 && <div className="layer-list__empty">No matching layers</div>}
          </div>
        </div>
        <button
          type="button"
          className={`btn${underground ? " btn--active" : ""}`}
          onClick={() => setUnderground((v) => !v)}
          aria-pressed={underground}
        >
          {underground ? "Surface view" : "Underground view"}
        </button>
      </div>
      <div className="manhole-3d-overlay__canvas-wrap">
        {loading && <div className="manhole-3d-overlay__status">Building 3D scene from real survey + terrain data…</div>}
        {error && <div className="manhole-3d-overlay__status manhole-3d-overlay__status--error">{error}</div>}
        <div ref={containerRef} className="manhole-3d-overlay__canvas" />
        {selected && (() => {
          // Same filtering the 2D Map Canvas's own HoverTooltip applies —
          // internal/blank fields never shown, so this panel gives exactly
          // the same information the 2D map already gives on hover.
          const attrEntries = Object.entries(selected.attributes ?? {}).filter(([k, v]) => {
            if (k === "gdb_layer" || k.startsWith("_")) return false;
            if (v === null || v === undefined) return false;
            if (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "nan")) return false;
            return true;
          });
          const formatVal = (v: unknown): string => {
            if (v === null || v === undefined || v === "") return "-";
            if (typeof v === "object") return JSON.stringify(v);
            return String(v);
          };
          return (
            <div className="manhole-3d-overlay__detail">
              <div className="manhole-3d-overlay__detail-head">
                <span className="manhole-3d-overlay__detail-swatch" style={{ background: selected.color }} />
                <span className="manhole-3d-overlay__detail-title">{selected.label}</span>
                <button type="button" onClick={clearSelection} aria-label="Close details">×</button>
              </div>
              <div className="manhole-3d-overlay__detail-body">
                <div className="manhole-3d-overlay__detail-category">
                  {selected.category}
                  {typeof selected.severity === "number" && (
                    <span className="manhole-3d-overlay__detail-sev">sev {selected.severity.toFixed(2)}</span>
                  )}
                </div>
                {selected.lat !== undefined && selected.lon !== undefined && (
                  <div className="manhole-3d-overlay__detail-latlng">
                    Lat {selected.lat.toFixed(6)}, Lng {selected.lon.toFixed(6)}
                  </div>
                )}
                {attrEntries.length > 0 && (
                  <div className="manhole-3d-overlay__detail-attrs">
                    {attrEntries.map(([k, v]) => (
                      <div className="manhole-3d-overlay__detail-attr-row" key={k}>
                        <span className="manhole-3d-overlay__detail-attr-key">{k}</span>
                        <span className="manhole-3d-overlay__detail-attr-val">{formatVal(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
      </div>
    </div>
  );
}
