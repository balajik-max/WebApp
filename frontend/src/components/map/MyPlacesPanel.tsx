import { useEffect, useMemo, useState } from "react";
import type { Placemark } from "../../lib/placemarks";
import { useDraggableMapPanel } from "./useDraggableMapPanel";

interface Props {
  placemarks: Placemark[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onClose: () => void;
  onFlyTo: (placemark: Placemark) => void;
  onHover: (placemark: Placemark | null) => void;
}

function coordinateSummary(placemark: Placemark) {
  return `${Math.abs(placemark.latitude).toFixed(5)}° ${placemark.latitude >= 0 ? "N" : "S"}, ${Math.abs(placemark.longitude).toFixed(5)}° ${placemark.longitude >= 0 ? "E" : "W"}`;
}

export function MyPlacesPanel({
  placemarks,
  loading,
  error,
  selectedId,
  onClose,
  onFlyTo,
  onHover,
}: Props) {
  const [query, setQuery] = useState("");
  const { panelRef, style, onDragStart } = useDraggableMapPanel<HTMLElement>({
    storageKey: "davangere.my-places-position",
    dock: "right",
    top: 118,
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      onHover(null);
    };
  }, [onClose, onHover]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return placemarks;
    return placemarks.filter((item) => [item.name, item.description, item.category]
      .some((value) => value?.toLocaleLowerCase().includes(normalized)));
  }, [placemarks, query]);

  return (
    <aside ref={panelRef} style={style} className="my-places-panel" role="dialog" aria-label="My Places">
      <div className="my-places-panel__head" onPointerDown={onDragStart}>
        <div>
          <span>Saved annotations</span>
          <strong>My Places</strong>
          <small>Drag this header to move the popup</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close My Places">×</button>
      </div>

      <div className="my-places-panel__search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
        </svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search saved places…" />
      </div>

      <div className="my-places-panel__toolbar">
        <span>{filtered.length} saved place{filtered.length === 1 ? "" : "s"}</span>
        <small>Hover to identify · click to go</small>
      </div>

      {loading && <div className="my-places-panel__state">Loading saved placemarks…</div>}
      {error && !loading && <div className="my-places-panel__state my-places-panel__state--error">{error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="my-places-panel__state">No saved places match this search.</div>
      )}

      <div className="my-places-panel__list">
        {filtered.map((placemark) => (
          <button
            type="button"
            key={placemark.id}
            className={`my-place my-place--button${selectedId === placemark.id ? " is-active" : ""}${placemark.is_visible ? "" : " is-hidden"}`}
            onPointerEnter={() => onHover(placemark)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(placemark)}
            onBlur={() => onHover(null)}
            onClick={() => onFlyTo(placemark)}
            title={`Go to ${placemark.name}`}
          >
            <span className={`my-place__icon my-place__icon--${placemark.icon || "pin"}`} aria-hidden="true">●</span>
            <span className="my-place__content">
              <strong>{placemark.name}</strong>
              <small>{placemark.category || "Saved placemark"}</small>
              <em>{coordinateSummary(placemark)}</em>
            </span>
            <span className="my-place__go" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
