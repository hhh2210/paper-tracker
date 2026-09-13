# 📄 PaperTracker · 论文每日阅读打卡 & 自动聚合

> 专为**视觉型 & ADHD 研究者**打造的 Chrome / Chromium 浏览器扩展。  
> 告别“手动记笔记”的认知阻力，自动静默追踪你在 **arXiv** 和 **alphaXiv** 上的阅读轨迹与专注时长，用即时视觉正反馈与打卡连击助你无痛积累论文阅读习惯。

---

## ✨ 核心特性

- ⚡ **零摩擦静默追踪（Zero-Friction Passive Tracking）**
  - 无需每次阅读后手动添加或在网页上繁琐打标。
  - 打开 `arxiv.org`（含 `/abs/`、`/html/`、`/pdf/`）或 `alphaxiv.org` 即刻自动识别论文 ID、标题与作者。
  - 支持直接打开纯 PDF 文件的后台元数据自动补全与计时。
- 🧠 **ADHD 专属视觉正反馈机制（Dopamine Loop）**
  - **每日阅读目标环（Progress Ring）**：动态渲染今日已读篇数与目标百分比。
  - **连续打卡火焰（Streak 🔥）**：记录连续阅读天数与历史最佳连击，给坚持以即时奖赏。
  - **阅读深度自动分级徽章**：
    - `⚡ 扫读 (<2m)`：快速过一眼摘要
    - `📖 细读 (2-10m)`：读了核心结构与图表
    - `🧠 精读 (>10m)`：深入推导与全文通读
  - **达成目标彩带粒子（Confetti Celebration）**：完成每日目标时触发微型庆祝动画。
- ⏱️ **页面悬浮微型 HUD（In-Page Floating Pill）**
  - 在 arXiv / alphaXiv 页面右下角静默显示优雅的深色毛玻璃计时药丸。
  - 自动检测活跃状态（窗口失焦或 2 分钟无键盘/鼠标/滚动操作自动暂停，杜绝“后台开着 50 个 Tab 虚假计时”）。
  - 支持一键折叠为微型按钮。
- 📋 **每日聚合与一键导出（Daily Digest）**
  - Popup 中一键复制今日已读论文清单为精美 Markdown，无缝粘贴至 Obsidian、飞书文档、Notion 或日报。
- 📊 **全屏数据看板（30-Day Heatmap & Repository）**
  - 类似 GitHub 提交图谱的 **30 天阅读热力图**。
  - 累积阅读篇数、总阅读时长、历史最佳打卡统计。
  - 历史论文模糊搜索与按来源筛选（arXiv vs alphaXiv）。
  - 支持全量导出 Markdown 与本地 JSON 备份。

---

## 🚀 快速安装（10 秒上手）

该插件基于 **Chrome Extension Manifest V3** 标准开发，原生纯原生 JavaScript，零打包零构建，支持 Chrome、Edge、Brave 及 Dia 等所有 Chromium 内核浏览器：

1. 打开浏览器，在地址栏输入：
   - **Chrome / Dia / Brave**: `chrome://extensions`
   - **Edge**: `edge://extensions`
2. 打开右上角的 **「开发者模式」（Developer mode）** 开关。
3. 点击左上角的 **「加载已解压的扩展程序」（Load unpacked）**。
4. 在弹出的文件选择器中，选择本目录：
   ```text
   /Users/larry_1/Opensource/paper-tracker
   ```
5. 安装完成！将 `PaperTracker` 图标固定到浏览器工具栏即可。

---

## 🛠️ 项目结构

```text
paper-tracker/
├── manifest.json       # Chrome MV3 配置文件
├── background.js       # 后台服务（时长累加、Streak 逻辑、PDF 识别与元数据解析）
├── content.js          # 页面内容脚本（DOM 提取、活跃与空闲检测、心跳通信）
├── content.css         # 页面右下角浮动 HUD 药丸样式（深色毛玻璃）
├── popup.html          # 工具栏弹出面板（进度环、火焰连击、今日已读卡片）
├── popup.css           # 弹出面板样式
├── popup.js            # 弹出面板交互与彩带动画
├── dashboard.html      # 全屏数据大屏（30 天热力图、全量表格与检索）
├── dashboard.css       # 全屏大屏样式
├── dashboard.js        # 看板数据加载、搜索与 JSON/Markdown 导出
└── icons/              # 16x16, 32x32, 48x48, 128x128 炫彩暗黑发光图标
```

---

## 💡 使用场景示例

1. **日常刷 arXiv / alphaXiv**：正常浏览感兴趣的论文页面，右下角药丸会温和提示你当前阅读时长。
2. **晚上复盘**：点击右上角插件图标，弹窗立即展示你今天读了哪几篇论文、读了多久、达成几篇目标。
3. **周报 / 笔记沉淀**：点击 `复制今日`，直接获得排版优美的 Markdown 论文清单。
