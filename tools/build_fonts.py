#!/usr/bin/env python3
"""把狮尾黑体（Swei Gothic，SIL OFL 1.1）切成按需加载的小字体包，放进 assets/fonts/。

只在换字体或想补字时手动运行一次，每日机器人不需要它。
用法：python3 tools/build_fonts.py <SweiGothicCJKsc-Regular.ttf> <SweiGothicCJKsc-Bold.ttf>
字体来源：https://github.com/max32002/swei-gothic （CJK SC 目录）
依赖：fonttools、brotli。

切法：先放网页当前用到的字（按出现频率），再放 GB2312 一级、二级常用字，每 300 字一包。
浏览器只下载页面上真的出现了的那几包；以后新增记录里的字大多已在常用字包里。
"""
import collections, glob, os, re, sys

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "fonts")
CHUNK = 300
FAMILY = "Swei Gothic"

PUNCT = [c for a, b in [(0x2010, 0x2027), (0x2030, 0x205E), (0x2190, 0x21FF), (0x3000, 0x303F), (0xFF00, 0xFFEF)] for c in range(a, b + 1)] + [0xB7, 0xD7]


def is_cjk(cp):
    return 0x3400 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF


def site_chars():
    files = [os.path.join(ROOT, "index.html")] + glob.glob(os.path.join(ROOT, "data", "*.csv")) + glob.glob(os.path.join(ROOT, "data", "*.json"))
    cnt = collections.Counter()
    for f in files:
        cnt.update(ord(c) for c in open(f, encoding="utf-8-sig", errors="ignore").read() if is_cjk(ord(c)))
    return [cp for cp, _ in cnt.most_common()]


def gb2312(level):
    rows = range(0xB0, 0xD8) if level == 1 else range(0xD8, 0xF8)
    out = []
    for hi in rows:
        for lo in range(0xA1, 0xFF):
            try:
                out.append(ord(bytes([hi, lo]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    return out


def ranges(cps):
    cps = sorted(cps)
    parts, start, prev = [], cps[0], cps[0]
    for cp in cps[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        parts.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        if cp is not None:
            start = prev = cp
    return ",".join(parts)


def main(regular, bold):
    os.makedirs(OUT, exist_ok=True)
    for f in glob.glob(os.path.join(OUT, "swei-*.woff2")):
        os.remove(f)
    cmap = set(TTFont(regular, lazy=True).getBestCmap())
    order, seen = [], set()
    for cp in site_chars() + gb2312(1) + gb2312(2):
        if cp in cmap and cp not in seen:
            seen.add(cp); order.append(cp)
    punct = [cp for cp in PUNCT if cp in cmap]
    chunks = [punct + order[:CHUNK]] + [order[i:i + CHUNK] for i in range(CHUNK, len(order), CHUNK)]
    css = [f"/* {FAMILY}（狮尾黑体）by Max32002，SIL Open Font License 1.1，见 assets/fonts/OFL.txt。由 tools/build_fonts.py 生成，请勿手改。 */"]
    import io
    for tag, path, weight in [("r", regular, 400), ("b", bold, 700)]:
        if path.lower().endswith((".ttf", ".otf")):
            raw = io.BytesIO(open(path, "rb").read())
        else:  # woff / woff2 先解压一次（较慢，建议直接用 .ttf）
            raw = io.BytesIO(); src = TTFont(path); src.flavor = None; src.save(raw)
        for i, cps in enumerate(chunks):
            raw.seek(0); font = TTFont(raw)
            opt = Options(); opt.flavor = "woff2"; opt.hinting = False; opt.desubroutinize = True; opt.name_IDs = ["*"]; opt.notdef_outline = True
            sub = Subsetter(opt); sub.populate(unicodes=cps); sub.subset(font)
            name = f"swei-{tag}-{i:02d}.woff2"
            font.flavor = "woff2"; font.save(os.path.join(OUT, name))
            css.append(f'@font-face{{font-family:"{FAMILY}";font-style:normal;font-weight:{weight};font-display:swap;'
                       f'src:url({name}) format("woff2");unicode-range:{ranges(cps)}}}')
    open(os.path.join(OUT, "fonts.css"), "w", encoding="utf-8").write("\n".join(css) + "\n")
    total = sum(os.path.getsize(f) for f in glob.glob(os.path.join(OUT, "swei-*.woff2")))
    print(f"{len(chunks)} 包 × 2 字重，{len(order)} 字，共 {total / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
