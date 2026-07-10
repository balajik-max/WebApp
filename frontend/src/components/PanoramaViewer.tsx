import { useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

interface Props {
  url: string;
  label: string;
  onClose: () => void;
}

/** Real 360° equirectangular sphere viewer — used instead of the flat
 * lightbox when a photo is detected as a true panorama (GPano XMP tag or
 * a 2:1 aspect ratio). Drag to look around, scroll to zoom, matching the
 * standard Street-View-style interaction model. */
export function PanoramaViewer({ url, label, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const timer = setTimeout(() => {
      viewer = new Viewer({
        container,
        panorama: url,
        navbar: ["zoom", "move", "fullscreen"],
        loadingTxt: "Loading panorama…",
        withCredentials: true,
      });
      viewer.addEventListener("panorama-error", () => {
        setError("Couldn't load this as a 360° panorama — the file may not actually be equirectangular.");
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      viewer?.destroy();
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
