#!/usr/bin/env python3
"""
竞品促销雷达 · 全市场新活动发现 + 自动建档（GitHub Actions 每天运行，只用 Python 标准库）

信息来源（都可以在 data/discovery_sources.csv 里增删）：
  - Google 新闻搜索：按「品牌 × 促销关键词」和「通用活动关键词」自动生成查询（英文 / 繁中 / 简中 / 马来）
  - 行业媒体与通稿的 RSS（Finance Magnates、FX News Group、LeapRate、FinanceFeeds……）
  - 公开 Telegram 频道（t.me/s/频道名，无需登录的网页版）
  - 任意网页（会提取页面上像活动的链接）

流程：抓取 → 按「已跟踪品牌 + 促销关键词」筛选 → 去重 → 自动建档写入 data/auto_records.csv
  - 没有 AI key：用规则提取 品牌 / 对象 / 地区 / 活动类型 / 金额 / 来源 / 日期
  - 有 AI key：AI 先判断是否真的是促销活动（不是就丢掉），再补全门槛、起止日期等字段

人工数据（data/records.csv 或 Google 表格）与自动数据（data/auto_records.csv）分开存放；
同事把某条自动记录确认后复制进人工数据（同一个 ID），网页会以人工版本为准。
"""
import csv, datetime as dt, difflib, email.utils, hashlib, html, io, json, os, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import env, fetch, visible_text, log, load_records  # 复用监测程序的工具函数

AUTO = os.path.join(ROOT, "data", "auto_records.csv")
STATE = os.path.join(ROOT, "data", "discovery.json")
SOURCES = os.path.join(ROOT, "data", "discovery_sources.csv")
KL = dt.timezone(dt.timedelta(hours=8))
TODAY = dt.datetime.now(KL).date()
LOOKBACK_DAYS = int(env("DISCOVERY_LOOKBACK_DAYS", "10")) if env("DISCOVERY_LOOKBACK_DAYS", "10").isdigit() else 10
DUP_WINDOW_DAYS = 30  # 同一品牌 30 天内主题相近的新闻，视为同一活动，只留一条
STALE_DAYS = 60  # 自动记录超过 60 天且没有截止日期，就不再算“在列”

HEAD = ["ID", "品牌", "对象", "地区", "活动类型", "奖励性质", "标题", "奖励摘要", "给谁", "门槛", "可参考点",
        "开始日期", "截止日期", "人工状态", "不计入在列", "活动说明", "完整条款", "国家资格", "限制国家", "国家备注",
        "签约实体", "客户类别", "零售限制", "产品范围", "金额上限", "日期说明", "IB支持", "办公室支持", "活动支持",
        "预付机制", "支付窗口", "赠金与IB佣金", "公开披露观察", "其他限制", "限制来源范围", "待核事项", "证据注释",
        "研究备注", "来源链接", "来源日期", "截图链接", "截图说明", "原始英文", "精选排序", "最后核查", "更新人"]

# ---------- 品牌识别 ----------
# 显示名 → 搜索 / 匹配用的别名（大小写不敏感，按词边界匹配）
CORE = {
    "D Prime": ["D Prime", "Doo Prime", "DooTrader"],
    "EC Markets": ["EC Markets"], "EBC": ["EBC Financial", "EBC Group", "EBC金融", "EBC 金融"], "IC Markets (IC)": ["IC Markets", "IC Trading"],
    "Exness": ["Exness"], "Bybit": ["Bybit"], "XM": ["XM.com", "XM Global", "XM broker", "XM Arabia", "XM 外汇"],
    "Pepperstone": ["Pepperstone"], "FxPro": ["FxPro"], "Axi": ["AxiTrader", "Axi Select", "Axi broker", "Axi Financial"],
    "WeTrade": ["WeTrade"], "Hantec Markets": ["Hantec", "亨达金融", "亨達金融", "亨达", "亨達"], "ATFX": ["ATFX"], "Tickmill": ["Tickmill"],
    "AvaTrade": ["AvaTrade"], "FXCM": ["FXCM"], "FOREX.com": ["FOREX.com"], "TMGM": ["TMGM", "TMGM 外汇", "TMGM外匯"],
    "Ultima Markets": ["Ultima Markets"],
}


def brand_aliases(records):
    aliases = {k: list(v) for k, v in CORE.items()}
    for r in records:
        b = (r.get("品牌") or "").strip()
        if b and b not in aliases and len(b) >= 3:
            aliases[b] = [b]
    return aliases


def compile_brands(aliases):
    pats = []
    for brand, names in aliases.items():
        for n in names:
            pats.append((brand, re.compile(r"(?<![A-Za-z0-9.])" + re.escape(n) + r"(?![A-Za-z0-9])", re.I)))
    return pats


def find_brand(text, pats):
    hits = {}
    for brand, p in pats:
        m = p.search(text)
        if m: hits.setdefault(brand, m.start())
    return min(hits, key=hits.get) if hits else ""


# ---------- 关键词 ----------
PROMO = re.compile(r"(trading (competition|contest|cup|challenge|championship|tournament|festival)|demo (competition|contest)|"
                   r"\bcontest\b|\bcompetition\b|\btournament\b|\bchampionship\b|\bpromotion\b|\bpromo\b|deposit bonus|welcome bonus|no[- ]deposit|\bbonus\b|cashback|"
                   r"cash back|rebate|giveaway|lucky draw|lucky spin|prize pool|\bprizes?\b|sweepstake|refer[- ]a[- ]friend|"
                   r"loyalty (program|programme)|reward|campaign|challenge|\bcup\b|"
                   r"交易大赛|交易赛|模拟赛|比赛|大赛|活动|优惠|赠金|赠送|返现|返佣|抽奖|奖金|奖池|奖品|奖励|推荐好友|"
                   r"交易大賽|比賽|活動|優惠|贈金|返現|抽獎|獎金|獎池|獎勵|"
                   r"concurso|competencia|promoción|bono|sorteo|premio|kontes|hadiah|bonus deposit|pertandingan)", re.I)
NOT_PROMO = re.compile(r"(appoints|hires|joins as|steps down|fined|penalt|lawsuit|license|licence|quarterly results|"
                       r"trading volume|earnings|revenue|acquires|acquisition|outage|scam warning|clone|"
                       r"referral code|promo code|coupon|invite code|sign[- ]?up bonus code|"  # 第三方推荐码 / 优惠码广告页
                       r"hold ?& ?earn|launchpool|launchpad|airdrop|staking|savings|\bAPR\b|\bAPY\b|"  # 加密理财，不是交易促销
                       r"seeks .*partnership|enters? the (us|u\.s\.)|market entry|partnership with)", re.I)

TYPE_RULES = [
    ("IB 奖励", r"\b(IB|introducing broker|partner|affiliate)s?\b.*(cup|contest|competition|reward|bonus|ladder|prize)|代理|合作伙伴奖励"),
    ("模拟赛", r"demo (trading )?(competition|contest|cup)|模拟赛|模擬賽|virtual (funds|capital)|模拟交易|模擬交易|虚拟资金|虛擬資金"),
    ("交易大赛", r"(trading )?(competition|contest|cup|championship|tournament|challenge|festival)|交易大赛|交易大賽|大赛|比赛|比賽|concurso|kontes"),
    ("抽奖", r"lucky (draw|spin)|giveaway|sweepstake|raffle|抽奖|抽獎|sorteo"),
    ("返现", r"cash ?back|rebate|返现|返現|返佣"),
    ("推荐好友", r"refer[- ]a[- ]friend|referral|推荐好友|推薦好友"),
    ("入金赠金", r"deposit bonus|welcome bonus|no[- ]deposit|\bbonus\b|赠金|贈金|bono|bonus deposit"),
    ("积分奖励", r"loyalty|points|积分|積分"),
]
REGION_RULES = [  # 顺序有意义：同时提到泰国、印尼等和新马时，归东南亚；只提港澳台、新马或华人时，归华语
    ("东南亚", r"thailand|thai|indonesia|vietnam|philippines|cambodia|myanmar|south ?east asia|\bSEA\b|泰国|印尼|越南|菲律宾"),
    ("华语", r"taiwan|hong kong|macau|greater china|singapore|malaysia|chinese|台湾|台灣|香港|澳门|新加坡|马来西亚|馬來西亞|华人|華人"),
    ("中东北非", r"\bUAE\b|dubai|abu dhabi|saudi|qatar|kuwait|bahrain|oman|egypt|jordan|morocco|\bMENA\b|middle east|gcc|迪拜|中东"),
    ("伊朗/伊拉克", r"\biran\b|\biraq\b"),
    ("拉美", r"mexico|brazil|argentina|colombia|chile|peru|ecuador|latam|latin america|拉美|墨西哥|巴西|阿根廷"),
    ("非洲", r"africa|nigeria|kenya|ghana|south africa|tanzania|uganda|非洲"),
    ("欧洲", r"europe|\bEU\b|\bUK\b|united kingdom|cyprus|germany|spain|italy|poland|欧洲"),
]
MONEY = re.compile(r"((?:US\$|USD|\$|€|£|EUR|USDT)\s?[\d,.]+\s?(?:k|K|m|M|million|万|千)?(?:\s?(?:USD|USDT))?|"
                   r"[\d,.]+\s?(?:万|千)?\s?(?:美元|美金|USD|USDT|欧元)|[\d,.]+\s?(?:million|k)\s?(?:USD|dollars))", re.I)
IB_RE = re.compile(r"\b(IB|IBs|introducing broker|partners? program|affiliates?)\b|代理|介绍经纪人", re.I)


def guess(rules, text, default):
    for label, pat in rules:
        if re.search(pat, text, re.I): return label
    return default


def norm_title(t):
    return re.sub(r"[\W_]+", "", (t or "").lower())[:90]


# 加密交易所：只收和 CFD / 传统金融（TradFi）相关的活动，币圈专属玩法（空投、理财、永续期权、社区任务）不收
CRYPTO_BRANDS = {"Bybit"}
CRYPTO_MAX_PER_DAY = 1
TRADFI = re.compile(r"tradfi|\bstocks?\b|equit|\bgold\b|forex|\bfx\b|\bcfds?\b|\bmt5\b|metatrader|indices|\bindex\b|"
                    r"外汇|外匯|黄金|黃金|股票|美股|港股|差价合约|差價合約|指数|指數", re.I)
_COMMON_CAPS = {"USDT", "USDC", "USD", "RWA", "RWAS", "CFD", "CFDS", "MT5", "MT4", "NFT", "ETF", "KYC", "VIP", "BTC", "ETH",
                "CEO", "APR", "APY", "IPO", "UAE", "LIVE", "NEW", "THE", "AND", "FOR", "WITH", "TRADFI", "AI", "IB", "FX"}


_SYMBOL = re.compile(r"^((XAU|XAG|EUR|USD|GBP|JPY|AUD|NZD|CAD|CHF|BTC|ETH)[A-Z]{3}|US\d{2,3}|NAS\d+|SPX\d*|GER\d+|UK\d+|HK\d+)$")  # 交易品种代码不是活动名


def event_keys(title, brand=""):
    """同一活动的不同报道（中英文、不同媒体）通常共用活动缩写（如 WSOT）或同一奖金数额，用来合并重复报道。"""
    t = title or ""
    own = {w.upper() for n in [brand] + CORE.get(brand, []) for w in re.findall(r"[A-Za-z0-9]+", n)}
    keys = {w for w in re.findall(r"(?<![A-Za-z0-9])[A-Z][A-Z0-9]{2,}(?![A-Za-z0-9])", t) if w not in _COMMON_CAPS and w not in own and not _SYMBOL.match(w)}
    for m in re.findall(r"第\s*([一二三四五六七八九十百\d]+)\s*[届屆期季]|\bseason\s*(\d+)|\bS(\d{1,2})\b", t, re.I):
        keys.add("#ed" + next(x for x in m if x))   # 第十二届 / Season 18：届次
    for num, unit in re.findall(r"(\d[\d,\.]*)\s*(million|m\b|万|萬|k\b)?", t, re.I):
        n = num.replace(",", "").rstrip(".")
        try: v = float(n)
        except ValueError: continue
        u = (unit or "").lower()
        v *= 1e6 if u in ("million", "m") else 1e4 if u in ("万", "萬") else 1e3 if u == "k" else 1
        if v >= 1000 and not (1990 <= v <= 2100): keys.add(f"${int(v)}")
    return keys


_STOP = set("""a an the and or of for to in on with by at from as is are be its it this that new now first final last
launch launches launched launching announce announces announced unveil unveils unveiled introduce introduces host hosts hosted
kick kicks off returns return back coming expands expand enable enables offer offers offering via up more than top best
trading trade trader traders traders' market markets broker brokers forex cfd cfds clients client users user customers
global official live days day week weeks month event events assets amount pool direct over requirement 2025 2026 2027""".split())
_SYN = {"xauusd": "gold", "黄金": "gold", "黃金": "gold", "stocks": "stock", "shares": "stock", "股票": "stock", "美股": "stock",
        "promotion": "#promo", "promo": "#promo", "campaign": "#promo", "challenge": "#promo", "contest": "#promo",
        "competition": "#promo", "tournament": "#promo", "championship": "#promo", "cup": "#promo", "bonus": "#promo",
        "prize": "#promo", "giveaway": "#promo", "rewards": "#promo", "reward": "#promo", "交易大赛": "#promo", "交易大賽": "#promo",
        "比赛": "#promo", "比賽": "#promo", "活动": "#promo", "活動": "#promo", "赠金": "#promo", "贈金": "#promo"}


def topic_tokens(title, brand=""):
    """标题里的主题词（去掉品牌、套话），同义词归一：用来判断同一品牌近期两条新闻是不是在讲同一个活动。"""
    own = {w.lower() for n in [brand] + CORE.get(brand, []) for w in re.findall(r"[A-Za-z0-9]+", n)}
    words = re.findall(r"[A-Za-z][A-Za-z0-9']+|黄金|黃金|股票|美股|交易大赛|交易大賽|比赛|比賽|活动|活動|赠金|贈金", (title or "").lower())
    return {_SYN.get(w, w) for w in words if w not in _STOP and w not in own and len(w) > 2 or w in _SYN}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:20] or "brand"


# ---------- 抓取 ----------
def parse_date(s):
    if not s: return None
    try: return email.utils.parsedate_to_datetime(s).astimezone(KL).date()
    except Exception: pass
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try: return dt.date(int(m[1]), int(m[2]), int(m[3]))
        except Exception: return None
    return None


def strip_tags(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", " ", s or ""))).strip()


def read_feed(url, source_name):
    status, text, ctype, final = fetch(url, raw=True)
    root = ET.fromstring(text.encode("utf-8", "replace"))
    items = []
    for it in root.iter():
        tag = it.tag.split("}")[-1]
        if tag not in ("item", "entry"): continue
        def g(*names):  # 注意：ElementTree 的空元素在布尔判断里是 False，所以必须显式比较 None
            for name in names:
                for c in it:
                    if c.tag.split("}")[-1] == name: return c
            return None
        title_el = g("title")
        title = strip_tags((title_el.text if title_el is not None else "") or "")
        link_el = g("link")
        link = ((link_el.text or "").strip() or (link_el.get("href") or "").strip()) if link_el is not None else ""
        desc_el = g("description", "summary", "content")
        desc = strip_tags(desc_el.text if desc_el is not None else "")
        date_el = g("pubDate", "published", "updated")
        src_el = g("source")
        publisher = (src_el.text or "").strip() if src_el is not None else ""
        items.append({"title": title, "url": link, "snippet": desc[:600], "date": parse_date(date_el.text if date_el is not None else ""),
                      "via": source_name, "publisher": publisher})
    return items


def read_telegram(channel, name):
    url = "https://t.me/s/" + channel.strip().lstrip("@")
    status, page, ctype, final = fetch(url)
    items = []
    for block in re.findall(r'(?s)<div class="tgme_widget_message_wrap.*?</time>', page):
        txt = strip_tags(re.search(r'(?s)tgme_widget_message_text[^>]*>(.*?)</div>', block).group(1)) if "tgme_widget_message_text" in block else ""
        link = re.search(r'href="(https://t\.me/[^"]+/\d+)"', block)
        when = re.search(r'datetime="([^"]+)"', block)
        if txt and link:
            d = None
            if when:
                try: d = dt.datetime.fromisoformat(when.group(1).replace("Z", "+00:00")).astimezone(KL).date()
                except Exception: pass
            items.append({"title": txt[:140], "url": link.group(1), "snippet": txt[:600], "date": d, "via": name or "Telegram", "publisher": "Telegram"})
    return items


def read_page_links(url, name):
    status, page, ctype, final = fetch(url)
    items = []
    for href, text in re.findall(r'(?is)<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', page):
        t = strip_tags(text)
        u = urllib.parse.urljoin(final, href.strip())
        if len(t) > 12 and u.startswith("http"):
            items.append({"title": t[:160], "url": u, "snippet": "", "date": None, "via": name or url, "publisher": urllib.parse.urlparse(u).netloc})
    return items


def google_news(q, lang):
    hl, gl, ceid = {"en": ("en-US", "US", "US:en"), "zh-TW": ("zh-TW", "TW", "TW:zh-Hant"),
                    "zh-HK": ("zh-HK", "HK", "HK:zh-Hant"), "zh-CN": ("zh-CN", "CN", "CN:zh-Hans"),
                    "en-SG": ("en-SG", "SG", "SG:en"), "en-MY": ("en-MY", "MY", "MY:en"),
                    "ms": ("ms-MY", "MY", "MY:ms")}[lang]
    url = env("DISCOVERY_GNEWS_BASE", "https://news.google.com/rss/search") + "?" + urllib.parse.urlencode({"q": q + f" when:{LOOKBACK_DAYS}d", "hl": hl, "gl": gl, "ceid": ceid})
    items = read_feed(url, "Google 新闻")
    for it in items:  # Google 新闻标题末尾带 “ - 媒体名”
        if it["publisher"] and it["title"].endswith(" - " + it["publisher"]):
            it["title"] = it["title"][: -len(it["publisher"]) - 3]
    return items


def build_queries():
    qs = []
    en_kw = '(promotion OR competition OR contest OR "trading cup" OR bonus OR cashback OR giveaway OR "lucky draw" OR "prize pool")'
    for brand, names in CORE.items():
        name = names[0]
        qs.append((f'"{name}" {en_kw}', "en"))
    # 华语区：所有核心品牌都用繁体（台湾、香港）和简体（新马、海外华人）各搜一次
    for brand, names in CORE.items():
        if brand == "Bybit":
            continue  # 加密交易所，中文新闻多为理财 / 空投，噪音大
        name = names[0]
        qs.append((f'"{name}" (交易大賽 OR 活動 OR 贈金 OR 抽獎 OR 獎金 OR 獎池)', "zh-TW"))
        qs.append((f'"{name}" (交易大赛 OR 活动 OR 赠金 OR 抽奖 OR 奖金 OR 奖池)', "zh-CN"))
    for brand in ["D Prime", "EBC", "TMGM", "ATFX", "Ultima Markets", "Hantec Markets", "XM", "Exness"]:
        qs.append((f'"{CORE[brand][0]}" (交易大賽 OR 活動 OR 講座 OR 博覽會)', "zh-HK"))
    for brand in ["D Prime", "EBC", "TMGM", "ATFX", "Ultima Markets", "WeTrade", "XM", "Exness", "Pepperstone"]:
        qs.append((f'"{CORE[brand][0]}" (Singapore OR Malaysia OR "Kuala Lumpur") {en_kw}', "en-SG"))
    for q, lang in [('forex broker "trading competition"', "en"), ('CFD broker "trading contest" prize', "en"),
                    ('forex broker "deposit bonus" launch', "en"), ('broker "lucky draw" trading', "en"),
                    ('外汇 交易大赛 奖金', "zh-CN"), ('外匯 交易大賽 獎金', "zh-TW"), ('外匯 交易大賽 獎金', "zh-HK"),
                    ('外汇 模拟交易大赛', "zh-CN"), ('外匯 券商 贈金 活動', "zh-TW"), ('差價合約 交易比賽 香港', "zh-HK"),
                    ('外汇 券商 马来西亚 活动 奖金', "zh-CN"), ('外匯 博覽會 台北 OR 香港 券商', "zh-TW"),
                    ('forex broker "trading competition" Malaysia OR Singapore', "en-MY"), ('forex "trading competition" Malaysia OR Thailand OR Indonesia OR Vietnam', "en"),
                    ('pertandingan dagangan forex hadiah', "ms")]:
        qs.append((q, lang))
    return qs


# ---------- 自动建档 ----------
def rule_record(c, brand):
    text = " ".join([c["title"], c.get("snippet", ""), c.get("page_text", "")[:3000]])
    money = []
    for m in MONEY.findall(text):
        v = m.strip(" ,.")
        if re.search(r"\d", v) and v not in money: money.append(v)
    kind = "现金" if re.search(r"cash|现金|現金|prize pool|奖池|獎池|cashback|返现", text, re.I) else (
        "赠金/信用额" if re.search(r"bonus|赠金|贈金|credit", text, re.I) else (
        "实物/旅行" if re.search(r"trip|tickets?|iphone|car|watch|旅行|门票|門票", text, re.I) else "待确认"))
    h = hashlib.sha1((brand + norm_title(c["title"])).encode()).hexdigest()[:8]
    return {
        "ID": f"auto-{slug(brand)}-{h}", "品牌": brand,
        "对象": "IB" if IB_RE.search(c["title"]) else "直客",
        "地区": guess(REGION_RULES, text, "华语" if re.search(r"[\u4e00-\u9fff]{4,}", c["title"]) else "全球"),
        "活动类型": guess(TYPE_RULES, text, "其他活动"),
        "奖励性质": kind, "标题": c["title"][:120],
        "奖励摘要": "；".join(money[:3]) if money else "金额见来源",
        "给谁": "见来源（自动发现，资格未核实）", "门槛": "见来源（自动发现，条件未核实）",
        "活动说明": c.get("snippet", "")[:500],
        "来源链接": c["url"], "来源日期": c["date"].isoformat() if c.get("date") else "",
        "证据注释": f"自动发现于 {c['via']}" + (f"（{c['publisher']}）" if c.get("publisher") else ""),
        "待核事项": "规则自动提取，金额、地区、日期与资格均未核实。",
        "最后核查": TODAY.isoformat(), "更新人": "自动发现（规则）",
    }


AI_FIELDS = ["品牌", "对象", "地区", "活动类型", "奖励性质", "标题", "奖励摘要", "给谁", "门槛", "可参考点", "开始日期", "截止日期",
             "活动说明", "完整条款", "国家资格", "限制国家", "签约实体", "待核事项"]


def ai_record(c, rule, brands):
    key = env("AI_API_KEY")
    if not key: return rule, None
    provider = env("AI_PROVIDER", "anthropic").lower()
    model = env("AI_MODEL", "claude-haiku-5-5" if provider == "anthropic" else "gpt-4o-mini")
    prompt = (
        "你在维护一个外汇/CFD 券商促销活动数据库。下面是一条自动搜到的新闻 / 网页。请判断它是否在介绍一个**具体的、面向客户或 IB 的促销活动**"
        "（交易大赛、模拟赛、赠金、返现、抽奖、推荐奖励、IB 奖励等）。人事任命、财报、交易量、牌照、赞助签约（没有面向客户的奖励机制）都不算。\n"
        "只输出 JSON：{\"is_promotion\":true/false,\"reason\":\"一句话\",\"fields\":{...}}。\n"
        f"fields 的键只能用：{'、'.join(AI_FIELDS)}。全部用简体中文；金额保留原币种；日期 YYYY-MM-DD；"
        "对象 只能是 直客 或 IB；地区 只能是 华语/东南亚/中东北非/伊朗/伊拉克/拉美/非洲/欧洲/全球 之一；"
        "奖励性质 只能是 现金/赠金/信用额/积分/权益/实物/旅行/资源支持/多种奖励/待确认 之一；"
        f"品牌请用这些写法之一（如果都不是就写新闻里的品牌名）：{'、'.join(brands[:80])}。"
        "可参考点 用一句话写这个活动设计有什么值得同行借鉴；不确定的写进 待核事项，不要编造。\n\n"
        f"标题：{c['title']}\n来源：{c['via']} {c.get('publisher','')}\n日期：{c.get('date') or ''}\n链接：{c['url']}\n\n"
        f"正文（截断）：\n{(c.get('page_text') or c.get('snippet') or '')[:9000]}"
    )
    try:
        if provider == "anthropic":
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps({
                "model": model, "max_tokens": 1500, "messages": [{"role": "user", "content": prompt}]}).encode(),
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
        if not j.get("is_promotion"):
            return None, j.get("reason", "AI 判断不是促销活动")
        rec = dict(rule)
        rec["待核事项"] = ""
        for k in ("给谁", "门槛"):  # 规则版的占位文字不要留在 AI 版里
            if rec.get(k, "").startswith("见来源"): rec[k] = ""
        for k, v in (j.get("fields") or {}).items():
            if k in AI_FIELDS and str(v).strip(): rec[k] = str(v).strip()
        rec["更新人"] = "自动发现（AI 整理）"
        rec["待核事项"] = rec.get("待核事项") or "AI 自动整理，请抽查。"
        return rec, None
    except Exception as e:
        log("AI 整理失败，改用规则版：", e)
        return rule, None


# ---------- 主流程 ----------
def main():
    records = load_records()
    aliases = brand_aliases(records)
    pats = compile_brands(aliases)
    known_urls = {u.strip().split("?")[0].rstrip("/") for r in records for u in re.split(r"\s*\|\s*|\n", r.get("来源链接", "")) if u.strip()}
    known_titles = {norm_title(r.get("标题", "")) for r in records}

    auto = []
    if os.path.exists(AUTO):
        with open(AUTO, encoding="utf-8-sig") as f: auto = list(csv.DictReader(f))
    auto_ids = {r["ID"] for r in auto}
    state = json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}
    seen = set(state.get("seen", []))   # 已处理过的链接 / 标题指纹（包括被 AI 判定为“不是活动”的）
    rejected = state.get("rejected", [])[-300:]

    # 1) 收集候选
    cands, src_status = [], []
    for q, lang in build_queries():
        try: got = google_news(q, lang); cands += got; src_status.append({"source": f"Google 新闻：{q}", "ok": True, "items": len(got)})
        except Exception as e: src_status.append({"source": f"Google 新闻：{q}", "ok": False, "error": type(e).__name__})
        time.sleep(1.2)
    if os.path.exists(SOURCES):
        with open(SOURCES, encoding="utf-8-sig") as f:
            for s in csv.DictReader(f):
                kind, name, url = (s.get("类型") or "").strip().lower(), (s.get("名称") or "").strip(), (s.get("网址或频道") or "").strip()
                if not url: continue
                try:
                    got = read_feed(url, name) if kind == "rss" else read_telegram(url, name) if kind == "telegram" else read_page_links(url, name)
                    cands += got; src_status.append({"source": name or url, "ok": True, "items": len(got)})
                except Exception as e:
                    src_status.append({"source": name or url, "ok": False, "error": type(e).__name__})
                time.sleep(0.5)
    log(f"候选 {len(cands)} 条")

    # 2) 筛选 + 去重
    picked, batch_titles, merged = [], set(), 0
    # 已有记录（人工 + 自动）的活动“指纹”，用来把同一活动的多篇报道合成一条
    known_events = []   # (品牌, 活动缩写/奖金数额, 规范化标题, 主题词, 对应的自动记录或 None)
    recent = TODAY - dt.timedelta(days=DUP_WINDOW_DAYS)
    for r in list(records) + auto:
        b, title = r.get("品牌", ""), r.get("标题", "")
        is_auto = r in auto
        try: fresh = dt.date.fromisoformat((r.get("最后核查") or "")[:10]) >= recent
        except ValueError: fresh = False
        known_events.append((b, event_keys(title, b), norm_title(title), topic_tokens(title, b) if is_auto and fresh else set(), r if is_auto else None))

    def same_event(brand, keys, t, toks):
        for b, k, nt, tk, rec in known_events:
            if b != brand: continue
            if (keys & k) or difflib.SequenceMatcher(None, t, nt).ratio() > 0.6:
                return True, rec
            acr_a, acr_b = {x for x in keys if not x.startswith("$")}, {x for x in k if not x.startswith("$")}
            if (acr_a or acr_b) and acr_a != acr_b:
                continue   # 一边有活动缩写（如 WSOT）而另一边没有 / 不同：是不同活动
            shared = toks & tk
            if len(shared - {"#promo"}) >= 2 or (len(shared - {"#promo"}) >= 1 and "#promo" in shared):
                return True, rec
        return False, None
    cutoff = TODAY - dt.timedelta(days=LOOKBACK_DAYS)
    for c in cands:
        if not c["title"] or not c["url"]: continue
        if c.get("date") and c["date"] < cutoff: continue
        text = c["title"] + " " + c.get("snippet", "")
        if not PROMO.search(text) or NOT_PROMO.search(c["title"]): continue
        brand = find_brand(text, pats)
        if not brand: continue
        u = c["url"].split("?")[0].rstrip("/")
        t = norm_title(c["title"])
        fp = hashlib.sha1((brand + t).encode()).hexdigest()[:12]
        if u in known_urls or t in known_titles or u in seen or fp in seen or t in batch_titles: continue
        if brand in CRYPTO_BRANDS and not TRADFI.search(text):
            seen.add(u); seen.add(fp); continue
        keys, toks = event_keys(c["title"], brand), topic_tokens(c["title"], brand)
        dup, rec = same_event(brand, keys, t, toks)
        if dup:   # 同一活动的另一篇报道：不新建，只把链接补进那条自动记录的来源（最多 5 个）
            seen.add(u); seen.add(fp)
            if rec is not None:
                links = [x for x in re.split(r"\s*\|\s*", rec.get("来源链接", "")) if x]
                if c["url"] not in links and len(links) < 5:
                    rec["来源链接"] = " | ".join(links + [c["url"]]); merged += 1
            continue
        known_events.append((brand, keys, t, toks, None))
        batch_titles.add(t)
        c["brand"], c["fp"], c["u"] = brand, fp, u
        picked.append(c)
    max_new = int(env("DISCOVERY_MAX_NEW", "40")) if env("DISCOVERY_MAX_NEW", "40").isdigit() else 40
    picked = sorted(picked, key=lambda c: (c["brand"] not in CORE, -(c["date"] or cutoff).toordinal()))
    per_brand = int(env("DISCOVERY_MAX_PER_BRAND", "3")) if env("DISCOVERY_MAX_PER_BRAND", "3").isdigit() else 3
    counts, capped = {}, []
    for c in picked:  # 每个品牌每天最多新增几条，避免发稿多的品牌刷屏；没轮到的明天再收
        if counts.get(c["brand"], 0) < (CRYPTO_MAX_PER_DAY if c["brand"] in CRYPTO_BRANDS else per_brand):
            capped.append(c); counts[c["brand"]] = counts.get(c["brand"], 0) + 1
    picked = capped[:max_new]
    log(f"新候选 {len(picked)} 条；重复报道已合并到原记录 {merged} 条")

    # 3) 自动建档
    added = []
    brands = list(aliases.keys())
    for c in picked:
        if not c["url"].startswith("https://news.google.com/"):
            try: c["page_text"] = visible_text(fetch(c["url"])[1])[:15000]
            except Exception: c["page_text"] = ""
        rule = rule_record(c, c["brand"])
        rec, why = ai_record(c, rule, brands)
        seen.add(c["u"]); seen.add(c["fp"])
        if rec is None:
            rejected.append({"title": c["title"], "url": c["url"], "brand": c["brand"], "reason": why, "date": TODAY.isoformat()})
            continue
        if rec["ID"] in auto_ids: continue
        auto.append(rec); auto_ids.add(rec["ID"]); added.append(rec)

    # 4) 老化：超过 60 天、没有截止日期、仍未被人工确认的自动记录 → 不再算“在列”
    human_ids = {r.get("ID") for r in records}
    for r in auto:
        d = r.get("最后核查", "")[:10]
        try: age = (TODAY - dt.date.fromisoformat(d)).days
        except Exception: age = 0
        if age > STALE_DAYS and not r.get("截止日期") and r["ID"] not in human_ids:
            r["不计入在列"] = "是"

    with open(AUTO, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEAD); w.writeheader()
        for r in auto: w.writerow({h: r.get(h, "") for h in HEAD})
    out = {"generated": TODAY.isoformat(), "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "ai_enabled": bool(env("AI_API_KEY")), "candidates": len(cands), "new_today": [r["ID"] for r in added],
           "total_auto": len(auto), "sources": src_status, "rejected": rejected[-300:], "seen": sorted(seen)[-20000:]}
    json.dump(out, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    log(f"完成：今日新增 {len(added)} 条，自动记录共 {len(auto)} 条")


if __name__ == "__main__":
    main()
