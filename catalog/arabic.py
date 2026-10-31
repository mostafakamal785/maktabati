"""Build catalog/arabic.json from kolnovel.com («ملوك الروايات»), the Arabic translations, once a week.
kolnovel's robots.txt allows these pages (only /wp-admin/ is closed); its wp-json API answers 403, so it is not used.
For each series: Arabic title, English title (used by the app to match the novelping catalog and your library),
author, Arabic description, Arabic genres and the newest translated chapter.
Usage: python catalog/arabic.py      (stdlib only, runs on GitHub Actions after build.py)"""
import json, re, sys, time, html, os, urllib.request, datetime

BASE = "https://kolnovel.com"
UA = "maktabati-catalog/1.0 (personal reading-list app; weekly)"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arabic.json")

def get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                body = r.read().decode("utf-8", "ignore")
            time.sleep(1.2)
            return body
        except Exception as e:
            print("retry", url[:80], e, flush=True); time.sleep(5 * (attempt + 1))
    return ""

text = lambda s: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

def series(page):
    t = re.search(r'class="kol-series-editorial__title"[^>]*>(.*?)</h1>', page, re.S)
    if not t: return None
    en = re.search(r'class="kol-series-editorial__alt-title"[^>]*>(.*?)</p>', page, re.S)
    au = re.search(r'class="kol-series-editorial__byline".*?<a[^>]*>(.*?)</a>', page, re.S)
    d = re.search(r'itemprop="description"[^>]*>(.*?)</div>', page, re.S)
    # paragraphs kept as line breaks; long synopses cut at a sentence near 700 characters
    desc = "\n".join(x for x in (text(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", d.group(1), re.S)) if x) if d else ""
    if len(desc) > 700: desc = desc[:700].rsplit(".", 1)[0].rsplit("،", 1)[0] + "…"
    g = re.search(r'class="kol-series-editorial__genres">(.*?)</div></div>', page, re.S)
    genres = [text(x) for x in re.findall(r"<a[^>]*>(.*?)</a>", g.group(1), re.S)] if g else []
    nums = [int(x) for x in re.findall(r'data-kol-chapter-number="(\d+)"', page)]
    return {"ar": text(t.group(1)), "en": text(en.group(1)) if en else "", "author": text(au.group(1)) if au else "",
            "desc": desc, "genres": genres, "latest": max(nums) if nums else 0}

urls = re.findall(r"<loc>([^<]+/series/[^<]+)</loc>", get(BASE + "/wp-sitemap-posts-series-1.xml"))
rows = []
for i, u in enumerate(urls, 1):
    s = series(get(u))
    if s: rows.append([u.rstrip("/").rsplit("/", 1)[1], s["ar"], s["en"], s["author"], s["desc"], s["latest"], s["genres"]])
    if i % 25 == 0: print("series", i, "/", len(urls), flush=True)

try: before = len(json.load(open(OUT, encoding="utf-8"))["items"])
except Exception: before = 0
if len(rows) < max(50, before * 0.8):
    sys.exit("only %d series read (last file had %d), arabic.json not written" % (len(rows), before))
data = {"source": "kolnovel.com", "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        # one row per series: [slug (percent-encoded), Arabic title, English title, author, Arabic description, newest translated chapter, Arabic genres]
        "items": rows}
json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("wrote", len(rows), "series,", sum(1 for r in rows if r[2]), "with an English title,", os.path.getsize(OUT) // 1024, "KB")
