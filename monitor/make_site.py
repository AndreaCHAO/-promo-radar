#!/usr/bin/env python3
"""整理 index.html：
1. 去掉旧版内嵌的数据备份（网页一律从 data/ 在线读取，页面体积从约 740 KB 降到约 10 KB）；
2. 给样式和脚本加内容版本号，更新后浏览器会自动加载新文件。"""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
idx = os.path.join(ROOT, "index.html")
s = open(idx, encoding="utf-8").read()

s = re.sub(r'<script id="(seedData|researchData|autoData|eventsData|playbookData|monitorData)" type="[^"]+">.*?</script>\n?', "", s, flags=re.S)

# 给样式和脚本加上内容版本号，更新后浏览器会自动加载新文件，不再用旧缓存
import hashlib
for asset in ("assets/app.css", "assets/app.js", "config.js"):
    fp = os.path.join(ROOT, asset)
    if os.path.exists(fp):
        v = hashlib.md5(open(fp, "rb").read()).hexdigest()[:8]
        s = re.sub(rf'(["\']){re.escape(asset)}(\?v=[0-9a-f]+)?(["\'])', lambda m: f"{m.group(1)}{asset}?v={v}{m.group(3)}", s)
open(idx, "w", encoding="utf-8").write(s)
print("index.html 已整理（版本号已更新）")
