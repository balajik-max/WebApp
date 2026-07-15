import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

async function loadImageTexture(src: string): Promise<THREE.Texture> {
  // Fetch as a blob (with credentials) and hand three.js an object URL.
  // A plain cross-origin <img> taints the WebGL texture and renders black,
  // whereas a same-origin blob URL never taints — so the panorama shows.
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

interface Props {
  url: string;
  label: string;
  /** "360" wraps the image around a full cylinder (free look-around).
   *  "180" maps it onto a half cylinder and clamps the yaw so you can
   *  only sweep from one edge to the other — like a curved backdrop. */
  mode?: "360" | "180";
  onClose: () => void;
}

type View = "360" | "180" | "flat";

/** Wraps a SINGLE flat (non-equirectangular) image onto the inside of a
 *  cylinder and sits the camera at the centre, so dragging rotates your
 *  viewpoint around the photo — a Street-View-style look-around for plain
 *  site photos that have no true 360 capture. Scroll wheel zooms (FOV),
 *  drag pans the yaw/pitch. This is distinct from `PanoramaViewer`, which
 *  expects a real equirectangular panorama. A "Flat" toggle restores the
 *  original un-warped image. */
export function CylinderPanoramaViewer({ url, label, mode = "360", onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(mode);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    setError(null);
    if (view === "flat") return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1100);
    camera.position.set(0, 0, 0.01);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    let mesh: THREE.Mesh | null = null;
    let disposed = false;
    const yawLimit = view === "180" ? Math.PI / 2 - 0.02 : Infinity;

    loadImageTexture(url)
      .then((texture) => {
        if (disposed) return;
        const img = texture.image as HTMLImageElement;
        const aspect = img.width / img.height; // w / h

        const radius = 100;
        const circumference = view === "180" ? Math.PI * radius : 2 * Math.PI * radius;
        const height = circumference / aspect;
        const thetaLength = view === "180" ? Math.PI : 2 * Math.PI;

        const geometry = new THREE.CylinderGeometry(
          radius, radius, height, 96, 1, true, -thetaLength / 2, thetaLength,
        );
        // Invert X so the image is viewed un-mirrored from the INSIDE of the
        // cylinder, then rotate it 180° so the texture CENTRE faces the
        // camera's forward (-Z) direction on open — not off to one side.
        geometry.scale(-1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.y = Math.PI;
        scene.add(mesh);
      })
      .catch(() => { if (!disposed) setError("Couldn't load image for the cylindrical view."); });

    // ---- interaction ----
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0;
    let pitch = 0;

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
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("wheel", onWheel);
      mesh?.geometry.dispose();
      (mesh?.material as THREE.Material | undefined)?.dispose();
      renderer.dispose();
      if (el.parentNode === container) container.removeChild(el);
    };
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
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
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
