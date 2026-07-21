import * as THREE from "three";
import {
  GRID_STEP,
  SPAN_X,
  SPAN_Z,
  ROAD_EXCLUSION_HALF,
  PEDESTRIAN_OFFSET,
  PEDESTRIAN_HALF_WIDTH,
  TREE_BELT,
  PLAZA,
  CIVIC_CENTER,
  PLANNING_ZONES,
  PARKS,
} from "./config";
import { makeLineCurve } from "./pathUtils";
import type { ExclusionZone } from "./collisionUtils";

export type CityLayout = {
  exclusionZones: ExclusionZone[];
  carPaths: THREE.LineCurve3[];
  pedPaths: THREE.LineCurve3[];
  parks: Array<{ x: number; z: number; size: number }>;
  planningZones: Array<[number, number]>;
  treeBelt: { x: number; z: number; r: number };
  plaza: { x: number; z: number; w: number; d: number };
  civicCenter: { x: number; z: number; r: number };
};

function roadLines(): {
  zRoads: number[];
  xRoads: number[];
} {
  const zRoads: number[] = [];
  for (let x = -SPAN_X; x <= SPAN_X; x += GRID_STEP) zRoads.push(x);
  const xRoads: number[] = [];
  for (let z = -SPAN_Z; z <= SPAN_Z; z += GRID_STEP) xRoads.push(z);
  return { zRoads, xRoads };
}

export function buildCityLayout(): CityLayout {
  const { zRoads, xRoads } = roadLines();
  const exclusionZones: ExclusionZone[] = [];
  const carPaths: THREE.LineCurve3[] = [];
  const pedPaths: THREE.LineCurve3[] = [];

  for (const gx of zRoads) {
    exclusionZones.push({
      type: "box",
      minX: gx - ROAD_EXCLUSION_HALF,
      maxX: gx + ROAD_EXCLUSION_HALF,
      minZ: -SPAN_Z,
      maxZ: SPAN_Z,
    });
    carPaths.push(makeLineCurve(gx, -SPAN_Z, gx, SPAN_Z));
    for (const sign of [1, -1]) {
      const off = sign * PEDESTRIAN_OFFSET;
      exclusionZones.push({
        type: "box",
        minX: gx + off - PEDESTRIAN_HALF_WIDTH,
        maxX: gx + off + PEDESTRIAN_HALF_WIDTH,
        minZ: -SPAN_Z,
        maxZ: SPAN_Z,
      });
      pedPaths.push(makeLineCurve(gx + off, -SPAN_Z, gx + off, SPAN_Z));
    }
  }

  for (const gz of xRoads) {
    exclusionZones.push({
      type: "box",
      minX: -SPAN_X,
      maxX: SPAN_X,
      minZ: gz - ROAD_EXCLUSION_HALF,
      maxZ: gz + ROAD_EXCLUSION_HALF,
    });
    carPaths.push(makeLineCurve(-SPAN_X, gz, SPAN_X, gz));
    for (const sign of [1, -1]) {
      const off = sign * PEDESTRIAN_OFFSET;
      exclusionZones.push({
        type: "box",
        minX: -SPAN_X,
        maxX: SPAN_X,
        minZ: gz + off - PEDESTRIAN_HALF_WIDTH,
        maxZ: gz + off + PEDESTRIAN_HALF_WIDTH,
      });
      pedPaths.push(makeLineCurve(-SPAN_X, gz + off, SPAN_X, gz + off));
    }
  }

  for (const p of PARKS) {
    const h = p.size / 2;
    exclusionZones.push({
      type: "box",
      minX: p.x - h,
      maxX: p.x + h,
      minZ: p.z - h,
      maxZ: p.z + h,
    });
  }

  for (const [zx, zz] of PLANNING_ZONES) {
    const h = 9;
    exclusionZones.push({
      type: "box",
      minX: zx - h,
      maxX: zx + h,
      minZ: zz - h,
      maxZ: zz + h,
    });
  }

  exclusionZones.push({
    type: "circle",
    x: TREE_BELT.x,
    z: TREE_BELT.z,
    radius: TREE_BELT.r,
  });

  exclusionZones.push({
    type: "box",
    minX: PLAZA.x - PLAZA.w / 2,
    maxX: PLAZA.x + PLAZA.w / 2,
    minZ: PLAZA.z - PLAZA.d / 2,
    maxZ: PLAZA.z + PLAZA.d / 2,
  });

  exclusionZones.push({
    type: "circle",
    x: CIVIC_CENTER.x,
    z: CIVIC_CENTER.z,
    radius: CIVIC_CENTER.r,
  });

  return {
    exclusionZones,
    carPaths,
    pedPaths,
    parks: PARKS,
    planningZones: PLANNING_ZONES,
    treeBelt: TREE_BELT,
    plaza: PLAZA,
    civicCenter: CIVIC_CENTER,
  };
}
