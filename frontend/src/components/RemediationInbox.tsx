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

  useEffect(() => {
    if (user?.role !== "admin") {
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
    const timer = window.setInterval(load, 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [user?.role, refreshToken]);

  if (user?.role !== "admin") return null;

  return (
    <div className="remediation-inbox">
      <button type="button" className="remediation-inbox__toggle" onClick={() => setOpen((value) => !value)}>
        <span>Remediation</span>
        <strong>{items.length}</strong>
      </button>
      {open && (
        <section className="remediation-inbox__panel" aria-label="Pending remediation submissions">
          <header>
            <div><strong>Pending Admin Verification</strong><span>Architect submissions waiting for review</span></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          {loading && items.length === 0 && <p>Loading submissions…</p>}
          {error && <p className="remediation-inbox__error">{error}</p>}
          {!loading && items.length === 0 && <p>No submissions are waiting.</p>}
          <div className="remediation-inbox__list">
            {items.map((item) => (
              <article key={item.verification_id}>
                <div className="remediation-inbox__badges">
                  <span>{item.detection_mode ?? "AI"}</span>
                  <span className={`remediation-inbox__severity remediation-inbox__severity--${item.ai_color ?? "red"}`}>{item.ai_color ?? "red"}</span>
                </div>
                <strong>{item.label ?? item.category ?? item.feature_id}</strong>
                <small>{item.dataset_name}</small>
                <p>{item.issue_summary ?? "Architect remediation submitted"}</p>
                <dl>
                  <div><dt>Architect</dt><dd>{item.architect_name ?? "—"}</dd></div>
                  <div><dt>Submitted</dt><dd>{displayDate(item.architect_submitted_at)}</dd></div>
                  <div><dt>Location</dt><dd>{item.evidence_location_status?.replaceAll("_", " ") ?? "—"}</dd></div>
                  <div><dt>Distance</dt><dd>{item.evidence_distance_m === null ? "—" : `${item.evidence_distance_m.toFixed(1)} m`}</dd></div>
                </dl>
                <button type="button" onClick={() => { onLocate(item); setOpen(false); }}>Locate point on map</button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
