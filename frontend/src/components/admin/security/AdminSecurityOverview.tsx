import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SecurityControl,
  SecurityFinding,
  SecurityGroup,
  SecurityMonitoringResponse,
} from "../../../lib/adminSecurity";
import { findSecurityControl } from "../../../lib/adminSecurity";
import { apiGet, ApiError } from "../../../lib/api";
import { AdminSecuritySummary } from "./AdminSecuritySummary";
import { AdminSecurityFindingsPanel } from "./AdminSecurityFindingsPanel";
import { AdminSecurityGroup } from "./AdminSecurityGroup";
import { AdminSecurityDetailsDrawer } from "./AdminSecurityDetailsDrawer";

interface AdminSecurityOverviewProps {
  /** External last-updated setter — set to Date.now() on every successful fetch. */
  onUpdated?: (at: Date) => void;
  /** External payload setter — exposed so the parent can compute overall health. */
  onPayload?: (payload: SecurityMonitoringResponse) => void;
  /** Polling interval in ms. Defaults to 60s. Pass 0 to disable polling. */
  pollMs?: number;
}

/**
 * Top-level wrapper for the Admin Security tab.
 *
 * Responsibilities:
 *   - fetch /api/v1/admin/security (the new grouped endpoint)
 *   - render the posture summary, the findings panel, all groups, and
 *     the details drawer
 *   - poll on a configurable interval
 *   - expose the most-recent fetch timestamp via the onUpdated callback
 *
 * The drawer can be opened from a control row/card (passes the
 * control + group) or from a finding (resolves the matching control
 * by lowercased id, e.g. "SEC-001" → "sec_001").
 */
export function AdminSecurityOverview({ onUpdated, onPayload, pollMs = 60_000 }: AdminSecurityOverviewProps) {
  const [payload, setPayload] = useState<SecurityMonitoringResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedControl, setSelectedControl] = useState<SecurityControl | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<SecurityGroup | null>(null);

  const fetchNow = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      setError(null);
      try {
        const data = await apiGet<SecurityMonitoringResponse>(
          "/api/v1/admin/security",
          signal,
        );
        if (signal?.aborted) return;
        setPayload(data);
        onPayload?.(data);
        onUpdated?.(new Date());
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message;
        setError(msg || "Failed to load security payload");
      } finally {
        if (!signal?.aborted) setRefreshing(false);
      }
    },
    [onPayload, onUpdated],
  );

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
  }, [fetchNow, pollMs]);

  const onViewDetails = useCallback((control: SecurityControl, group: SecurityGroup) => {
    setSelectedControl(control);
    setSelectedGroup(group);
  }, []);

  const onSelectFinding = useCallback(
    (finding: SecurityFinding) => {
      if (!payload) return;
      // Map SEC-001 → control key "sec_001" (lower-cased, dashes → underscores)
      const controlKey = finding.id.toLowerCase().replace(/-/g, "_");
      const located = findSecurityControl(payload, controlKey);
      if (located) {
        setSelectedControl(located.control);
        setSelectedGroup(located.group);
      }
    },
    [payload],
  );

  const onCloseDrawer = useCallback(() => {
    setSelectedControl(null);
    setSelectedGroup(null);
  }, []);

  const onRefresh = useCallback(() => {
    const ctrl = new AbortController();
    void fetchNow(ctrl.signal);
  }, [fetchNow]);

  // Memoize the group list so each AdminSecurityGroup stays referentially stable
  // when only the surrounding payload metadata changes.
  const groups = useMemo(() => payload?.groups ?? [], [payload]);

  if (error && !payload) {
    return (
      <div className="admin-empty" data-testid="sec-error" role="alert">
        Failed to load security payload: {error}
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="admin-empty" data-testid="sec-loading">Loading security posture…</div>
    );
  }

  return (
    <div className="sec-overview" data-testid="sec-overview" data-posture={payload.overall_posture}>
      <AdminSecuritySummary payload={payload} onRefresh={onRefresh} refreshing={refreshing} />

      {error && (
        <div className="sec-overview__banner" role="status" data-testid="sec-banner-error">
          Refresh failed: {error}
        </div>
      )}

      <AdminSecurityFindingsPanel
        payload={payload}
        onSelectFinding={onSelectFinding}
      />

      <div className="sec-overview__groups" data-testid="sec-groups">
        {groups.map((group) => (
          <AdminSecurityGroup
            key={group.id}
            group={group}
            payload={payload}
            onViewDetails={onViewDetails}
            defaultOpen={false}
          />
        ))}
      </div>

      <AdminSecurityDetailsDrawer
        control={selectedControl}
        group={selectedGroup}
        payload={payload}
        onClose={onCloseDrawer}
      />
    </div>
  );
}
