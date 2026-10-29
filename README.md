# 竞品促销雷达

同行促销活动与 IB 方案的在线看板，每天自动复查来源页、发现新活动。

上线与更新方法见 [GUIDE.md](GUIDE.md)。

- `index.html` 网页
- `config.js` 设置（Google 表格链接、我方品牌名）
- `data/records.csv` 活动数据
- `data/watchlist.csv` 机器人盯的活动列表页
- `data/monitor.json` 机器人每日结果（自动生成）
- `monitor/` 机器人程序；`.github/workflows/monitor.yml` 每日定时
