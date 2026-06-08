import fs from "node:fs";
import path from "node:path";
import {
  assertDesignDirection,
  assertSlideDesignSpecs,
  assertStoryboard
} from "./schema-utils.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadDesignFirstArtifacts(inputDir) {
  const base = path.resolve(inputDir);
  const storyboard = readJson(path.join(base, "deck.storyboard.json"));
  const designDirection = readJson(path.join(base, "deck.design-direction.json"));
  const slideDesignSpecs = readJson(path.join(base, "slide-design-specs.json"));
  assertStoryboard(storyboard);
  assertDesignDirection(designDirection);
  assertSlideDesignSpecs(slideDesignSpecs);
  return { baseDir: base, storyboard, designDirection, slideDesignSpecs };
}
