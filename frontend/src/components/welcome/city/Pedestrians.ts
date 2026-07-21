import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "./config";
import { makeRng } from "./collisionUtils";
import { getPathTransform } from "./pathUtils";
import type { CityEntity } from "./types";

const WHITE = new THREE.Color(PALETTE.WHITE);
const LIGHT = new THREE.Color(PALETTE.LIGHT);
const GREEN = new THREE.Color(PALETTE.GREEN);

function buildPersonGeometry(): THREE.BufferGeometry {
  const head = new THREE.SphereGeometry(0.3, 10, 8);
  head.translate(0, 1.5, 0);
  const torso = new THREE.BoxGeometry(0.5, 0.9, 0.3);
  torso.translate(0, 0.95, 0);
  const legL = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  legL.translate(0.13, 0.35, 0);
  const legR = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  legR.translate(-0.13, 0.35, 0);
  const merged = mergeGeometries([head, torso, legL, legR]);
  head.dispose();
  torso.dispose();
  legL.dispose();
  legR.dispose();
  return merged;
}

type AgentConfig = {
  curve: THREE.LineCurve3;
  offset: number;
  speed: number;
  dir: 1 | -1;
  phase: number;
  height: number;
};

export function createPedestrians(
  paths: THREE.LineCurve3[],
  count: number,
  isMobile: boolean
): CityEntity {
  const geo = buildPersonGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: WHITE,
    roughness: 0.7,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = !isMobile;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const rng = makeRng(23);
  const agents: AgentConfig[] = [];
  const palette = [WHITE, LIGHT, GREEN, LIGHT];
  for (let i = 0; i < count; i++) {
    agents.push({
      curve: paths[Math.floor(rng() * paths.length)],
      offset: rng(),
      speed: 0.012 + rng() * 0.02,
      dir: rng() < 0.5 ? 1 : -1,
      phase: rng() * Math.PI * 2,
      height: 0,
    });
    mesh.setColorAt(i, palette[Math.floor(rng() * palette.length)]);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const dummy = new THREE.Object3D();
  const apply = (cfg: AgentConfig, i: number, elapsed: number) => {
    const base = cfg.offset + cfg.speed * elapsed * cfg.dir;
    const { position, quaternion } = getPathTransform(
      cfg.curve,
      base,
      cfg.height
    );
    const bob = Math.abs(Math.sin(elapsed * 4 + cfg.phase)) * 0.06;
    dummy.position.copy(position);
    dummy.position.y += bob;
    dummy.quaternion.copy(quaternion);
    if (cfg.dir < 0) dummy.rotateY(Math.PI);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  };

  const update = (elapsed: number) => {
    for (let i = 0; i < agents.length; i++) apply(agents[i], i, elapsed);
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
