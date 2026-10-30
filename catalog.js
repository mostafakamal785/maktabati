"use strict";
/* «الفهرس»: browse novels from novelping (catalog/catalog.json, rebuilt weekly by a GitHub Action).
   Nothing from here enters «مكتبتي» unless you press «أضف». Also feeds the «فصول جديدة» badge in the library. */

let CAT = null, catBy = {slug: new Map(), key: new Map()}, tab = "lib";
let cview = {q: "", genres: [], sort: "rank", state: "all", hideMine: true, shown: 40};
try { Object.assign(cview, JSON.parse(localStorage.getItem("cview") || "{}"), {q: "", shown: 40}); } catch(e) {}
const saveCview = () => { try { localStorage.setItem("cview", JSON.stringify({...cview, q: ""})); } catch(e) {} };
const npCover = slug => "https://images.novelping.com/novel_200_89/" + slug + ".jpg";
const npUrl = slug => "https://novelping.com/book/" + slug;

// novelping writes "Super Gene Ⅱ" with one Roman-numeral character; your library has "Super Gene II"
const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
const roman = t => (t || "").replace(/[\u2160-\u216B]/g, c => " " + ROMAN[c.charCodeAt(0) - 0x215F] + " ").replace(/[\u2170-\u217B]/g, c => " " + ROMAN[c.charCodeAt(0) - 0x216F] + " ");
function indexCatalog(d){
  CAT = d; catBy = {slug: new Map(), key: new Map()};
  d.items.forEach((r, i) => { const it = {slug: r[0], title: r[1], author: r[2], latest: r[3], full: !!r[4], genres: r[5].map(g => d.genres[g]), rank: i, key: KEY(roman(r[1])), akey: KEY(r[2])};
    catBy.slug.set(it.slug, it); if (!catBy.key.has(it.key)) catBy.key.set(it.key, it); });
}
// a library novel's catalog entry: by its saved links, its slug, or its name
function catFor(n){
  if (!CAT) return null;
  // a link chosen by hand wins; "-" means "not in the catalog" (a wrong automatic match was undone)
  if (n.catSlug) return n.catSlug === "-" ? null : catBy.slug.get(n.catSlug) || null;
  for (const id of idsOf(n)){ const [site, slug] = id.split(":"); if (!/^\d+$/.test(slug) && catBy.slug.has(slug)) return catBy.slug.get(slug); }
  return catBy.key.get(n.key) || (n.aliases||[]).map(a => catBy.key.get(a)).find(Boolean) || (n.altTitle && catBy.key.get(KEY(n.altTitle))) || null;
}
// the full catalog has ~27k novels, so look them up in a map of the library built once per render
let mineIdx = null;
function buildMine(){
  const m = new Map();
  lib().forEach(n => { m.set(n.key, n); if (n.catSlug && n.catSlug !== "-") m.set("np:" + n.catSlug, n); (n.aliases||[]).forEach(a => m.set(a, n)); idsOf(n).forEach(id => { if (id.indexOf("novelping:") === 0) m.set("np:" + id.slice(10), n); }); });
  return m;
}
function inLibrary(it){ const m = mineIdx || buildMine(); return m.get(it.key) || m.get("np:" + it.slug) || null; }
// what to show as the novel's length: the saved total, or the site's newest chapter when that is higher
function totalOf(n){ const c = catFor(n); return Math.max(Number(n.total) || 0, c ? c.latest : 0); }
// released since you last moved this novel: seenLatest is the site's last chapter at that moment
// a 0 means the site row showed no chapter number, so it is no baseline and no news
const newChapters = n => { const c = catFor(n); return c && n.status === "reading" && n.seenLatest > 0 && c.latest > n.seenLatest ? c.latest - n.seenLatest : 0; };
const leftChapters = n => { const c = catFor(n); return c && c.latest > (n.chapter||0) ? c.latest - (n.chapter||0) : 0; };
function markSeen(n){ const c = catFor(n); if (c && c.latest > 0) n.seenLatest = c.latest; }

async function loadCatalog(refresh){
  if (!CAT && meta.catalog) indexCatalog(meta.catalog);
  if (refresh || !CAT) try {
    const r = await fetch("catalog/catalog.json", {cache: "no-cache"});
    if (r.ok){ const d = await r.json(); if (!CAT || d.updatedAt !== CAT.updatedAt){ indexCatalog(d); await setMeta("catalog", d); } }
  } catch(e) { /* offline: keep the saved copy */ }
  if (!CAT) return;
  // first sight of a novel in the catalog sets the baseline, so only later releases count as new
  const fresh = lib().filter(n => (!(n.seenLatest > 0) || n.seenFull == null) && catFor(n));
  fresh.forEach(n => { if (!(n.seenLatest > 0)) markSeen(n); if (n.seenFull == null) n.seenFull = catFor(n).full; });
  if (fresh.length) await putNovels(fresh);
}

/* ---------- «مقترحة لك»: catalog novels that share the genres you read most ---------- */
// each library novel votes for its genres: more for what you read, finished or rated well, less for what you dropped
function forYouScore(){
  const w = new Map();
  lib().forEach(n => {
    const c = catFor(n); const gs = new Set([...(n.genres||[]), ...(c ? c.genres : [])].map(g => g.toLowerCase()));
    const v = n.status === "dropped" ? -0.5 : (n.status === "reading" || n.status === "done" ? 2 : 1) + (n.rating >= 4 ? 1 : 0);
    gs.forEach(g => w.set(g, (w.get(g) || 0) + v));
  });
  const memo = new Map();
  return it => {
    if (memo.has(it.slug)) return memo.get(it.slug);
    let s = 0; it.genres.forEach(g => s += Math.max(0, w.get(g.toLowerCase()) || 0));
    // favour well-known novels a little, and do not let a long genre list win on its own
    s = it.genres.length ? s / Math.sqrt(it.genres.length) / (1 + it.rank / 3000) : 0;
    memo.set(it.slug, s); return s;
  };
}

/* ---------- link a library novel to its catalog entry by hand ---------- */
// shown on the novel page: which catalog novel feeds its chapter count, or a button to choose one
function catSection(n){
  const box = el("div", "cat-link"); if (!CAT) return box;
  const c = catFor(n);
  const p = el("p", "small", c ? "في الفهرس: " + c.title + " · آخر فصل " + (c.latest || "؟") + " · " + (c.full ? "مكتملة" : "مستمرة")
    : "غير مربوطة بالفهرس، فلا يظهر لها عدد الفصول ولا الفصول الجديدة."); p.dir = "auto";
  box.append(p, btn("btn", c ? "تغيير الربط" : "اربطها بالفهرس", () => linkCatSheet(n)));
  return box;
}
function catMatches(q, limit){
  const k = KEY(q); if (k.length < 2) return [];
  const hits = [];
  for (const it of catBy.slug.values()){
    if (it.key === k) hits.push([it, 2]);
    else if (it.key.includes(k) || (it.key.length > 5 && k.includes(it.key))) hits.push([it, 1]);
  }
  // nothing contains the words: fall back to the closest spellings among names of similar length
  if (hits.length < limit && k.length > 5)
    for (const it of catBy.slug.values()) if (Math.abs(it.key.length - k.length) < 6 && !hits.some(h => h[0] === it)){ const s = similar(it.key, k); if (s > 0.7) hits.push([it, s]); }
  return hits.sort((a, b) => b[1] - a[1] || a[0].rank - b[0].rank).slice(0, limit).map(h => h[0]);
}
function linkCatSheet(n){
  const f = sheet("ربط «" + n.title + "» بالفهرس"); f.querySelector("h2").dir = "auto";
  if (!CAT){ f.appendChild(el("p", "sub", "الفهرس لم يُحمَّل بعد. افتح تبويب «الفهرس» وأنت متصل، ثم عد.")); return; }
  f.appendChild(el("p", "small", "اختر الرواية نفسها من الفهرس حتى يظهر لها عدد الفصول والفصول الجديدة. ابحث بالاسم الإنجليزي."));
  const q = document.createElement("input"); q.type = "search"; q.dir = "auto"; q.value = n.altTitle && !/[a-z]/i.test(n.title) ? n.altTitle : n.title;
  const l = el("label", "f", "ابحث في الفهرس"); l.appendChild(q); f.appendChild(l);
  const box = el("div", "list-opt"); f.appendChild(box);
  const choose = async slug => { n.catSlug = slug; n.seenLatest = null; markSeen(n); back(); await save(n); drawDetail(); toast(slug === "-" ? "أُلغي الربط" : "رُبطت بالفهرس"); };
  const draw = () => {
    box.innerHTML = ""; const cur = catFor(n);
    const list = catMatches(q.value, 8);
    if (!list.length) box.appendChild(el("p", "small", q.value.trim() ? "لا نتائج. جرّب جزءًا من الاسم." : ""));
    list.forEach(it => { const b = btn("opt", ""); const t = el("span", "", it.title); t.dir = "auto"; b.append(t, el("span", "", (it.latest ? it.latest + " فصل" : "") + (it.full ? " · مكتملة" : "")));
      b.setAttribute("aria-pressed", !!cur && cur.slug === it.slug); b.onclick = () => choose(it.slug); box.appendChild(b); });
    if (cur) box.appendChild(btn("btn", "ليست في الفهرس (إلغاء الربط)", () => choose("-")));
  };
  let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(draw, 250); }); draw();
}
// the menu's list of library novels the catalog does not know yet
function unlinkedSheet(){
  const f = sheet("روايات غير مربوطة بالفهرس");
  const list = lib().filter(n => !catFor(n) && n.catSlug !== "-").sort((a, b) => (b.lastReadAt||0) - (a.lastReadAt||0));
  f.appendChild(el("p", "small", list.length ? "اضغط على رواية لتختارها من الفهرس. بعضها قد لا يكون في novelping أصلًا." : "كل رواياتك مربوطة بالفهرس."));
  const box = el("div", "list-opt"); f.appendChild(box);
  list.forEach(n => { const b = btn("opt", ""); const t = el("span", "", n.title); t.dir = "auto"; b.append(t, el("span", "", STATUS[n.status] || "")); b.onclick = () => { back(); setTimeout(() => { detail(n.key); setTimeout(() => linkCatSheet(n), 80); }, 80); }; box.appendChild(b); });
}

/* ---------- tabs ---------- */
function setTab(t){
  tab = t; document.body.dataset.tab = t;
  $("#tabLib").setAttribute("aria-pressed", t === "lib"); $("#tabCat").setAttribute("aria-pressed", t === "cat");
  $("#q").value = t === "lib" ? view.q : cview.q;
  $("#q").placeholder = t === "lib" ? "ابحث بالاسم أو الوصف أو النوع أو المؤلف" : "ابحث في الفهرس بالاسم أو المؤلف";
  window.scrollTo(0, 0);
  if (t === "cat"){ renderCatalog(); loadCatalog(true).then(() => tab === "cat" && renderCatalog()); }
  else render();
}

function renderCatalog(){
  const list = $("#list"); list.innerHTML = "";
  const box = $("#catControls"); box.innerHTML = "";
  if (!CAT){ const e = el("div", "empty"); e.append(el("b", "", navigator.onLine ? "جارٍ تحميل الفهرس…" : "الفهرس يحتاج إنترنت أول مرة"), el("span", "", "بعدها يبقى محفوظًا في جهازك ويتحدّث حين تتصل.")); list.appendChild(e); return; }
  // controls: genres, state, sort, hide mine
  const gl = el("div", "chips");
  const counts = new Map(); CAT.items.forEach(r => r[5].forEach(g => counts.set(g, (counts.get(g)||0) + 1)));
  const allG = btn("chip list", "كل الأنواع", () => { cview.genres = []; cview.shown = 40; saveCview(); renderCatalog(); }); allG.setAttribute("aria-pressed", !cview.genres.length); gl.appendChild(allG);
  CAT.genres.map((g, i) => [g, counts.get(i) || 0]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).forEach(([g, c]) => {
    const on = cview.genres.includes(g);
    const b = btn("chip list", g + " " + c, () => { cview.genres = on ? cview.genres.filter(x => x !== g) : [...cview.genres, g]; cview.shown = 40; saveCview(); renderCatalog(); });
    b.setAttribute("aria-pressed", on); gl.appendChild(b);
  });
  box.appendChild(gl);
  const row = el("div", "bar-row");
  const st = document.createElement("select"); [["all", "كل الحالات"], ["ongoing", "مستمرة"], ["full", "مكتملة"]].forEach(([v, t]) => { const o = el("option", "", t); o.value = v; st.appendChild(o); }); st.value = cview.state;
  st.onchange = () => { cview.state = st.value; cview.shown = 40; saveCview(); renderCatalog(); };
  const so = document.createElement("select"); [["rank", "الأكثر قراءة"], ["forYou", "مقترحة لك"], ["chapters", "الأكثر فصولًا"], ["name", "الاسم"]].forEach(([v, t]) => { const o = el("option", "", t); o.value = v; so.appendChild(o); }); so.value = cview.sort;
  so.onchange = () => { cview.sort = so.value; cview.shown = 40; saveCview(); renderCatalog(); };
  const hm = btn("pill" + (cview.hideMine ? " on" : ""), cview.hideMine ? "إخفاء ما في مكتبتي ✓" : "إخفاء ما في مكتبتي", () => { cview.hideMine = !cview.hideMine; saveCview(); renderCatalog(); });
  const l1 = el("label", "sort"); l1.appendChild(st); const l2 = el("label", "sort"); l2.appendChild(so);
  row.append(hm, el("span", "bar-left"), l1, l2); row.children[1].remove(); box.appendChild(row);

  const q = KEY(cview.q); mineIdx = buildMine();
  let items = CAT.items.map(r => catBy.slug.get(r[0])).filter(it =>
    (!cview.genres.length || cview.genres.every(g => it.genres.includes(g))) &&
    (cview.state === "all" || (cview.state === "full") === it.full) &&
    (!q || it.key.includes(q) || it.akey.includes(q)));
  if (cview.hideMine) items = items.filter(it => !inLibrary(it));
  if (cview.sort === "forYou"){ const sc = forYouScore(); items = items.filter(it => sc(it) > 0).sort((a, b) => sc(b) - sc(a)); }
  else if (cview.sort === "chapters") items.sort((a, b) => b.latest - a.latest); else if (cview.sort === "name") items.sort((a, b) => a.title.localeCompare(b.title));
  list.appendChild(el("p", "small cat-meta", items.length.toLocaleString("ar") + " رواية · الفهرس من novelping.com · آخر تحديث " + CAT.updatedAt.slice(0, 10)));
  if (!items.length){ const e = el("div", "empty"); e.append(el("b", "", "لا نتائج"), el("span", "", "غيّر البحث أو الأنواع.")); list.appendChild(e); mineIdx = null; return; }
  const frag = document.createDocumentFragment(); items.slice(0, cview.shown).forEach(it => frag.appendChild(catCard(it))); list.appendChild(frag);
  if (items.length > cview.shown) list.appendChild(btn("btn more", "عرض المزيد (" + (items.length - cview.shown) + ")", () => { cview.shown += 60; renderCatalog(); }));
  mineIdx = null;
}
function catCard(it){
  const c = el("article", "card cat-card");
  const cv = el("div", "cover"); const im = document.createElement("img"); im.src = npCover(it.slug); im.alt = ""; im.loading = "lazy"; im.onerror = () => { cv.textContent = it.title.charAt(0); }; cv.appendChild(im);
  const body = el("div", "body");
  const t = el("h3", "title", it.title); t.dir = "auto"; body.appendChild(t);
  if (it.author) body.appendChild(el("p", "sub", it.author));
  body.appendChild(el("p", "sub", (it.latest ? "آخر فصل " + it.latest.toLocaleString("ar") + " · " : "") + (it.full ? "مكتملة" : "مستمرة")));
  if (it.genres.length){ const tg = el("div", "tags"); it.genres.slice(0, 4).forEach(g => tg.appendChild(el("span", "tag", g))); body.appendChild(tg); }
  const a = el("div", "acts"); const mine = inLibrary(it);
  if (mine) a.appendChild(btn("btn", "في مكتبتك ✓", () => { setTab("lib"); setTimeout(() => detail(mine.key), 50); }));
  else a.appendChild(btn("btn primary", "+ أضف", () => addFromCatalog(it)));
  const l = el("a", "btn", "صفحتها"); l.href = npUrl(it.slug); l.target = "_blank"; l.rel = "noopener"; a.appendChild(l);
  body.appendChild(a); c.append(cv, body); return c;
}
function addFromCatalog(it){
  const f = sheet(it.title); f.querySelector("h2").dir = "auto";
  f.appendChild(el("p", "section-title", "أضفها بحالة"));
  let lists = []; const sg = el("div", "status-grid");
  ORDER.forEach(k => sg.appendChild(btn("status-opt s-" + k, STATUS[k], async () => {
    const now = Date.now(); const key = KEY(it.title);
    const n = {key, aliases: [], title: it.title, altTitle: "", url: npUrl(it.slug), chapter: 0, total: it.full ? it.latest : 0, status: k, rating: 0, note: "",
      shelves: lists, genres: it.genres, author: it.author, desc: "", source: "novelping", coverUrl: npCover(it.slug), links: ["novelping:" + it.slug], createdAt: now, updatedAt: now};
    back(); await save(n); toast("أُضيفت إلى مكتبتك: " + it.title); if (tab === "cat") renderCatalog();
  })));
  f.appendChild(sg);
  if (allShelves().length){
    f.appendChild(el("p", "section-title", "وفي القوائم (اختياري)"));
    const lg = el("div", "grid-opts");
    allShelves().forEach(s => { const b = btn("shelf-toggle", s, () => { lists = lists.includes(s) ? lists.filter(x => x !== s) : [...lists, s]; b.setAttribute("aria-pressed", lists.includes(s)); }); b.setAttribute("aria-pressed", false); lg.appendChild(b); });
    f.appendChild(lg);
  }
}
