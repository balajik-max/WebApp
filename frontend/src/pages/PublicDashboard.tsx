import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PublicPortalHeader } from "../components/public/PublicPortalHeader";
import { PublicPortalNav } from "../components/public/PublicPortalNav";
import { usePublicAuth } from "../context/PublicAuthContext";
import {
  fetchPublicComplaints,
  fetchPublicNotifications,
  inspectPublicComplaintImage,
  markPublicNotificationRead,
  PublicApiError,
  publicAssetUrl,
  submitPublicComplaint,
  type PublicComplaint,
  type PublicComplaintStatus,
  type PublicImageMetadata,
  type PublicNotification,
} from "../lib/publicPortal";

const STATUS_LABELS: Record<PublicComplaintStatus, string> = {
  submitted: "Submitted",
  received: "Received",
  viewed_by_commissioner: "Viewed by Authority",
  in_review: "In Review",
  resolved: "Resolved",
};

const STATUS_ORDER: PublicComplaintStatus[] = [
  "submitted",
  "received",
  "viewed_by_commissioner",
  "in_review",
  "resolved",
];

type LocationFix = { latitude: number; longitude: number; accuracy: number } | null;
type ComplaintLocationMode = "image_exif" | "browser_geolocation";

function publicNotificationMessage(notification: PublicNotification): string {
  if (notification.kind === "complaint_submitted") return "Complaint submitted successfully.";
  if (notification.kind === "commissioner_viewed") return "Authority viewed your problem.";
  return notification.message
    .replace(/Commissioner/gi, "Authority")
    .replace(/sent to AE, AEE, and Authority\.?/gi, "");
}

export default function PublicDashboard() {
  const { publicUser, logout } = usePublicAuth();
  const navigate = useNavigate();
  const locationState = useLocation();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const [complaints, setComplaints] = useState<PublicComplaint[]>([]);
  const [notifications, setNotifications] = useState<PublicNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [location, setLocation] = useState<LocationFix>(null);
  const [locationStatus, setLocationStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageMetadata, setImageMetadata] = useState<PublicImageMetadata | null>(null);
  const [imageMetadataStatus, setImageMetadataStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [locationMode, setLocationMode] = useState<ComplaintLocationMode>("browser_geolocation");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(
    (locationState.state as { registered?: boolean } | null)?.registered
      ? "Account created successfully. You can now report a problem."
      : null,
  );

  useEffect(() => {
    document.body.classList.add("citizen-scroll");
    document.title = "Public Dashboard · Davanagere Smart Urban Survey";
    return () => document.body.classList.remove("citizen-scroll");
  }, []);

  useEffect(() => {
    if (!image) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const selectImage = async (selected: File | null) => {
    setImage(selected);
    setImageMetadata(null);
    setImageMetadataStatus(selected ? "loading" : "idle");
    setError(null);
    if (!selected) return;

    try {
      const metadata = await inspectPublicComplaintImage(selected);
      setImageMetadata(metadata);
      setImageMetadataStatus("ready");
      if (metadata.has_geotag) {
        setLocationMode("image_exif");
      } else {
        setLocationMode("browser_geolocation");
      }
    } catch (reason) {
      setImageMetadataStatus("error");
      setLocationMode("browser_geolocation");
      setError(reason instanceof PublicApiError ? reason.message : "Unable to read the selected image.");
    }
  };

  const refresh = async () => {
    try {
      const [complaintRows, notificationRows] = await Promise.all([
        fetchPublicComplaints(),
        fetchPublicNotifications(),
      ]);
      setComplaints(complaintRows);
      setNotifications(notificationRows);
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to load public dashboard data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read_at).length,
    [notifications],
  );

  const captureLocation = () => {
    setError(null);
    if (!window.isSecureContext) {
      setLocationStatus("error");
      setError("Complaint location requires HTTPS. For local testing, open the portal using localhost.");
      return;
    }
    if (!navigator.geolocation) {
      setLocationStatus("error");
      setError("This browser does not support geolocation.");
      return;
    }

    setLocationStatus("loading");
    const savePosition = (position: GeolocationPosition) => {
      setLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      setLocationStatus("success");
      setError(null);
    };
    const showLocationError = (locationError: GeolocationPositionError) => {
      setLocationStatus("error");
      if (locationError.code === locationError.PERMISSION_DENIED) {
        setError("Allow location permission in the browser to submit a geo-tagged problem.");
      } else if (locationError.code === locationError.TIMEOUT) {
        setError("Location detection timed out. Check Windows Location/Wi-Fi and use Retry Location.");
      } else {
        setError("Current location is unavailable. Check device location services and use Retry Location.");
      }
    };

    navigator.geolocation.getCurrentPosition(
      savePosition,
      (firstError) => {
        if (firstError.code === firstError.PERMISSION_DENIED) {
          showLocationError(firstError);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          savePosition,
          showLocationError,
          { enableHighAccuracy: false, timeout: 30000, maximumAge: 300000 },
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  };

  const toggleReportForm = () => {
    if (formOpen) {
      setFormOpen(false);
      return;
    }
    setFormOpen(true);
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setLocationLabel("");
    setLocation(null);
    setLocationStatus("idle");
    setImage(null);
    setImageMetadata(null);
    setImageMetadataStatus("idle");
    setLocationMode("browser_geolocation");
    if (fileRef.current) fileRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    if (!image) {
      setError("Capture or upload an image of the problem.");
      return;
    }
    if (imageMetadataStatus === "loading") {
      setError("Please wait while the image geo-tag is checked.");
      return;
    }
    if (locationMode === "image_exif" && !imageMetadata?.has_geotag) {
      setError("This image has no embedded GPS. Select current device location instead.");
      return;
    }
    if (locationMode === "browser_geolocation" && !location) {
      setError("Capture the current device location before submitting.");
      return;
    }

    const form = new FormData();
    form.append("title", title);
    form.append("description", description);
    form.append("location_source", locationMode);
    if (locationMode === "browser_geolocation" && location) {
      form.append("latitude", String(location.latitude));
      form.append("longitude", String(location.longitude));
      form.append("location_accuracy_m", String(location.accuracy));
    }
    if (locationLabel.trim()) form.append("location_label", locationLabel.trim());
    form.append("image", image);

    setSubmitting(true);
    try {
      await submitPublicComplaint(form);
      setSuccess("Complaint submitted successfully.");
      resetForm();
      setFormOpen(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to submit the complaint.");
    } finally {
      setSubmitting(false);
    }
  };

  const signOut = async () => {
    await logout();
    navigate("/public/login", { replace: true });
  };

  const openNotification = async (notification: PublicNotification) => {
    if (!notification.read_at) {
      setNotifications((current) => current.map((row) => (
        row.id === notification.id ? { ...row, read_at: new Date().toISOString() } : row
      )));
      try {
        await markPublicNotificationRead(notification.id);
      } catch {
        // Read state is best-effort; the notification remains visible.
      }
    }
    if (notification.complaint_id) {
      document.getElementById(`public-complaint-${notification.complaint_id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  };

  return (
    <div className="citizen-dashboard-page">
      <PublicPortalHeader />
      <PublicPortalNav />
      <div className="citizen-dashboard-bar">
        <div>
          <span className="citizen-eyebrow">Public User Dashboard</span>
          <h1>Welcome, {publicUser?.first_name}</h1>
        </div>
        <div className="citizen-dashboard-bar__actions">
          <button className="citizen-notification-button" type="button" onClick={() => document.getElementById("public-notifications")?.scrollIntoView({ behavior: "smooth" })}>
            Notifications {unreadCount > 0 && <span>{unreadCount}</span>}
          </button>
          <button className="citizen-secondary-button" type="button" onClick={() => void signOut()}>Sign Out</button>
        </div>
      </div>

      <main className="citizen-dashboard">
        {success && <div className="citizen-alert citizen-alert--success" role="status">{success}</div>}
        {error && <div className="citizen-alert citizen-alert--error" role="alert">{error}</div>}

        <section className="citizen-dashboard__summary">
          <article><strong>{complaints.length}</strong><span>Total complaints</span></article>
          <article><strong>{complaints.filter((row) => row.status === "viewed_by_commissioner").length}</strong><span>Viewed by Authority</span></article>
          <article><strong>{complaints.filter((row) => row.status === "resolved").length}</strong><span>Resolved</span></article>
          <button type="button" onClick={toggleReportForm}>
            <span aria-hidden="true">＋</span>
            {formOpen ? "Close Report Form" : "Report a Problem"}
          </button>
        </section>

        {formOpen && (
          <section className="citizen-report-card" aria-labelledby="report-problem-title">
            <div className="citizen-section-heading">
              <div>
                <p className="citizen-eyebrow">Geo-tagged public complaint</p>
                <h2 id="report-problem-title">Report a Problem</h2>
              </div>
              <span>Geo-tagged image or current location</span>
            </div>

            <form className="citizen-report-form" onSubmit={submit}>
              <div className="citizen-report-form__fields">
                <label>
                  <span>Problem Title</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Example: Overflowing drain near bus stop" minLength={3} maxLength={200} required />
                </label>
                <label>
                  <span>Describe the Problem</span>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Explain what happened, the exact place, and any immediate risk." minLength={10} maxLength={5000} rows={6} required />
                </label>
                <label>
                  <span>Location / Landmark</span>
                  <input value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} placeholder="Ward, road, landmark, or nearby building" maxLength={500} />
                </label>

                <fieldset className="citizen-location-source">
                  <legend>Choose the complaint location source</legend>
                  <label className={imageMetadata?.has_geotag ? "available" : ""}>
                    <input
                      type="radio"
                      name="complaint-location-source"
                      value="image_exif"
                      checked={locationMode === "image_exif"}
                      onChange={() => setLocationMode("image_exif")}
                      disabled={!imageMetadata?.has_geotag}
                    />
                    <span>
                      <strong>Use GPS embedded in the image</strong>
                      <small>Best for an already geo-tagged photo selected from the device.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="complaint-location-source"
                      value="browser_geolocation"
                      checked={locationMode === "browser_geolocation"}
                      onChange={() => setLocationMode("browser_geolocation")}
                    />
                    <span>
                      <strong>Use current device location</strong>
                      <small>Use this for a new photo or an image without embedded GPS.</small>
                    </span>
                  </label>
                </fieldset>

                {locationMode === "image_exif" ? (
                  <div className="citizen-image-geotag citizen-image-geotag--success">
                    <strong>Image geo-tag selected</strong>
                    {imageMetadata?.has_geotag && imageMetadata.latitude !== null && imageMetadata.longitude !== null ? (
                      <p>{imageMetadata.latitude.toFixed(6)}, {imageMetadata.longitude.toFixed(6)}</p>
                    ) : (
                      <p>Select an already geo-tagged image first.</p>
                    )}
                    {imageMetadata?.captured_at && <small>Image date: {new Date(imageMetadata.captured_at).toLocaleString()}</small>}
                  </div>
                ) : (
                  <div className="citizen-live-location">
                    <div>
                      <strong>Current device location</strong>
                      <small>The browser asks permission only when you press this button.</small>
                    </div>
                    <button className="citizen-secondary-button" type="button" onClick={captureLocation} disabled={locationStatus === "loading"}>
                      {locationStatus === "loading" ? "Capturing…" : location ? "Refresh Location" : "Capture Location"}
                    </button>
                    {location && (
                      <p>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)} · accuracy ±{Math.round(location.accuracy)}m</p>
                    )}
                  </div>
                )}
              </div>

              <div className="citizen-image-upload">
                <input
                  ref={fileRef}
                  id="public-problem-image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => void selectImage(event.target.files?.[0] ?? null)}
                />
                <input
                  ref={cameraRef}
                  id="public-problem-camera"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  onChange={(event) => void selectImage(event.target.files?.[0] ?? null)}
                />
                <div className="citizen-image-upload__preview">
                  {imagePreview ? (
                    <img src={imagePreview} alt="Selected problem preview" />
                  ) : (
                    <span>
                      <strong>Add complaint evidence</strong>
                      <small>Upload an existing geo-tagged image or take a new photo.</small>
                    </span>
                  )}
                </div>
                <div className="citizen-image-upload__actions">
                  <label className="citizen-secondary-button" htmlFor="public-problem-image">Upload Existing Image</label>
                  <label className="citizen-primary-button" htmlFor="public-problem-camera">Take New Photo</label>
                </div>
                {image && <p>{image.name} · {(image.size / 1024 / 1024).toFixed(2)} MB</p>}
                {imageMetadataStatus === "loading" && <p className="citizen-image-meta">Checking embedded GPS…</p>}
                {imageMetadataStatus === "ready" && imageMetadata?.has_geotag && (
                  <p className="citizen-image-meta citizen-image-meta--success">Embedded GPS found. The image location can be used automatically.</p>
                )}
                {imageMetadataStatus === "ready" && !imageMetadata?.has_geotag && (
                  <p className="citizen-image-meta citizen-image-meta--warning">No embedded GPS found. Capture the current device location.</p>
                )}
              </div>

              <div className="citizen-report-form__submit">
                <p>The server validates the image and location before notifying the relevant authorities.</p>
                <button className="citizen-primary-button" type="submit" disabled={submitting || imageMetadataStatus === "loading"}>
                  {submitting ? "Submitting…" : "Submit Complaint"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="citizen-dashboard-grid">
          <div className="citizen-complaints-panel">
            <div className="citizen-section-heading">
              <div>
                <p className="citizen-eyebrow">Your submissions</p>
                <h2>Complaint History</h2>
              </div>
            </div>

            {loading ? (
              <div className="citizen-empty">Loading complaints…</div>
            ) : complaints.length === 0 ? (
              <div className="citizen-empty">No complaints submitted yet.</div>
            ) : (
              <div className="citizen-complaint-list">
                {complaints.map((complaint) => {
                  const activeIndex = STATUS_ORDER.indexOf(complaint.status);
                  return (
                    <article id={`public-complaint-${complaint.id}`} className="citizen-complaint-card" key={complaint.id}>
                      <img src={publicAssetUrl(complaint.image_url)} alt={`Evidence for ${complaint.title}`} />
                      <div className="citizen-complaint-card__body">
                        <div className="citizen-complaint-card__top">
                          <div>
                            <h3>{complaint.title}</h3>
                            <p>{complaint.description}</p>
                          </div>
                          <span className={`citizen-status citizen-status--${complaint.status}`}>{STATUS_LABELS[complaint.status]}</span>
                        </div>
                        <dl>
                          <div><dt>Submitted</dt><dd>{new Date(complaint.created_at).toLocaleString()}</dd></div>
                          <div><dt>Coordinates</dt><dd>{complaint.latitude.toFixed(6)}, {complaint.longitude.toFixed(6)}</dd></div>
                          <div><dt>Location source</dt><dd>{complaint.location_source === "image_exif" ? "Image embedded GPS" : complaint.location_source === "browser_geolocation" ? "Current device location" : "Not recorded (legacy complaint)"}</dd></div>
                          {complaint.location_label && <div><dt>Location</dt><dd>{complaint.location_label}</dd></div>}
                        </dl>
                        <ol className="citizen-status-track" aria-label="Complaint status">
                          {STATUS_ORDER.map((status, index) => (
                            <li className={index <= activeIndex ? "complete" : ""} key={status}>
                              <span />
                              <small>{STATUS_LABELS[status]}</small>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <aside id="public-notifications" className="citizen-notifications-panel">
            <div className="citizen-section-heading">
              <div>
                <p className="citizen-eyebrow">Live updates</p>
                <h2>Notifications</h2>
              </div>
              {unreadCount > 0 && <span>{unreadCount} new</span>}
            </div>
            {notifications.length === 0 ? (
              <div className="citizen-empty">No notifications yet.</div>
            ) : (
              <ul>
                {notifications.map((notification) => (
                  <li className={notification.read_at ? "" : "unread"} key={notification.id}>
                    <button type="button" onClick={() => void openNotification(notification)}>
                      <span className="citizen-notification-dot" aria-hidden="true" />
                      <span>
                        <strong>{notification.kind === "commissioner_viewed" ? "Authority Update" : "Complaint Update"}</strong>
                        <small>{publicNotificationMessage(notification)}</small>
                        <time>{new Date(notification.created_at).toLocaleString()}</time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </section>
      </main>
    </div>
  );
}
