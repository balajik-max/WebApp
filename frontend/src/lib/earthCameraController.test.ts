import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock maplibre-gl so the controller can be unit-tested without a WebGL
// context. Only the bits the controller actually touches are provided.
vi.mock("maplibre-gl", () => {
  class LngLat {
    lng: number;
    lat: number;
    constructor(lng: number, lat: number) {
      this.lng = lng;
      this.lat = lat;
    }
    static convert(c: unknown): LngLat {
      if (c && typeof c === "object" && "lng" in (c as object)) {
        const o = c as { lng: number; lat: number };
        return new LngLat(o.lng, o.lat);
      }
      const a = c as [number, number];
      return new LngLat(a[0], a[1]);
    }
  }
  return {
    default: { LngLat, Point: class { constructor(public x: number, public y: number) {} } },
    LngLat,
    Map: class {},
    SkySpecification: {},
  };
});

import {
  rangeFromZoom,
  zoomFromRange,
  normalizeHeading,
  clampTilt,
  cameraOffsetMeters,
  offsetMetersToLngLat,
  applyDolly,
} from "./earthCameraMath";
import { EarthCameraController } from "./earthCameraController";
import type { Map as MLMap } from "maplibre-gl";

const EARTH_RADIUS_M = 6371008.8;

beforeAll(() => {
  // Deterministic, synchronous rAF so gesture ticks run immediately.
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (
    cb
  ) => {
    cb(0);
    return 0;
  };
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = () => {};
});

describe("pure camera mathematics", () => {
  it("places the camera directly above the target at zero heading/tilt", () => {
    const off = cameraOffsetMeters(1000, 0, 0);
    expect(off.eastOffsetM).toBeCloseTo(0, 6);
    expect(off.northOffsetM).toBeCloseTo(0, 6);
    expect(off.cameraAltitudeM).toBeCloseTo(1000, 6);
  });

  it("offset points east at 90-degree heading", () => {
    const off = cameraOffsetMeters(1000, 90, 45);
    // horizontal range = 1000 * sin(45) ~ 707; east = horizontal * sin(90)
    expect(off.eastOffsetM).toBeGreaterThan(700);
    expect(off.northOffsetM).toBeCloseTo(0, 6);
  });

  it("increasing tilt moves the camera toward the horizon", () => {
    const low = cameraOffsetMeters(1000, 0, 10);
    const high = cameraOffsetMeters(1000, 0, 80);
    expect(high.cameraAltitudeM).toBeLessThan(low.cameraAltitudeM);
    const horizLow = Math.hypot(low.eastOffsetM, low.northOffsetM);
    const horizHigh = Math.hypot(high.eastOffsetM, high.northOffsetM);
    expect(horizHigh).toBeGreaterThan(horizLow);
  });

  it("keeps range positive and finite", () => {
    expect(rangeFromZoom(5, 800)).toBeGreaterThan(0);
    expect(Number.isFinite(rangeFromZoom(5, 800))).toBe(true);
  });

  it("clamps tilt to the safe band", () => {
    expect(clampTilt(120, 85)).toBe(85);
    expect(clampTilt(-30, 85)).toBe(0);
    expect(clampTilt(45, 85)).toBe(45);
  });

  it("normalises heading across ±360", () => {
    expect(normalizeHeading(370)).toBeCloseTo(10, 6);
    expect(normalizeHeading(-10)).toBeCloseTo(350, 6);
    expect(normalizeHeading(360)).toBeCloseTo(0, 6);
    expect(normalizeHeading(180)).toBeCloseTo(180, 6);
  });

  it("keeps camera altitude at or above the target", () => {
    for (const tilt of [0, 15, 45, 75, 90]) {
      const off = cameraOffsetMeters(5000, 200, tilt);
      expect(off.cameraAltitudeM).toBeGreaterThanOrEqual(0);
    }
  });

  it("wheel dolly decreases/increases range and stays clamped", () => {
    const near = applyDolly(1000, -100); // scroll up -> closer
    const far = applyDolly(1000, 100); // scroll down -> farther
    expect(near).toBeLessThan(1000);
    expect(far).toBeGreaterThan(1000);
    // clamp at the top of the band
    const huge = applyDolly(1000, 100000);
    expect(huge).toBeLessThanOrEqual(20_000_000);
    expect(huge).toBeGreaterThan(0);
  });

  it("range<->zoom conversion is consistent", () => {
    const range = rangeFromZoom(10, 900);
    const zoom = zoomFromRange(range, 900);
    expect(zoom).toBeCloseTo(10, 4);
  });

  it("converts metre offsets back into lng/lat deltas", () => {
    const origin = { lng: 0, lat: 0 };
    const delta = offsetMetersToLngLat(origin, 0, EARTH_RADIUS_M * (Math.PI / 180));
    // One degree of latitude ~= (pi * R)/180 metres.
    expect(delta.lat).toBeCloseTo(1, 4);
  });
});

// --- Controller behaviour (mocked MapLibre) -------------------------------

function makeHandler(initial = true) {
  let enabled = initial;
  return {
    enable: () => {
      enabled = true;
    },
    disable: () => {
      enabled = false;
    },
    isEnabled: () => enabled,
  };
}

function makeMockMap(): MLMap {
  let bearing = 0;
  let pitch = 0;
  let zoom = 12;
  const center = { lng: 75.92, lat: 14.46 };
  const canvas = {
    clientHeight: 800,
    style: {} as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
  } as unknown as HTMLCanvasElement;
  const map = {
    getBearing: () => bearing,
    getPitch: () => pitch,
    getZoom: () => zoom,
    getCenter: () => ({ lng: center.lng, lat: center.lat }),
    getMaxPitch: () => 85,
    getMinZoom: () => 4,
    getMaxZoom: () => 24,
    getCanvas: () => canvas,
    queryTerrainElevation: () => 0,
    stop: () => {},
    jumpTo: (c: { center?: { lng: number; lat: number }; zoom?: number; bearing?: number; pitch?: number }) => {
      if (c.center) {
        center.lng = c.center.lng;
        center.lat = c.center.lat;
      }
      if (c.zoom != null) zoom = c.zoom;
      if (c.bearing != null) bearing = c.bearing;
      if (c.pitch != null) pitch = c.pitch;
    },
    easeTo: (c: { center?: { lng: number; lat: number }; zoom?: number; bearing?: number; pitch?: number; duration?: number }) => {
      if (c.center) {
        center.lng = c.center.lng;
        center.lat = c.center.lat;
      }
      if (c.zoom != null) zoom = c.zoom;
      if (c.bearing != null) bearing = c.bearing;
      if (c.pitch != null) pitch = c.pitch;
    },
    setBearing: (b: number) => {
      bearing = b;
    },
    setPitch: (p: number) => {
      pitch = p;
    },
    dragPan: makeHandler(true),
    dragRotate: makeHandler(true),
    scrollZoom: makeHandler(true),
    boxZoom: makeHandler(false),
    doubleClickZoom: makeHandler(true),
    keyboard: makeHandler(true),
    touchZoomRotate: makeHandler(true),
    touchPitch: makeHandler(true),
  };
  return map as unknown as MLMap;
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
  } as unknown as HTMLCanvasElement;
}

describe("EarthCameraController", () => {
  it("keeps the target fixed while orbiting (stable look-at)", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    const targetBefore = ctrl.getTarget();
    const startHeading = ctrl.getState().headingDeg;

    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.updateOrbit(500, 300); // drag right -> heading changes
    ctrl.endOrbit(1);

    const state = ctrl.getState();
    expect(state.target?.lng).toBeCloseTo(targetBefore!.lng, 6);
    expect(state.target?.lat).toBeCloseTo(targetBefore!.lat, 6);
    expect(state.headingDeg).not.toBeCloseTo(startHeading, 3);
  });

  it("keeps the target fixed while dollying", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    const targetBefore = ctrl.getTarget();
    const rangeBefore = ctrl.getState().rangeM;

    ctrl.dolly(120);

    const state = ctrl.getState();
    expect(state.target?.lng).toBeCloseTo(targetBefore!.lng, 6);
    expect(state.rangeM).toBeGreaterThan(rangeBefore);
  });

  it("entering then exiting preserves the map centre", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    const center = ctrl.getTarget();
    // Simulate a mode round-trip via state model.
    ctrl.setViewMode("standard");
    ctrl.syncFromMap();
    expect(ctrl.getTarget()?.lng).toBeCloseTo(center!.lng, 6);
  });

  it("disabled inertia when reduced motion is on does not throw", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map, { reducedMotion: true });
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    expect(() => {
      ctrl.beginOrbit(400, 300, 1, fakeCanvas());
      ctrl.updateOrbit(600, 300);
      ctrl.endOrbit(1); // with reducedMotion, no inertia loop is started
    }).not.toThrow();
  });
});

describe("EarthCameraController lifecycle (orbit stability)", () => {
  it("begins from idle and reports active", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.getPhase()).toBe("active");
  });

  it("ignores a second begin while already active", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.beginOrbit(10, 10, 2, fakeCanvas());
    // still the first pointer
    expect(ctrl.isActive()).toBe(true);
    ctrl.finishOrbit("pointerup", 1);
  });

  it("finishOrbit is idempotent", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.finishOrbit("pointerup", 1);
    expect(() => ctrl.finishOrbit("pointerup", 1)).not.toThrow();
    expect(() => ctrl.cancelOrbit("pointercancel", 1)).not.toThrow();
    expect(ctrl.isActive()).toBe(false);
  });

  it("ignores finishOrbit for a mismatched pointer id", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.finishOrbit("pointerup", 99);
    expect(ctrl.isActive()).toBe(true);
    ctrl.finishOrbit("pointerup", 1);
    expect(ctrl.isActive()).toBe(false);
  });

  it("pointercancel / lostpointercapture path cancels via recover", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.recover("pointercancel");
    expect(ctrl.isActive()).toBe(false);
  });

  it("restores native handlers to their exact pre-orbit state", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    expect(map.dragPan.isEnabled()).toBe(false); // suspended
    ctrl.finishOrbit("pointerup", 1);
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(map.dragRotate.isEnabled()).toBe(true);
  });

  it("does not clobber a handler that was already disabled before orbit", () => {
    const map = makeMockMap();
    map.dragPan.disable();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.finishOrbit("pointerup", 1);
    expect(map.dragPan.isEnabled()).toBe(false); // preserved
  });

  it("produces no camera motion after the gesture ends", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.updateOrbit(500, 300);
    ctrl.finishOrbit("pointerup", 1);
    const headingAfter = ctrl.getState().headingDeg;
    // a stray update after finish must be ignored
    ctrl.updateOrbit(900, 900);
    expect(ctrl.getState().headingDeg).toBeCloseTo(headingAfter, 6);
    expect(ctrl.isActive()).toBe(false);
  });

  it("restores the cursor via the tool resolver after orbit", () => {
    const map = makeMockMap();
    const canvas = fakeCanvas();
    const ctrl = new EarthCameraController(map);
    ctrl.cursorResolver = () => "grab"; // a tool that wants grab
    ctrl.beginOrbit(400, 300, 1, canvas);
    expect(canvas.style.cursor).toBe("grabbing");
    ctrl.finishOrbit("pointerup", 1);
    expect(canvas.style.cursor).toBe("grab");
  });

  it("recovers even if a camera update throws", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.setViewMode("earth3d");
    ctrl.syncFromMap();
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    // Force the per-frame camera write to throw.
    (map as unknown as { jumpTo: () => void }).jumpTo = () => {
      throw new Error("boom");
    };
    expect(() => ctrl.updateOrbit(500, 300)).not.toThrow();
    // The error must have triggered recovery, not left the map locked.
    expect(ctrl.isActive()).toBe(false);
    expect(map.dragPan.isEnabled()).toBe(true);
  });

  it("tool-change recovers an in-progress orbit", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    ctrl.recover("tool-change");
    expect(ctrl.isActive()).toBe(false);
    expect(map.dragPan.isEnabled()).toBe(true);
  });

  it("dispose is safe and idempotent", () => {
    const map = makeMockMap();
    const ctrl = new EarthCameraController(map);
    ctrl.beginOrbit(400, 300, 1, fakeCanvas());
    expect(() => {
      ctrl.dispose();
      ctrl.dispose();
    }).not.toThrow();
    expect(ctrl.isActive()).toBe(false);
  });
});
