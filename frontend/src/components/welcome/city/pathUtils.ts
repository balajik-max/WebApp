import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);

export function makeLineCurve(
  ax: number,
  az: number,
  bx: number,
  bz: number
): THREE.LineCurve3 {
  return new THREE.LineCurve3(
    new THREE.Vector3(ax, 0, az),
    new THREE.Vector3(bx, 0, bz)
  );
}

export type PathTransform = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
};

export function getPathTransform(
  curve: THREE.LineCurve3,
  t: number,
  height: number
): PathTransform {
  const tc = ((t % 1) + 1) % 1;
  const position = curve.getPointAt(tc);
  const tangent = curve.getTangentAt(tc).normalize();
  const yaw = Math.atan2(tangent.x, tangent.z);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  position.y += height;
  return { position, quaternion };
}
