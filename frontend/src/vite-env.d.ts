/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_CADASTRAL_TILE_URL?: string;
  readonly VITE_CADASTRAL_ATTRIBUTION?: string;
  readonly VITE_CADASTRAL_OPACITY?: string;
  readonly VITE_CADASTRAL_MAX_ZOOM?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
