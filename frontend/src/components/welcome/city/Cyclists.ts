import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "./config";
import { makeRng } from "./collisionUtils";
import { getPathTransform } from "./pathUtils";
import type { CityEntity } from "./types";

const WHITE = new THREE.Color(PALETTE.WHITE);
const LIGHT = new THREE.Color(PALETTE.LIGHT);
const GREEN = new THREE.Color(PALETTE.GREEN);

function buildCyclistGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wheelGeo = new THREE.TorusGeometry(0.35, 0.1, 8, 16);
  wheelGeo.rotateY(Math.PI / 2);
  const wf = wheelGeo.clone();
  wf.translate(0, 0.35, 0.6);
  const wb = wheelGeo.clone();
  wb.translate(0, 0.35, -0.6);
  parts.push(wf, wb);
  const frame = new THREE.BoxGeometry(0.1, 0.5, 1.2);
  frame.translate(0, 0.55, 0);
  parts.push(frame);
  const torso = new THREE.BoxGeometry(0.35, 0.7, 0.25);
  torso.translate(0, 1.1, 0);
  parts.push(torso);
  const head = new THREE.SphereGeometry(0.25, 10, 8);
  head.translate(0, 1.55, 0);
  parts.push(head);
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  wheelGeo.dispose();
  return merged;
}

type AgentConfig = {
  curve: THREE.LineCurve3;
  offset: number;
  speed: number;
  dir: 1 | -1;
  height: number;
};

export function createCyclists(
  paths: THREE.LineCurve3[],
  count: number,
  isMobile: boolean
): CityEntity {
  const geo = buildCyclistGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: WHITE,
    roughness: 0.6,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = !isMobile;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const rng = makeRng(37);
  const agents: AgentConfig[] = [];
  const palette = [GREEN, LIGHT, WHITE, GREEN];
  for (let i = 0; i < count; i++) {
    agents.push({
      curve: paths[Math.floor(rng() * paths.length)],
      offset: rng(),
      speed: 0.04 + rng() * 0.03,
      dir: rng() < 0.5 ? 1 : -1,
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
    dummy.position.copy(position);
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
