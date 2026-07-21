import type * as THREE from "three";

export type CityEntity = {
  object3D: THREE.Object3D;
  update: (elapsed: number) => void;
  setStatic: () => void;
  dispose: () => void;
};
