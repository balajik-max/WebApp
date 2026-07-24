import { useEffect, useMemo, useState } from "react";
import type { ServiceMonitoringItem, ServiceMonitoringResponse } from "../../../lib/adminMonitoring";
import { apiGet, ApiError } from "../../../lib/api";
import { AdminServicesSummary } from "./AdminServicesSummary";
import { AdminServiceGroup } from "./AdminServiceGroup";
import { AdminServiceDetailsDrawer } from "./AdminServiceDetailsDrawer";

interface AdminServicesOverviewProps {
  /** External last-updated setter — set to Date.now() on every successful poll. */
  onUpdated?: (at: Date) => void;
  /** External payload setter — exposed so the parent can compute overall health. */
  onPayload?: (payload: ServiceMonitoringResponse) => void;
  /** Polling interval in ms. Defaults to 30s. Pass 0 to disable polling. */
  pollMs?: number;
}

/**
 * Top-level wrapper for the new grouped Services monitoring view.
 *
 * Responsibilities:
 *   - fetch /api/v1/admin/services (the new grouped endpoint)
 *   - render the summary banner, all groups, and the details drawer
 *   - poll on a configurable interval
 *   - expose the most-recent fetch timestamp via the onUpdated callback
 *     so the parent can keep its "Last updated" label in sync
 */
export function AdminServicesOverview({ onUpdated, onPayload, pollMs = 30_000 }: AdminServicesOverviewProps) {
  const [payload, setPayload] = useState<ServiceMonitoringResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ServiceMonitoringItem | null>(null);

  const fetchNow = async (signal?: AbortSignal) => {
    setRefreshing(true);
    setError(null);
    try {
      const data = await apiGet<ServiceMonitoringResponse>("/api/v1/admin/services", signal);
      if (signal?.aborted) return;
      setPayload(data);
      onPayload?.(data);
      onUpdated?.(new Date());
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message;
      setError(msg || "Failed to load services");
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchNow(ctrl.signal);
    if (!pollMs) return;
    const id = window.setInterval(() => {
      // Each tick uses a fresh controller so a stale one can't cancel a new fetch.
      const tickCtrl = new AbortController();
      void fetchNow(tickCtrl.signal);
    }, pollMs);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  // Stable callback identities for the drawer
  const onViewDetails = useMemo(
    () => (item: ServiceMonitoringItem) => setSelected(item),
    []
  );
  const onCloseDrawer = useMemo(() => () => setSelected(null), []);

  if (error && !payload) {
    return (
      <div className="admin-empty" data-testid="svc-error" role="alert">
        Failed to load services: {error}
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="admin-empty" data-testid="svc-loading">Loading services…</div>
    );
  }

  return (
    <div className="svc-overview" data-testid="svc-overview">
      <AdminServicesSummary
        payload={payload}
        onRefresh={() => {
          const ctrl = new AbortController();
          void fetchNow(ctrl.signal);
        }}
        refreshing={refreshing}
      />

      {error && (
        <div className="svc-overview__banner" role="status" data-testid="svc-banner-error">
          Refresh failed: {error}
        </div>
      )}

      <div className="svc-overview__groups" data-testid="svc-groups">
        {payload.groups.map((group) => (
          <AdminServiceGroup
            key={group.id}
            group={group}
            payload={payload}
            onViewDetails={onViewDetails}
            defaultOpen={false}
          />
        ))}
      </div>

      <AdminServiceDetailsDrawer
        item={selected}
        payload={payload}
        onClose={onCloseDrawer}
      />
    </div>
  );
}
