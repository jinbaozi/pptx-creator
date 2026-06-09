import { describe, expect, it } from "vitest";
import { extractRequirements } from "../scripts/lib/requirements-extractor.mjs";
import { readJson, validateSchema } from "../scripts/lib/schema-utils.mjs";

describe("requirements extractor", () => {
  it("extracts a deterministic requirements artifact from plain text", async () => {
    const requirements = extractRequirements({
      inputText: "Build a business technology roadshow deck for compiler sample, a Rust-based GCC-compatible C compiler.",
      options: {
        audience: "technical executives",
        tone: "business technology roadshow"
      }
    });

    expect(requirements.audience).toBe("technical executives");
    expect(requirements.objective).toContain("roadshow");
    expect(requirements.sourceFacts[0].text).toContain("Rust-based");
    expect(requirements.tone).toBe("business technology roadshow");
  });

  it("validates against the requirements schema", async () => {
    const schema = await readJson("schemas/requirements.schema.json");
    const requirements = extractRequirements({
      inputText: "Create a polished deck about Claude Design-like workflows.",
      options: { audience: "product team" }
    });

    expect(() => validateSchema(schema, requirements, "requirements")).not.toThrow();
  });
});

