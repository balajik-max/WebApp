import { useEffect, useRef, useState } from "react";

interface Props {
  latitude: number;
  longitude: number;
  onClose: () => void;
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? "";
let googleMapsPromise: Promise<any> | null = null;

function loadGoogleMaps(): Promise<any> {
  const current = (window as any).google?.maps;
  if (current) return Promise.resolve(current);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = `__nakshaGoogleMapsReady_${Date.now()}`;
    const timeout = window.setTimeout(() => reject(new Error("Google Maps took too long to load.")), 15000);
    (window as any)[callbackName] = () => {
      window.clearTimeout(timeout);
      delete (window as any)[callbackName];
      resolve((window as any).google.maps);
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timeout);
      delete (window as any)[callbackName];
      googleMapsPromise = null;
      reject(new Error("Google Maps could not be loaded. Check the API key and its domain restrictions."));
    };
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

export function GoogleStreetView({ latitude, longitude, onClose }: Props) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const panoramaRef = useRef<any>(null);
  const [status, setStatus] = useState("Checking Street View coverage…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) {
      setError("Street View is not configured. Add VITE_GOOGLE_MAPS_API_KEY and rebuild the frontend.");
      return;
    }
    let cancelled = false;
    void loadGoogleMaps()
      .then(async (maps) => {
        const service = new maps.StreetViewService();
        const response = await service.getPanorama({
          location: { lat: latitude, lng: longitude },
          radius: 250,
          preference: maps.StreetViewPreference.NEAREST,
          source: maps.StreetViewSource.GOOGLE,
        });
        if (cancelled || !viewerRef.current) return;
        const panoramaPosition = response.data?.location?.latLng;
        const pano = response.data?.location?.pano;
        if (!pano) throw new Error("No Google Street View panorama is available near this location.");
        panoramaRef.current = new maps.StreetViewPanorama(viewerRef.current, {
          pano,
          position: panoramaPosition,
          pov: { heading: 0, pitch: 0 },
          zoom: 1,
          addressControl: true,
          fullscreenControl: true,
          motionTracking: false,
          motionTrackingControl: true,
          panControl: true,
          zoomControl: true,
          linksControl: true,
          clickToGo: true,
          showRoadLabels: true,
        });
        setStatus("");
      })
      .catch((reason: Error) => {
        if (!cancelled) {
          const noCoverage = (reason as any)?.code === "ZERO_RESULTS" || reason.message.includes("ZERO_RESULTS");
          setError(noCoverage
            ? "No official Google Street View coverage was found within 250 metres of this point."
            : reason.message || "Street View could not be opened.");
        }
      });
    return () => {
      cancelled = true;
      panoramaRef.current = null;
    };
  }, [latitude, longitude]);

  return (
    <div className="google-street-view" data-testid="google-street-view">
      <div ref={viewerRef} className="google-street-view__canvas" />
      {(status || error) && (
        <div className={`google-street-view__status${error ? " google-street-view__status--error" : ""}`}>
          <b>{error ? "Street View unavailable" : status}</b>
          {error && <span>{error}</span>}
        </div>
      )}
      <div className="google-street-view__location">
        Street View · {latitude.toFixed(6)}, {longitude.toFixed(6)}
      </div>
      <button type="button" className="google-street-view__close" onClick={onClose} data-testid="google-street-view-close">
        Close ×
      </button>
    </div>
  );
}
