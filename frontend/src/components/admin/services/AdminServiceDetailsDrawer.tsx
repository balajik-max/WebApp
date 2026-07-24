import { useEffect, useRef } from "react";
import type { ServiceMonitoringItem, ServiceMonitoringResponse } from "../../../lib/adminMonitoring";
import { childItems, findItem, formatRelative, formatResponseTime } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminServiceDetailsDrawerProps {
  item: ServiceMonitoringItem | null;
  payload: ServiceMonitoringResponse | null;
  onClose: () => void;
}

/**
 * Right-side drawer that opens when the admin clicks "View details"
 * on a service card.
 *
 * Shows the full sanitized details bag, dependencies, health-check
 * method, response time, last-checked timestamp, and any nested
 * configuration. Never includes secrets — the backend scrubs query
 * strings and credential fields before they reach the API.
 */
export function AdminServiceDetailsDrawer({ item, payload, onClose }: AdminServiceDetailsDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!item) return;
    // Focus the close button when the drawer opens for keyboard users
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const responseTime = formatResponseTime(item.response_time_ms);
  const lastChecked = formatRelative(item.last_checked_at);

  // Resolve dependency names (best-effort; safe to leave blank if missing)
  const dependencies = (item.dependencies || [])
    .map((key) => payload ? findItem(payload, key)?.item : null)
    .filter((it): it is ServiceMonitoringItem => Boolean(it));

  // Resolve nested capabilities (children with parent_key == this item)
  const capabilities = payload ? childItems(payload, item.key) : [];
  const responseTimeNum = item.response_time_ms ?? null;

  return (
    <div
      className="svc-drawer__scrim"
      role="presentation"
      onClick={onClose}
      data-testid="svc-drawer-scrim"
    >
      <aside
        className="svc-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="svc-drawer-title"
        data-testid={`svc-drawer-${item.key}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="svc-drawer__header">
          <div className="svc-drawer__title-row">
            <h2 className="svc-drawer__title" id="svc-drawer-title">
              {item.name}
            </h2>
            <StatusBadge status={item.status} size="md" />
          </div>
          <button
            type="button"
            className="svc-drawer__close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close details"
            data-testid="svc-drawer-close"
          >
            ×
          </button>
        </header>

        <p className="svc-drawer__desc">{item.description}</p>

        <section className="svc-drawer__section">
          <h3 className="svc-drawer__section-title">Overview</h3>
          <dl className="svc-drawer__kv">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={item.status} />
            </dd>
            <dt>Criticality</dt>
            <dd className={`svc-card__crit svc-card__crit--${item.criticality}`}>
              {item.criticality}
            </dd>
            <dt>Kind</dt>
            <dd>{item.kind.replace(/_/g, " ")}</dd>
            {responseTime && (
              <>
                <dt>Response time</dt>
                <dd>{responseTime}</dd>
              </>
            )}
            {responseTimeNum !== null && !responseTime && (
              <>
                <dt>Response time</dt>
                <dd>{responseTimeNum.toFixed(1)} ms</dd>
              </>
            )}
            {lastChecked && (
              <>
                <dt>Last checked</dt>
                <dd>{lastChecked}</dd>
              </>
            )}
            {item.endpoint_label && (
              <>
                <dt>Endpoint</dt>
                <dd className="svc-drawer__endpoint">{item.endpoint_label}</dd>
              </>
            )}
            {item.detail && (
              <>
                <dt>Detail</dt>
                <dd>{item.detail}</dd>
              </>
            )}
          </dl>
        </section>

        {dependencies.length > 0 && (
          <section className="svc-drawer__section">
            <h3 className="svc-drawer__section-title">Depends on</h3>
            <ul className="svc-drawer__dep-list">
              {dependencies.map((dep) => (
                <li key={dep.key} className="svc-drawer__dep">
                  <span className="svc-drawer__dep-name">{dep.name}</span>
                  <StatusBadge status={dep.status} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {capabilities.length > 0 && (
          <section className="svc-drawer__section">
            <h3 className="svc-drawer__section-title">Capabilities</h3>
            <ul className="svc-drawer__cap-list">
              {capabilities.map((cap) => (
                <li key={cap.key} className="svc-drawer__cap">
                  <div className="svc-drawer__cap-text">
                    <div className="svc-drawer__cap-name">{cap.name}</div>
                    {cap.description && (
                      <div className="svc-drawer__cap-desc">{cap.description}</div>
                    )}
                  </div>
                  <StatusBadge status={cap.status} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
