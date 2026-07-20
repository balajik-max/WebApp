import * as THREE from "three";
import {
  SEED,
  SAFETY_MARGIN,
  MAX_PLACEMENT_ATTEMPTS,
  PLACEMENT_BOUNDS,
  PALETTE,
  GRID_STEP,
} from "./config";
import {
  makeRng,
  isFootprintClear,
  clampToBounds,
  validateSceneLayout,
  type Footprint,
} from "./collisionUtils";
import type { CityLayout } from "./cityLayout";
import type { CityEntity } from "./types";

type BuildingPlacement = Footprint & { height: number; active: boolean };

const GREEN = new THREE.Color(PALETTE.GREEN);
const LIGHT = new THREE.Color(PALETTE.LIGHT);
const WHITE = new THREE.Color(PALETTE.WHITE);

function generatePlacements(
  count: number,
  zones: CityLayout["exclusionZones"]
): BuildingPlacement[] {
  const rng = makeRng(SEED);
  const placements: BuildingPlacement[] = [];
  let attempts = 0;
  const maxAttempts = count * MAX_PLACEMENT_ATTEMPTS;
  while (placements.length < count && attempts < maxAttempts) {
    attempts++;
    const baseCellX = Math.round(rng() * 2 - 1) * GRID_STEP;
    const baseCellZ = Math.round(rng() * 2 - 1) * GRID_STEP;
    const jitterX = rng() * (GRID_STEP - 14) - (GRID_STEP - 14) / 2;
    const jitterZ = rng() * (GRID_STEP - 14) - (GRID_STEP - 14) / 2;
    const [cx, cz] = clampToBounds(
      baseCellX + jitterX,
      baseCellZ + jitterZ,
      PLACEMENT_BOUNDS
    );
    const width = 3 + rng() * 4;
    const depth = 3 + rng() * 4;
    const height = 2 + rng() * 12;
    const rotation = rng() < 0.5 ? 0 : Math.PI / 2;
    const fp: Footprint = { centerX: cx, centerZ: cz, width, depth, rotation };
    if (!isFootprintClear(fp, zones, SAFETY_MARGIN)) continue;
    const active = rng() < 0.12;
    placements.push({ ...fp, height, active });
  }
  return placements;
}

export function createBuildings(
  layout: CityLayout,
  count: number,
  isMobile: boolean
): CityEntity {
  const placements = generatePlacements(count, layout.exclusionZones);

  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    validateSceneLayout(placements, layout.exclusionZones, SAFETY_MARGIN);
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: false,
    roughness: 0.85,
    metalness: 0.0,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  mesh.castShadow = !isMobile;
  mesh.receiveShadow = !isMobile;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  placements.forEach((p, i) => {
    dummy.position.set(p.centerX, p.height / 2, p.centerZ);
    dummy.rotation.y = p.rotation;
    dummy.scale.set(p.width, p.height, p.depth);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (p.active) {
      color.copy(GREEN);
    } else if ((i + Math.round(p.centerX)) % 3 === 0) {
      color.copy(LIGHT);
    } else {
      color.copy(WHITE);
    }
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return {
    object3D: mesh,
    update: () => {},
    setStatic: () => {},
    dispose: () => {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
