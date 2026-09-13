/**
 * PaperTracker - Background Service Worker (Manifest V3 Standard Compliant)
 * Tracks reading dwell time on arXiv & alphaXiv, maintains streaks, resolves metadata,
 * and handles PDF reading via event-driven timestamp diffing and storage.session.
 */

const DEFAULT_SETTINGS = {
  dailyGoal: 3, // Target papers per day
  minSecondsToCount: 30, // Minimum seconds on a paper to count towards daily total
  showFloatingWidget: true,
  idleTimeoutSeconds: 120 // Pause tracking after 2 minutes of inactivity
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
    if (url) papers[paperId].url = url;

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

        sendResponse({
          success: true,
          today,
          stats,
          settings,
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
        sendResponse({ success: true, ...data, streak });
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

  sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  return false;
});

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
