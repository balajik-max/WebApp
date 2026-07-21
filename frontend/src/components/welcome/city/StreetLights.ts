import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  PALETTE,
  SPAN_X,
  SPAN_Z,
  GRID_STEP,
  PEDESTRIAN_OFFSET,
} from "./config";
import type { CityEntity } from "./types";

const GREEN = new THREE.Color(PALETTE.GREEN);

function buildLampGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.12, 0.15, 4, 8);
  pole.translate(0, 2, 0);
  const arm = new THREE.BoxGeometry(0.8, 0.12, 0.12);
  arm.translate(0.4, 3.9, 0);
  const merged = mergeGeometries([pole, arm]);
  pole.dispose();
  arm.dispose();
  return merged;
}

export function createStreetLights(count: number): CityEntity {
  const positions: Array<{ x: number; z: number }> = [];
  const step = 16;
  for (let x = -SPAN_X; x <= SPAN_X; x += GRID_STEP) {
    for (let z = -SPAN_Z; z <= SPAN_Z; z += step) {
      positions.push({ x: x + PEDESTRIAN_OFFSET, z });
    }
  }
  for (let z = -SPAN_Z; z <= SPAN_Z; z += GRID_STEP) {
    for (let x = -SPAN_X; x <= SPAN_X; x += step) {
      positions.push({ x, z: z + PEDESTRIAN_OFFSET });
    }
  }

  const total = positions.length;
  const stride = total > count ? Math.floor(total / count) : 1;
  const chosen: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < total && chosen.length < count; i += stride) {
    chosen.push(positions[i]);
  }

  const n = Math.max(chosen.length, 1);
  const poleGeo = buildLampGeometry();
  const poleMat = new THREE.MeshStandardMaterial({
    color: GREEN,
    roughness: 0.8,
  });
  const headGeo = new THREE.BoxGeometry(0.4, 0.25, 0.4);
  const headMat = new THREE.MeshStandardMaterial({
    color: GREEN,
    emissive: new THREE.Color(PALETTE.GREEN),
    emissiveIntensity: 0.5,
    roughness: 0.6,
  });

  const poles = new THREE.InstancedMesh(poleGeo, poleMat, n);
  const heads = new THREE.InstancedMesh(headGeo, headMat, n);
  const dummy = new THREE.Object3D();
  chosen.forEach((p, i) => {
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x + 0.8, 3.85, p.z);
    dummy.updateMatrix();
    heads.setMatrixAt(i, dummy.matrix);
  });
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.add(poles);
  group.add(heads);

  return {
    object3D: group,
    update: (elapsed: number) => {
      headMat.emissiveIntensity = 0.5 + Math.sin(elapsed * 0.8) * 0.15;
    },
    setStatic: () => {
      headMat.emissiveIntensity = 0.55;
    },
    dispose: () => {
      poleGeo.dispose();
      poleMat.dispose();
      headGeo.dispose();
      headMat.dispose();
      poles.dispose();
      heads.dispose();
    },
  };
}
