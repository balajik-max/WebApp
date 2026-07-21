import { useEffect, useMemo, useRef, useState } from "react";
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
  submitAeeDecision,
  submitCommissionerAcceptance,
  submitFieldRemediation,
  uploadRemediationEvidence,
  type AeeCategory,
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
  AI_DETECTED: "AI detected · Available to AE",
  WORK_IN_PROGRESS: "AE work in progress",
  PENDING_AEE_APPROVAL: "Sent to AEE for approval",
  RETURNED_BY_AEE: "Returned by AEE · Correction required",
  AEE_APPROVED: "AEE approved as Good · Blue in AI mode",
  COMMISSIONER_ACCEPTED: "Commissioner accepted · Blue in AI mode",
};

const STATUS_CLASS: Record<WorkflowStatus, string> = {
  AI_DETECTED: "open",
  WORK_IN_PROGRESS: "open",
  PENDING_AEE_APPROVAL: "pending_admin",
  RETURNED_BY_AEE: "rejected",
  AEE_APPROVED: "resolved",
  COMMISSIONER_ACCEPTED: "resolved",
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
      {Object.keys(entry.details).length > 0 && <pre>{JSON.stringify(entry.details, null, 2)}</pre>}
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
  const [success, setSuccess] = useState<string | null>(null);

  const [aeName, setAeName] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [workCompleted, setWorkCompleted] = useState("");
  const [remarks, setRemarks] = useState("");
  const [beforeImage, setBeforeImage] = useState<File | null>(null);
  const [afterImage, setAfterImage] = useState<File | null>(null);

  const [aeeName, setAeeName] = useState("");
  const [aeeCategory, setAeeCategory] = useState<AeeCategory>("GOOD");
  const [aeeRemarks, setAeeRemarks] = useState("");
  const [commissionerRemarks, setCommissionerRemarks] = useState("");
  const formRef = useRef<HTMLDivElement | null>(null);
  const messageRef = useRef<HTMLDivElement | null>(null);

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
    setSuccess(null);
    fetchPointVerification(feature.properties.id, requestContext, controller.signal)
      .then((next) => {
        setRecord(next);
        setAeName(next.ae_name ?? "");
        setIssueDescription(next.issue_description ?? "");
        setWorkCompleted(next.work_completed ?? "");
        setRemarks(next.remarks ?? "");
        setAeeName(next.aee_name ?? "");
        setAeeCategory(next.aee_category ?? "GOOD");
        setAeeRemarks(next.aee_remarks ?? "");
        setCommissionerRemarks(next.commissioner_remarks ?? "");
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
  const isAe = user?.role === "ae";
  const isAee = user?.role === "aee";
  const isCommissioner = user?.role === "commissioner";
  const isMla = user?.role === "mla";
  const ownsWork = Boolean(record?.field_submitter_id && record.field_submitter_id === user?.id);
  const canStart = isAe && (status === "AI_DETECTED" || (status === "RETURNED_BY_AEE" && ownsWork));
  const canEdit = isAe && ownsWork && status === "WORK_IN_PROGRESS";
  const canAeeDecide = isAee && status === "PENDING_AEE_APPROVAL";
  const canCommissionerAccept = isCommissioner && status === "AEE_APPROVED";

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
    try {
      onUpdated(await fetchFeatureById(activeFeature.properties.id));
    } catch {
      // Workflow state already changed; overlay refresh still runs.
    } finally {
      // Refresh the map overlay, role queue, and notifications once after the
      // mutation has completed. Triggering this before and after onUpdated
      // caused duplicate requests and confusing duplicate notification loads.
      onQueueChanged?.();
    }
  }

  function showError(message: string) {
    setSuccess(null);
    setError(message);
    window.requestAnimationFrame(() => {
      messageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  async function perform(action: () => Promise<PointVerificationRecord>, message?: string) {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await action();
      setRecord(next);
      if (message) setSuccess(message);
      await refreshMap();
      return next;
    } catch (reason) {
      showError(errorMessage(reason));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function startWork() {
    const correctingReturnedWork = status === "RETURNED_BY_AEE";
    const next = await perform(
      () => startRemediationWork(activeFeature.properties.id, activeRequest),
      correctingReturnedWork ? "Returned work reopened for correction." : "Work started by AE.",
    );
    if (next) {
      if (correctingReturnedWork) {
        // The displayed field officer may change for every correction cycle.
        // Never silently reuse the previous manually entered AE name.
        setAeName("");
      }
      window.requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  function evidenceError(reason: unknown): string {
    const message = errorMessage(reason);
    if (/no GPS metadata/i.test(message)) {
      return `${message} Select the original camera JPG/JPEG file. Screenshots, PNG exports, edited copies, and messaging-app downloads usually remove GPS.`;
    }
    if (/allowed distance|outside/i.test(message)) {
      return `${message}. Use a photo captured at the selected asset location.`;
    }
    return message;
  }

  function isOriginalJpeg(file: File): boolean {
    const lowerName = file.name.toLowerCase();
    return file.type === "image/jpeg" || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg");
  }

  async function submitToAee() {
    if (!aeName.trim() || !issueDescription.trim() || !workCompleted.trim()) {
      showError("AE Name, What was the issue, and What was solved are required.");
      return;
    }

    const replacingEvidence = Boolean(beforeImage || afterImage);
    const evidenceAlreadyVerified = record?.gps_validation_status === "PHOTO_EXIF_VERIFIED";
    if (!evidenceAlreadyVerified || replacingEvidence) {
      if (!beforeImage || !afterImage) {
        showError("Choose both Before and After images before sending the work to AEE.");
        return;
      }
      if (!isOriginalJpeg(afterImage)) {
        showError("After Image must be the original geotagged camera JPG/JPEG. PNG, screenshots, edited copies, and messaging-app images normally do not contain GPS EXIF.");
        return;
      }
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      let current = record;
      if (!evidenceAlreadyVerified || replacingEvidence) {
        current = await uploadRemediationEvidence(
          activeFeature.properties.id,
          activeRequest,
          beforeImage!,
          afterImage!,
        );
        setRecord(current);
      }

      if (current?.gps_validation_status !== "PHOTO_EXIF_VERIFIED") {
        throw new Error("Photo GPS verification did not complete. Use the original geotagged After camera image.");
      }

      const submitted = await submitFieldRemediation(activeFeature.properties.id, {
        ...activeRequest,
        aeName: aeName.trim(),
        issueDescription: issueDescription.trim(),
        workCompleted: workCompleted.trim(),
        remarks: remarks.trim() || null,
      });
      setRecord(submitted);
      setBeforeImage(null);
      setAfterImage(null);
      setSuccess("Work submitted successfully. Approval request sent to AEE.");
      await refreshMap();
    } catch (reason) {
      showError(evidenceError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function reviewByAee() {
    if (!aeeName.trim()) {
      setError("AEE Name is required.");
      return;
    }
    if (aeeCategory !== "GOOD" && !aeeRemarks.trim()) {
      setError("AEE remarks are required for Moderate or Bad work.");
      return;
    }
    const message = aeeCategory === "GOOD"
      ? "Approved as Good. The AI point is now Blue and the Commissioner has been notified."
      : `Returned to AE as ${aeeCategory.toLowerCase()} for correction.`;
    await perform(() => submitAeeDecision(activeFeature.properties.id, {
      ...activeRequest,
      aeeName: aeeName.trim(),
      category: aeeCategory,
      remarks: aeeRemarks.trim() || null,
    }), message);
  }

  async function acceptByCommissioner() {
    await perform(() => submitCommissionerAcceptance(activeFeature.properties.id, {
      ...activeRequest,
      remarks: commissionerRemarks.trim() || null,
    }), "Completed work accepted. AE and AEE have been notified.");
  }

  async function download(kind: "excel" | "gdb") {
    setDownloading(true);
    setError(null);
    try {
      if (kind === "excel") {
        saveDownload(await downloadPointVerificationExcel(record?.dataset_id), "ai-remediation-register.xlsx");
      } else if (record?.dataset_id) {
        saveDownload(await downloadResolvedGdb(record.dataset_id), "aee-approved-resolved-gdb.zip");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(false);
    }
  }

  return createPortal(
    <div
      className="point-verification-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="point-verification-dialog point-verification-dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="AI remediation workflow"
      >
        <header className="point-verification-dialog__header">
          <div>
            <span>AE → AEE → Commissioner</span>
            <h2>{record?.label ?? activeFeature.properties.category ?? "Field remediation"}</h2>
            <strong className={`point-verification-status point-verification-status--${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</strong>
          </div>
          <button type="button" className="point-verification-dialog__close" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </header>

        <div className="point-verification-dialog__body">
          <div
            ref={messageRef}
            aria-live="polite"
            style={{
              position: "sticky",
              top: -20,
              zIndex: 6,
              margin: "-20px -22px 14px",
              padding: "12px 22px 2px",
              background: "var(--surface, #fff)",
            }}
          >
            {loading && <p>Loading workflow…</p>}
            {error && <p className="point-verification-error" style={{ margin: "0 0 10px", fontWeight: 800, lineHeight: 1.45 }}>{error}</p>}
            {success && <p className="point-verification-message" style={{ margin: "0 0 10px", padding: "10px 12px", borderRadius: 10, background: "rgba(5, 150, 105, 0.12)", color: "#047857", fontWeight: 800 }}>{success}</p>}
          </div>

          <dl className="point-verification-details">
            {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>

          {canStart && (
            <div className="point-verification-action-card">
              <strong>{status === "RETURNED_BY_AEE" ? "Correct returned work" : "Issue is available for AE field work"}</strong>
              {status === "RETURNED_BY_AEE" && <p>AEE result: {record?.aee_category ?? "—"}. Remarks: {record?.aee_remarks ?? "Correction required"}</p>}
              <button type="button" onClick={() => void startWork()} disabled={saving}>Start Work</button>
            </div>
          )}

          {canEdit && (
            <div ref={formRef} className="point-verification-form">
              <h3>AE Field Work</h3>
              <p className="point-verification-evidence-note">Start Work is active. Complete this form and use the single Send button below.</p>
              <label>AE Name <input value={aeName} onChange={(event) => setAeName(event.target.value)} placeholder="Type AE name for this work" /></label>
              <label>Date and Time <input value={displayDate(record?.work_started_at)} readOnly /></label>
              <label>What was the issue? <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} rows={3} /></label>
              <label>What was solved / work completed? <textarea value={workCompleted} onChange={(event) => setWorkCompleted(event.target.value)} rows={3} /></label>
              <label>Remarks <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} rows={2} /></label>
              <div className="point-verification-upload-grid">
                <label>
                  Before Image
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setBeforeImage(event.target.files?.[0] ?? null)} />
                  <small style={{ overflowWrap: "anywhere", color: "var(--muted, #64748b)" }}>{beforeImage?.name ?? record?.before_photo_filename ?? "Choose the before-work image"}</small>
                </label>
                <label>
                  After Image — original geotagged camera JPG/JPEG
                  <input type="file" accept="image/jpeg,.jpg,.jpeg" onChange={(event) => setAfterImage(event.target.files?.[0] ?? null)} />
                  <small style={{ overflowWrap: "anywhere", color: "var(--muted, #64748b)" }}>{afterImage?.name ?? record?.after_photo_filename ?? "Choose the original after-work camera photo"}</small>
                </label>
              </div>
              <p
                className="point-verification-evidence-note"
                style={{
                  padding: "11px 12px",
                  border: "1px solid rgba(217, 119, 6, 0.4)",
                  borderRadius: 10,
                  background: "rgba(217, 119, 6, 0.1)",
                  color: "#92400e",
                  fontWeight: 750,
                }}
              >
                The After image must contain GPS EXIF and be captured near the selected AI point. Do not use a screenshot, PNG export, edited copy, or messaging-app download.
              </p>
              <div className="point-verification-gps-summary">
                <strong>GPS: {record?.gps_validation_status?.replaceAll("_", " ") ?? "Will be checked when you send"}</strong>
                <span>Distance: {formatDistance(record?.evidence_distance_m)} / Allowed: {formatDistance(record?.evidence_buffer_m)}</span>
              </div>
              <button className="point-verification-submit" type="button" onClick={() => void submitToAee()} disabled={saving}>
                {saving ? "Validating evidence and sending…" : "Send to AEE for Approval"}
              </button>
            </div>
          )}

          {record && (record.before_photo_url || record.after_photo_url) && (
            <div className="point-verification-evidence-grid">
              <EvidenceImage title="Before image" url={record.before_photo_url} filename={record.before_photo_filename} />
              <EvidenceImage title="After image" url={record.after_photo_url} filename={record.after_photo_filename} />
            </div>
          )}

          {record && record.issue_solved && (
            <section className="point-verification-text-block">
              <h3>AE Submission</h3>
              <p><strong>Solved By:</strong> {record.ae_name ?? "—"}</p>
              <p><strong>Logged-in AE account:</strong> {record.field_submitter_account_name ?? "—"}</p>
              <p><strong>Issue:</strong> {record.issue_description ?? "—"}</p>
              <p><strong>Work completed:</strong> {record.work_completed ?? "—"}</p>
              <p><strong>AE remarks:</strong> {record.remarks ?? "—"}</p>
              <p><strong>Submitted:</strong> {displayDate(record.submitted_at)}</p>
            </section>
          )}

          {canAeeDecide && (
            <div className="point-verification-form">
              <h3>AEE Review</h3>
              <label>AEE Name <input value={aeeName} onChange={(event) => setAeeName(event.target.value)} placeholder="Type AEE name for this approval" /></label>
              <label>Work Category
                <select value={aeeCategory} onChange={(event) => setAeeCategory(event.target.value as AeeCategory)}>
                  <option value="GOOD">Good</option>
                  <option value="MODERATE">Moderate</option>
                  <option value="BAD">Bad</option>
                </select>
              </label>
              <label>AEE Remarks <textarea value={aeeRemarks} onChange={(event) => setAeeRemarks(event.target.value)} rows={3} /></label>
              <button type="button" onClick={() => void reviewByAee()} disabled={saving}>{aeeCategory === "GOOD" ? "Approve as Good" : "Return to AE"}</button>
            </div>
          )}

          {record?.aee_category && (
            <section className="point-verification-text-block">
              <h3>AEE Decision</h3>
              <p><strong>Approved/Reviewed By:</strong> {record.aee_name ?? "—"}</p>
              <p><strong>Logged-in AEE account:</strong> {record.aee_account_name ?? "—"}</p>
              <p><strong>Category:</strong> {record.aee_category}</p>
              <p><strong>AEE remarks:</strong> {record.aee_remarks ?? "—"}</p>
              <p><strong>Decision time:</strong> {displayDate(record.aee_decided_at)}</p>
            </section>
          )}

          {canCommissionerAccept && (
            <div className="point-verification-form">
              <h3>Commissioner Acceptance</h3>
              <p>AE work is approved as Good by AEE and is already Blue in AI mode.</p>
              <label>Commissioner Remarks <textarea value={commissionerRemarks} onChange={(event) => setCommissionerRemarks(event.target.value)} rows={3} /></label>
              <button type="button" onClick={() => void acceptByCommissioner()} disabled={saving}>Accept Completed Work</button>
            </div>
          )}

          {status === "COMMISSIONER_ACCEPTED" && (
            <section className="point-verification-text-block">
              <h3>Commissioner Acceptance</h3>
              <p><strong>Accepted By:</strong> {record?.commissioner_name ?? "Commissioner"}</p>
              <p><strong>Accepted on:</strong> {displayDate(record?.commissioner_decided_at)}</p>
              <p><strong>Remarks:</strong> {record?.commissioner_remarks ?? "—"}</p>
            </section>
          )}

          {record && (isCommissioner || isMla) && (
            <details className="point-verification-text-block">
              <summary>Original GDB attributes (read only)</summary>
              <pre>{JSON.stringify(record.original_gdb_attributes, null, 2)}</pre>
            </details>
          )}

          {record && record.history.length > 0 && (
            <details className="point-verification-history">
              <summary>Complete workflow history ({record.history.length})</summary>
              {record.history.map((entry, index) => <HistoryEntry key={`${entry.occurred_at}-${index}`} entry={entry} />)}
            </details>
          )}

          {isMla && <p className="point-verification-message">MLA access is complete visualization only. All write actions are blocked by the backend.</p>}
          {isAee && status !== "PENDING_AEE_APPROVAL" && <p className="point-verification-message">AEE can review only work sent by AE for approval.</p>}
          {isCommissioner && status !== "AEE_APPROVED" && status !== "COMMISSIONER_ACCEPTED" && <p className="point-verification-message">Commissioner receives only AEE-approved Good work.</p>}
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
