import maplibregl from "maplibre-gl";
import type { Map as MLMap, LngLat as MLLngLat, LngLatLike } from "maplibre-gl";

import {
  ORBIT_HEADING_SENSITIVITY,
  ORBIT_TILT_SENSITIVITY,
  DOLLY_WHEEL_SCALE,
  type MapViewMode,
} from "./earthConfig";

// Pure, framework-free camera mathematics (Phase 12). Imported (and
// re-exported) from earthCameraMath so they can be unit-tested without
// pulling in MapLibre's runtime.
import {
  metersPerPixelAtZoom,
  rangeFromZoom,
  zoomFromRange,
  normalizeHeading,
  clampTilt,
  clampRange,
  cameraOffsetMeters,
  offsetMetersToLngLat,
  applyDolly,
} from "./earthCameraMath";
export {
  metersPerPixelAtZoom,
  rangeFromZoom,
  zoomFromRange,
  normalizeHeading,
  clampTilt,
  clampRange,
  cameraOffsetMeters,
  offsetMetersToLngLat,
  applyDolly,
};

// ---------------------------------------------------------------------------
// Orbit / Look Around lifecycle (Phases 2-25)
// ---------------------------------------------------------------------------

/** Single explicit lifecycle phase. Only one may be active at a time. */
export type OrbitPhase = "idle" | "starting" | "active" | "ending" | "cancelled";

/** Every reason an orbit gesture can end or be cancelled. */
export type OrbitEndReason =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "escape"
  | "window-blur"
  | "document-hidden"
  | "tool-change"
  | "basemap-change"
  | "route-change"
  | "internal-error"
  | "cancelled"
  | "disposed"
  | "recover";

/** Snapshot of MapLibre handler enable-states taken before an orbit starts,
 *  so they can be restored exactly afterwards (Phase 8). */
export interface NativeHandlerSnapshot {
  dragPan: boolean;
  dragRotate: boolean;
  scrollZoom: boolean;
  boxZoom: boolean;
  doubleClickZoom: boolean;
  keyboard: boolean;
  touchZoomRotate: boolean;
  touchPitch: boolean;
}

interface OrbitSnapshot {
  startPointer: { x: number; y: number };
  startHeading: number;
  startTilt: number;
  startRange: number;
  startTarget: MLLngLat;
  startGround: MLLngLat;
  startCenter: MLLngLat;
}

/** High-frequency runtime state kept in the instance (not React state). */
interface OrbitRuntimeState {
  phase: OrbitPhase;
  gesture: "orbit" | "pan" | null;
  pointerId: number | null;
  pointerCaptured: boolean;
  startPointerX: number;
  startPointerY: number;
  latestPointerX: number;
  latestPointerY: number;
  startBearing: number;
  startPitch: number;
  rafId: number | null;
  inertiaRafId: number | null;
  lastTimestamp: number;
  velocityX: number;
  velocityY: number;
  nativeSuspended: boolean;
  disposed: boolean;
}

/** Source-of-truth camera model for the 3D Earth look-at navigation. */
export interface LookAtCameraState {
  target: { lng: number; lat: number } | null;
  targetElevationM: number;
  rangeM: number;
  headingDeg: number;
  tiltDeg: number;
  rollDeg: number;
}

// Disable custom inertia until the direct orbit is proven stable (Phase 7).
// Correctness beats imitation: native handlers are restored immediately and
// no post-release camera motion can occur.
const ORBIT_INERTIA_ENABLED = false;
const ORBIT_INERTIA_MAX_FRAMES = 11; // ~180ms at 60fps
const ORBIT_INERTIA_MIN_VELOCITY = 0.4;

export interface EarthCameraControllerOptions {
  reducedMotion?: boolean;
  debug?: boolean;
}

export class EarthCameraController {
  private map: MLMap;
  private canvas: HTMLCanvasElement | null = null;
  private mode: MapViewMode = "standard";
  private reducedMotion: boolean;
  private debug: boolean;

  // Look-at state (source of truth while navigating).
  private target: MLLngLat | null = null;
  private targetElevationM = 0;
  private rangeM = 0;
  private headingDeg = 0;
  private tiltDeg = 0;

  // Lifecycle / gesture bookkeeping.
  private rt: OrbitRuntimeState = {
    phase: "idle",
    gesture: null,
    pointerId: null,
    pointerCaptured: false,
    startPointerX: 0,
    startPointerY: 0,
    latestPointerX: 0,
    latestPointerY: 0,
    startBearing: 0,
    startPitch: 0,
    rafId: null,
    inertiaRafId: null,
    lastTimestamp: 0,
    velocityX: 0,
    velocityY: 0,
    nativeSuspended: false,
    disposed: false,
  };
  private snapshot: OrbitSnapshot | null = null;
  private prevCursor: string | null = null;
  private nativeSnapshot: NativeHandlerSnapshot | null = null;
  private debugEl: HTMLDivElement | null = null;

  /** Resolves the cursor that should be shown after orbit ends, based on the
   *  current active tool. Assigned by MapCanvas so cursor restoration is
   *  always correct (Phase 13/15). */
  cursorResolver: (() => string) | null = null;

  // Bound listeners added only while an orbit is active (Phase 4/18).
  private readonly onWindowPointerUp = (e: PointerEvent) => {
    if (this.rt.phase === "active") this.finishOrbit("pointerup", e.pointerId);
  };
  private readonly onWindowPointerCancel = (e: PointerEvent) => {
    if (this.rt.phase === "active") this.cancelOrbit("pointercancel", e.pointerId);
  };

  constructor(map: MLMap, options: EarthCameraControllerOptions = {}) {
    this.map = map;
    this.reducedMotion = options.reducedMotion ?? false;
    this.debug = options.debug ?? false;
  }

  // --- Mode / state ---------------------------------------------------------

  setViewMode(mode: MapViewMode): void {
    this.mode = mode;
  }

  getViewMode(): MapViewMode {
    return this.mode;
  }

  isActive(): boolean {
    return this.rt.phase === "active";
  }

  getPhase(): OrbitPhase {
    return this.rt.phase;
  }

  /** Read the current map camera into the look-at model. */
  syncFromMap(): void {
    const map = this.map;
    this.headingDeg = normalizeHeading(map.getBearing());
    this.tiltDeg = map.getPitch();
    this.target = map.getCenter();
    this.rangeM = clampRange(rangeFromZoom(map.getZoom(), this.canvasHeight()));
    this.targetElevationM = this.readElevation(this.target);
  }

  setTarget(lngLat: LngLatLike): void {
    this.target = maplibregl.LngLat.convert(lngLat);
    this.targetElevationM = this.readElevation(this.target);
  }

  getTarget(): MLLngLat | null {
    return this.target;
  }

  getState(): LookAtCameraState {
    return {
      target: this.target ? { lng: this.target.lng, lat: this.target.lat } : null,
      targetElevationM: this.targetElevationM,
      rangeM: this.rangeM,
      headingDeg: this.headingDeg,
      tiltDeg: this.tiltDeg,
      rollDeg: 0,
    };
  }

  // --- Public navigation primitives (used by compass + gestures) ----------

  setBearing(bearing: number): void {
    this.headingDeg = normalizeHeading(bearing);
    if (this.mode === "earth3d") this.writeCamera(true);
    else this.map.setBearing(this.headingDeg);
  }

  nudgeBearing(deltaDeg: number): void {
    this.setBearing(this.headingDeg + deltaDeg);
  }

  setPitch(pitch: number): void {
    this.tiltDeg = clampTilt(pitch, this.map.getMaxPitch());
    if (this.mode === "earth3d") this.writeCamera(true);
    else this.map.setPitch(this.tiltDeg);
  }

  nudgePitch(deltaDeg: number): void {
    this.setPitch(this.tiltDeg + deltaDeg);
  }

  resetNorth(): void {
    this.headingDeg = 0;
    if (this.mode === "earth3d") this.writeCamera(false);
    else this.map.easeTo({ bearing: 0, duration: this.reducedMotion ? 0 : 300 });
  }

  resetTilt(): void {
    this.tiltDeg = 0;
    if (this.mode === "earth3d") this.writeCamera(false);
    else this.map.easeTo({ pitch: 0, duration: this.reducedMotion ? 0 : 300 });
  }

  resetView(): void {
    this.headingDeg = 0;
    this.tiltDeg = 0;
    if (this.mode === "earth3d") this.writeCamera(false);
    else this.map.easeTo({ bearing: 0, pitch: 0, duration: this.reducedMotion ? 0 : 300 });
  }

  /** Wheel dolly. `delta` is the raw wheel deltaY; positive zooms out. */
  dolly(delta: number): void {
    if (this.mode !== "earth3d") return;
    this.rangeM = clampRange(this.rangeM * Math.exp(delta * DOLLY_WHEEL_SCALE));
    this.writeCamera(true);
  }

  // --- Canonical entry points (Phase 3) ------------------------------------

  beginOrbit(clientX: number, clientY: number, pointerId: number, canvas: HTMLCanvasElement): void {
    // Single entry: ignore if already active or disposed.
    if (this.rt.phase !== "idle" || this.rt.disposed) return;
    this.rt.phase = "starting";
    this.canvas = canvas;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const ground = this.safeUnproject(px, py);
    this.snapshot = {
      startPointer: { x: clientX, y: clientY },
      startHeading: this.headingDeg,
      startTilt: this.tiltDeg,
      startRange: this.rangeM,
      startTarget: this.target ?? this.map.getCenter(),
      startGround: ground,
      startCenter: this.map.getCenter(),
    };

    this.rt.gesture = "orbit";
    this.rt.startPointerX = clientX;
    this.rt.startPointerY = clientY;
    this.rt.latestPointerX = clientX;
    this.rt.latestPointerY = clientY;
    this.rt.lastTimestamp = performance.now();
    this.rt.velocityX = 0;
    this.rt.velocityY = 0;
    this.rt.pointerId = pointerId;
    this.rt.pointerCaptured = false;

    // Pointer capture safety (Phase 4).
    try {
      canvas.setPointerCapture(pointerId);
      this.rt.pointerCaptured = canvas.hasPointerCapture ? canvas.hasPointerCapture(pointerId) : true;
    } catch {
      this.rt.pointerCaptured = false;
    }

    this.prevCursor = canvas.style.cursor;
    canvas.style.cursor = "grabbing";

    this.suspendNativeInteractions();
    this.addWindowFallbackListeners();
    if (this.debug) this.ensureDebugEl();

    // Stop any in-flight camera animation before we take over (Phase 10).
    this.stopMapCamera();

    this.rt.phase = "active";
    this.debugLog("beginOrbit", { phase: this.rt.phase, captured: this.rt.pointerCaptured });
  }

  beginPan(clientX: number, clientY: number, pointerId: number, canvas: HTMLCanvasElement): void {
    if (this.rt.phase !== "idle" || this.rt.disposed) return;
    this.rt.phase = "starting";
    this.canvas = canvas;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const ground = this.safeUnproject(px, py);
    this.snapshot = {
      startPointer: { x: clientX, y: clientY },
      startHeading: this.headingDeg,
      startTilt: this.tiltDeg,
      startRange: this.rangeM,
      startTarget: this.target ?? this.map.getCenter(),
      startGround: ground,
      startCenter: this.map.getCenter(),
    };

    this.rt.gesture = "pan";
    this.rt.startPointerX = clientX;
    this.rt.startPointerY = clientY;
    this.rt.latestPointerX = clientX;
    this.rt.latestPointerY = clientY;
    this.rt.pointerId = pointerId;
    this.rt.pointerCaptured = false;
    try {
      canvas.setPointerCapture(pointerId);
      this.rt.pointerCaptured = canvas.hasPointerCapture ? canvas.hasPointerCapture(pointerId) : true;
    } catch {
      this.rt.pointerCaptured = false;
    }
    this.prevCursor = canvas.style.cursor;
    canvas.style.cursor = "grabbing";
    // Pan does not conflict with native handlers in 3D Earth mode (they are
    // already suspended by the mode effect); we still snapshot so a tool
    // change mid-pan restores correctly.
    this.suspendNativeInteractions();
    this.addWindowFallbackListeners();
    this.stopMapCamera();
    this.rt.phase = "active";
  }

  updateOrbit(clientX: number, clientY: number): void {
    if (this.rt.phase !== "active" || this.rt.gesture !== "orbit") return;
    const now = performance.now();
    if (this.rt.lastTimestamp) {
      const dt = Math.max(1, now - this.rt.lastTimestamp);
      this.rt.velocityX = (clientX - this.rt.latestPointerX) / dt;
      this.rt.velocityY = (clientY - this.rt.latestPointerY) / dt;
    }
    this.rt.lastTimestamp = now;
    this.rt.latestPointerX = clientX;
    this.rt.latestPointerY = clientY;
    this.scheduleTick();
  }

  updatePan(clientX: number, clientY: number): void {
    if (this.rt.phase !== "active" || this.rt.gesture !== "pan") return;
    this.rt.latestPointerX = clientX;
    this.rt.latestPointerY = clientY;
    this.scheduleTick();
  }

  // --- Canonical exit points (Phase 3) -------------------------------------

  /** Normal completion (pointer released over the map). */
  endOrbit(pointerId?: number): void {
    this.finishOrbit("pointerup", pointerId);
  }

  /** Soft cancel — used by pointercancel / lostpointercapture / tool change. */
  cancelOrbit(reason: OrbitEndReason = "cancelled", pointerId?: number): void {
    if (this.rt.phase !== "active") return;
    if (pointerId != null && this.rt.pointerId != null && pointerId !== this.rt.pointerId) return;
    this.cleanup(reason);
  }

  /** Canonical, idempotent finish used by every exit path. */
  finishOrbit(reason: OrbitEndReason, pointerId?: number): void {
    if (this.rt.phase !== "active") return;
    if (pointerId != null && this.rt.pointerId != null && pointerId !== this.rt.pointerId) return;
    // Inertia is disabled by default (Phase 7); startInertia early-returns
    // when ORBIT_INERTIA_ENABLED is false. The call is kept so a future,
    // capped implementation can be re-enabled in one place.
    const snapshot = this.snapshot;
    const hadVelocity =
      !this.reducedMotion &&
      !!snapshot &&
      (Math.abs(this.rt.velocityX) > 0.01 || Math.abs(this.rt.velocityY) > 0.01);
    if (hadVelocity) this.startInertia(snapshot!);
    this.cleanup(reason);
  }

  /** Defensive, idempotent recovery — safe to call from anywhere (Phase 17). */
  recover(reason: OrbitEndReason = "recover"): void {
    if (this.rt.phase === "idle" || this.rt.phase === "ending") return;
    this.cleanup(reason);
  }

  dispose(): void {
    this.rt.disposed = true;
    this.recover("disposed");
    this.removeWindowFallbackListeners();
    this.stopRaf();
    this.stopInertia();
    this.removeDebugEl();
  }

  // --- Internals -----------------------------------------------------------

  private stopMapCamera(): void {
    try {
      this.map.stop();
    } catch {
      /* ignore */
    }
  }

  private cleanup(reason: OrbitEndReason): void {
    this.rt.phase = "ending";
    try {
      this.stopRaf();
      this.stopInertia();
      this.releaseCapture();
    } finally {
      this.restoreNativeInteractions();
      this.restoreCursor();
      this.removeWindowFallbackListeners();
      this.clearTempState();
      this.rt.phase = "idle";
      this.removeDebugEl();
      this.debugLog("finishOrbit", { reason, phase: this.rt.phase });
    }
  }

  private clearTempState(): void {
    this.rt.gesture = null;
    this.rt.pointerId = null;
    this.rt.pointerCaptured = false;
    this.rt.latestPointerX = 0;
    this.rt.latestPointerY = 0;
    this.rt.startPointerX = 0;
    this.rt.startPointerY = 0;
    this.rt.lastTimestamp = 0;
    this.rt.velocityX = 0;
    this.rt.velocityY = 0;
    this.snapshot = null;
  }

  private canvasHeight(): number {
    const c = this.map.getCanvas();
    return c && c.clientHeight > 0 ? c.clientHeight : 800;
  }

  private readElevation(lngLat: MLLngLat | null): number {
    if (!lngLat) return 0;
    try {
      const e = this.map.queryTerrainElevation(lngLat);
      return typeof e === "number" && Number.isFinite(e) ? e : 0;
    } catch {
      return 0;
    }
  }

  private safeUnproject(x: number, y: number): MLLngLat {
    try {
      return this.map.unproject([x, y]);
    } catch {
      return this.map.getCenter();
    }
  }

  private writeCamera(immediate: boolean): void {
    if (!this.target) return;
    // In 3D Earth mode the look-at range drives the zoom; in standard 2D mode
    // the range is intentionally ignored so the orbit only changes
    // bearing/pitch and preserves the current zoom (a zero/uninitialised
    // range would otherwise resolve to max zoom).
    const zoom =
      this.mode === "earth3d"
        ? clampZoom(zoomFromRange(this.rangeM, this.canvasHeight()), this.map)
        : this.map.getZoom();
    const camera = {
      center: this.target,
      zoom,
      bearing: normalizeHeading(this.headingDeg),
      pitch: clampTilt(this.tiltDeg, this.map.getMaxPitch()),
    };
    if (immediate) this.map.jumpTo(camera);
    else this.map.easeTo({ ...camera, duration: this.reducedMotion ? 0 : 350 });
  }

  private releaseCapture(): void {
    if (this.canvas && this.rt.pointerCaptured && this.rt.pointerId != null) {
      try {
        if (this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(this.rt.pointerId)) {
          this.canvas.releasePointerCapture(this.rt.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    this.rt.pointerCaptured = false;
    this.rt.pointerId = null;
  }

  private restoreCursor(): void {
    if (!this.canvas) return;
    const next = this.cursorResolver ? this.cursorResolver() : this.prevCursor ?? "";
    this.canvas.style.cursor = next;
    this.prevCursor = null;
  }

  // --- Native handler snapshot / restore (Phase 8) -------------------------

  private suspendNativeInteractions(): void {
    const map = this.map;
    const snapshot: NativeHandlerSnapshot = {
      dragPan: map.dragPan.isEnabled(),
      dragRotate: map.dragRotate.isEnabled(),
      scrollZoom: map.scrollZoom.isEnabled(),
      boxZoom: map.boxZoom.isEnabled(),
      doubleClickZoom: map.doubleClickZoom.isEnabled(),
      keyboard: map.keyboard.isEnabled(),
      touchZoomRotate: map.touchZoomRotate.isEnabled(),
      touchPitch: map.touchPitch.isEnabled(),
    };
    this.nativeSnapshot = snapshot;
    // Disable only the handlers that conflict with a custom orbit/pan gesture.
    // Everything else (scrollZoom, keyboard, ...) is left untouched and
    // restored exactly from the snapshot.
    if (snapshot.dragPan) map.dragPan.disable();
    if (snapshot.dragRotate) map.dragRotate.disable();
    this.rt.nativeSuspended = true;
  }

  private restoreNativeInteractions(): void {
    if (!this.rt.nativeSuspended || !this.nativeSnapshot) {
      this.rt.nativeSuspended = false;
      return;
    }
    const s = this.nativeSnapshot;
    const map = this.map;
    this.applyHandler(map.dragPan, s.dragPan);
    this.applyHandler(map.dragRotate, s.dragRotate);
    this.applyHandler(map.scrollZoom, s.scrollZoom);
    this.applyHandler(map.boxZoom, s.boxZoom);
    this.applyHandler(map.doubleClickZoom, s.doubleClickZoom);
    this.applyHandler(map.keyboard, s.keyboard);
    this.applyHandler(map.touchZoomRotate, s.touchZoomRotate);
    this.applyHandler(map.touchPitch, s.touchPitch);
    this.nativeSnapshot = null;
    this.rt.nativeSuspended = false;
  }

  private applyHandler(
    handler: { enable(): void; disable(): void; isEnabled(): boolean },
    target: boolean
  ): void {
    try {
      if (target) handler.enable();
      else handler.disable();
    } catch {
      /* handler may be unavailable in some runtimes */
    }
  }

  // --- Window fallback listeners (Phase 4) ---------------------------------

  private addWindowFallbackListeners(): void {
    try {
      window.addEventListener("pointerup", this.onWindowPointerUp);
      window.addEventListener("pointercancel", this.onWindowPointerCancel);
    } catch {
      /* ignore */
    }
  }

  private removeWindowFallbackListeners(): void {
    try {
      window.removeEventListener("pointerup", this.onWindowPointerUp);
      window.removeEventListener("pointercancel", this.onWindowPointerCancel);
    } catch {
      /* ignore */
    }
  }

  // --- Animation frames (Phase 6) ------------------------------------------

  private scheduleTick(): void {
    if (this.rt.rafId !== null) return;
    this.rt.rafId = requestAnimationFrame(() => {
      this.rt.rafId = null;
      this.tick();
    });
  }

  private stopRaf(): void {
    if (this.rt.rafId !== null) {
      cancelAnimationFrame(this.rt.rafId);
      this.rt.rafId = null;
    }
  }

  private stopInertia(): void {
    if (this.rt.inertiaRafId !== null) {
      cancelAnimationFrame(this.rt.inertiaRafId);
      this.rt.inertiaRafId = null;
    }
  }

  private tick(): void {
    // Never run if we are no longer active (Phase 6 + 12).
    if (this.rt.phase !== "active") return;
    try {
      if (this.rt.gesture === "orbit" && this.snapshot) {
        const dx = this.rt.latestPointerX - this.snapshot.startPointer.x;
        const dy = this.rt.latestPointerY - this.snapshot.startPointer.y;
        this.headingDeg = normalizeHeading(this.snapshot.startHeading + dx * ORBIT_HEADING_SENSITIVITY);
        this.tiltDeg = clampTilt(this.snapshot.startTilt - dy * ORBIT_TILT_SENSITIVITY, this.map.getMaxPitch());
        this.target = this.snapshot.startTarget;
        this.writeCamera(true);
        this.updateDebug();
      } else if (this.rt.gesture === "pan" && this.snapshot && this.canvas) {
        const rect = this.canvas.getBoundingClientRect();
        const groundNow = this.safeUnproject(this.rt.latestPointerX - rect.left, this.rt.latestPointerY - rect.top);
        const dLng = this.snapshot.startGround.lng - groundNow.lng;
        const dLat = this.snapshot.startGround.lat - groundNow.lat;
        this.target = new maplibregl.LngLat(
          this.snapshot.startTarget.lng + dLng,
          this.snapshot.startTarget.lat + dLat
        );
        this.writeCamera(true);
      }
    } catch (err) {
      // One camera error must never leave the map locked (Phase 24).
      this.reportError(err);
      this.recover("internal-error");
    }
  }

  // Inertia is disabled by default (Phase 7). Kept for a future, capped,
  // hard-stop implementation once direct orbit is proven stable.
  private startInertia(_snapshot: OrbitSnapshot): void {
    if (!ORBIT_INERTIA_ENABLED) return;
    if (this.rt.inertiaRafId !== null) cancelAnimationFrame(this.rt.inertiaRafId);
    let latest = { x: this.rt.latestPointerX, y: this.rt.latestPointerY };
    let vx = this.rt.velocityX;
    let vy = this.rt.velocityY;
    const FRAME_MS = 16;
    let frames = 0;
    const loop = () => {
      if (this.rt.phase !== "active" || !this.snapshot) {
        this.rt.inertiaRafId = null;
        this.removeDebugEl();
        return;
      }
      frames++;
      vx *= 0.85;
      vy *= 0.85;
      latest = { x: latest.x + vx * FRAME_MS, y: latest.y + vy * FRAME_MS };
      const dx = latest.x - this.snapshot.startPointer.x;
      const dy = latest.y - this.snapshot.startPointer.y;
      this.headingDeg = normalizeHeading(this.snapshot.startHeading + dx * ORBIT_HEADING_SENSITIVITY);
      this.tiltDeg = clampTilt(this.snapshot.startTilt - dy * ORBIT_TILT_SENSITIVITY, this.map.getMaxPitch());
      this.target = this.snapshot.startTarget;
      this.writeCamera(true);
      if (frames < ORBIT_INERTIA_MAX_FRAMES && (Math.abs(vx) > ORBIT_INERTIA_MIN_VELOCITY || Math.abs(vy) > ORBIT_INERTIA_MIN_VELOCITY)) {
        this.rt.inertiaRafId = requestAnimationFrame(loop);
      } else {
        this.rt.inertiaRafId = null;
        this.removeDebugEl();
      }
    };
    this.rt.inertiaRafId = requestAnimationFrame(loop);
  }

  private reportError(err: unknown): void {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.warn("[earthCameraController] orbit update error (recovered):", err);
    }
  }

  private debugLog(event: string, data: Record<string, unknown>): void {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.debug("[earthCameraController]", event, data);
  }

  private ensureDebugEl(): void {
    if (this.debugEl) return;
    const el = document.createElement("div");
    el.setAttribute("data-testid", "earth-camera-debug");
    el.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:99999;padding:6px 10px;" +
      "background:rgba(0,0,0,0.8);color:#5eead4;font:11px/1.4 monospace;" +
      "border-radius:6px;pointer-events:none;white-space:pre;";
    document.body.appendChild(el);
    this.debugEl = el;
  }

  private updateDebug(): void {
    if (!this.debug || !this.debugEl) return;
    this.debugEl.textContent =
      `earth  mode ${this.mode}\n` +
      `phase ${this.rt.phase}  gesture ${this.rt.gesture}\n` +
      `head ${this.headingDeg.toFixed(1)}  tilt ${this.tiltDeg.toFixed(1)}\n` +
      `range ${(this.rangeM / 1000).toFixed(1)} km`;
  }

  private removeDebugEl(): void {
    if (this.debugEl && this.debugEl.parentNode) {
      this.debugEl.parentNode.removeChild(this.debugEl);
    }
    this.debugEl = null;
  }
}

function clampZoom(zoom: number, map: MLMap): number {
  return Math.min(Math.max(zoom, map.getMinZoom()), map.getMaxZoom());
}
