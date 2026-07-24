import type { SecurityControl, SecurityGroup } from "../../../lib/adminSecurity";
import { formatSecurityRelative } from "../../../lib/adminSecurity";
import { SecurityStatusBadge } from "./SecurityStatusBadge";

interface AdminSecurityControlRowProps {
  control: SecurityControl;
  group: SecurityGroup;
  onViewDetails: (control: SecurityControl, group: SecurityGroup) => void;
}

/**
 * Compact row layout for security controls. Used as the default
 * presentation inside a group — keeps the list scannable and lets
 * one glance surface the at-risk / not-configured items.
 *
 * The drawer button opens the full control details (current
 * implementation, known limitations, evidence source, recommended
 * remediation, affected components, etc).
 */
export function AdminSecurityControlRow({ control, group, onViewDetails }: AdminSecurityControlRowProps) {
  const assessedAt = formatSecurityRelative(control.last_assessed_at);

  return (
    <div
      className="sec-ctrl-row"
      data-status={control.status}
      data-testid={`sec-ctrl-row-${control.key}`}
    >
      <div className="sec-ctrl-row__main">
        <div className="sec-ctrl-row__title-row">
          <span className="sec-ctrl-row__name">{control.name}</span>
          <SecurityStatusBadge status={control.status} emphasis />
        </div>
        {control.one_line && (
          <p className="sec-ctrl-row__one-line">{control.one_line}</p>
        )}
        <div className="sec-ctrl-row__meta">
          {control.scope && (
            <span className="sec-ctrl-row__scope">Scope: {control.scope}</span>
          )}
          {assessedAt && (
            <span className="sec-ctrl-row__time">Assessed {assessedAt}</span>
          )}
        </div>
      </div>
      <div className="sec-ctrl-row__actions">
        <button
          type="button"
          className="sec-ctrl-row__details"
          onClick={() => onViewDetails(control, group)}
          aria-label={`View details for ${control.name}`}
          data-testid={`sec-ctrl-row-details-${control.key}`}
        >
          View details
        </button>
      </div>
    </div>
  );
}
