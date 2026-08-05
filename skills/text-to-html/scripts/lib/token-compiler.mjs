/**
 * Compiles validated theme tokens into the small, fixed CSS variable surface
 * used by the deck shell. Theme loading performs token safety validation.
 */
export function compileTokenCss(tokens) {
  return `:root {
  --font-display: ${tokens.fonts.display};
  --font-body: ${tokens.fonts.body};
  --color-bg: ${tokens.colors.background};
  --color-surface: ${tokens.colors.surface};
  --color-text: ${tokens.colors.text};
  --color-muted: ${tokens.colors.muted};
  --color-primary: ${tokens.colors.primary};
  --color-primary-soft: ${tokens.colors.primarySoft};
  --color-accent: ${tokens.colors.accent};
  --color-positive: ${tokens.colors.positive};
  --color-border: ${tokens.colors.border};
  --title-size: ${tokens.type.title}px;
  --display-size: ${tokens.type.display}px;
  --section-size: ${tokens.type.section}px;
  --body-size: ${tokens.type.body}px;
  --label-size: ${tokens.type.label}px;
  --source-size: ${tokens.type.source}px;
  --canvas-x: ${tokens.space.canvasX}px;
  --canvas-y: ${tokens.space.canvasY}px;
  --gap: ${tokens.space.gap}px;
  --space-small: ${tokens.space.small}px;
  --radius-card: ${tokens.radius.card}px;
  --radius-pill: ${tokens.radius.pill}px;
  --shadow-card: ${tokens.shadow.card};
}
`;
}
