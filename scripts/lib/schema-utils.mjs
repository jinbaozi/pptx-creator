function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

export function assertStoryboard(storyboard) {
  assertObject(storyboard, "storyboard");
  for (const key of ["title", "audience", "goal", "language"]) {
    assertString(storyboard[key], `storyboard.${key}`);
  }
  assertArray(storyboard.slides, "storyboard.slides");
  if (storyboard.slides.length === 0) throw new Error("storyboard.slides must not be empty");
  storyboard.slides.forEach((slide, index) => {
    assertObject(slide, `storyboard.slides[${index}]`);
    for (const key of ["id", "role", "message"]) {
      assertString(slide[key], `storyboard.slides[${index}].${key}`);
    }
    assertArray(slide.contentBlocks, `storyboard.slides[${index}].contentBlocks`);
  });
}

export function assertDesignDirection(direction) {
  assertObject(direction, "designDirection");
  assertString(direction.style, "designDirection.style");
  assertArray(direction.tone, "designDirection.tone");
  assertObject(direction.palette, "designDirection.palette");
  for (const key of ["background", "surface", "primary", "accent", "text"]) {
    assertString(direction.palette[key], `designDirection.palette.${key}`);
  }
  assertObject(direction.typography, "designDirection.typography");
  assertString(direction.typography.title, "designDirection.typography.title");
  assertString(direction.typography.body, "designDirection.typography.body");
  assertString(direction.layoutStrategy, "designDirection.layoutStrategy");
  assertArray(direction.avoid, "designDirection.avoid");
}

export function assertSlideDesignSpecs(specs) {
  assertObject(specs, "slideDesignSpecs");
  assertArray(specs.slides, "slideDesignSpecs.slides");
  if (specs.slides.length === 0) throw new Error("slideDesignSpecs.slides must not be empty");
  specs.slides.forEach((slide, index) => {
    assertObject(slide, `slideDesignSpecs.slides[${index}]`);
    for (const key of ["id", "layoutType", "intent", "mainIdea"]) {
      assertString(slide[key], `slideDesignSpecs.slides[${index}].${key}`);
    }
    assertObject(slide.visualPlan, `slideDesignSpecs.slides[${index}].visualPlan`);
    assertString(slide.visualPlan.focalPoint, `slideDesignSpecs.slides[${index}].visualPlan.focalPoint`);
    assertString(slide.visualPlan.density, `slideDesignSpecs.slides[${index}].visualPlan.density`);
    assertObject(slide.visualPlan.visualWeight, `slideDesignSpecs.slides[${index}].visualPlan.visualWeight`);
    assertArray(slide.contentSlots, `slideDesignSpecs.slides[${index}].contentSlots`);
    assertNumber(slide.editableTarget, `slideDesignSpecs.slides[${index}].editableTarget`);
  });
}
