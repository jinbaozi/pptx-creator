import { describe, expect, it, vi } from "vitest";
import { runBoundedRepair } from "../scripts/lib/bounded-repair.mjs";

const proof = (ssim, accepted = false) => ({ accepted, aggregate: { fidelity: { ssim: { status: "available", value: ssim } } } });

describe("bounded repair convergence", () => {
  it("hard caps attempts at three and returns the best improving proof", async () => {
    const attempt = vi.fn(async ({ iteration }) => ({ proof: proof([0.8, 0.85, 0.9][iteration - 1]), artifact: `v${iteration}` }));
    const result = await runBoundedRepair({ initialProof: proof(0.7), maxAttempts: 99, attempt });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ accepted: false, attempts: 3, artifact: "v3", stopReason: "attempt-limit" });
  });

  it("stops immediately on no improvement and preserves the prior best", async () => {
    const attempt = vi.fn(async () => ({ proof: proof(0.79), artifact: "worse" }));
    const result = await runBoundedRepair({ initialProof: proof(0.8), initialArtifact: "original", attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ artifact: "original", attempts: 1, stopReason: "no-improvement" });
  });

  it("stops as soon as an accepted proof is measured", async () => {
    const attempt = vi.fn(async ({ iteration }) => ({ proof: proof(iteration === 2 ? 0.96 : 0.9, iteration === 2), artifact: `v${iteration}` }));
    const result = await runBoundedRepair({ initialProof: proof(0.8), attempt });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ accepted: true, attempts: 2, artifact: "v2", stopReason: "accepted" });
  });

  it("does not claim attempts when no deterministic repair is available", async () => {
    const result = await runBoundedRepair({ initialProof: proof(0.8) });
    expect(result).toMatchObject({ attempts: 0, stopReason: "repair-unavailable" });
  });
});
