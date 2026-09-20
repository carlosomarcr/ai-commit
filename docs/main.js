(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Nav background once the page is scrolled (observer, no scroll listener).
  const nav = $("#nav");
  new IntersectionObserver(([e]) => nav.classList.toggle("stuck", !e.isIntersecting)).observe($("#top"));

  // Scroll reveal, staggered inside grids.
  const rv = $$(".rv");
  rv.forEach((el) => {
    const sibs = el.parentElement.querySelectorAll(":scope > .rv");
    if (sibs.length > 1) el.style.setProperty("--d", `${Math.min([...sibs].indexOf(el), 8) * 70}ms`);
  });
  if (reduce || !("IntersectionObserver" in window)) {
    rv.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }),
      { rootMargin: "0px 0px -4% 0px", threshold: 0.08 },
    );
    rv.forEach((el) => io.observe(el));
  }

  // Cursor-follow glow on cards.
  $$(".card").forEach((c) =>
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", `${e.clientX - r.left}px`);
      c.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, { passive: true }),
  );

  // Terminal: type the command, then reveal the output line by line.
  const term = $("#term");
  const typed = $("#typed");
  const lines = $$(".ln", term).slice(1);
  const word = typed.dataset.text;
  let run = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function play() {
    const id = ++run;
    lines.forEach((l) => l.classList.remove("on"));
    typed.textContent = "";
    for (const ch of word) {
      if (id !== run) return;
      typed.textContent += ch;
      await sleep(90);
    }
    await sleep(350);
    for (const l of lines) {
      if (id !== run) return;
      l.classList.add("on");
      const t = l.textContent;
      await sleep(t.includes("Planning") ? 700 : /^\s*(\d\/3|\?|✔)/.test(t) ? 320 : 150);
    }
  }
  function showAll() {
    run++;
    typed.textContent = word;
    lines.forEach((l) => l.classList.add("on"));
  }
  if (reduce) showAll();
  else new IntersectionObserver(([e], o) => { if (e.isIntersecting) { play(); o.disconnect(); } }, { threshold: 0.3 }).observe(term);
  $("#replay").addEventListener("click", () => (reduce ? showAll() : play()));

  // Copy buttons.
  $$(".copy").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        const old = b.textContent;
        b.textContent = "Copied ✔";
        b.classList.add("ok");
        setTimeout(() => { b.textContent = old; b.classList.remove("ok"); }, 1600);
      } catch { /* clipboard blocked: the text is still selectable */ }
    }),
  );

  // Accessible install tabs (click + arrow keys).
  const tabs = $$('[role="tab"]');
  const select = (t) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute("aria-selected", on);
      x.tabIndex = on ? 0 : -1;
      $("#" + x.getAttribute("aria-controls")).hidden = !on;
    });
    t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length]); }
    });
  });

  // Keep the version badge current without hard-coding it in more than one place.
  fetch("https://registry.npmjs.org/@carlosomarcr/gitowl/latest", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && /^\d+\.\d+\.\d+$/.test(j.version)) $("#ver").textContent = "v" + j.version; })
    .catch(() => {});
})();
