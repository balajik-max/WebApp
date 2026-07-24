import { useState } from "react";
import type {
  ServiceMonitoringGroup,
  ServiceMonitoringItem,
  ServiceMonitoringResponse,
} from "../../../lib/adminMonitoring";
import { GROUP_STATUS_BADGE_CLASS, STATUS_LABEL } from "../../../lib/adminMonitoring";
import { AdminServiceCard } from "./AdminServiceCard";
import { AdminResourceRow } from "./AdminResourceRow";
import { AdminConfigurationRow } from "./AdminConfigurationRow";

interface AdminServiceGroupProps {
  group: ServiceMonitoringGroup;
  /** Full response payload, kept here so the group can be enhanced later
   *  to render cross-group context without touching its callers. */
  payload: ServiceMonitoringResponse;
  onViewDetails: (item: ServiceMonitoringItem) => void;
  defaultOpen?: boolean;
}

/**
 * Collapsible group container. Renders a header (title, description,
 * status badge, item count, toggle) and a body that splits its items
 * into:
 *   - top-level service / subsystem cards
 *   - resource / configuration rows
 *   - loose capability rows (capabilities without a parent card)
 *
 * Capability rows whose parent card lives in this same group are no
 * longer rendered inline — they live in the card's "View details" drawer
 * to keep the list view compact. Loose capabilities (no parent) are
 * still shown here as rows.
 *
 * The body layout is responsive: a single column on mobile, two
 * columns at >= 900px.
 */
export function AdminServiceGroup({
  group,
  payload: _payload,
  onViewDetails,
  defaultOpen = true,
}: AdminServiceGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  const topLevel = group.items.filter(
    (it) => it.kind === "service" || it.kind === "subsystem"
  );
  const loose = group.items.filter(
    (it) =>
      it.kind === "resource" ||
      it.kind === "configuration" ||
      (it.kind === "capability" && !it.parent_key)
  );

  return (
    <section
      className="svc-group"
      data-testid={`svc-group-${group.id}`}
      data-status={group.status}
    >
      <header className="svc-group__header">
        <button
          type="button"
          className="svc-group__toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={`svc-group-body-${group.id}`}
          data-testid={`svc-group-toggle-${group.id}`}
        >
          <span className="svc-group__toggle-icon" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="svc-group__title">{group.label}</span>
          <span className={`svc-group-badge ${GROUP_STATUS_BADGE_CLASS[group.status]}`}>
            {STATUS_LABEL[group.status]}
          </span>
          <span className="svc-group__count">
            {group.item_count} item{group.item_count === 1 ? "" : "s"}
          </span>
        </button>
        {group.description && <p className="svc-group__desc">{group.description}</p>}
      </header>

      {open && (
        <div className="svc-group__body" id={`svc-group-body-${group.id}`}>
          {topLevel.length > 0 && (
            <div className="svc-group__cards">
              {topLevel.map((item) => (
                <AdminServiceCard
                  key={item.key}
                  item={item}
                  onViewDetails={onViewDetails}
                />
              ))}
            </div>
          )}

          {loose.length > 0 && (
            <div className="svc-group__rows">
              {loose.map((item) => {
                if (item.kind === "resource") {
                  return <AdminResourceRow key={item.key} item={item} />;
                }
                return <AdminConfigurationRow key={item.key} item={item} />;
              })}
            </div>
          )}

          {topLevel.length === 0 && loose.length === 0 && (
            <div className="svc-group__empty">No items in this group.</div>
          )}
        </div>
      )}
    </section>
  );
}
