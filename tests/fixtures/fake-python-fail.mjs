#!/usr/bin/env node
// tests/fixtures/fake-python-fail.mjs
//
// Fake Python interpreter that always exits with a non-zero code and writes
// a recognizable error message to stderr. Used by tests that assert the
// wrapper propagates Python failures with a clear surfaced message.
if (process.argv[2] === "--version") {
  console.log("Python 3.12.0");
  process.exit(0);
} else {
  console.error("simulated python failure");
  process.exit(7);
}
