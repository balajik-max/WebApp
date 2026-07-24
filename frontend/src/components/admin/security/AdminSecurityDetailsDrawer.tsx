import { useEffect, useRef } from "react";
import type { SecurityControl, SecurityGroup, SecurityMonitoringResponse } from "../../../lib/adminSecurity";
import { formatSecurityRelative } from "../../../lib/adminSecurity";
import { SecurityStatusBadge } from "./SecurityStatusBadge";

interface AdminSecurityDetailsDrawerProps {
  /** Selected control (null = drawer closed) */
  control: SecurityControl | null;
  /** Group the control lives in (used for breadcrumb) */
  group: SecurityGroup | null;
  /** Full payload, kept here so the drawer can be extended later
   *  with cross-group context (e.g. related findings). */
  payload: SecurityMonitoringResponse | null;
  onClose: () => void;
}

/**
 * Right-side drawer that opens when an admin clicks "View details"
 * on a security control.
 *
 * Shows the full sanitized details bag:
 *   - current implementation
 *   - known limitations
 *   - evidence source (file path or runtime probe)
 *   - affected components
 *   - exposure context
 *   - recommended remediation
 *   - monitoring source
 *   - production / development impact
 *
 * Never includes a secret, password, full connection string, API key,
 * or raw cookie value. The backend scrubs those before they reach
 * the API, and the drawer MUST display `current_implementation` and
 * `known_limitations` text only — never the underlying `.env` value.
 */
export function AdminSecurityDetailsDrawer({ control, group, payload: _payload, onClose }: AdminSecurityDetailsDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!control) return;
    // Focus the close button when the drawer opens for keyboard users
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [control, onClose]);

  if (!control) return null;

  const assessedAt = formatSecurityRelative(control.last_assessed_at);
  const details = control.details;

  return (
    <div
      className="sec-drawer__scrim"
      role="presentation"
      onClick={onClose}
      data-testid="sec-drawer-scrim"
    >
      <aside
        className="sec-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sec-drawer-title"
        data-testid={`sec-drawer-${control.key}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sec-drawer__header">
          <div className="sec-drawer__title-row">
            <h2 className="sec-drawer__title" id="sec-drawer-title">
              {control.name}
            </h2>
            <SecurityStatusBadge status={control.status} size="md" emphasis />
          </div>
          {group && <p className="sec-drawer__breadcrumb">Group: {group.label}</p>}
          <button
            type="button"
            className="sec-drawer__close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close details"
            data-testid="sec-drawer-close"
          >
            ×
          </button>
        </header>

        <section className="sec-drawer__section">
          <h3 className="sec-drawer__section-title">Overview</h3>
          <dl className="sec-drawer__kv">
            <dt>Status</dt>
            <dd>
              <SecurityStatusBadge status={control.status} />
            </dd>
            {control.severity && (
              <>
                <dt>Severity</dt>
                <dd>{control.severity}</dd>
              </>
            )}
            <dt>Kind</dt>
            <dd>{control.kind}</dd>
            {control.scope && (
              <>
                <dt>Scope</dt>
                <dd>{control.scope}</dd>
              </>
            )}
            {assessedAt && (
              <>
                <dt>Last assessed</dt>
                <dd>{assessedAt}</dd>
              </>
            )}
          </dl>
        </section>

        {control.one_line && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">One-line summary</h3>
            <p className="sec-drawer__paragraph">{control.one_line}</p>
          </section>
        )}

        {details.current_implementation && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Current implementation</h3>
            <p className="sec-drawer__paragraph">{details.current_implementation}</p>
          </section>
        )}

        {details.known_limitations && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Known limitations</h3>
            <p className="sec-drawer__paragraph">{details.known_limitations}</p>
          </section>
        )}

        {details.evidence_source && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Evidence source</h3>
            <p className="sec-drawer__paragraph sec-drawer__mono">{details.evidence_source}</p>
          </section>
        )}

        {details.affected_components.length > 0 && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Affected components</h3>
            <ul className="sec-drawer__chips">
              {details.affected_components.map((c) => (
                <li key={c} className="sec-drawer__chip">
                  {c}
                </li>
              ))}
            </ul>
          </section>
        )}

        {details.exposure_context && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Exposure context</h3>
            <p className="sec-drawer__paragraph">{details.exposure_context}</p>
          </section>
        )}

        {details.recommended_remediation && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Recommended remediation</h3>
            <p className="sec-drawer__paragraph">{details.recommended_remediation}</p>
          </section>
        )}

        {details.monitoring_source && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Monitoring source</h3>
            <p className="sec-drawer__paragraph sec-drawer__mono">{details.monitoring_source}</p>
          </section>
        )}

        {details.production_impact && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Production impact</h3>
            <p className="sec-drawer__paragraph">{details.production_impact}</p>
          </section>
        )}

        {details.development_impact && (
          <section className="sec-drawer__section">
            <h3 className="sec-drawer__section-title">Development impact</h3>
            <p className="sec-drawer__paragraph">{details.development_impact}</p>
          </section>
        )}
      </aside>
    </div>
  );
}
