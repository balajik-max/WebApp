import type { PlacemarkDraft } from "../../lib/placemarks";
import { useDraggableMapPanel } from "./useDraggableMapPanel";

interface Props {
  draft: PlacemarkDraft;
  saving: boolean;
  error: string | null;
  onChange: (patch: Partial<PlacemarkDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function PlacemarkEditor({ draft, saving, error, onChange, onSave, onCancel }: Props) {
  const { panelRef, style, onDragStart } = useDraggableMapPanel<HTMLElement>({
    storageKey: "davangere.placemark-editor-position",
    dock: "left",
    top: 118,
  });

  const valid = draft.name.trim().length > 0
    && Number.isFinite(draft.longitude)
    && Number.isFinite(draft.latitude);

  return (
    <section
      ref={panelRef}
      style={style}
      className="placemark-editor"
      role="dialog"
      aria-label={draft.id ? "Edit placemark" : "New placemark"}
    >
      <div className="placemark-editor__head" onPointerDown={onDragStart}>
        <div>
          <span>Placemark</span>
          <strong>{draft.id ? "Edit saved place" : "Mark this location"}</strong>
          <small>Drag this header to move the popup</small>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close placemark editor">×</button>
      </div>

      <div className="placemark-editor__hint">The visible pin marks the exact location. Drag the pin to correct it before saving.</div>

      <label>
        <span>Name *</span>
        <input
          autoFocus
          value={draft.name}
          maxLength={255}
          placeholder="Enter a location name"
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>

      <label>
        <span>Description</span>
        <textarea
          value={draft.description ?? ""}
          maxLength={5000}
          rows={3}
          placeholder="Add notes about this location"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>

      <label>
        <span>Category</span>
        <input
          value={draft.category ?? ""}
          maxLength={128}
          placeholder="Example: Drainage, Survey, Issue"
          onChange={(event) => onChange({ category: event.target.value })}
        />
      </label>

      <div className="placemark-editor__location">
        <span>Exact location</span>
        <strong>{draft.latitude.toFixed(7)}, {draft.longitude.toFixed(7)}</strong>
      </div>

      {error && <div className="placemark-editor__error">{error}</div>}

      <div className="placemark-editor__actions">
        <button type="button" className="placemark-editor__secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="placemark-editor__primary" onClick={onSave} disabled={!valid || saving}>
          {saving ? "Saving…" : draft.id ? "Save changes" : "Save"}
        </button>
      </div>
    </section>
  );
}
