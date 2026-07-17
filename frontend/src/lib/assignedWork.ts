/**
 * Client-side store for AEE "Assign Work" records.
 *
 * There is no backend endpoint for this yet, so records live in
 * localStorage. Serials are recomputed on every write so the earliest
 * work (by date) is always #001, matching the AEE Activity view.
 */

const STORAGE_KEY = "davangere.assignedWork";
const CHANGE_EVENT = "davangere:assigned-work-changed";

export interface AssignedWorkRecord {
  id: string;
  serial: string;
  featureId: string;
  anomalyId: string;
  detectionMode: string;
  issueName: string;
  date: string;
  deadline: string;
  latitude: number;
  longitude: number;
  remarks: string;
  assignedAt: string;
  assignedByName: string | null;
  featureLabel: string | null;
  road: string | null;
}

export type NewAssignedWorkInput = Omit<AssignedWorkRecord, "id" | "serial" | "assignedAt">;

function readAll(): AssignedWorkRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AssignedWorkRecord[]) : [];
  } catch {
    return [];
  }
}

function resequence(records: AssignedWorkRecord[]): AssignedWorkRecord[] {
  return [...records]
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.assignedAt < b.assignedAt ? -1 : 1;
    })
    .map((record, index) => ({ ...record, serial: `#${String(index + 1).padStart(3, "0")}` }));
}

function writeAll(records: AssignedWorkRecord[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function listAssignedWork(): AssignedWorkRecord[] {
  return readAll();
}

export function findAssignedWork(featureId: string, anomalyId: string): AssignedWorkRecord | null {
  return readAll().find((record) => record.featureId === featureId && record.anomalyId === anomalyId) ?? null;
}

export function addAssignedWork(input: NewAssignedWorkInput): AssignedWorkRecord {
  const id = `${input.featureId}:${input.anomalyId}:${Date.now()}`;
  const draft: AssignedWorkRecord = { ...input, id, serial: "", assignedAt: new Date().toISOString() };
  const resequenced = resequence([...readAll(), draft]);
  writeAll(resequenced);
  return resequenced.find((record) => record.id === id) ?? draft;
}

export function subscribeAssignedWork(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
