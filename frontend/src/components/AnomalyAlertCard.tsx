import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { explainAnomaly, type AnomalyStatus, type SpatialAnomaly } from "../lib/workflow";
import { UrbanPlanningSolutionPanel } from "./UrbanPlanningSolutionPanel";

interface Props {
  anomaly: SpatialAnomaly;
  onClose: () => void;
  onStatusChange: (anomalyId: string, next: AnomalyStatus) => void;
  /** A newer audit run replaced this finding server-side (its id no longer
   * exists) — remove it from the map/local state instead of showing a raw
   * fetch error, since re-running the audit is a normal, expected action. */
  onStale: (anomalyId: string) => void;
}

const TYPE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
  road_width_narrowing: "Road Width Narrowing",
  powerline_proximity: "Powerline Proximity",
  pothole_status: "Pothole Condition",
  standing_water_status: "Standing Water",
};

const COLOR_LABEL: Record<SpatialAnomaly["color"], string> = {
  red: "Critical",
  yellow: "Review",
  green: "Confirmed OK",
};

/** Facts worth surfacing verbatim next to the AI narration — the same
 * numbers the LLM was given, shown as data so this is never a black box. */
function metadataEntries(metadata: Record<string, unknown>): [string, string][] {
  const skip = new Set([
    "this_feature_id", "kept_feature_id", "building_id", "manhole_id", "pothole_id", "standing_water_id", "top_reference_feature_id", "nearest_drain_id", "drain_ids",
    "centerline_feature_id", "left_edge_feature_id", "right_edge_feature_id",
    "affected_line_wkt", "sample_interval_m", "probe_length_m",
  ]);
  return Object.entries(metadata)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => [
      k.replace(/_/g, " "),
      Array.isArray(v) ? v.join(", ") : String(v),
    ]);
}

const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

type ResizeEdge = "right" | "bottom" | "corner";

export function AnomalyAlertCard({ anomaly, onClose, onStatusChange, onStale }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [explanation, setExplanation] = useState<string | null>(anomaly.explanation_text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draggable (header) + resizable (right/bottom/corner handles), so a long
  // AI explanation or a wide metrics table (e.g. Road Width Narrowing) isn't
  // stuck cramped into a fixed 320px box — the user can both move the panel
  // out of the way and grow it to actually read the content comfortably.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const resizeStartRef = useRef<{ edge: ResizeEdge; x: number; y: number; width: number; height: number } | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);

  const clampToViewport = (x: number, y: number, width: number, height: number) => {
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
  };

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // Ignore drags started on the header's own buttons so they still just click.
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    dragPointerIdRef.current = e.pointerId;
    e.preventDefault();
  };
  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const offset = dragOffsetRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!offset || !rect) return;
    const nextX = e.clientX - offset.x;
    const nextY = e.clientY - offset.y;
    setPosition(clampToViewport(nextX, nextY, rect.width, rect.height));
    e.preventDefault();
  };
  const endHeaderDrag = (e: React.PointerEvent<HTMLElement>) => {
    dragOffsetRef.current = null;
    dragPointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleResizePointerDown = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Dragging a resize handle also pins the panel's current on-screen
    // position (if it hadn't been moved yet) so it grows from where it
    // already is instead of jumping back to the default top/right corner.
    setPosition((prev) => prev ?? { x: rect.left, y: rect.top });
    resizeStartRef.current = { edge, x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
    resizePointerIdRef.current = e.pointerId;
    e.preventDefault();
    e.stopPropagation();
  };
  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!start || !rect) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - rect.left - 8);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - rect.top - 8);
    setSize({
      width: start.edge === "bottom" ? rect.width : Math.min(maxWidth, Math.max(MIN_WIDTH, start.width + dx)),
      height: start.edge === "right" ? rect.height : Math.min(maxHeight, Math.max(MIN_HEIGHT, start.height + dy)),
    });
    e.preventDefault();
    e.stopPropagation();
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    resizePointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Keep the card inside the viewport if the window shrinks after being
  // dragged/resized near an edge.
  useEffect(() => {
    const handleResize = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition((prev) => (prev ? clampToViewport(prev.x, prev.y, rect.width, rect.height) : prev));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // On unmount (e.g. closed mid-drag/resize) release any active pointer
  // capture so the browser cursor is never left stuck in dragging mode.
  useEffect(() => {
    const el = panelRef.current;
    return () => {
      const dragId = dragPointerIdRef.current;
      const resizeId = resizePointerIdRef.current;
      if (dragId !== null && el?.hasPointerCapture(dragId)) el.releasePointerCapture(dragId);
      if (resizeId !== null && el?.hasPointerCapture(resizeId)) el.releasePointerCapture(resizeId);
    };
  }, []);

  useEffect(() => {
    setExplanation(anomaly.explanation_text);
    setError(null);
    if (anomaly.explanation_text) return;
    const ctrl = new AbortController();
    setLoading(true);
    explainAnomaly(anomaly.id, ctrl.signal)
      .then((r) => setExplanation(r.explanation_text))
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 404) {
          onStale(anomaly.id);
          return;
        }
        setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [anomaly.id, anomaly.explanation_text, onStale]);

  const style: React.CSSProperties | undefined = {
    ...(position ? { top: position.y, left: position.x, right: "auto", transform: "none" } : undefined),
    ...(size ? { width: size.width, maxHeight: size.height } : undefined),
  };

  return (
    <aside
      className="anomaly-card"
      data-testid="anomaly-alert-card"
      ref={panelRef as React.RefObject<HTMLElement>}
      style={style}
    >
      <header
        className="anomaly-card__head"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        data-testid="anomaly-card-head"
      >
        <div>
          <span className={`anomaly-card__badge anomaly-card__badge--${anomaly.color}`}>
            {COLOR_LABEL[anomaly.color]}
          </span>
          <h3 className="anomaly-card__title">{TYPE_LABEL[anomaly.anomaly_type]}</h3>
        </div>
        <button type="button" className="anomaly-card__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="anomaly-card__body">
        {loading && <div className="anomaly-card__loading">Generating explanation…</div>}
        {error && <div className="anomaly-card__error">{error}</div>}
        {explanation && <p className="anomaly-card__explanation">{explanation}</p>}

        <div className="anomaly-card__facts">
          {metadataEntries(anomaly.anomaly_metadata).map(([k, v]) => (
            <div className="anomaly-card__fact" key={k}>
              <span className="anomaly-card__fact-key">{k}</span>
              <span className="anomaly-card__fact-value">{v}</span>
            </div>
          ))}
        </div>

        <UrbanPlanningSolutionPanel
          featureId={anomaly.feature_ids[0] ?? null}
          contextLabel={TYPE_LABEL[anomaly.anomaly_type]}
          placeholder={`Describe your proposed solution for this ${TYPE_LABEL[anomaly.anomaly_type].toLowerCase()} issue…`}
        />
      </div>

      <footer className="anomaly-card__actions">
        {anomaly.status !== "reviewing" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "reviewing")}>Mark Reviewing</button>
        )}
        {isAdmin && anomaly.status !== "dismissed" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "dismissed")}>Dismiss</button>
        )}
        <span className="anomaly-card__workflow-note">Resolution follows the active remediation workflow and its required approvals.</span>
      </footer>

      <div
        className="anomaly-card__resize anomaly-card__resize--right"
        onPointerDown={handleResizePointerDown("right")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
      <div
        className="anomaly-card__resize anomaly-card__resize--bottom"
        onPointerDown={handleResizePointerDown("bottom")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
      <div
        className="anomaly-card__resize anomaly-card__resize--corner"
        onPointerDown={handleResizePointerDown("corner")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
    </aside>
  );
}
