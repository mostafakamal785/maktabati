"""Build catalog/catalog.json for the app's «الفهرس» tab from novelping.com browse pages.
Only pages that novelping's robots.txt allows are read (/sort/*, /novelping-genres/*); novel pages are not.
Usage: python catalog/build.py [popular_pages] [genre_pages]      (stdlib only, runs on GitHub Actions)"""
import json, re, sys, time, html, os, urllib.request, datetime

POPULAR_PAGES = int(sys.argv[1]) if len(sys.argv) > 1 else 75   # 20 novels per page
GENRE_PAGES = int(sys.argv[2]) if len(sys.argv) > 2 else 15
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
        ch = re.search(r'/book/[^"/]+/chapter-(\d+)', block)
        out.append({"slug": slug, "title": title, "author": html.unescape(au.group(1)).strip() if au else "",
                    "latest": int(ch.group(1)) if ch else 0, "full": "label-full" in block[:600]})
    return out

items, order = {}, []
for p in range(1, POPULAR_PAGES + 1):
    rows = parse(get("/sort/popular?sort=ALL_TIME&page=%d" % p))
    if not rows: break
    for r in rows:
        if r["slug"] not in items: items[r["slug"]] = {**r, "genres": set()}; order.append(r["slug"])
    print("popular page", p, len(items), flush=True)

home = get("/sort/popular")
genres = sorted(set(html.unescape(g) for g in re.findall(r'href="(?:https://novelping\.com)?/novelping-genres/([^"]+)"', home)))
names = {}
for g in genres:
    for p in range(1, GENRE_PAGES + 1):
        page = get("/novelping-genres/%s?page=%d" % (urllib.request.quote(g, safe="&+-"), p))
        nm = re.search(r'<title>([^<|]+)', page); names[g] = (nm.group(1).replace("Novels", "").replace("Read", "").strip() if nm else g.replace("-", " ").title()) or g
        rows = parse(page)
        if not rows: break
        for r in rows:
            if r["slug"] in items: items[r["slug"]]["genres"].add(g)
    print("genre", g, flush=True)

if len(items) < 100:  # the site was down or changed its pages: keep last week's catalog
    sys.exit("only %d novels read, catalog not written" % len(items))
used = sorted({g for it in items.values() for g in it["genres"]})
gidx = {g: i for i, g in enumerate(used)}
data = {
    "source": "novelping.com", "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    "genres": [g.replace("-", " ").title() for g in used],
    # one row per novel, most viewed first: [slug, title, author, latest chapter, 1 if completed, genre indexes]
    "items": [[s, items[s]["title"], items[s]["author"], items[s]["latest"], 1 if items[s]["full"] else 0, sorted(gidx[g] for g in items[s]["genres"])] for s in order],
}
json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("wrote", len(data["items"]), "novels,", len(used), "genres,", os.path.getsize(OUT) // 1024, "KB")
