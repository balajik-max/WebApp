import * as THREE from "three";
import {
  PALETTE,
  ROAD_HALF_WIDTH,
  PEDESTRIAN_HALF_WIDTH,
} from "./config";
import { makeRng } from "./collisionUtils";
import type { CityLayout } from "./cityLayout";
import type { CityEntity } from "./types";

const GREEN = new THREE.Color(PALETTE.GREEN);
const LIGHT = new THREE.Color(PALETTE.LIGHT);
const INK = new THREE.Color(PALETTE.INK_GREEN);

function buildStripMesh(
  paths: THREE.LineCurve3[],
  width: number,
  color: THREE.Color,
  opacity: number,
  y: number
): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 0.04, 1);
  const mat = new THREE.MeshStandardMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    roughness: 0.95,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, paths.length);
  const dummy = new THREE.Object3D();
  paths.forEach((curve, i) => {
    const a = curve.getPoint(0);
    const b = curve.getPoint(1);
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const lenX = Math.abs(b.x - a.x);
    const lenZ = Math.abs(b.z - a.z);
    dummy.position.set(cx, y, cz);
    dummy.scale.set(
      lenX > lenZ ? Math.max(lenX, 1) : width,
      1,
      lenZ > lenX ? Math.max(lenZ, 1) : width
    );
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildFlatPlane(
  x: number,
  z: number,
  size: number,
  color: THREE.Color,
  opacity: number
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.02, z);
  return mesh;
}

export function createGreenZones(
  layout: CityLayout,
  isMobile: boolean,
  treeCount: number
): CityEntity {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];

  const track = (d: { dispose: () => void }) => disposables.push(d);

  // roads (light strips)
  const roads = buildStripMesh(
    layout.carPaths,
    ROAD_HALF_WIDTH * 2,
    LIGHT,
    0.85,
    0.05
  );
  track(roads.geometry);
  track(roads.material as THREE.Material);
  group.add(roads);

  // pedestrian green corridors
  const peds = buildStripMesh(
    layout.pedPaths,
    PEDESTRIAN_HALF_WIDTH * 2,
    GREEN,
    0.4,
    0.04
  );
  track(peds.geometry);
  track(peds.material as THREE.Material);
  group.add(peds);

  // parks
  for (const p of layout.parks) {
    const m = buildFlatPlane(p.x, p.z, p.size, GREEN, 0.3);
    track(m.geometry);
    track(m.material as THREE.Material);
    group.add(m);
  }

  // planning zones
  for (const [zx, zz] of layout.planningZones) {
    const m = buildFlatPlane(zx, zz, 18, GREEN, 0.28);
    track(m.geometry);
    track(m.material as THREE.Material);
    group.add(m);
  }

  // plaza
  const plazaGeo = new THREE.BoxGeometry(layout.plaza.w, 0.12, layout.plaza.d);
  const plazaMat = new THREE.MeshStandardMaterial({
    color: LIGHT,
    roughness: 0.9,
  });
  const plaza = new THREE.Mesh(plazaGeo, plazaMat);
  plaza.position.set(layout.plaza.x, 0.06, layout.plaza.z);
  plaza.receiveShadow = !isMobile;
  track(plazaGeo);
  track(plazaMat);
  group.add(plaza);

  // trees
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: INK,
    roughness: 1,
  });
  const foliageGeo = new THREE.SphereGeometry(1.0, 10, 8);
  const foliageMat = new THREE.MeshStandardMaterial({
    color: GREEN,
    roughness: 0.9,
  });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, treeCount);
  trunks.castShadow = !isMobile;
  foliage.castShadow = !isMobile;

  const rng = makeRng(717);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < treeCount; i++) {
    let x = 0;
    let z = 0;
    if (rng() < 0.7) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * layout.treeBelt.r;
      x = layout.treeBelt.x + Math.cos(ang) * r;
      z = layout.treeBelt.z + Math.sin(ang) * r;
    } else {
      const p = layout.parks[Math.floor(rng() * layout.parks.length)];
      const h = p.size / 2 - 1.5;
      x = p.x + (rng() * 2 - 1) * h;
      z = p.z + (rng() * 2 - 1) * h;
    }
    dummy.position.set(x, 0.6, z);
    dummy.scale.setScalar(0.8 + rng() * 0.5);
    dummy.rotation.y = rng() * Math.PI;
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, 1.6, z);
    dummy.scale.setScalar(0.8 + rng() * 0.5);
    dummy.updateMatrix();
    foliage.setMatrixAt(i, dummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  track(trunkGeo);
  track(trunkMat);
  track(foliageGeo);
  track(foliageMat);
  group.add(trunks);
  group.add(foliage);

  return {
    object3D: group,
    update: () => {},
    setStatic: () => {},
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
