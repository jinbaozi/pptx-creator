import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fail } from "./errors.mjs";

const schemaDirectory = new URL("../../schemas/", import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function loadSchema(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, schemaDirectory)), "utf8"));
}

const reports = Object.freeze({
  designIntent: {
    code: "E_DESIGN_INTENT_SCHEMA",
    validate: ajv.compile(loadSchema("design-intent.schema.json"))
  },
  reviewReport: {
    code: "E_REVIEW_REPORT_SCHEMA",
    validate: ajv.compile(loadSchema("review-report.schema.json"))
  },
  provenance: {
    code: "E_PROVENANCE_SCHEMA",
    validate: ajv.compile(loadSchema("provenance.schema.json"))
  },
  visualScorecard: {
    code: "E_VISUAL_SCORECARD_SCHEMA",
    validate: ajv.compile(loadSchema("visual-scorecard.schema.json"))
  }
});

function pathSegment(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? `.${value}` : `[${JSON.stringify(value)}]`;
}

function schemaErrorPath(issue) {
  let path = "$";
  for (const rawSegment of (issue?.instancePath ?? "").split("/").slice(1)) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    path += /^\d+$/.test(segment) ? `[${segment}]` : pathSegment(segment);
  }
  const property = issue?.params?.missingProperty ?? issue?.params?.additionalProperty;
  return property === undefined ? path : `${path}${pathSegment(property)}`;
}

function validateArtifact(kind, value) {
  const report = reports[kind];
  if (!report) {
    fail("E_REPORT_KIND", `Unsupported report artifact ${kind ?? "missing"}`, { path: "$.kind" });
  }
  if (report.validate(value)) return value;

  const issue = report.validate.errors?.[0];
  const path = schemaErrorPath(issue);
  fail(report.code, `${path} ${issue?.message ?? "does not match the report schema"}`, {
    path,
    details: {
      keyword: issue?.keyword,
      schemaPath: issue?.schemaPath
    }
  });
}

/**
 * Validates the standalone design-intent lock before it is used by a renderer.
 */
export function validateDesignIntent(value) {
  return validateArtifact("designIntent", value);
}

/**
 * Validates a host review report with its independent content/design/rights approvals.
 */
export function validateReviewReport(value) {
  return validateArtifact("reviewReport", value);
}

/**
 * Validates the persisted provenance record that binds a review to its artifacts.
 */
export function validateProvenanceRecord(value) {
  return validateArtifact("provenance", value);
}

/**
 * Validates the versioned visual scorecard before it is accepted as QA evidence.
 */
export function validateVisualScorecard(value) {
  return validateArtifact("visualScorecard", value);
}

/**
 * Validates one known report artifact by its explicit kind.
 */
export function validateReportArtifact(kind, value) {
  return validateArtifact(kind, value);
}
