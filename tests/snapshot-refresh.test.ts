import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshotLoader } from "../src/shared/useSnapshot";
import { fetchSdkPrSnapshot } from "../src/features/sdk-prs/useSdkPrData";

afterEach(() => vi.unstubAllGlobals());

describe("live snapshot refresh", () => {
  it("loads subsequent snapshots without concurrent or disposed updates", async () => {
    let complete: ((value: number) => void) | undefined;
    const load = vi.fn((_signal: AbortSignal) => new Promise<number>((resolve) => { complete = resolve; }));
    const update = vi.fn();
    const loader = createSnapshotLoader(load, update);
    const first = loader.refresh();
    await loader.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    complete!(1);
    await first;
    expect(update).toHaveBeenLastCalledWith({ snapshot: 1, loading: false, error: null });
    const second = loader.refresh();
    complete!(2);
    await second;
    expect(update).toHaveBeenLastCalledWith({ snapshot: 2, loading: false, error: null });
    const third = loader.refresh();
    loader.dispose();
    expect(load.mock.calls[2][0].aborted).toBe(true);
    complete!(3);
    await third;
    await loader.refresh();
    expect(load).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("surfaces failures and recovers on the next refresh without invented data", async () => {
    const update = vi.fn();
    const load = vi.fn<(signal: AbortSignal) => Promise<number>>()
      .mockRejectedValueOnce(new Error("Snapshot request failed (503)"))
      .mockResolvedValueOnce(2);
    const loader = createSnapshotLoader(load, update);
    await loader.refresh();
    expect(update).toHaveBeenLastCalledWith({
      snapshot: null, loading: false, error: "Snapshot request failed (503)",
    });
    await loader.refresh();
    expect(update).toHaveBeenLastCalledWith({ snapshot: 2, loading: false, error: null });
    loader.dispose();
  });

  it("rejects unavailable or invalid SDK data instead of using the bundled snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}")));
    await expect(fetchSdkPrSnapshot()).rejects.toThrow("503");
    await expect(fetchSdkPrSnapshot()).rejects.toThrow("unsupported data contract");
  });
});
