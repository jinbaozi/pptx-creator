/**
 * Dispatches only a renderer that has already been selected by the validated
 * layout-archetype adapter. It deliberately does not infer content or mutate
 * slots; each handler receives the reviewed slide unchanged.
 */
export function renderSlotBody(slide, handlers) {
  const handler = handlers?.[slide?.type];
  return typeof handler === "function" ? handler() : "";
}
