import type { SecurityControl, SecurityGroup } from "../../../lib/adminSecurity";
import { SecurityStatusBadge } from "./SecurityStatusBadge";

interface AdminSecurityControlCardProps {
  control: SecurityControl;
  group: SecurityGroup;
  onViewDetails: (control: SecurityControl, group: SecurityGroup) => void;
}

/**
 * Card layout for security controls that warrant a fuller presentation
 * (typically the at-risk / partially-protected / critical items). Shows
 * a short headline, a one-line summary, the status badge, and a
 * "View details" affordance.
 */
export function AdminSecurityControlCard({ control, group, onViewDetails }: AdminSecurityControlCardProps) {
  return (
    <article
      className="sec-ctrl-card"
      data-status={control.status}
      data-testid={`sec-ctrl-card-${control.key}`}
    >
      <header className="sec-ctrl-card__header">
        <h3 className="sec-ctrl-card__name">{control.name}</h3>
        <SecurityStatusBadge status={control.status} emphasis />
      </header>
      {control.one_line && (
        <p className="sec-ctrl-card__one-line">{control.one_line}</p>
      )}
      {control.description && (
        <p className="sec-ctrl-card__desc">{control.description}</p>
      )}
      <footer className="sec-ctrl-card__footer">
        <button
          type="button"
          className="sec-ctrl-card__details"
          onClick={() => onViewDetails(control, group)}
          aria-label={`View details for ${control.name}`}
          data-testid={`sec-ctrl-card-details-${control.key}`}
        >
          View details
        </button>
      </footer>
    </article>
  );
}
