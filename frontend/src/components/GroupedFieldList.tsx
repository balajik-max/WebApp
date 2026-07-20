import { memo, useMemo, useState } from "react";
import type {
  VisualizationFieldGroupTree,
  VisualizationFieldProfile,
} from "../lib/workflow";

export interface GroupedFieldSelection {
  geometryGroup: string;
  layerName: string;
  fieldName: string;
}

export interface GroupedFieldListProps {
  tree: VisualizationFieldGroupTree;
  // Composite selection so the same field name on two different source
  // layers (e.g. "FID" in Manhole vs Point) is never conflated.
  selected?: GroupedFieldSelection | null;
  onSelect: (
    selection: GroupedFieldSelection & { field: VisualizationFieldProfile }
  ) => void;
  /** Compact note shown under each field (e.g. populated count). */
  renderFieldMeta?: (field: VisualizationFieldProfile) => string | null;
  emptyLabel?: string;
}

/**
 * 3-level attribute tree: Geometry Group → Layer → Attributes.
 *
 * Behaviour implemented per spec:
 *  - Only geometry-group names are shown initially (everything collapsed).
 *  - Clicking a geometry group expands only that group to reveal its layers.
 *  - Clicking a layer expands only that layer to reveal its attributes.
 *  - Clicking a geometry group or layer again collapses it.
 *  - Subtrees are mounted lazily (first open) so thousands of attributes are
 *    never mounted at once, but stay mounted afterwards for smooth re-expand.
 *  - Selecting a field calls `onSelect` and behaves exactly like the previous
 *    flat attribute selection (only the presentation changed).
 */
function GroupedFieldListImpl({
  tree,
  selected,
  onSelect,
  renderFieldMeta,
  emptyLabel = "No compatible field",
}: GroupedFieldListProps) {
  const [expandedGeo, setExpandedGeo] = useState<Set<string>>(() => new Set());
  const [geoMounted, setGeoMounted] = useState<Set<string>>(() => new Set());

  const [expandedLayer, setExpandedLayer] = useState<Set<string>>(() => new Set());
  const [layerMounted, setLayerMounted] = useState<Set<string>>(() => new Set());

  const toggleGeo = useMemo(
    () => (name: string) => {
      setExpandedGeo((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setGeoMounted((current) => {
        if (current.has(name)) return current;
        const next = new Set(current);
        next.add(name);
        return next;
      });
    },
    []
  );

  const layerKey = (geo: string, layer: string) => `${geo}\u0000${layer}`;

  const toggleLayer = useMemo(
    () => (geo: string, layer: string) => {
      const key = layerKey(geo, layer);
      setExpandedLayer((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setLayerMounted((current) => {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
    },
    []
  );

  const selectedKey = selected
    ? `${selected.geometryGroup}::${selected.layerName}::${selected.fieldName}`
    : null;

  if (tree.geometry_groups.length === 0) {
    return <p className="grouped-field-list__empty">{emptyLabel}</p>;
  }

  return (
    <div className="grouped-field-list" role="tree" aria-label="Attribute groups">
      {tree.geometry_groups.map((geo) => {
        const geoOpen = expandedGeo.has(geo.name);
        const geoIsMounted = geoMounted.has(geo.name);
        const geoFieldCount = geo.layers.reduce((sum, l) => sum + l.fields.length, 0);
        return (
          <div
            key={geo.name}
            className={`grouped-field-list__group${geoOpen ? " is-open" : ""}`}
            role="treeitem"
            aria-expanded={geoOpen}
          >
            <button
              type="button"
              className="grouped-field-list__header grouped-field-list__header--geo"
              aria-label={`${geoOpen ? "Collapse" : "Expand"} ${geo.name}`}
              onClick={() => toggleGeo(geo.name)}
            >
              <span className="grouped-field-list__chevron" aria-hidden="true" />
              <span className="grouped-field-list__name">{geo.name}</span>
              <span className="grouped-field-list__count">{geoFieldCount}</span>
            </button>
            <div className="grouped-field-list__body" role="group">
              {geoIsMounted &&
                geo.layers.map((layer) => {
                  const key = layerKey(geo.name, layer.name);
                  const layerOpen = expandedLayer.has(key);
                  const layerIsMounted = layerMounted.has(key);
                  return (
                    <div
                      key={key}
                      className={`grouped-field-list__layer${layerOpen ? " is-open" : ""}`}
                      role="treeitem"
                      aria-expanded={layerOpen}
                    >
                      <button
                        type="button"
                        className="grouped-field-list__header grouped-field-list__header--layer"
                        aria-label={`${layerOpen ? "Collapse" : "Expand"} layer ${layer.name}`}
                        onClick={() => toggleLayer(geo.name, layer.name)}
                      >
                        <span className="grouped-field-list__chevron" aria-hidden="true" />
                        <span className="grouped-field-list__name">{layer.name}</span>
                        <span className="grouped-field-list__count">{layer.fields.length}</span>
                      </button>
                      <div className="grouped-field-list__body" role="group">
                        {layerIsMounted && (
                          <ul className="grouped-field-list__fields">
                            {layer.fields.map((field) => {
                              const meta = renderFieldMeta?.(field) ?? null;
                              const fieldKey = `${geo.name}::${layer.name}::${field.name}`;
                              return (
                                <li key={field.name}>
                                  <button
                                    type="button"
                                    className={`grouped-field-list__field${
                                      selectedKey === fieldKey ? " is-selected" : ""
                                    }`}
                                    aria-pressed={selectedKey === fieldKey}
                                    onClick={() => onSelect({
                                      geometryGroup: geo.name,
                                      layerName: layer.name,
                                      fieldName: field.name,
                                      field,
                                    })}
                                    title={field.name}
                                  >
                                    <span className="grouped-field-list__field-name">{field.name}</span>
                                    {meta && (
                                      <small className="grouped-field-list__field-meta">{meta}</small>
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const GroupedFieldList = memo(GroupedFieldListImpl);
