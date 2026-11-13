#!/usr/bin/env python3
"""
竞品促销雷达 · 每日监测机器人（GitHub Actions 定时运行，只用 Python 标准库）

做三件事：
1. 复查每条记录的来源网址：内容变化 / 无法访问 / 出现「已结束」字样 → 写入 data/monitor.json，网页自动标记“待核”。
2. 扫描 data/watchlist.csv 里的活动列表页：出现新的活动链接 → 列入“疑似新活动”。
3. （可选）设置了 AI_API_KEY 时，把有变化的页面交给 AI，生成“建议更新内容”，同事核对后一键复制进表格。

环境变量（都在 GitHub 仓库 Settings → Secrets and variables → Actions 里设置，都可以不设）：
  SHEET_CSV_URL   Google 表格“发布到网络”的 CSV 链接；不设则读 data/records.csv
  AI_API_KEY      AI 服务的 key；不设则跳过第 3 步
  AI_PROVIDER     anthropic | openai（默认 anthropic；openai 兼容接口也可用于 DeepSeek、Gemini 等）
  AI_BASE_URL     openai 兼容接口地址，例如 https://api.deepseek.com/v1
  AI_MODEL        模型名，例如 claude-haiku-5-5 / gpt-4o-mini / deepseek-chat
  AI_MAX_RECORDS  每次最多让 AI 处理几条（默认 15，用来控制费用）
"""
import csv, datetime as dt, difflib, hashlib, html, io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "monitor.json")
SNAP_DIR = os.path.join(ROOT, "monitor", "snapshots")
WATCHLIST = os.path.join(ROOT, "data", "watchlist.csv")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TODAY = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()  # 吉隆坡时间
ENDED = re.compile(r"(promotion (has )?(ended|expired|closed)|campaign (has )?ended|offer (has )?(ended|expired)|no longer (available|valid)|"
                   r"competition (has )?(ended|closed)|活动已结束|活动已截止|已过期|已结束|ha finalizado|ha terminado|finalizada|"
                   r"telah berakhir|sudah berakhir|đã kết thúc|สิ้นสุดแล้ว|انتهى العرض|انتهت)", re.I)
PROMO_LINK = re.compile(r"(promo|promotion|bonus|cashback|rebate|contest|competition|cup|campaign|reward|giveaway|lucky|draw|"
                        r"challenge|festival|tournament|loyalty|refer|活动|优惠|赠金|返现|大赛|比赛|抽奖|奖励|promoción|concurso|bono|hadiah|kontes)", re.I)


def log(*a): print(*a, flush=True)


def env(name, default=""):
    """GitHub 里没设置的变量会以空字符串传进来，这里统一当作“未设置”，用默认值。"""
    v = (os.environ.get(name) or "").strip()
    return v if v else default


def load_records():
    url = env("SHEET_CSV_URL")
    if not url:  # 没在 GitHub 里设变量时，直接用网页 config.js 里填的同一个链接
        try:
            m = re.search(r"sheetCsvUrl:\s*['\"]([^'\"]+)['\"]", open(os.path.join(ROOT, "config.js"), encoding="utf-8").read())
            url = m.group(1).strip() if m else ""
        except Exception:
            url = ""
    if url:
        try:
            text = fetch(url, raw=True)[1]
            log("records: Google Sheet")
            return list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
        except Exception as e:
            log("Google Sheet 读取失败，改用 data/records.csv：", e)
    with open(os.path.join(ROOT, "data", "records.csv"), encoding="utf-8-sig") as f:
        log("records: data/records.csv")
        return list(csv.DictReader(f))


def fetch(url, raw=False, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,zh;q=0.8", "Accept": "text/html,application/xhtml+xml,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        body = r.read(4_000_000)
        enc = (re.search(r"charset=([\w-]+)", ctype) or [None, "utf-8"])[1]
        return r.status, body.decode(enc, "replace") if raw or "text" in ctype or "html" in ctype or "json" in ctype else "", ctype, r.geturl()


def visible_text(page):
    page = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?is)<!--.*?-->", " ", page)
    page = re.sub(r"(?i)<(br|/p|/div|/li|/h\d|/tr|/section|/article)[^>]*>", "\n", page)
    page = html.unescape(re.sub(r"(?s)<[^>]+>", " ", page))
    lines = [re.sub(r"\s+", " ", l).strip() for l in page.split("\n")]
    # 去掉明显每次都会变的噪声（时间戳、计数器、随机 token）
    lines = [l for l in lines if len(l) > 2 and not re.fullmatch(r"[\d\s:/.,-]+", l)]
    return "\n".join(lines)


# ---------- 判断“真变化”还是噪声 ----------
BLOCKED = re.compile(r"just a moment|checking your browser|enable javascript and cookies|attention required|verify you are (a )?human|"
                     r"are you a robot|captcha|access denied|request blocked|pardon our interruption|ddos protection|incapsula|"
                     r"cf-chl|bot verification|security check|请稍候|安全验证|人机验证", re.I)
MONEY = re.compile(r"[$€£¥%]|usd|usdt|eur|美元|赠金|贈金|bonus|deposit|入金|cashback|rebate|返佣|返现|prize|奖金|lot|手|cpa", re.I)


RELEVANT = re.compile(r"[$€£¥%٪]|\d+\s*(usd|usdt|eur|美元|万)|promo|bonus|bono|bônus|contest|concurso|competi|campaign|campaña|reward|"
                      r"cashback|rebate|prize|premio|deposit|dep[oó]sito|credit|cr[eé]dito|terms|t&c|eligib|expire|ended|valid|"
                      r"terminad|finaliz|encerrad|until|deadline|period|tournament|lucky|draw|giveaway|loyalty|cpa|commission|"
                      r"comisi|rebat|ib\b|partner|socio|活动|活動|赠金|贈金|奖|獎|返现|返佣|入金|截止|结束|結束|条款|條款|大赛|大賽|"
                      r"promosi|hadiah|kontes|khuyến mãi|thưởng|โบนัส|โปรโมชั่น|مكافأة|بونص|\bعرض\b|مسابقة|جائزة|بونوس|پاداش|مسابقه|جایزه|"
                      r"کش ?بک|تخفیف|اعتبار", re.I)
# 第三方新闻 / 媒体页：正文发布后基本不变，变的只是侧栏推荐，所以不提醒内容变化（仍检查“已结束”和能否打开）
MEDIA = re.compile(r"bernama|businessfocus|prnasia|prnewswire|globenewswire|businesswire|einpresswire|financefeeds|financemagnates|"
                   r"investinglive|forexlive|invezz|macaubusiness|fastbull|sina\.c|webmobi|leaprate|fxnewsgroup|tradersunion|aap\.com|"
                   r"theblock|decrypt|mexc\.com/news|yahoo|marketscreener|ffnews|mpost|itiger|forklog|techloy|benzinga|cointelegraph|"
                   r"tradeinformer|/news/|/article|/releases?/|/press|/blog/|company-news|market-analysis|analize|/insights|webinar", re.I)


# 风险提示 / 公司注册信息这类页脚，各语言版本经常改，跟活动无关
DISCLAIMER = re.compile(r"regulated by|authori[sz]ed|not intended for distribution|complex instruments|risk of losing|lose money|"
                        r"losing money|verlieren geld|operated by|strictly intended|registration number|registered (office|address)|"
                        r"skip to content|neither established|all rights reserved|cookie|privacy policy|下载 app|风险提示|風險提示", re.I)


def is_blocked(text, prev_len=0):
    """网站返回的是验证 / 拦截页，而不是真正的活动页。"""
    t = text or ""
    if len(t) < 1500 and BLOCKED.search(t): return True
    return prev_len > 3000 and len(t) < prev_len * 0.15 and len(t) < 600   # 页面突然几乎空白，多半是被拦截


def _n(l): return re.sub(r"\s+", "", l or "").lower()


def meaningful(added, removed, url=""):
    """把 diff 里的噪声去掉：媒体页侧栏、换行/空白差异、重复出现的同一句、随机码、与活动无关的句子（导航、帮助中心、推荐文章），
    以及排行榜和时间这类只有数字在跳的行。"""
    if url and MEDIA.search(url): return [], []
    added = [l for l in added if RELEVANT.search(l) and not DISCLAIMER.search(l)]
    removed = [l for l in removed if RELEVANT.search(l) and not DISCLAIMER.search(l)]
    na, nr = {_n(l) for l in added}, {_n(l) for l in removed}
    a = [l for l in added if _n(l) not in nr]
    r = [l for l in removed if _n(l) not in na]
    if "".join(map(_n, a)) == "".join(map(_n, r)): return [], []          # 只是换行方式变了
    token = re.compile(r"[A-Za-z0-9+/=_\-]{28,}")
    rank = re.compile(r"^\s*(#|no\.?\s*)?\d{1,3}[.)]?\s+\S.{0,70}\d")   # 排行榜的一行：名次 + 昵称 + 数字
    a = [l for l in a if not token.fullmatch(l.strip()) and not (len(l) < 90 and rank.match(l))]
    r = [l for l in r if not token.fullmatch(l.strip()) and not (len(l) < 90 and rank.match(l))]
    dig = lambda l: re.sub(r"\d+([.,]\d+)*", "#", _n(l))
    da, dr = {dig(l) for l in a}, {dig(l) for l in r}
    pairs = da & dr
    board = len(pairs) >= 4   # 很多行只有数字在变：排行榜、计数器
    a = [l for l in a if dig(l) not in pairs or (not board and MONEY.search(l))]
    r = [l for l in r if dig(l) not in pairs or (not board and MONEY.search(l))]
    return a, r


def signature(text):
    """按“去掉空白后的句子集合”算指纹：顺序调换、重复句、换行都不算变化。"""
    return hashlib.sha1("\n".join(sorted({_n(l) for l in (text or "").splitlines() if _n(l)})).encode("utf-8", "replace")).hexdigest()


def links(page, base):
    out = {}
    for href, text in re.findall(r'(?is)<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', page):
        t = re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", " ", text))).strip()
        u = urllib.parse.urljoin(base, href.strip())
        if u.startswith("http") and (PROMO_LINK.search(u) or PROMO_LINK.search(t)):
            out[u.split("?")[0].rstrip("/")] = t[:120]
    return out


def snap_path(url):
    return os.path.join(SNAP_DIR, hashlib.sha1(url.encode()).hexdigest()[:16] + ".txt")


def check_url(url, prev):
    prev = prev or {}
    res = {"url": url, "checked": TODAY}
    keep = lambda: [res.__setitem__(k, prev[k]) for k in ("hash", "sig", "changed", "minor", "last_ok", "added", "removed") if prev.get(k)]
    try:
        status, page, ctype, final = fetch(url)
        res["http"] = status
        if "pdf" in ctype.lower():
            text = ""; res["kind"] = "pdf"   # PDF：只比较哈希，不解析内容
        else:
            text = visible_text(page)
        sp = snap_path(url)
        old_text = open(sp, encoding="utf-8").read() if text and os.path.exists(sp) else ""
        if text and is_blocked(text, len(old_text)):
            res.update(error="被网站拦截（验证页）"); keep(); res["_text"] = ""; return res
        res["hash"] = hashlib.sha1((text or page).encode("utf-8", "replace")).hexdigest()
        res["sig"] = signature(text) if text else res["hash"]
        res["final_url"] = final if final != url else ""
        res["changed"], res["minor"] = prev.get("changed", ""), prev.get("minor", "")
        for k in ("added", "removed"):
            if prev.get(k): res[k] = prev[k]
        if not prev.get("sig"):
            # 第一次用新指纹：只建基线；顺便用新规则重新判断以前标出的变化，噪声就撤掉
            if res["changed"]:
                a, r = meaningful(prev.get("added", []), prev.get("removed", []), url)
                if not a and not r: res["changed"] = ""; res.pop("added", None); res.pop("removed", None)
        elif prev["sig"] != res["sig"]:
            if old_text:
                old = old_text.splitlines(); new = text.splitlines()
                on, nn = {_n(l) for l in old}, {_n(l) for l in new}
                a, r = meaningful([l for l in new if _n(l) not in on], [l for l in old if _n(l) not in nn], url)
            else:
                a, r = ["（页面内容有变化）"], []
            if a or r:
                res["changed"] = TODAY; res["added"] = [l[:200] for l in a[:6]]; res["removed"] = [l[:200] for l in r[:6]]
            else:
                res["minor"] = TODAY   # 只有数字 / 排版在变，不提醒
        m = ENDED.search(text or "")
        res["ended_hint"] = m.group(0) if m else ""
        res["error"] = ""
        res["last_ok"] = TODAY
        if text:
            os.makedirs(SNAP_DIR, exist_ok=True)
            open(sp, "w", encoding="utf-8").write(text[:200_000])
        res["_text"] = text
        res["_page"] = page
    except urllib.error.HTTPError as e:
        res.update(http=e.code, error=("页面不存在（%s）" % e.code) if e.code in (404, 410) else ("访问被拒绝或出错（%s）" % e.code)); keep()
    except Exception as e:
        res.update(error="无法访问：" + type(e).__name__); keep()
    return res


def _domain(u):
    return re.sub(r"^www\.", "", urllib.parse.urlparse(u).netloc.lower())


def domain_lines(texts):
    from collections import Counter, defaultdict
    per = defaultdict(Counter)
    for u, t in texts.items():
        for l in {_n(x) for x in (t or "").splitlines() if _n(x)}: per[_domain(u)][l] += 1
    return per


def drop_template_changes(url_state, texts, prev_urls, old_texts=None):
    """同一网站多个页面都出现的句子（页脚免责声明、导航栏）是网站模板，模板改了不算活动变化。"""
    from collections import Counter, defaultdict
    per, per_old = domain_lines(texts), domain_lines(old_texts or {})
    in_diffs = defaultdict(Counter)   # 同一句变化同时出现在同网站 2 个以上页面 → 网站改版（导航 / 页脚），不是某个活动变了
    for u, st in url_state.items():
        if st.get("changed"):
            for l in {_n(x) for x in st.get("added", []) + st.get("removed", [])}: in_diffs[_domain(u)][l] += 1
    for u, st in url_state.items():
        if not st.get("changed"): continue
        tpl = ({l for l, c in per[_domain(u)].items() if c >= 2} | {l for l, c in per_old[_domain(u)].items() if c >= 2}
               | {l for l, c in in_diffs[_domain(u)].items() if c >= 2})
        heads = {l[:40] for l in tpl if len(l) >= 40}
        is_tpl = lambda l: _n(l) in tpl or (len(_n(l)) >= 40 and _n(l)[:40] in heads)
        a = [l for l in st.get("added", []) if not is_tpl(l)]
        r = [l for l in st.get("removed", []) if not is_tpl(l)]
        if a == st.get("added", []) and r == st.get("removed", []): continue
        if a or r:
            st["added"], st["removed"] = a, r
        else:
            old = (prev_urls.get(u) or {})
            fresh = st["changed"] == TODAY and old.get("changed", "") != TODAY
            st["changed"] = old.get("changed", "") if fresh and old.get("sig") else ""
            st["minor"] = TODAY
            for k in ("added", "removed"):
                if old.get(k) and st["changed"]: st[k] = old[k]
                else: st.pop(k, None)


def ai_suggest(record, page_text, cols):
    key = env("AI_API_KEY")
    if not key: return None
    provider = env("AI_PROVIDER", "anthropic").lower()
    model = env("AI_MODEL", "claude-haiku-5-5" if provider == "anthropic" else "gpt-4o-mini")
    core = ["品牌", "对象", "地区", "活动类型", "奖励性质", "标题", "奖励摘要", "给谁", "门槛", "可参考点", "开始日期", "截止日期", "人工状态", "活动说明", "完整条款", "国家资格", "限制国家", "签约实体", "待核事项"]
    old = {k: record.get(k, "") for k in core}
    prompt = (
        "你在维护一个外汇/CFD 券商促销活动数据库。下面是数据库里的旧记录，以及该活动来源网页的最新文字。\n"
        "请对比后输出 JSON（只输出 JSON，不要解释）：\n"
        '{"change_summary":"用一两句中文说明网页相对旧记录有什么实质变化；没有实质变化就写 无实质变化",'
        '"likely_ended":true/false,"fields":{只包含需要修改的字段，字段名必须来自旧记录}}\n'
        "规则：金额保留原币种；日期用 YYYY-MM-DD；赠金(不可提现信用额)与现金要区分；不确定的不要改，写进 待核事项。\n\n"
        f"旧记录：{json.dumps(old, ensure_ascii=False)}\n\n网页最新文字（截断）：\n{page_text[:12000]}"
    )
    try:
        if provider == "anthropic":
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps({
                "model": model, "max_tokens": 1200, "messages": [{"role": "user", "content": prompt}]}).encode(),
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.loads(r.read())["content"][0]["text"]
        else:
            base = env("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
            req = urllib.request.Request(base + "/chat/completions", data=json.dumps({
                "model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0}).encode(),
                headers={"Authorization": "Bearer " + key, "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.loads(r.read())["choices"][0]["message"]["content"]
        j = json.loads(re.search(r"\{.*\}", out, re.S).group(0))
        fields = {k: str(v) for k, v in (j.get("fields") or {}).items() if k in core}
        merged = {c: fields.get(c, record.get(c, "")) for c in cols}
        merged["最后核查"] = TODAY
        merged["更新人"] = "AI 建议（待人工确认）"
        tsv = "\t".join(str(merged.get(c, "")).replace("\t", " ").replace("\n", " ") for c in cols)
        return {"date": TODAY, "summary": j.get("change_summary", ""), "likely_ended": bool(j.get("likely_ended")), "fields": fields, "tsv": tsv}
    except Exception as e:
        log("AI 失败：", record.get("ID"), e)
        return None


def load_auto():
    p = os.path.join(ROOT, "data", "auto_records.csv")
    if not os.path.exists(p): return []
    with open(p, encoding="utf-8-sig") as f: return list(csv.DictReader(f))


def main():
    records = load_records()
    ids = {r.get("ID") for r in records}
    records += [r for r in load_auto() if r.get("ID") not in ids]  # 自动发现的记录也每天复查
    cols = list(records[0].keys()) if records else []
    prev = {}
    if os.path.exists(OUT):
        try: prev = json.load(open(OUT, encoding="utf-8"))
        except Exception: prev = {}
    prev_urls = prev.get("urls", {})

    # 1) 来源网址
    urls = sorted({u.strip() for r in records for u in re.split(r"\s*\|\s*|\n", r.get("来源链接", "")) if u.strip().startswith("http")})
    log(f"{len(records)} 条记录，{len(urls)} 个来源网址")
    old_texts = {u: open(snap_path(u), encoding="utf-8").read() for u in urls if os.path.exists(snap_path(u))}
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda u: check_url(u, prev_urls.get(u)), urls))
    texts = {r["url"]: r.pop("_text", "") for r in results}
    for r in results: r.pop("_page", None)
    url_state = {r["url"]: r for r in results}
    drop_template_changes(url_state, texts, prev_urls, old_texts)

    # 每条记录汇总：变化日期晚于“最后核查”才算需要处理
    rec_state, ai_budget = {}, int(env("AI_MAX_RECORDS", "15")) if env("AI_MAX_RECORDS", "15").isdigit() else 15
    prev_rec = prev.get("records", {})
    for r in records:
        rid = r.get("ID") or ""
        if not rid: continue
        us = [url_state[u] for u in re.split(r"\s*\|\s*|\n", r.get("来源链接", "")) if u.strip() in url_state]
        checked_by_human = (r.get("最后核查") or "")[:10]
        changed = max([u.get("changed", "") for u in us] or [""])
        st = {
            "checked": TODAY,
            "changed": changed if changed and changed > checked_by_human else "",
            "unreachable": [u["url"] for u in us if u.get("error")],
            "errors": sorted({u["error"] for u in us if u.get("error")}),
            "ended_hint": next((u["ended_hint"] for u in us if u.get("ended_hint")), ""),
            "added": next((u.get("added") for u in us if u.get("added")), []),
            "removed": next((u.get("removed") for u in us if u.get("removed")), []),
            "sources_ok": sum(1 for u in us if not u.get("error")), "sources_total": len(us),
        }
        old_ai = (prev_rec.get(rid) or {}).get("ai")
        if old_ai and old_ai.get("date", "") > checked_by_human: st["ai"] = old_ai
        need_ai = st["changed"] and (not old_ai or old_ai.get("date", "") < st["changed"])
        if need_ai and ai_budget > 0:
            text = "\n\n".join(texts.get(u["url"], "") for u in us)[:15000]
            if text.strip():
                sug = ai_suggest(r, text, cols)
                if sug: st["ai"] = sug; ai_budget -= 1
        rec_state[rid] = st

    # 2) 活动列表页 → 疑似新活动
    known = {u.split("?")[0].rstrip("/") for r in records for u in re.split(r"\s*\|\s*|\n", r.get("来源链接", "")) if u.strip()}
    watch_prev = prev.get("watch", {})
    discoveries = [d for d in prev.get("discoveries", []) if d.get("url") not in known]
    seen_disc = {d["url"] for d in discoveries}
    watch_state = {}
    if os.path.exists(WATCHLIST):
        with open(WATCHLIST, encoding="utf-8-sig") as f:
            watch = [w for w in csv.DictReader(f) if (w.get("网址") or "").startswith("http")]
        for w in watch:
            url = w["网址"].strip()
            try:
                status, page, ctype, final = fetch(url)
                ls = links(page, final)
                old_links = set((watch_prev.get(url) or {}).get("links", []))
                first_run = url not in watch_prev
                for lu, lt in ls.items():
                    if not first_run and lu not in old_links and lu not in known and lu not in seen_disc:
                        discoveries.append({"brand": w.get("品牌", ""), "region": w.get("地区", ""), "title": lt or lu, "url": lu, "from": url, "first_seen": TODAY})
                        seen_disc.add(lu)
                watch_state[url] = {"checked": TODAY, "links": sorted(ls.keys())[:400], "error": ""}
            except Exception as e:
                watch_state[url] = {"checked": TODAY, "links": (watch_prev.get(url) or {}).get("links", []), "error": type(e).__name__}
            time.sleep(0.5)
    discoveries = sorted(discoveries, key=lambda d: d["first_seen"], reverse=True)[:200]

    out = {
        "generated": TODAY, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "ai_enabled": bool(env("AI_API_KEY")),
        "summary": {
            "records": len(rec_state), "urls": len(urls),
            "changed": sum(1 for s in rec_state.values() if s["changed"]),
            "unreachable": sum(1 for s in rec_state.values() if s["unreachable"] and s["sources_ok"] == 0),
            "ended_hint": sum(1 for s in rec_state.values() if s["ended_hint"]),
            "new": sum(1 for d in discoveries if d["first_seen"] == TODAY), "discoveries": len(discoveries),
        },
        "records": rec_state, "urls": url_state, "watch": watch_state, "discoveries": discoveries,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("完成：", json.dumps(out["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
