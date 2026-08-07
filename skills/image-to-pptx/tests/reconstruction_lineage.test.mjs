import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReconstructionPlanLineage,
  validateReconstructionPlanRef
} from "../scripts/validate_output.mjs";
import { validatePublishedReference } from "../scripts/image-to-pptx.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("reconstruction plan lineage is file-bound and four-way references must agree", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-lineage-"));
  try {
    const payload = "{\"version\":\"1.0.0\"}\n";
    const path = "reports/reconstruction-plan.json";
    await mkdir(join(root, "reports"), { recursive: true });
    await writeFile(join(root, path), payload);
    const reference = { path, sha256: digest(payload) };

    await assert.doesNotReject(validateReconstructionPlanRef(root, reference));
    await assert.doesNotReject(validatePublishedReference(root, reference, "reconstruction plan"));
    assert.doesNotThrow(() => assertReconstructionPlanLineage(reference, { ...reference }, { ...reference }, { ...reference }));
    assert.throws(
      () => assertReconstructionPlanLineage(reference, { ...reference, sha256: "f".repeat(64) }),
      (error) => error.code === "E_RECONSTRUCTION_PLAN"
    );

    await writeFile(join(root, path), "tampered\n");
    await assert.rejects(
      validatePublishedReference(root, reference, "reconstruction plan"),
      (error) => error.code === "E_CONTRACT"
    );
    await assert.rejects(
      validateReconstructionPlanRef(root, reference),
      (error) => error.code === "E_RECONSTRUCTION_PLAN"
    );
    await assert.rejects(
      validateReconstructionPlanRef(root, { ...reference, path: "reports/missing.json" }),
      (error) => error.code === "E_CONTRACT" || error.code === "E_RECONSTRUCTION_PLAN"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
