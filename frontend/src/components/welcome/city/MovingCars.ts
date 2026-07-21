import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "./config";
import { makeRng } from "./collisionUtils";
import { getPathTransform } from "./pathUtils";
import type { CityEntity } from "./types";

const WHITE = new THREE.Color(PALETTE.WHITE);
const LIGHT = new THREE.Color(PALETTE.LIGHT);
const GREEN = new THREE.Color(PALETTE.GREEN);

function buildCarGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(2, 1.0, 4);
  body.translate(0, 0.6, 0);
  parts.push(body);
  const cabin = new THREE.BoxGeometry(1.7, 0.8, 2);
  cabin.translate(0, 1.3, 0.2);
  parts.push(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.4, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const offsets: Array<[number, number]> = [
    [0.9, 1.3],
    [-0.9, 1.3],
    [0.9, -1.3],
    [-0.9, -1.3],
  ];
  for (const [x, z] of offsets) {
    const w = wheelGeo.clone();
    w.translate(x, 0.35, z);
    parts.push(w);
  }
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  wheelGeo.dispose();
  return merged;
}

type CarConfig = {
  curve: THREE.LineCurve3;
  offset: number;
  speed: number;
  dir: 1 | -1;
  height: number;
};

export function createCars(
  paths: THREE.LineCurve3[],
  count: number,
  isMobile: boolean
): CityEntity {
  const geo = buildCarGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: WHITE,
    roughness: 0.55,
    metalness: 0.0,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = !isMobile;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const rng = makeRng(11);
  const cars: CarConfig[] = [];
  const palette = [WHITE, LIGHT, GREEN, LIGHT, WHITE];
  for (let i = 0; i < count; i++) {
    const curve = paths[Math.floor(rng() * paths.length)];
    cars.push({
      curve,
      offset: rng(),
      speed: 0.02 + rng() * 0.03,
      dir: rng() < 0.5 ? 1 : -1,
      height: 0,
    });
    const c = palette[Math.floor(rng() * palette.length)];
    mesh.setColorAt(i, c);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const dummy = new THREE.Object3D();
  const applyCar = (cfg: CarConfig, i: number, elapsed: number) => {
    const base = cfg.offset + cfg.speed * elapsed * cfg.dir;
    const { position, quaternion } = getPathTransform(
      cfg.curve,
      base,
      cfg.height
    );
    dummy.position.copy(position);
    dummy.quaternion.copy(quaternion);
    if (cfg.dir < 0) dummy.rotateY(Math.PI);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  };

  const update = (elapsed: number) => {
    for (let i = 0; i < cars.length; i++) applyCar(cars[i], i, elapsed);
    mesh.instanceMatrix.needsUpdate = true;
  };

  update(0);

  return {
    object3D: mesh,
    update,
    setStatic: () => update(0),
    dispose: () => {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
