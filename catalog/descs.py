"""Collect English descriptions for the catalog from freewebnovel.com, a little at a time.
freewebnovel's robots.txt allows every page, and its novel pages use the same slugs as novelping
(/novel/<slug>), so each catalog novel is looked up by its own slug, most-read first.

Saving in parts: descriptions go into 256 small files catalog/desc/<xx>.json (xx from a hash of the slug,
the same hash the app uses to find a novel's file). Every 50 novels the changed files are written, so a stop
loses at most 50; the next run skips every slug already in a file ("" = freewebnovel has no such novel).
Usage: python catalog/descs.py [minutes]      (default 330: one GitHub Actions run; stdlib only)"""
import json, re, sys, time, html, os, urllib.request, urllib.error

MINUTES = float(sys.argv[1]) if len(sys.argv) > 1 else 330
BASE = "https://freewebnovel.com/novel/"
UA = "maktabati-catalog/1.0 (personal reading-list app)"
HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "desc")

def shard(slug):
    # djb2, 32-bit; catalog.js computes the same number to fetch desc/<xx>.json
    h = 5381
    for c in slug: h = (h * 33 + ord(c)) & 0xFFFFFFFF
    return "%02x" % (h & 255)

def get(slug):
    """The page, None when freewebnovel has no such novel, or "" when the site could not be reached."""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + slug, headers={"User-Agent": UA}), timeout=30) as r:
                body = r.read().decode("utf-8", "ignore")
            time.sleep(1.2)
            return body
        except urllib.error.HTTPError as e:
            time.sleep(1.2)
            if e.code == 404: return None
            print("retry", slug, e.code, flush=True); time.sleep(5 * (attempt + 1))
        except Exception as e:
            print("retry", slug, e, flush=True); time.sleep(5 * (attempt + 1))
    return ""

def description(page):
    i = page.find('class="abstract"')
    m = re.search(r'<div class="inner">(.*?)</div>', page[i:], re.S) if i >= 0 else None
    if not m: return ""
    paras = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p))).strip() for p in re.findall(r"<p[^>]*>(.*?)</p>", m.group(1), re.S)]
    text = "\n".join(p for p in paras if p and not re.search(r"discord\.gg|patreon\.com", p, re.I))
    # long synopses end at a sentence near 1,200 characters
    return text if len(text) <= 1200 else text[:1200].rsplit(".", 1)[0] + ".…"

os.makedirs(DIR, exist_ok=True)
files = {}
for k in ("%02x" % i for i in range(256)):
    try: files[k] = json.load(open(os.path.join(DIR, k + ".json"), encoding="utf-8"))
    except Exception: files[k] = {}
known = {s for f in files.values() for s in f}
slugs = [r[0] for r in json.load(open(os.path.join(HERE, "catalog.json"), encoding="utf-8"))["items"]]
todo = [s for s in slugs if s not in known]
print(len(slugs), "catalog novels,", len(known), "already looked up,", len(todo), "to go", flush=True)

def save(dirty):
    for k in dirty:
        json.dump(files[k], open(os.path.join(DIR, k + ".json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    dirty.clear()

end, dirty, done, found = time.time() + MINUTES * 60, set(), 0, 0
for s in todo:
    if time.time() > end: break
    page = get(s)
    if page == "": continue          # site unreachable: try this one again next run
    d = description(page) if page else ""
    k = shard(s); files[k][s] = d; dirty.add(k); done += 1; found += bool(d)
    if done % 50 == 0:
        save(dirty); print("looked up", done, "found", found, flush=True)
save(dirty)
print("this run: looked up", done, "found", found, "| left", len(todo) - done)
