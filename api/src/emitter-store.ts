import { ActivityError } from "./engine";
import { createEmitterState, validateEmitterState, type EmitterActivityState } from "./emitter-engine";
import { isWriteConflict, type StateBlob } from "./store";

export async function updateEmitterState<T>(
  blob: StateBlob,
  change: (state: EmitterActivityState) => T,
): Promise<{ state: EmitterActivityState; result: T }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const source = await blob.read();
    let state: EmitterActivityState;
    if (source === null) state = createEmitterState();
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(source.text); }
      catch { throw new ActivityError(503, "Stored emitter activity state is unreadable. No data was changed."); }
      state = validateEmitterState(parsed);
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
  throw new ActivityError(503, "Emitter activity is busy. Reload and try again.");
}
