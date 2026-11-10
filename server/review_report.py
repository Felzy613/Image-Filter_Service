#!/usr/bin/env python3
"""Build a click-through page of the pictures the server greyed (the opt-in review log).

    python3 server/review_report.py            # default review folder
    python3 server/review_report.py /some/dir  # or a specific one (REVIEW_LOG_DIR works too)

Writes <folder>/index.html next to the thumbnails and prints its path. Open it, click every
picture that should NOT have been greyed (a red cross appears), then press "Copy list" and
paste it back — the file names identify the thumbnails. Marks are kept in the browser, so
you can rebuild the page as the folder fills up without losing them.

Standard library only. The log itself is switched on by creating the folder; see REVIEW_DIR
in app.py.
"""
import json
import os
import sys
from pathlib import Path

DEFAULT_DIR = Path(os.getenv(
    "REVIEW_LOG_DIR",
    str(Path.home() / "Library" / "Application Support" / "Image-Filter-Service" / "review")))

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Greyed pictures — review</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --card:#f5f5f7; --line:#d2d2d7; --bad:#d70015; --accent:#0071e3; }
@media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#f5f5f7; --muted:#98989d; --card:#232326; --line:#3a3a3d; --bad:#ff453a; --accent:#2997ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, system-ui, sans-serif; }
header { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px; }
h1 { font-size:17px; margin:0 0 4px; }
p { margin:0 0 8px; color:var(--muted); }
.bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
select, button { font:inherit; padding:5px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
#count { color:var(--muted); margin-left:auto; }
main { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; padding:16px; }
.card { position:relative; background:var(--card); border:2px solid transparent; border-radius:10px; padding:8px; cursor:pointer; }
.card.wrong { border-color:var(--bad); }
.card.wrong::after { content:"\\2715"; position:absolute; top:6px; right:8px; color:var(--bad); font-weight:700; font-size:18px; }
.pic { height:130px; display:flex; align-items:center; justify-content:center; background:
  repeating-conic-gradient(#0000000d 0 25%, #0000 0 50%) 0 0/16px 16px; border-radius:6px; overflow:hidden; }
.pic img { max-width:100%; max-height:100%; image-rendering:auto; }
.pic img.small { min-width:96px; min-height:96px; object-fit:contain; image-rendering:pixelated; }
.meta { margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.meta b { color:var(--fg); font-weight:600; }
#empty { padding:40px 16px; color:var(--muted); }
textarea { width:100%; height:120px; margin:8px 0 0; display:none; }
</style></head><body>
<header>
  <h1>Pictures the server greyed</h1>
  <p>Click any picture that should <b>not</b> have been greyed, then press <b>Copy list</b> and send it back.
     Only the greyed result and the site name are stored — never the original.</p>
  <div class="bar">
    <label>Sort <select id="sort">
      <option value="new">Newest</option><option value="grey">Most grey</option>
      <option value="small">Smallest image</option><option value="host">Site</option></select></label>
    <label>Show <select id="size">
      <option value="0">All sizes</option><option value="64">Up to 64px</option>
      <option value="128">Up to 128px</option><option value="256">Up to 256px</option></select></label>
    <button id="clear">Clear marks</button>
    <button id="copy" class="primary">Copy list</button>
    <span id="count"></span>
  </div>
  <textarea id="fallback" readonly></textarea>
</header>
<main id="grid"></main>
<div id="empty" hidden>Nothing here yet. Browse a little with the log on, then rebuild this page.</div>
<script id="data" type="application/json">__DATA__</script>
<script>
const items = JSON.parse(document.getElementById('data').textContent);
const KEY = 'review-marks:' + location.pathname;
let marks = new Set();
try { marks = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...marks])); } catch (e) {} };
const $ = id => document.getElementById(id);
const sorters = {
  new: (a, b) => b.ts - a.ts, grey: (a, b) => b.ratio - a.ratio,
  small: (a, b) => Math.max(a.w, a.h) - Math.max(b.w, b.h), host: (a, b) => a.host.localeCompare(b.host) || b.ts - a.ts
};
function render() {
  const max = +$('size').value;
  const list = items.filter(i => !max || Math.max(i.w, i.h) <= max).sort(sorters[$('sort').value]);
  const grid = $('grid'); grid.textContent = '';
  for (const i of list) {
    const card = document.createElement('div');
    card.className = 'card' + (marks.has(i.file) ? ' wrong' : '');
    const pic = document.createElement('div'); pic.className = 'pic';
    const img = document.createElement('img'); img.src = i.file; img.loading = 'lazy';
    if (Math.max(i.w, i.h) < 96) img.className = 'small';
    pic.appendChild(img);
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = Math.round(i.ratio * 100) + '% grey';
    meta.append(b, ' · ' + i.w + '×' + i.h, document.createElement('br'), i.host || '(unknown site)');
    card.append(pic, meta);
    card.onclick = () => { marks.has(i.file) ? marks.delete(i.file) : marks.add(i.file); save(); card.classList.toggle('wrong'); count(list.length); };
    grid.appendChild(card);
  }
  $('empty').hidden = items.length > 0; count(list.length);
}
function count(shown) { $('count').textContent = shown + ' shown · ' + items.length + ' saved · ' + marks.size + ' marked'; }
function summary() {
  const bad = items.filter(i => marks.has(i.file));
  return JSON.stringify({ wrong: bad.map(i => i.file), total: items.length,
    detail: bad.map(i => ({ file: i.file, host: i.host, w: i.w, h: i.h, ratio: i.ratio })) }, null, 1);
}
$('copy').onclick = async () => {
  const text = summary(), ta = $('fallback');
  try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied \\u2713'; }
  catch (e) { ta.style.display = 'block'; ta.value = text; ta.select(); try { document.execCommand('copy'); } catch (e2) {} $('copy').textContent = 'Copy from the box'; }
  setTimeout(() => { $('copy').textContent = 'Copy list'; }, 2500);
};
$('clear').onclick = () => { marks.clear(); save(); render(); };
$('sort').onchange = $('size').onchange = render;
render();
</script></body></html>
"""


def build(folder: Path) -> Path:
    index = folder / "index.jsonl"
    latest = {}
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                if (folder / row["file"]).exists():
                    latest[row["file"]] = {
                        "file": row["file"], "ts": int(row.get("ts", 0)), "w": int(row["w"]), "h": int(row["h"]),
                        "ratio": float(row.get("ratio", 0)), "host": str(row.get("host", ""))}
            except Exception:
                continue
    data = json.dumps(list(latest.values())).replace("</", "<\\/")
    out = folder / "index.html"
    out.write_text(PAGE.replace("__DATA__", data), encoding="utf-8")
    return out


def main() -> int:
    folder = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_DIR
    if not folder.is_dir():
        print(f"No review folder at {folder}\nTurn the log on with:  mkdir -p \"{folder}\"", file=sys.stderr)
        return 1
    out = build(folder)
    n = sum(1 for _ in folder.glob("*.jpg"))
    print(f"{n} thumbnail(s) → {out}\nOpen it with:  open \"{out}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
