import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { fetchFeatureById } from "../lib/features";
import {
  downloadPointVerificationExcel,
  downloadResolvedGdb,
  fetchPointVerification,
  fetchPointVerificationById,
  remediationEvidenceUrl,
  startRemediationWork,
  submitAeeDecision,
  submitCommissionerAcceptance,
  submitFieldRemediation,
  uploadRemediationEvidence,
  type AeeCategory,
  type AiDetectionMode,
  type PointVerificationRecord,
  type WorkflowHistoryItem,
  type WorkflowStatus,
} from "../lib/pointVerifications";
import type { UrbanFeature } from "../lib/types";
import type { AiVerificationContext } from "./MapCanvas";

interface Props {
  feature: UrbanFeature | null;
  aiVerification: AiVerificationContext | null;
  verificationId?: string | null;
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
  pothole_status: "Pothole Condition",
  standing_water_status: "Standing Water",
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

export function OperationalPointVerificationPanel({
  feature,
  aiVerification,
  verificationId = null,
  onClose,
  onUpdated,
  onQueueChanged,
}: Props) {
  const { user } = useAuth();
  const [record, setRecord] = useState<PointVerificationRecord | null>(null);
  const [loadedFeature, setLoadedFeature] = useState<UrbanFeature | null>(null);
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

  const mapRequestContext = useMemo(() => aiVerification ? ({
    anomalyId: aiVerification.anomalyId,
    detectionMode: aiVerification.detectionMode,
  }) : null, [aiVerification]);

  useEffect(() => {
    const hasMapTarget = Boolean(feature && mapRequestContext);
    if (!verificationId && !hasMapTarget) {
      setRecord(null);
      setLoadedFeature(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSuccess(null);
    setRecord(null);
    if (!verificationId) setLoadedFeature(feature);

    const hydrateForm = (next: PointVerificationRecord) => {
      setRecord(next);
      setAeName(next.ae_name ?? "");
      setIssueDescription(next.issue_description ?? "");
      setWorkCompleted(next.work_completed ?? "");
      setRemarks(next.remarks ?? "");
      setAeeName(next.aee_name ?? "");
      setAeeCategory(next.aee_category ?? "GOOD");
      setAeeRemarks(next.aee_remarks ?? "");
      setCommissionerRemarks(next.commissioner_remarks ?? "");
    };

    const load = async () => {
      try {
        if (verificationId) {
          const next = await fetchPointVerificationById(verificationId, controller.signal);
          hydrateForm(next);
          setLoadedFeature(await fetchFeatureById(next.feature_id, controller.signal));
        } else if (feature && mapRequestContext) {
          hydrateForm(await fetchPointVerification(feature.properties.id, mapRequestContext, controller.signal));
        }
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") {
          setError(errorMessage(reason));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [verificationId, feature?.properties.id, mapRequestContext]);

  const hasTarget = Boolean(verificationId || (feature && aiVerification));
  useEffect(() => {
    if (!hasTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasTarget, onClose, saving]);

  if (!hasTarget) return null;

  const activeFeature = verificationId ? loadedFeature : feature;
  const activeRequest = verificationId
    ? (record?.anomaly_id && record.detection_mode
      ? { anomalyId: record.anomaly_id, detectionMode: record.detection_mode }
      : null)
    : mapRequestContext;
  const status = record?.workflow_status ?? null;

  if (!activeFeature || !activeRequest || !status) {
    return createPortal(
      <div className="point-verification-backdrop" role="dialog" aria-modal="true" aria-label="Approval notification">
        <section className="point-verification-dialog">
          <header className="point-verification-dialog__header">
            <div><span>AE → AEE → Commissioner</span><h2>Approval notification</h2></div>
            <button type="button" className="point-verification-dialog__close" onClick={onClose} aria-label="Close">×</button>
          </header>
          <div className="point-verification-dialog__body">
            {loading && <p>Loading the exact submitted workflow…</p>}
            {error && <p className="point-verification-message point-verification-message--error">{error}</p>}
            {!loading && !error && <p className="point-verification-message point-verification-message--error">This approval item is incomplete or no longer available.</p>}
          </div>
          <footer className="point-verification-dialog__footer"><button type="button" onClick={onClose}>Close</button></footer>
        </section>
      </div>,
      document.body,
    );
  }

  const readyRecord = record as PointVerificationRecord;
  const readyFeature = activeFeature as UrbanFeature;
  const readyRequest = activeRequest as { anomalyId: string; detectionMode: AiDetectionMode };

  const activeAiType = verificationId ? readyRecord.ai_anomaly_type : aiVerification?.anomalyType;
  const activeAiColor = verificationId ? readyRecord.ai_color : aiVerification?.aiColor;
  const activeLatitude = verificationId ? readyRecord.latitude : aiVerification?.latitude;
  const activeLongitude = verificationId ? readyRecord.longitude : aiVerification?.longitude;
  const isAe = user?.role === "ae";
  const isAee = user?.role === "aee";
  const isCommissioner = user?.role === "commissioner";
  const isMla = user?.role === "mla";
  const ownsWork = Boolean(readyRecord.field_submitter_id && readyRecord.field_submitter_id === user?.id);
  const canStart = isAe && (status === "AI_DETECTED" || (status === "RETURNED_BY_AEE" && ownsWork));
  const canEdit = isAe && ownsWork && status === "WORK_IN_PROGRESS";
  const canAeeDecide = isAee && status === "PENDING_AEE_APPROVAL";
  const canCommissionerAccept = isCommissioner && status === "AEE_APPROVED";
  const pointLocation = typeof activeLatitude === "number" && Number.isFinite(activeLatitude)
    && typeof activeLongitude === "number" && Number.isFinite(activeLongitude)
    ? `${activeLatitude.toFixed(7)}, ${activeLongitude.toFixed(7)}`
    : "Location unavailable";

  const details = [
    ["Dataset", readyRecord.dataset_name ?? readyFeature.properties.dataset_id],
    ["Layer", readyRecord.source_layer ?? readyFeature.properties.category ?? "—"],
    ["Feature ID", readyFeature.properties.id],
    ["Asset type", readyRecord.asset_type ?? readyFeature.properties.category ?? "—"],
    ["AI-detected issue", activeAiType ? (FINDING_LABEL[activeAiType] ?? activeAiType) : "—"],
    ["Original AI condition", readyRecord.original_ai_condition ?? activeAiColor?.toUpperCase() ?? "—"],
    ["AI point location", pointLocation],
  ];

  async function refreshMap() {
    onQueueChanged?.();
    window.dispatchEvent(new CustomEvent("remediation-notifications-changed"));
    try {
      onUpdated(await fetchFeatureById(readyFeature.properties.id));
    } catch {
      // Workflow state already changed; overlay refresh still runs.
    }
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
      setError(errorMessage(reason));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function startWork() {
    const correctingReturnedWork = status === "RETURNED_BY_AEE";
    const next = await perform(
      () => startRemediationWork(readyFeature.properties.id, readyRequest),
      correctingReturnedWork ? "Returned work reopened for correction." : "Work started by AE.",
    );
    if (next && correctingReturnedWork) {
      // The displayed field officer may change for every correction cycle.
      // Never silently reuse the previous manually entered AE name.
      setAeName("");
    }
  }

  async function uploadEvidence() {
    if (!beforeImage || !afterImage) {
      setError("Before and After images are required.");
      return;
    }
    const next = await perform(() => uploadRemediationEvidence(
      readyFeature.properties.id,
      readyRequest,
      beforeImage,
      afterImage,
    ), "Evidence uploaded and GPS verified.");
    if (next) {
      setBeforeImage(null);
      setAfterImage(null);
    }
  }

  async function submitToAee() {
    if (!aeName.trim() || !issueDescription.trim() || !workCompleted.trim()) {
      setError("AE Name, What was the issue, and What was solved are required.");
      return;
    }
    await perform(() => submitFieldRemediation(readyFeature.properties.id, {
      ...readyRequest,
      aeName: aeName.trim(),
      issueDescription: issueDescription.trim(),
      workCompleted: workCompleted.trim(),
      remarks: remarks.trim() || null,
    }), "Work submitted successfully. Approval request sent to AEE.");
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
    await perform(() => submitAeeDecision(readyFeature.properties.id, {
      ...readyRequest,
      aeeName: aeeName.trim(),
      category: aeeCategory,
      remarks: aeeRemarks.trim() || null,
    }), message);
  }

  async function acceptByCommissioner() {
    await perform(() => submitCommissionerAcceptance(readyFeature.properties.id, {
      ...readyRequest,
      remarks: commissionerRemarks.trim() || null,
    }), "Completed work accepted. AE and AEE have been notified.");
  }

  async function download(kind: "excel" | "gdb") {
    setDownloading(true);
    setError(null);
    try {
      if (kind === "excel") {
        saveDownload(await downloadPointVerificationExcel(readyRecord?.dataset_id), "ai-remediation-register.xlsx");
      } else if (readyRecord?.dataset_id) {
        saveDownload(await downloadResolvedGdb(readyRecord.dataset_id), "aee-approved-resolved-gdb.zip");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(false);
    }
  }

  return createPortal(
    <div className="point-verification-backdrop" role="dialog" aria-modal="true" aria-label="AI remediation workflow">
      <section className="point-verification-dialog">
        <header className="point-verification-dialog__header">
          <div>
            <span>AE → AEE → Commissioner</span>
            <h2>{readyRecord?.label ?? readyFeature.properties.category ?? "Field remediation"}</h2>
            <strong className={`point-verification-status point-verification-status--${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</strong>
          </div>
          <button type="button" className="point-verification-dialog__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="point-verification-dialog__body">
          {loading && <p>Loading workflow…</p>}
          {error && <p className="point-verification-message point-verification-message--error">{error}</p>}
          {success && <p className="point-verification-message">{success}</p>}

          <dl className="point-verification-details">
            {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>

          {canStart && (
            <div className="point-verification-action-card">
              <strong>{status === "RETURNED_BY_AEE" ? "Correct returned work" : "Issue is available for AE field work"}</strong>
              {status === "RETURNED_BY_AEE" && <p>AEE result: {readyRecord?.aee_category ?? "—"}. Remarks: {readyRecord?.aee_remarks ?? "Correction required"}</p>}
              <button type="button" onClick={() => void startWork()} disabled={saving}>Start Work</button>
            </div>
          )}

          {canEdit && (
            <div className="point-verification-form">
              <h3>AE Field Work</h3>
              <label>AE Name <input value={aeName} onChange={(event) => setAeName(event.target.value)} placeholder="Type AE name for this work" /></label>
              <label>Date and Time <input value={displayDate(new Date().toISOString())} readOnly /></label>
              <label>What was the issue? <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} rows={3} /></label>
              <label>What was solved / work completed? <textarea value={workCompleted} onChange={(event) => setWorkCompleted(event.target.value)} rows={3} /></label>
              <label>Remarks <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} rows={2} /></label>
              <div className="point-verification-upload-grid">
                <label>Before Image <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setBeforeImage(event.target.files?.[0] ?? null)} /></label>
                <label>After Image <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAfterImage(event.target.files?.[0] ?? null)} /></label>
              </div>
              <button type="button" onClick={() => void uploadEvidence()} disabled={saving || !beforeImage || !afterImage}>Upload Images and Validate GPS</button>
              <div className="point-verification-gps-summary">
                <strong>GPS: {readyRecord?.gps_validation_status?.replaceAll("_", " ") ?? "Not validated"}</strong>
                <span>Distance: {formatDistance(readyRecord?.evidence_distance_m)} / Allowed: {formatDistance(readyRecord?.evidence_buffer_m)}</span>
              </div>
              <button type="button" onClick={() => void submitToAee()} disabled={saving || readyRecord?.gps_validation_status !== "PHOTO_EXIF_VERIFIED"}>Send to AEE for Approval</button>
            </div>
          )}

          {readyRecord && (readyRecord.before_photo_url || readyRecord.after_photo_url) && (
            <div className="point-verification-evidence-grid">
              <EvidenceImage title="Before image" url={readyRecord.before_photo_url} filename={readyRecord.before_photo_filename} />
              <EvidenceImage title="After image" url={readyRecord.after_photo_url} filename={readyRecord.after_photo_filename} />
            </div>
          )}

          {readyRecord && readyRecord.issue_solved && (
            <section className="point-verification-text-block">
              <h3>AE Submission</h3>
              <p><strong>Solved By:</strong> {readyRecord.ae_name ?? "—"}</p>
              <p><strong>Logged-in AE account:</strong> {readyRecord.field_submitter_account_name ?? "—"}</p>
              <p><strong>Issue:</strong> {readyRecord.issue_description ?? "—"}</p>
              <p><strong>Work completed:</strong> {readyRecord.work_completed ?? "—"}</p>
              <p><strong>AE remarks:</strong> {readyRecord.remarks ?? "—"}</p>
              <p><strong>Submitted:</strong> {displayDate(readyRecord.submitted_at)}</p>
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

          {readyRecord?.aee_category && (
            <section className="point-verification-text-block">
              <h3>AEE Decision</h3>
              <p><strong>Approved/Reviewed By:</strong> {readyRecord.aee_name ?? "—"}</p>
              <p><strong>Logged-in AEE account:</strong> {readyRecord.aee_account_name ?? "—"}</p>
              <p><strong>Category:</strong> {readyRecord.aee_category}</p>
              <p><strong>AEE remarks:</strong> {readyRecord.aee_remarks ?? "—"}</p>
              <p><strong>Decision time:</strong> {displayDate(readyRecord.aee_decided_at)}</p>
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
              <p><strong>Accepted By:</strong> {readyRecord?.commissioner_name ?? "Commissioner"}</p>
              <p><strong>Accepted on:</strong> {displayDate(readyRecord?.commissioner_decided_at)}</p>
              <p><strong>Remarks:</strong> {readyRecord?.commissioner_remarks ?? "—"}</p>
            </section>
          )}

          {readyRecord && (isCommissioner || isMla) && (
            <details className="point-verification-text-block">
              <summary>Original GDB attributes (read only)</summary>
              <pre>{JSON.stringify(readyRecord.original_gdb_attributes, null, 2)}</pre>
            </details>
          )}

          {readyRecord && readyRecord.history.length > 0 && (
            <details className="point-verification-history">
              <summary>Complete workflow history ({readyRecord.history.length})</summary>
              {readyRecord.history.map((entry, index) => <HistoryEntry key={`${entry.occurred_at}-${index}`} entry={entry} />)}
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
