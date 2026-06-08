export function createDirectionCandidates({ title, audience }) {
  return [
    {
      id: "direction-001",
      label: "Conservative Business",
      title,
      audience,
      tone: ["trusted", "clear", "executive"],
      palette: { background: "#F7F9FC", surface: "#FFFFFF", primary: "#1D4ED8", accent: "#14B8A6", text: "#172033" },
      typography: { title: "bold modern sans", body: "clean sans" },
      layoutStrategy: "high-readability grid, restrained contrast, executive summary rhythm",
      sampleSlides: []
    },
    {
      id: "direction-002",
      label: "Premium Tech Roadshow",
      title,
      audience,
      tone: ["premium", "technical", "precise"],
      palette: { background: "#07111F", surface: "#101C2E", primary: "#35D0FF", accent: "#7CFFB2", text: "#E8F1FF" },
      typography: { title: "bold geometric sans", body: "compact sans" },
      layoutStrategy: "diagram-led dark canvas, sharp focal hierarchy, controlled density",
      sampleSlides: []
    },
    {
      id: "direction-003",
      label: "Editorial Technical",
      title,
      audience,
      tone: ["explanatory", "structured", "readable"],
      palette: { background: "#FBFAF7", surface: "#FFFFFF", primary: "#0F766E", accent: "#F59E0B", text: "#1F2937" },
      typography: { title: "editorial sans", body: "document sans" },
      layoutStrategy: "explanation-first pages, generous whitespace, annotated diagrams",
      sampleSlides: []
    }
  ];
}

export function selectRepresentativeSlides(storyboard) {
  const slides = storyboard?.slides ?? [];
  const preferredRoles = ["cover", "architecture", "technical-solution", "user-value", "metrics", "summary"];
  const selected = [];
  for (const role of preferredRoles) {
    const found = slides.find((slide) => slide.role === role && !selected.includes(slide.id));
    if (found) selected.push(found.id);
    if (selected.length === 3) return selected;
  }
  for (const slide of slides) {
    if (!selected.includes(slide.id)) selected.push(slide.id);
    if (selected.length === 3) break;
  }
  return selected;
}

export function rankDirections(scorecards) {
  return [...scorecards].sort((a, b) => b.total - a.total || a.directionId.localeCompare(b.directionId));
}
