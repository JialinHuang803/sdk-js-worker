import { describe, expect, it, vi } from "vitest";
import { hasCurrentHeadApproval, normalizeReviewDecision, resolveMergeability, type SubmittedReview } from "../scripts/review-status";

const review = (id: number, state: string, overrides: Partial<SubmittedReview> = {}): SubmittedReview => ({
  id, state, user: { id: 1 }, commit_id: "head", submitted_at: `2026-09-24T00:0${id}:00Z`, ...overrides,
});

describe("recorded approvals", () => {
  it("does not interpret null or absent aggregate decisions as approval not required", () => {
    expect(normalizeReviewDecision(null)).toBe("unknown");
    expect(normalizeReviewDecision(undefined)).toBe("unknown");
    expect(normalizeReviewDecision("APPROVED")).toBe("approved");
    expect(normalizeReviewDecision("REVIEW_REQUIRED")).toBe("review-required");
    expect(normalizeReviewDecision("CHANGES_REQUESTED")).toBe("changes-requested");
  });
  it("retains a current-head approval even when the aggregate decision is absent", () => {
    expect(hasCurrentHeadApproval("head", [review(1, "APPROVED")])).toBe(true);
    expect(hasCurrentHeadApproval("new-head", [review(1, "APPROVED")])).toBe(false);
    expect(hasCurrentHeadApproval("head", [])).toBe(false);
  });
  it("uses each reviewer's latest decisive review, not later comments or pending reviews", () => {
    expect(hasCurrentHeadApproval("head", [review(2, "COMMENTED"), review(1, "APPROVED"), review(3, "PENDING")])).toBe(true);
    expect(hasCurrentHeadApproval("head", [review(2, "CHANGES_REQUESTED"), review(1, "APPROVED")])).toBe(false);
    expect(hasCurrentHeadApproval("head", [review(1, "APPROVED"), review(2, "DISMISSED")])).toBe(false);
    expect(hasCurrentHeadApproval("head", [review(1, "DISMISSED"), review(2, "APPROVED")])).toBe(true);
  });
  it("does not treat another reviewer's changes request as dismissal of an approval", () => {
    expect(hasCurrentHeadApproval("head", [review(1, "APPROVED"), review(2, "CHANGES_REQUESTED", { user: { id: 2 } })])).toBe(true);
    expect(hasCurrentHeadApproval("head", [review(1, "APPROVED", { user: null })])).toBe(false);
  });
});

describe("mergeability recomputation", () => {
  const initial: { head: { sha: string }; base: { sha: string }; mergeable: boolean | null } =
    { head: { sha: "head" }, base: { sha: "base" }, mergeable: null };
  it.each([true, false])("retries unknown until GitHub returns %s", async (mergeable) => {
    const reload = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, mergeable });
    const wait = vi.fn().mockResolvedValue(undefined);
    expect((await resolveMergeability(initial, reload, wait)).mergeable).toBe(mergeable);
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });
  it("bounds retries and never turns an unresolved result into no conflicts", async () => {
    const reload = vi.fn().mockResolvedValue(initial);
    expect((await resolveMergeability(initial, reload, vi.fn())).mergeable).toBeNull();
    expect(reload).toHaveBeenCalledTimes(3);
    await resolveMergeability({ ...initial, mergeable: false }, reload, vi.fn());
    expect(reload).toHaveBeenCalledTimes(3);
  });
  it.each(["head", "base"])("rejects a moving %s revision rather than mixing signals", async (key) => {
    await expect(resolveMergeability(initial, async () => ({
      ...initial, [key]: { sha: "changed" }, mergeable: true,
    }), vi.fn())).rejects.toThrow("revision changed");
  });
  it("propagates failed lookups instead of reporting healthy mergeability", async () => {
    await expect(resolveMergeability(initial, async () => { throw new Error("Unavailable"); }, vi.fn()))
      .rejects.toThrow("Unavailable");
  });
});
