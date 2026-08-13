import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

async function loadImageTexture(src: string): Promise<THREE.Texture> {
  const res = await fetch(src, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const texture = await new THREE.TextureLoader().loadAsync(objectUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* ------------------------------------------------------------------ */
/*  Bearing helpers — drive the Google-style directional arrow overlay  */
/* ------------------------------------------------------------------ */

/** Haversine initial bearing from (lat1,lon1) to (lat2,lon2) in degrees [0, 360). */
function computeBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Normalize degrees to [-180, 180). */
function normalizeAngle(deg: number): number {
  return ((deg % 360) + 540) % 360 - 180;
}

export interface SiblingInfo {
  index: number;
  lat: number;
  lon: number;
  label: string;
}

interface Props {
  url: string;
  label: string;
  /** EXIF capture heading — used ONLY for the arrow overlay's compass
   *  maths, NOT to rotate the camera (the image center IS the capture
   *  direction, so yaw = 0 is always correct for the initial view). */
  startHeading?: number;
  mode?: "360" | "180";
  onClose: () => void;
  /** View persistence lifted to the parent (MapCanvas). These seed the
   *  refs on mount (including on a FULL remount — e.g. when React swaps
   *  between <PanoramaViewer> and <CylinderPanoramaViewer> because a
   *  neighbour photo has a different is_360 flag), so the ride stays
   *  continuous no matter what React does to this component. */
  initialYaw?: number;
  initialPitch?: number;
  initialFov?: number;
  /** Push the latest view back up so MapCanvas stays the single source
   *  of truth; on every cleanup (photo advance) we report yaw/pitch/fov. */
  onPersist?: (yaw: number, pitch: number, fov: number) => void;
  /** Read the persisted viewport at effect-run time (after the previous
   *  photo's cleanup has persisted) — closes the render-time staleness
   *  race on a full remount, same as PanoramaViewer. */
  getPersistedView?: () => { active: boolean; yaw: number; pitch: number; fov: number };
  /** Current photo's GPS position — needed to compute bearings to siblings. */
  currentLat?: number;
  currentLon?: number;
  /** Sibling photos for the directional arrow overlay. */
  siblings?: SiblingInfo[];
  /** Jump to a specific photo by its list index. */
  onGotoPhoto?: (index: number) => void;
}

type View = "360" | "180" | "flat";

export function CylinderPanoramaViewer({
  url, label, mode = "360", startHeading, onClose,
  currentLat, currentLon, siblings, onGotoPhoto,
  initialYaw, initialPitch, initialFov, onPersist, getPersistedView,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const arrowOverlayRef = useRef<HTMLDivElement | null>(null);
  /** Persists zoom across photo transitions so the view doesn't snap
   *  back to default FOV every time the slideshow advances. Seeded from
   *  the parent each mount so a remount can't lose the user's zoom. */
  const fovRef = useRef(initialFov ?? 75);
  /** Persist the user's look-direction (yaw/pitch) across photo
   *  transitions, exactly like fovRef above. Without this, every
   *  slideshow advance tears down the THREE scene and rebuilds it with
   *  yaw = pitch = 0, which snaps the camera back to image-centre —
   *  the "view keeps resetting on the next image" bug. */
  const yawRef = useRef(initialYaw ?? 0);
  const pitchRef = useRef(initialPitch ?? 0);
  // On every [url, view] change, re-seed the refs from the freshly
  // passed props. useRef's argument is only consumed on the first mount,
  // so without this re-sync the refs would hold the value from photo A
  // forever, making every subsequent photo (B, C, …) snap back to A's
  // exit viewport instead of the most recent one.
  // getPersistedView() is evaluated at effect-run time (after the
  // previous photo's cleanup has persisted), closing the render-time
  // staleness race on a full remount.
  const persisted = getPersistedView?.();
  if (persisted?.active) {
    fovRef.current = persisted.fov;
    yawRef.current = persisted.yaw;
    pitchRef.current = persisted.pitch;
  } else {
    fovRef.current = initialFov ?? fovRef.current;
    yawRef.current = initialYaw ?? yawRef.current;
    pitchRef.current = initialPitch ?? pitchRef.current;
  }
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(mode);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    setError(null);
    if (view === "flat") return;

    const scene = new THREE.Scene();
    // Restore persisted zoom instead of hardcoding 75 — prevents the
    // "view resets on every slide advance" issue the user reported.
    const camera = new THREE.PerspectiveCamera(fovRef.current, container.clientWidth / container.clientHeight, 0.1, 1100);
    camera.position.set(0, 0, 0.01);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    let mesh: THREE.Mesh | null = null;
    let disposed = false;
    const yawLimitDeg = view === "180" ? 90 : 180;
    const yawLimit = view === "180" ? Math.PI / 2 - 0.02 : Infinity;

    loadImageTexture(url)
      .then((texture) => {
        if (disposed) return;
        const img = texture.image as HTMLImageElement;
        const aspect = img.width / img.height;
        const radius = 100;
        const circumference = view === "180" ? Math.PI * radius : 2 * Math.PI * radius;
        const height = circumference / aspect;
        const thetaLength = view === "180" ? Math.PI : 2 * Math.PI;
        const geometry = new THREE.CylinderGeometry(
          radius, radius, height, 96, 1, true, -thetaLength / 2, thetaLength,
        );
        geometry.scale(-1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.y = Math.PI;
        scene.add(mesh);
      })
      .catch(() => { if (!disposed) setError("Couldn't load image for the cylindrical view."); });

    /* ------------------------------------------------------------- */
    /*  Google-style directional arrow overlays                       */
    /*  One clickable arrow per sibling photo positioned at the       */
    /*  correct screen location based on the GPS bearing to that      */
    /*  sibling, just like Google Street View.                        */
    /* ------------------------------------------------------------- */
    const arrowEls: HTMLButtonElement[] = [];
    const overlay = arrowOverlayRef.current;
    const hasNav =
      siblings && siblings.length > 0 && onGotoPhoto &&
      typeof currentLat === "number" && typeof currentLon === "number";

    if (hasNav && overlay) {
      for (const sib of siblings!) {
        const bearing = computeBearing(currentLat!, currentLon!, sib.lat, sib.lon);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("aria-label", `Navigate to ${sib.label}`);
        // Google Street View-style: small semi-transparent white circle
        // with a dark chevron, positioned at the correct horizontal
        // bearing from the current view. The chevron rotates to hint at
        // the exact direction.
        btn.style.cssText = [
          "position:absolute",
          "top:62%",
          "width:44px",
          "height:44px",
          "border-radius:50%",
          "background:rgba(255,255,255,0.82)",
          "border:2px solid rgba(0,0,0,0.2)",
          "cursor:pointer",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "font-size:22px",
          "line-height:1",
          "color:#333",
          "box-shadow:0 2px 10px rgba(0,0,0,0.4)",
          "transition:opacity .12s,transform .12s",
          "z-index:1",
          "pointer-events:auto",
          "user-select:none",
          "transform:translateX(-50%)",
        ].join(";");
        btn.textContent = "▸";
        // Attach bearing metadata for the per-frame position update
        // (avoids a React re-render on every animation frame).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (btn as any)._bearing = bearing;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onGotoPhoto!(sib.index);
        });
        btn.addEventListener("mouseenter", () => { btn.style.background = "rgba(255,255,255,1)"; btn.style.transform = "translateX(-50%) scale(1.15)"; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "rgba(255,255,255,0.82)"; btn.style.transform = "translateX(-50%)"; });
        overlay.appendChild(btn);
        arrowEls.push(btn);
      }
    }

    // ---- interaction ----
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    // Restore the look-direction persisted from the previous photo so the
    // ride stays continuous; the image centre is the capture heading, so
    // a fresh open (yawRef === 0) still faces the right way. Clamp to the
    // current view's limits in case the user switched 360 <-> 180.
    let yaw = yawLimit !== Infinity
      ? Math.max(-yawLimit, Math.min(yawLimit, yawRef.current))
      : yawRef.current;
    let pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitchRef.current));

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yaw -= dx * 0.005;
      pitch -= dy * 0.005;
      if (yawLimit !== Infinity) yaw = Math.max(-yawLimit, Math.min(yawLimit, yaw));
      pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitch));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.fov = Math.max(35, Math.min(95, camera.fov + (e.deltaY > 0 ? 4 : -4)));
      camera.updateProjectionMatrix();
      // Persist so the next photo opens at the same zoom level.
      fovRef.current = camera.fov;
    };

    const el = renderer.domElement;
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("wheel", onWheel, { passive: false });

    const onResize = () => {
      if (!container.clientWidth) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      camera.rotation.order = "YXZ";
      camera.rotation.y = yaw;
      camera.rotation.x = pitch;
      renderer.render(scene, camera);

      // ---- update arrow screen positions every frame ----
      // The compass bearing the viewer is currently facing =
      //   startHeading (image centre) minus the yaw rotation.
      // Positive yaw = looking left (CCW) = compass bearing decreases.
      if (hasNav) {
        const viewCompass = (startHeading ?? 0) - (yaw * 180) / Math.PI;
        for (const btn of arrowEls) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bearing = (btn as any)._bearing as number;
          const rel = normalizeAngle(bearing - viewCompass);
          if (Math.abs(rel) <= yawLimitDeg) {
            const pct = 50 + (rel / yawLimitDeg) * 50;
            btn.style.left = `${pct}%`;
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
            // Slight rotation in the direction of travel for a visual hint
            btn.style.transform = `translateX(-50%) rotate(${rel * 0.3}deg)`;
          } else {
            btn.style.opacity = "0";
            btn.style.pointerEvents = "none";
          }
        }
      }
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      // CRITICAL: read the actual FOV from the live camera BEFORE
      // disposing — the wheel handler writes to fovRef too, but during
      // rapid slideshow advance the user's last scroll wheel tweak might
      // not have triggered a wheel event cleanly. Reading camera.fov
      // here guarantees the saved value matches what the user saw.
      fovRef.current = camera.fov;
      // Persist the look-direction the same way, so the next photo opens
      // where the user left off instead of snapping back to centre.
      yawRef.current = yaw;
      pitchRef.current = pitch;
      // Report the final view back to the parent so it survives even a
      // full remount (e.g. React swapping PanoramaViewer <-> Cylinder
      // when a neighbour photo has a different is_360 flag).
      onPersist?.(yaw, pitch, camera.fov);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("wheel", onWheel);
      mesh?.geometry.dispose();
      (mesh?.material as THREE.Material | undefined)?.dispose();
      renderer.dispose();
      if (el.parentNode === container) container.removeChild(el);
      // Remove arrow DOM elements
      for (const btn of arrowEls) btn.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, view]);

  const flatDrag = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000" }}
      data-testid="cylinder-panorama-viewer"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {view === "flat" ? (
        <div
          style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { if (!flatDrag.current) onClose(); flatDrag.current = false; }}
          onPointerDown={() => { flatDrag.current = false; }}
          onPointerMove={() => { flatDrag.current = true; }}
        >
          <img
            src={url} alt={label}
            style={{ maxWidth: "90vw", maxHeight: "82vh", borderRadius: "var(--radius-md)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)", userSelect: "none" }}
            draggable={false}
          />
        </div>
      ) : (
        <>
          <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
          {/* Arrow overlay — sibling arrows are injected imperatively
              into this div by the useEffect above (avoids 60-fps
              React re-renders while still letting React own the DOM
              node). pointer-events: none so drags pass through to the
              canvas; individual arrows set pointer-events: auto. */}
          <div
            ref={arrowOverlayRef}
            style={{ position: "absolute", inset: 0, zIndex: 1000, pointerEvents: "none" }}
          />
        </>
      )}
      {error && view !== "flat" && (
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
        📷 {label} <span style={{ opacity: 0.7, fontWeight: 400 }}>· {view === "flat" ? "flat" : view === "180" ? "180° curved" : "360° curved"} view — drag to look around</span>
      </div>
      <div style={{ position: "absolute", top: 12, right: 16, zIndex: 1001, display: "flex", gap: 8 }}>
        {(["360", "180", "flat"] as View[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setView(m)}
            style={{
              background: view === m ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)",
              border: "1px solid rgba(255,255,255,0.3)", color: "#fff",
              borderRadius: "var(--radius-sm)", padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >
            {m === "flat" ? "Flat" : `${m}°`}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          data-testid="cylinder-panorama-viewer-close"
          style={{
            background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff",
            borderRadius: "var(--radius-sm)", padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          Close ✕
        </button>
      </div>
    </div>
  );
}
