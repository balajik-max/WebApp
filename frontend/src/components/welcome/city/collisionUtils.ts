export type AgentCounts = {
  cars: number;
  pedestrians: number;
  cyclists: number;
  streetlights: number;
};

export type Footprint = {
  centerX: number;
  centerZ: number;
  width: number;
  depth: number;
  rotation: number;
};

export type BoxZone = {
  type: "box";
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type CircleZone = {
  type: "circle";
  x: number;
  z: number;
  radius: number;
};

export type CorridorZone = {
  type: "corridor";
  points: Array<[number, number]>;
  halfWidth: number;
};

export type ExclusionZone = BoxZone | CircleZone | CorridorZone;

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rotatedCorners(fp: Footprint): Array<[number, number]> {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  const c = Math.cos(fp.rotation);
  const s = Math.sin(fp.rotation);
  const local: Array<[number, number]> = [
    [hw, hd],
    [hw, -hd],
    [-hw, -hd],
    [-hw, hd],
  ];
  return local.map(([x, z]) => [
    fp.centerX + x * c - z * s,
    fp.centerZ + x * s + z * c,
  ]);
}

function footprintAabb(fp: Footprint): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const corners = rotatedCorners(fp);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

function pointToSegmentDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

function intersectsBox(fp: Footprint, margin: number, zone: BoxZone): boolean {
  const aabb = footprintAabb(fp);
  return (
    aabb.minX - margin < zone.maxX &&
    aabb.maxX + margin > zone.minX &&
    aabb.minZ - margin < zone.maxZ &&
    aabb.maxZ + margin > zone.minZ
  );
}

function intersectsCircle(fp: Footprint, margin: number, zone: CircleZone): boolean {
  const aabb = footprintAabb(fp);
  const cx = Math.max(zone.x, Math.min(aabb.maxX, zone.x));
  const cz = Math.max(zone.z, Math.min(aabb.maxZ, zone.z));
  return Math.hypot(zone.x - cx, zone.z - cz) < zone.radius + margin;
}

function intersectsCorridor(
  fp: Footprint,
  margin: number,
  zone: CorridorZone
): boolean {
  const radius = 0.5 * Math.hypot(fp.width, fp.depth);
  const total = zone.halfWidth + radius + margin;
  for (let i = 0; i < zone.points.length - 1; i++) {
    const [ax, az] = zone.points[i];
    const [bx, bz] = zone.points[i + 1];
    const d = pointToSegmentDistance(
      fp.centerX,
      fp.centerZ,
      ax,
      az,
      bx,
      bz
    );
    if (d < total) return true;
  }
  return false;
}

export function isFootprintClear(
  fp: Footprint,
  zones: ExclusionZone[],
  margin: number
): boolean {
  for (const zone of zones) {
    if (zone.type === "box") {
      if (intersectsBox(fp, margin, zone)) return false;
    } else if (zone.type === "circle") {
      if (intersectsCircle(fp, margin, zone)) return false;
    } else {
      if (intersectsCorridor(fp, margin, zone)) return false;
    }
  }
  return true;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export function clampToBounds(
  x: number,
  z: number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): [number, number] {
  return [
    clamp(x, bounds.minX, bounds.maxX),
    clamp(z, bounds.minZ, bounds.maxZ),
  ];
}

export function validateSceneLayout(
  footprints: Footprint[],
  zones: ExclusionZone[],
  margin: number
): boolean {
  let ok = true;
  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i];
      const b = footprints[j];
      const da = Math.hypot(a.centerX - b.centerX, a.centerZ - b.centerZ);
      if (da < 2.0) {
        const sa = isFootprintClear(a, zones, margin);
        const sb = isFootprintClear(b, zones, margin);
        if (!sa || !sb) {
          ok = false;
          // eslint-disable-next-line no-console
          console.warn("[city] overlapping building near", a.centerX, a.centerZ);
        }
      }
    }
  }
  return ok;
}
