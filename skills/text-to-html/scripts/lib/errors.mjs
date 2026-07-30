export class SkillError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SkillError";
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }
}

export function fail(code, message, options) {
  throw new SkillError(code, message, options);
}

export function errorRecord(error) {
  return {
    status: "failed",
    code: error?.code ?? "E_UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.path ? { path: error.path } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {})
  };
}

export async function runCli(main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorRecord(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}
