import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    throw new Error("DESIGN.md must start with YAML frontmatter");
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    throw new Error("DESIGN.md frontmatter is not closed");
  }
  return {
    yaml: text.slice(4, end),
    body: text.slice(end + 4).replace(/^\n/, "")
  };
}

function parseSections(body) {
  const sections = {};
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1].trim();
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    sections[heading] = body.slice(start, end).trim();
  }
  return sections;
}

export async function parseDesignFile(path) {
  const text = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  const parts = splitFrontmatter(text);
  const tokens = YAML.parse(parts.yaml);
  return {
    source: resolve(path),
    name: tokens.name,
    description: tokens.description ?? "",
    tokens,
    sections: parseSections(parts.body),
    warnings: []
  };
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: parse-design-md.mjs <DESIGN.md>");
    process.exit(1);
  }
  parseDesignFile(path)
    .then((profile) => console.log(JSON.stringify(profile, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
