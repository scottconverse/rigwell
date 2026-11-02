// Phone menu and copy buttons. The page works without this file.
const toggle = document.querySelector(".nav-toggle");
const links = document.getElementById("nav-links");
if (toggle && links) {
  const set = (open) => { links.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); };
  toggle.addEventListener("click", () => set(!links.classList.contains("open")));
  links.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && links.classList.contains("open")) { set(false); toggle.focus(); } });
}

for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy || "");
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => { btn.textContent = "Copy"; }, 1600);
  });
}
