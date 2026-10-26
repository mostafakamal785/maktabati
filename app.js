"use strict";
/* مكتبتي: a personal web-novel library that lives on the device (IndexedDB).
   No server and no account. Devices sync by exporting a file on one and importing it on the other. */

const STATUS = {reading:"أقرأ الآن", planned:"أنوي قراءتها", paused:"متوقفة", done:"مكتملة", dropped:"تركتها"};
const ORDER = ["reading","planned","paused","done","dropped"];
const PROGRESS_FIELDS = ["title","altTitle","url","chapter","total","status","rating","note","shelves","titleAr","descAr","deleted","customCover","links","lastChapterUrl","lastReadAt"];
const CATALOG_FIELDS = ["desc","genres","author","source"];
const $ = s => document.querySelector(s);
const KEY = s => (s||"").toLowerCase().replace(/[^a-z0-9؀-ۿ]/g,"");

let db, all = [], coverUrls = new Map(), detailKey = null, meta = {};
let view = {q:"", status:"all", shelves:[], genres:[], sort:"recent"};
try { Object.assign(view, JSON.parse(localStorage.getItem("view")||"{}"), {q:""}); } catch(e) {}

/* ---------- storage ---------- */
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open("maktabati", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("novels", {keyPath:"key"}); d.createObjectStore("covers"); d.createObjectStore("meta"); };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
// runs op on one store inside a single transaction; resolves with the request's result when the transaction commits
function idb(store, mode, op){
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode); const r = op(t.objectStore(store));
    t.oncomplete = () => res(r && "result" in r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const putNovels = list => idb("novels", "readwrite", s => { list.forEach(n => s.put(n)); });
const putCover = (k, blob) => idb("covers", "readwrite", s => s.put(blob, k));
const setMeta = (k, v) => { meta[k] = v; return idb("meta", "readwrite", s => s.put(v, k)); };

async function loadAll(){
  all = await idb("novels", "readonly", s => s.getAll());
  const keys = await idb("covers", "readonly", s => s.getAllKeys());
  const blobs = await idb("covers", "readonly", s => s.getAll());
  coverUrls.forEach(u => URL.revokeObjectURL(u)); coverUrls.clear();
  keys.forEach((k, i) => coverUrls.set(k, URL.createObjectURL(blobs[i])));
  const mk = await idb("meta", "readonly", s => s.getAllKeys());
  const mv = await idb("meta", "readonly", s => s.getAll());
  meta = {}; mk.forEach((k, i) => meta[k] = mv[i]);
}
const lib = () => all.filter(n => !n.deleted);
const find = k => k ? all.find(n => n.key === k || (n.aliases||[]).includes(k)) : null;

async function save(n, touch = true){
  if (touch) n.updatedAt = Date.now();
  await putNovels([n]);
  const i = all.findIndex(x => x.key === n.key); if (i >= 0) all[i] = n; else all.push(n);
  render();
}

/* ---------- small helpers ---------- */
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function btn(cls, text, fn, label){ const b = el("button", cls, text); b.type = "button"; if (fn) b.onclick = fn; if (label) b.setAttribute("aria-label", label); return b; }
function toast(t, action, fn){
  const box = $("#toast"); box.innerHTML = ""; const sp = el("span", "", t);
  if (action){ const b = btn("toast-act", action, () => { box.innerHTML = ""; fn(); }); sp.appendChild(b); }
  box.appendChild(sp); clearTimeout(toast.t); toast.t = setTimeout(() => box.innerHTML = "", action ? 6000 : 2400);
}
function ago(t){
  if (!t) return ""; const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return "اليوم"; if (d === 1) return "أمس"; if (d < 30) return "قبل " + d + " يوم";
  if (d < 365) return "قبل " + Math.floor(d / 30) + " شهر"; return "قبل " + Math.floor(d / 365) + " سنة";
}
function similar(a, b){
  if (a === b) return 1; const m = a.length, n = b.length; if (!m || !n) return 0;
  const d = Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++){ let p = d[0]; d[0] = i; for (let j = 1; j <= n; j++){ const t = d[j]; d[j] = Math.min(d[j] + 1, d[j-1] + 1, p + (a[i-1] === b[j-1] ? 0 : 1)); p = t; } }
  return 1 - d[n] / Math.max(m, n);
}
function saveView(){ try { localStorage.setItem("view", JSON.stringify({...view, q:""})); } catch(e) {} }
function coverNode(n, big){
  const box = el("div", "cover"); const url = coverUrls.get(n.key);
  if (url){ const im = document.createElement("img"); im.src = url; im.alt = ""; im.loading = "lazy"; box.appendChild(im); }
  else box.textContent = (n.title || "؟").trim().charAt(0).toUpperCase();
  if (big) box.style.cursor = "default";
  return box;
}
function allShelves(){ const s = new Set(meta.shelves || []); lib().forEach(n => (n.shelves||[]).forEach(x => s.add(x))); return [...s].sort((a, b) => a.localeCompare(b, "ar")); }
function allGenres(){ const s = new Map(); lib().forEach(n => (n.genres||[]).forEach(g => s.set(g, (s.get(g)||0) + 1))); return [...s].sort((a, b) => b[1] - a[1]); }

/* ---------- layers: novel page and sheets close with the phone's back button ---------- */
const layers = [];
function pushLayer(node, onClose){ $("#layer").appendChild(node); layers.push({node, onClose}); history.pushState({layer: layers.length}, ""); }
function back(steps){ steps = Math.min(typeof steps === "number" ? steps : 1, layers.length); if (steps) history.go(-steps); } // also used directly as a click handler
// one popstate can stand for several steps (history.go(-2)), so close down to the depth history now reports
window.addEventListener("popstate", e => {
  const depth = (e.state && e.state.layer) || 0;
  while (layers.length > depth){ const L = layers.pop(); L.node.remove(); if (L.onClose) L.onClose(); }
});

/* ---------- quick change: status and lists from the card, in one sheet ---------- */
function quickSheet(n){
  const f = sheet(n.title); f.querySelector("h2").dir = "auto";
  f.appendChild(el("p", "section-title", "الحالة"));
  const sg = el("div", "status-grid");
  ORDER.forEach(k => { const b = btn("status-opt s-" + k, STATUS[k], async () => { if (n.status !== k){ n.status = k; await save(n); toast("صارت «" + STATUS[k] + "»"); } back(); }); b.setAttribute("aria-pressed", n.status === k); sg.appendChild(b); });
  f.appendChild(sg);
  f.appendChild(el("p", "section-title", "القوائم"));
  const lg = el("div", "grid-opts");
  const paint = () => { lg.innerHTML = "";
    allShelves().forEach(s => { const on = (n.shelves||[]).includes(s); const b = btn("shelf-toggle", s, async () => { n.shelves = on ? n.shelves.filter(x => x !== s) : [...(n.shelves||[]), s]; await save(n); paint(); }); b.setAttribute("aria-pressed", on); lg.appendChild(b); });
    lg.appendChild(btn("shelf-toggle", "+ قائمة جديدة", () => newShelfSheet(n, paint))); };
  paint(); f.appendChild(lg);
  const acts = el("div", "acts"); acts.append(btn("btn", "صفحة الرواية", () => { back(); setTimeout(() => detail(n.key), 60); }), btn("btn", "تعديل", () => { back(); setTimeout(() => editSheet(n), 60); }));
  f.appendChild(acts);
}

/* ---------- multi-select: long-press a card, then change status or lists for all of them ---------- */
let sel = null, selBar = null;
function longPress(node, fn){
  let t = null, x = 0, y = 0;
  node.addEventListener("pointerdown", e => { x = e.clientX; y = e.clientY; t = setTimeout(() => { t = null; node.dataset.lp = "1"; if (navigator.vibrate) navigator.vibrate(15); fn(); }, 480); });
  const cancel = () => { if (t){ clearTimeout(t); t = null; } };
  node.addEventListener("pointerup", cancel); node.addEventListener("pointercancel", cancel); node.addEventListener("pointerleave", cancel);
  node.addEventListener("pointermove", e => { if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 12) cancel(); });
  // the click that ends a long-press must not also open the novel or toggle it again
  node.addEventListener("click", e => { if (node.dataset.lp){ delete node.dataset.lp; e.stopPropagation(); e.preventDefault(); } }, true);
  node.addEventListener("contextmenu", e => e.preventDefault());
}
function startSelect(k){
  sel = new Set(k ? [k] : []);
  selBar = el("div", "selbar");
  pushLayer(selBar, () => { sel = null; selBar = null; render(); });
  render();
}
function toggleSel(k){ if (sel.has(k)) sel.delete(k); else sel.add(k); const c = document.querySelector('.card[data-key="' + CSS.escape(k) + '"]'); if (c) c.classList.toggle("selected", sel.has(k)); updateSelBar(); }
function updateSelBar(){
  if (!selBar) return; selBar.innerHTML = ""; const inner = el("div", "inner");
  inner.appendChild(el("span", "sel-count", sel.size + " محددة"));
  const shown = [...document.querySelectorAll(".card[data-key]")].map(c => c.dataset.key);
  const acts = el("div", "acts");
  acts.append(
    btn("btn", shown.every(k => sel.has(k)) && shown.length ? "لا شيء" : "الكل", () => { const allOn = shown.every(k => sel.has(k)); shown.forEach(k => allOn ? sel.delete(k) : sel.add(k)); render(); }),
    Object.assign(btn("btn primary", "الحالة", bulkStatusSheet), {disabled: !sel.size}),
    Object.assign(btn("btn primary", "القوائم", bulkListsSheet), {disabled: !sel.size}),
    Object.assign(btn("btn danger", "حذف", bulkDelete), {disabled: !sel.size}),
    btn("btn", "إلغاء", () => back()));
  inner.appendChild(acts); selBar.appendChild(inner);
}
const picked = () => lib().filter(n => sel && sel.has(n.key));
function bulkStatusSheet(){
  const f = sheet("حالة " + sel.size + " رواية"); const sg = el("div", "status-grid");
  ORDER.forEach(k => sg.appendChild(btn("status-opt s-" + k, STATUS[k], async () => {
    const now = Date.now(); const list = picked(); list.forEach(n => { n.status = k; n.updatedAt = now; });
    await putNovels(list); back(2); toast(list.length + " رواية صارت «" + STATUS[k] + "»");
  })));
  f.appendChild(sg);
}
function bulkListsSheet(){
  const f = sheet("قوائم " + sel.size + " رواية");
  f.appendChild(el("p", "small", "اضغط قائمة لإضافة كل المحدد إليها، واضغطها مرة أخرى لإخراجه منها."));
  const lg = el("div", "list-opt");
  const paint = () => { lg.innerHTML = ""; const list = picked();
    allShelves().forEach(s => { const c = list.filter(n => (n.shelves||[]).includes(s)).length; const all = c === list.length;
      const b = btn("opt", ""); b.append(el("span", "", s), el("span", "", all ? "كلها فيها ✓" : c ? c + " من " + list.length : "")); b.setAttribute("aria-pressed", all);
      b.onclick = async () => { const now = Date.now(); list.forEach(n => { n.shelves = all ? (n.shelves||[]).filter(x => x !== s) : [...new Set([...(n.shelves||[]), s])]; n.updatedAt = now; }); await putNovels(list); render(); paint(); };
      lg.appendChild(b); });
    lg.appendChild(btn("btn", "+ قائمة جديدة", () => newShelfSheet(null, paint))); };
  paint(); f.appendChild(lg);
  const acts = el("div", "acts"); acts.append(btn("btn primary", "تم", () => back(2))); f.appendChild(acts);
}
function bulkDelete(){
  const f = sheet("حذف " + sel.size + " رواية");
  f.appendChild(el("p", "sub", "ستُحذف من هذا الجهاز، وينتقل الحذف إلى جهازك الآخر عند المزامنة."));
  const acts = el("div", "acts"); acts.append(btn("btn danger", "احذفها", async () => {
    const now = Date.now(); const list = picked(); list.forEach(n => { n.deleted = true; n.updatedAt = now; }); await putNovels(list); back(2); toast("حُذفت " + list.length + " رواية");
  }), btn("btn", "إلغاء", () => back())); f.appendChild(acts);
}
function sheet(title){
  const wrapper = el("div"); const scrim = el("div", "scrim"); scrim.onclick = back;
  const sh = el("div", "sheet"); sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true");
  const inner = el("div", "inner"); inner.appendChild(el("h2", "", title)); sh.appendChild(inner);
  wrapper.append(scrim, sh); pushLayer(wrapper); return inner;
}

/* ---------- progress ---------- */
async function bump(n, d){
  n.chapter = Math.max(0, (Number(n.chapter) || 0) + d);
  if (d > 0 && n.total > 0 && n.chapter >= n.total) n.status = "done";
  else if (d > 0 && n.status !== "reading" && n.status !== "done") n.status = "reading";
  n.lastReadAt = Date.now();
  await save(n);
}

/* ---------- library list ---------- */
function filtered(skipStatus){
  const q = view.q.trim().toLowerCase();
  return lib().filter(n => {
    if (!skipStatus && view.status !== "all" && n.status !== view.status) return false;
    if (view.shelves.length && !view.shelves.every(s => (n.shelves||[]).includes(s))) return false;
    if (view.genres.length && !view.genres.some(g => (n.genres||[]).includes(g))) return false;
    if (q){ const hay = [n.title, n.altTitle, n.titleAr, n.desc, n.descAr, n.author, n.note, (n.genres||[]).join(" "), (n.shelves||[]).join(" ")].join(" ").toLowerCase(); if (!hay.includes(q)) return false; }
    return true;
  });
}
const SORTS = {
  recent: (a, b) => (b.updatedAt||0) - (a.updatedAt||0),
  name: (a, b) => (a.title||"").localeCompare(b.title||"", "ar"),
  rating: (a, b) => (b.rating||0) - (a.rating||0) || (b.updatedAt||0) - (a.updatedAt||0),
  progress: (a, b) => (b.total ? b.chapter / b.total : -1) - (a.total ? a.chapter / a.total : -1),
  left: (a, b) => (a.total ? a.total - a.chapter : 1e9) - (b.total ? b.total - b.chapter : 1e9),
  added: (a, b) => (b.createdAt||0) - (a.createdAt||0),
};
function render(){
  const base = filtered(true);
  const chips = $("#statusChips"); chips.innerHTML = "";
  [["all", "الكل", base.length], ...ORDER.map(k => [k, STATUS[k], base.filter(n => n.status === k).length])].forEach(([k, label, c]) => {
    if (k !== "all" && !c && view.status !== k) return;
    const b = btn("chip", label + " " + c, () => { view.status = k; saveView(); render(); });
    b.setAttribute("aria-pressed", view.status === k); chips.appendChild(b);
  });
  $("#count").textContent = lib().length ? lib().length + " رواية" : "";
  // lists bar: one tap shows a list, a second tap on it goes back to everything
  const lc = $("#listChips"); lc.innerHTML = ""; const lists = allShelves();
  lc.hidden = !lib().length;
  const allBtn = btn("chip list", "كل الروايات", () => { view.shelves = []; saveView(); render(); }); allBtn.setAttribute("aria-pressed", !view.shelves.length); lc.appendChild(allBtn);
  lists.forEach(s => { const on = view.shelves.includes(s);
    const b = btn("chip list", s + " " + lib().filter(n => (n.shelves||[]).includes(s)).length, () => { view.shelves = on && view.shelves.length === 1 ? [] : [s]; saveView(); render(); });
    b.setAttribute("aria-pressed", on); lc.appendChild(b); });
  lc.appendChild(btn("chip list add", "+ قائمة", () => newShelfSheet(null)));
  const nf = view.genres.length;
  $("#filterBtn").textContent = nf ? "الأنواع (" + nf + ")" : "الأنواع"; $("#filterBtn").classList.toggle("on", !!nf);
  $("#sort").value = view.sort;
  const af = $("#activeFilters"); af.innerHTML = ""; af.hidden = !nf;
  view.genres.forEach(g => af.appendChild(btn("af", g + " ✕", () => { view.genres = view.genres.filter(x => x !== g); saveView(); render(); })));
  document.body.classList.toggle("selecting", !!sel);
  if (sel) updateSelBar();

  const list = $("#list"); list.innerHTML = "";
  if (!lib().length){
    const e = el("div", "empty"); e.append(el("b", "", "مكتبتك فارغة"),
      el("span", "", "استورد ملف البداية «مكتبتي_بداية.json» أو ملف مزامنة من جهازك الآخر، أو أضف أول رواية بيدك."),
      btn("btn primary", "استيراد ملف", () => $("#fileIn").click()), btn("btn", "إضافة رواية", () => editSheet(null)));
    list.appendChild(e);
  } else {
    const shown = (view.status === "all" ? base : base.filter(n => n.status === view.status)).sort(SORTS[view.sort] || SORTS.recent);
    if (!shown.length){ const e = el("div", "empty"); e.append(el("b", "", "لا نتائج"), el("span", "", "غيّر البحث أو الحالة أو القائمة.")); list.appendChild(e); }
    if (!view.q && view.status === "all" && !view.shelves.length && !view.genres.length && !sel) list.appendChild(recentStrip());
    const frag = document.createDocumentFragment(); shown.forEach(n => frag.appendChild(card(n))); list.appendChild(frag);
  }
  if (detailKey) drawDetail();
}
function card(n){
  const c = el("article", "card"); c.dataset.key = n.key;
  if (sel && sel.has(n.key)) c.classList.add("selected");
  const openOrPick = () => sel ? toggleSel(n.key) : detail(n.key);
  const cv = btn("cover", "", openOrPick, "تفاصيل " + n.title); cv.appendChild(coverNode(n).firstChild || document.createTextNode((n.title||"؟").charAt(0)));
  const body = el("div", "body");
  const open = btn("open", "", openOrPick); const h = el("h3", "title", n.title || "بدون اسم"); h.dir = "auto"; open.appendChild(h);
  if (n.titleAr) open.appendChild(el("p", "sub", n.titleAr));
  const badge = btn("badge s-" + n.status, (STATUS[n.status] || "") + " ▾", () => sel ? toggleSel(n.key) : quickSheet(n), "تغيير الحالة والقوائم");
  const r1 = el("div", "row1"); r1.append(open, badge); body.appendChild(r1);
  longPress(c, () => { if (!sel) startSelect(n.key); });
  body.appendChild(progress(n));
  const a = el("div", "acts");
  a.append(btn("btn primary plus", "+1 فصل", () => bump(n, 1)), Object.assign(btn("btn minus", "−1", () => bump(n, -1), "تراجع فصل"), {dir: "ltr"}));
  const go = readLink(n); if (go){ const l = el("a", "btn", n.lastChapterUrl ? "أكمل" : "فتح"); l.href = go; l.target = "_blank"; l.rel = "noopener"; a.appendChild(l); }
  body.appendChild(a);
  const m = el("div", "meta");
  if (n.rating > 0) m.appendChild(el("span", "stars", "★".repeat(n.rating) + "☆".repeat(5 - n.rating)));
  (n.shelves||[]).slice(0, 3).forEach(s => m.appendChild(el("span", "tag shelf", s)));
  if (n.lastReadAt || n.updatedAt) m.appendChild(el("span", "", "آخر تحديث " + ago(n.lastReadAt || n.updatedAt)));
  if (m.childNodes.length) body.appendChild(m);
  c.append(cv, body); return c;
}
function progress(n){
  const p = el("div", "prog"); const num = el("div", "num", String(n.chapter || 0));
  num.appendChild(el("small", "", n.total ? "من " + n.total : "فصل")); p.appendChild(num);
  if (n.total > 0){ const b = el("div", "bar"); const i = document.createElement("i"); i.style.width = Math.min(100, Math.round((n.chapter||0) / n.total * 100)) + "%"; b.appendChild(i); p.appendChild(b); }
  return p;
}

/* ---------- chapter links: share from the browser, paste a link, continue reading ---------- */
// a novel's id on a reading site, from any of its links: novelbin:<slug>, novelping:<slug>, webnovel:<number>
function linkId(u){
  try {
    const x = new URL(u); const site = x.hostname.replace(/^(www|m)\./, "").split(".")[0];
    const m = x.pathname.match(/^\/(?:b|book|novel|series|n)\/([^\/?#]+)/i); if (!m) return null;
    let id = decodeURIComponent(m[1]).toLowerCase(); const num = id.match(/(\d{8,})$/); if (num) id = num[1];
    return site + ":" + id;
  } catch(e){ return null; }
}
function chapterNum(...parts){
  for (const raw of parts){
    if (!raw) continue; let s = String(raw); try { s = decodeURIComponent(s); } catch(e) {}
    const m = s.match(/chapter[\s\-_:]*(\d{1,5})/i) || s.match(/(?:الفصل|فصل)\s*(\d{1,5})/) || s.match(/\bch(?:ap)?[.\-_ ]?(\d{1,5})\b/i);
    if (m) return +m[1];
  }
  return 0;
}
const readLink = n => n.lastChapterUrl || n.url || "";
function idsOf(n){ return new Set([...(n.links||[]), linkId(n.url), linkId(n.lastChapterUrl)].filter(Boolean)); }
function matchNovel(url, words){
  const id = linkId(url);
  if (id){
    const hit = lib().find(n => idsOf(n).has(id)); if (hit) return hit;
    // novelbin and novelping share title-based slugs, so a slug can name the novel on any site
    const slug = id.split(":")[1];
    if (!/^\d+$/.test(slug)){
      const byKey = find(KEY(slug)); if (byKey && !byKey.deleted) return byKey;
      const bySlug = lib().find(n => [...idsOf(n)].some(x => x.split(":")[1] === slug)); if (bySlug) return bySlug;
    }
  }
  // fall back to the novel's name inside the shared page title
  const k = KEY(words); if (k.length < 6) return null;
  let best = null;
  lib().forEach(n => [n.title, n.altTitle].filter(Boolean).forEach(t => { const tk = KEY(t); if (tk.length >= 6 && k.includes(tk) && (!best || tk.length > best[1])) best = [n, tk.length]; }));
  return best ? best[0] : null;
}
async function applyChapter(n, ch, url){
  const before = {chapter: n.chapter, status: n.status, lastChapterUrl: n.lastChapterUrl, lastReadAt: n.lastReadAt};
  n.chapter = ch;
  if (n.total > 0 && ch >= n.total) n.status = "done"; else if (n.status !== "reading") n.status = "reading";
  if (url){ n.lastChapterUrl = url; const id = linkId(url); if (id && !(n.links||[]).includes(id)) n.links = [...(n.links||[]), id]; }
  n.lastReadAt = Date.now(); await save(n);
  toast("«" + n.title + "» على الفصل " + ch, "تراجع", async () => { Object.assign(n, before); await save(n); toast("أُعيد كما كان"); });
}
async function handleLink({url = "", title = "", text = ""}){
  if (!url){ const m = (text + " " + title).match(/https?:\/\/[^\s]+/); url = m ? m[0] : ""; }
  const ch = chapterNum(url, title, text); const n = matchNovel(url, title + " " + text);
  if (n && ch){ await applyChapter(n, ch, url); return; }
  linkSheet(url, ch, title || text, n);
}
// when the link did not identify the novel or the chapter, ask once and remember the link for next time
function linkSheet(url, ch, title, guess){
  const f = sheet("تحديث من رابط");
  if (url){ const u = el("p", "small", url); u.dir = "ltr"; u.style.overflowWrap = "anywhere"; f.appendChild(u); }
  const chIn = document.createElement("input"); chIn.type = "number"; chIn.min = 0; chIn.inputMode = "numeric"; chIn.value = ch || "";
  const l1 = el("label", "f", ch ? "رقم الفصل" : "رقم الفصل (لم أجده في الرابط، اكتبه)"); l1.appendChild(chIn); f.appendChild(l1);
  const q = document.createElement("input"); q.type = "search"; q.placeholder = "ابحث عن الرواية في مكتبتك";
  q.value = guess ? guess.title : (title || "").replace(/(chapter|ch\.?|الفصل)[\s\S]*$/i, "").replace(/[|\-–—:]+\s*$/, "").trim().slice(0, 60);
  const l2 = el("label", "f", "أي رواية؟"); l2.appendChild(q); f.appendChild(l2);
  const box = el("div", "list-opt"); f.appendChild(box);
  const pick = async n => { const c = parseInt(chIn.value) || 0; if (!c){ chIn.focus(); return; } back(); await applyChapter(n, c, url); };
  const paint = () => {
    box.innerHTML = ""; const k = KEY(q.value);
    const score = n => { if (!k) return 0; const t = KEY(n.title); return Math.max(similar(t, k), t.includes(k) ? 0.95 : 0, k.includes(t) && t.length > 5 ? 0.9 : 0); };
    lib().map(n => [n, score(n)]).sort((a, b) => b[1] - a[1] || (b[0].lastReadAt||0) - (a[0].lastReadAt||0)).slice(0, 6)
      .forEach(([n]) => { const b = btn("opt", ""); const t = el("span", "", n.title); t.dir = "auto"; b.append(t, el("span", "", "فصل " + (n.chapter||0))); b.onclick = () => pick(n); box.appendChild(b); });
    if (q.value.trim()) box.appendChild(btn("btn", "أضفها كرواية جديدة: " + q.value.trim().slice(0, 40), async () => {
      const c = parseInt(chIn.value) || 0; const t = q.value.trim(); const k2 = KEY(t); if (!k2) return;
      if (find(k2) && !find(k2).deleted){ pick(find(k2)); return; }
      const now = Date.now();
      const n = {key: k2, aliases: [], title: t, altTitle: "", url: "", chapter: 0, total: 0, status: "reading", rating: 0, note: "", shelves: [], genres: [], author: "", desc: "", source: "", createdAt: now, updatedAt: now};
      back(); await save(n); await applyChapter(n, c, url);
    }));
  };
  q.addEventListener("input", paint); paint();
}
function pasteSheet(n){
  const f = sheet(n ? "تحديث «" + n.title + "» من رابط" : "لصق رابط فصل");
  f.appendChild(el("p", "small", "الصق رابط الفصل الذي وصلت إليه، وسأقرأ رقم الفصل والرواية منه."));
  const i = document.createElement("input"); i.type = "url"; i.dir = "ltr"; i.placeholder = "https://…";
  const l = el("label", "f", "الرابط"); l.appendChild(i); f.appendChild(l);
  const go = async () => {
    const u = i.value.trim(); if (!u) return; back();
    if (n){ const c = chapterNum(u); if (c) await applyChapter(n, c, u); else setTimeout(() => linkSheet(u, 0, "", n), 60); }
    else setTimeout(() => handleLink({url: u}), 60);
  };
  const acts = el("div", "acts");
  const paste = btn("btn", "لصق", async () => { try { i.value = (await navigator.clipboard.readText()).trim(); if (i.value) go(); } catch(e){ i.focus(); toast("الصق الرابط بنفسك في الخانة"); } });
  acts.append(paste, btn("btn primary", "تحديث", go)); f.appendChild(acts);
  i.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
}
function recentStrip(){
  const wrap = el("section", "recent");
  const items = lib().filter(n => n.lastReadAt && n.status === "reading").sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, 8);
  if (!items.length){ wrap.hidden = true; return wrap; }
  wrap.appendChild(el("p", "section-title", "أكمل من حيث توقفت"));
  const row = el("div", "recent-row");
  items.forEach(n => {
    const go = readLink(n); const a = el(go ? "a" : "button", "recent-item");
    if (go){ a.href = go; a.target = "_blank"; a.rel = "noopener"; } else { a.type = "button"; a.onclick = () => detail(n.key); }
    a.appendChild(coverNode(n)); const t = el("span", "recent-title", n.title); t.dir = "auto"; a.appendChild(t);
    a.appendChild(el("span", "recent-ch", "الفصل " + (n.chapter || 0)));
    row.appendChild(a);
  });
  wrap.appendChild(row); return wrap;
}

/* ---------- novel page ---------- */
let showAr = {}, trBusy = {};
function detail(k){
  detailKey = k; const page = el("div", "page"); page.id = "page"; page.setAttribute("role", "dialog"); page.setAttribute("aria-modal", "true");
  pushLayer(page, () => { detailKey = null; }); drawDetail();
}
function drawDetail(){
  const page = document.getElementById("page"); const n = find(detailKey);
  if (!page) return; if (!n || n.deleted){ back(); return; }
  const keep = page.scrollTop; page.innerHTML = ""; const w = el("div", "inner"); page.appendChild(w);
  const top = el("div", "p-top"); top.append(btn("btn", "رجوع", back), btn("btn", "تعديل", () => editSheet(n))); w.appendChild(top);
  const head = el("div", "p-head"); head.appendChild(coverNode(n, true));
  const ht = el("div", "body");
  const t = el("h2", "p-title", n.title); t.dir = "auto"; ht.appendChild(t);
  if (n.altTitle){ const s = el("p", "sub", n.altTitle); s.dir = "auto"; ht.appendChild(s); }
  if (n.titleAr) ht.appendChild(el("p", "p-title-ar", n.titleAr));
  if (n.author) ht.appendChild(el("p", "sub", "المؤلف: " + n.author));
  if ((n.genres||[]).length){ const tg = el("div", "tags"); n.genres.forEach(g => tg.appendChild(el("span", "tag", g))); ht.appendChild(tg); }
  const st = el("span", "badge s-" + n.status, STATUS[n.status]); st.style.alignSelf = "flex-start"; ht.appendChild(st);
  if (n.rating > 0) ht.appendChild(el("span", "stars", "★".repeat(n.rating) + "☆".repeat(5 - n.rating)));
  head.appendChild(ht); w.appendChild(head);
  w.appendChild(progress(n));
  const a = el("div", "acts");
  a.append(btn("btn primary plus", "+1 فصل", () => bump(n, 1)), Object.assign(btn("btn minus", "−1", () => bump(n, -1), "تراجع فصل"), {dir: "ltr"}));
  if (n.lastChapterUrl){ const l = el("a", "btn", "أكمل القراءة"); l.href = n.lastChapterUrl; l.target = "_blank"; l.rel = "noopener"; a.appendChild(l); }
  if (n.url){ const l = el("a", "btn", "صفحة الرواية"); l.href = n.url; l.target = "_blank"; l.rel = "noopener"; a.appendChild(l); }
  a.appendChild(btn("btn", "تحديث من رابط", () => pasteSheet(n)));
  w.appendChild(a);
  // quick status change
  const sr = el("div", "grid-opts"); ORDER.forEach(k => { const b = btn("shelf-toggle", STATUS[k], async () => { n.status = k; await save(n); }); b.setAttribute("aria-pressed", n.status === k); sr.appendChild(b); });
  w.append(el("p", "h3", "الحالة"), sr);
  // shelves
  const sh = el("div", "grid-opts");
  allShelves().forEach(s => { const on = (n.shelves||[]).includes(s); const b = btn("shelf-toggle", s, async () => { n.shelves = on ? n.shelves.filter(x => x !== s) : [...(n.shelves||[]), s]; await save(n); }); b.setAttribute("aria-pressed", on); sh.appendChild(b); });
  sh.appendChild(btn("shelf-toggle", "+ قائمة جديدة", () => newShelfSheet(n)));
  w.append(el("p", "h3", "القوائم"), sh);
  // description + translation
  const dr = el("div", "p-top"); dr.appendChild(el("p", "h3", "الوصف"));
  const ar = !!showAr[n.key] && !!n.descAr;
  if (n.descAr){ const seg = el("div", "seg"); [["الأصل", false], ["العربية", true]].forEach(([lb, v]) => { const b = btn("", lb, () => { showAr[n.key] = v; drawDetail(); }); b.setAttribute("aria-pressed", ar === v); seg.appendChild(b); }); dr.appendChild(seg); }
  w.appendChild(dr);
  const body = el("p", "p-desc", ar ? n.descAr : (n.desc || "لا يوجد وصف لهذه الرواية.")); body.dir = ar || !n.desc ? "rtl" : "ltr"; w.appendChild(body);
  if (!n.descAr || !n.titleAr){
    const tr = el("div", "acts");
    const b = btn("btn", trBusy[n.key] ? "جارٍ الترجمة…" : "ترجمة الاسم والوصف", () => translate(n)); b.disabled = !!trBusy[n.key];
    const g = el("a", "btn", "ترجمة Google"); g.target = "_blank"; g.rel = "noopener";
    g.href = "https://translate.google.com/?sl=auto&tl=ar&op=translate&text=" + encodeURIComponent((n.title + "\n\n" + (n.desc||"")).slice(0, 4500));
    tr.append(b, g); w.appendChild(tr);
  }
  if (n.note){ w.append(el("p", "h3", "ملاحظتي"), el("p", "sub", n.note)); }
  const info = [];
  if (n.source) info.push("مصدر الوصف والغلاف: " + n.source);
  if (n.createdAt) info.push("أضيفت " + ago(n.createdAt));
  if (info.length) w.appendChild(el("p", "small", info.join(" · ")));
  page.scrollTop = keep;
}

/* ---------- free translation (MyMemory, no key; result is saved so each novel is translated once) ---------- */
async function mt(text){
  const parts = []; let cur = "";
  for (const s of text.split(/(?<=[.!?…])\s+|\n+/)){ if ((cur + " " + s).length > 450 && cur){ parts.push(cur); cur = s; } else cur = cur ? cur + " " + s : s; }
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts){
    const r = await fetch("https://api.mymemory.translated.net/get?langpair=en|ar&q=" + encodeURIComponent(p));
    const j = await r.json();
    if (j.responseStatus != 200 || /MYMEMORY WARNING/i.test(j.responseData?.translatedText || "")) throw new Error("quota");
    out.push(j.responseData.translatedText);
  }
  return out.join(" ");
}
async function translate(n){
  if (!navigator.onLine){ toast("الترجمة تحتاج إنترنت"); return; }
  trBusy[n.key] = true; drawDetail();
  try {
    if (!n.titleAr) n.titleAr = await mt(n.title);
    if (!n.descAr && n.desc) n.descAr = await mt(n.desc);
    showAr[n.key] = true; await save(n, false); await putNovels([n]);
  } catch(e){ toast(e.message === "quota" ? "انتهت الترجمات المجانية لليوم، استخدم ترجمة Google" : "تعذّرت الترجمة، حاول لاحقًا"); }
  trBusy[n.key] = false; drawDetail();
}

/* ---------- add / edit ---------- */
function editSheet(n){
  const isNew = !n; const d = n ? {...n} : {title:"", url:"", chapter:0, total:0, status:"planned", rating:0, note:"", shelves:[]};
  const f = sheet(isNew ? "رواية جديدة" : "تعديل الرواية");
  const field = (label, input) => { const l = el("label", "f", label); l.appendChild(input); return l; };
  const inp = (type, val, extra = {}) => { const i = document.createElement("input"); i.type = type; i.value = val ?? ""; Object.assign(i, extra); return i; };
  const title = inp("text", d.title, {required: true, autocomplete: "off"}), alt = inp("text", d.altTitle || "");
  const url = inp("url", d.url, {placeholder: "https://", inputMode: "url"}); url.dir = "ltr";
  const ch = inp("number", d.chapter || 0, {min: 0, inputMode: "numeric"}), tot = inp("number", d.total || "", {min: 0, inputMode: "numeric", placeholder: "إن عرفته"});
  const st = document.createElement("select"); ORDER.forEach(k => { const o = el("option", "", STATUS[k]); o.value = k; st.appendChild(o); }); st.value = d.status;
  const note = document.createElement("textarea"); note.rows = 2; note.value = d.note || "";
  const desc = document.createElement("textarea"); desc.rows = 3; desc.value = d.desc || ""; desc.dir = "auto";
  let rating = d.rating || 0; const stars = el("div", "stars-in");
  const paint = () => { stars.innerHTML = ""; for (let i = 1; i <= 5; i++){ const b = btn(i <= rating ? "on" : "", "★", () => { rating = rating === i ? 0 : i; paint(); }, i + " من 5"); stars.appendChild(b); } }; paint();
  let shelves = [...(d.shelves||[])]; const shBox = el("div", "grid-opts");
  const paintSh = () => { shBox.innerHTML = ""; allShelves().concat(shelves.filter(s => !allShelves().includes(s))).forEach(s => { const on = shelves.includes(s); const b = btn("shelf-toggle", s, () => { shelves = on ? shelves.filter(x => x !== s) : [...shelves, s]; paintSh(); }); b.setAttribute("aria-pressed", on); shBox.appendChild(b); }); }; paintSh();
  let newCover = null; const coverBtn = btn("btn", "اختيار غلاف من الجهاز", () => { $("#coverIn").onchange = async e => { const file = e.target.files[0]; e.target.value = ""; if (file){ newCover = await shrink(file); coverBtn.textContent = "تم اختيار الغلاف ✓"; } }; $("#coverIn").click(); });
  const two1 = el("div", "two"); two1.append(field("آخر فصل قرأته", ch), field("عدد الفصول الكلي", tot));
  f.append(field("اسم الرواية", title), field("اسم آخر (اختياري)", alt), field("الرابط (اختياري)", url), two1, field("الحالة", st));
  const rl = el("div", "f", "تقييمك"); rl.appendChild(stars); f.appendChild(rl);
  const sl = el("div", "f", "القوائم"); sl.appendChild(shBox); f.appendChild(sl);
  f.append(field("الوصف", desc), field("ملاحظة", note), coverBtn);
  const warn = el("p", "small"); warn.hidden = true; f.appendChild(warn);
  let forceAdd = false;
  const saveBtn = btn("btn primary", "حفظ", async () => {
    const t = title.value.trim(); if (!t){ title.focus(); return; }
    if (isNew){
      const k = KEY(t), ex = find(k);
      if (ex && !ex.deleted){ warn.hidden = false; warn.textContent = "هذه الرواية موجودة في مكتبتك."; return; }
      const near = !forceAdd && lib().map(x => [x, similar(KEY(x.title), k)]).sort((a, b) => b[1] - a[1])[0];
      if (near && near[1] >= 0.85){ warn.hidden = false; warn.textContent = "تشبه رواية موجودة: «" + near[0].title + "». اضغط حفظ مرة أخرى لإضافتها على أي حال."; forceAdd = true; return; }
    }
    const rec = isNew ? {key: KEY(t), aliases: [], createdAt: Date.now(), genres: [], author: "", source: ""} : n;
    Object.assign(rec, {title: t, altTitle: alt.value.trim(), url: url.value.trim(), chapter: Math.max(0, parseInt(ch.value) || 0),
      total: Math.max(0, parseInt(tot.value) || 0), status: st.value, rating, note: note.value.trim(), shelves, desc: desc.value.trim(), deleted: false});
    if (rec.total > 0 && rec.chapter >= rec.total && rec.status === "reading") rec.status = "done";
    if (newCover){ await putCover(rec.key, newCover); coverUrls.set(rec.key, URL.createObjectURL(newCover)); rec.customCover = true; }
    back(); await save(rec); toast("تم الحفظ");
  });
  const acts = el("div", "acts"); acts.append(saveBtn, btn("btn", "إلغاء", back)); f.appendChild(acts);
  if (!isNew){
    const del = btn("btn danger", "حذف الرواية", async () => {
      if (!del.dataset.sure){ del.dataset.sure = 1; del.textContent = "اضغط مرة أخرى للتأكيد"; return; }
      back(); n.deleted = true; await save(n); toast("تم الحذف");
    });
    f.appendChild(del);
  }
  if (isNew) setTimeout(() => title.focus(), 60);
}
async function shrink(file){
  const img = await createImageBitmap(file); const s = Math.min(1, 320 / img.height, 240 / img.width);
  const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/webp", 0.75));
}
function newShelfSheet(n, after){
  const f = sheet("قائمة جديدة"); const i = document.createElement("input"); i.placeholder = "مثل: المفضلة، أعيد قراءتها، نظام، زراعة، للعطلة";
  const l = el("label", "f", "اسم القائمة"); l.appendChild(i); f.appendChild(l);
  const add = async () => {
    const s = i.value.trim(); if (!s) return;
    await setMeta("shelves", [...new Set([...(meta.shelves||[]), s])]);
    if (n && !(n.shelves||[]).includes(s)){ n.shelves = [...(n.shelves||[]), s]; back(); await save(n); } else { back(); render(); }
    if (after) after();
  };
  i.addEventListener("keydown", e => { if (e.key === "Enter") add(); });
  const acts = el("div", "acts"); acts.append(btn("btn primary", "إضافة", add), btn("btn", "إلغاء", back)); f.appendChild(acts);
  setTimeout(() => i.focus(), 60);
}

/* ---------- categories filter ---------- */
function filterSheet(){
  const f = sheet("الأنواع والقوائم");
  const paint = () => {
    f.querySelectorAll(".dyn").forEach(x => x.remove());
    const add = node => { node.classList.add("dyn"); f.appendChild(node); };
    add(el("p", "section-title", "قوائمي"));
    const sh = el("div", "list-opt");
    const shelves = allShelves();
    if (!shelves.length) sh.appendChild(el("p", "small", "لا قوائم بعد. أنشئ قائمة من شريط القوائم أو من أي رواية."));
    shelves.forEach(s => { const c = lib().filter(n => (n.shelves||[]).includes(s)).length; const on = view.shelves.includes(s);
      const b = btn("opt", ""); b.append(el("span", "", s), el("span", "", c)); b.setAttribute("aria-pressed", on);
      b.onclick = () => { view.shelves = on ? view.shelves.filter(x => x !== s) : [...view.shelves, s]; saveView(); render(); paint(); }; sh.appendChild(b); });
    add(sh);
    add(el("p", "section-title", "النوع"));
    const gr = el("div", "grid-opts");
    allGenres().forEach(([g, c]) => { const on = view.genres.includes(g); const b = btn("shelf-toggle", g + " " + c, () => { view.genres = on ? view.genres.filter(x => x !== g) : [...view.genres, g]; saveView(); render(); paint(); }); b.setAttribute("aria-pressed", on); gr.appendChild(b); });
    add(gr);
    const acts = el("div", "acts"); acts.append(btn("btn primary", "عرض النتائج", back), btn("btn", "مسح الاختيار", () => { view.shelves = []; view.genres = []; saveView(); render(); paint(); }));
    add(acts);
  };
  paint();
}

/* ---------- menu: stats, sync, bulk add, shelves ---------- */
function menuSheet(){
  const f = sheet("القائمة");
  const L = lib(); const read = L.reduce((s, n) => s + (Number(n.chapter) || 0), 0);
  f.appendChild(el("p", "sub", L.length + " رواية · " + ORDER.map(k => [STATUS[k], L.filter(n => n.status === k).length]).filter(x => x[1]).map(x => x[0] + " " + x[1]).join(" · ") + " · " + read.toLocaleString("ar") + " فصل مقروء"));
  f.appendChild(el("p", "section-title", "المزامنة بين الجوال والكمبيوتر"));
  f.appendChild(el("p", "small", "صدّر ملفًا من جهاز، وانقله بأي طريقة، ثم استورده في الجهاز الآخر. الدمج يأخذ الأحدث لكل رواية ولا يكرر شيئًا."
    + (meta.lastExport ? " آخر تصدير: " + ago(meta.lastExport) + "." : "")));
  const a1 = el("div", "acts"); a1.append(btn("btn primary", "تصدير ملف المزامنة", () => { back(); exportSync(); }), btn("btn", "استيراد ملف", () => { back(); $("#fileIn").click(); })); f.appendChild(a1);
  f.appendChild(el("p", "section-title", "إضافة وتنظيم"));
  const a2 = el("div", "acts"); a2.append(btn("btn", "إضافة عدة روايات", () => { back(); setTimeout(bulkSheet, 50); }), btn("btn", "إدارة القوائم", () => { back(); setTimeout(shelvesSheet, 50); })); f.appendChild(a2);
  f.appendChild(el("p", "small", "البيانات محفوظة في هذا الجهاز فقط" + (meta.persisted ? "، والمتصفح لن يمسحها تلقائيًا." : ". صدّر ملفًا من وقت لآخر كنسخة احتياطية.")));
}
function bulkSheet(){
  const f = sheet("إضافة عدة روايات");
  f.appendChild(el("p", "small", "رواية في كل سطر. يمكنك إضافة رقم الفصل والرابط بعد الاسم بخط عمودي: الاسم | 120 | https://…"));
  const ta = document.createElement("textarea"); ta.rows = 10; ta.dir = "auto";
  const l = el("label", "f", "القائمة"); l.appendChild(ta); f.appendChild(l);
  const st = document.createElement("select"); ORDER.forEach(k => { const o = el("option", "", STATUS[k]); o.value = k; st.appendChild(o); }); st.value = "planned";
  const l2 = el("label", "f", "الحالة للجميع"); l2.appendChild(st); f.appendChild(l2);
  const acts = el("div", "acts"); acts.append(btn("btn primary", "إضافة", async () => {
    const now = Date.now(); const add = []; const skip = [];
    ta.value.split(/\n+/).map(x => x.trim()).filter(Boolean).forEach((line, i) => {
      const [t, c, u] = line.split("|").map(x => (x || "").trim()); const k = KEY(t);
      if (!k || find(k) && !find(k).deleted || add.some(x => x.key === k)){ skip.push(t); return; }
      const chapter = parseInt(c) || 0;
      add.push({key: k, aliases: [], title: t, altTitle: "", url: u || "", chapter, total: 0, status: chapter > 0 && st.value === "planned" ? "reading" : st.value,
        rating: 0, note: "", shelves: [], genres: [], author: "", desc: "", source: "", createdAt: now - i, updatedAt: now - i});
    });
    await putNovels(add); all = all.filter(n => !add.some(a => a.key === n.key)).concat(add);
    back(); render(); toast("أضيفت " + add.length + (skip.length ? "، وتُركت " + skip.length + " موجودة أو مكررة" : ""));
  }), btn("btn", "إلغاء", back)); f.appendChild(acts);
}
function shelvesSheet(){
  const f = sheet("إدارة القوائم");
  const paint = () => {
    f.querySelectorAll(".dyn").forEach(x => x.remove());
    const box = el("div", "list-opt dyn");
    allShelves().forEach(s => {
      const row = el("div", "opt"); const c = lib().filter(n => (n.shelves||[]).includes(s)).length;
      row.append(el("span", "", s + " (" + c + ")"));
      const acts = el("span", "acts");
      acts.append(btn("btn", "تسمية", () => {
        const i = document.createElement("input"); i.value = s; i.className = "search"; row.replaceChildren(i, btn("btn primary", "حفظ", async () => {
          const t = i.value.trim(); if (!t || t === s) { paint(); return; }
          const changed = lib().filter(n => (n.shelves||[]).includes(s)); changed.forEach(n => { n.shelves = [...new Set(n.shelves.map(x => x === s ? t : x))]; n.updatedAt = Date.now(); });
          await putNovels(changed); await setMeta("shelves", [...new Set((meta.shelves||[]).map(x => x === s ? t : x).concat(t))]); render(); paint();
        }));
        i.focus();
      }), btn("btn danger", "حذف", async () => {
        const changed = lib().filter(n => (n.shelves||[]).includes(s)); changed.forEach(n => { n.shelves = n.shelves.filter(x => x !== s); n.updatedAt = Date.now(); });
        await putNovels(changed); await setMeta("shelves", (meta.shelves||[]).filter(x => x !== s)); view.shelves = view.shelves.filter(x => x !== s); saveView(); render(); paint();
      }));
      row.appendChild(acts); box.appendChild(row);
    });
    if (!allShelves().length) box.appendChild(el("p", "small", "لا قوائم بعد."));
    f.appendChild(box);
    const add = btn("btn primary dyn", "+ قائمة جديدة", () => { back(); setTimeout(() => newShelfSheet(null), 50); }); f.appendChild(add);
  };
  paint();
}

/* ---------- sync: export / import with merge ---------- */
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function exportSync(){
  const covers = {};
  for (const n of all.filter(n => n.customCover && !n.deleted)){ const b = await idb("covers", "readonly", s => s.get(n.key)); if (b) covers[n.key] = await blobToDataURL(b); }
  const data = {app: "maktabati", kind: "sync", version: 1, exportedAt: Date.now(), novels: all, shelves: meta.shelves || [], covers};
  const d = new Date(); const name = "مكتبتي_" + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + ".json";
  const file = new File([JSON.stringify(data)], name, {type: "application/json"});
  if (navigator.canShare && navigator.canShare({files: [file]})){
    try { await navigator.share({files: [file], title: "مكتبتي"}); await setMeta("lastExport", Date.now()); toast("تم التصدير"); return; }
    catch(e){ if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  await setMeta("lastExport", Date.now()); toast("حُفظ الملف في التنزيلات");
}
// the old Claude page exported a plain array of {title, chapter, status, …}
function fromClaudePage(r){
  return {key: KEY(r.title), aliases: [], title: r.title || "", altTitle: "", url: r.url || "", chapter: r.chapter || 0, total: r.total || 0, status: r.status || "planned",
    rating: r.rating || 0, note: r.note || "", shelves: [], titleAr: r.titleAr || "", descAr: r.descAr || "", createdAt: r.createdAt || Date.now(), updatedAt: r.updatedAt || Date.now()};
}
async function importFile(file){
  let d; try { d = JSON.parse(await file.text()); } catch(e){ toast("الملف ليس ملف مكتبة صالحًا"); return; }
  let recs, covers = {}, kind;
  if (Array.isArray(d)){ kind = "claude"; recs = d.map(fromClaudePage); }
  else if (d && d.app === "maktabati" && Array.isArray(d.novels)){ kind = d.kind; recs = d.novels; covers = d.covers || {}; if (d.shelves) await setMeta("shelves", [...new Set([...(meta.shelves||[]), ...d.shelves])]); }
  else { toast("الملف ليس ملف مكتبة صالحًا"); return; }
  let added = 0, updated = 0; const changed = [];
  for (const r of recs){
    if (!r || !r.key) continue;
    const ex = find(r.key) || (r.aliases||[]).map(find).find(Boolean);
    let target = null;
    if (!ex){ if (r.deleted) continue; target = {...r}; added++; }
    else {
      let touched = false; const m = {...ex};
      // progress: the newer record wins (a starter file never overrides your progress)
      if (kind !== "starter" && (r.updatedAt||0) > (ex.updatedAt||0)){
        PROGRESS_FIELDS.forEach(f => { if (f in r) m[f] = r[f]; });
        if (/…$/.test(r.title||"") && !/…$/.test(ex.title||"")) m.title = ex.title; // never swap a full name for a cut-short one
        if (kind === "claude"){ m.shelves = ex.shelves; m.altTitle = ex.altTitle; } // the old page had no shelves
        m.updatedAt = r.updatedAt; touched = true;
      }
      // catalog data only fills what is missing
      CATALOG_FIELDS.forEach(f => { const empty = !m[f] || (Array.isArray(m[f]) && !m[f].length); if (empty && r[f] && (!Array.isArray(r[f]) || r[f].length)){ m[f] = r[f]; touched = true; } });
      ["titleAr", "descAr", "altTitle"].forEach(f => { if (!m[f] && r[f]){ m[f] = r[f]; touched = true; } });
      const al = new Set([...(m.aliases||[]), ...(r.aliases||[])]); if (r.key !== m.key) al.add(r.key); al.delete(m.key);
      if (al.size !== (m.aliases||[]).length){ m.aliases = [...al]; touched = true; }
      if (touched){ target = m; updated++; }
    }
    if (target){ target.shelves = target.shelves || []; target.genres = target.genres || []; changed.push(target); }
    const c = covers[r.key]; const k = (target || ex).key;
    if (c && (!coverUrls.has(k) || r.customCover)){ const b = await (await fetch(c)).blob(); await putCover(k, b); }
  }
  await putNovels(changed); await setMeta("lastImport", Date.now()); await loadAll(); render();
  toast(added || updated ? "أضيفت " + added + " رواية، وتحدّثت " + updated : "لا جديد في الملف، مكتبتك محدّثة");
}

/* ---------- start ---------- */
$("#q").addEventListener("input", e => { view.q = e.target.value; render(); });
$("#sort").addEventListener("change", e => { view.sort = e.target.value; saveView(); render(); });
$("#filterBtn").onclick = filterSheet;
$("#selectBtn").onclick = () => { if (!sel) startSelect(null); };
$("#menuBtn").onclick = menuSheet;
$("#linkBtn").onclick = () => pasteSheet(null);
$("#addBtn").onclick = () => editSheet(null);
$("#fileIn").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); });

(async () => {
  try { await openDB(); await loadAll(); }
  catch(e){ $("#list").innerHTML = ""; const x = el("div", "empty"); x.append(el("b", "", "تعذّر فتح التخزين"), el("span", "", "افتح التطبيق في متصفح Chrome عادي، لا في وضع التصفح الخفي.")); $("#list").appendChild(x); return; }
  render();
  if (navigator.storage && navigator.storage.persist){ try { const p = await navigator.storage.persist(); meta.persisted = p; } catch(e) {} }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  // opened from Android's share menu: index.html?title=…&text=…&url=…
  const sp = new URLSearchParams(location.search);
  if (sp.has("url") || sp.has("text")){
    history.replaceState(null, "", location.pathname);
    if (lib().length) handleLink({url: sp.get("url") || "", title: sp.get("title") || "", text: sp.get("text") || ""});
    else toast("استورد مكتبتك أولًا، ثم شارك الفصل مرة أخرى");
  }
})();
