/**
 * PaperTracker - Background Service Worker (Manifest V3 Standard Compliant)
 * Tracks reading dwell time on arXiv & alphaXiv, maintains streaks, resolves metadata,
 * and handles PDF reading via event-driven timestamp diffing and storage.session.
 */

const DEFAULT_SETTINGS = {
  dailyGoal: 3, // Target papers per day
  minSecondsToCount: 30, // Minimum seconds on a paper to count towards daily total
  showFloatingWidget: true,
  idleTimeoutSeconds: 120, // Pause tracking after 2 minutes of inactivity
  glmApiKey: '',
  glmModel: 'glm-4-flash',
  feishuWebhook: '',
  feishuAppId: 'cli_a926b95fa9f8dbd1',
  feishuAppSecret: '',
  feishuReceiverId: 'ou_162e0eaf2ed84e4421c57d0daf9de348'
};

// Storage Mutex Queue to prevent race conditions during concurrent tab updates
let storageLock = Promise.resolve();
function runWithStorageLock(fn) {
  const next = storageLock.then(fn, fn);
  storageLock = next;
  return next;
}

// Helper: Format date as YYYY-MM-DD in local time
function getTodayDateStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getYesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Storage helpers with explicit lastError checks
async function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[PaperTracker] storage.local.get error:', chrome.runtime.lastError.message);
        return resolve({});
      }
      resolve(res || {});
    });
  });
}

async function setStorageData(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) {
        console.error('[PaperTracker] storage.local.set error:', chrome.runtime.lastError.message);
        return reject(chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

// Initialize default storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await getStorageData(['settings', 'streak', 'papers', 'daily_stats']);
  const updates = {};
  if (!data.settings) updates.settings = DEFAULT_SETTINGS;
  if (!data.streak) {
    updates.streak = {
      currentStreak: 0,
      bestStreak: 0,
      lastActiveDate: null
    };
  }
  if (!data.papers) updates.papers = {};
  if (!data.daily_stats) updates.daily_stats = {};

  if (Object.keys(updates).length > 0) {
    await setStorageData(updates);
  }

  // Create periodic 1-minute alarm as a background fallback wake-up
  chrome.alarms.create('paperTrackerSyncAlarm', { periodInMinutes: 1 });
});

// Extract arXiv ID from URL
function extractArxivId(url) {
  if (!url) return null;
  const match = url.match(/(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf|html|overview)\/([a-zA-Z\-]+(?:\.[a-zA-Z]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (match && match[1]) {
    return match[1].replace(/v\d+$/, '');
  }
  return null;
}

// Determine source domain
function getSourceFromUrl(url) {
  if (!url) return 'arxiv';
  if (url.includes('alphaxiv.org')) return 'alphaxiv';
  return 'arxiv';
}

// Resolve metadata from arXiv abstract page
async function resolvePaperMetadata(arxivId) {
  try {
    // Check local cache first to save network bandwidth and avoid HTML parsing in memory
    const stored = await getStorageData(['papers']);
    if (stored.papers && stored.papers[arxivId] && stored.papers[arxivId].title && !stored.papers[arxivId].title.startsWith('arXiv:')) {
      return {
        title: stored.papers[arxivId].title,
        authors: stored.papers[arxivId].authors || ['arXiv Paper'],
        summary: stored.papers[arxivId].summary || ''
      };
    }

    const res = await fetch(`https://arxiv.org/abs/${arxivId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    let title = '';
    const titleMatch = html.match(/<h1 class="title mathjax"><span class="descriptor">Title:<\/span>(.*?)<\/h1>/s);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim();
    } else {
      const pageTitleMatch = html.match(/<title>\[[^\]]+\]\s*(.*?)<\/title>/);
      if (pageTitleMatch && pageTitleMatch[1]) {
        title = pageTitleMatch[1].trim();
      }
    }

    let authors = [];
    const authorsSection = html.match(/<div class="authors">(.*?)<\/div>/s);
    if (authorsSection && authorsSection[1]) {
      const authorMatches = authorsSection[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g);
      for (const m of authorMatches) {
        authors.push(m[1].trim());
      }
    }

    let summary = '';
    const summaryMatch = html.match(/<blockquote class="abstract mathjax"><span class="descriptor">Abstract:<\/span>(.*?)<\/blockquote>/s);
    if (summaryMatch && summaryMatch[1]) {
      summary = summaryMatch[1].replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim();
    }

    return {
      title: title || `arXiv:${arxivId}`,
      authors: authors.length > 0 ? authors : ['Unknown Authors'],
      summary: summary || ''
    };
  } catch (err) {
    console.warn(`[PaperTracker] Failed to fetch metadata for ${arxivId}:`, err);
    return {
      title: `arXiv:${arxivId}`,
      authors: ['arXiv Paper'],
      summary: ''
    };
  }
}

// Process heartbeat message with concurrency protection
async function handlePaperHeartbeat(payload) {
  return runWithStorageLock(async () => {
    if (!payload || !payload.paperId) {
      throw new Error('Invalid payload: paperId is required');
    }

    const { paperId, source, title, authors, url, deltaSeconds } = payload;
    const safeDelta = Math.max(0, Math.round(Number(deltaSeconds) || 0));
    const today = getTodayDateStr();
    const now = Date.now();

    const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings', 'dismissed_today']);
    const papers = data.papers || {};
    const dailyStats = data.daily_stats || {};
    const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
    const settings = data.settings || DEFAULT_SETTINGS;
    const dismissedToday = data.dismissed_today || {};

    // If paper was dismissed by user today, ignore heartbeat
    if (dismissedToday[today]?.includes(paperId)) {
      return {
        todayPaperCount: (dailyStats[today]?.paperIds || []).length,
        qualifyingCount: 0,
        todaySeconds: dailyStats[today]?.totalSeconds || 0,
        dailyGoal: settings.dailyGoal,
        currentStreak: streak.currentStreak,
        paperTodaySeconds: 0,
        goalMet: false
      };
    }

    // Initialize paper entry if not present
    if (!papers[paperId]) {
      papers[paperId] = {
        id: paperId,
        source: source || 'arxiv',
        title: title || `Paper ${paperId}`,
        authors: authors || 'Unknown Authors',
        url: url,
        firstSeen: now,
        lastSeen: now,
        totalSeconds: 0,
        history: {}
      };
    }

    // Update paper metadata if newly resolved
    if (title && (!papers[paperId].title || papers[paperId].title.startsWith('arXiv:'))) {
      papers[paperId].title = title;
    }
    if (authors && authors !== 'Unknown Authors') {
      papers[paperId].authors = authors;
    }
    if (url) {
      const isExistingCanonical = papers[paperId].url &&
        (papers[paperId].url.includes('arxiv.org') || papers[paperId].url.includes('alphaxiv.org'));
      if (!isExistingCanonical) {
        papers[paperId].url = url;
      }
    }

    papers[paperId].lastSeen = now;
    papers[paperId].totalSeconds = (papers[paperId].totalSeconds || 0) + safeDelta;
    if (!papers[paperId].history) papers[paperId].history = {};
    papers[paperId].history[today] = (papers[paperId].history[today] || 0) + safeDelta;

    // Initialize today's stats
    if (!dailyStats[today]) {
      dailyStats[today] = {
        date: today,
        paperIds: [],
        totalSeconds: 0,
        goal: settings.dailyGoal || 3
      };
    }

    if (!dailyStats[today].paperIds.includes(paperId)) {
      dailyStats[today].paperIds.push(paperId);
    }
    dailyStats[today].totalSeconds = (dailyStats[today].totalSeconds || 0) + safeDelta;

    // Streak calculation
    const qualifyingPapers = dailyStats[today].paperIds.filter(pid => {
      const p = papers[pid];
      return p && (p.history?.[today] || 0) >= (settings.minSecondsToCount || 30);
    });

    const goalMet = qualifyingPapers.length >= settings.dailyGoal;
    const yesterday = getYesterdayDateStr();

    if (qualifyingPapers.length > 0) {
      if (streak.lastActiveDate !== today) {
        if (streak.lastActiveDate === yesterday) {
          streak.currentStreak += 1;
        } else if (!streak.lastActiveDate) {
          streak.currentStreak = 1;
        } else {
          streak.currentStreak = 1;
        }
        streak.lastActiveDate = today;
        if (streak.currentStreak > streak.bestStreak) {
          streak.bestStreak = streak.currentStreak;
        }
      }
    }

    await setStorageData({ papers, daily_stats: dailyStats, streak });

    return {
      todayPaperCount: dailyStats[today].paperIds.length,
      qualifyingCount: qualifyingPapers.length,
      todaySeconds: dailyStats[today].totalSeconds,
      dailyGoal: settings.dailyGoal,
      currentStreak: streak.currentStreak,
      paperTodaySeconds: papers[paperId].history[today],
      goalMet
    };
  });
}

// Message Listener with universal Error Boundary
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ success: false, error: 'Invalid message' });
    return false;
  }

  if (message.type === 'PAPER_HEARTBEAT') {
    handlePaperHeartbeat(message.payload)
      .then((res) => sendResponse({ success: true, ...res }))
      .catch((err) => {
        console.error('[PaperTracker] Heartbeat error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'RESOLVE_METADATA') {
    resolvePaperMetadata(message.arxivId)
      .then((res) => sendResponse({ success: true, ...res }))
      .catch((err) => {
        console.error('[PaperTracker] Resolve metadata error:', err);
        sendResponse({ success: false, title: `arXiv:${message.arxivId}`, error: err.message });
      });
    return true;
  }

  if (message.type === 'GET_TODAY_DATA') {
    (async () => {
      try {
        // Flush active PDF session first so popup gets up-to-the-second time
        await flushActivePdfSession();

        const today = getTodayDateStr();
        const yesterday = getYesterdayDateStr();
        const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings']);
        const stats = data.daily_stats?.[today] || { date: today, paperIds: [], totalSeconds: 0, goal: 3 };
        const settings = data.settings || DEFAULT_SETTINGS;
        const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
        const papers = data.papers || {};

        if (streak.lastActiveDate && streak.lastActiveDate !== today && streak.lastActiveDate !== yesterday) {
          streak.currentStreak = 0;
        }

        const todayPapers = (stats.paperIds || []).map(id => {
          const p = papers[id] || {};
          return {
            ...p,
            todaySeconds: p.history?.[today] || 0
          };
        }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

        const isExtensionPage = !sender.tab && sender.id === chrome.runtime.id;
        const safeSettings = isExtensionPage ? settings : { ...settings };
        if (!isExtensionPage) {
          delete safeSettings.glmApiKey;
          delete safeSettings.feishuAppSecret;
        }

        sendResponse({
          success: true,
          today,
          stats,
          settings: safeSettings,
          streak,
          papers: todayPapers
        });
      } catch (err) {
        console.error('[PaperTracker] GET_TODAY_DATA error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'GET_ALL_DATA') {
    (async () => {
      try {
        await flushActivePdfSession();
        const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings']);
        const today = getTodayDateStr();
        const yesterday = getYesterdayDateStr();
        const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
        if (streak.lastActiveDate && streak.lastActiveDate !== today && streak.lastActiveDate !== yesterday) {
          streak.currentStreak = 0;
        }

        const isExtensionPage = !sender.tab && sender.id === chrome.runtime.id;
        const safeSettings = isExtensionPage ? (data.settings || DEFAULT_SETTINGS) : { ...(data.settings || DEFAULT_SETTINGS) };
        if (!isExtensionPage) {
          delete safeSettings.glmApiKey;
          delete safeSettings.feishuAppSecret;
        }

        sendResponse({ success: true, ...data, settings: safeSettings, streak });
      } catch (err) {
        console.error('[PaperTracker] GET_ALL_DATA error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    (async () => {
      try {
        const data = await getStorageData(['settings']);
        const settings = { ...(data.settings || DEFAULT_SETTINGS), ...message.payload };
        await setStorageData({ settings });
        sendResponse({ success: true, settings });
      } catch (err) {
        console.error('[PaperTracker] UPDATE_SETTINGS error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'DELETE_PAPER_FROM_TODAY') {
    (async () => {
      try {
        const today = getTodayDateStr();
        const paperId = message.payload?.paperId;
        if (!paperId) throw new Error('paperId is required');

        const data = await getStorageData(['papers', 'daily_stats', 'dismissed_today']);
        const papers = data.papers || {};
        const dailyStats = data.daily_stats || {};
        const dismissedToday = data.dismissed_today || {};

        if (!dismissedToday[today]) dismissedToday[today] = [];
        if (!dismissedToday[today].includes(paperId)) {
          dismissedToday[today].push(paperId);
        }

        if (papers[paperId]?.history?.[today]) {
          const deducted = papers[paperId].history[today] || 0;
          if (dailyStats[today]) {
            dailyStats[today].totalSeconds = Math.max(0, (dailyStats[today].totalSeconds || 0) - deducted);
          }
          papers[paperId].totalSeconds = Math.max(0, (papers[paperId].totalSeconds || 0) - deducted);
          delete papers[paperId].history[today];
        }

        if (dailyStats[today]) {
          dailyStats[today].paperIds = dailyStats[today].paperIds.filter(id => id !== paperId);
        }
        await setStorageData({ papers, daily_stats: dailyStats, dismissed_today: dismissedToday });
        sendResponse({ success: true });
      } catch (err) {
        console.error('[PaperTracker] DELETE_PAPER error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'ANALYZE_WITH_GLM') {
    (async () => {
      try {
        const result = await analyzePageWithGlm(message.payload || {});
        sendResponse(result);
      } catch (err) {
        console.error('[PaperTracker] ANALYZE_WITH_GLM handler error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'SEND_TO_FEISHU') {
    (async () => {
      try {
        const result = await sendReadingListToFeishu(message.payload || {});
        sendResponse(result);
      } catch (err) {
        console.error('[PaperTracker] SEND_TO_FEISHU handler error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  return false;
});

// Helper: Extract JSON object from LLM response text with balanced brace scanning (ReDoS immune)
function extractJsonObject(str) {
  if (!str || typeof str !== 'string') return null;

  // 1. Try markdown code block extraction
  const codeBlockMatch = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {}
  }

  // 2. Direct parse attempt
  try {
    return JSON.parse(str.trim());
  } catch (e) {}

  // 3. Balanced brace scanner (handles trailing commentary and nested braces)
  const startIdx = str.indexOf('{');
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const candidate = str.slice(startIdx, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (err) {
            return null;
          }
        }
      }
    }
  }

  return null;
}

// Helper: Build a beautiful Feishu interactive card
function buildFeishuCard({ papers, stats, streak, today }) {
  const count = papers.length;
  const totalMins = Math.round((stats.totalSeconds || 0) / 60);
  const streakDays = streak.currentStreak || (count > 0 ? 1 : 0);

  let elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🔥 **连续打卡 ${streakDays} 天** · 今日阅读 **${count}** 篇 · 专注时长 **${totalMins} 分钟**`
      }
    },
    { tag: 'hr' }
  ];

  papers.forEach((p, idx) => {
    const depthStr = (p.todaySeconds || 0) < 120 ? '⚡ 扫读' : (p.todaySeconds || 0) < 600 ? '📖 细读' : '🧠 精读';
    const durationMins = Math.max(1, Math.round((p.todaySeconds || 0) / 60));
    const paperUrl = p.url || `https://arxiv.org/abs/${p.id}`;
    const sourceBadge = p.source === 'alphaxiv' ? 'alphaXiv' : (p.source === 'blog' ? 'Blog' : 'arXiv');

    let paperText = `**${idx + 1}. [${p.title}](${paperUrl})**\n`;
    paperText += `• 来源: \`${sourceBadge}\` (${p.id}) · 深度: **${depthStr}** (${durationMins} 分钟)`;
    if (p.authors) {
      paperText += `\n• 作者: ${p.authors.slice(0, 80)}${p.authors.length > 80 ? '...' : ''}`;
    }

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: paperText
      }
    });
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `PaperTracker 自动聚合 · 日期: ${today}`
      }
    ]
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `📄 今日论文阅读清单 · ${today}`
      },
      template: count >= (stats.goal || 3) ? 'turquoise' : 'blue'
    },
    elements: elements
  };
}

// Helper: Build a test card for connectivity verification
function buildFeishuTestCard({ today }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `🧪 PaperTracker · 飞书推送联调成功`
      },
      template: 'turquoise'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `🎉 **飞书推送通道连接成功！**\n• 当你在 arXiv 或学术博客阅读论文时，PaperTracker 将自动监督阅读时长。\n• 点击 Popup 顶部的「同步飞书」按钮，即可秒级生成精美的阅读简报推送！`
        }
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `测试时间: ${today} · PaperTracker 自动测试`
          }
        ]
      }
    ]
  };
}

// Send reading digest to Feishu via Local CLI Bridge, Webhook, or Bot API
async function sendReadingListToFeishu(payload = {}) {
  await flushActivePdfSession();
  const today = getTodayDateStr();
  const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings']);
  const stats = data.daily_stats?.[today] || { date: today, paperIds: [], totalSeconds: 0, goal: 3 };
  const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
  const settings = data.settings || DEFAULT_SETTINGS;
  const papersMap = data.papers || {};

  const isTest = Boolean(payload && payload.isTest);

  const todayPapers = (stats.paperIds || []).map(id => {
    const p = papersMap[id] || {};
    return {
      ...p,
      todaySeconds: p.history?.[today] || 0
    };
  }).filter(p => (p.todaySeconds || 0) > 0);

  if (!isTest && todayPapers.length === 0) {
    return { success: false, reason: 'EMPTY_PAPERS', error: '今日暂无已读论文记录可同步' };
  }

  const cardPayload = isTest
    ? buildFeishuTestCard({ today })
    : buildFeishuCard({
        papers: todayPapers,
        stats,
        streak,
        today
      });

  const receiverId = settings.feishuReceiverId?.trim() || 'ou_162e0eaf2ed84e4421c57d0daf9de348';

  // 1. Tier 1 Priority: Try Local Lark CLI Bridge (http://127.0.0.1:18288)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    const bridgeRes = await fetch('http://127.0.0.1:18288/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card: cardPayload,
        receiverId: receiverId
      }),
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeoutId);

    if (bridgeRes && bridgeRes.ok) {
      const json = await bridgeRes.json().catch(() => null);
      if (json && json.ok) {
        return {
          success: true,
          mode: 'local_cli',
          message: isTest ? '🎉 测试卡片已通过本地飞书机器人送达！' : '🎉 已通过本地飞书机器人推送到私聊！'
        };
      }
    }
  } catch (err) {
    console.warn('[PaperTracker] Local bridge skipped:', err);
  }

  // 2. Tier 2: Webhook mode (Group bot or custom webhook)
  if (settings.feishuWebhook && settings.feishuWebhook.trim()) {
    const webhookUrl = settings.feishuWebhook.trim();
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card: cardPayload
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`飞书 Webhook 返回 HTTP ${res.status}: ${errText.slice(0, 100)}`);
    }

    const json = await res.json();
    if (json.code !== 0 && json.StatusCode !== 0) {
      throw new Error(json.msg || json.message || '飞书 Webhook 发送失败');
    }

    return {
      success: true,
      mode: 'webhook',
      message: isTest ? '🎉 测试卡片已推送到飞书群！' : '已成功推送到飞书群！'
    };
  }

  // 3. Tier 3: Bot OpenAPI mode (Direct message with App Secret)
  if (settings.feishuAppId && settings.feishuAppSecret) {
    const appId = settings.feishuAppId.trim();
    const appSecret = settings.feishuAppSecret.trim();

    // Get tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });

    if (!tokenRes.ok) {
      throw new Error(`获取飞书 Bot Token 失败: HTTP ${tokenRes.status}`);
    }

    const tokenJson = await tokenRes.json();
    if (tokenJson.code !== 0) {
      throw new Error(`飞书 Token 错误: ${tokenJson.msg || '未知错误'}`);
    }

    const token = tokenJson.tenant_access_token;
    const isChat = receiverId.startsWith('oc_');
    const idType = isChat ? 'chat_id' : 'open_id';

    // Send interactive card
    const sendRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${idType}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: receiverId,
        msg_type: 'interactive',
        content: JSON.stringify(cardPayload)
      })
    });

    if (!sendRes.ok) {
      throw new Error(`飞书消息发送失败: HTTP ${sendRes.status}`);
    }

    const sendJson = await sendRes.json();
    if (sendJson.code !== 0) {
      throw new Error(`飞书消息错误: ${sendJson.msg || '未知错误'}`);
    }

    return {
      success: true,
      mode: 'bot',
      message: isTest ? '🎉 测试卡片已发送到飞书私聊！' : '已成功发送到飞书私聊！'
    };
  }

  return {
    success: false,
    reason: 'NOT_CONFIGURED',
    error: '未检测到可用推送通道：可启动本地 CLI 桥接 (scripts/lark_bridge.py) 或在设置中配置飞书 Webhook / App Secret。'
  };
}

// Analyze research blog page using Zhipu GLM API
async function analyzePageWithGlm({ pageSnippet, url, pageTitle }) {
  const data = await getStorageData(['settings']);
  const apiKey = data.settings?.glmApiKey?.trim();
  const model = data.settings?.glmModel?.trim() || 'glm-4-flash';

  if (!apiKey) {
    return {
      success: false,
      reason: 'NO_API_KEY',
      error: 'GLM API Key 未配置。请在插件设置中填入 API Key，或启用端侧 Gemini Nano。'
    };
  }

  const promptText = `请分析以下网页文本，判断是否属于学术论文、学术研究项目主页（Project Page）、或高质量深度技术/科学研究博客（如 OpenAI Research、Anthropic Research、Distill、BAIR、Hugging Face Research、个人学者研究博客等）。
如果是，提取其论文/文章标题、作者列表，以及如果页面正文或参考文献中存在对应的 arXiv ID，提取该 ID。

页面标题: ${pageTitle || ''}
URL: ${url || ''}
页面正文片段:
${pageSnippet ? pageSnippet.slice(0, 3000) : ''}

请严格仅输出以下 JSON 格式，禁止包含 Markdown 代码块标记（如 \`\`\`json）：
{
  "is_research": true,
  "title": "论文或博文真实标题",
  "authors": "作者名字（逗号分隔）",
  "arxiv_id": "提取到的 arXiv ID 如 2608.24949，没有则填 null",
  "summary": "一句话核心内容（20字以内）"
}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'user', content: promptText }
        ],
        temperature: 0.1,
        max_tokens: 350
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`GLM API HTTP ${res.status}: ${errText.slice(0, 100)}`);
    }

    const json = await res.json();
    const rawContent = json.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(rawContent);

    if (!parsed) {
      throw new Error('无法解析 GLM 返回的 JSON 内容');
    }

    return {
      success: true,
      is_research: Boolean(parsed.is_research),
      title: parsed.title || pageTitle || 'Academic Blog',
      authors: parsed.authors || 'Research Team',
      arxiv_id: parsed.arxiv_id || null,
      summary: parsed.summary || ''
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[PaperTracker] GLM API analysis error:', err);
    return {
      success: false,
      error: err.name === 'AbortError' ? 'GLM API 请求超时 (15s)' : err.message
    };
  }
}

// ============================================================================
// PDF Tracking Engine (MV3 Standard: Timestamp Diffing via storage.session)
// Content scripts do not run on Chrome's native PDFium viewer.
// This engine uses session storage and browser events, immune to worker teardowns.
// ============================================================================

async function getActivePdfSession() {
  try {
    const res = await chrome.storage.session.get('active_pdf_session');
    return res?.active_pdf_session || null;
  } catch (e) {
    return null;
  }
}

async function setActivePdfSession(session) {
  try {
    if (session) {
      await chrome.storage.session.set({ active_pdf_session: session });
    } else {
      await chrome.storage.session.remove('active_pdf_session');
    }
  } catch (e) {
    // ignore
  }
}

async function flushActivePdfSession() {
  const session = await getActivePdfSession();
  if (!session) return;

  const now = Date.now();
  const deltaSeconds = Math.floor((now - (session.lastCommittedTime || session.startTime || now)) / 1000);

  if (deltaSeconds >= 1) {
    try {
      await handlePaperHeartbeat({
        paperId: session.paperId,
        source: session.source,
        title: session.title,
        authors: session.authors,
        url: session.url,
        deltaSeconds: deltaSeconds
      });
      session.lastCommittedTime = now;
      await setActivePdfSession(session);
    } catch (e) {
      console.error('[PaperTracker] flushActivePdfSession error:', e);
    }
  }
}

async function stopActivePdfTracking() {
  await flushActivePdfSession();
  await setActivePdfSession(null);
}

async function checkActiveTabForPdf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) {
      await stopActivePdfTracking();
      return;
    }

    const arxivId = extractArxivId(tab.url);
    const isPdf = tab.url.includes('/pdf/');

    if (arxivId && isPdf) {
      const currentSession = await getActivePdfSession();
      if (currentSession && currentSession.tabId === tabId && currentSession.paperId === arxivId) {
        await flushActivePdfSession();
        return;
      }

      await stopActivePdfTracking();

      const source = getSourceFromUrl(tab.url);
      const meta = await resolvePaperMetadata(arxivId);
      const now = Date.now();

      const newSession = {
        tabId,
        paperId: arxivId,
        source,
        url: tab.url,
        title: meta.title,
        authors: Array.isArray(meta.authors) ? meta.authors.join(', ') : meta.authors,
        startTime: now,
        lastCommittedTime: now
      };

      await setActivePdfSession(newSession);
      await handlePaperHeartbeat({ ...newSession, deltaSeconds: 1 });
    } else {
      await stopActivePdfTracking();
    }
  } catch (err) {
    await stopActivePdfTracking();
  }
}

// Tab Events
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await flushActivePdfSession();
  await checkActiveTabForPdf(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(tabs) && tabs.length > 0 && tabs[0].id === tabId) {
        await checkActiveTabForPdf(tabId);
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getActivePdfSession();
  if (session && session.tabId === tabId) {
    await stopActivePdfTracking();
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopActivePdfTracking();
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(tabs) && tabs.length > 0) {
        await checkActiveTabForPdf(tabs[0].id);
      }
    });
  }
});

// Idle State Change Listener (system idle/lock support)
chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === 'idle' || newState === 'locked') {
    await stopActivePdfTracking();
  } else if (newState === 'active') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(tabs) && tabs.length > 0) {
        await checkActiveTabForPdf(tabs[0].id);
      }
    });
  }
});

// Alarms listener: wake up every 1 minute to flush active session if reading continuously
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'paperTrackerSyncAlarm') {
    await flushActivePdfSession();
  }
});
