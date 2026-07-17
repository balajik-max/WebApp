import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDraggableMapPanel } from "./useDraggableMapPanel";
import { useIsMobile } from "../../lib/useIsMobile";

export interface ReferenceLayerVisibility {
  borders: boolean;
  roads: boolean;
  buildings: boolean;
  places: boolean;
}

interface Props {
  value: ReferenceLayerVisibility;
  onChange: (key: keyof ReferenceLayerVisibility, value: boolean) => void;
}

const options: Array<{ key: keyof ReferenceLayerVisibility; label: string; detail: string }> = [
  { key: "borders", label: "Borders & Labels", detail: "State, district, local boundaries and administrative names" },
  { key: "roads", label: "Roads & Road Names", detail: "Major, secondary, local roads and available road labels" },
  { key: "buildings", label: "Buildings & Names", detail: "Mapped building footprints and available building names" },
  { key: "places", label: "Places & Place Names", detail: "Localities, schools, hospitals, parks, offices and named POIs" },
];

export function ReferenceLayersMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const enabledCount = Object.values(value).filter(Boolean).length;
  const isMobile = useIsMobile();
  const initialPosition = useMemo(() => anchor, [anchor?.x, anchor?.y]);
  const { panelRef, style, onDragStart } = useDraggableMapPanel<HTMLDivElement>({
    storageKey: "davangere.reference-layers-position",
    boundary: "viewport",
    initialPosition,
    margin: 8,
    disabled: isMobile,
  });

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setAnchor({ x: Math.max(8, rect.right - 330), y: rect.bottom + 6 });
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, panelRef]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`map-controls__btn${enabledCount > 0 ? " map-controls__btn--active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Reference layers"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ marginRight: 4, verticalAlign: -2 }} aria-hidden="true">
          <polygon points="12 2 3 7 12 12 21 7 12 2" /><polyline points="3 12 12 17 21 12" /><polyline points="3 17 12 22 21 17" />
        </svg>
        <span className="map-controls__btn-label">Map Layers{enabledCount > 0 ? ` · ${enabledCount}` : ""}</span>
      </button>
      {open && anchor && createPortal(
        <div
          ref={panelRef}
          className="reference-layers-menu"
          role="dialog"
          aria-label="Reference layers"
          style={{ ...style, position: "fixed" }}
        >
          <div className="reference-layers-menu__head" onPointerDown={onDragStart}>
            <div>
              <span>Google Earth-style overlays</span>
              <strong>Reference Layers</strong>
              <small>Drag this header to move the popup</small>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close reference layers">×</button>
          </div>
          {options.map((option) => (
            <label key={option.key} className="reference-layer-option">
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              <input type="checkbox" checked={value[option.key]} onChange={(event) => onChange(option.key, event.target.checked)} />
            </label>
          ))}
          <p>Names appear only when the reference source or uploaded dataset contains a real name. No names are invented.</p>
        </div>,
        document.body
      )}
    </>
  );
}
