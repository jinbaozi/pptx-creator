import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesignFile } from "./parse-design-md.mjs";

function requireValue(value, message, errors) {
  if (value === undefined || value === null || value === "") {
    errors.push(message);
  }
}

function validateReferences(value, tokens, errors, path = "root") {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{([^}]+)\}/g)) {
      const ref = match[1].split(".");
      let cursor = tokens;
      for (const part of ref) cursor = cursor?.[part];
      if (cursor === undefined) errors.push(`unresolved token reference ${match[0]} at ${path}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => validateReferences(item, tokens, errors, `${path}[${index}]`));
  } else if (typeof value === "object" && value) {
    for (const [key, item] of Object.entries(value)) {
      validateReferences(item, tokens, errors, `${path}.${key}`);
    }
  }
}

export function validateDesignProfile(profile) {
  const errors = [];
  const tokens = profile.tokens ?? {};
  requireValue(tokens.name, "frontmatter name is required", errors);
  requireValue(tokens.colors?.primary, "colors.primary is required", errors);
  requireValue(tokens.typography?.title, "typography.title is required", errors);
  requireValue(tokens.typography?.body, "typography.body is required", errors);
  requireValue(profile.sections?.["PPTX Export Rules"], "PPTX Export Rules section is required", errors);
  requireValue(profile.sections?.["Editability Rules"], "Editability Rules section is required", errors);
  requireValue(profile.sections?.["Do's and Don'ts"], "Do's and Don'ts section is required", errors);
  validateReferences(tokens.components ?? {}, tokens, errors, "components");
  return errors;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: validate-design-md.mjs <DESIGN.md>");
    process.exit(1);
  }
  parseDesignFile(path)
    .then((profile) => {
      const errors = validateDesignProfile(profile);
      if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
      }
      console.log("design valid");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
