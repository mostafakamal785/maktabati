"""Build catalog/catalog.json for the app's «الفهرس» tab from novelping.com browse pages.
Only pages that novelping's robots.txt allows are read (/sort/*, /novelping-genres/*); novel pages are not.
Usage: python catalog/build.py [popular_pages] [genre_pages]      (stdlib only, runs on GitHub Actions)
       python catalog/build.py genres      every page of every genre into the existing catalog (hours; saves after each genre)"""
import json, re, sys, time, html, os, urllib.request, datetime

GENRES_ONLY = len(sys.argv) > 1 and sys.argv[1] == "genres"
POPULAR_PAGES = int(sys.argv[1]) if len(sys.argv) > 1 and not GENRES_ONLY else 2000   # 20 novels per page; stops at the last page (~1333 in 2026)
GENRE_PAGES = 400 if GENRES_ONLY else int(sys.argv[2]) if len(sys.argv) > 2 else 30   # big genres run to ~300 pages; the first 30 hold their most-read novels
BASE = "https://novelping.com"
UA = "maktabati-catalog/1.0 (personal reading-list app; weekly)"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json")

def get(path):
    for attempt in range(3):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8", "ignore")
            time.sleep(1.2)
            return body
        except Exception as e:
            print("retry", path, e, flush=True); time.sleep(5 * (attempt + 1))
    return ""

def parse(page):
    out = []
    for block in page.split('<h3 class="novel-title">')[1:]:
        m = re.search(r'href="https://novelping\.com/book/([^"/]+)"\s+title="([^"]+)"', block)
        if not m: continue
        slug, title = m.group(1), html.unescape(m.group(2))
        au = re.search(r'class="author"><span[^>]*></span>([^<]*)<', block)
        # newest chapter: its title says "Chapter 1432 …"; links are not reliable ("cchapter-1432-…", "gentle-snow-after-story-2")
        ch = re.search(r'class="chr-text chapter-title">\s*(?:Chapter|Ch\.?)\s*(\d+)', block, re.I) or re.search(r'/book/[^"/]+/[a-z]*chapter-(\d+)', block)
        out.append({"slug": slug, "title": title, "author": html.unescape(au.group(1)).strip() if au else "",
                    "latest": int(ch.group(1)) if ch else 0, "full": "label-full" in block[:600]})
    return out

disp = lambda g: re.sub(r"\s+", " ", g.replace("-", " ")).strip().title()   # "anime-&-comics" -> "Anime & Comics"

# last catalog: the floor for the size check, the genres to keep, and the chapter to keep when a row shows none
try:
    prev = json.load(open(OUT, encoding="utf-8"))
    old = {r[0]: {"slug": r[0], "title": r[1], "author": r[2], "latest": r[3], "full": bool(r[4]), "genres": {disp(prev["genres"][g]) for g in r[5]}} for r in prev["items"]}
except Exception: old = {}

items, order = {}, []
def take(r, genre=None):
    it = items.get(r["slug"])
    if it is None:
        it = items[r["slug"]] = {**r, "genres": set(old[r["slug"]]["genres"]) if r["slug"] in old else set()}; order.append(r["slug"])
    else: it.update(title=r["title"], author=r["author"] or it["author"], full=r["full"] or it["full"])
    # a side story or oddly named last chapter reads as 0: keep the number we knew
    it["latest"] = r["latest"] or it["latest"] or (old[r["slug"]]["latest"] if r["slug"] in old else 0)
    if genre: it["genres"].add(genre)

def write(stage):
    # the site was down or changed its pages: keep last week's catalog rather than shrink it
    if len(items) < max(100, len(old) * 0.8):
        sys.exit("only %d novels read (last catalog had %d), catalog not written" % (len(items), len(old)))
    used = sorted({g for it in items.values() for g in it["genres"]})
    gidx = {g: i for i, g in enumerate(used)}
    data = {
        "source": "novelping.com", "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "genres": used,
        # one row per novel, most viewed first: [slug, title, author, latest chapter, 1 if completed, genre indexes]
        "items": [[s, items[s]["title"], items[s]["author"], items[s]["latest"], 1 if items[s]["full"] else 0, sorted(gidx[g] for g in items[s]["genres"])] for s in order],
    }
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("wrote (%s)" % stage, len(data["items"]), "novels,", len(used), "genres,", os.path.getsize(OUT) // 1024, "KB", flush=True)

if GENRES_ONLY:   # start from the saved catalog, in its order
    for s, it in old.items(): items[s] = {**it, "genres": set(it["genres"])}; order.append(s)
else:
    for p in range(1, POPULAR_PAGES + 1):
        rows = parse(get("/sort/popular?sort=ALL_TIME&page=%d" % p))
        if not rows: break
        for r in rows: take(r)
        print("popular page", p, len(items), flush=True)
    write("novels")   # genres are the slow part, so save the novels first

home = get("/sort/popular")
genres = sorted(set(html.unescape(g) for g in re.findall(r'href="(?:https://novelping\.com)?/novelping-genres/([^"]+)"', home)))
for n, g in enumerate(genres, 1):
    for p in range(1, GENRE_PAGES + 1):
        rows = parse(get("/novelping-genres/%s?page=%d" % (urllib.request.quote(g, safe="&+-"), p)))
        if not rows: break
        for r in rows: take(r, disp(g))
        if p % 25 == 0: print("  genre", g, "page", p, flush=True)
    print("genre %d/%d %s, %d pages" % (n, len(genres), g, p), flush=True)
    if GENRES_ONLY: write(g)   # hours long: save after each genre so a stop loses little
if not GENRES_ONLY: write("genres")
