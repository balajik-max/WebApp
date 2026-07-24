import { useState } from "react";
import type {
  SecurityControl,
  SecurityGroup,
  SecurityMonitoringResponse,
} from "../../../lib/adminSecurity";
import {
  SECURITY_GROUP_STATUS_BADGE_CLASS,
  SECURITY_STATUS_LABEL,
} from "../../../lib/adminSecurity";
import { AdminSecurityControlRow } from "./AdminSecurityControlRow";
import { AdminSecurityControlCard } from "./AdminSecurityControlCard";

interface AdminSecurityGroupProps {
  group: SecurityGroup;
  payload: SecurityMonitoringResponse;
  onViewDetails: (control: SecurityControl, group: SecurityGroup) => void;
  defaultOpen?: boolean;
}

/**
 * Collapsible group container for a single security domain.
 *
 * Splits the group's items into:
 *   - card controls (kind === "card") — rendered in a 3-column grid
 *   - row controls (everything else)  — rendered as a stacked list
 *
 * The header carries the group label, a soft status badge, the
 * control count, and the open/close toggle.
 */
export function AdminSecurityGroup({
  group,
  payload: _payload,
  onViewDetails,
  defaultOpen,
}: AdminSecurityGroupProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? group.default_open ?? true);

  const cardItems = group.items.filter((it) => it.kind === "card");
  const rowItems = group.items.filter((it) => it.kind !== "card");

  const totalControls = group.items.length;
  const headlineStatus = group.status;

  return (
    <section
      className="sec-group"
      data-testid={`sec-group-${group.id}`}
      data-status={headlineStatus}
    >
      <header className="sec-group__header">
        <button
          type="button"
          className="sec-group__toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={`sec-group-body-${group.id}`}
          data-testid={`sec-group-toggle-${group.id}`}
        >
          <span className="sec-group__toggle-icon" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="sec-group__title">{group.label}</span>
          <span
            className={`sec-group-badge ${SECURITY_GROUP_STATUS_BADGE_CLASS[headlineStatus]}`}
          >
            {SECURITY_STATUS_LABEL[headlineStatus]}
          </span>
          <span className="sec-group__count">
            {totalControls} control{totalControls === 1 ? "" : "s"}
          </span>
        </button>
        {group.description && <p className="sec-group__desc">{group.description}</p>}
      </header>

      {open && (
        <div className="sec-group__body" id={`sec-group-body-${group.id}`}>
          {cardItems.length > 0 && (
            <div className="sec-group__cards" data-testid={`sec-group-cards-${group.id}`}>
              {cardItems.map((control) => (
                <AdminSecurityControlCard
                  key={control.key}
                  control={control}
                  group={group}
                  onViewDetails={onViewDetails}
                />
              ))}
            </div>
          )}

          {rowItems.length > 0 && (
            <div className="sec-group__rows" data-testid={`sec-group-rows-${group.id}`}>
              {rowItems.map((control) => (
                <AdminSecurityControlRow
                  key={control.key}
                  control={control}
                  group={group}
                  onViewDetails={onViewDetails}
                />
              ))}
            </div>
          )}

          {cardItems.length === 0 && rowItems.length === 0 && (
            <div className="sec-group__empty">No controls in this group.</div>
          )}

          {/* Headline status badge for the visually-impaired list summary
              — kept inside the body so the group remains single-source
              for screen readers via aria-controls. */}
          <span className="sec-group__sr-only">
            Group status: {SECURITY_STATUS_LABEL[headlineStatus]}.
          </span>
        </div>
      )}
    </section>
  );
}
