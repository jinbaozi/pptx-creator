export function extractRequirements({ inputText, options = {} }) {
  const text = String(inputText || "").trim();
  if (!text) {
    throw new Error("inputText is required");
  }

  const audience = options.audience || "general business audience";
  const tone = options.tone || "polished business presentation";
  const objective = options.objective || `Create a ${tone} deck for ${audience}.`;

  return {
    version: "1.0",
    audience,
    objective,
    sourceFacts: [
      {
        id: "fact-001",
        text,
        source: "user-input"
      }
    ],
    mustInclude: Array.isArray(options.mustInclude) ? options.mustInclude : [],
    mustAvoid: Array.isArray(options.mustAvoid) ? options.mustAvoid : [],
    tone,
    confidenceNotes: []
  };
}
