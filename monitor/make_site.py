#!/usr/bin/env python3
"""把 data/records.csv、data/research.json、data/monitor.json 的最新副本嵌入 index.html，
这样网页即使双击本地打开也能显示。GitHub 上线后网页优先读取在线数据，这一步只影响离线备份。"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
idx = os.path.join(ROOT, "index.html")
s = open(idx, encoding="utf-8").read()


def embed(tag_id, kind, text):
    global s
    text = text.replace("</script", "<\\/script")
    block = f'<script id="{tag_id}" type="{kind}">\n{text}\n</script>'
    pat = re.compile(rf'<script id="{tag_id}" type="[^"]+">.*?</script>', re.S)
    s = pat.sub(lambda m: block, s, count=1) if pat.search(s) else s.replace('<script src="config.js"></script>', block + '\n<script src="config.js"></script>', 1)


embed("seedData", "text/csv", open(os.path.join(ROOT, "data/records.csv"), encoding="utf-8-sig").read().strip())
rp = os.path.join(ROOT, "data/research.json")
embed("researchData", "application/json", open(rp, encoding="utf-8").read() if os.path.exists(rp) else "")
ap = os.path.join(ROOT, "data/auto_records.csv")
embed("autoData", "text/csv", open(ap, encoding="utf-8-sig").read().strip() if os.path.exists(ap) else "")
mp = os.path.join(ROOT, "data/monitor.json")
embed("monitorData", "application/json", open(mp, encoding="utf-8").read() if os.path.exists(mp) else "")
open(idx, "w", encoding="utf-8").write(s)
print("index.html 已更新离线备份")
