import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../context/AuthContext";
import {
  fetchRemediationUpdates,
  markRemediationUpdateRead,
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

export function RemediationUpdates({ refreshToken = 0, onLocate }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<RemediationUpdateItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFieldOfficer = user?.role === "ae" || user?.role === "aee";
  const unread = useMemo(() => items.filter((item) => !item.read_at).length, [items]);

  useEffect(() => {
    if (!isFieldOfficer) {
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
    const timer = window.setInterval(load, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [isFieldOfficer, user?.id, refreshToken]);

  if (!isFieldOfficer) return null;

  async function locate(item: RemediationUpdateItem) {
    if (!item.read_at) {
      try {
        await markRemediationUpdateRead(item.notification_id);
        setItems((current) => current.map((row) => row.notification_id === item.notification_id
          ? { ...row, read_at: new Date().toISOString() }
          : row));
      } catch {
        // A read-marker failure must not block locating the field point.
      }
    }
    if (item.feature_id) onLocate(item);
    setOpen(false);
  }

  return (
    <div className="remediation-updates">
      <button type="button" className="remediation-updates__toggle" onClick={() => setOpen((value) => !value)}>
        <span>Work Updates</span><strong>{unread}</strong>
      </button>
      {open && (
        <section className="remediation-updates__panel" aria-label="Remediation approval updates">
          <header>
            <div><strong>Remediation Updates</strong><span>Commissioner approvals and rejections</span></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          {loading && items.length === 0 && <p>Loading updates…</p>}
          {error && <p className="remediation-updates__error">{error}</p>}
          {!loading && items.length === 0 && <p>No remediation updates yet.</p>}
          <div className="remediation-updates__list">
            {items.map((item) => {
              const rejected = item.source === "remediation_rejected";
              return (
                <article key={item.notification_id} className={item.read_at ? "" : "remediation-updates__item--unread"}>
                  <div className="remediation-updates__badges">
                    <span className={rejected ? "remediation-updates__denied" : "remediation-updates__approved"}>{rejected ? "Rejected" : "Approved"}</span>
                    {item.workflow_status && <span>{item.workflow_status.replaceAll("_", " ")}</span>}
                  </div>
                  <strong>{item.label ?? item.asset_type ?? item.feature_id ?? "Remediation item"}</strong>
                  <small>{item.dataset_name ?? "Survey dataset"} · {displayDate(item.created_at)}</small>
                  <p>{item.message}</p>
                  {item.commissioner_remarks && <blockquote>{item.commissioner_remarks}</blockquote>}
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
