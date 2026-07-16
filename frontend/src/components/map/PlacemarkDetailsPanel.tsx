import type { Placemark } from "../../lib/placemarks";
import { useDraggableMapPanel } from "./useDraggableMapPanel";

interface Props {
  placemark: Placemark;
  datasetName?: string | null;
  onClose: () => void;
  onEdit: (placemark: Placemark) => void;
  onDelete: (placemark: Placemark) => void;
}

function formatCoordinate(value: number, positive: string, negative: string) {
  const direction = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(7)}° ${direction}`;
}

export function PlacemarkDetailsPanel({ placemark, datasetName, onClose, onEdit, onDelete }: Props) {
  const { panelRef, style, onDragStart } = useDraggableMapPanel<HTMLElement>({
    storageKey: "davangere.placemark-details-position",
    dock: "left",
    top: 132,
  });

  return (
    <section
      ref={panelRef}
      style={style}
      className="placemark-details-panel"
      role="dialog"
      aria-label={`Placemark details: ${placemark.name}`}
    >
      <div className="placemark-details-panel__head" onPointerDown={onDragStart}>
        <div>
          <span>Saved location</span>
          <strong>{placemark.name}</strong>
          <small>Drag this header to move the popup</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close placemark details">×</button>
      </div>

      <div className="placemark-details-panel__body">
        <div className="placemark-details-panel__badge-row">
          <span className="placemark-details-panel__pin" aria-hidden="true">📍</span>
          <div>
            <strong>{placemark.category || "Saved placemark"}</strong>
            <small>The highlighted pin shows this exact location</small>
          </div>
        </div>

        {placemark.description ? (
          <p className="placemark-details-panel__description">{placemark.description}</p>
        ) : (
          <p className="placemark-details-panel__description is-empty">No description was saved.</p>
        )}

        <dl className="placemark-details-panel__facts">
          <div><dt>Latitude</dt><dd>{formatCoordinate(placemark.latitude, "N", "S")}</dd></div>
          <div><dt>Longitude</dt><dd>{formatCoordinate(placemark.longitude, "E", "W")}</dd></div>
          <div><dt>Related dataset</dt><dd>{datasetName || "No dataset link"}</dd></div>
        </dl>
      </div>

      <div className="placemark-details-panel__actions">
        <button type="button" onClick={() => onEdit(placemark)}>Edit</button>
        <button
          type="button"
          className="is-danger"
          onClick={() => {
            if (window.confirm(`Delete placemark “${placemark.name}”?`)) onDelete(placemark);
          }}
        >
          Delete
        </button>
      </div>
    </section>
  );
}
