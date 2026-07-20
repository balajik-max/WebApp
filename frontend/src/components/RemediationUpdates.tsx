import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../context/AuthContext";
import {
  fetchRemediationUpdates,
  markRemediationUpdateRead,
  remediationEvidenceUrl,
  type RemediationUpdateItem,
} from "../lib/pointVerifications";

interface Props {
  refreshToken?: number;
  onLocate: (item: RemediationUpdateItem) => void;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const SOURCE_LABEL: Record<RemediationUpdateItem["source"], string> = {
  remediation_submitted: "Pending AEE Approval",
  remediation_aee_approved: "AEE Approved",
  remediation_returned: "Returned by AEE",
  remediation_commissioner_accepted: "Commissioner Accepted",
};

export function RemediationUpdates({ refreshToken = 0, onLocate }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<RemediationUpdateItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = user?.role === "ae" || user?.role === "aee" || user?.role === "commissioner";
  const unread = useMemo(() => items.filter((item) => !item.read_at).length, [items]);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const load = () => {
      setLoading(true);
      fetchRemediationUpdates(controller.signal)
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

  async function locate(item: RemediationUpdateItem) {
    if (!item.read_at) {
      try {
        await markRemediationUpdateRead(item.notification_id);
        setItems((current) => current.map((row) => row.notification_id === item.notification_id
          ? { ...row, read_at: new Date().toISOString() }
          : row));
      } catch {
        // Read-marker failure must not block locating the point.
      }
    }
    if (item.feature_id) onLocate(item);
    setOpen(false);
  }

  return (
    <div className="remediation-updates">
      <button type="button" className="remediation-updates__toggle" onClick={() => setOpen((value) => !value)}>
        <span>Workflow Notifications</span><strong>{unread}</strong>
      </button>
      {open && (
        <section className="remediation-updates__panel" aria-label="Remediation workflow notifications">
          <header>
            <div><strong>Workflow Notifications</strong><span>AE, AEE, and Commissioner updates</span></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          {loading && items.length === 0 && <p>Loading notifications…</p>}
          {error && <p className="remediation-updates__error">{error}</p>}
          {!loading && items.length === 0 && <p>No workflow notifications yet.</p>}
          <div className="remediation-updates__list">
            {items.map((item) => {
              const returned = item.source === "remediation_returned";
              return (
                <article key={item.notification_id} className={item.read_at ? "" : "remediation-updates__item--unread"}>
                  <div className="remediation-updates__badges">
                    <span className={returned ? "remediation-updates__denied" : "remediation-updates__approved"}>{SOURCE_LABEL[item.source]}</span>
                    {item.workflow_status && <span>{item.workflow_status.replaceAll("_", " ")}</span>}
                  </div>
                  <strong>{item.label ?? item.asset_type ?? item.feature_id ?? "Remediation item"}</strong>
                  <small>{item.dataset_name ?? "Survey dataset"} · {displayDate(item.created_at)}</small>
                  <p>{item.message}</p>
                  {(item.ae_name || item.aee_name) && <p>Solved by AE: {item.ae_name ?? "—"} · Approved by AEE: {item.aee_name ?? "—"}</p>}
                  {item.issue_description && <p><strong>Issue:</strong> {item.issue_description}</p>}
                  {item.work_completed && <p><strong>Work completed:</strong> {item.work_completed}</p>}
                  {item.ae_remarks && <blockquote>AE remarks: {item.ae_remarks}</blockquote>}
                  {item.aee_remarks && <blockquote>AEE remarks: {item.aee_remarks}</blockquote>}
                  {item.commissioner_remarks && <blockquote>Commissioner remarks: {item.commissioner_remarks}</blockquote>}
                  {(item.before_photo_url || item.after_photo_url) && (
                    <div className="point-verification-evidence-grid">
                      {item.before_photo_url && <a href={remediationEvidenceUrl(item.before_photo_url) ?? undefined} target="_blank" rel="noreferrer"><img src={remediationEvidenceUrl(item.before_photo_url) ?? undefined} alt="Before work" /></a>}
                      {item.after_photo_url && <a href={remediationEvidenceUrl(item.after_photo_url) ?? undefined} target="_blank" rel="noreferrer"><img src={remediationEvidenceUrl(item.after_photo_url) ?? undefined} alt="After work" /></a>}
                    </div>
                  )}
                  {item.feature_id && <button type="button" onClick={() => void locate(item)}>Locate point and view details</button>}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
