import type { ActivityRow } from "../lib/workflow";

interface Props {
  rows: ActivityRow[] | null;
}

const ACTION_LABEL: Record<string, string> = {
  login: "signed in",
  logout: "signed out",
  user_created: "user created",
  dataset_uploaded: "dataset uploaded",
  dataset_status_changed: "dataset status changed",
  feature_created: "feature created",
  feature_updated: "feature updated",
  feature_versioned: "new version",
  review_assigned: "review opened",
  review_status_changed: "status changed",
  comment_posted: "comment added",
  survey_requested: "survey requested",
  survey_status_changed: "survey status changed",
};

const ACTION_COLOR: Record<string, string> = {
  review_status_changed: "#f5c542",
  comment_posted: "#3aa1ff",
  feature_versioned: "#c47af5",
  dataset_uploaded: "#5be08a",
  review_assigned: "#ff7a3d",
  survey_requested: "#ff5a3d",
};

export function ActivityTimeline({ rows }: Props) {
  if (!rows) {
    return <p className="workspace__muted">Loading activity…</p>;
  }
  if (rows.length === 0) {
    return <p className="workspace__muted">No activity on this feature yet.</p>;
  }

  return (
    <ol className="timeline" data-testid="activity-timeline">
      {rows.map((row) => {
        const color = ACTION_COLOR[row.action] ?? "#8ea3a0";
        const label = ACTION_LABEL[row.action] ?? row.action;
        const summary = summarize(row);
        return (
          <li key={row.id} data-testid={`activity-row-${row.id}`}>
            <span className="timeline__dot" style={{ background: color }} />
            <div className="timeline__body">
              <div className="timeline__head">
                <b>{row.actor_name ?? "system"}</b>
                <span className="timeline__action">{label}</span>
              </div>
              {summary && <div className="timeline__summary">{summary}</div>}
              <time className="timeline__time">{formatDate(row.created_at)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function summarize(row: ActivityRow): string | null {
  const p = row.payload ?? {};
  if (row.action === "review_status_changed") {
    return `${p.from ?? "?"} → ${p.to ?? "?"}`;
  }
  if (row.action === "comment_posted") {
    const mentions = Array.isArray(p.mentions) ? (p.mentions as string[]).length : 0;
    return mentions > 0 ? `mentioned ${mentions} user(s)` : null;
  }
  if (row.action === "feature_versioned") {
    return `v${p.version_number ?? "?"} · ${p.filename ?? ""}`;
  }
  if (row.action === "dataset_uploaded") {
    return String(p.filename ?? "");
  }
  return null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
