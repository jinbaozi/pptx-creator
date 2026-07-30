(() => {
  const WIDTH = 1280;
  const HEIGHT = 720;
  const slides = [...document.querySelectorAll(".pptx-slide")];
  const counter = document.querySelector(".deck-counter");
  const previous = document.querySelector("[data-nav='previous']");
  const next = document.querySelector("[data-nav='next']");
  const readerHeading = document.querySelector(".mobile-reader-heading");
  const readerContent = document.querySelector(".mobile-reader-content");
  let activeIndex = 0;

  function scaleDeck() {
    const scale = Math.min(window.innerWidth / WIDTH, window.innerHeight / HEIGHT);
    document.documentElement.style.setProperty("--deck-scale", String(scale));
  }

  function relativeRect(baseElement, element) {
    const base = baseElement.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const slide = element.closest(".pptx-slide");
    const slideWidth = slide?.getBoundingClientRect().width || WIDTH;
    const scale = slideWidth / WIDTH || 1;
    return {
      left: (rect.left - base.left) / scale,
      right: (rect.right - base.left) / scale,
      top: (rect.top - base.top) / scale,
      bottom: (rect.bottom - base.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale
    };
  }

  function layoutConnectors(slide) {
    for (const connector of slide.querySelectorAll("[data-connector]")) {
      const source = slide.querySelector(`[data-pptx-id="${CSS.escape(connector.dataset.sourceId || "")}"]`);
      const target = slide.querySelector(`[data-pptx-id="${CSS.escape(connector.dataset.targetId || "")}"]`);
      const svg = connector.ownerSVGElement;
      if (!source || !target || !svg) continue;
      const from = relativeRect(svg, source);
      const to = relativeRect(svg, target);
      const svgRect = relativeRect(svg, svg);
      svg.setAttribute("viewBox", `0 0 ${svgRect.width} ${svgRect.height}`);
      const x1 = from.right;
      const y1 = from.top + from.height / 2;
      const x2 = to.left;
      const y2 = to.top + to.height / 2;
      const bend = x1 + Math.max(10, (x2 - x1) / 2);
      connector.setAttribute("d", `M ${x1} ${y1} L ${bend} ${y1} L ${bend} ${y2} L ${x2} ${y2}`);
      connector.dataset.x1 = String(x1);
      connector.dataset.y1 = String(y1);
      connector.dataset.x2 = String(x2);
      connector.dataset.y2 = String(y2);
    }
  }

  function layoutAllConnectors() {
    for (const slide of slides) layoutConnectors(slide);
  }

  function goTo(index, updateHash = true) {
    if (slides.length === 0) return;
    activeIndex = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    for (const [slideIndex, slide] of slides.entries()) {
      const active = slideIndex === activeIndex;
      slide.classList.toggle("is-active", active);
      slide.setAttribute("aria-hidden", active ? "false" : "true");
    }
    if (counter) counter.textContent = `${activeIndex + 1} / ${slides.length}`;
    if (previous) previous.disabled = activeIndex === 0;
    if (next) next.disabled = activeIndex === slides.length - 1;
    if (readerHeading && readerContent) {
      const activeSlide = slides[activeIndex];
      readerHeading.textContent = activeSlide.querySelector(".slide-title")?.textContent?.trim()
        || activeSlide.querySelector("h1")?.textContent?.trim()
        || `第 ${activeIndex + 1} 页`;
      readerContent.replaceChildren();
      const seen = new Set([readerHeading.textContent]);
      for (const element of activeSlide.querySelectorAll("[data-pptx-kind='text']")) {
        const id = element.dataset.pptxId ?? "";
        if (/(?:-title|-sources|-folio|-number-\d+|-index-\d+|-dot-\d+)$/.test(id)) continue;
        const value = element.textContent?.replace(/\s+/g, " ").trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const paragraph = document.createElement("p");
        paragraph.textContent = value;
        readerContent.append(paragraph);
      }
    }
    if (updateHash) history.replaceState(null, "", `#slide-${activeIndex + 1}`);
    requestAnimationFrame(() => layoutConnectors(slides[activeIndex]));
  }

  function indexFromHash() {
    const match = window.location.hash.match(/^#slide-(\d+)$/);
    return match ? Number(match[1]) - 1 : 0;
  }

  previous?.addEventListener("click", () => goTo(activeIndex - 1));
  next?.addEventListener("click", () => goTo(activeIndex + 1));
  window.addEventListener("keydown", (event) => {
    if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      goTo(activeIndex + 1);
    } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      goTo(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(slides.length - 1);
    }
  });
  window.addEventListener("hashchange", () => goTo(indexFromHash(), false));
  window.addEventListener("resize", () => {
    scaleDeck();
    requestAnimationFrame(layoutAllConnectors);
  });

  window.__deck = {
    goTo,
    get activeIndex() {
      return activeIndex;
    },
    get slideCount() {
      return slides.length;
    },
    layoutConnectors: layoutAllConnectors
  };

  scaleDeck();
  goTo(indexFromHash(), false);
  requestAnimationFrame(layoutAllConnectors);
})();
