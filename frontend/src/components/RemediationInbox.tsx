import { useEffect, useState } from "react";

import { useAuth } from "../context/AuthContext";
import { fetchRemediationInbox, type RemediationInboxItem } from "../lib/pointVerifications";

interface Props {
  refreshToken?: number;
  onLocate: (item: RemediationInboxItem) => void;
}

function displayDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function RemediationInbox({ refreshToken = 0, onLocate }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<RemediationInboxItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = user?.role === "aee" || user?.role === "commissioner";

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const load = () => {
      setLoading(true);
      fetchRemediationInbox(controller.signal)
        .then((next) => {
          setItems(next);
          setError(null);
        })
        .catch((reason) => {
          if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
        })
        .finally(() => setLoading(false));
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, user?.id, refreshToken]);

  if (!enabled) return null;
  const isAee = user?.role === "aee";

  return (
    <div className="remediation-inbox">
      <button type="button" className="remediation-inbox__toggle" onClick={() => setOpen((value) => !value)}>
        <span>{isAee ? "AEE Approvals" : "Commissioner Acceptance"}</span><strong>{items.length}</strong>
      </button>
      {open && (
        <section className="remediation-inbox__panel" aria-label="Remediation workflow inbox">
          <header>
            <div>
              <strong>{isAee ? "Work Pending AEE Approval" : "AEE-Approved Work Pending Acceptance"}</strong>
              <span>{isAee ? "Review AE evidence and rate Good, Moderate, or Bad" : "View AE and AEE details, then accept completed work"}</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          {loading && items.length === 0 && <p>Loading submissions…</p>}
          {error && <p className="remediation-inbox__error">{error}</p>}
          {!loading && items.length === 0 && <p>No work is waiting.</p>}
          <div className="remediation-inbox__list">
            {items.map((item) => (
              <article key={item.verification_id}>
                <div className="remediation-inbox__badges">
                  <span>{item.detection_mode ?? "AI"}</span>
                  <span className={`remediation-inbox__severity remediation-inbox__severity--${item.ai_color ?? "red"}`}>{item.ai_color ?? "red"}</span>
                  {item.aee_category && <span>{item.aee_category}</span>}
                </div>
                <strong>{item.label ?? item.asset_type ?? item.feature_id}</strong>
                <small>{item.dataset_name}</small>
                <p>{item.issue_description ?? "Field issue"}</p>
                <p>{item.work_completed ?? "Work details not available"}</p>
                <dl>
                  <div><dt>Solved by AE</dt><dd>{item.ae_name ?? "—"}</dd></div>
                  {item.aee_name && <div><dt>Approved by AEE</dt><dd>{item.aee_name}</dd></div>}
                  <div><dt>Submitted</dt><dd>{displayDate(item.submitted_at)}</dd></div>
                  {item.aee_decided_at && <div><dt>AEE decision</dt><dd>{displayDate(item.aee_decided_at)}</dd></div>}
                  <div><dt>GPS</dt><dd>{item.gps_validation_status?.replaceAll("_", " ") ?? "—"}</dd></div>
                  <div><dt>Distance</dt><dd>{item.evidence_distance_m === null ? "—" : `${item.evidence_distance_m.toFixed(1)} m`}</dd></div>
                </dl>
                <button type="button" onClick={() => { onLocate(item); setOpen(false); }}>
                  {isAee ? "Open work for review" : "Open approved work"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
