import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { addAssignedWork, findAssignedWork, type AssignedWorkRecord } from "../lib/assignedWork";
import { fetchFeatureById } from "../lib/features";
import {
  downloadPointVerificationExcel,
  downloadResolvedGdb,
  fetchPointVerification,
  remediationEvidenceUrl,
  submitAdminDecision,
  submitArchitectRemediation,
  type PointVerificationRecord,
  type VerifiedCondition,
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

function localDateTimeValue(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function localDateValue(date = new Date()): string {
  return localDateTimeValue(date).slice(0, 10);
}

function displayDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function attributeValue(feature: UrbanFeature, ...keys: string[]): string {
  const attributes = feature.properties.attributes ?? {};
  for (const key of keys) {
    const value = attributes[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value);
  }
  return "—";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && typeof reason.body === "object" && reason.body) {
    const detail = (reason.body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return reason instanceof Error ? reason.message : "Unexpected error";
}

function formatDistance(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)} m`;
}

const MODE_LABEL = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
} as const;

const FINDING_LABEL = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
  road_width_narrowing: "Road Width Narrowing",
} as const;

const ASSIGN_WORK_MODES = new Set(["manholes", "poles"]);

const ASSIGN_DEFAULT_ISSUE_NAME: Record<string, string> = {
  manholes: "Manhole Fix",
  poles: "Pole Fix",
};

const STATUS_LABEL: Record<string, string> = {
  open: "Awaiting Architect work",
  pending_admin: "Pending Admin verification",
  rejected: "Returned to Architect",
  resolved: "Admin approved · Blue",
};

function EvidenceImage({ title, url, filename }: { title: string; url: string | null; filename: string | null }) {
  const fullUrl = remediationEvidenceUrl(url);
  if (!fullUrl) return null;
  return (
    <figure className="point-verification-evidence-card">
      <figcaption><strong>{title}</strong><span>{filename ?? "Uploaded photo"}</span></figcaption>
      <a href={fullUrl} target="_blank" rel="noreferrer" title={`Open ${title} in a new tab`}>
        <img src={fullUrl} alt={title} />
      </a>
    </figure>
  );
}

export function PointVerificationPanel({ feature, aiVerification, onClose, onUpdated, onQueueChanged }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const isArchitect = user?.role === "architect";
  const [record, setRecord] = useState<PointVerificationRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [gdbDownloading, setGdbDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [issueSummary, setIssueSummary] = useState("");
  const [workCompleted, setWorkCompleted] = useState("");
  const [workStartedAt, setWorkStartedAt] = useState("");
  const [workCompletedAt, setWorkCompletedAt] = useState(localDateTimeValue());
  const [beforePhoto, setBeforePhoto] = useState<File | null>(null);
  const [afterPhoto, setAfterPhoto] = useState<File | null>(null);
  const [beforePreview, setBeforePreview] = useState<string | null>(null);
  const [afterPreview, setAfterPreview] = useState<string | null>(null);
  const [adminRemarks, setAdminRemarks] = useState("");
  const [verifiedCondition, setVerifiedCondition] = useState<VerifiedCondition>("good");
  const [decision, setDecision] = useState<"approve" | "reject">("approve");

  const [showAssignWork, setShowAssignWork] = useState(false);
  const [assignIssueName, setAssignIssueName] = useState("Manhole Fix");
  const [assignDate, setAssignDate] = useState(localDateValue());
  const [assignDeadline, setAssignDeadline] = useState("");
  const [assignRemarks, setAssignRemarks] = useState("");
  const [assignedRecord, setAssignedRecord] = useState<AssignedWorkRecord | null>(null);
  const [assignNotice, setAssignNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!feature || !aiVerification) {
      setRecord(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchPointVerification(
      feature.properties.id,
      { anomalyId: aiVerification.anomalyId, detectionMode: aiVerification.detectionMode },
      controller.signal,
    )
      .then((next) => {
        setRecord(next);
        setIssueSummary(next.issue_summary ?? next.survey_condition ?? "");
        setWorkCompleted(next.work_completed ?? "");
        setWorkStartedAt(next.work_started_at ? localDateTimeValue(new Date(next.work_started_at)) : "");
        setWorkCompletedAt(next.work_completed_at ? localDateTimeValue(new Date(next.work_completed_at)) : localDateTimeValue());
        setAdminRemarks(next.remarks ?? "");
        const nextCondition = next.verified_condition ?? "good";
        setVerifiedCondition(nextCondition);
        setDecision(nextCondition === "good" ? "approve" : "reject");
      })
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") setError(errorMessage(reason));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [feature?.properties.id, aiVerification?.anomalyId, aiVerification?.detectionMode]);

  useEffect(() => {
    if (!beforePhoto) {
      setBeforePreview(null);
      return;
    }
    const url = URL.createObjectURL(beforePhoto);
    setBeforePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [beforePhoto]);

  useEffect(() => {
    if (!afterPhoto) {
      setAfterPreview(null);
      return;
    }
    const url = URL.createObjectURL(afterPhoto);
    setAfterPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [afterPhoto]);

  useEffect(() => {
    if (!feature || !aiVerification) {
      setAssignedRecord(null);
      return;
    }
    setAssignedRecord(findAssignedWork(feature.properties.id, aiVerification.anomalyId));
  }, [feature?.properties.id, aiVerification?.anomalyId]);

  useEffect(() => {
    if (!assignNotice) return;
    const timeout = window.setTimeout(() => setAssignNotice(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [assignNotice]);

  useEffect(() => {
    if (!feature || !aiVerification) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showAssignWork) {
        setShowAssignWork(false);
        return;
      }
      if (!saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feature, aiVerification, onClose, saving, showAssignWork]);

  const details = useMemo(() => {
    if (!feature || !aiVerification) return [];
    return [
      ["Feature ID", attributeValue(feature, "FID", "fid", "OBJECTID", "objectid") !== "—" ? attributeValue(feature, "FID", "fid", "OBJECTID", "objectid") : feature.properties.id],
      ["AI mode", MODE_LABEL[aiVerification.detectionMode]],
      ["AI finding", FINDING_LABEL[aiVerification.anomalyType]],
      ["AI severity", `${aiVerification.aiColor.toUpperCase()} · ${aiVerification.severityScore.toFixed(1)}`],
      ["AI detected", displayDate(aiVerification.detectedAt)],
      ["AI point latitude", aiVerification.latitude.toFixed(7)],
      ["AI point longitude", aiVerification.longitude.toFixed(7)],
      ["Layer", attributeValue(feature, "gdb_layer", "LAYER") !== "—" ? attributeValue(feature, "gdb_layer", "LAYER") : feature.properties.category ?? "—"],
      ["Condition", attributeValue(feature, "Condition", "condition")],
      ["Road", attributeValue(feature, "Road_Name", "road_name")],
      ["Survey X / Easting", attributeValue(feature, "X_Long", "x_long")],
      ["Survey Y / Northing", attributeValue(feature, "Y_Lat", "y_lat")],
    ];
  }, [feature, aiVerification]);

  if (!feature || !aiVerification) return null;
  const activeFeature = feature;
  const activeAi = aiVerification;
  const currentStatus = record?.status ?? "open";
  const canArchitectSubmit = isArchitect && (currentStatus === "open" || currentStatus === "rejected");
  const canAdminDecide = isAdmin && currentStatus === "pending_admin";
  const isAee = user?.role === "aee";
  const isAeeRedAssignableIssue = isAee && ASSIGN_WORK_MODES.has(activeAi.detectionMode) && activeAi.aiColor === "red";
  const statusLabel = isAeeRedAssignableIssue && currentStatus === "open" ? "Fix Pending" : STATUS_LABEL[currentStatus] ?? currentStatus;

  async function refreshFeature() {
    const refreshed = await fetchFeatureById(activeFeature.properties.id);
    onUpdated(refreshed);
    onQueueChanged?.();
  }

  async function submitArchitect(event: React.FormEvent) {
    event.preventDefault();
    if (!beforePhoto || !afterPhoto) return;
    setSaving(true);
    setError(null);
    try {
      const next = await submitArchitectRemediation(activeFeature.properties.id, {
        anomalyId: activeAi.anomalyId,
        detectionMode: activeAi.detectionMode,
        issueSummary: issueSummary.trim(),
        workCompleted: workCompleted.trim(),
        workStartedAt: workStartedAt ? new Date(workStartedAt).toISOString() : null,
        workCompletedAt: new Date(workCompletedAt).toISOString(),
        beforePhoto,
        afterPhoto,
      });
      setRecord(next);
      setBeforePhoto(null);
      setAfterPhoto(null);
      await refreshFeature();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function submitDecision() {
    if (!adminRemarks.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await submitAdminDecision(activeFeature.properties.id, {
        anomaly_id: activeAi.anomalyId,
        detection_mode: activeAi.detectionMode,
        decision,
        verified_condition: verifiedCondition,
        remarks: adminRemarks.trim(),
      });
      setRecord(next);
      await refreshFeature();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function downloadExcel() {
    setDownloading(true);
    setError(null);
    try {
      const result = await downloadPointVerificationExcel(activeFeature.properties.dataset_id);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename ?? "ai_remediation_register.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(false);
    }
  }

  async function downloadUpdatedGdb() {
    setGdbDownloading(true);
    setError(null);
    try {
      const result = await downloadResolvedGdb(activeFeature.properties.dataset_id);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename ?? "UPDATED_RESOLVED.gdb.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setGdbDownloading(false);
    }
  }

  function handleAssignWork() {
    setAssignIssueName(ASSIGN_DEFAULT_ISSUE_NAME[activeAi.detectionMode] ?? "Fix Work");
    setAssignDate(localDateValue());
    setAssignDeadline("");
    setAssignRemarks("");
    setShowAssignWork(true);
  }

  function submitAssignWork() {
    // TODO: notify the backend once an Assign Work endpoint is available.
    const road = attributeValue(activeFeature, "Road_Name", "road_name");
    const record = addAssignedWork({
      featureId: activeFeature.properties.id,
      anomalyId: activeAi.anomalyId,
      detectionMode: activeAi.detectionMode,
      issueName: assignIssueName.trim(),
      date: assignDate,
      deadline: assignDeadline.trim(),
      latitude: activeAi.latitude,
      longitude: activeAi.longitude,
      remarks: assignRemarks.trim(),
      assignedByName: user?.name ?? null,
      featureLabel: activeFeature.properties.label ?? activeFeature.properties.category ?? null,
      road: road !== "—" ? road : null,
    });
    setAssignedRecord(record);
    setShowAssignWork(false);
    setAssignNotice("Work Assigned Successfully");
  }

  return (
    <>
      {createPortal(
        <div className="point-verification-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) onClose();
        }}>
      <section className="point-verification-dialog point-verification-dialog--wide" role="dialog" aria-modal="true" aria-label="AI remediation workflow">
        <header className="point-verification-dialog__header">
          <div>
            <span className={`point-verification-status point-verification-status--${currentStatus}`}>
              {statusLabel}
            </span>
            <h2>AI Issue Remediation</h2>
            <p>{feature.properties.label ?? feature.properties.category ?? "Detected survey feature"}</p>
          </div>
          <button type="button" className="point-verification-dialog__close" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </header>

        <div className="point-verification-dialog__body">
          <div className="point-verification-details">
            {details.map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </div>

          {loading && <p className="point-verification-message">Loading remediation history…</p>}
          {error && <p className="point-verification-error" role="alert">{error}</p>}

          {record?.architect_submitted_at && (
            <section className="point-verification-submission">
              <div className="point-verification-section-title">
                <div><strong>Architect evidence</strong><span>Submitted {displayDate(record.architect_submitted_at)}</span></div>
                <span className={`point-verification-location point-verification-location--${record.evidence_location_status ?? "unknown"}`}>
                  {record.evidence_location_status?.replaceAll("_", " ") ?? "Location unavailable"}
                </span>
              </div>
              <div className="point-verification-details point-verification-details--compact">
                <div><span>Architect</span><strong>{record.architect_name ?? "—"}</strong></div>
                <div><span>Work completed</span><strong>{displayDate(record.work_completed_at)}</strong></div>
                <div><span>Photo latitude</span><strong>{record.evidence_latitude ?? "—"}</strong></div>
                <div><span>Photo longitude</span><strong>{record.evidence_longitude ?? "—"}</strong></div>
                <div><span>Distance from AI point</span><strong>{formatDistance(record.evidence_distance_m)}</strong></div>
                <div><span>Allowed buffer</span><strong>{formatDistance(record.evidence_buffer_m)}</strong></div>
              </div>
              <div className="point-verification-text-block"><span>Issue observed</span><p>{record.issue_summary ?? "—"}</p></div>
              <div className="point-verification-text-block"><span>Work completed</span><p>{record.work_completed ?? "—"}</p></div>
              <div className="point-verification-evidence-grid">
                <EvidenceImage title="Before work" url={record.before_photo_url} filename={record.before_photo_filename} />
                <EvidenceImage title="After work" url={record.after_photo_url} filename={record.after_photo_filename} />
              </div>
              {(record.before_photo_exif_latitude !== null || record.after_photo_exif_latitude !== null) && (
                <div className="point-verification-details point-verification-details--compact">
                  <div><span>Before photo GPS</span><strong>{record.before_photo_exif_latitude === null ? "No EXIF GPS" : `${record.before_photo_exif_latitude}, ${record.before_photo_exif_longitude}`}</strong></div>
                  <div><span>Before captured</span><strong>{displayDate(record.before_photo_exif_captured_at)}</strong></div>
                  <div><span>After photo GPS</span><strong>{record.after_photo_exif_latitude === null ? "No EXIF GPS" : `${record.after_photo_exif_latitude}, ${record.after_photo_exif_longitude}`}</strong></div>
                  <div><span>After captured</span><strong>{displayDate(record.after_photo_exif_captured_at)}</strong></div>
                </div>
              )}
              {(record.before_photo_exif_latitude !== null || record.after_photo_exif_latitude !== null) && (
                <p className="point-verification-evidence-note">
                  The backend extracted the photo EXIF GPS and checked it against the selected AI point. No user-entered coordinates are accepted.
                </p>
              )}
            </section>
          )}

          {record?.status === "resolved" && (
            <div className="point-verification-resolved">
              <strong>Admin approved the Architect evidence. This finding is blue only in AI Detection view.</strong>
              <span>Original GDB condition: {record.original_condition ?? record.survey_condition ?? "—"}</span>
              <span>Current verified condition: {record.current_condition ?? "Good"}</span>
              <span>Reviewed: {displayDate(record.inspected_at)}</span>
              <span>Approved by: {record.verified_by_name ?? "Admin"}</span>
              <p>{record.remarks}</p>
            </div>
          )}

          {record?.status === "rejected" && (
            <div className="point-verification-rejected">
              <strong>Admin returned this work for correction.</strong>
              <span>Reviewed: {displayDate(record.rejected_at)}</span>
              <span>Reviewed by: {record.verified_by_name ?? "Admin"}</span>
              <span>Admin assessed condition: {record.verified_condition?.toUpperCase() ?? "—"}</span>
              <p>{record.remarks}</p>
            </div>
          )}

          {canArchitectSubmit && (
            <form className="point-verification-form" onSubmit={submitArchitect}>
              <div className="point-verification-section-title">
                <div><strong>{currentStatus === "rejected" ? "Correct and resubmit work" : "Submit completed field work"}</strong><span>The point remains red/yellow until Admin approval.</span></div>
              </div>
              <label>What was the issue?<textarea value={issueSummary} onChange={(e) => setIssueSummary(e.target.value)} maxLength={2048} rows={3} required placeholder="Describe the actual problem found at this AI-detected point." /></label>
              <label>What work was completed?<textarea value={workCompleted} onChange={(e) => setWorkCompleted(e.target.value)} maxLength={10000} rows={4} required placeholder="Describe the repair, material, method, and final condition." /></label>
              <div className="point-verification-form-grid">
                <label>Work started date and time (optional)<input type="datetime-local" value={workStartedAt} onChange={(e) => setWorkStartedAt(e.target.value)} /></label>
                <label>Work completed date and time<input type="datetime-local" value={workCompletedAt} min={workStartedAt || undefined} max={localDateTimeValue()} onChange={(e) => setWorkCompletedAt(e.target.value)} required /></label>
              </div>

              <fieldset>
                <legend>Geotag verification</legend>
                <p className="point-verification-help">No latitude or longitude entry is required. Upload the original geotagged after-work photo. The backend extracts its EXIF GPS, compares it with the selected AI point, and blocks the submission when it falls outside the allowed buffer.</p>
                <div className="point-verification-details point-verification-details--compact">
                  <div><span>AI point latitude</span><strong>{activeAi.latitude.toFixed(7)}</strong></div>
                  <div><span>AI point longitude</span><strong>{activeAi.longitude.toFixed(7)}</strong></div>
                </div>
              </fieldset>

              <div className="point-verification-upload-grid">
                <label className="point-verification-upload">
                  <span>Before-work photo</span>
                  <input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(e) => setBeforePhoto(e.target.files?.[0] ?? null)} required />
                  {beforePreview && <img src={beforePreview} alt="Selected before-work preview" />}
                  {beforePhoto && <small>{beforePhoto.name} · {(beforePhoto.size / 1024 / 1024).toFixed(2)} MB</small>}
                </label>
                <label className="point-verification-upload">
                  <span>After-work photo</span>
                  <input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(e) => setAfterPhoto(e.target.files?.[0] ?? null)} required />
                  {afterPreview && <img src={afterPreview} alt="Selected after-work preview" />}
                  {afterPhoto && <small>{afterPhoto.name} · {(afterPhoto.size / 1024 / 1024).toFixed(2)} MB</small>}
                </label>
              </div>
              <p className="point-verification-evidence-note">JPG, JPEG, PNG, or WebP; maximum 12 MB each. The after-work photo must contain EXIF GPS. Upload the original camera image because screenshots, edited copies, and messaging-app compressed files may lose geotags.</p>
              <button type="submit" className="point-verification-submit" disabled={saving || !issueSummary.trim() || !workCompleted.trim() || !beforePhoto || !afterPhoto}>
                {saving ? "Uploading and validating…" : "Submit to Admin verification"}
              </button>
            </form>
          )}

          {isArchitect && currentStatus === "pending_admin" && (
            <div className="point-verification-readonly"><strong>Submitted successfully.</strong><span>Admin has been notified. The point remains {activeAi.aiColor} until approval.</span></div>
          )}

          {isAdmin && currentStatus === "open" && (
            <div className="point-verification-readonly"><strong>Awaiting Architect evidence.</strong><span>Admin approval is unavailable until the Architect uploads the required work details and photos.</span></div>
          )}

          {canAdminDecide && (
            <section className="point-verification-admin-review">
              <div className="point-verification-section-title"><div><strong>Admin decision</strong><span>Review the uploaded evidence and validated location before deciding.</span></div></div>
              <label>Verified condition after Admin inspection
                <select
                  value={verifiedCondition}
                  onChange={(event) => {
                    const next = event.target.value as VerifiedCondition;
                    setVerifiedCondition(next);
                    setDecision(next === "good" ? "approve" : "reject");
                  }}
                >
                  <option value="good">Good — approve, show blue in AI view</option>
                  <option value="moderate">Moderate — reject, keep yellow/red</option>
                  <option value="bad">Bad — reject, keep red/yellow</option>
                </select>
              </label>
              <div className={`point-verification-decision-preview point-verification-decision-preview--${decision}`}>
                {decision === "approve"
                  ? "Decision: Approve. Original condition is preserved and Current Condition becomes Good."
                  : "Decision: Deny approval. Architect receives the reason and must correct/resubmit."}
              </div>
              <label>{decision === "approve" ? "Admin approval remarks" : "Mandatory rejection reason"}<textarea value={adminRemarks} onChange={(e) => setAdminRemarks(e.target.value)} maxLength={4096} rows={4} required placeholder={decision === "approve" ? "Record what was checked before approval." : "Explain exactly why approval was denied and what the Architect must correct."} /></label>
              <button type="button" className={decision === "approve" ? "point-verification-approve" : "point-verification-open"} onClick={submitDecision} disabled={saving || !adminRemarks.trim()}>
                {saving ? "Saving decision…" : decision === "approve" ? "Approve Good and mark blue in AI view" : "Deny approval and notify Architect"}
              </button>
            </section>
          )}
        </div>

        <footer className="point-verification-dialog__footer">
          <div className="point-verification-dialog__downloads">
            <button type="button" onClick={downloadExcel} disabled={downloading}>{downloading ? "Preparing Excel…" : "Download remediation Excel"}</button>
            <button type="button" onClick={downloadUpdatedGdb} disabled={gdbDownloading}>{gdbDownloading ? "Generating updated GDB…" : "Download Updated Resolved GDB"}</button>
          </div>
          {isAeeRedAssignableIssue ? (
            assignedRecord ? (
              <span className="point-verification-assigned-label">Work Assigned!</span>
            ) : (
              <button type="button" className="point-verification-assign-work" onClick={handleAssignWork}>Assign Work</button>
            )
          ) : (
            <span>The original uploaded GDB remains unchanged. The generated GDB copy updates approved rows to Good and preserves the original condition in a separate field.</span>
          )}
        </footer>
      </section>
        </div>,
        document.body,
      )}
      {showAssignWork && isAeeRedAssignableIssue && createPortal(
        <div
          className="assign-work-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowAssignWork(false);
          }}
        >
          <section className="assign-work-dialog" role="dialog" aria-modal="true" aria-label="Assign work to field team">
            <header className="assign-work-dialog__header">
              <h3>Assign Work</h3>
              <button type="button" className="assign-work-dialog__close" onClick={() => setShowAssignWork(false)} aria-label="Close">×</button>
            </header>
            <div className="assign-work-dialog__body">
              <label className="assign-work-field assign-work-field--full">
                <span>Issue Name</span>
                <input
                  type="text"
                  value={assignIssueName}
                  onChange={(event) => setAssignIssueName(event.target.value)}
                  maxLength={120}
                  placeholder="Describe the issue for the field team"
                />
              </label>
              <div className="assign-work-row">
                <label className="assign-work-field">
                  <span>Date</span>
                  <input type="date" value={assignDate} onChange={(event) => setAssignDate(event.target.value)} />
                </label>
                <label className="assign-work-field">
                  <span>Deadline</span>
                  <input
                    type="text"
                    value={assignDeadline}
                    onChange={(event) => setAssignDeadline(event.target.value)}
                    placeholder="dd/mm/yyyy"
                    inputMode="numeric"
                  />
                </label>
              </div>
              <label className="assign-work-field assign-work-field--full">
                <span>Remarks</span>
                <textarea
                  value={assignRemarks}
                  onChange={(event) => setAssignRemarks(event.target.value)}
                  rows={4}
                  placeholder="Add a message for the field worker (optional)"
                />
              </label>
            </div>
            <footer className="assign-work-dialog__footer">
              <button type="button" className="assign-work-cancel" onClick={() => setShowAssignWork(false)}>Cancel</button>
              <button type="button" className="assign-work-confirm" onClick={submitAssignWork} disabled={!assignIssueName.trim()}>Assign</button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
      {assignNotice && createPortal(
        <div className="assign-work-success-toast" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          {assignNotice}
        </div>,
        document.body,
      )}
    </>
  );
}
