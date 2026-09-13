/**
 * PaperTracker - Background Service Worker (Manifest V3)
 * Tracks reading dwell time on arXiv & alphaXiv, maintains streaks, and resolves metadata.
 */

const DEFAULT_SETTINGS = {
  dailyGoal: 3, // Target papers per day
  minSecondsToCount: 30, // Minimum seconds on a paper to count towards daily total
  showFloatingWidget: true,
  idleTimeoutSeconds: 120 // Pause tracking after 2 minutes of inactivity
};

// In-memory cache for resolved paper metadata
const metadataCache = new Map();

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

// Storage helpers
async function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => resolve(res || {}));
  });
}

async function setStorageData(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
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
});

// Extract arXiv ID from URL
function extractArxivId(url) {
  if (!url) return null;
  // Match 2403.12345 or 2403.12345v2 or cs/0102003
  const match = url.match(/(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf|html|overview)\/([a-zA-Z\-]+(?:\.[a-zA-Z]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (match && match[1]) {
    // Strip version like v1, v2 if preferred, or keep canonical base
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
  if (metadataCache.has(arxivId)) {
    return metadataCache.get(arxivId);
  }

  try {
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

    const metadata = {
      title: title || `arXiv:${arxivId}`,
      authors: authors.length > 0 ? authors : ['Unknown Authors'],
      summary: summary || ''
    };

    metadataCache.set(arxivId, metadata);
    return metadata;
  } catch (err) {
    console.warn(`[PaperTracker] Failed to fetch metadata for ${arxivId}:`, err);
    return {
      title: `arXiv:${arxivId}`,
      authors: ['arXiv Paper'],
      summary: ''
    };
  }
}

// Process heartbeat message from content script or internal timer
async function handlePaperHeartbeat(payload) {
  const { paperId, source, title, authors, url, deltaSeconds } = payload;
  const today = getTodayDateStr();
  const now = Date.now();

  const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings', 'dismissed_today']);
  const papers = data.papers || {};
  const dailyStats = data.daily_stats || {};
  const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
  const settings = data.settings || DEFAULT_SETTINGS;
  const dismissedToday = data.dismissed_today || {};

  // If paper was explicitly deleted by user today, skip tracking for today
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
  if (url) papers[paperId].url = url;

  papers[paperId].lastSeen = now;
  papers[paperId].totalSeconds = (papers[paperId].totalSeconds || 0) + deltaSeconds;
  if (!papers[paperId].history) papers[paperId].history = {};
  papers[paperId].history[today] = (papers[paperId].history[today] || 0) + deltaSeconds;

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
  dailyStats[today].totalSeconds = (dailyStats[today].totalSeconds || 0) + deltaSeconds;

  // Streak calculation
  // A day counts towards streak if total qualifying papers >= dailyGoal or >= 1 paper read for minSecondsToCount
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
        // Streak was broken
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
}

// Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PAPER_HEARTBEAT') {
    handlePaperHeartbeat(message.payload).then(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (message.type === 'RESOLVE_METADATA') {
    resolvePaperMetadata(message.arxivId).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_TODAY_DATA') {
    (async () => {
      const today = getTodayDateStr();
      const yesterday = getYesterdayDateStr();
      const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings']);
      const stats = data.daily_stats?.[today] || { date: today, paperIds: [], totalSeconds: 0, goal: 3 };
      const settings = data.settings || DEFAULT_SETTINGS;
      const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
      const papers = data.papers || {};

      // Reset streak if gap > 1 day
      if (streak.lastActiveDate && streak.lastActiveDate !== today && streak.lastActiveDate !== yesterday) {
        streak.currentStreak = 0;
      }

      const todayPapers = (stats.paperIds || []).map(id => {
        const p = papers[id] || {};
        return {
          ...p,
          todaySeconds: p.history?.[today] || 0
        };
      }).sort((a, b) => b.lastSeen - a.lastSeen);

      sendResponse({
        today,
        stats,
        settings,
        streak,
        papers: todayPapers
      });
    })();
    return true;
  }

  if (message.type === 'GET_ALL_DATA') {
    (async () => {
      const data = await getStorageData(['papers', 'daily_stats', 'streak', 'settings']);
      const today = getTodayDateStr();
      const yesterday = getYesterdayDateStr();
      const streak = data.streak || { currentStreak: 0, bestStreak: 0, lastActiveDate: null };
      if (streak.lastActiveDate && streak.lastActiveDate !== today && streak.lastActiveDate !== yesterday) {
        streak.currentStreak = 0;
      }
      sendResponse({ ...data, streak });
    })();
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    (async () => {
      const data = await getStorageData(['settings']);
      const settings = { ...(data.settings || DEFAULT_SETTINGS), ...message.payload };
      await setStorageData({ settings });
      sendResponse({ success: true, settings });
    })();
    return true;
  }

  if (message.type === 'DELETE_PAPER_FROM_TODAY') {
    (async () => {
      const today = getTodayDateStr();
      const { paperId } = message.payload;
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
    })();
    return true;
  }
});

// Fallback: Handle direct navigation to pure PDF tabs
// When Chrome opens a raw PDF, content scripts might not execute.
// Background tracks active tab URL and updates time.
let activePdfTab = null;
let pdfTimer = null;

async function checkActiveTabForPdf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return;

    const arxivId = extractArxivId(tab.url);
    const isPdf = tab.url.includes('/pdf/');

    if (arxivId && isPdf) {
      const source = getSourceFromUrl(tab.url);
      activePdfTab = {
        tabId,
        paperId: arxivId,
        source,
        url: tab.url
      };

      // Resolve metadata in background
      const meta = await resolvePaperMetadata(arxivId);
      activePdfTab.title = meta.title;
      activePdfTab.authors = Array.isArray(meta.authors) ? meta.authors.join(', ') : meta.authors;

      startPdfTracker();
    } else {
      stopPdfTracker();
    }
  } catch (err) {
    stopPdfTracker();
  }
}

function startPdfTracker() {
  if (pdfTimer) clearInterval(pdfTimer);
  pdfTimer = setInterval(async () => {
    if (!activePdfTab) {
      stopPdfTracker();
      return;
    }
    // Verify window is focused
    try {
      const window = await chrome.windows.getCurrent();
      if (!window.focused) return;

      await handlePaperHeartbeat({
        paperId: activePdfTab.paperId,
        source: activePdfTab.source,
        title: activePdfTab.title,
        authors: activePdfTab.authors,
        url: activePdfTab.url,
        deltaSeconds: 5
      });
    } catch (e) {
      // ignore
    }
  }, 5000);
}

function stopPdfTracker() {
  if (pdfTimer) {
    clearInterval(pdfTimer);
    pdfTimer = null;
  }
  activePdfTab = null;
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  checkActiveTabForPdf(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id === tabId) {
        checkActiveTabForPdf(tabId);
      }
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    stopPdfTracker();
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        checkActiveTabForPdf(tabs[0].id);
      }
    });
  }
});
