import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { UrbanFeature } from "../lib/types";
import type { DatasetRow, SpatialAnomaly } from "../lib/workflow";
import type { AiAnswer } from "../lib/ai";
import { fetchDemGrid, fetchBuildingHeights, type DemGrid } from "../lib/dem";

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
const MANHOLE_DEFAULT_DEPTH_M = 2;
const PIPE_RADIUS_M = 0.35;

const ANOMALY_COLOR: Record<string, number> = {
  red: 0xdc2626,
  yellow: 0xeab308,
  green: 0x16a34a,
};
const NEUTRAL_MANHOLE_COLOR = 0x94a3b8;
const PROPOSED_MANHOLE_COLOR = 0x22c55e;
const PIPE_ROUTE_COLOR = 0x3aa1ff;

interface Projector {
  toLocal: (lon: number, lat: number) => [number, number]; // -> [x, z] metres
}

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
  return mesh;
}

function buildBuildingMesh(
  ring: [number, number][],
  baseY: number,
  heightM: number,
  projector: Projector,
  estimated: boolean
): THREE.Mesh | null {
  if (ring.length < 3) return null;
  const shape = new THREE.Shape();
  ring.forEach(([lon, lat], idx) => {
    const [x, z] = projector.toLocal(lon, lat);
    if (idx === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  });
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false });
  // ExtrudeGeometry extrudes along +Z in shape-local space; rotate so that
  // becomes world +Y (up), then lift to sit on the real terrain elevation.
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: estimated ? 0x8899aa : 0x6b8caf,
    transparent: estimated,
    opacity: estimated ? 0.6 : 0.9,
    roughness: 0.8,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = baseY;
  mesh.userData.kind = "building";
  return mesh;
}

function buildPipeTube(coords: [number, number][], yStart: number, yEnd: number, projector: Projector): THREE.Mesh {
  const points = coords.map(([lon, lat], idx) => {
    const [x, z] = projector.toLocal(lon, lat);
    const t = coords.length > 1 ? idx / (coords.length - 1) : 0;
    const y = yStart + (yEnd - yStart) * t;
    return new THREE.Vector3(x, y, z);
  });
  const curve = new THREE.CatmullRomCurve3(points.length > 1 ? points : [points[0], points[0]]);
  const geometry = new THREE.TubeGeometry(curve, Math.max(2, points.length * 4), PIPE_RADIUS_M, 8, false);
  const material = new THREE.MeshStandardMaterial({ color: PIPE_ROUTE_COLOR, roughness: 0.4, metalness: 0.2 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.kind = "pipe";
  return mesh;
}

function buildManholeMarker(x: number, y: number, z: number, color: number, kind: string, id: string): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(0.6, 0.6, 1.2, 16);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.userData = { kind, id };
  return mesh;
}

export function ManholePlan3D({ features, classMap, anomalies, manholeAnswer, datasets, activeDatasetIds, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: string; id: string; extra?: string } | null>(null);
  const [terrainAvailable, setTerrainAvailable] = useState(true);

  const wardDatasetId = activeDatasetIds[0];
  const dtmDataset = useMemo(
    () => datasets.find((d) => d.file_type === "geotiff" && /dtm/i.test(d.name)),
    [datasets]
  );
  const dsmDataset = useMemo(
    () => datasets.find((d) => d.file_type === "geotiff" && /dsm/i.test(d.name)),
    [datasets]
  );

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

        if (grid) {
          scene.add(buildTerrainMesh(grid, projector, baseElevation));
        } else {
          const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(1000, 1000),
            new THREE.MeshStandardMaterial({ color: 0xd8d2c2, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
          );
          ground.rotation.x = -Math.PI / 2;
          scene.add(ground);
        }

        const elevAt = (lon: number, lat: number) => (grid ? sampleGrid(grid, lon, lat) - baseElevation : 0);

        for (const b of buildings) {
          const geom = b.geometry;
          const ring: [number, number][] =
            geom.type === "Polygon" ? geom.coordinates[0] : geom.type === "MultiPolygon" ? geom.coordinates[0][0] : [];
          if (ring.length < 3) continue;
          const centroidLon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
          const centroidLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          const h = heights[b.properties.id];
          const heightM = h?.height_m ?? DEFAULT_BUILDING_HEIGHT_M;
          const estimated = h ? h.estimated : true;
          const mesh = buildBuildingMesh(ring, elevAt(centroidLon, centroidLat), heightM, projector, estimated);
          if (mesh) {
            mesh.userData = { kind: "building", id: b.properties.id, extra: `height ${heightM.toFixed(1)} m${estimated ? " (estimated)" : ""}` };
            scene.add(mesh);
            clickable.push(mesh);
          }
        }

        const anomalyByManhole = new Map(
          anomalies.filter((a) => a.anomaly_type === "manhole_status").map((a) => [a.feature_ids[0], a])
        );
        for (const m of manholes) {
          if (m.geometry.type !== "Point") continue;
          const [lon, lat] = m.geometry.coordinates;
          const [x, z] = projector.toLocal(lon, lat);
          const ground = elevAt(lon, lat);
          const anomaly = anomalyByManhole.get(m.properties.id);
          const color = anomaly ? ANOMALY_COLOR[anomaly.color] ?? NEUTRAL_MANHOLE_COLOR : NEUTRAL_MANHOLE_COLOR;
          const mesh = buildManholeMarker(x, ground - MANHOLE_DEFAULT_DEPTH_M / 2, z, color, "manhole", m.properties.id);
          mesh.userData.extra = anomaly ? `status: ${anomaly.color}` : "no audit finding";
          scene.add(mesh);
          clickable.push(mesh);
        }

        if (manholeAnswer) {
          for (const loc of manholeAnswer.needed_locations ?? []) {
            const [x, z] = projector.toLocal(loc.lon, loc.lat);
            const ground = elevAt(loc.lon, loc.lat);
            const mesh = buildManholeMarker(x, ground, z, PROPOSED_MANHOLE_COLOR, "proposed-manhole", loc.id);
            mesh.userData.extra = loc.reason;
            scene.add(mesh);
            clickable.push(mesh);
          }
          for (const route of manholeAnswer.routes ?? []) {
            // route.pipe_spec.{from_rl,to_rl} are real absolute elevations
            // (same units as the DTM), so they need the same baseElevation
            // re-zeroing as the terrain/buildings/manholes above.
            const yStart =
              route.pipe_spec.from_rl !== null
                ? route.pipe_spec.from_rl - baseElevation
                : elevAt(route.coordinates[0][0], route.coordinates[0][1]) - MANHOLE_DEFAULT_DEPTH_M;
            const lastCoord = route.coordinates[route.coordinates.length - 1];
            const yEnd =
              route.pipe_spec.to_rl !== null
                ? route.pipe_spec.to_rl - baseElevation
                : elevAt(lastCoord[0], lastCoord[1]) - MANHOLE_DEFAULT_DEPTH_M;
            const tube = buildPipeTube(route.coordinates, yStart, yEnd, projector);
            tube.userData = {
              kind: "pipe",
              id: route.from_id,
              extra: `${route.pipe_spec.material}, ${route.pipe_spec.diameter_mm.toFixed(0)} mm`,
            };
            scene.add(tube);
            clickable.push(tube);
          }
        }

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const handleClick = (e: MouseEvent) => {
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hits = raycaster.intersectObjects(clickable, false);
          if (hits.length > 0) {
            const { kind, id, extra } = hits[0].object.userData as { kind: string; id: string; extra?: string };
            setSelected({ kind, id, extra });
          }
        };
        renderer.domElement.addEventListener("click", handleClick);
        cleanupFns.push(() => renderer.domElement.removeEventListener("click", handleClick));

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
        <span><i style={{ background: "#3aa1ff" }} /> AI pipe route</span>
      </div>
      {loading && <div className="manhole-3d-overlay__status">Building 3D scene from real survey + terrain data…</div>}
      {error && <div className="manhole-3d-overlay__status manhole-3d-overlay__status--error">{error}</div>}
      <div ref={containerRef} className="manhole-3d-overlay__canvas" />
      {selected && (
        <div className="manhole-3d-overlay__info">
          <b>{selected.kind}</b>
          <div>{selected.id}</div>
          {selected.extra && <div>{selected.extra}</div>}
        </div>
      )}
    </div>
  );
}
