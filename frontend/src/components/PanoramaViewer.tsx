import { useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

interface Props {
  url: string;
  label: string;
  /** Capture heading in degrees [0, 360) true-north (EXIF GPSImgDirection),
   *  used to set the viewer's initial facing direction so direction-tagged
   *  photos play like a continuous ride instead of snapping to centre. */
  startHeading?: number;
  onClose: () => void;
  /** View persistence lifted to the parent (MapCanvas) so the ride stays
   *  continuous even across a FULL remount (React swapping between this
   *  viewer and CylinderPanoramaViewer for a neighbour with a different
   *  is_360 flag). Angles are in photo-sphere-viewer radians. */
  initialYaw?: number;
  initialPitch?: number;
  initialZoom?: number;
  /** Report the final view back so MapCanvas stays the source of truth. */
  onPersist?: (yaw: number, pitch: number, zoom: number) => void;
  /** Read the persisted viewport at effect-run time. Unlike the render-
   *  time `initialYaw/Pitch/Zoom` props (which are snapshotted when the
   *  previous photo's cleanup hasn't run yet — a race on remount), this
   *  is called AFTER the previous viewer's cleanup, so it always returns
   *  the freshest persisted values. */
  getPersistedView?: () => { active: boolean; yaw: number; pitch: number; fov: number };
}

/** Real 360° equirectangular sphere viewer — used instead of the flat
 * lightbox when a photo is detected as a true panorama (GPano XMP tag or
 * a 2:1 aspect ratio). Drag to look around, scroll to zoom, matching the
 * standard Street-View-style interaction model. */
export function PanoramaViewer({ url, label, startHeading, onClose, initialYaw, initialPitch, initialZoom, onPersist, getPersistedView }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Persist zoom and viewing direction across photo transitions so the
  // slideshow doesn't snap back to defaults on every advance — the user
  // complained that setting a viewport on photo A gets immediately reset
  // when photo B loads. Seeded from the parent on each effect run so a
  // new url always picks up the latest persisted viewport (useRef's
  // argument is only consumed on the first mount, which is why the old
  // implementation appeared to "reset" on every photo change).
  /** Live interaction state — updated by user drag/zoom events. These
   *  are the source for what to restore on the NEXT photo. */
  const zoomRef = useRef<number | null>(initialZoom ?? null);
  const yawRef = useRef<number | null>(initialYaw ?? null);
  const pitchRef = useRef<number | null>(initialPitch ?? null);
  // On every [url] change, sync from the freshly-passed props. Without
  // this, the refs only ever hold the value they had at first mount, so
  // the second photo onward would always re-seed from the very first
  // photo's final state, not the most recent one.
  // Also consult getPersistedView() — it's evaluated at effect-run time
  // (after the previous photo's cleanup has persisted), closing the
  // render-time staleness race on a full remount.
  const persisted = getPersistedView?.();
  if (persisted?.active) {
    zoomRef.current = persisted.fov;
    yawRef.current = persisted.yaw;
    pitchRef.current = persisted.pitch;
  } else {
    zoomRef.current = initialZoom ?? zoomRef.current;
    yawRef.current = initialYaw ?? yawRef.current;
    pitchRef.current = initialPitch ?? pitchRef.current;
  }

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    setError(null);

    // React StrictMode (dev only) mounts this effect, cleans it up, then
    // mounts it again — all synchronously, before any timer can fire. If we
    // built the Viewer immediately, the first (doomed) instance would start
    // fetching `url`; its cleanup aborts that fetch; and because browsers
    // coalesce concurrent requests to the same URL, that abort also kills
    // the second instance's identical in-flight request, leaving it stuck
    // forever. Deferring construction past a macrotask means the aborted
    // "phantom" mount's timer gets cleared before it ever fires, so only
    // the real, final mount ever creates a Viewer or issues a fetch.
    let viewer: Viewer | null = null;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    // Snapshot the persisted viewport NOW (effect-run time), before the
    // Viewer exists and before the library can fire position-updated /
    // zoom-updated with the image's own XMP InitialView* values. These
    // are the values we restore after every panorama load.
    const restoreZoom = zoomRef.current;
    const restoreYaw = yawRef.current;
    const restorePitch = pitchRef.current;
    const timer = setTimeout(() => {
      const psOptions: {
        container: HTMLElement;
        panorama: string;
        navbar: string[];
        loadingTxt: string;
        withCredentials: boolean;
        defaultYaw?: number;
        defaultZoomLvl?: number;
        defaultPitch?: number;
      } = {
        container,
        panorama: url,
        navbar: ["zoom", "move", "fullscreen"],
        loadingTxt: "Loading panorama…",
        withCredentials: true,
      };
      // Restore persisted zoom level instead of the library default (50).
      if (restoreZoom != null) {
        psOptions.defaultZoomLvl = restoreZoom;
      }
      // Restore persisted yaw if available; fall back to startHeading.
      if (restoreYaw != null) {
        psOptions.defaultYaw = restoreYaw;
      } else if (typeof startHeading === "number" && isFinite(startHeading)) {
        psOptions.defaultYaw = (startHeading % 360) * (Math.PI / 180);
      }
      // Also restore pitch if available
      if (restorePitch != null) {
        psOptions.defaultPitch = restorePitch;
      }
      viewer = new Viewer(psOptions);
      viewer.addEventListener("panorama-error", () => {
        setError("Couldn't load this as a 360° panorama — the file may not actually be equirectangular.");
      });
      // Apply saved zoom + yaw AFTER the panorama has loaded AND after
      // photo-sphere-viewer has had a chance to apply the image's own
      // GPano XMP "InitialView*" metadata.
      //
      // Why this matters: 360° cameras embed InitialViewHeadingDegrees /
      // InitialViewPitchDegrees / InitialViewFovDegrees in the file's
      // GPano XMP block. The library's load pipeline (setPanorama ->
      // cleanPanoramaOptions) OVERRIDES our defaultYaw/defaultPitch with
      // that per-image heading when it applies options.position. So even
      // though we pass defaultYaw, every photo snaps to its OWN capture
      // heading instead of the viewport the user set on the previous
      // photo — the "view resets on next photo" bug.
      //
      // "ready" fires during init(), BEFORE the XMP position is applied
      // (setPanorama: init() -> dispatch ready -> rotate(XMP position)),
      // so applying here would just get overwritten. We defer past a
      // macrotask so we run after the library's synchronous XMP rotate.
      viewer.addEventListener("panorama-loaded", () => {
        // Clear any pending apply from a previous panorama load.
        if (applyTimer) clearTimeout(applyTimer);
        applyTimer = setTimeout(() => {
          // The library has just applied the image's own XMP
          // InitialView* heading/pitch/fov and fired position-updated /
          // zoom-updated — which OVERWROTE our refs. Restore the user's
          // persisted viewport (captured before the load), then re-assert
          // the refs from the viewer's now-correct state.
          if (restoreZoom != null) viewer!.zoom(restoreZoom);
          if (restoreYaw != null || restorePitch != null) {
            viewer!.rotate({ yaw: restoreYaw ?? 0, pitch: restorePitch ?? 0 });
          }
          // Re-assert the refs from the viewer's now-correct state so the
          // parent's source of truth (onPersist) stays in sync with what
          // the user actually sees.
          zoomRef.current = viewer!.getZoomLevel();
          const pos = viewer!.getPosition();
          yawRef.current = pos.yaw;
          pitchRef.current = pos.pitch;
          onPersist?.(pos.yaw, pos.pitch, zoomRef.current);
        }, 0);
      });
      // Keep refs in sync on every change (for live interaction tracking).
      viewer.addEventListener("zoom-updated", ({ zoomLevel }: { zoomLevel: number }) => {
        zoomRef.current = zoomLevel;
      });
      viewer.addEventListener("position-updated", ({ position }: { position: { yaw: number; pitch: number } }) => {
        yawRef.current = position.yaw;
        pitchRef.current = position.pitch;
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      // CRITICAL: read final state BEFORE destroying — event listeners
      // may not have fired for the last user interaction, but the viewer
      // always holds the true current state. This is what ensures the
      // next photo opens at the viewport the user actually set.
      if (viewer) {
        if (applyTimer) clearTimeout(applyTimer);
        zoomRef.current = viewer.getZoomLevel();
        const pos = viewer.getPosition();
        yawRef.current = pos.yaw;
        pitchRef.current = pos.pitch;
        // Report the final view back to the parent so it survives even a
        // full remount (React swapping PanoramaViewer <-> Cylinder).
        onPersist?.(pos.yaw, pos.pitch, zoomRef.current);
        viewer.destroy();
      }
    };
  }, [url]);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000" }}
      data-testid="panorama-viewer"
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {error && (
        <div
          style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            color: "#fff", background: "rgba(0,0,0,0.7)", padding: "16px 20px", borderRadius: 8,
            fontSize: 13, maxWidth: 340, textAlign: "center",
          }}
        >
          {error}
        </div>
      )}
      <div style={{ position: "absolute", top: 14, left: 18, color: "#fff", fontSize: 13, fontWeight: 600, textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>
        📷 {label} <span style={{ opacity: 0.7, fontWeight: 400 }}>· 360° — drag to look around</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        data-testid="panorama-viewer-close"
        style={{
          position: "absolute", top: 12, right: 16, zIndex: 1001,
          background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff",
          borderRadius: "var(--radius-sm)", padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}
      >
        Close ✕
      </button>
    </div>
  );
}
