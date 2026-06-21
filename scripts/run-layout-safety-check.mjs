/**
 * run-layout-safety-check.mjs
 *
 * CLI entry for the layout-safety preflight. Mirrors
 * `scripts/run-visual-critic.mjs` in shape: positional manifest path,
 * `--output <path>` for the JSON report, plus two policy flags:
 *
 *   --strict-layout-safety    Hard-block: non-zero exit if any critical
 *                             issue is detected.
 *   --allow-layout-violation  Soft-block override (explicit acknowledgement
 *                             that critical issues are present). The
 *                             pipeline passes this through when it wants
 *                             to write a `pipeline-blocked.json` summary
 *                             but still emit the report.
 *
 * Exit codes:
 *   0  Clean, or critical with --allow-layout-violation, or warning only.
 *   2  Critical violations + --strict-layout-safety (hard-block).
 *
 * Output JSON shape: conforms to `schemas/layout-safety-report.schema.json`
 * (U5). The CLI pipes the internal `preflightLayout()` output through
 * `formatReport()` so the on-disk file is schema-valid and byte-identical
 * across runs.
 */
import fs from "node:fs";
import path from "node:path";
import { preflightLayout, formatReport } from "./lib/check-layout-safety.mjs";
import { validateJsonSchema } from "./lib/schema-utils.mjs";

const SCHEMA_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "schemas",
  "layout-safety-report.schema.json"
);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

function parseArgs(argv) {
  const out = {
    manifestPath: null,
    outputPath: null,
    strict: false,
    allowViolation: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") {
      out.outputPath = argv[++i];
    } else if (arg === "--strict-layout-safety") {
      out.strict = true;
    } else if (arg === "--allow-layout-violation") {
      out.allowViolation = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      positional.push(arg);
    }
  }
  out.manifestPath = positional[0] ?? null;
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/run-layout-safety-check.mjs <manifest.json>",
      "                                 [--output <report.json>]",
      "                                 [--strict-layout-safety]",
      "                                 [--allow-layout-violation]",
      "",
      "Exit codes: 0 = clean / warning-only / allowed; 2 = critical + strict.",
      ""
    ].join("\n")
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.manifestPath) {
  printHelp();
  process.exit(64); // EX_USAGE
}

const manifest = JSON.parse(fs.readFileSync(args.manifestPath, "utf8"));
const internal = preflightLayout(manifest, { strict: args.strict });
const report = formatReport(internal);

const outputPath = args.outputPath ?? path.join("output", "layout-safety-report.json");
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const validation = validateJsonSchema(report, SCHEMA);

process.stdout.write(`Wrote ${outputPath}\n`);
process.stdout.write(
  `Layout safety: critical=${report.summary.criticalCount} warning=${report.summary.warningCount} slides=${report.summary.slideCount ?? 0}\n`
);
if (validation.valid) {
  process.stdout.write(`Schema: valid (schemas/layout-safety-report.schema.json)\n`);
} else {
  process.stderr.write(
    `Schema: INVALID — ${validation.errors.map((e) => `${e.path} ${e.message}`).join("; ")}\n`
  );
}

const critical = report.summary.criticalCount;
if (critical > 0 && args.strict) {
  process.stderr.write(`Layout safety hard-blocked: ${critical} critical violation(s).\n`);
  process.exit(2);
}
process.exit(0);
