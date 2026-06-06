import { runPython } from "./lib/python-utils.mjs";

try {
  const result = await runPython(process.argv.slice(2), { cwd: process.cwd(), stdio: "inherit" });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
} catch (error) {
  const stderr = error.stderr?.toString?.() || error.message || String(error);
  if (stderr) {
    process.stderr.write(stderr);
    if (!stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  process.exit(typeof error.code === "number" ? error.code : 1);
}
