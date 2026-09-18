import { ActivityError, createState, validateStoredState, type ActivityState } from "./engine";

export interface StateBlob {
  read(): Promise<{ text: string; etag: string } | null>;
  write(text: string, etag: string | null): Promise<void>;
}

export function isWriteConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error &&
    (error.statusCode === 412 || (error.statusCode === 409 &&
      "code" in error && error.code === "BlobAlreadyExists"));
}

export async function updateState<T>(
  blob: StateBlob,
  change: (state: ActivityState) => T,
): Promise<{ state: ActivityState; result: T }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const source = await blob.read();
    let state: ActivityState;
    if (source === null) state = createState();
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(source.text); }
      catch { throw new ActivityError(503, "Stored activity state is unreadable. No data was changed."); }
      state = validateStoredState(parsed);
    }
    const result = change(state);
    const text = JSON.stringify(state);
    if (source?.text === text) return { state, result };
    try {
      await blob.write(text, source?.etag ?? null);
      return { state, result };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw new ActivityError(503, "Activity is busy. Reload and try again.");
}
