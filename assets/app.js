'use strict';
/* 竞品促销监测 · 页面脚本。数据：data/records.csv（人工）+ data/auto_records.csv（自动发现）+ data/events.csv（行业展会）
   + data/playbook.csv（玩法案例）+ data/monitor.json（每日监测）。本地双击打开时用 index.html 里内嵌的备份。 */
const CFG = Object.assign({ sheetCsvUrl: '', fallbackCsv: 'data/records.csv', monitorJson: 'data/monitor.json', autoCsv: 'data/auto_records.csv', eventsCsv: 'data/events.csv', playbookCsv: 'data/playbook.csv', discoveryJson: 'data/discovery.json', selfBrand: 'D Prime', dueSoonDays: 7, guideUrl: 'GUIDE.md', coreBrands: ['D Prime', 'EC Markets', 'EBC', 'IC Markets (IC)', 'IC Markets', 'Exness', 'Bybit', 'XM', 'Pepperstone', 'FxPro', 'Axi', 'WeTrade', 'Hantec Markets', 'ATFX', 'Tickmill', 'AvaTrade', 'FXCM', 'FOREX.com', 'TMGM', 'Ultima Markets'], repo: 'AndreaCHAO/-promo-radar', branch: 'main' }, window.RADAR_CONFIG || {});
const REGIONS = {
  '华语': { en: 'GREATER CHINA / SG·MY', lon: 118, lat: 26 },
  '东南亚': { en: 'SOUTHEAST ASIA', lon: 104, lat: 4 },
  '伊朗/伊拉克': { en: 'IRAN / IRAQ', lon: 48, lat: 33 },
  '中东北非': { en: 'MENA', lon: 28, lat: 24 },
  '非洲': { en: 'AFRICA', lon: 22, lat: -6 },
  '欧洲': { en: 'EUROPE', lon: 12, lat: 50 },
  '拉美': { en: 'LATAM', lon: -62, lat: -14 },
  '全球': { en: 'GLOBAL', lon: null, lat: null }
};
const STATUS = { active: '进行中', due: '即将截止', undated: '在列 · 未标期', unclear: '待核', upcoming: '尚未开始', expired: '已结束', excluded: '不适用' };
const COLS = ['ID', '品牌', '对象', '地区', '活动类型', '奖励性质', '标题', '奖励摘要', '给谁', '门槛', '可参考点', '开始日期', '截止日期', '人工状态', '不计入在列', '活动说明', '完整条款', '国家资格', '限制国家', '国家备注', '签约实体', '客户类别', '零售限制', '产品范围', '金额上限', '日期说明', 'IB支持', '办公室支持', '活动支持', '预付机制', '支付窗口', '赠金与IB佣金', '公开披露观察', '其他限制', '限制来源范围', '待核事项', '证据注释', '研究备注', '来源链接', '来源日期', '截图链接', '截图说明', '原始英文', '精选排序', '最后核查', '更新人'];
/* 线下活动：按活动类型判断；细分形式按标题关键词判断 */
const OFFLINE_TYPES = ['线下活动', '品牌赞助', '体育 IP 活动', '展会', '赞助', '讲座路演'];
const OFFLINE_KINDS = { expo: '展会 / 峰会', sponsor: '赞助', seminar: '讲座 / 路演', party: '客户 / IB 活动' };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let LOAD_ERROR = '', RECORDS = [], BY_ID = new Map(), META = { source: '', loadedAt: null, latestCheck: '' }, MON = null, RESEARCH = null, DISC = null, EVENTS = [], PLAYBOOK = [], RAW = { records: '', auto: '' };
let VIEW = 'promos', selectedRegion = 'all', audience = 'all', visibleCount = 9, filtered = [], compareIds = [];
let offlineKind = 'expo', playIndustry = 'all';
/* ---------- 动效：系统开了「减少动态效果」时全部跳过 ---------- */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
var firstPaint = true;
function countUp(nodes) {
  if (REDUCED) return;
  nodes.forEach(n => {
    const end = parseInt(n.textContent, 10); if (!(end > 1)) return;
    const t0 = performance.now(), dur = 900; n.textContent = '0';
    const step = t => { const p = Math.min(1, (t - t0) / dur); n.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
const revealIO = !REDUCED && 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  let n = 0;
  es.forEach(e => {
    if (!e.isIntersecting) return;
    const c = e.target; revealIO.unobserve(c);
    c.style.setProperty('--d', Math.min(n++, 8) * 55 + 'ms'); c.classList.add('in');
    setTimeout(() => { c.classList.remove('reveal-pre', 'in'); c.style.removeProperty('--d'); }, 1100);
  });
}, { rootMargin: '0px 0px -30px 0px' }) : null;
function revealIn(nodes) { if (!revealIO) return; nodes.forEach(c => { c.classList.add('reveal-pre'); revealIO.observe(c); }); }
/* 筛选切换：留下来的卡片滑到新位置（FLIP），新出现的淡入 */
function animateCards(prev) {
  if (REDUCED) return;
  const cards = [...document.querySelectorAll('#recordCards .record-card')];
  if (!prev.size) { revealIn(cards); return; }
  let i = 0;
  cards.forEach(c => {
    const old = prev.get(c.dataset.recordId);
    if (old) {
      const now = c.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } else c.animate([{ opacity: 0, transform: 'translateY(12px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: Math.min(i++, 8) * 45, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  });
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.some(v => v.trim() !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function parseDate(s) {
  s = String(s || '').trim(); if (!s) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d) ? null : d;
}
function fmt(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; }
function md(d) { return d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''; }
function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }

/* 状态：人工状态优先，否则按今天的日期自动计算 */
function computeStatus(r) {
  const manual = (r['人工状态'] || '').trim();
  const map = { '待核': 'unclear', '不适用': 'excluded', '已结束': 'expired', '进行中': 'active', '预告': 'upcoming' };
  if (map[manual]) return map[manual];
  const t = today(), s = parseDate(r['开始日期']), e = parseDate(r['截止日期']);
  if (e && e < t) return 'expired';
  if (s && s > t) return 'upcoming';
  if (e) { const days = (e - t) / 864e5; return days <= CFG.dueSoonDays ? 'due' : 'active'; }
  return 'undated';
}
function offlineKindOf(r) {
  const t = (r['活动类型'] + ' ' + r['标题']).toLowerCase();
  if (/赞助|sponsor|合作伙伴|官方伙伴|partner of|大使|f1|足协|俱乐部/.test(t)) return 'sponsor';
  if (/展|expo|博览|summit|峰会|fair|festival/.test(t)) return 'expo';
  if (/研讨|讲座|工作坊|seminar|workshop|路演|roadshow|培训|大学|教育/.test(t)) return 'seminar';
  return 'party';
}
function normalize(raw, i) {
  const r = Object.fromEntries(COLS.map(c => [c, raw[c] || '']));
  r.id = r['ID'] || ('row-' + (i + 2));
  r.region = REGIONS[r['地区']] ? r['地区'] : '全球';
  r.audience = /ib|伙伴|联盟|代理/i.test(r['对象']) ? 'ib' : 'direct';
  r.sources = (r['来源链接'] || '').split(/\s*\|\s*|\s*\n\s*/).filter(u => /^https?:\/\//i.test(u));
  r.status = computeStatus(r);
  r.isSelf = r['品牌'].trim().toLowerCase() === CFG.selfBrand.toLowerCase();
  r.offList = /^(是|y|yes|1|true)$/i.test(r['不计入在列']);
  r.offline = OFFLINE_TYPES.includes(r['活动类型']);
  if (r.offline) r.okind = offlineKindOf(r);
  r.rank = parseInt(r['精选排序'], 10) || 9999;
  const found = parseDate(r['最后核查']); r.foundDays = found ? Math.round((today() - found) / 864e5) : 999;
  const e = parseDate(r['截止日期']); r.daysLeft = e ? Math.round((e - today()) / 864e5) : null;
  return r;
}
/* 自动监测：来源页在“最后核查”之后有变化 / 全部来源无法访问 / 页面出现“已结束”字样 */
function monFlag(r) {
  const m = r.mon; if (!m || r.status === 'expired' || r.status === 'excluded') return '';
  if (m.ended_hint) return 'ended';
  // 用来源页最新变化日期和“最后核查”实时比较：同事改了核查日期，提醒立刻消失，不用等机器人下次运行
  const urlChanged = r.sources.map(u => MON?.urls?.[u]?.changed || '').sort().pop() || m.changed || '';
  const checked = fmt(parseDate(r['最后核查']));
  if (urlChanged && (!checked || urlChanged > checked)) { m.changed = urlChanged; return 'changed'; }
  if (m.sources_total && m.sources_ok === 0) return 'down';
  return '';
}
const FLAG = { changed: '来源有更新 · 待核', ended: '可能已结束', down: '来源打不开' };
/* 只把“重要”的变化算进「需要核对」：核心竞品 + 仍在列 + 变化涉及金额 / 奖励 / 日期 / 结束；其余算小变化，不提醒 */
const KEY_CHANGE = /[$€£¥%٪]|\d[\d,.]*\s*(usd|usdt|美元|万|lots?|手)|bonus|bono|prize|premio|reward|cashback|rebate|deposit|credit|奖|獎|赠金|贈金|返现|返佣|入金|截止|until|deadline|expire|ended|terminad|finaliz|结束|結束|20\d\d/i;
function isImportant(r) {
  if (r.flag !== 'changed' && r.flag !== 'ended') return false;
  const core = CFG.coreBrands.some(b => b.toLowerCase() === r['品牌'].toLowerCase());
  if (!core || r.offList || !['active', 'due', 'undated', 'upcoming', 'unclear'].includes(r.status)) return false;
  if (r.flag === 'ended') return true;
  const lines = r.sources.flatMap(u => [...(MON?.urls?.[u]?.added || []), ...(MON?.urls?.[u]?.removed || [])]);
  return lines.some(l => KEY_CHANGE.test(l));
}
async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
const online = () => location.protocol !== 'file:';
function embedded(id) { const el = document.getElementById(id); return el ? el.textContent.trim() : ''; }
async function textOr(url, embedId) {
  if (online()) { try { return await fetchText(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now()); } catch (err) { console.warn('读取失败，改用内置备份：', url, err); } }
  return embedded(embedId);
}
async function loadData() {
  let text = '', source = '';
  if (CFG.sheetCsvUrl) {
    try { text = await fetchText(CFG.sheetCsvUrl + (CFG.sheetCsvUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()); source = 'sheet'; }
    catch (err) { console.warn('Google 表格读取失败，改用仓库数据：', err); }
  }
  if (!text && online()) { try { text = await fetchText(CFG.fallbackCsv + '?_t=' + Date.now()); source = 'repo'; } catch (err) { console.warn('仓库数据读取失败，改用内置备份：', err); } }
  if (!text) { text = embedded('seedData'); source = 'embedded'; }
  if (!text) throw new Error('没有可用的数据');
  RAW.records = text;
  MON = null;
  const monText = await textOr(CFG.monitorJson, 'monitorData');
  try { MON = monText ? JSON.parse(monText) : null; } catch { MON = null; }
  if (!RESEARCH) { try { RESEARCH = JSON.parse(embedded('researchData') || 'null'); } catch { RESEARCH = null; } }
  RECORDS = parseCSV(text).map(normalize).filter(r => r['品牌'] && r['标题']);
  const autoText = await textOr(CFG.autoCsv, 'autoData');
  RAW.auto = autoText;
  const humanIds = new Set(RECORDS.map(r => r.id));
  if (autoText) RECORDS = RECORDS.concat(parseCSV(autoText).map((x, i) => Object.assign(normalize(x, i), { auto: true })).filter(r => r['品牌'] && r['标题'] && !humanIds.has(r.id)));
  EVENTS = parseCSV(await textOr(CFG.eventsCsv, 'eventsData')).filter(e => e['名称']).map(e => Object.assign(e, { start: parseDate(e['开始日期']), end: parseDate(e['结束日期']) || parseDate(e['开始日期']), sources: (e['来源链接'] || '').split(/\s*\|\s*/).filter(u => /^https?:\/\//i.test(u)), brands: (e['竞品参与'] || '').split(/\s*\|\s*/).filter(Boolean) }));
  PLAYBOOK = parseCSV(await textOr(CFG.playbookCsv, 'playbookData')).filter(p => p['案例名']);
  DISC = null;
  if (online()) { try { DISC = JSON.parse(await fetchText(CFG.discoveryJson + '?_t=' + Date.now())); } catch { DISC = null; } }
  RECORDS.forEach(r => { r.mon = MON?.records?.[r.id] || null; r.flag = monFlag(r); r.alert = isImportant(r); r.minor = (r.flag === 'changed' || r.flag === 'ended') && !r.alert; });
  BY_ID = new Map(RECORDS.map(r => [r.id, r]));
  META = { source, loadedAt: new Date(), latestCheck: RECORDS.map(r => fmt(parseDate(r['最后核查']))).filter(Boolean).sort().pop() || '' };
}

/* ---------- 通用 ---------- */
function short(v, n = 110) { v = String(v || '').trim(); return v.length > n ? v.slice(0, n) + '…' : v; }
function safeUrl(u) { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : '#'; } catch { return '#'; } }
function imgSrc(u) { u = String(u || '').trim(); if (!u) return ''; if (/^https?:\/\//i.test(u)) return safeUrl(u); return /^[\w./-]+\.(jpe?g|png|webp|gif)$/i.test(u) && !u.includes('..') ? u : ''; }
function domain(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '来源'; } }
function toast(m) { $('toast').textContent = m; $('toast').classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => $('toast').classList.remove('show'), 2800); }
function monTime() {
  if (!MON) return '';
  const d = MON.generated_at ? new Date(MON.generated_at) : null;
  if (!d || isNaN(d)) return MON.generated || '';
  const kl = new Date(d.getTime() + 8 * 3600e3), p = n => String(n).padStart(2, '0');
  return kl.getUTCFullYear() + '-' + p(kl.getUTCMonth() + 1) + '-' + p(kl.getUTCDate()) + ' ' + p(kl.getUTCHours()) + ':' + p(kl.getUTCMinutes());
}
const inList = r => ['active', 'due', 'undated'].includes(r.status) && !r.offList;

/* ---------- 视图切换 ---------- */
const VIEWS = ['promos', 'offline', 'regions', 'playbook'];
function showView(v, push = true) {
  if (!VIEWS.includes(v)) v = 'promos';
  VIEW = v;
  VIEWS.forEach(x => { $('view-' + x).hidden = x !== v; });
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  if (push && location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  if (v === 'promos') render();
  if (v === 'offline') renderOffline();
  if (v === 'regions') renderRegions();
  if (v === 'playbook') renderPlaybook();
  window.scrollTo(0, 0);
}

/* ---------- 活动监测 ---------- */
function statusMatch(r, s) {
  if (s === 'all') return true;
  if (s === 'current') return inList(r);
  if (s === 'flag') return r.alert;
  if (s === 'new') return r.auto && r.foundDays <= 7;
  if (s === 'recent') return r.foundDays <= 7;
  if (s === 'ended7') return r.status === 'expired' && r.daysLeft != null && r.daysLeft >= -7;
  if (s === 'stale') return inList(r) && r.foundDays > 60;
  if (s === 'auto') return !!r.auto;
  if (s === 'active') return ['active', 'due'].includes(r.status);
  if (s === 'watch') return ['unclear', 'upcoming'].includes(r.status);
  return r.status === s;
}
function matchRecord(r) {
  const q = $('searchInput').value.trim().toLowerCase();
  const st = $('statusFilter').value;
  return (!r.offline || ['recent', 'flag', 'due', 'ended7', 'all'].includes(st)) && (audience === 'all' || r.audience === audience) && (selectedRegion === 'all' || r.region === selectedRegion) &&
    (!$('brokerFilter').value || r['品牌'] === $('brokerFilter').value) &&
    (!$('typeFilter').value || r['活动类型'] === $('typeFilter').value) &&
    statusMatch(r, st) &&
    (!q || COLS.map(c => r[c]).join(' ').toLowerCase().includes(q));
}
function populateFilters() {
  const isSelf = b => b.toLowerCase() === CFG.selfBrand.toLowerCase();
  const brands = [...new Set(RECORDS.filter(r => !r.offline).map(r => r['品牌']))].sort((a, b) => (isSelf(b) - isSelf(a)) || a.localeCompare(b));
  const old = $('brokerFilter').value;
  $('brokerFilter').innerHTML = '<option value="">全部品牌</option>' + brands.map(b => `<option value="${esc(b)}">${esc(b)}${isSelf(b) ? '（我方）' : ''}</option>`).join('');
  if (brands.includes(old)) $('brokerFilter').value = old;
  const regionOpts = '<option value="all">全部地区</option>' + Object.keys(REGIONS).map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  $('regionFilter').innerHTML = regionOpts; $('regionFilter').value = selectedRegion;
  $('offlineRegion').innerHTML = regionOpts;
  populateTypes();
  const cats = [...new Set(PLAYBOOK.map(p => p['玩法类别']).filter(Boolean))];
  $('playCategory').innerHTML = '<option value="">全部玩法</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
}
function populateTypes() {
  const old = $('typeFilter').value, types = [...new Set(RECORDS.filter(r => !r.offline && (audience === 'all' || r.audience === audience)).map(r => r['活动类型']).filter(Boolean))].sort();
  $('typeFilter').innerHTML = '<option value="">全部类型</option>' + types.map(t => `<option>${esc(t)}</option>`).join('');
  if (types.includes(old)) $('typeFilter').value = old;
}
function setRegion(key, move = true) {
  selectedRegion = key; $('regionFilter').value = key; visibleCount = 9;
  const reg = REGIONS[key];
  render();
}
function statusBadge(r) {
  let label = STATUS[r.status];
  if (r.status === 'due' && r.daysLeft != null) label = r.daysLeft === 0 ? '今天截止' : '还剩 ' + r.daysLeft + ' 天';
  return `<span class="status ${r.status}">${r.status === 'due' ? '<i class="pulse-dot" aria-hidden="true"></i>' : ''}${esc(label)}</span>`;
}
function deadlineText(r) {
  const s = parseDate(r['开始日期']), e = parseDate(r['截止日期']);
  if (r.status === 'upcoming' && s) return fmt(s) + ' 开始';
  if (e) return fmt(e) + (r.daysLeft != null && r.daysLeft >= 0 ? '（' + (r.daysLeft === 0 ? '今天' : r.daysLeft + ' 天后') + '）' : '');
  return r['日期说明'] ? short(r['日期说明'], 40) : '未公开截止日';
}
/* 奖励里的第一个金额 / 比例用柠檬黄高亮 */
const AMT = /(?:US\$|HK\$|S\$|A\$|USDT\s?|USD\s?|RM\s?|\$|€|£|¥)\s?\d[\d,.]*(?:\s?(?:k|K|M|万|million|mil))?|\d[\d,.]*\s?(?:万美元|美元|USDT|USD|%|％|万)/;
function hiAmount(v) { return esc(v).replace(AMT, m => `<mark class="amt">${m}</mark>`); }
/* 卡片只留 4 项：品牌、奖励、门槛、截止；其余（可参考点、标签）收进详情 */
function card(r) {
  const picked = compareIds.includes(r.id), hasImg = !!imgSrc(r['截图链接']);
  const meta = [r.region, r['活动类型'], r.audience === 'ib' ? 'IB / 伙伴' : '直客', hasImg && '有截图'].filter(Boolean).map(esc).join('<i>·</i>');
  return `<article class="record-card${r.isSelf ? ' self' : ''}" data-record-id="${esc(r.id)}"><button class="card-main" data-open="${esc(r.id)}" aria-label="查看${esc(r['品牌'] + ' ' + r['标题'])}的详情"><div class="card-content"><div class="card-top"><div class="broker-name">${esc(r['品牌'])}${r.isSelf ? '<span class="self-badge">我方</span>' : ''}${r.auto ? `<span class="auto-badge">${r.foundDays <= 7 ? '新 · ' : ''}自动发现 · 未核实</span>` : ''}</div>${statusBadge(r)}</div><p class="card-meta">${meta}</p><p class="headline-reward">${hiAmount(r['奖励摘要'] || '金额未公开，需确认')}</p><h2>${esc(r['标题'])}</h2><dl class="facts"><div><dt>门槛</dt><dd>${esc(r['门槛'] || '未公开，需确认')}</dd></div><div class="deadline${r.status === 'due' ? ' soon' : ''}"><dt>${r.status === 'upcoming' ? '开始' : '截止'}</dt><dd>${esc(deadlineText(r))}</dd></div></dl>${r.alert || r.flag === 'down' ? `<div class="mon-flag ${r.flag}">⚑ ${esc(FLAG[r.flag])}${r.mon?.ai ? ' · 有 AI 建议' : ''}</div>` : ''}</div></button><div class="card-footer"><span>${r.auto ? '发现于' : '核查'} ${esc(fmt(parseDate(r['最后核查'])) || '未标')}</span><button class="compare-pick" data-compare="${esc(r.id)}" aria-pressed="${picked}">${picked ? '已加入比较 ✓' : '＋ 同类比较'}</button></div></article>`;
}
function sortKey(r) { return { due: 0, active: 1, upcoming: 2, undated: 3, unclear: 4, expired: 5, excluded: 6 }[r.status]; }
function render() {
  renderDigest(); renderMap();
  const prev = new Map();
  if (!REDUCED) document.querySelectorAll('#recordCards .record-card').forEach(c => prev.set(c.dataset.recordId, c.getBoundingClientRect()));
  filtered = RECORDS.filter(matchRecord).sort((a, b) => (b.isSelf - a.isSelf) || (b.alert - a.alert) || ((b.auto && b.foundDays <= 7) - (a.auto && a.foundDays <= 7)) || sortKey(a) - sortKey(b) || a.rank - b.rank || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || (fmt(parseDate(b['最后核查'])) || '').localeCompare(fmt(parseDate(a['最后核查'])) || ''));
  const show = filtered.slice(0, visibleCount);
  if (LOAD_ERROR) { $('recordCards').innerHTML = `<div class="empty"><strong>数据读取失败</strong>${esc(LOAD_ERROR)}</div>`; return; }
  $('recordCards').innerHTML = show.map(card).join('') || '<div class="empty"><strong>没有符合筛选的记录</strong>试试切换资料状态，或重置品牌、地区与类型。没有记录不代表市场上没有活动。</div>';
  $('resultSummary').innerHTML = esc(({ all: '全部活动', direct: '直客活动', ib: 'IB 合作' })[audience]) + ' · <b class="rs-num">' + filtered.length + '</b> 条匹配' + (filtered.length ? ' · 展示 ' + show.length + ' 条' : '');
  const st = $('statusFilter').value;
  $('scopeNote').textContent = st === 'current' ? '状态按今天日期自动计算；未标期 ≠ 确认仍可参加。' : st === 'expired' || st === 'ended7' ? '已结束的历史案例，可作机制参考。' : st === 'stale' ? '超过 60 天没人核查，可能早已结束，建议逐条确认。' : st === 'watch' || st === 'unclear' ? '条款、资格或来源有缺口，须进一步确认。' : st === 'all' ? '包含全部状态，每张卡分别标注。' : '时效、国家与客户类别请分别核验。';
  $('loadMore').hidden = show.length >= filtered.length;
  $('loadMore').textContent = '再看 ' + Math.min(9, filtered.length - show.length) + ' 条';
  const urls = new Set(filtered.flatMap(r => r.sources));
  $('filteredStats').textContent = '当前筛选：' + new Set(filtered.map(r => r['品牌'])).size + ' 个品牌 · ' + urls.size + ' 个来源链接';
  updateCompareBar(); updateNavCounts();
  animateCards(prev); updateMini(filtered.length);
  if (firstPaint && RECORDS.length) { firstPaint = false; countUp(document.querySelectorAll('.digest-head b, .map-num')); revealIn(document.querySelectorAll('.digest-col')); }
}
/* 本周动态：全部地区、全部对象 */
function renderDigest() {
  const pool = RECORDS.filter(r => selectedRegion === 'all' || r.region === selectedRegion);
  const by = (a, b) => (b.isSelf - a.isSelf);
  const cols = [
    ['recent', '近 7 天新增 / 核查', '新建档或刚核对过', pool.filter(r => r.foundDays <= 7).sort((a, b) => a.foundDays - b.foundDays || by(a, b)), r => (r.auto ? '自动发现 · ' : '') + (r['最后核查'] || '')],
    ['flag', '需要核对', '来源变了或可能已结束', pool.filter(r => r.alert).sort((a, b) => (b.flag === 'ended') - (a.flag === 'ended')), r => FLAG[r.flag]],
    ['due', '7 天内截止', '提醒同事抓紧参考', pool.filter(r => r.status === 'due').sort((a, b) => a.daysLeft - b.daysLeft), r => r.daysLeft === 0 ? '今天截止' : '还剩 ' + r.daysLeft + ' 天'],
    ['ended', '近 7 天结束', '可复盘的案例', pool.filter(r => statusMatch(r, 'ended7')).sort((a, b) => b.daysLeft - a.daysLeft), r => fmt(parseDate(r['截止日期'])) + ' 结束']
  ];
  $('digestScope').textContent = (selectedRegion === 'all' ? '全部地区' : selectedRegion) + ' · 直客与 IB · 含线下活动';
  $('digest').innerHTML = cols.map(([k, title, sub, list, meta]) => `<div class="digest-col" data-kind="${k}"><div class="digest-head"><b>${list.length}</b><div><span>${title}</span><small>${sub}</small></div></div>${list.length ? `<ul class="digest-list">${list.slice(0, 4).map(r => `<li><button data-open="${esc(r.id)}"><span class="d-brand">${esc(r['品牌'])}</span><span class="d-title">${esc(short(r['标题'], 34))}</span><span class="d-meta">${esc(r.region)} · ${esc(meta(r))}</span></button></li>`).join('')}</ul>` : '<p class="digest-empty">暂无</p>'}${list.length > 4 ? `<button class="digest-all" data-digest="${k}">查看全部 ${list.length} 条 →</button>` : ''}</div>`).join('');
}
function updateNavCounts() {
  const n = RECORDS.filter(r => r.alert).length;
  $('navPromosCount').textContent = n || ''; $('navPromosCount').hidden = !n;
}
function field(label, value) { return value ? `<section class="detail-section"><h3>${esc(label)}</h3><p>${esc(value)}</p></section>` : ''; }
function urlState(u) {
  const s = MON?.urls?.[u]; if (!s) return '';
  if (s.error) return ` <em class="url-bad">${esc(s.error)}</em>`;
  return ` <em class="url-ok">监测正常 · ${esc(s.checked || '')}</em>`;
}
function monPanel(r) {
  const m = r.mon;
  if (!m) return MON ? '' : '<div class="mon-panel quiet">自动监测尚未运行。</div>';
  const lines = (arr, sign) => (arr || []).map(l => `<li><b>${sign}</b> ${esc(l)}</li>`).join('');
  const ai = m.ai ? `<div class="ai-box"><strong>AI 建议（${esc(m.ai.date)}，请核对后再用）</strong><p>${esc(m.ai.summary || '')}</p>${Object.keys(m.ai.fields || {}).length ? `<p class="ai-fields">${Object.entries(m.ai.fields).map(([k, v]) => `<span>${esc(k)}</span>${esc(v)}`).join('<br>')}</p>` : ''}<button class="copy-tsv" data-copy-tsv="${esc(r.id)}">复制整行</button></div>` : '';
  if (r.minor) return `<div class="mon-panel quiet"><strong>自动监测 · ${esc(m.checked)}</strong><p>来源页有小变化（${r.flag === 'ended' ? '出现结束字样，但不是核心竞品或已不在列' : '不涉及金额、奖励或日期，或不是核心竞品'}），可以不处理。</p>${(m.added?.length || m.removed?.length) ? `<details><summary>看变化的文字</summary><ul class="diff">${lines(m.added, '+')}${lines(m.removed, '−')}</ul></details>` : ''}</div>`;
  return `<div class="mon-panel ${r.flag || 'ok'}"><strong>自动监测 · ${esc(m.checked)}</strong>${r.flag === 'changed' ? `<p>来源页在 ${esc(m.changed)} 有变化（晚于最后核查 ${esc(r['最后核查'] || '未标')}）。核对后把「最后核查」改成今天，提醒就会消失（见下方「维护这条记录」）。</p>` : ''}${r.flag === 'ended' ? `<p>来源页出现了「${esc(m.ended_hint)}」字样，活动可能已结束。确认后在「人工状态」填 已结束。</p>` : ''}${r.flag === 'down' ? `<p>全部来源都打不开：${esc((m.errors || []).join('；'))}。多半是网站拦截了机器人，请人工打开确认。</p>` : ''}${!r.flag ? `<p>来源页正常（${m.sources_ok}/${m.sources_total} 可访问），自最后核查以来没有检测到实质变化。</p>` : ''}${(m.added?.length || m.removed?.length) && r.flag === 'changed' ? `<details open><summary>看变化的文字</summary><ul class="diff">${lines(m.added, '+')}${lines(m.removed, '−')}</ul></details>` : ''}${ai}</div>`;
}
/* 维护入口：定位到 GitHub 上这一行 */
function lineOf(raw, id) {
  if (!raw) return 0;
  const lines = raw.replace(/^﻿/, '').split('\n');
  const i = lines.findIndex(l => l.startsWith(id + ',') || l.startsWith('"' + id + '",'));
  return i >= 0 ? i + 1 : 0;
}
function maintPanel(r) {
  if (META.source === 'sheet' && !r.auto) return `<section class="maint"><h3>维护这条记录</h3><p>数据来自 Google 表格：在表格里搜 ID <code>${esc(r.id)}</code>，修改后把「最后核查」改成今天。</p></section>`;
  const file = r.auto ? 'data/auto_records.csv' : 'data/records.csv';
  const line = lineOf(r.auto ? RAW.auto : RAW.records, r.id);
  const base = `https://github.com/${CFG.repo}`;
  const view = `${base}/blob/${CFG.branch}/${file}?plain=1${line ? '#L' + line : ''}`, edit = `${base}/edit/${CFG.branch}/${file}`;
  return `<section class="maint"><h3>维护这条记录</h3><p>文件 <code>${esc(file)}</code>${line ? ` · 第 <code>${line}</code> 行` : ''} · ID <code>${esc(r.id)}</code></p><ol><li>核对来源后点「编辑」，按 Ctrl+F 搜 ID 找到这一行。</li><li>只改需要改的字，不要动逗号和英文双引号。</li><li>每行最后两个值是「最后核查」和「更新人」：改成今天和你的名字，提醒就会消失。</li><li>改完点绿色的 Commit changes，1–2 分钟后刷新本页。</li></ol><div class="maint-actions"><a href="${esc(edit)}" target="_blank" rel="noopener">编辑数据表 ↗</a><a class="secondary" href="${esc(view)}" target="_blank" rel="noopener">查看这一行 ↗</a><button class="secondary" data-copy-id="${esc(r.id)}">复制 ID</button></div></section>`;
}
function openRecord(id) {
  const r = BY_ID.get(id); if (!r) return;
  $('drawerHeader').textContent = r['品牌'] + ' / ' + r.region;
  const img = imgSrc(r['截图链接']);
  const dates = [r['开始日期'] ? '开始 ' + r['开始日期'] : '', r['截止日期'] ? '截止 ' + r['截止日期'] : ''].filter(Boolean).join('；') || '未公开明确起止日期';
  $('drawerContent').innerHTML = `<div class="drawer-eyebrow"><span>${esc(r['活动类型'])}</span><span>· ${esc(r['奖励性质'] || '奖励性质见条款')}</span>${statusBadge(r)}${r.isSelf ? '<span class="self-badge">我方</span>' : ''}</div><h2 id="drawerTitle">${esc(r['标题'])}</h2>${r.auto ? `<div class="mon-panel quiet"><strong>自动发现 · ${esc(r['最后核查'] || '')} · ${esc(r['更新人'] || '')}</strong><p>这条由机器人从新闻 / 媒体 / 官网自动发现并建档，内容未经人工核实，请以来源为准。</p>${r['证据注释'] ? `<p>${esc(r['证据注释'])}</p>` : ''}</div>` : ''}<p class="drawer-reward">${esc(r['奖励摘要'] || '金额未公开，需确认')}</p>${monPanel(r)}${img ? `<figure class="drawer-screenshot"><img src="${esc(img)}" alt="${esc(r['品牌'])}活动页面截图"><figcaption>${esc(r['截图说明'] || '官方页面截图')}</figcaption></figure>` : ''}<div class="drawer-lead"><div><h3>给谁</h3><p>${esc(r['给谁'] || '按国家、实体和客户类别核验')}</p></div><div><h3>要做到什么</h3><p>${esc(r['门槛'] || '未公开，需确认')}</p></div></div>${r['可参考点'] ? `<aside class="analysis-panel"><strong>可参考点 · 研究分析，不是效果或合规结论</strong>${esc(r['可参考点'])}</aside>` : ''}${field('活动说明', r['活动说明'])}${field('国家资格与客户类别', [r['国家资格'], r['客户类别'] ? '客户类别：' + r['客户类别'] : ''].filter(Boolean).join('\n'))}${field('明确受限国家（不代表整个区域排除）', r['限制国家'])}${field('国家备注', r['国家备注'])}${field('限制来源范围', r['限制来源范围'])}${field('签约实体', r['签约实体'])}${field('完整达标与兑现条件', r['完整条款'])}${field('金额、单位与上限', r['金额上限'])}${field('产品范围', r['产品范围'])}${field('零售 / 专业客户边界', r['零售限制'])}${field('IB / 伙伴支持', r['IB支持'])}${field('办公室支持', r['办公室支持'])}${field('活动支持', r['活动支持'])}${field('预付与支付机制', r['预付机制'])}${field('支付窗口', r['支付窗口'])}${field('赠金交易量与 IB 佣金', r['赠金与IB佣金'])}${field('公开披露观察', r['公开披露观察'])}${field('其他限制', r['其他限制'])}${field('待核事项', r['待核事项'])}${field('证据注释', r['证据注释'])}${field('研究备注', r['研究备注'])}${field('活动日期', [dates, r['日期说明']].filter(Boolean).join('\n'))}${field('核查记录', '最后核查：' + (r['最后核查'] || '未标') + (r['来源日期'] ? '\n来源标注日期：' + r['来源日期'] : '') + '\n更新人：' + (r['更新人'] || '未标'))}<section class="detail-section"><h3>全部来源 · ${r.sources.length}</h3>${r.sources.map(u => `<a class="source-link" href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(domain(u))} ↗${urlState(u)}<small>${esc(u)}</small></a>`).join('') || '<p>暂无来源链接。</p>'}</section>${r['原始英文'] ? `<section class="detail-section"><details><summary>原始研究措辞（英文）</summary><p>${esc(r['原始英文'])}</p></details></section>` : ''}${maintPanel(r)}`;
  if (!$('recordDrawer').open) $('recordDrawer').showModal();
  $('recordDrawer').scrollTop = 0;
}
function toggleCompare(id) {
  if (compareIds.includes(id)) compareIds = compareIds.filter(x => x !== id);
  else {
    if (compareIds.length === 3) { toast('最多比较 3 项，请先移除一项。'); return; }
    if (compareIds.length && BY_ID.get(compareIds[0])['活动类型'] !== BY_ID.get(id)['活动类型']) { toast('只比较同类活动，请先清空已选项。'); return; }
    compareIds.push(id);
  }
  render();
}
function updateCompareBar() {
  compareIds = compareIds.filter(id => BY_ID.has(id));
  $('compareBar').hidden = !compareIds.length || VIEW !== 'promos';
  $('compareCount').textContent = '已选 ' + compareIds.length + ' / 3';
  $('compareSelections').innerHTML = compareIds.map(id => `<button data-remove-compare="${esc(id)}">${esc(BY_ID.get(id)['品牌'])} ×</button>`).join('');
  $('openComparison').disabled = compareIds.length < 2;
}
function openComparison() {
  if (compareIds.length < 2) return;
  const rs = compareIds.map(id => BY_ID.get(id));
  const rows = [['公开金额', r => r['奖励摘要']], ['奖励性质', r => r['奖励性质']], ['给谁 / 地区', r => r.region + '；' + (r['给谁'] || '')], ['达标条件', r => r['门槛']], ['状态', r => STATUS[r.status]], ['活动日期', r => [r['开始日期'], r['截止日期']].filter(Boolean).join(' — ') || '未注明'], ['可参考点', r => r['可参考点'] || '—'], ['最后核查', r => r['最后核查']]];
  $('comparisonTitle').textContent = rs[0]['活动类型'] + ' · 同类比较（' + rs.length + ' 项）';
  $('comparisonContent').innerHTML = '<p class="compare-intro">同类机制对照，不做收益排名。币种、国家、实体和奖励性质不同，不能只看最高数字。</p><div class="comparison-table-wrap"><table class="comparison-table"><thead><tr><th>比较维度</th>' + rs.map(r => `<th>${esc(r['品牌'])}<br><small>${esc(r['标题'])}</small></th>`).join('') + '</tr></thead><tbody>' + rows.map(([l, fn]) => `<tr><td>${esc(l)}</td>${rs.map(r => `<td>${esc(fn(r) || '—')}</td>`).join('')}</tr>`).join('') + '<tr><td>原始证据</td>' + rs.map(r => `<td><button data-compare-open-record="${esc(r.id)}">完整条款与 ${r.sources.length} 个来源 →</button></td>`).join('') + '</tr></tbody></table></div>';
  $('comparisonDialog').showModal();
}

/* ---------- 线下活动：两块——行业展会（只看哪里办什么展）/ 竞品赞助 ---------- */
const isExpoish = r => /展|expo|fair|summit|峰会|festival/i.test(r['标题']);
function rangeTxt(a, b) {
  if (!a) return '';
  if (!b || fmt(a) === fmt(b)) return a.getFullYear() + '年' + md(a);
  return a.getFullYear() + '年' + (a.getMonth() === b.getMonth() ? (a.getMonth() + 1) + '月' + a.getDate() + '–' + b.getDate() + '日' : md(a) + '–' + md(b));
}
const ocStat = (n, label, hot) => `<div class="oc-stat${hot ? ' hot' : ''}"><b>${n}</b><span>${esc(label)}</span></div>`;
function renderOffline() {
  const region = $('offlineRegion').value || 'all', t = today();
  if (offlineKind === 'sponsor') {
    const list = RECORDS.filter(r => r.offline && r.okind === 'sponsor' && r.audience === 'direct' && !isExpoish(r) && (region === 'all' || r.region === region))
      .sort((a, b) => (fmt(parseDate(b['开始日期'])) || '0').localeCompare(fmt(parseDate(a['开始日期'])) || '0'));
    $('timeline').innerHTML = list.length ? `<div class="tl-items">${list.map(r => { const s0 = parseDate(r['开始日期']), e0 = parseDate(r['截止日期']); const when = s0 ? (e0 ? rangeTxt(s0, e0) : s0.getFullYear() + ' 年起') : '时间未公开'; return `<button class="tl-item simple" data-open="${esc(r.id)}"><span class="tl-date">${esc(when)}</span><span class="tl-body"><span class="tl-title">${esc(r['品牌'])}${r.isSelf ? '<span class="self-badge">我方</span>' : ''} · ${esc(r['标题'])}</span><span class="tl-sub">${esc(r.region)} · ${esc(short(r['奖励摘要'] || r['活动说明'], 80))}</span></span><span class="tl-arrow">→</span></button>`; }).join('')}</div>` : '<div class="empty"><strong>这个地区暂无赞助记录</strong></div>';
    $('offlineSummary').innerHTML = ocStat(list.length, '个竞品赞助') + ocStat(new Set(list.map(r => r['品牌'])).size, '个品牌');
    return;
  }
  const evs = EVENTS.filter(e => region === 'all' || e['地区'] === region);
  const up = evs.filter(e => (e.end || e.start) >= t).sort((a, b) => a.start - b.start);
  const past = evs.filter(e => (e.end || e.start) < t).sort((a, b) => b.start - a.start);
  const row = e => `<a class="tl-item simple${(e.end || e.start) < t ? ' past' : ''}" href="${esc(safeUrl(e.sources[0] || '#'))}" target="_blank" rel="noopener noreferrer"><span class="tl-date">${esc(rangeTxt(e.start, e.end))}${(e.end || e.start) >= t ? `<small>${e.start > t ? Math.round((e.start - t) / 864e5) + ' 天后' : '进行中'}</small>` : ''}</span><span class="tl-body"><span class="tl-title">${esc(e['城市'])} · ${esc(e['名称'])}</span></span><span class="tl-arrow">↗</span></a>`;
  $('timeline').innerHTML = (up.length ? `<div class="tl-group"><h3>即将举办</h3><div class="tl-items">${up.map(row).join('')}</div></div>` : '') + (past.length ? `<div class="tl-group"><h3>已举办</h3><div class="tl-items">${past.map(row).join('')}</div></div>` : '') || '<div class="empty"><strong>这个地区暂无展会记录</strong></div>';
  $('offlineSummary').innerHTML = ocStat(evs.length, '场行业展会') + ocStat(up.length, '场即将举办', up.length > 0);
}
function openEvent(id) {
  const e = EVENTS.find(x => x['ID'] === id); if (!e) return;
  const m = MON?.records?.[id];
  $('researchTitle').textContent = '行业展会';
  $('researchContent').innerHTML = `<h2>${esc(e['名称'])}</h2><p><b>${esc(fmt(e.start))}${e.end && fmt(e.end) !== fmt(e.start) ? ' – ' + esc(fmt(e.end)) : ''}</b> · ${esc(e['城市'])}${e['场馆'] && e['场馆'] !== '—' ? ' · ' + esc(e['场馆']) : ''} · ${esc(e['类型'])} · ${esc(e['地区'])}</p><p>${esc(e['说明'])}</p><h3>已知竞品参与</h3><p>${e.brands.length ? e.brands.map(esc).join('、') : '暂未公开。可关注主办方的赞助商 / 参展商名单，机器人会每天检查来源页有没有更新。'}</p>${m ? `<h3>自动监测</h3><p>${m.changed && m.changed > (e['最后核查'] || '') ? '来源页在 ' + esc(m.changed) + ' 有更新，可能新增了赞助商或参展商，请打开确认。' : '来源页最近一次检查：' + esc(m.checked) + '，没有检测到实质变化。'}</p>` : ''}<h3>来源</h3><div class="research-sources">${e.sources.map(u => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(domain(u))} ↗</a>`).join('') || '暂无'}</div><p class="risk-note">数据文件：data/events.csv · ID ${esc(id)} · 最后核查 ${esc(e['最后核查'] || '未标')}</p>`;
  $('researchDialog').showModal();
}

/* ---------- 地区策略：按公开资料自动统计 ---------- */
function topCounts(list, key, n) { const c = new Map(); list.forEach(r => { const v = typeof key === 'function' ? key(r) : r[key]; if (v) c.set(v, (c.get(v) || 0) + 1); }); return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }
function renderRegions() {
  const allCur = RECORDS.filter(r => inList(r) && !r.offline);
  const globalTypes = topCounts(allCur, '活动类型', 10).map(([k]) => k);
  const keys = Object.keys(REGIONS).filter(k => k !== '全球');
  const stats = keys.map(k => {
    const rs = RECORDS.filter(r => r.region === k), cur = rs.filter(r => inList(r) && !r.offline);
    return { k, rs, cur, brands: new Set(cur.map(r => r['品牌'])).size };
  });
  const maxBrands = Math.max(...stats.map(s => s.brands), 1);
  $('regionGrid').innerHTML = stats.sort((a, b) => b.cur.length - a.cur.length).map(({ k, rs, cur, brands }) => {
    const direct = cur.filter(r => r.audience === 'direct').length, ib = cur.length - direct;
    const recent = rs.filter(r => r.foundDays <= 30).length;
    const heat = brands >= maxBrands * .66 ? ['h3', '竞争激烈'] : brands >= maxBrands * .33 ? ['h2', '竞争中等'] : ['h1', '竞争较少'];
    const types = topCounts(cur, '活动类型', 5), maxT = Math.max(...types.map(t => t[1]), 1);
    const rewards = topCounts(cur.filter(r => r.audience === 'direct'), '奖励性质', 3);
    const ibRecs = cur.filter(r => r.audience === 'ib');
    const cpa = ibRecs.filter(r => /cpa/i.test(r['活动类型'] + r['标题']));
    const offline = rs.filter(r => r.offline).sort((a, b) => (fmt(parseDate(b['开始日期'])) || '').localeCompare(fmt(parseDate(a['开始日期'])) || ''));
    const restricted = cur.filter(r => r['限制国家']).length;
    const present = new Set(cur.map(r => r['活动类型']));
    const gaps = globalTypes.filter(t => !present.has(t)).slice(0, 5);
    const self = rs.filter(r => r.isSelf);
    const res = RESEARCH?.regions?.[k];
    const insight = res?.headline || (res?.insights || [])[0]?.title || '';
    const link = r => `<button data-open="${esc(r.id)}"><b>${esc(r['品牌'])}</b>${esc(short(r['标题'], 40))}</button>`;
    return `<article class="region-card"><header><h2><small>${esc(REGIONS[k].en)}</small>${esc(k)}</h2><span class="heat ${heat[0]}">${heat[1]}</span></header>
<div class="metrics"><div><b>${brands}</b><span>在推品牌</span></div><div><b>${cur.length}</b><span>在列方案</span></div><div><b>${direct} / ${ib}</b><span>直客 / IB</span></div><div><b>${recent}</b><span>近 30 天新增或核查</span></div></div>
<div class="rc-block"><h3>主流打法</h3>${types.length ? `<div class="bars">${types.map(([t, n]) => `<div class="bar"><span>${esc(t)}</span><i style="width:${Math.max(6, n / maxT * 100)}%"></i><em>${n}</em></div>`).join('')}</div>` : '<p>暂无在列方案。</p>'}</div>
${rewards.length ? `<div class="rc-block"><h3>直客奖励形式</h3><p>${rewards.map(([t, n]) => esc(t) + ' ' + n).join(' · ')}</p></div>` : ''}
<div class="rc-block"><h3>IB 生态</h3><p>${ibRecs.length ? `${ibRecs.length} 个公开 IB / 伙伴方案，其中 CPA ${cpa.length} 个。` : '暂无公开 IB 方案。'}</p>${cpa.length ? `<div class="rc-links">${cpa.slice(0, 3).map(r => `<button data-open="${esc(r.id)}"><b>${esc(r['品牌'])}</b>${esc(short(r['奖励摘要'] || r['标题'], 46))}</button>`).join('')}</div>` : ''}</div>
<div class="rc-block"><h3>线下动作 · ${offline.length}</h3>${offline.length ? `<div class="rc-links">${offline.slice(0, 3).map(link).join('')}</div>` : '<p>暂无公开的线下活动记录。</p>'}</div>
<div class="rc-block"><h3>准入提示</h3><p>${restricted ? `${restricted} 个在列方案写明了受限国家，参考前先看签约实体与国家资格。` : '在列方案里没有写明受限国家，仍需逐条核验。'}</p></div>
${gaps.length ? `<div class="rc-block"><h3>竞品在这里较少做</h3><div class="gap-list">${gaps.map(g => `<span>${esc(g)}</span>`).join('')}</div></div>` : ''}
${insight ? `<div class="rc-block"><h3>研究要点</h3><p>${esc(short(insight, 180))}</p></div>` : ''}
<div class="self-line">${self.length ? `<b>D Prime 在此</b>：${self.length} 条公开活动 · ${self.slice(0, 2).map(r => esc(short(r['标题'], 30))).join('；')}` : '<b>D Prime 在此</b>：暂无公开活动记录'}</div>
<button class="go" data-go-region="${esc(k)}">看 ${esc(k)} 的全部活动 →</button></article>`;
  }).join('');
}

/* ---------- 玩法案例库 ---------- */
function renderPlaybook() {
  const cat = $('playCategory').value, risk = $('playRisk').value;
  const list = PLAYBOOK.filter(p => (playIndustry === 'all' || p['行业'] === playIndustry) && (!cat || p['玩法类别'] === cat) && (!risk || p['合规风险'] === risk));
  $('playSummary').textContent = list.length + ' 个案例';
  $('playGrid').innerHTML = list.map(p => {
    const rec = (p['关联记录'] || '').split(/\s*\|\s*/).filter(id => BY_ID.has(id));
    const srcs = (p['来源链接'] || '').split(/\s*\|\s*/).filter(u => /^https?:/.test(u));
    return `<article class="play-card"><div class="play-top"><div><span class="play-meta">${esc(p['平台'])} · ${esc(p['行业'])} · ${esc(p['玩法类别'])}${p['来源日期'] ? ' · ' + esc(p['来源日期']) : ''}</span><h2>${esc(p['案例名'])}</h2></div><span class="risk r${esc(p['合规风险'])}">合规风险 ${esc(p['合规风险'] || '待评估')}</span></div>
<p><span class="label">怎么玩</span>${esc(p['玩法拆解'])}</p><p><span class="label">为什么有效</span>${esc(p['为什么有效'])}</p><div class="borrow"><p><span class="label">D Prime 可以怎么借鉴</span>${esc(p['D Prime 可以怎么借鉴'])}</p></div>${p['风险说明'] && p['风险说明'] !== '—' ? `<p class="risk-note">⚠ ${esc(p['风险说明'])}</p>` : ''}<div class="play-links">${rec.map(id => `<a href="#" data-open-link="${esc(id)}">查看活动记录 →</a>`).join('')}${srcs.map(u => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(domain(u))} ↗</a>`).join('')}</div></article>`;
  }).join('') || '<div class="empty"><strong>没有符合条件的案例</strong></div>';
}

/* ---------- 覆盖与方法 / 疑似新活动 ---------- */
function openResearch() {
  const counts = Object.keys(STATUS).map(s => STATUS[s] + ' ' + RECORDS.filter(r => r.status === s).length).join('；');
  const brands = [...new Set(RECORDS.map(r => r['品牌']))];
  const byRegion = Object.keys(REGIONS).map(k => `<li>${esc(k)}：${RECORDS.filter(r => r.region === k).length} 条 · ${esc([...new Set(RECORDS.filter(r => r.region === k).map(r => r['品牌']))].join('、') || '暂无')}</li>`).join('');
  $('researchTitle').textContent = '资料覆盖与更新方式';
  $('researchContent').innerHTML = `<h2>资料覆盖与更新方式</h2><p>数据来源：${({ sheet: 'Google 表格（每次打开页面实时读取）', repo: '仓库数据表 data/records.csv', embedded: '网页内置备份（不会自动更新）' })[META.source] || ''}。读取时间 ${esc(META.loadedAt?.toLocaleString('zh-CN') || '')}；最新一条核查日期 ${esc(META.latestCheck || '未标')}。</p><p>共 ${RECORDS.length} 条 · ${brands.length} 个品牌 · 行业展会 ${EVENTS.length} 场 · 玩法案例 ${PLAYBOOK.length} 个。${esc(counts)}。</p><h3>自动监测</h3><p>${MON ? `最近一次运行：${esc(monTime())}（吉隆坡时间）。检查 ${MON.summary?.urls ?? 0} 个来源网址：${MON.summary?.changed ?? 0} 条记录来源有实质更新，${MON.summary?.ended_hint ?? 0} 条可能已结束，${MON.summary?.unreachable ?? 0} 条来源打不开（多为网站拦截机器人）。只看与活动相关的句子：网站导航、页脚免责声明、新闻页侧栏、排行榜数字的变化不算更新。` : '尚未运行。每天早上 8:00（吉隆坡时间）自动运行。'}</p><h3>全市场新活动发现</h3><p>${DISC ? `最近一次：${esc(DISC.generated)}。扫描 ${DISC.sources?.length || 0} 个来源，得到 ${DISC.candidates || 0} 条候选，今天新增 ${DISC.new_today?.length || 0} 条；自动记录累计 ${DISC.total_auto || 0} 条。同一活动的多篇报道只留一条。` : '尚未运行，或在本地打开时不显示。'}</p><p>来源包括：Google 新闻（按品牌 × 促销 / 线下活动关键词，英 / 繁中 / 简中 / 马来文）、行业媒体 RSS、官网新闻页、公开 Telegram 频道。微信群、私人群组和需要登录的社媒抓取不到。</p><h3>状态怎么算</h3><p>「人工状态」留空时按今天日期判断：截止日已过＝已结束；开始日未到＝尚未开始；${CFG.dueSoonDays} 天内截止＝即将截止；没有截止日＝在列 · 未标期。填了「待核 / 不适用 / 已结束 / 进行中 / 预告」则以人工为准。</p><h3>各地区覆盖</h3><ul>${byRegion}</ul><h3>已知缺口</h3><ul><li>华语市场（港澳台、新马）的活动多在社群和 IB 渠道传播，公开页面少，欢迎同事补充。</li><li>线下活动多以新闻稿、展会名单和社媒照片出现，覆盖不全；赞助商名单常在展会前几周才公布。</li><li>184 条记录导入自 2026-10-28 的参考底稿，之后由自动监测持续复查。</li></ul><h3>怎么更新</h3><p>点开任意卡片，底部「维护这条记录」有编辑入口和步骤。详细说明见 <a href="${esc(CFG.guideUrl)}" target="_blank" rel="noopener">更新指南</a>。</p>${regionResearchHTML()}<h3>研究边界</h3><p>只使用公开资料，不是穷尽名单，不代表某地区所有居民都可参加。CFD 及杠杆交易风险高；赠金、现金与积分性质不同，请勿混同。「可参考点」与玩法案例是机制分析，不是效果或合规结论。</p>`;
  $('researchDialog').showModal();
}
function openDiscoveries() {
  const ds = MON?.discoveries || [];
  $('researchTitle').textContent = '疑似新活动';
  $('researchContent').innerHTML = `<h2>各品牌活动列表页上新出现的链接</h2><p>${MON ? '更新于 ' + esc(MON.generated) + '。共 ' + ds.length + ' 条，按发现日期排序。不是每条都是新活动，请点开确认；值得收录的发给 Andrea 或按维护手册新增。' : '自动监测尚未运行。'}</p>` +
    (ds.length ? '<div class="disc-list">' + ds.map(d => `<a class="disc" href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener noreferrer"><span class="disc-date">${esc(d.first_seen)}</span><b>${esc(d.brand)}</b><span>${esc(d.region || '')}</span><span class="disc-title">${esc(d.title)}</span><small>${esc(d.url)}</small></a>`).join('') + '</div>' : '<p>暂时没有新发现。</p>');
  $('researchDialog').showModal();
}
function regionResearchHTML() {
  if (!RESEARCH?.regions) return '';
  return '<h3>区域研究（来自 2026-10-28 参考底稿）</h3>' + Object.entries(RESEARCH.regions).map(([k, m]) => {
    const sup = m.support ? `<h3>IB 公开支持对照</h3>${['summary', 'economics', 'tools', 'office_events', 'prepayment', 'disclosure'].map(x => m.support[x] ? `<p>${esc(m.support[x])}</p>` : '').join('')}<div class="research-sources">${(m.support.record_ids || []).filter(id => BY_ID.has(id)).map(id => `<a href="#" data-research-record="${esc(id)}">${esc(BY_ID.get(id)['品牌'])} 证据 →</a>`).join('')}</div>` : '';
    const ins = (m.insights || []).map(i => `<h3>${esc(i.title)}</h3><p>${esc(i.fact)}</p>${i.analysis ? `<p>分析：${esc(i.analysis)}</p>` : ''}${i.transparency ? `<p>公开程度：${esc(i.transparency)}</p>` : ''}<div class="research-sources">${(i.record_ids || []).filter(id => BY_ID.has(id)).map(id => `<a href="#" data-research-record="${esc(id)}">${esc(BY_ID.get(id)['品牌'])} 记录 →</a>`).join('')}${(i.urls || []).map(u => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(domain(u))} ↗</a>`).join('')}</div>`).join('');
    const reg = (m.regulatory || []).map(v => `<p>${esc(v.title)} · ${esc(v.detail)} ${v.url ? `<a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener noreferrer">原始来源 ↗</a>` : ''}</p>`).join('');
    const cmp = (m.comparators || []).map(c => `<p>${esc(c.title)}：${esc(c.summary || '')} ${c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">来源 ↗</a>` : ''}</p>`).join('');
    return `<details><summary>${esc(k)} · ${RECORDS.filter(r => r.region === k).length} 条记录</summary>${m.headline ? `<p>${esc(m.headline)}</p>` : ''}${m.scope ? `<p>${esc(m.scope)}</p>` : ''}${sup}${ins}${m.gaps ? `<h3>覆盖与待核缺口</h3><p>${esc(m.gaps)}</p>` : ''}${reg ? `<h3>监管背景</h3>${reg}` : ''}${cmp ? `<h3>范围外对照（不计入在列）</h3>${cmp}` : ''}</details>`;
  }).join('');
}
function renderMeta() {
  const t = META.loadedAt ? META.loadedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  $('todayLabel').textContent = '今日 ' + fmt(today());
  $('sourceLabel').textContent = '数据载入 ' + t + ' · 来源：' + ({ sheet: 'Google 表格（实时）', repo: '主数据表', embedded: '离线备份' }[META.source] || '');
  $('checkLabel').textContent = (MON ? '系统更新 ' + monTime() + ' · 每日 08:00 自动更新' : '自动监测尚未运行') + ' · 人工核查 ' + (META.latestCheck || '未标');
}
function rerenderAll() { populateFilters(); renderMeta(); if (VIEW === 'promos') render(); else showView(VIEW, false); }

/* ---------- 事件 ---------- */
document.addEventListener('click', e => {
  const o = e.target.closest('[data-open]'); if (o && !e.target.closest('[data-compare]')) { openRecord(o.dataset.open); return; }
  const l = e.target.closest('[data-open-link]'); if (l) { e.preventDefault(); openRecord(l.dataset.openLink); return; }
  const v = e.target.closest('[data-view]'); if (v) { e.preventDefault(); document.querySelectorAll('dialog[open]').forEach(d => d.close()); showView(v.dataset.view); return; }
  const g = e.target.closest('[data-go-region]'); if (g) { showView('promos'); $('statusFilter').value = 'current'; setRegion(g.dataset.goRegion); document.querySelector('.audience-bar').scrollIntoView({ behavior: 'smooth' }); return; }
  const tl = e.target.closest('[data-tl]'); if (tl) { const [k, id] = tl.dataset.tl.split(/:(.+)/); k === 'event' ? openEvent(id) : openRecord(id); return; }
  const d = e.target.closest('[data-digest]'); if (d) { $('statusFilter').value = { recent: 'recent', flag: 'flag', due: 'due', ended: 'ended7' }[d.dataset.digest]; setAudience('all'); visibleCount = 30; render(); $('recordCards').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const cid = e.target.closest('[data-copy-id]'); if (cid) { navigator.clipboard?.writeText(cid.dataset.copyId).then(() => toast('已复制 ID：' + cid.dataset.copyId + '。在编辑页按 Ctrl+F 粘贴即可找到这一行。'), () => toast('复制失败')); return; }
  if (!e.target.closest('.more-menu')) document.querySelectorAll('.more-menu[open]').forEach(m => m.removeAttribute('open'));
});
$('recordCards').addEventListener('click', e => { const c = e.target.closest('[data-compare]'); if (c) toggleCompare(c.dataset.compare); });
function setAudience(a) { audience = a; document.querySelectorAll('[data-audience]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.audience === a))); $('audienceHint').textContent = { all: '直客活动与 IB 合作方案', direct: '给交易者的激励与活动', ib: '给介绍经纪人、联盟伙伴的报酬与支持' }[a]; compareIds = []; populateTypes(); }
document.querySelectorAll('[data-audience]').forEach(b => b.addEventListener('click', () => { setAudience(b.dataset.audience); visibleCount = 9; render(); }));
for (const id of ['searchInput', 'brokerFilter', 'typeFilter', 'statusFilter']) $(id).addEventListener(id === 'searchInput' ? 'input' : 'change', () => { visibleCount = 9; render(); });
$('regionFilter').onchange = () => setRegion($('regionFilter').value);
$('clearFilters').onclick = () => { for (const id of ['searchInput', 'brokerFilter', 'typeFilter']) $(id).value = ''; $('statusFilter').value = 'current'; setAudience('all'); setRegion('all'); };
$('loadMore').onclick = () => { visibleCount += 9; render(); };
$('compareSelections').addEventListener('click', e => { const b = e.target.closest('[data-remove-compare]'); if (b) toggleCompare(b.dataset.removeCompare); });
$('clearCompare').onclick = () => { compareIds = []; render(); };
$('openComparison').onclick = openComparison;
$('comparisonContent').addEventListener('click', e => { const b = e.target.closest('[data-compare-open-record]'); if (b) { $('comparisonDialog').close(); openRecord(b.dataset.compareOpenRecord); } });
for (const id of ['openResearch', 'openResearchBottom']) $(id).onclick = () => { document.querySelectorAll('.more-menu[open]').forEach(m => m.removeAttribute('open')); openResearch(); };
$('researchContent').addEventListener('click', e => { const a = e.target.closest('[data-research-record]'); if (a) { e.preventDefault(); $('researchDialog').close(); openRecord(a.dataset.researchRecord); } });
$('drawerContent').addEventListener('click', async e => { const b = e.target.closest('[data-copy-tsv]'); if (!b) return; const r = BY_ID.get(b.dataset.copyTsv); try { await navigator.clipboard.writeText(r.mon.ai.tsv); toast('已复制整行（ID：' + r.id + '）。'); } catch { toast('复制失败，请手动选中复制。'); } });
$('reloadData').onclick = async () => { document.querySelectorAll('.more-menu[open]').forEach(m => m.removeAttribute('open')); try { await loadData(); LOAD_ERROR = ''; rerenderAll(); toast('已重新读取，共 ' + RECORDS.length + ' 条'); } catch (err) { toast('读取失败：' + err.message); } };
document.querySelectorAll('[data-okind]').forEach(b => b.addEventListener('click', () => { offlineKind = b.dataset.okind; document.querySelectorAll('[data-okind]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderOffline(); }));
$('offlineRegion').onchange = renderOffline;
document.querySelectorAll('[data-industry]').forEach(b => b.addEventListener('click', () => { playIndustry = b.dataset.industry; document.querySelectorAll('[data-industry]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderPlaybook(); }));
$('playCategory').onchange = renderPlaybook; $('playRisk').onchange = renderPlaybook;
window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
$('exportCsv').onclick = () => {
  document.querySelectorAll('.more-menu[open]').forEach(m => m.removeAttribute('open'));
  const clean = v => { let t = String(v ?? ''); if (/^[\s]*[=+@-]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const cols = ['状态', ...COLS];
  const rows = VIEW === 'offline' ? RECORDS.filter(r => r.offline) : filtered;
  const csv = '﻿' + cols.join(',') + '\r\n' + rows.map(r => cols.map(c => clean(c === '状态' ? STATUS[r.status] : r[c])).join(',')).join('\r\n');
  const u = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })), a = document.createElement('a');
  a.href = u; a.download = '竞品促销监测_' + (VIEW === 'offline' ? '线下活动' : (selectedRegion === 'all' ? '全部地区' : selectedRegion)) + '_' + fmt(today()) + '.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
  toast('已导出 ' + rows.length + ' 条');
};

/* ---------- 地球（示意图） ---------- */
const LAND=[ [[-168,70],[-150,72],[-136,68],[-128,59],[-133,55],[-125,49],[-123,40],[-117,32],[-111,29],[-110,23],[-103,20],[-97,16],[-91,18],[-87,21],[-86,17],[-82,9],[-78,9],[-82,13],[-84,22],[-81,25],[-80,31],[-75,35],[-70,42],[-63,45],[-55,51],[-61,56],[-64,60],[-76,63],[-83,69],[-97,70],[-105,73],[-125,74],[-146,72]], [[-81,12],[-73,11],[-70,12],[-60,8],[-51,3],[-47,-1],[-35,-5],[-35,-10],[-39,-18],[-43,-23],[-48,-28],[-52,-33],[-58,-38],[-65,-55],[-72,-54],[-75,-46],[-73,-38],[-71,-30],[-70,-18],[-76,-10],[-81,-5]], [[-52,60],[-44,60],[-38,67],[-21,70],[-18,77],[-31,83],[-46,83],[-59,78],[-62,70]], [[-17,21],[-17,15],[-15,11],[-10,6],[-5,5],[4,4],[9,1],[10,-5],[13,-12],[12,-18],[15,-27],[18,-34],[26,-34],[33,-25],[36,-18],[40,-12],[40,-3],[44,2],[51,12],[44,11],[40,16],[36,22],[33,30],[28,32],[20,33],[11,37],[5,36],[-4,35],[-10,30],[-13,25]], [[-10,36],[-10,43],[-2,44],[-5,48],[-1,50],[8,54],[9,58],[5,60],[5,66],[13,70],[26,71],[30,66],[40,65],[45,69],[61,69],[70,73],[90,75],[110,77],[131,72],[150,70],[169,67],[180,65],[178,59],[164,59],[159,52],[153,47],[144,46],[141,41],[131,43],[130,38],[123,39],[121,31],[116,23],[109,20],[105,16],[109,12],[106,9],[102,13],[100,7],[103,1],[99,3],[97,10],[94,17],[90,22],[85,21],[79,8],[76,9],[73,17],[68,24],[62,25],[57,25],[57,18],[52,16],[45,13],[42,16],[39,22],[35,29],[34,35],[29,37],[28,41],[23,40],[24,35],[20,38],[17,41],[16,38],[13,42],[10,45],[7,44],[3,43],[-1,43],[-2,37]], [[-10,50],[-5,50],[-3,53],[-4,57],[-6,59],[-8,56]], [[-11,51],[-7,51],[-6,55],[-10,55]], [[-25,63],[-14,64],[-15,67],[-23,67]], [[47,-13],[50,-16],[49,-23],[45,-26],[44,-21]], [[113,-22],[114,-27],[115,-34],[123,-35],[130,-32],[137,-35],[140,-38],[147,-38],[153,-29],[151,-22],[145,-15],[141,-12],[136,-13],[131,-12],[127,-15],[122,-17]], [[166,-34],[174,-39],[178,-39],[175,-35],[172,-34]], [[167,-46],[171,-43],[173,-40],[171,-40],[166,-44]], [[95,5],[102,1],[105,-6],[101,-5],[97,0]], [[106,-6],[114,-7],[115,-9],[108,-8]], [[109,7],[117,6],[118,1],[115,-4],[110,-3]], [[120,-1],[124,2],[125,1],[122,-4],[120,-5]], [[119,19],[122,18],[124,13],[126,8],[125,6],[121,12]], [[131,-2],[140,-2],[149,-6],[151,-10],[141,-9],[135,-4]], [[137,34],[141,40],[145,44],[146,43],[142,36],[139,34]], [[130,31],[132,34],[135,35],[133,32]], [[-84,22],[-79,22],[-74,20],[-78,20]], [[-73,19],[-68,18],[-70,20]] ];
/* ---------- 平面点阵世界地图：灰点 = 陆地，红点大小 = 该地区在推方案数，点击筛选 ---------- */
const MAP_W = 360, MAP_H = 150, LAT_TOP = 76, LAT_BOT = -58;
const mx = lo => (lo + 180) / 360 * MAP_W, my = la => (LAT_TOP - la) / (LAT_TOP - LAT_BOT) * MAP_H;
function inPoly(x, y, p) { let ins = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) ins = !ins; } return ins; }
const MAP_DOTS = []; for (let la = LAT_TOP - 2; la > LAT_BOT; la -= 3.6) for (let lo = -178; lo < 180; lo += 3.6) if (LAND.some(p => inPoly(lo, la, p))) MAP_DOTS.push([mx(lo), my(la)]);
/* 标签位置手工排好，避免互相遮挡：[x, y, 对齐] */
const MAP_LABELS = { '欧洲': [150, 14, 'end'], '伊朗/伊拉克': [246, 14, 'start'], '华语': [318, 40, 'start'], '中东北非': [160, 62, 'end'], '东南亚': [306, 104, 'start'], '非洲': [170, 112, 'end'], '拉美': [88, 128, 'end'], '全球': [14, 18, 'start'] };
function regionCount(k) { return RECORDS.filter(r => r.region === k && !r.offline && (audience === 'all' || r.audience === audience) && inList(r)).length; }
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); if (parent) parent.appendChild(e); return e; }
function renderMap() {
  const svg = $('worldMap'); if (!svg) return;
  svg.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`); svg.textContent = '';
  const land = el('g', { class: 'map-land' }, svg);
  for (const [x, y] of MAP_DOTS) el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 1.05 }, land);
  const counts = Object.fromEntries(Object.keys(REGIONS).map(k => [k, regionCount(k)])), max = Math.max(1, ...Object.values(counts));
  const any = selectedRegion !== 'all';
  for (const [k, reg] of Object.entries(REGIONS)) {
    const [lx, ly, anchor] = MAP_LABELS[k] || [0, 0, 'start'], sel = selectedRegion === k;
    const g = el('g', { class: 'map-region' + (sel ? ' sel' : '') + (any && !sel ? ' dim' : ''), tabindex: 0, role: 'button', 'aria-pressed': String(sel), 'aria-label': `${k}：${counts[k]} 个在推方案，点击筛选` }, svg);
    if (reg.lon != null) {
      const x = mx(reg.lon), y = my(reg.lat), r = 3 + Math.sqrt(counts[k] / max) * 7;
      el('line', { class: 'map-leader', x1: x, y1: y, x2: lx, y2: ly - 3 }, g);
      el('circle', { class: 'map-halo', cx: x, cy: y, r: r + 3 }, g);
      if (RECORDS.some(x => x.region === k && x.foundDays <= 7)) for (const p of ['p1', 'p2']) el('circle', { class: 'map-pulse ' + p, cx: x, cy: y, r }, g);
      el('circle', { class: 'map-dot', cx: x, cy: y, r }, g);
    }
    const label = el('g', { class: 'map-label' }, g);
    const rect = el('rect', { rx: 7, ry: 7, height: 14 }, label);
    const t = el('text', { x: lx, y: ly + 1.5, 'text-anchor': anchor }, label);
    el('tspan', { class: 'map-name' }, t).textContent = k + ' ';
    el('tspan', { class: 'map-num' }, t).textContent = counts[k];
    const w = t.getComputedTextLength ? t.getComputedTextLength() : 40;
    const left = anchor === 'end' ? lx - w : anchor === 'middle' ? lx - w / 2 : lx;
    rect.setAttribute('x', (left - 6).toFixed(1)); rect.setAttribute('y', ly - 9); rect.setAttribute('width', (w + 12).toFixed(1));
    const go = () => { hideTip(); setRegion(selectedRegion === k ? 'all' : k); };
    g.addEventListener('pointerdown', e => { lastPointer = e.pointerType; });
    g.addEventListener('click', e => {
      // 手机：第一次点先出小卡片，再点一次才筛选
      if (lastPointer === 'touch' && tipFor !== k) { showTip(k, e); return; }
      go();
    });
    g.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { lastPointer = 'mouse'; showTip(k, e); } });
    g.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && tipFor === k) moveTip(e); });
    g.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTip(); });
    g.addEventListener('focus', () => { if (g.matches(':focus-visible')) showTip(k); });
    g.addEventListener('blur', hideTip);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
}
/* 悬停小卡片：在推方案数（直客 / IB）、活动最多的 3 个品牌、本周新增 */
let tipFor = '', lastPointer = 'mouse';
function regionStats(k) {
  const all = RECORDS.filter(r => r.region === k && !r.offline);
  const cur = all.filter(r => inList(r) && (audience === 'all' || r.audience === audience));
  const top = topCounts(cur, '品牌', 3);
  return { cur, direct: cur.filter(r => r.audience === 'direct').length, ib: cur.filter(r => r.audience === 'ib').length, top, week: RECORDS.filter(r => r.region === k && r.foundDays <= 7).length };
}
function showTip(k, e) {
  const tip = $('mapTip'), st = regionStats(k);
  tipFor = k;
  tip.innerHTML = `<b class="tip-title">${esc(k)}</b><span class="tip-row"><em>${st.cur.length}</em> 个在推方案 · 直客 ${st.direct} / IB ${st.ib}</span>${st.top.length ? `<span class="tip-row">活动最多：${st.top.map(([b, n]) => esc(b) + ' ' + n).join('、')}</span>` : '<span class="tip-row">暂无在推方案</span>'}<span class="tip-row">本周新增或核查 <em>${st.week}</em> 条（含线下）</span><span class="tip-cta">${selectedRegion === k ? '点击取消筛选' : (lastPointer === 'touch' ? '再点一次查看全部 →' : '点击查看全部 →')}</span>`;
  tip.hidden = false;
  moveTip(e, k);
}
function moveTip(e, k) {
  const tip = $('mapTip'), wrap = tip.parentElement.getBoundingClientRect();
  let x, y;
  if (e && e.clientX != null) { x = e.clientX - wrap.left; y = e.clientY - wrap.top; }
  else { const reg = REGIONS[k || tipFor], svg = $('worldMap').getBoundingClientRect(), sc = svg.width / MAP_W; x = (reg && reg.lon != null ? mx(reg.lon) : 30) * sc; y = (reg && reg.lon != null ? my(reg.lat) : 20) * sc; }
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > wrap.width) left = x - w - 14;
  if (left < 0) left = 0;
  if (top + h > wrap.height + 40) top = y - h - 14;
  tip.style.left = left + 'px'; tip.style.top = Math.max(-10, top) + 'px';
}
document.addEventListener('pointerdown', e => { if (tipFor && !e.target.closest('.map-region')) hideTip(); });
function hideTip() { tipFor = ''; const tip = $('mapTip'); if (tip) tip.hidden = true; }

/* ---------- 启动 ---------- */
(async function init() {
  try { await loadData(); }
  catch (err) { LOAD_ERROR = err.message + '。请点右上角「更多 → 重新读取」，或把截图发给 Andrea。'; $('sourceLabel').textContent = '数据读取失败'; render(); return; }
  populateFilters(); renderMeta(); setAudience('all');
  showView(location.hash.slice(1) || 'promos', false);
})();

/* 其他页的卡片也依次浮现 */
for (const [fn, sel] of [['renderRegions', '#regionGrid > *'], ['renderPlaybook', '#playGrid > *'], ['renderOffline', '#timeline .tl-item']]) {
  const orig = window[fn];
  window[fn] = function () { const out = orig.apply(this, arguments); revealIn(document.querySelectorAll(sel)); return out; };
}
/* 顶部导航：往下滚变窄 + 毛玻璃；筛选条吸顶时加阴影 */
(() => {
  const head = document.querySelector('header'), bar = document.querySelector('.filter-bar');
  let on = false, ticking = false;
  const check = () => {
    ticking = false;
    const y = scrollY;
    if (!on && y > 80) { on = true; head.classList.add('scrolled'); document.documentElement.classList.add('scrolled'); }
    else if (on && y < 20) { on = false; head.classList.remove('scrolled'); document.documentElement.classList.remove('scrolled'); }
    if (!REDUCED) document.documentElement.style.setProperty('--glow-a', (y * 0.22 % 360).toFixed(1) + 'deg');
    if (bar) {
      const was = bar.classList.contains('stuck');
      const now = getComputedStyle(bar).position === 'sticky' && bar.getBoundingClientRect().top <= head.offsetHeight + 1 && y > 80;
      if (now !== was) { bar.classList.toggle('stuck', now); if (now && !REDUCED) { bar.classList.add('flash'); clearTimeout(check.f); check.f = setTimeout(() => bar.classList.remove('flash'), 650); } }
    }
  };
  /* 吸顶时，「全部 / 直客 / IB」那一行藏到导航后面，只露出筛选框和结果数 */
  const setTop = () => { const a = bar && bar.querySelector('.audience-bar'); if (a) bar.style.setProperty('--fc-top', (a.offsetHeight + 14) + 'px'); };
  addEventListener('resize', setTop); setTop();
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } }, { passive: true });
  check();
})();
/* 弹窗关闭时也有动画（Esc、关闭按钮、点背景） */
function animClose(d) {
  if (REDUCED || !d.open || d.classList.contains('closing')) { if (d.open && REDUCED) d.close(); return; }
  d.classList.add('closing');
  const done = () => { clearTimeout(t); d.removeEventListener('animationend', onEnd); d.classList.remove('closing'); d.close(); };
  const onEnd = e => { if (e.target === d) done(); };
  const t = setTimeout(done, 450);
  d.addEventListener('animationend', onEnd);
}
for (const id of ['recordDrawer', 'comparisonDialog', 'researchDialog']) {
  const d = $(id);
  d.addEventListener('cancel', e => { e.preventDefault(); animClose(d); });
  d.addEventListener('click', e => { if (e.target === d) { e.stopImmediatePropagation(); animClose(d); } }, true);
}
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => animClose($(b.dataset.close)));

/* ---------- 滚过筛选卡片后，导航下方滑出的精简筛选条 ---------- */
var miniClosed = false;
function updateMini(n) {
  $('miniCount').innerHTML = `<b>${n}</b> 条匹配`; $('miniReopenCount').textContent = n;
  const ms = $('miniSearch'); if (document.activeElement !== ms) ms.value = $('searchInput').value;
  const chips = [];
  const opt = id => { const el = $(id); return el.value && el.selectedOptions[0] ? el.selectedOptions[0].textContent : ''; };
  if ($('brokerFilter').value) chips.push(['brokerFilter', opt('brokerFilter')]);
  if (selectedRegion !== 'all') chips.push(['region', selectedRegion]);
  if ($('typeFilter').value) chips.push(['typeFilter', opt('typeFilter')]);
  if ($('statusFilter').value !== 'current') chips.push(['statusFilter', opt('statusFilter').replace(/[（(].*$/, '')]);
  $('miniChips').innerHTML = chips.map(([k, l]) => `<button type="button" class="mf-chip" data-clear="${k}" aria-label="取消筛选：${esc(l)}">${esc(l)}<i aria-hidden="true">×</i></button>`).join('');
}
$('miniSearch').addEventListener('input', e => { $('searchInput').value = e.target.value; visibleCount = 9; render(); });
$('miniSearch').addEventListener('blur', () => dispatchEvent(new Event('scroll')));
$('miniChips').addEventListener('click', e => {
  const b = e.target.closest('[data-clear]'); if (!b) return;
  const k = b.dataset.clear;
  if (k === 'region') { setRegion('all', false); return; }
  $(k).value = k === 'statusFilter' ? 'current' : ''; visibleCount = 9; render();
});
$('miniMore').addEventListener('click', () => document.querySelector('.filter-card').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }));
(() => {
  const mini = $('miniFilter'), card = document.querySelector('.filter-card'), head = document.querySelector('header');
  let shown = false, ticking = false;
  /* 收起后只留右上角一颗「筛选」小按钮；收起状态在本浏览器记住 */
  try { miniClosed = localStorage.getItem('miniFilterClosed') === '1'; } catch (e) {}
  const setClosed = v => { miniClosed = v; try { localStorage.setItem('miniFilterClosed', v ? '1' : '0'); } catch (e) {} check(); };
  $('miniClose').addEventListener('click', () => setClosed(true));
  $('miniReopen').addEventListener('click', () => setClosed(false));
  const check = () => {
    ticking = false;
    // 正在小搜索框里打字时不收起（结果变少、页面变短也不打断输入）
    const vis = card.offsetParent !== null && (card.getBoundingClientRect().bottom < head.offsetHeight || (shown && mini.contains(document.activeElement) && document.activeElement.id === 'miniSearch'));
    mini.style.top = head.getBoundingClientRect().bottom + 'px';
    const want = vis && !miniClosed;
    if (want !== shown) { shown = want; mini.classList.toggle('show', want); mini.inert = !want; }
    $('miniReopen').hidden = !(vis && miniClosed);
    $('miniReopen').style.top = (head.getBoundingClientRect().bottom + 10) + 'px';
    if (!REDUCED) mini.style.setProperty('--sweep', ((scrollY * 0.06) % 130 - 30).toFixed(1) + '%');
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } }, { passive: true });
  addEventListener('hashchange', () => setTimeout(check, 50));
  check();
})();

/* 鼠标聚光（只在有鼠标的设备上） */
if (!REDUCED && matchMedia('(hover: hover) and (pointer: fine)').matches) {
  document.querySelectorAll('.glass-card').forEach(c => {
    let raf = 0, ev = null;
    c.addEventListener('pointermove', e => {
      ev = e; if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; const r = c.getBoundingClientRect(); c.style.setProperty('--mx', (ev.clientX - r.left) + 'px'); c.style.setProperty('--my', (ev.clientY - r.top) + 'px'); });
    });
    c.addEventListener('pointerenter', () => c.classList.add('spot-on'));
    c.addEventListener('pointerleave', () => c.classList.remove('spot-on'));
  });
}

/* 毛玻璃后面的两团柔光随滚动轻微漂移 */
if (!REDUCED) {
  let tk = false;
  const drift = () => {
    tk = false;
    document.querySelectorAll('.glass-stage').forEach(st => {
      const r = st.getBoundingClientRect(); if (r.bottom < -200 || r.top > innerHeight + 200) return;
      const p = (innerHeight / 2 - (r.top + r.height / 2)) / innerHeight; // -1…1
      st.querySelector('.o1').style.setProperty('--ox', (p * 120).toFixed(1) + 'px');
      st.querySelector('.o1').style.setProperty('--oy', (p * -30).toFixed(1) + 'px');
      st.querySelector('.o2').style.setProperty('--ox', (p * -140).toFixed(1) + 'px');
      st.querySelector('.o2').style.setProperty('--oy', (p * 24).toFixed(1) + 'px');
    });
  };
  addEventListener('scroll', () => { if (!tk) { tk = true; requestAnimationFrame(drift); } }, { passive: true });
  addEventListener('hashchange', () => setTimeout(drift, 60)); drift();
}
