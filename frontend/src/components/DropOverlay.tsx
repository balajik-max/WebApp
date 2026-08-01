/**
 * Full-page overlay shown while an external file is being dragged over the
 * Map page — tells the user dropping it will take them to Datasets to
 * finish the upload, rather than silently doing nothing (the map itself
 * has no native drop target of its own).
 */
export function DropOverlay({
  visible,
  state = "hover",
}: {
  visible: boolean;
  state?: "hover" | "processing";
}) {
  if (!visible) return null;
  return (
    <div className="map-drop-overlay" data-testid="map-drop-overlay" aria-hidden="true">
      <div className="map-drop-overlay__card">
        <div className={`map-drop-overlay__icon${state === "processing" ? " map-drop-overlay__icon--spin" : ""}`}>
          {state === "processing" ? (
            <svg viewBox="0 0 24 24" fill="none" width="34" height="34">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
              <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 48 48" fill="none" width="40" height="40">
              <rect x="4" y="4" width="40" height="40" rx="10" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" opacity="0.5" />
              <path d="M24 15v18M16 24h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="map-drop-overlay__title">
          {state === "processing" ? "Preparing your files…" : "Drop to upload"}
        </div>
        <div className="map-drop-overlay__sub">
          {state === "processing"
            ? "Reading the folder before handing it off to Datasets"
            : "You'll be taken to the Datasets page to finish uploading this file"}
        </div>
      </div>
    </div>
  );
}
