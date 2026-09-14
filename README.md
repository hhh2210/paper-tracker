# 📄 PaperTracker · 论文每日阅读打卡 & 飞书自动聚合

> **专为视觉型 & ADHD 研究者打造的 Chrome / Chromium 浏览器扩展。**  
> 告别“手动记笔记”的认知阻力与遗忘负担，静默追踪你在 **arXiv**、**alphaXiv** 以及**前沿学术研究博客**上的阅读轨迹与专注时长。融合 **Google Chrome Built-in AI (端侧 Gemini Nano)** 本地智能理解与 **飞书互动卡片一键同步**，用即时视觉正反馈与打卡连击助你无痛积累深度阅读习惯。

---

## ✨ 核心特性

### 1. ⚡ 零摩擦静默追踪（Zero-Friction Passive Tracking）
- **无感记录**：无需每次阅读后手动打标或复制粘贴。
- **全平台支持**：
  - `arxiv.org`（包含 `/abs/` 摘要页、`/html/` 网页版、`/pdf/` 纯 PDF 阅读流自动元数据补全）；
  - `alphaxiv.org` 社区讨论版；
  - **前沿研究博客与项目主页**（OpenAI Index、Anthropic Research、HuggingFace Blog、Distill、BAIR、MIT/Stanford 实验室主页及个人学术主页）。
- **防虚假计时机制**：页面失焦、切 Tab 或 2 分钟无键盘/鼠标/滚动操作自动进入休眠，杜绝“后台挂着 50 个 Tab 伪造专注”的虚假多巴胺。

---

### 2. 🤖 Google Chrome Built-in AI 端侧博客识别 (Gemini Nano)
针对科研博客排版千差万别、缺少标准元数据标签的问题，PaperTracker 打造了**分级智能判定漏斗**：
- **Tier 1 · 毫秒级 DOM 探针（0 延迟 / 0 Token）**：智能嗅探页面内的 BibTeX 结构化引用、arXiv 跳转锚点，毫秒级提取论文 ID 与标题。
- **Tier 2 · Chrome 原生端侧 Gemini Nano 本地大模型（隐私第一 / 离线运行）**：
  - 调用 Chrome 131+ 原生内置的 Prompt API (`window.ai.languageModel`)。
  - 在用户本地 GPU / NPU 硬件加速下运行端侧小模型，自动识别当前网页是否为学术论文/技术博客，智能提炼 Title、Authors 与关联论文 ID。
  - **100% 本地运行**：网页正文不出本地设备，完全保护私有浏览与阅读隐私。
- **Tier 3 · 智谱 GLM API 云端兜底**：
  - 若浏览器未开启端侧 Nano 或需更长上下文理解，可无缝走 Background Service Worker 接入 GLM 兜底，敏感 API Key 强隔离于网页沙盒之外。

---

### 3. 📮 飞书 / Lark 一键打卡与结构化卡片推送
- **Popup 顶部直达按钮 `[同步飞书]`**：
  - **防手抖与重复点击锁（Anti-Double-Click Lock）**：请求处理期间自动禁用，杜绝重复调用。
  - **即时触感与视觉反馈**：
    - 同步中：淡蓝呼吸加载动效与 SVG 旋转器；
    - 今日暂无记录：轻微触感抖动（`pt-btn-shake`）与琥珀色高亮提示；
    - 成功送达：翡翠绿 `✓ 已同步飞书` 角标，伴随多巴胺彩带粒子（Confetti Celebration）；
    - 缺少配置：自动展开偏好设置并平滑定位。
- **飞书互动卡片（Interactive Card）**：
  - **头部统计**：连续打卡天数（🔥）、今日阅读篇数、累计专注时长（分钟）；
  - **论文清单流**：按阅读顺序排版，包含标题超链接、来源平台（arXiv / alphaXiv / Blog）、精准阅读时长、作者以及专属**阅读深度徽章**：
    - `⚡ 扫读 (<2m)`：快速通览标题与摘要
    - `📖 细读 (2-10m)`：精看方法论、网络架构与实验图表
    - `🧠 精读 (>10m)`：深入推导与全文通读
- **多通道自适应分发**：
  1. **本地 CLI 极速桥接（推荐，免 Secret）**：内置轻量环回桥接服务 (`127.0.0.1:18288`)，直通本机已认证的 `lark-cli`，可直推个人私聊或已加入的飞书群聊。支持注册为 macOS `LaunchAgent` 开机静默常驻。
  2. **飞书群 Webhook 模式**：粘贴群自定义机器人的 Webhook 地址，0 鉴权门槛，团队或监督群开箱即用。
  3. **自建 Bot OpenAPI 模式**：在插件内填入 App ID 与 Secret，纯浏览器沙盒直通飞书官方 OpenAPI。
  4. **抽屉内置「🧪 测试推送」**：即使今日尚未开始读论文，也可在设置抽屉一秒自测飞书连通性。

---

### 4. 🧠 ADHD 专属视觉正反馈系统（Dopamine Loop）
- **每日阅读目标环（Progress Ring）**：动态渲染今日已读篇数与目标进度百分比。
- **连续打卡火焰（Streak 🔥）**：记录连续专注天数与历史最佳连击，给坚持以即时奖赏。
- **目标达成烟花（Confetti Celebration）**：完成每日目标或同步成功时触发微型粒子烟花。
- **页面右下角灵动胶囊（Floating HUD）**：在论文页面右下角显示优雅微型毛玻璃计时药丸，专注状态一目了然，支持一键最小化。

---

### 5. 📊 全屏数据看板（30-Day Heatmap & Repository）
- **30 天阅读热力图**：类 GitHub Commit 图谱的深色沉浸式阅读活跃度看板。
- **全量论文资料库**：支持模糊搜索标题/作者/ID，并按来源（arXiv / alphaXiv / Blog）实时筛选。
- **多格式导出与备份**：一键导出全量已读论文 Markdown（即贴即用至 Obsidian / Notion），或导出本地 JSON 全量备份。

---

## 🚀 快速安装与配置

该插件严格遵循 **Chrome Extension Manifest V3** 规范，采用原生 ES2022 JavaScript 编写，零打包、零 Node 依赖构建，支持 Chrome、Edge、Brave 及 Dia 等所有现代 Chromium 内核浏览器。

### 1. 载入插件（10 秒上手）
1. 打开浏览器扩展管理页面：
   - **Chrome / Dia / Brave**: `chrome://extensions`
   - **Edge**: `edge://extensions`
2. 打开右上角的 **「开发者模式」（Developer mode）** 开关。
3. 点击左上角的 **「加载已解压的扩展程序」（Load unpacked）**。
4. 选择本项目所在目录：
   ```text
   /Users/larry_1/Opensource/paper-tracker
   ```
5. 将 `PaperTracker` 图标固定在浏览器工具栏。

### 2. 飞书联动配置（二选一）

#### 选项 A：使用本地已有的 lark-cli 机器人（最省事，推荐 ⭐）
1. 本地已随附轻量桥接服务脚本 [scripts/lark_bridge.py](file:///Users/larry_1/Opensource/paper-tracker/scripts/lark_bridge.py)。
2. 项目已自动注册 macOS LaunchAgent 守护进程：
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.larry.papertracker.larkbridge.plist
   ```
3. 打开插件 Popup 设置抽屉，右上角会亮起 `🟢 CLI 就绪`；在「接收目标 ID」填入你的个人 Open ID（`ou_xxx`）或群会话 ID（`oc_xxx`，机器人需在群内），点击「🧪 测试推送」即可完成连通！

#### 选项 B：使用飞书群自定义 Webhook
1. 在飞书群聊中点击 `···` -> **设置** -> **群机器人** -> **添加机器人** -> **自定义机器人 (Webhook)**；
2. 复制生成的 Webhook URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/...`）；
3. 粘贴到插件设置的「飞书群 Webhook 地址」并保存即可。

---

## 🛠️ 项目工程结构

```text
paper-tracker/
├── manifest.json       # Chrome MV3 规范清单（严格最小权限、host_permissions）
├── background.js       # 后台 Service Worker（时长累加、PDF 解析、飞书卡片构建与三级分发）
├── content.js          # 页面内容注入（活跃检测、DOM 探针、Gemini Nano 本地分析、HUD 药丸）
├── content.css         # 页面浮动药丸 HUD 样式（Linear/Vercel 深色微磨砂风格）
├── popup.html          # 工具栏弹出面板（目标环、打卡流、偏好设置抽屉、飞书配置）
├── popup.css           # 弹出面板样式表（深色科技感、抖动与旋转动效、状态机色彩体系）
├── popup.js            # 弹出面板交互（数据渲染、防抖、飞书同步、彩带动画粒子系统）
├── dashboard.html      # 全屏数据看板（30 天热力图、全量论文库与多维过滤检索）
├── dashboard.css       # 看板样式表
├── dashboard.js        # 看板数据驱动、Markdown/JSON 导出与 XSS 安全防御
├── scripts/
│   └── lark_bridge.py  # 极轻量 Python 本地环回桥接服务（127.0.0.1:18288 -> lark-cli）
└── icons/              # 16px、32px、48px、128px 精致发光图标
```

---

## 🔒 安全与隐私承诺

1. **零数据外泄**：
   - 阅读时长、阅读历史完全保存在本地浏览器 `chrome.storage.local` 中，无外部中心服务器收集你的阅读习惯。
2. **端侧 AI 优先**：
   - 博客内容摘要与学术判定优先在端侧 Gemini Nano 本地模型内完成，网页原文不出本地设备。
3. **敏感凭据沙盒隔离**：
   - GLM API Key 与飞书 App Secret 严格驻留在 Background Service Worker 内存和受保护存储中，普通网页注入的 Content Script 无法探测或读取凭据。
4. **防御 Stored XSS**：
   - 对外源解析到的论文标题、作者信息均经过全面的 HTML 实体安全转义，杜绝 DOM 注入漏洞。

---

## 💡 典型工作流

1. **白天沉浸阅读**：在 arXiv 读新模型论文，或在 OpenAI/HuggingFace 博客学习最新算法，右下角药丸静默记录专注时长。
2. **随手打卡复盘**：点击浏览器右上角图标，瞬间看到今日已读篇数、耗时与火焰连击。
3. **一键同步打卡**：点击「**同步飞书**」，精美的图文卡片瞬间发到你的课题组群聊或个人日志中，告别手动写每日学术汇报的繁琐。
