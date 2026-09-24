import type { ReviewDecision } from "../src/data/contracts.ts";

export interface SubmittedReview {
  id: number;
  user: { id: number } | null;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

export function normalizeReviewDecision(value: unknown): ReviewDecision {
  switch (value) {
    case "APPROVED": return "approved";
    case "REVIEW_REQUIRED": return "review-required";
    case "CHANGES_REQUESTED": return "changes-requested";
    default: return "unknown";
  }
}

export function hasCurrentHeadApproval(headSha: string, reviews: SubmittedReview[]): boolean {
  const latest = new Map<number, SubmittedReview>();
  for (const review of reviews) {
    if (!review.user || !review.submitted_at ||
        !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    const prior = latest.get(review.user.id);
    if (!prior || Date.parse(review.submitted_at) > Date.parse(prior.submitted_at!) ||
        (review.submitted_at === prior.submitted_at && review.id > prior.id)) {
      latest.set(review.user.id, review);
    }
  }
  return [...latest.values()].some((review) =>
    review.state === "APPROVED" && review.commit_id === headSha);
}

export async function resolveMergeability<T extends {
  head: { sha: string }; base: { sha: string }; mergeable: boolean | null;
}>(
  initial: T,
  reload: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let pull = initial;
  for (const delay of [1_000, 2_000, 4_000]) {
    if (pull.mergeable !== null) break;
    await wait(delay);
    const next = await reload();
    if (next.head.sha !== initial.head.sha || next.base.sha !== initial.base.sha) {
      throw new Error("PR revision changed while resolving mergeability; retry collection.");
    }
    pull = next;
  }
  return pull;
}
