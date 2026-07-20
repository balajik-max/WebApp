import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { fetchFeatureById } from "../lib/features";
import {
  downloadPointVerificationExcel,
  downloadResolvedGdb,
  fetchPointVerification,
  remediationEvidenceUrl,
  startRemediationWork,
  submitCommissionerDecision,
  submitFieldRemediation,
  uploadRemediationEvidence,
  type PointVerificationRecord,
  type WorkflowHistoryItem,
  type WorkflowStatus,
} from "../lib/pointVerifications";
import type { UrbanFeature } from "../lib/types";
import type { AiVerificationContext } from "./MapCanvas";

interface Props {
  feature: UrbanFeature | null;
  aiVerification: AiVerificationContext | null;
  onClose: () => void;
  onUpdated: (feature: UrbanFeature) => void;
  onQueueChanged?: () => void;
}

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  AI_DETECTED: "AI detected · Available",
  WORK_IN_PROGRESS: "Work in progress",
  PENDING_COMMISSIONER_APPROVAL: "Pending Commissioner approval",
  REJECTED_BY_COMMISSIONER: "Rejected · Correction required",
  APPROVED_RESOLVED: "Commissioner approved · Blue in AI mode",
};

const STATUS_CLASS: Record<WorkflowStatus, string> = {
  AI_DETECTED: "open",
  WORK_IN_PROGRESS: "open",
  PENDING_COMMISSIONER_APPROVAL: "pending_admin",
  REJECTED_BY_COMMISSIONER: "rejected",
  APPROVED_RESOLVED: "resolved",
};

const FINDING_LABEL: Record<string, string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
  road_width_narrowing: "Road Width Narrowing",
};

function displayDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && typeof reason.body === "object" && reason.body) {
    const detail = (reason.body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => (item as { msg?: string }).msg ?? "Invalid value").join("; ");
    }
  }
  return reason instanceof Error ? reason.message : "Unexpected error";
}

function formatDistance(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)} m`;
}

function saveDownload(result: { blob: Blob; filename: string | null }, fallback: string) {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename ?? fallback;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function EvidenceImage({ title, url, filename }: { title: string; url: string | null; filename?: string | null }) {
  const fullUrl = remediationEvidenceUrl(url);
  if (!fullUrl) return null;
  return (
    <figure className="point-verification-evidence-card">
      <figcaption><strong>{title}</strong><span>{filename ?? "Preserved evidence"}</span></figcaption>
      <a href={fullUrl} target="_blank" rel="noreferrer"><img src={fullUrl} alt={title} /></a>
    </figure>
  );
}

function HistoryEntry({ entry }: { entry: WorkflowHistoryItem }) {
  return (
    <article className="point-verification-text-block">
      <span>{entry.event.replaceAll("_", " ")} · version {entry.version}</span>
      <p>{entry.actor_name ?? "System"} ({entry.actor_role?.toUpperCase() ?? "SYSTEM"}) · {displayDate(entry.occurred_at)}</p>
      {(entry.before_photo_url || entry.after_photo_url) && (
        <div className="point-verification-evidence-grid">
          <EvidenceImage title="Previous Before image" url={entry.before_photo_url} />
          <EvidenceImage title="Previous After image" url={entry.after_photo_url} />
        </div>
      )}
    </article>
  );
}

export function PointVerificationPanel({ feature, aiVerification, onClose, onUpdated, onQueueChanged }: Props) {
  const { user } = useAuth();
  const [record, setRecord] = useState<PointVerificationRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueSolved, setIssueSolved] = useState(false);
  const [shortDescription, setShortDescription] = useState("");
  const [remarks, setRemarks] = useState("");
  const [beforeImage, setBeforeImage] = useState<File | null>(null);
  const [afterImage, setAfterImage] = useState<File | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const requestContext = useMemo(() => aiVerification ? ({
    anomalyId: aiVerification.anomalyId,
    detectionMode: aiVerification.detectionMode,
  }) : null, [aiVerification]);

  useEffect(() => {
    if (!feature || !requestContext) {
      setRecord(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchPointVerification(feature.properties.id, requestContext, controller.signal)
      .then((next) => {
        setRecord(next);
        setIssueSolved(next.issue_solved);
        setShortDescription(next.short_description ?? "");
        setRemarks(next.remarks ?? "");
        setRejectionReason("");
      })
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") setError(errorMessage(reason));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [feature?.properties.id, requestContext]);

  useEffect(() => {
    if (!feature || !aiVerification) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feature, aiVerification, onClose, saving]);

  if (!feature || !aiVerification || !requestContext) return null;
  const activeFeature = feature;
  const activeAi = aiVerification;
  const activeRequest = requestContext;
  const status = record?.workflow_status ?? "AI_DETECTED";
  const isFieldOfficer = user?.role === "ae" || user?.role === "aee";
  const isCommissioner = user?.role === "commissioner";
  const isMla = user?.role === "mla";
  const ownsWork = Boolean(record?.field_submitter_id && record.field_submitter_id === user?.id);
  const canStart = isFieldOfficer && (
    status === "AI_DETECTED" || (status === "REJECTED_BY_COMMISSIONER" && ownsWork)
  );
  const canEdit = isFieldOfficer && ownsWork && status === "WORK_IN_PROGRESS";
  const canDecide = isCommissioner && status === "PENDING_COMMISSIONER_APPROVAL";

  const details = [
    ["Dataset", record?.dataset_name ?? activeFeature.properties.dataset_id],
    ["Layer", record?.source_layer ?? activeFeature.properties.category ?? "—"],
    ["Feature ID", activeFeature.properties.id],
    ["Asset type", record?.asset_type ?? activeFeature.properties.category ?? "—"],
    ["AI-detected issue", FINDING_LABEL[activeAi.anomalyType] ?? activeAi.anomalyType],
    ["Original AI condition", record?.original_ai_condition ?? activeAi.aiColor.toUpperCase()],
    ["AI point location", `${activeAi.latitude.toFixed(7)}, ${activeAi.longitude.toFixed(7)}`],
  ];

  async function refreshMap() {
    onQueueChanged?.();
    try {
      onUpdated(await fetchFeatureById(activeFeature.properties.id));
    } catch {
      // Workflow state is already updated; the map refresh token still reloads its overlays.
    }
  }

  async function perform(action: () => Promise<PointVerificationRecord>) {
    setSaving(true);
    setError(null);
    try {
      const next = await action();
      setRecord(next);
      await refreshMap();
      return next;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function startWork() {
    await perform(() => startRemediationWork(activeFeature.properties.id, activeRequest));
  }

  async function uploadEvidence() {
    if (!beforeImage || !afterImage) {
      setError("Before and After images are required.");
      return;
    }
    const next = await perform(() => uploadRemediationEvidence(
      activeFeature.properties.id,
      activeRequest,
      beforeImage,
      afterImage,
    ));
    if (next) {
      setBeforeImage(null);
      setAfterImage(null);
    }
  }

  async function submitWork(event: React.FormEvent) {
    event.preventDefault();
    await perform(() => submitFieldRemediation(activeFeature.properties.id, {
      ...activeRequest,
      issueSolved,
      shortDescription: shortDescription.trim(),
      remarks: remarks.trim() || null,
    }));
  }

  async function decide(decision: "APPROVE" | "REJECT") {
    if (decision === "REJECT" && !rejectionReason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    await perform(() => submitCommissionerDecision(activeFeature.properties.id, {
      ...activeRequest,
      decision,
      reason: decision === "REJECT" ? rejectionReason.trim() : null,
    }));
  }

  async function download(kind: "excel" | "gdb") {
    setDownloading(true);
    setError(null);
    try {
      if (kind === "excel") {
        saveDownload(await downloadPointVerificationExcel(activeFeature.properties.dataset_id), "ai_remediation_register.xlsx");
      } else {
        saveDownload(await downloadResolvedGdb(activeFeature.properties.dataset_id), "UPDATED_RESOLVED.gdb.zip");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(false);
    }
  }

  return createPortal(
    <div className="point-verification-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="point-verification-dialog point-verification-dialog--wide" role="dialog" aria-modal="true" aria-label="AI remediation workflow">
        <header className="point-verification-dialog__header">
          <div>
            <span className={`point-verification-status point-verification-status--${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
            <h2>AI Issue Remediation</h2>
            <p>AE and AEE use the same independent field workflow.</p>
          </div>
          <button type="button" className="point-verification-dialog__close" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </header>

        <div className="point-verification-dialog__body">
          <div className="point-verification-details">
            {details.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div>

          {loading && <p className="point-verification-message">Loading remediation state…</p>}
          {error && <p className="point-verification-error" role="alert">{error}</p>}

          {canStart && (
            <section className="point-verification-readonly">
              <strong>{status === "REJECTED_BY_COMMISSIONER" ? "Correct rejected work" : "Issue is available for field work"}</strong>
              <p>Starting is atomic. If another AE or AEE has already started this point, the server returns a conflict.</p>
              <button type="button" onClick={() => void startWork()} disabled={saving}>{saving ? "Starting…" : "Start Work"}</button>
            </section>
          )}

          {record?.field_submitter_id && (
            <section className="point-verification-submission">
              <div className="point-verification-section-title">
                <div><strong>Field workflow</strong><span>Started {displayDate(record.work_started_at)}</span></div>
              </div>
              <div className="point-verification-details point-verification-details--compact">
                <div><span>Field submitter</span><strong>{record.field_submitter_name ?? "—"}</strong></div>
                <div><span>Role</span><strong>{record.field_submitter_role?.toUpperCase() ?? "—"}</strong></div>
                <div><span>Submitted</span><strong>{displayDate(record.submitted_at)}</strong></div>
                <div><span>Version</span><strong>{record.submission_version}</strong></div>
              </div>
            </section>
          )}

          {canEdit && (
            <form className="point-verification-form" onSubmit={(event) => void submitWork(event)}>
              <h3>Field completion</h3>
              <label className="point-verification-checkbox">
                <input type="checkbox" checked={issueSolved} onChange={(event) => setIssueSolved(event.target.checked)} required />
                <span>Issue Solved / Work Performed</span>
              </label>
              <label>
                <span>Short Work Description</span>
                <textarea value={shortDescription} onChange={(event) => setShortDescription(event.target.value)} minLength={3} maxLength={2048} required />
              </label>
              <div className="point-verification-upload-grid">
                <label><span>Before Image</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setBeforeImage(event.target.files?.[0] ?? null)} /></label>
                <label><span>After Image</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAfterImage(event.target.files?.[0] ?? null)} /></label>
              </div>
              <label>
                <span>Optional Remarks</span>
                <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={4096} />
              </label>
              <div className="point-verification-gps-summary">
                <strong>Automatic backend GPS validation</strong>
                <span>Status: {record?.gps_validation_status?.replaceAll("_", " ") ?? "Upload original geotagged images"}</span>
                <span>Distance from AI point: {formatDistance(record?.evidence_distance_m)}</span>
                <span>Allowed distance: {formatDistance(record?.evidence_buffer_m)}</span>
                <small>Coordinates are extracted from photo EXIF. Manual coordinates are not accepted.</small>
              </div>
              <div className="point-verification-form__actions">
                <button type="button" onClick={() => void uploadEvidence()} disabled={saving || !beforeImage || !afterImage}>
                  {saving ? "Validating…" : "Upload & Validate Evidence"}
                </button>
                <button type="submit" disabled={saving || !issueSolved || shortDescription.trim().length < 3 || record?.gps_validation_status !== "PHOTO_EXIF_VERIFIED"}>
                  Submit Directly to Commissioner
                </button>
              </div>
            </form>
          )}

          {(record?.before_photo_url || record?.after_photo_url) && (
            <section className="point-verification-submission">
              <div className="point-verification-section-title"><div><strong>Current evidence</strong><span>Backend GPS validated</span></div></div>
              <div className="point-verification-evidence-grid">
                <EvidenceImage title="Before image" url={record.before_photo_url} filename={record.before_photo_filename} />
                <EvidenceImage title="After image" url={record.after_photo_url} filename={record.after_photo_filename} />
              </div>
              <div className="point-verification-details point-verification-details--compact">
                <div><span>Photo GPS</span><strong>{record.photo_latitude === null ? "—" : `${record.photo_latitude}, ${record.photo_longitude}`}</strong></div>
                <div><span>GPS result</span><strong>{record.gps_validation_status?.replaceAll("_", " ") ?? "—"}</strong></div>
                <div><span>Distance</span><strong>{formatDistance(record.evidence_distance_m)}</strong></div>
                <div><span>Allowed distance</span><strong>{formatDistance(record.evidence_buffer_m)}</strong></div>
              </div>
              {record.short_description && <div className="point-verification-text-block"><span>Short work description</span><p>{record.short_description}</p></div>}
              {record.remarks && <div className="point-verification-text-block"><span>Optional remarks</span><p>{record.remarks}</p></div>}
            </section>
          )}

          {canDecide && (
            <section className="point-verification-admin-review">
              <h3>Commissioner Decision</h3>
              <p>Confirm the submitted issue is resolved, or return it with a mandatory reason.</p>
              <label><span>Rejection reason</span><textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength={4096} /></label>
              <div className="point-verification-form__actions">
                <button type="button" onClick={() => void decide("REJECT")} disabled={saving || !rejectionReason.trim()}>Reject</button>
                <button type="button" onClick={() => void decide("APPROVE")} disabled={saving}>Approve as Resolved</button>
              </div>
            </section>
          )}

          {status === "REJECTED_BY_COMMISSIONER" && (
            <div className="point-verification-rejected">
              <strong>Commissioner rejected this submission.</strong>
              <span>Decided {displayDate(record?.commissioner_decided_at)} by {record?.commissioner_name ?? "Commissioner"}</span>
              <p>{record?.commissioner_remarks}</p>
            </div>
          )}

          {status === "APPROVED_RESOLVED" && (
            <div className="point-verification-resolved">
              <strong>Commissioner approved this remediation. It is Blue only while AI mode is ON.</strong>
              <span>AI OFF continues to use the original GDB/category colour.</span>
              <span>Approved {displayDate(record?.commissioner_decided_at)} by {record?.commissioner_name ?? "Commissioner"}</span>
            </div>
          )}

          {record && isCommissioner && (
            <details className="point-verification-text-block">
              <summary>Original GDB attributes (read only)</summary>
              <pre>{JSON.stringify(record.original_gdb_attributes, null, 2)}</pre>
            </details>
          )}

          {record && record.history.length > 0 && (
            <details className="point-verification-history">
              <summary>Complete workflow and resubmission history ({record.history.length})</summary>
              {record.history.map((entry, index) => <HistoryEntry key={`${entry.occurred_at}-${index}`} entry={entry} />)}
            </details>
          )}

          {isMla && <p className="point-verification-message">MLA access is read-only. All remediation write actions are blocked by the backend.</p>}
          {isFieldOfficer && status === "WORK_IN_PROGRESS" && !ownsWork && <p className="point-verification-message">Another AE/AEE is currently working on this issue.</p>}
          {isFieldOfficer && status === "PENDING_COMMISSIONER_APPROVAL" && <p className="point-verification-message">Submitted directly to Commissioner. No AEE review step exists.</p>}
        </div>

        <footer className="point-verification-dialog__footer">
          <button type="button" onClick={() => void download("excel")} disabled={downloading}>Export register</button>
          {!isMla && <button type="button" onClick={() => void download("gdb")} disabled={downloading}>Generate resolved GDB</button>}
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
