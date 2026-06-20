#!/usr/bin/env node
// tests/fixtures/fake-python-fail.mjs
//
// Fake Python interpreter that always exits with a non-zero code and writes
// a recognizable error message to stderr. Used by tests that assert the
// wrapper propagates Python failures with a clear surfaced message.
console.error("simulated python failure");
process.exit(7);