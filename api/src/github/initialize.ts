import { createState, ingest, parseIngest, validateStoredState } from "../engine";
import { createEmitterState, ingestEmitter, parseEmitterIngest, validateEmitterState } from "../emitter-engine";

export function initialState(
  source: "sdk" | "emitter", mode: "empty" | "import" | "snapshot",
  value?: unknown, now = new Date().toISOString(),
) {
  if (mode === "empty") return source === "sdk" ? createState() : createEmitterState();
  if (mode === "import") return source === "sdk" ? validateStoredState(value) : validateEmitterState(value);
  if (source === "sdk") {
    const state = createState();
    ingest(state, parseIngest({ snapshot: value, inactivePullRequests: [] }), now);
    return state;
  }
  const state = createEmitterState();
  const parsed = parseEmitterIngest({ snapshot: value });
  // A single emitter snapshot cannot reconstruct its preceding comparison baseline.
  parsed.snapshot.activity = {
    comparisonFrom: null, events: [], excludedIssueNumbers: parsed.snapshot.activity!.excludedIssueNumbers,
  };
  ingestEmitter(state, parsed, now);
  return state;
}
