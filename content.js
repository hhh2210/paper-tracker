/**
 * PaperTracker - Content Script
 * Extracts paper metadata, tracks active dwell time with idle detection,
 * and renders a sleek floating HUD pill on arXiv and alphaXiv.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__paperTrackerInjected) return;
  window.__paperTrackerInjected = true;

  // Extract arXiv ID from current URL
  function extractArxivId(url) {
    const match = url.match(/(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf|html|overview)\/([a-zA-Z\-]+(?:\.[a-zA-Z]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (match && match[1]) {
      return match[1].replace(/v\d+$/, '');
    }
    return null;
  }

  const currentUrl = window.location.href;
  const paperId = extractArxivId(currentUrl);

  // If not on an individual paper page, exit quietly
  if (!paperId) {
    return;
  }

  const source = window.location.hostname.includes('alphaxiv.org') ? 'alphaxiv' : 'arxiv';

  // Extract Paper Metadata
  function extractMetadata() {
    let title = '';
    let authors = '';

    if (source === 'arxiv') {
      // arXiv abs page
      const titleEl = document.querySelector('h1.title');
      if (titleEl) {
        // Strip the descriptor "Title:"
        title = titleEl.textContent.replace(/^Title:\s*/i, '').trim();
      }

      // arXiv html page
      if (!title) {
        const htmlTitle = document.querySelector('h1.ltx_title, .title.ltx_title');
        if (htmlTitle) title = htmlTitle.textContent.trim();
      }

      const authorEls = document.querySelectorAll('.authors a, .ltx_authors a, .author');
      if (authorEls.length > 0) {
        authors = Array.from(authorEls).map(el => el.textContent.trim()).join(', ');
      }
    } else {
      // alphaXiv
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim().length > 3) {
        title = h1.textContent.trim();
      }
    }

    // Fallback: document.title clean up
    if (!title || title.length < 3) {
      let dt = document.title || '';
      // arXiv document.title usually looks like "[2403.12345] Title Here"
      dt = dt.replace(/^\[[^\]]+\]\s*/, '').replace(/\s*\|\s*arXiv.*$/, '').replace(/\s*\|\s*alphaXiv.*$/, '').trim();
      if (dt && !dt.includes('arXiv.org') && !dt.includes('alphaXiv')) {
        title = dt;
      }
    }

    return {
      paperId,
      source,
      title: title || `arXiv:${paperId}`,
      authors: authors || '',
      url: currentUrl
    };
  }

  let paperMeta = extractMetadata();

  // If title is missing or default, request background to resolve asynchronously
  if (!paperMeta.title || paperMeta.title === `arXiv:${paperId}`) {
    chrome.runtime.sendMessage({ type: 'RESOLVE_METADATA', arxivId: paperId }, (res) => {
      if (res && res.title) {
        paperMeta.title = res.title;
        if (res.authors) {
          paperMeta.authors = Array.isArray(res.authors) ? res.authors.join(', ') : res.authors;
        }
        updateWidgetUI();
      }
    });
  }

  // Active Time & Idle Detection
  let isActive = true;
  let lastActiveTimestamp = Date.now();
  const IDLE_THRESHOLD_MS = 120 * 1000; // 2 minutes without user interaction
  let sessionSeconds = 0;
  let serverStats = {
    todayPaperCount: 0,
    dailyGoal: 3,
    currentStreak: 0,
    paperTodaySeconds: 0,
    goalMet: false
  };

  function onUserActivity() {
    lastActiveTimestamp = Date.now();
    if (!isActive && document.visibilityState === 'visible') {
      isActive = true;
      updateWidgetStatus(true);
    }
  }

  // Listen for user interactions to reset idle timer
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, onUserActivity, { passive: true });
  });

  // Handle visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      isActive = false;
      updateWidgetStatus(false);
    } else {
      lastActiveTimestamp = Date.now();
      isActive = true;
      updateWidgetStatus(true);
    }
  });

  // Format seconds as MM:SS or HH:MM:SS
  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return `${h}h ${rm}m`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // In-page Floating HUD Widget
  let widgetContainer = null;
  let isCollapsed = false;

  function createFloatingWidget() {
    if (document.getElementById('paper-tracker-hud')) return;

    widgetContainer = document.createElement('div');
    widgetContainer.id = 'paper-tracker-hud';
    widgetContainer.className = 'pt-hud-container';

    widgetContainer.innerHTML = `
      <div class="pt-hud-card" id="pt-hud-card">
        <div class="pt-hud-header">
          <div class="pt-hud-indicator">
            <span class="pt-pulse-dot" id="pt-status-dot"></span>
            <span class="pt-brand">PaperTracker</span>
          </div>
          <div class="pt-hud-controls">
            <button class="pt-btn-icon" id="pt-toggle-btn" title="收起 / 展开">−</button>
          </div>
        </div>

        <div class="pt-hud-body" id="pt-hud-body">
          <div class="pt-hud-timer-row">
            <div class="pt-timer-display">
              <span class="pt-icon">⏱️</span>
              <span class="pt-timer-val" id="pt-live-timer">00:00</span>
            </div>
            <div class="pt-depth-badge" id="pt-depth-tag">刚开始</div>
          </div>

          <div class="pt-progress-row">
            <div class="pt-progress-text">
              <span id="pt-goal-status">今日进度 0/3 篇</span>
              <span class="pt-streak-text" id="pt-streak-tag">🔥 0 天</span>
            </div>
            <div class="pt-progress-bar-bg">
              <div class="pt-progress-bar-fill" id="pt-progress-bar" style="width: 0%;"></div>
            </div>
          </div>

          <div class="pt-paper-info" id="pt-paper-title-text" title="${paperMeta.title}">
            ${paperMeta.title}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(widgetContainer);

    // Bind event listeners for widget
    const toggleBtn = document.getElementById('pt-toggle-btn');
    const hudCard = document.getElementById('pt-hud-card');
    const hudBody = document.getElementById('pt-hud-body');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        hudCard.classList.add('pt-collapsed');
        hudBody.style.display = 'none';
        toggleBtn.textContent = '+';
        toggleBtn.title = '展开';
      } else {
        hudCard.classList.remove('pt-collapsed');
        hudBody.style.display = 'block';
        toggleBtn.textContent = '−';
        toggleBtn.title = '收起';
      }
    });

    // Clicking header opens popup or un-collapses
    hudCard.addEventListener('click', () => {
      if (isCollapsed) {
        isCollapsed = false;
        hudCard.classList.remove('pt-collapsed');
        hudBody.style.display = 'block';
        toggleBtn.textContent = '−';
      }
    });
  }

  function updateWidgetStatus(active) {
    const dot = document.getElementById('pt-status-dot');
    if (!dot) return;
    if (active) {
      dot.className = 'pt-pulse-dot pt-active';
      dot.title = '正在专注计时中';
    } else {
      dot.className = 'pt-pulse-dot pt-idle';
      dot.title = '已暂停（未聚焦或无操作）';
    }
  }

  function updateWidgetUI() {
    const timerEl = document.getElementById('pt-live-timer');
    const depthEl = document.getElementById('pt-depth-tag');
    const goalEl = document.getElementById('pt-goal-status');
    const streakEl = document.getElementById('pt-streak-tag');
    const barEl = document.getElementById('pt-progress-bar');
    const titleEl = document.getElementById('pt-paper-title-text');

    if (!timerEl) return;

    const totalPaperSeconds = (serverStats.paperTodaySeconds || 0) + sessionSeconds;
    timerEl.textContent = formatDuration(totalPaperSeconds);

    // Reading Depth Classification
    if (totalPaperSeconds < 120) {
      depthEl.textContent = '⚡ 扫读';
      depthEl.className = 'pt-depth-badge pt-depth-skim';
    } else if (totalPaperSeconds < 600) {
      depthEl.textContent = '📖 细读';
      depthEl.className = 'pt-depth-badge pt-depth-read';
    } else {
      depthEl.textContent = '🧠 精读';
      depthEl.className = 'pt-depth-badge pt-depth-deep';
    }

    if (titleEl) {
      titleEl.textContent = paperMeta.title;
      titleEl.title = paperMeta.title;
    }

    const count = serverStats.qualifyingCount || 0;
    const goal = serverStats.dailyGoal || 3;
    const pct = Math.min(100, Math.round((count / goal) * 100));

    if (goalEl) {
      goalEl.textContent = serverStats.goalMet ? `🎉 目标已达成 (${count}/${goal})` : `今日进度 ${count}/${goal} 篇`;
    }
    if (barEl) {
      barEl.style.width = `${pct}%`;
      if (serverStats.goalMet) {
        barEl.classList.add('pt-goal-completed');
      }
    }
    if (streakEl) {
      streakEl.textContent = `🔥 ${serverStats.currentStreak || 0} 天`;
    }
  }

  // Load user settings to check if HUD is enabled
  chrome.storage.local.get(['settings'], (res) => {
    const settings = res.settings || {};
    if (settings.showFloatingWidget !== false) {
      createFloatingWidget();
    }
  });

  // Heartbeat interval (runs every 5 seconds)
  const HEARTBEAT_INTERVAL_SEC = 5;
  setInterval(() => {
    // Check if idle
    if (Date.now() - lastActiveTimestamp > IDLE_THRESHOLD_MS) {
      isActive = false;
      updateWidgetStatus(false);
    }

    if (!isActive || document.visibilityState !== 'visible') {
      return;
    }

    sessionSeconds += HEARTBEAT_INTERVAL_SEC;

    // Send heartbeat to background service worker
    chrome.runtime.sendMessage(
      {
        type: 'PAPER_HEARTBEAT',
        payload: {
          paperId: paperMeta.paperId,
          source: paperMeta.source,
          title: paperMeta.title,
          authors: paperMeta.authors,
          url: paperMeta.url,
          deltaSeconds: HEARTBEAT_INTERVAL_SEC
        }
      },
      (res) => {
        if (chrome.runtime.lastError) {
          // Extension might be reloading
          return;
        }
        if (res) {
          serverStats = res;
          updateWidgetUI();
        }
      }
    );

    updateWidgetUI();
  }, HEARTBEAT_INTERVAL_SEC * 1000);

})();
