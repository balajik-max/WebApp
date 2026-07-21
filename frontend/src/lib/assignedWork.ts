/** Client-side store for legacy AEE Assign Work records. */
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

function writeAll(records: AssignedWorkRecord[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage can be unavailable in strict privacy modes; the server workflow remains unaffected.
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
