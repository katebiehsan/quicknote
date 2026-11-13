/* Quicknote – offline notieren, über GitHub (quicknote-inbox) mit Second Brain abgleichen.
   Ablauf: jede Änderung wird zuerst lokal gespeichert (IndexedDB, Ausgang) und als Issue an
   katebiehsan/quicknote-inbox geschickt, sobald Netz und Schlüssel da sind. Claude trägt die Issues
   stündlich in Second Brain ein und schreibt mirror.json (alle Notizen) zurück; die App liest sie. */
(() => {
  "use strict";
  const REPO = "katebiehsan/quicknote-inbox";
  const API = "https://api.github.com/repos/" + REPO;
  const SYNC_MIN = 7;            // Minute, zu der der stündliche Abgleich läuft (8–23 Uhr)
  const SYNC_FIRST = 8, SYNC_LAST = 23;
  const EO = "cubic-bezier(0.23, 1, 0.32, 1)";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const nowIso = () => new Date().toISOString();
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
  };
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const MON = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."];
  const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.2 2.2L9.5 3.6"/></svg>';

  /* ---------- IndexedDB ---------- */
  const DB = (() => {
    let opening = null;
    function open() {
      if (!opening) opening = new Promise((res, rej) => {
        const r = indexedDB.open("quicknote", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("notes", { keyPath: "id" });
          d.createObjectStore("outbox", { keyPath: "opId" });
          d.createObjectStore("kv");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return opening;
    }
    /* Eine Transaktion über mehrere Speicher: alles oder nichts */
    async function run(stores, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(stores, "readwrite");
        fn((name) => t.objectStore(name));
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("abgebrochen"));
      });
    }
    async function all(name) {
      const d = await open();
      return new Promise((res, rej) => {
        const r = d.transaction(name, "readonly").objectStore(name).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    }
    async function get(name, key) {
      const d = await open();
      return new Promise((res, rej) => {
        const r = d.transaction(name, "readonly").objectStore(name).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return { run, all, get };
  })();

  /* ---------- Zustand ---------- */
  const notes = new Map();   // id -> Notiz (wie sie gerade aussieht, inkl. noch nicht übertragener Änderungen)
  const outbox = new Map();  // opId -> Änderung { opId, noteId, kind, ts, base, note, state: wait|sent, sentAt }
  let token = "", mirrorAt = "", authBad = false, flushing = false, query = "";
  const fresh = new Set();   // Zeilen, die beim nächsten Zeichnen einfliegen

  /* ---------- Text-Hilfen ---------- */
  const TODO = /^\s*[-*]\s\[( |x|X)\]\s?(.*)$/;
  function parse(text) {
    const lines = String(text || "").split("\n");
    let title = "", sub = [], todos = [];
    lines.forEach((l, i) => {
      const m = l.match(TODO);
      if (!title && l.trim()) { title = m ? "Aufgaben" : l.trim(); if (!m) return; }
      if (m) todos.push({ i, on: m[1] !== " ", t: m[2].trim() });
      else if (l.trim()) sub.push(l.trim());
    });
    return { title: title || "Leere Notiz", sub: sub.join(" · "), todos };
  }
  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso), t = new Date();
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), b = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const diff = Math.round((b - a) / 86400000);
    if (diff === 0) return pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (diff === 1) return "Gestern";
    if (diff > 1 && diff < 7) return WD[d.getDay()];
    return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + ".";
  }
  function longDate(iso) {
    const d = new Date(iso);
    return d.getDate() + ". " + MON[d.getMonth()] + " " + d.getFullYear() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function nextImport() {
    const d = new Date();
    let h = d.getHours() + (d.getMinutes() >= SYNC_MIN ? 1 : 0);
    if (h < SYNC_FIRST) return "um " + SYNC_FIRST + ":" + pad(SYNC_MIN);
    if (h > SYNC_LAST) return "morgen um " + SYNC_FIRST + ":" + pad(SYNC_MIN);
    return "um " + h + ":" + pad(SYNC_MIN);
  }

  /* ---------- Termin erkennen: „morgen 10 Uhr“, „Freitag 14:30“, „20.11.“ ---------- */
  const DAYS = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6 };
  function detect(text) {
    const first = String(text || "").split("\n").find((l) => l.trim()) || "";
    const s = first.toLowerCase();
    const now = new Date();
    let date = null, used = [];
    const dm = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
    if (dm) {
      let y = dm[3] ? +dm[3] : now.getFullYear(); if (y < 100) y += 2000;
      date = new Date(y, +dm[2] - 1, +dm[1]);
      if (!dm[3] && date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) date.setFullYear(y + 1);
      used.push(dm[0]);
    } else {
      const rel = s.match(/\b(übermorgen|morgen|heute)\b/);
      if (rel) { date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + { heute: 0, morgen: 1, übermorgen: 2 }[rel[1]]); used.push(rel[0]); }
      else {
        const wd = s.match(/\b(nächsten |nächster |am )?(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/);
        if (wd) { const add = (DAYS[wd[2]] - now.getDay() + 7) % 7 || 7; date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add); used.push(wd[0]); }
      }
    }
    if (!date || isNaN(date)) return null;
    let start = "";
    const tm = s.match(/\b(?:um\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*uhr\b/) || s.match(/\b(?:um\s+)?(\d{1,2})[:.](\d{2})\b(?!\.)/);
    if (tm && +tm[1] < 24 && (!tm[2] || +tm[2] < 60)) { start = pad(+tm[1]) + ":" + (tm[2] || "00"); used.push(tm[0]); }
    let title = first;
    for (const u of used) { const i = title.toLowerCase().indexOf(u); if (i >= 0) title = title.slice(0, i) + title.slice(i + u.length); }
    title = title.replace(/\s+(am|um|ab)\s*$/i, "").replace(/\s{2,}/g, " ").replace(/^[\s,–-]+|[\s,–-]+$/g, "") || first.trim();
    const key = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
    return {
      date: key, start, end: "", title, cal: "claude",   // Standard Claude, Privat per Tipp auf den Vorschlag
      label: WD[date.getDay()] + ", " + date.getDate() + ". " + MON[date.getMonth()] + (start ? ", " + start : ""),
    };
  }
  function terminLabel(v) {
    const [y, m, d] = String(v.date).split("-").map(Number);
    const dt = new Date(y, m - 1, d, 12);
    return WD[dt.getDay()] + ", " + d + ". " + MON[m - 1] + (v.start ? ", " + v.start : "");
  }

  /* ---------- Speichern: erst lokal, dann Ausgang ---------- */
  function sentFor(noteId) { return [...outbox.values()].some((o) => o.noteId === noteId && o.state === "sent"); }
  async function enqueue(kind, note, base) {
    const prev = [...outbox.values()].find((o) => o.noteId === note.id && o.state === "wait");
    const snap = { id: note.id, text: note.text, created: note.created, updated: note.updated, angeheftet: !!note.angeheftet };
    if (note.vorschlag) snap.vorschlag = note.vorschlag;
    /* Text, den Quicknote zuletzt aus Second Brain kannte: damit führt der Abgleich zeilenweise zusammen */
    const known = notes.get(note.id);
    const baseText = prev ? prev.baseText : (known && known._mt != null ? known._mt : null);
    let op = { opId: uid("op"), noteId: note.id, kind, ts: nowIso(), base: prev ? prev.base : base, baseText, note: snap, state: "wait" };
    /* Neu angelegt, noch nie übertragen und gleich wieder gelöscht: einfach weglassen */
    const drop = kind === "delete" && prev && prev.kind === "upsert" && prev.base == null && !sentFor(note.id) && !note._m;
    if (drop) op = null;
    await DB.run(["notes", "outbox"], (s) => {
      if (prev) s("outbox").delete(prev.opId);
      if (op) s("outbox").put(op);
      if (kind === "delete") s("notes").delete(note.id); else s("notes").put(note);
    });
    if (prev) outbox.delete(prev.opId);
    if (op) outbox.set(op.opId, op);
    if (kind === "delete") notes.delete(note.id); else notes.set(note.id, note);
    flush();
  }

  /* ---------- Übertragen an GitHub ---------- */
  function ghHeaders(extra) {
    return Object.assign({ Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" }, extra || {});
  }
  async function flush() {
    updatePill();
    if (flushing || !token || authBad || !navigator.onLine) return;
    flushing = true;
    try {
      const waiting = [...outbox.values()].filter((o) => o.state === "wait").sort((a, b) => a.ts.localeCompare(b.ts));
      for (const op of waiting) {
        if (!outbox.has(op.opId)) continue;
        const payload = { v: 1, opId: op.opId, kind: op.kind, ts: op.ts, base: op.base, note: op.note };
        if (op.baseText != null) payload.baseText = op.baseText;
        const body = "<!-- quicknote -->\n```json\n" + JSON.stringify(payload, null, 1) + "\n```\n";
        let r;
        try {
          r = await fetch(API + "/issues", { method: "POST", headers: ghHeaders({ Accept: "application/vnd.github+json", "Content-Type": "application/json" }), body: JSON.stringify({ title: "qn " + op.opId, body }) });
        } catch (e) { break; }
        if (r.status === 401 || r.status === 403 || r.status === 404) { authBad = true; toast({ title: "Schlüssel funktioniert nicht", desc: "Tippe oben auf den Status, um ihn zu prüfen.", type: "err" }); break; }
        if (!r.ok) break;
        const cur = outbox.get(op.opId);
        if (!cur) continue;
        const done = { ...cur, state: "sent", sentAt: nowIso() };
        await DB.run(["outbox"], (s) => s("outbox").put(done));
        outbox.set(done.opId, done);
        render();
      }
    } finally { flushing = false; updatePill(); }
  }

  /* ---------- Spiegel aus Second Brain lesen ---------- */
  let mirrorBusy = false;
  async function pullMirror() {
    if (mirrorBusy || !token || authBad || !navigator.onLine) return;
    mirrorBusy = true;
    try {
      let r;
      try { r = await fetch(API + "/contents/mirror.json?t=" + Date.now(), { headers: ghHeaders({ Accept: "application/vnd.github.raw+json" }), cache: "no-store" }); }
      catch (e) { return; }
      if (r.status === 401 || r.status === 403) { authBad = true; updatePill(); return; }
      if (!r.ok) return;
      let m;
      try { m = await r.json(); } catch (e) { return; }
      if (!m || !Array.isArray(m.notes)) return;
      await applyMirror(m);
    } finally { mirrorBusy = false; }
  }
  async function applyMirror(m) {
    const mir = new Map(m.notes.filter((n) => n && n.id && !n.deleted).map((n) => [n.id, n]));
    /* Übertragene Änderungen abhaken, sobald Second Brain sie enthält */
    const old = Date.now() - 14 * 86400000;
    const settled = [];
    for (const o of outbox.values()) {
      if (o.state !== "sent") continue;
      const x = mir.get(o.noteId);
      const ok = o.kind === "delete" ? !x : x && (String(x.updated) > String(o.note.updated) || (x.text === o.note.text && !!x.angeheftet === !!o.note.angeheftet));
      if (ok || new Date(o.sentAt || o.ts).getTime() < old) settled.push(o.opId);
    }
    settled.forEach((id) => outbox.delete(id));
    /* Neuer Stand = Second Brain + alles, was noch unterwegs ist */
    const next = new Map();
    for (const n of mir.values()) next.set(n.id, { id: n.id, text: n.text || "", created: n.created || n.updated, updated: n.updated || n.created, angeheftet: !!n.angeheftet, gruppe: n.gruppe || null, vorschlag: n.vorschlag || null, _m: n.updated || n.created || "x", _mt: n.text || "" });
    for (const o of [...outbox.values()].sort((a, b) => a.ts.localeCompare(b.ts))) {
      if (o.kind === "delete") next.delete(o.noteId);
      else { const mm = mir.get(o.noteId); next.set(o.noteId, { ...(next.get(o.noteId) || {}), ...o.note, _m: mm ? mm.updated : null, _mt: mm ? mm.text || "" : null }); }
    }
    await DB.run(["notes", "outbox", "kv"], (s) => {
      settled.forEach((id) => s("outbox").delete(id));
      s("notes").clear();
      for (const n of next.values()) s("notes").put(n);
      s("kv").put(m.generated || nowIso(), "mirrorAt");
    });
    notes.clear(); next.forEach((v, k) => notes.set(k, v));
    mirrorAt = m.generated || nowIso();
    render();
  }

  /* ---------- Status oben ---------- */
  function updatePill() {
    const wait = [...outbox.values()].filter((o) => o.state === "wait").length;
    const sent = [...outbox.values()].some((o) => o.state === "sent");
    let text, cls = "";
    if (!token) { text = "Schlüssel fehlt"; cls = "bad"; }
    else if (authBad) { text = "Schlüssel prüfen"; cls = "bad"; }
    else if (wait) { text = wait + " wartet"; cls = "wait"; }
    else if (sent) text = "Nächster Sync " + nextImport().replace(/^um /, "").replace(/^morgen um /, "morgen ");
    else { text = "Alles in Second Brain"; cls = "ok"; }
    const p = $("pill"), t = $("pillT");
    /* Nur ein Symbol: grüner Haken = alles da, Uhr = kommt beim nächsten Sync, gelbe Zahl = wartet, rotes ! = Schlüssel */
    const label = text;
    /* Ein Symbol für die Verbindung: grüne Wolke mit Haken = verbunden, weiß = überträgt, rot = Schlüssel, grau durchgestrichen = offline */
    text = "";
    if (cls === "ok" || (!cls && sent)) cls = "ok";
    if (cls === "wait") cls = navigator.onLine ? "busy" : "off";
    p.setAttribute("aria-label", label); p.title = label;
    if (t.textContent === text && p.dataset.cls === cls) return;
    const apply = () => { t.textContent = text; p.className = "pill" + (cls ? " " + cls : ""); p.dataset.cls = cls; };
    if (!t.textContent || reduce) { apply(); return; }
    p.classList.add("swap");
    setTimeout(() => { apply(); p.classList.remove("swap"); }, 120);
  }

  /* ---------- Liste zeichnen (Zeilen bleiben bestehen, damit Animationen sauber laufen) ---------- */
  function opState(id) {
    let st = null;
    for (const o of outbox.values()) if (o.noteId === id) { if (o.state === "wait") return "wait"; st = "sent"; }
    return st;
  }
  function rowInner(n) {
    const p = parse(n.text);
    const waiting = opState(n.id) === "wait";
    let h = '<div class="t1"><b>' + esc(p.title) + "</b><time>" + (waiting ? '<i class="wdot" aria-label="Wartet auf Netz"></i>' : "") + esc(shortDate(n.updated || n.created)) + "</time></div>";
    if (p.sub) h += '<div class="sub">' + esc(p.sub) + "</div>";
    if (p.todos.length) {
      h += '<div class="todos">' + p.todos.slice(0, 5).map((t) => '<button type="button" class="todo' + (t.on ? " on" : "") + '" data-line="' + t.i + '" aria-pressed="' + t.on + '"><span class="cb">' + CHECK + '</span><span class="tx">' + esc(t.t || " ") + "</span></button>").join("") + "</div>";
      if (p.todos.length > 5) h += '<div class="more">+' + (p.todos.length - 5) + " weitere</div>";
    }
    if (n.vorschlag && n.vorschlag.date && !n.vorschlag.done) h += '<div class="st"><i class="dot' + (n.vorschlag.cal === "claude" ? " claude" : "") + '"></i>Termin-Vorschlag · ' + esc(terminLabel(n.vorschlag)) + "</div>";
    return h;
  }
  function makeRow(n) {
    const r = document.createElement("div");
    r.className = "row"; r.dataset.id = n.id;
    r.innerHTML = '<div class="bgL"><svg class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/></svg><span>' + (n.angeheftet ? "Lösen" : "Anheften") + '</span></div><div class="bgR"><button type="button" class="del">Löschen</button></div><div class="front" role="button" tabindex="0"></div>';
    wireRow(r);
    return r;
  }
  function enter(el) {
    if (reduce) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 }); return; }
    const h = el.offsetHeight;
    el.animate([{ height: "0px", opacity: 0, transform: "translateY(-4px)" }, { height: h + "px", opacity: 1, transform: "none" }], { duration: 260, easing: EO });
  }
  function leave(el) {
    el.dataset.leaving = "1";
    if (openRow === el) openRow = null;
    const f = el.querySelector(".front");
    const gone = () => { if (el.isConnected) el.remove(); };
    if (reduce || !el.offsetParent) { gone(); return; }
    const h = el.offsetHeight;
    /* Emil: erst zur Seite gleiten, dann die Lücke weich schließen */
    const slide = el._swiped ? f.animate([{ transform: getComputedStyle(f).transform }, { transform: "translateX(-110%)", opacity: 0 }], { duration: 180, easing: EO, fill: "forwards" }) : null;
    const close = () => { const a = el.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 220, easing: EO, fill: "forwards" }); a.onfinish = gone; };
    if (slide) slide.onfinish = close; else close();
    setTimeout(gone, 700);
  }
  function paint(container, items) {
    const existing = new Map();
    for (const el of container.children) if (el.dataset.id && !el.dataset.leaving) existing.set(el.dataset.id, el);
    let prev = null;
    for (const n of items) {
      let el = existing.get(n.id);
      const html = rowInner(n);
      const at = prev ? prev.nextSibling : container.firstChild;
      if (!el) {
        el = makeRow(n);
        el.querySelector(".front").innerHTML = html; el._h = html;
        container.insertBefore(el, at);
        if (fresh.has(n.id)) enter(el);
      } else {
        existing.delete(n.id);
        if (el._h !== html) { el.querySelector(".front").innerHTML = html; el._h = html; }
        el.querySelector(".bgL span").textContent = n.angeheftet ? "Lösen" : "Anheften";
        if (at !== el) container.insertBefore(el, at);
      }
      prev = el;
    }
    for (const el of existing.values()) leave(el);
  }
  function render() {
    const q = query.trim().toLowerCase();
    const all = [...notes.values()].filter((n) => String(n.text || "").trim()).sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
    const hits = q ? all.filter((n) => n.text.toLowerCase().includes(q)) : all;
    const pinned = hits.filter((n) => n.angeheftet), rest = hits.filter((n) => !n.angeheftet);
    $("pinSec").hidden = !pinned.length;
    $("noteSec").querySelector(".sh").hidden = !rest.length && pinned.length > 0;
    $("pinN").textContent = pinned.length;
    paint($("pinList"), pinned);
    paint($("list"), rest);
    const empty = $("empty");
    if (!all.length) { empty.hidden = false; empty.textContent = "Noch keine Notizen. Was du hier sicherst, landet stündlich in Second Brain."; }
    else if (q && !hits.length) { empty.hidden = false; empty.textContent = "Keine Notiz passt zu „" + query.trim() + "“."; }
    else empty.hidden = true;
    fresh.clear();
    updatePill();
  }

  /* ---------- Wischen: rechts = anheften/lösen, links = Löschen zeigen ---------- */
  let openRow = null;
  function wireRow(r) {
    const f = r.querySelector(".front"), OPEN = -96;
    let x0 = 0, y0 = 0, t0 = 0, dx = 0, base = 0, active = false, horiz = null, pid = null;
    const set = (x) => { f.style.transform = x ? "translateX(" + x + "px)" : ""; r.classList.toggle("sw-r", x > 0); r.classList.toggle("sw-l", x < 0); };
    const snap = (x) => { f.classList.add("snap"); set(x); base = x; if (x === 0) setTimeout(() => { if (base === 0) r.classList.remove("sw-r", "sw-l"); }, 260); };
    r._close = () => snap(0);
    f.addEventListener("pointerdown", (e) => {
      if (active || e.button > 0) return;
      if (openRow && openRow !== r) { openRow._close(); openRow = null; }
      active = true; pid = e.pointerId; horiz = null; x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); dx = 0;
      f.classList.remove("snap");
    });
    f.addEventListener("pointermove", (e) => {
      if (!active || e.pointerId !== pid) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (horiz === null) {
        if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
        horiz = Math.abs(mx) > Math.abs(my);
        if (horiz) { try { f.setPointerCapture(pid); } catch (err) {} } else { active = false; return; }
      }
      dx = mx;
      let x = base + dx;
      if (x > 72) x = 72 + (x - 72) * 0.3;          // Widerstand statt harter Grenze
      if (x < OPEN) x = OPEN + (x - OPEN) * 0.3;
      r.classList.toggle("arm", base === 0 && x > 56);   // Nadel springt an, sobald Loslassen anheftet
      set(x);
    });
    const up = (e) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      if (!horiz) return;
      f._dragged = true; setTimeout(() => { f._dragged = false; }, 50);
      const v = Math.abs(dx) / Math.max(1, Date.now() - t0), x = base + dx;
      r.classList.remove("arm");
      if (base === 0 && (x > 56 || (v > 0.11 && dx > 16))) { snap(0); togglePin(r.dataset.id); return; }
      if (x < -48 || (v > 0.11 && dx < -16)) { snap(OPEN); openRow = r; } else { snap(0); if (openRow === r) openRow = null; }
    };
    f.addEventListener("pointerup", up);
    f.addEventListener("pointercancel", up);
    f.addEventListener("click", (e) => {
      if (f._dragged) return;
      if (base !== 0) { snap(0); openRow = null; return; }
      const t = e.target.closest(".todo");
      if (t) { toggleTodo(r.dataset.id, +t.dataset.line, t); return; }
      openNote(r.dataset.id);
    });
    f.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === f) openNote(r.dataset.id); });
    r.querySelector(".del").addEventListener("click", () => { openRow = null; r._swiped = true; removeNote(r.dataset.id); });
  }

  /* ---------- Aktionen ---------- */
  async function togglePin(id) {
    const n = notes.get(id); if (!n) return;
    fresh.add(id);
    await enqueue("upsert", { ...n, angeheftet: !n.angeheftet }, n._m || null);
    render();
  }
  async function toggleTodo(id, line, btn) {
    const n = notes.get(id); if (!n) return;
    const lines = n.text.split("\n"), m = (lines[line] || "").match(TODO);
    if (!m) return;
    const on = m[1] === " ";
    lines[line] = lines[line].replace(/\[( |x|X)\]/, on ? "[x]" : "[ ]");
    btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on));
    const text = lines.join("\n");
    const el = btn.closest(".row");
    await enqueue("upsert", { ...n, text, updated: nowIso() }, n._m || null);
    if (el) el._h = rowInner(notes.get(id));   // Zeile nicht neu zeichnen, die Animation läuft schon
    setTimeout(render, 400);
  }
  async function removeNote(id) {
    const n = notes.get(id); if (!n) return;
    const snapNote = { ...n };
    await enqueue("delete", n, n._m || null);
    render();
    toast({ title: "Gelöscht", desc: parse(snapNote.text).title, action: { label: "Rückgängig", fn: async () => { fresh.add(id); await enqueue("upsert", { ...snapNote, updated: nowIso() }, snapNote._m || null); render(); } } });
  }

  /* ---------- Neue Notiz ---------- */
  const ta = $("ta"), chip = $("chip");
  let calOverride = null, lastDetect = null, okTimer = null;
  function grow(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  function updateChip() {
    const d = detect(ta.value);
    lastDetect = d;
    if (!d) { chip.classList.add("off"); calOverride = null; return; }
    const cal = calOverride || d.cal;
    $("chipT").textContent = d.label;
    chip.querySelector(".dot").classList.toggle("claude", cal === "claude");
    chip.setAttribute("aria-label", "Termin-Vorschlag " + d.label + ", Kalender " + (cal === "claude" ? "Claude" : "Privat") + ". Antippen wechselt den Kalender.");
    chip.classList.remove("off");
  }
  ta.value = ls.get("qn-draft") || "";
  ta.addEventListener("input", () => { ls.set("qn-draft", ta.value || null); $("err").textContent = ""; grow(ta); updateChip(); });
  chip.addEventListener("pointerdown", (e) => e.preventDefault());
  chip.addEventListener("click", () => { if (!lastDetect) return; calOverride = (calOverride || lastDetect.cal) === "claude" ? "privat" : "claude"; updateChip(); });
  /* Knöpfe nehmen dem Textfeld nicht den Fokus, damit die Tastatur offen bleibt */
  ["saveBtn", "todoBtn"].forEach((id) => $(id).addEventListener("pointerdown", (e) => { if (document.activeElement === ta) e.preventDefault(); }));
  $("todoBtn").addEventListener("click", () => {
    const v = ta.value, pos = ta.selectionStart ?? v.length;
    const ls0 = v.lastIndexOf("\n", pos - 1) + 1, le = v.indexOf("\n", pos), lineEnd = le < 0 ? v.length : le;
    const line = v.slice(ls0, lineEnd);
    let nv, caret;
    if (TODO.test(line)) { nv = v.slice(0, lineEnd) + "\n- [ ] " + v.slice(lineEnd); caret = lineEnd + 7; }
    else if (!line.trim()) { nv = v.slice(0, ls0) + "- [ ] " + v.slice(lineEnd); caret = ls0 + 6; }
    else { nv = v.slice(0, lineEnd) + "\n- [ ] " + v.slice(lineEnd); caret = lineEnd + 7; }
    ta.value = nv; ta.focus(); ta.setSelectionRange(caret, caret);
    ls.set("qn-draft", nv); grow(ta);
  });
  async function saveNew() {
    const text = ta.value.replace(/\s+$/, "");
    if (!text.trim()) { $("err").textContent = "Erst etwas schreiben"; ta.focus(); return; }
    const t = nowIso();
    const n = { id: uid("q"), text, created: t, updated: t, angeheftet: false };
    if (lastDetect) n.vorschlag = { date: lastDetect.date, start: lastDetect.start, end: "", title: lastDetect.title, cal: calOverride || lastDetect.cal, done: false };
    const btn = $("saveBtn");
    btn.classList.remove("done"); void btn.offsetWidth; btn.classList.add("done");
    clearTimeout(okTimer); okTimer = setTimeout(() => btn.classList.remove("done"), 600);
    ta.value = ""; ls.set("qn-draft", null); grow(ta); calOverride = null; updateChip();
    fresh.add(n.id);
    try { await enqueue("upsert", n, null); }
    catch (e) { ta.value = text; ls.set("qn-draft", text); btn.classList.remove("done"); toast({ title: "Nicht gespeichert", desc: "Bitte noch einmal sichern.", type: "err" }); return; }
    render();
  }
  $("saveBtn").addEventListener("click", saveNew);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNew(); }
    if (e.key === "Escape") { e.preventDefault(); closeCompose(); }
  });

  /* ---------- Schreiben im Vollbild ---------- */
  const cmp = $("cmp");
  function openCompose() {
    cmp.hidden = false;
    ta.focus({ preventScroll: true });          // noch im Tipp, damit iOS die Tastatur öffnet
    grow(ta); updateChip();
    requestAnimationFrame(() => cmp.classList.add("on"));
  }
  function closeCompose() {
    ta.blur(); cmp.classList.remove("on");
    setTimeout(() => { if (!cmp.classList.contains("on")) cmp.hidden = true; }, 260);
  }
  $("newBtn").addEventListener("click", openCompose);
  $("cmpClose").addEventListener("click", closeCompose);
  /* Tastaturhöhe messen, damit Leiste und Haken direkt darüber sitzen */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const kb = () => document.documentElement.style.setProperty("--kb", Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + "px");
    vv.addEventListener("resize", kb); vv.addEventListener("scroll", kb); kb();
  }

  /* ---------- Suche und Einklappen ---------- */
  $("q").addEventListener("input", (e) => { query = e.target.value; render(); });
  const pinSec = $("pinSec");
  if (ls.get("qn-pin-closed") === "1") { pinSec.classList.add("closed"); $("pinTog").setAttribute("aria-expanded", "false"); }
  $("pinTog").addEventListener("click", () => {
    const c = pinSec.classList.toggle("closed");
    $("pinTog").setAttribute("aria-expanded", String(!c)); ls.set("qn-pin-closed", c ? "1" : null);
  });

  /* ---------- Blatt (Notiz bearbeiten, Einstellungen) ---------- */
  let sheetMode = null, cur = null;
  function openSheet(title, html, mode) {
    sheetMode = mode;
    $("shT").textContent = title; $("shBody").innerHTML = html;
    $("shDone").hidden = mode !== "note";
    $("scrim").hidden = false; $("sheet").hidden = false;
    requestAnimationFrame(() => { $("scrim").classList.add("on"); $("sheet").classList.add("on"); });
  }
  function closeSheet() {
    sheetMode = null; cur = null;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    $("scrim").classList.remove("on"); $("sheet").classList.remove("on");
    setTimeout(() => { if (!sheetMode) { $("scrim").hidden = true; $("sheet").hidden = true; $("shBody").innerHTML = ""; } }, 380);
  }
  function openNote(id) {
    const n = notes.get(id); if (!n) return;
    cur = { id };
    let meta = '<div class="meta"><div>Erstellt ' + esc(longDate(n.created || n.updated)) + "</div>";
    if (n.vorschlag && n.vorschlag.date) meta += '<div style="display:flex;align-items:center;gap:8px"><i class="dot' + (n.vorschlag.cal === "claude" ? " claude" : "") + '"></i>' + (n.vorschlag.done ? "Im Kalender: " : "Termin-Vorschlag: ") + esc(terminLabel(n.vorschlag)) + "</div>";
    meta += '<div class="acts"><button type="button" class="sbtn" data-a="pin">' + (n.angeheftet ? "Lösen" : "Anheften") + '</button><button type="button" class="sbtn del" data-a="del">Löschen</button></div></div>';
    openSheet("Notiz", '<textarea id="edTa" aria-label="Notiz" autocapitalize="sentences">' + esc(n.text) + "</textarea>" + meta, "note");
  }
  async function finishNote() {
    if (!cur) { closeSheet(); return; }
    const n = notes.get(cur.id), el = $("edTa");
    if (n && el) {
      const text = el.value.replace(/\s+$/, "");
      if (!text.trim()) { closeSheet(); removeNote(n.id); return; }
      if (text !== n.text) {
        const upd = { ...n, text, updated: nowIso() };
        if (!n.vorschlag) { const d = detect(text); if (d) upd.vorschlag = { date: d.date, start: d.start, end: "", title: d.title, cal: d.cal, done: false }; }
        await enqueue("upsert", upd, n._m || null);
        render();
      }
    }
    closeSheet();
  }
  function openSettings() {
    const html = '<div class="set"><p>Quicknote schickt deine Notizen über dein privates GitHub-Repo <b>quicknote-inbox</b> an Second Brain. Dafür braucht die App einmalig deinen Zugangsschlüssel. Er bleibt nur auf diesem Gerät.</p>' +
      /* Als Passwort-Formular, damit iOS den Schlüssel im Schlüsselbund speichert und beim nächsten Mal anbietet */
      '<form id="tokForm" onsubmit="return false"><input type="text" name="username" autocomplete="username" value="Quicknote" hidden>' +
      '<label for="tok">Zugangsschlüssel</label><input class="field" id="tok" name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="github_pat_…" value="' + esc(token) + '">' +
      '<div class="row2"><button type="submit" class="sbtn" data-a="savetok">Sichern und prüfen</button></div></form>' +
      '<label>Stand</label><p>' + (mirrorAt ? "Zuletzt aus Second Brain: " + esc(longDate(mirrorAt)) : "Noch kein Abgleich aus Second Brain.") + "<br>Abgleich stündlich von " + SYNC_FIRST + " bis " + SYNC_LAST + " Uhr.</p></div>";
    openSheet("Einstellungen", html, "set");
  }
  async function saveToken(btn) {
    const v = ($("tok").value || "").trim();
    token = v; authBad = false;
    await DB.run(["kv"], (s) => { if (v) s("kv").put(v, "token"); else s("kv").delete("token"); });
    if (!v) { updatePill(); render(); return; }
    btn.textContent = "Prüfe …";
    let ok = false;
    try { const r = await fetch(API + "/issues?per_page=1", { headers: ghHeaders({ Accept: "application/vnd.github+json" }), cache: "no-store" }); ok = r.ok; if (r.status === 401 || r.status === 403 || r.status === 404) authBad = true; }
    catch (e) { toast({ title: "Kein Netz", desc: "Der Schlüssel ist gespeichert und wird geprüft, sobald du online bist." }); btn.textContent = "Sichern und prüfen"; return; }
    btn.textContent = "Sichern und prüfen";
    if (ok) { closeSheet(); toast({ title: "Verbunden", desc: "Notizen werden jetzt übertragen." }); flush(); pullMirror(); }
    else toast({ title: "Schlüssel funktioniert nicht", desc: "Prüfe Repo und Rechte (Issues: Lesen und Schreiben, Contents: Lesen).", type: "err" });
    render();
  }
  $("shBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const a = b.dataset.a;
    if (a === "pin" && cur) { const id = cur.id; finishNote().then(() => togglePin(id)); }
    else if (a === "del" && cur) { const id = cur.id; closeSheet(); removeNote(id); }
    else if (a === "savetok") saveToken(b);
  });
  $("shDone").addEventListener("click", finishNote);
  $("shClose").addEventListener("click", () => { if (sheetMode === "note") finishNote(); else closeSheet(); });
  $("scrim").addEventListener("click", () => { if (sheetMode === "note") finishNote(); else closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if (!sheetMode) return;
    if (e.key === "Escape") { e.preventDefault(); if (sheetMode === "note") finishNote(); else closeSheet(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && sheetMode === "note") { e.preventDefault(); finishNote(); }
  });
  /* Status-Symbol öffnet die Einstellungen (Schlüssel, Stand) */
  $("pill").addEventListener("click", () => {
    openSettings(); flush(); pullMirror(); return;
    const wait = [...outbox.values()].filter((o) => o.state === "wait").length;
    if (wait) toast({ title: wait === 1 ? "1 Notiz wartet" : wait + " Notizen warten", desc: navigator.onLine ? "Wird gerade übertragen." : "Wird übertragen, sobald du online bist." });
    else if ([...outbox.values()].some((o) => o.state === "sent")) toast({ title: "Übertragen", desc: "Kommt " + nextImport() + " in Second Brain." });
    else toast({ title: "Alles in Second Brain", desc: mirrorAt ? "Zuletzt abgeglichen: " + longDate(mirrorAt) : "Verbunden." });
    flush(); pullMirror();
  });

  /* ---------- Toast nach Sonner ---------- */
  function toast({ title, desc, type, action, duration }) {
    const box = $("toaster");
    for (const old of [...box.children]) { old.classList.remove("on"); setTimeout(() => old.remove(), 300); }
    const el = document.createElement("div");
    el.className = "toast" + (type === "err" ? " err" : "");
    el.setAttribute("role", type === "err" ? "alert" : "status");
    el.innerHTML = '<div class="tt">' + esc(title) + (desc ? "<small>" + esc(desc) + "</small>" : "") + "</div>" + (action ? '<button type="button">' + esc(action.label) + "</button>" : "");
    box.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
    let left = duration || (action ? 5000 : 3200), started = Date.now(), timer;
    const hide = () => { clearTimeout(timer); el.classList.remove("on"); setTimeout(() => el.remove(), 420); };
    const arm = () => { started = Date.now(); timer = setTimeout(hide, left); };
    el.addEventListener("pointerenter", () => { clearTimeout(timer); left -= Date.now() - started; });
    el.addEventListener("pointerleave", arm);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { clearTimeout(timer); left -= Date.now() - started; } else arm(); }, { once: true });
    if (action) el.querySelector("button").addEventListener("click", () => { hide(); action.fn(); });
    arm();
  }

  /* ---------- Start ---------- */
  async function start() {
    grow(ta); updateChip();
    try {
      const [ns, os, tok, mAt] = await Promise.all([DB.all("notes"), DB.all("outbox"), DB.get("kv", "token"), DB.get("kv", "mirrorAt")]);
      ns.forEach((n) => notes.set(n.id, n));
      os.forEach((o) => outbox.set(o.opId, o));
      token = tok || ""; mirrorAt = mAt || "";
    } catch (e) {
      toast({ title: "Speicher nicht verfügbar", desc: "Notizen können gerade nicht sicher gespeichert werden.", type: "err", duration: 8000 });
    }
    render();
    if (!token) setTimeout(openSettings, 400);
    flush(); pullMirror();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  window.addEventListener("online", () => { flush(); pullMirror(); });
  window.addEventListener("offline", updatePill);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { flush(); pullMirror(); render(); } });
  setInterval(() => { if (!document.hidden) flush(); }, 60000);
  setInterval(() => { if (!document.hidden) pullMirror(); }, 5 * 60000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  start();
})();
