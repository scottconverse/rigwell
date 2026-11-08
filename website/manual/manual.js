// Manual: contents filter, active section, phone contents menu, heading anchors and Mermaid diagrams.
// The text works without this file; the diagrams then show as their Mermaid source.
const toc = document.getElementById("toc");
const toggle = document.querySelector(".toc-toggle");
if (toc && toggle) {
  const set = (open) => { toc.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); };
  toggle.addEventListener("click", () => set(!toc.classList.contains("open")));
  toc.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && toc.classList.contains("open")) { set(false); toggle.focus(); } });
}

const search = document.querySelector(".toc-search");
if (search && toc) {
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const li of toc.querySelectorAll("li")) li.classList.toggle("hidden", q !== "" && !li.textContent.toLowerCase().includes(q));
  });
}

for (const h of document.querySelectorAll(".doc-main :is(h2, h3)[id]")) {
  const a = document.createElement("a");
  a.className = "anchor"; a.href = `#${h.id}`; a.textContent = "#"; a.setAttribute("aria-label", `Link to ${h.textContent}`);
  h.append(a);
}

const links = new Map([...document.querySelectorAll(".toc a[href^='#']")].map((a) => [a.getAttribute("href").slice(1), a]));
if ("IntersectionObserver" in window && links.size) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove("active");
      links.get(e.target.id)?.classList.add("active");
    }
  }, { rootMargin: "-70px 0px -70% 0px" });
  for (const id of links.keys()) { const el = document.getElementById(id); if (el) io.observe(el); }
}

if (window.mermaid) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: dark
      ? { primaryColor: "#1f3a45", primaryTextColor: "#ebe7e5", primaryBorderColor: "#4b7f91", lineColor: "#a09a97", secondaryColor: "#2a2523", tertiaryColor: "#1f1d1c", noteBkgColor: "#3a2c14", noteTextColor: "#ebe7e5", actorBkg: "#1f3a45", actorTextColor: "#ebe7e5", signalColor: "#ebe7e5", signalTextColor: "#ebe7e5", labelBoxBkgColor: "#1f3a45" }
      : { primaryColor: "#e3eef1", primaryTextColor: "#1d1b1a", primaryBorderColor: "#1d4e5f", lineColor: "#6b6664", secondaryColor: "#fbf1df", tertiaryColor: "#ffffff", noteBkgColor: "#fbf1df", noteTextColor: "#1d1b1a", actorBkg: "#e3eef1", actorBorder: "#1d4e5f", signalColor: "#1d1b1a", labelBoxBkgColor: "#e3eef1" },
  });
  window.mermaid.run({ querySelector: "pre.mermaid" }).catch((err) => console.error("Mermaid:", err));
}
