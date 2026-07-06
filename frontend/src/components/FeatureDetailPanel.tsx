import type { UrbanFeature } from "../lib/types";

interface Props {
  feature: UrbanFeature | null;
  onClose: () => void;
}

export function FeatureDetailPanel({ feature, onClose }: Props) {
  if (!feature) {
    return (
      <aside className="detail detail--empty" data-testid="feature-detail-empty">
        <div className="detail__hint">Select a feature on the map to inspect it.</div>
      </aside>
    );
  }

  const { properties, geometry } = feature;
  const attrEntries = Object.entries(properties.attributes ?? {});

  return (
    <aside className="detail" data-testid="feature-detail">
      <header className="detail__head">
        <div>
          <div className="detail__eyebrow">feature</div>
          <h3 className="detail__title" data-testid="feature-title">
            {properties.label ?? properties.id.slice(0, 8)}
          </h3>
        </div>
        <button
          type="button"
          className="detail__close"
          onClick={onClose}
          data-testid="feature-detail-close"
        >
          ×
        </button>
      </header>

      <dl className="detail__kv">
        <dt>id</dt>
        <dd data-testid="feature-id">{properties.id}</dd>
        <dt>dataset</dt>
        <dd data-testid="feature-dataset-id">{properties.dataset_id.slice(0, 8)}…</dd>
        <dt>category</dt>
        <dd>{properties.category ?? "—"}</dd>
        <dt>severity</dt>
        <dd data-testid="feature-severity">{properties.severity.toFixed(2)}</dd>
        <dt>geometry</dt>
        <dd>{geometry.type}</dd>
      </dl>

      <section className="detail__section">
        <h4 className="detail__section-title">Attributes</h4>
        {attrEntries.length === 0 ? (
          <p className="detail__muted">No attributes ingested for this row.</p>
        ) : (
          <ul className="detail__attrs" data-testid="feature-attrs">
            {attrEntries.map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <b>{formatValue(v)}</b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
