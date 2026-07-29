import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Carries File objects staged on the Map page (dragged in from outside the
 * browser) across the React Router navigation to /datasets, without ever
 * serializing them into route state, a query string, or storage — File
 * objects aren't serializable, and don't need to be since this context lives
 * above the router and survives the route swap.
 */
interface UploadTransferContextValue {
  hasPendingFiles: boolean;
  stageFilesForUpload: (files: File[]) => void;
  consumePendingFiles: () => File[] | null;
}

const UploadTransferContext = createContext<UploadTransferContextValue | null>(null);

export function UploadTransferProvider({ children }: { children: ReactNode }) {
  const filesRef = useRef<File[] | null>(null);
  const [hasPendingFiles, setHasPendingFiles] = useState(false);

  const stageFilesForUpload = useCallback((files: File[]) => {
    filesRef.current = files;
    setHasPendingFiles(files.length > 0);
  }, []);

  // Read-once: the Datasets page calls this on mount to pick up whatever
  // was staged, and it's cleared immediately so navigating back to Map and
  // returning to Datasets later doesn't replay a stale drop.
  const consumePendingFiles = useCallback((): File[] | null => {
    const files = filesRef.current;
    filesRef.current = null;
    setHasPendingFiles(false);
    return files;
  }, []);

  const value = useMemo(
    () => ({ hasPendingFiles, stageFilesForUpload, consumePendingFiles }),
    [hasPendingFiles, stageFilesForUpload, consumePendingFiles]
  );

  return <UploadTransferContext.Provider value={value}>{children}</UploadTransferContext.Provider>;
}

export function useUploadTransfer(): UploadTransferContextValue {
  const ctx = useContext(UploadTransferContext);
  if (!ctx) throw new Error("useUploadTransfer must be used within an UploadTransferProvider");
  return ctx;
}
