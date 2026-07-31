import { PROPERTY_TAX_CLASSES, type PropertyTaxClass } from "../lib/propertyTax";

interface Props {
  active: boolean;
  total: number;
  classified: number;
  unclassified: number;
  counts: Record<PropertyTaxClass, number>;
  selectedClass: PropertyTaxClass | null;
  onToggleActive: () => void;
  onSelectClass: (value: PropertyTaxClass | null) => void;
  onClose: () => void;
}

export function PropertyTaxPanel({
  active,
  total,
  classified,
  unclassified,
  counts,
  selectedClass,
  onToggleActive,
  onSelectClass,
  onClose,
}: Props) {
  return (
    <section className="property-tax-panel" data-testid="property-tax-panel" aria-label="Property tax classification">
      <header className="property-tax-panel__header">
        <div>
          <div className="property-tax-panel__eyebrow">GIS PROPERTY TAX</div>
          <h3>Building Classification</h3>
          <p>Survey-derived use classification</p>
        </div>
        <button type="button" className="property-tax-panel__close" onClick={onClose} aria-label="Close property tax panel">×</button>
      </header>

      <button
        type="button"
        className={`property-tax-panel__mode${active ? " is-active" : ""}`}
        onClick={onToggleActive}
        aria-pressed={active}
      >
        <span className="property-tax-panel__mode-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 21V9l8-5 8 5v12" />
            <path d="M8 21v-7h8v7M3 21h18" />
          </svg>
        </span>
        <span><strong>{active ? "Classification colours active" : "Apply classification colours"}</strong><small>{active ? "Principal buildings are colour-coded" : "Keep all current map layers unchanged"}</small></span>
        <i aria-hidden="true" />
      </button>

      <div className="property-tax-panel__kpis">
        <div><strong>{total.toLocaleString()}</strong><span>Principal buildings</span></div>
        <div><strong>{classified.toLocaleString()}</strong><span>Classified</span></div>
        <div><strong>{unclassified.toLocaleString()}</strong><span>Needs review</span></div>
      </div>

      <div className="property-tax-panel__section-head">
        <span>Filter buildings</span>
        {selectedClass && <button type="button" onClick={() => onSelectClass(null)}>Show all</button>}
      </div>

      {active && (
        <div className="property-tax-panel__filter-status" role="status">
          <span>{selectedClass ? "Showing one class" : "Showing all classes"}</span>
          <strong>{selectedClass ?? `${total.toLocaleString()} buildings`}</strong>
        </div>
      )}

      <div className="property-tax-panel__legend">
        {PROPERTY_TAX_CLASSES.map((item) => {
          const count = counts[item.key] ?? 0;
          if (count === 0 && item.key !== "Unclassified") return null;
          return (
            <button
              type="button"
              key={item.key}
              className={selectedClass === item.key ? "is-selected" : ""}
              onClick={() => onSelectClass(selectedClass === item.key ? null : item.key)}
              disabled={!active || count === 0}
              title={active ? `Filter map to ${item.label} buildings` : "Activate classification colours first"}
              aria-pressed={selectedClass === item.key}
            >
              <span className="property-tax-panel__swatch" style={{ background: item.color }} />
              <strong>{item.label}</strong>
              <small>{count.toLocaleString()}</small>
            </button>
          );
        })}
      </div>

      <div className="property-tax-panel__note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg>
        <span>Only principal building polygons are counted. Rooflines, steps, porches and transformer areas remain excluded.</span>
      </div>
    </section>
  );
}
