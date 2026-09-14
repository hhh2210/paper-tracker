/**
 * PaperTracker - Content Script (MV3 Robustness, Double-Count Prevention, SPA Routing)
 * Extracts paper metadata, tracks active dwell time with idle detection,
 * and renders a sleek floating HUD pill on arXiv and alphaXiv.
 */

(function () {
  'use strict';

  if (window.__paperTrackerInjected) return;
  window.__paperTrackerInjected = true;

  // Extract arXiv ID from URL
  function extractArxivId(url) {
    if (!url) return null;
    const match = url.match(/(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf|html|overview)\/([a-zA-Z\-]+(?:\.[a-zA-Z]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (match && match[1]) {
      return match[1].replace(/v\d+$/, '');
    }
    return null;
  }

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

  let currentPaperId = null;
  let currentSource = 'arxiv';
  let paperMeta = null;
  let sessionSeconds = 0;
  let uncommittedSeconds = 0;
  let isActive = true;
  let lastActiveTimestamp = Date.now();
  let idleThresholdMs = 120 * 1000; // default 2 minutes

  let serverStats = {
    todayPaperCount: 0,
    qualifyingCount: 0,
    dailyGoal: 3,
    currentStreak: 0,
    paperTodaySeconds: 0,
    goalMet: false
  };

  let widgetContainer = null;
  let isCollapsed = false;
  let tickerTimer = null;

  // Extract Paper Metadata from DOM or Document Title
  function extractMetadata(paperId, source) {
    let title = '';
    let authors = '';

    if (source === 'arxiv') {
      const titleEl = document.querySelector('h1.title');
      if (titleEl) {
        title = titleEl.textContent.replace(/^Title:\s*/i, '').trim();
      }
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

    if (!title || title.length < 3) {
      let dt = document.title || '';
      dt = dt.replace(/^\[[^\]]+\]\s*/, '')
             .replace(/\s*\|\s*arXiv.*$/i, '')
             .replace(/\s*\|\s*alphaXiv.*$/i, '')
             .replace(/\s*alphaXiv.*$/i, '')
             .trim();
      if (dt && !dt.includes('arXiv.org') && dt !== 'alphaXiv') {
        title = dt;
      }
    }

    return {
      paperId,
      source,
      title: title || `arXiv:${paperId}`,
      authors: authors || '',
      url: window.location.href
    };
  }

  // Google Page Lifecycle State Machine
  // Active: focused + pointer inside (threshold: idleThresholdMs, default 120s)
  // Passive: blurred or pointer outside (threshold: PASSIVE_IDLE_THRESHOLD_MS, 30s)
  // Idle: timeout exceeded in either state
  const PASSIVE_IDLE_THRESHOLD_MS = 30 * 1000;
  let lifecycleState = 'active'; // 'active' | 'passive' | 'idle' | 'hidden'
  let isPointerInside = true;

  // Create or retrieve floating Dynamic Capsule HUD
  function ensureFloatingWidget() {
    if (document.getElementById('paper-tracker-hud')) {
      widgetContainer = document.getElementById('paper-tracker-hud');
      widgetContainer.style.display = 'block';
      return;
    }

    widgetContainer = document.createElement('div');
    widgetContainer.id = 'paper-tracker-hud';
    widgetContainer.className = 'pt-hud-container';

    widgetContainer.innerHTML = `
      <div class="pt-capsule" id="pt-capsule">
        <div class="pt-cap-status" id="pt-cap-status" title="Google Page Lifecycle 状态">
          <span class="pt-status-dot pt-status-active" id="pt-status-dot"></span>
          <span class="pt-status-label" id="pt-status-label">深度阅读</span>
        </div>
        <div class="pt-cap-divider"></div>
        <div class="pt-cap-timer" id="pt-live-timer">00:00</div>
        <div class="pt-cap-divider"></div>
        <div class="pt-cap-depth pt-depth-skim" id="pt-depth-tag">⚡ 扫读</div>
        <div class="pt-cap-divider"></div>
        <div class="pt-cap-goal" id="pt-cap-goal" title="今日阅读目标进度">
          <span class="pt-cap-flame">🔥</span>
          <span class="pt-cap-goal-text" id="pt-goal-fraction">0/3</span>
        </div>
        <button class="pt-cap-toggle-btn" id="pt-toggle-btn" title="收起 / 展开">−</button>
      </div>
    `;

    document.body.appendChild(widgetContainer);

    const toggleBtn = document.getElementById('pt-toggle-btn');
    const capsule = document.getElementById('pt-capsule');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        capsule.classList.add('pt-minimized');
        toggleBtn.textContent = '+';
        toggleBtn.title = '展开';
      } else {
        capsule.classList.remove('pt-minimized');
        toggleBtn.textContent = '−';
        toggleBtn.title = '收起';
      }
    });

    capsule.addEventListener('click', () => {
      if (isCollapsed) {
        isCollapsed = false;
        capsule.classList.remove('pt-minimized');
        toggleBtn.textContent = '−';
        toggleBtn.title = '收起';
      }
    });
  }

  function evaluateLifecycleState() {
    if (document.visibilityState !== 'visible') {
      return 'hidden';
    }
    const now = Date.now();
    const elapsed = now - lastActiveTimestamp;
    const isDocFocused = document.hasFocus();

    if (isDocFocused && isPointerInside) {
      if (elapsed > idleThresholdMs) {
        return 'idle';
      }
      return 'active';
    } else {
      if (elapsed > PASSIVE_IDLE_THRESHOLD_MS) {
        return 'idle';
      }
      return 'passive';
    }
  }

  function updateLifecycleUI() {
    const dot = document.getElementById('pt-status-dot');
    const label = document.getElementById('pt-status-label');
    const capsule = document.getElementById('pt-capsule');
    if (!dot || !label) return;

    dot.className = 'pt-status-dot';

    if (lifecycleState === 'active') {
      dot.classList.add('pt-status-active');
      label.textContent = '深度阅读';
      label.title = '当前聚焦在论文中 (容差 120 秒)';
      if (capsule) {
        capsule.classList.remove('pt-state-idle', 'pt-state-passive');
      }
    } else if (lifecycleState === 'passive') {
      dot.classList.add('pt-status-passive');
      label.textContent = '伴读中';
      label.title = '分屏做笔记或查词中 (容差 30 秒)';
      if (capsule) {
        capsule.classList.remove('pt-state-idle');
        capsule.classList.add('pt-state-passive');
      }
    } else {
      dot.classList.add('pt-status-idle');
      label.textContent = '已暂离';
      label.title = '长时间无操作已暂停计时，移动鼠标或按键恢复';
      if (capsule) {
        capsule.classList.remove('pt-state-passive');
        capsule.classList.add('pt-state-idle');
      }
    }
  }

  function updateWidgetUI() {
    const timerEl = document.getElementById('pt-live-timer');
    const depthEl = document.getElementById('pt-depth-tag');
    const goalFractionEl = document.getElementById('pt-goal-fraction');

    if (!timerEl || !paperMeta) return;

    const totalPaperSeconds = (serverStats.paperTodaySeconds || 0) + uncommittedSeconds;
    timerEl.textContent = formatDuration(totalPaperSeconds);

    if (totalPaperSeconds < 120) {
      depthEl.textContent = '⚡ 扫读';
      depthEl.className = 'pt-cap-depth pt-depth-skim';
    } else if (totalPaperSeconds < 600) {
      depthEl.textContent = '📖 细读';
      depthEl.className = 'pt-cap-depth pt-depth-read';
    } else {
      depthEl.textContent = '🧠 精读';
      depthEl.className = 'pt-cap-depth pt-depth-deep';
    }

    const count = serverStats.qualifyingCount || (totalPaperSeconds >= 30 ? 1 : 0);
    const goal = serverStats.dailyGoal || 3;
    if (goalFractionEl) {
      goalFractionEl.textContent = `${count}/${goal}`;
      if (serverStats.goalMet) {
        goalFractionEl.parentElement.classList.add('pt-goal-achieved');
      }
    }
  }

  function isContextValid() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  }

  function teardownOrphanedScript() {
    if (tickerTimer) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
    if (widgetContainer) {
      widgetContainer.remove();
      widgetContainer = null;
    }
  }

  // Send heartbeat / sync to background (synchronous deduction prevents double counting)
  function syncWithBackground(deltaSec) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    if (!paperMeta || !paperMeta.paperId) return;
    const safeDelta = Math.max(0, Math.round(Number(deltaSec) || 0));
    if (safeDelta === 0 && deltaSec !== 0) return;

    // Deduct immediately to prevent double counting if visibilitychange and pagehide fire consecutively
    uncommittedSeconds = Math.max(0, uncommittedSeconds - safeDelta);

    try {
      chrome.runtime.sendMessage(
        {
          type: 'PAPER_HEARTBEAT',
          payload: {
            paperId: paperMeta.paperId,
            source: paperMeta.source,
            title: paperMeta.title,
            authors: paperMeta.authors,
            url: paperMeta.url,
            deltaSeconds: safeDelta
          }
        },
        (res) => {
          if (!isContextValid()) {
            teardownOrphanedScript();
            return;
          }
          if (chrome.runtime.lastError || !res || !res.success) {
            // Restore uncommittedSeconds if message was not received
            uncommittedSeconds += safeDelta;
            return;
          }
          serverStats = res;
          updateWidgetUI();
        }
      );
    } catch (err) {
      if (!isContextValid()) {
        teardownOrphanedScript();
      } else {
        uncommittedSeconds += safeDelta;
      }
    }
  }

  // Initialize tracking for current paper or blog
  function initPaper(paperId, customMeta = null) {
    currentPaperId = paperId;
    if (customMeta && customMeta.source) {
      currentSource = customMeta.source;
    } else {
      currentSource = window.location.hostname.includes('alphaxiv.org')
        ? 'alphaxiv'
        : (paperId.startsWith('blog:') ? 'blog' : 'arxiv');
    }

    if (customMeta) {
      paperMeta = {
        paperId,
        source: currentSource,
        title: customMeta.title || document.title,
        authors: customMeta.authors || '',
        url: customMeta.url || window.location.href
      };
    } else {
      paperMeta = extractMetadata(currentPaperId, currentSource);
    }

    sessionSeconds = 0;
    uncommittedSeconds = 0;
    lastActiveTimestamp = Date.now();
    isActive = true;

    // Check user preference for widget and idle setting
    chrome.storage.local.get(['settings'], (res) => {
      if (chrome.runtime.lastError) return;
      const settings = res?.settings || {};
      if (settings.idleTimeoutSeconds) {
        idleThresholdMs = settings.idleTimeoutSeconds * 1000;
      }
      if (settings.showFloatingWidget !== false) {
        ensureFloatingWidget();
        updateWidgetUI();
      }
    });

    // Immediate initial sync (1s) so background/popup instantly have the record
    syncWithBackground(1);

    // If title is missing or default, resolve asynchronously via background
    if (currentSource === 'arxiv' && (!paperMeta.title || paperMeta.title === `arXiv:${paperId}`)) {
      try {
        chrome.runtime.sendMessage({ type: 'RESOLVE_METADATA', arxivId: paperId }, (res) => {
          if (chrome.runtime.lastError || !res) return;
          if (res.title) {
            paperMeta.title = res.title;
            if (res.authors) {
              paperMeta.authors = Array.isArray(res.authors) ? res.authors.join(', ') : res.authors;
            }
            updateWidgetUI();
            syncWithBackground(0); // Update metadata in background
          }
        });
      } catch (e) {
        // ignore
      }
    }

    startSmoothTicker();
  }

  // Smooth 1-second ticker driven by Google Page Lifecycle state machine
  function startSmoothTicker() {
    if (tickerTimer) clearInterval(tickerTimer);

    let syncCounter = 0;
    tickerTimer = setInterval(() => {
      lifecycleState = evaluateLifecycleState();
      updateLifecycleUI();

      if (lifecycleState === 'idle' || document.visibilityState !== 'visible') {
        return;
      }

      sessionSeconds += 1;
      uncommittedSeconds += 1;
      syncCounter += 1;

      updateWidgetUI();

      // Sync to storage every 5 seconds
      if (syncCounter >= 5) {
        syncCounter = 0;
        syncWithBackground(uncommittedSeconds);
      }
    }, 1000);
  }

  // User Activity Listeners (Throttled to 500ms to eliminate event loop overhead on scroll/mousemove)
  let lastActivityThrottle = 0;
  function onUserActivity() {
    const now = Date.now();
    if (now - lastActivityThrottle < 500) return;
    lastActivityThrottle = now;
    lastActiveTimestamp = now;
    isPointerInside = true;

    const prev = lifecycleState;
    lifecycleState = evaluateLifecycleState();
    if (prev !== lifecycleState) {
      updateLifecycleUI();
    }
  }

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, onUserActivity, { passive: true });
  });

  // Pointer presence (Google Page Lifecycle standard)
  document.addEventListener('mouseenter', () => {
    isPointerInside = true;
    lastActiveTimestamp = Date.now();
    lifecycleState = evaluateLifecycleState();
    updateLifecycleUI();
  });

  document.addEventListener('mouseleave', () => {
    isPointerInside = false;
    lifecycleState = evaluateLifecycleState();
    updateLifecycleUI();
  });

  // Window Focus / Blur (Google Page Lifecycle: Active vs Passive)
  window.addEventListener('focus', () => {
    lastActiveTimestamp = Date.now();
    isPointerInside = true;
    lifecycleState = evaluateLifecycleState();
    updateLifecycleUI();
  });

  window.addEventListener('blur', () => {
    lifecycleState = evaluateLifecycleState();
    updateLifecycleUI();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      lifecycleState = 'hidden';
      updateLifecycleUI();
      if (uncommittedSeconds > 0) {
        syncWithBackground(uncommittedSeconds);
      }
    } else {
      lastActiveTimestamp = Date.now();
      isPointerInside = true;
      lifecycleState = evaluateLifecycleState();
      updateLifecycleUI();
      checkRoute();
    }
  });

  window.addEventListener('pagehide', () => {
    if (uncommittedSeconds > 0) {
      syncWithBackground(uncommittedSeconds);
    }
  });

  // ============================================================================
  // Academic Blog / Project Page Detection Engine
  // Tier 1: DOM / Metadata probe (arXiv link or BibTeX -> 0 tokens, 0ms)
  // Tier 2: Chrome Built-in AI (Gemini Nano on device -> 0 tokens, on-device)
  // Tier 3: Zhipu GLM API fallback (via background service worker)
  // ============================================================================

  function extractBlogTitle() {
    const selectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'h1.paper-title',
      'h1.post-title',
      'h1.entry-title',
      'article h1',
      'main h1',
      'h1'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = (el.getAttribute('content') || el.textContent || '').trim();
        if (val.length > 3 && val.length < 200) return val;
      }
    }
    return (document.title || '').replace(/\s*[-–|].*$/, '').trim() || document.title;
  }

  function extractBlogAuthors() {
    const metaAuthor = document.querySelector('meta[name="author"], meta[property="article:author"]');
    if (metaAuthor && metaAuthor.getAttribute('content')) {
      return metaAuthor.getAttribute('content').trim();
    }
    const authorEl = document.querySelector('.author, .authors, .byline, .post-author, .meta-author');
    if (authorEl && authorEl.textContent.trim().length > 1) {
      return authorEl.textContent.trim().replace(/^by\s+/i, '');
    }
    return '';
  }

  function probeArxivFromDom() {
    // 1. Meta tags (Google Scholar / Highwire Press / Dublin Core)
    const metaArxiv = document.querySelector('meta[name="citation_arxiv_id"], meta[name="arxiv_id"]');
    if (metaArxiv?.getAttribute('content')) {
      const match = metaArxiv.getAttribute('content').trim().match(/(\d{4}\.\d{4,5})/);
      if (match) return match[1];
    }

    // 2. Links to arXiv in hero/banner/buttons or project header CTA
    const prominentLinks = document.querySelectorAll(
      'header a[href*="arxiv.org"], .hero a[href*="arxiv.org"], .paper-header a[href*="arxiv.org"], .buttons a[href*="arxiv.org"], .paper-link a[href*="arxiv.org"], a.paper-link[href*="arxiv.org"], a.btn[href*="arxiv.org"]'
    );
    for (const link of prominentLinks) {
      const href = link.getAttribute('href') || link.href || '';
      const match = href.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
      if (match && match[1]) {
        return match[1].replace(/v\d+$/, '');
      }
    }

    // 3. Dedicated BibTeX block (Search ONLY pre and dedicated bibtex containers, NOT inline code)
    const blocks = document.querySelectorAll('pre, .bibtex, [class*="bibtex"], [id*="bibtex"]');
    for (const block of blocks) {
      const text = block.textContent || '';
      if (text.length > 20 && text.includes('@') && (text.includes('arxiv') || text.includes('eprint'))) {
        const match = text.match(/(?:eprint|arxivId)\s*=\s*\{?([0-9]{4}\.[0-9]{4,5})/i) ||
                      text.match(/arXiv:\s*([0-9]{4}\.[0-9]{4,5})/i);
        if (match && match[1]) {
          return match[1];
        }
      }
    }

    return null;
  }

  // Efficient TreeWalker snippet extraction without full-DOM deep cloning
  function getPageSnippetForAnalysis() {
    const root = document.querySelector('article, main, .content, .post-content, #content') || document.body;
    if (!root) return '';

    try {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (/^(SCRIPT|STYLE|NOSCRIPT|NAV|FOOTER|HEADER|SVG|BUTTON|CANVAS)$/i.test(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let accumulated = '';
      while (walker.nextNode() && accumulated.length < 2500) {
        const text = walker.currentNode.nodeValue.replace(/\s+/g, ' ');
        if (text.trim()) {
          accumulated += text + ' ';
        }
      }

      return accumulated.trim().slice(0, 2500);
    } catch (e) {
      return (root.innerText || '').slice(0, 2500);
    }
  }

  // Extract balanced JSON from LLM response
  function extractJsonObject(str) {
    if (!str || typeof str !== 'string') return null;
    const codeBlockMatch = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try { return JSON.parse(codeBlockMatch[1].trim()); } catch (e) {}
    }
    try { return JSON.parse(str.trim()); } catch (e) {}

    const startIdx = str.indexOf('{');
    if (startIdx === -1) return null;
    let depth = 0, inString = false, escape = false;
    for (let i = startIdx; i < str.length; i++) {
      const char = str[i];
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(str.slice(startIdx, i + 1)); } catch (err) { return null; }
          }
        }
      }
    }
    return null;
  }

  // Tier 2: Chrome Built-in AI (Gemini Nano on device) with strict resource destruction
  async function tryGeminiNano(snippet, pageTitle, url) {
    const aiObj = window.ai || (typeof ai !== 'undefined' ? ai : null);
    if (!aiObj) return null;
    const modelFactory = aiObj.languageModel || aiObj.assistant;
    if (!modelFactory) return null;

    let session = null;
    let timerId = null;
    const timeoutMs = 8000;

    try {
      let available = 'no';
      if (typeof modelFactory.availability === 'function') {
        available = await modelFactory.availability();
      } else if (typeof modelFactory.capabilities === 'function') {
        const cap = await modelFactory.capabilities();
        available = cap?.available || 'no';
      }

      if (available !== 'readily' && available !== 'yes') {
        return null;
      }

      const sessionPromise = modelFactory.create({
        systemPrompt: 'You are an academic researcher assistant. Determine if the webpage content is an academic research paper, research project page, or technical AI/CS/science research blog. Respond ONLY with valid JSON: {"is_research": boolean, "title": string, "authors": string, "arxiv_id": string or null}'
      });

      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error('Gemini Nano prompt timeout')), timeoutMs);
      });

      session = await Promise.race([sessionPromise, timeoutPromise]);
      const prompt = `Title: ${pageTitle}\nURL: ${url}\nSnippet:\n${snippet}`;
      const rawRes = await Promise.race([session.prompt(prompt), timeoutPromise]);

      const parsed = extractJsonObject(rawRes);
      if (parsed && typeof parsed.is_research === 'boolean') {
        return parsed;
      }
      return null;
    } catch (err) {
      console.warn('[PaperTracker] Gemini Nano detection error:', err.message);
      return null;
    } finally {
      if (timerId) clearTimeout(timerId);
      if (session && typeof session.destroy === 'function') {
        try {
          session.destroy();
        } catch (e) {}
      }
    }
  }

  // Tier 3: GLM Cloud API Fallback via background service worker
  async function tryGLMFallback(snippet, pageTitle, url) {
    if (!isContextValid()) return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'ANALYZE_WITH_GLM',
            payload: {
              pageSnippet: snippet,
              pageTitle: pageTitle,
              url: url
            }
          },
          (res) => {
            if (!isContextValid()) return resolve(null);
            if (chrome.runtime.lastError) {
              console.warn('[PaperTracker] GLM runtime message error:', chrome.runtime.lastError.message);
              return resolve(null);
            }
            if (!res || !res.success) {
              if (res?.reason === 'NO_API_KEY') {
                console.info('[PaperTracker] Note: GLM API Key not configured. Skipping cloud blog classification.');
              } else if (res?.error) {
                console.warn('[PaperTracker] GLM classification error:', res.error);
              }
              return resolve(null);
            }
            resolve(res);
          }
        );
      } catch (err) {
        resolve(null);
      }
    });
  }

  // In-memory cache fallback for private browsing or storage quota issues
  const memoryBlogCache = new Map();
  function getCachedBlogResult(key) {
    if (memoryBlogCache.has(key)) return memoryBlogCache.get(key);
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        memoryBlogCache.set(key, parsed);
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function setCachedBlogResult(key, data) {
    memoryBlogCache.set(key, data);
    try {
      sessionStorage.setItem(key, JSON.stringify(data));
    } catch (e) {}
  }

  // Main Tiered Funnel for Academic Blog Detection
  let blogDetectionPending = false;
  async function detectAndInitBlogPage() {
    const hostname = window.location.hostname;
    // Skip arXiv and alphaXiv listings/homepages (they have native routing)
    if (hostname.includes('arxiv.org') || hostname.includes('alphaxiv.org')) {
      return;
    }

    if (blogDetectionPending) return;
    blogDetectionPending = true;

    try {
      const currentUrl = window.location.href;
      const cacheKey = `pt_blog_cache_${location.pathname}`;

      // 0. Check cache
      const cached = getCachedBlogResult(cacheKey);
      if (cached) {
        if (cached.is_research === false) return;
        if (cached.is_research && cached.paperId) {
          initPaper(cached.paperId, cached);
          return;
        }
      }

      // Tier 1: DOM / Metadata probe (0 tokens, 0ms latency)
      const domArxivId = probeArxivFromDom();
      if (domArxivId) {
        const title = extractBlogTitle();
        const authors = extractBlogAuthors();
        const blogData = {
          is_research: true,
          paperId: domArxivId,
          source: 'arxiv',
          title: title || `arXiv:${domArxivId}`,
          authors: authors || '',
          url: currentUrl
        };
        setCachedBlogResult(cacheKey, blogData);
        initPaper(domArxivId, blogData);
        return;
      }

      // Extract text snippet safely
      const pageTitle = extractBlogTitle();
      const snippet = getPageSnippetForAnalysis();
      if (!snippet || snippet.length < 150) {
        return;
      }

      // Tier 2: Chrome Built-in AI (Gemini Nano on device)
      let aiResult = await tryGeminiNano(snippet, pageTitle, currentUrl);

      // Tier 3: GLM Cloud API Fallback
      if (!aiResult) {
        aiResult = await tryGLMFallback(snippet, pageTitle, currentUrl);
      }

      if (aiResult && aiResult.is_research) {
        const boundId = aiResult.arxiv_id || `blog:${location.hostname}${location.pathname.replace(/\/$/, '')}`;
        const boundSource = aiResult.arxiv_id ? 'arxiv' : 'blog';
        const blogData = {
          is_research: true,
          paperId: boundId,
          source: boundSource,
          title: aiResult.title || pageTitle,
          authors: aiResult.authors || extractBlogAuthors(),
          url: currentUrl
        };
        setCachedBlogResult(cacheKey, blogData);
        initPaper(boundId, blogData);
      } else if (aiResult && aiResult.is_research === false) {
        setCachedBlogResult(cacheKey, { is_research: false });
      }
    } finally {
      blogDetectionPending = false;
    }
  }

  // Handle SPA URL Navigation (Next.js / alphaXiv routing, stripping #hash to protect scroll spies)
  function getCanonicalRouteUrl(href) {
    try {
      const u = new URL(href);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch (e) {
      return (href || '').split('#')[0];
    }
  }

  let lastRecordedUrl = getCanonicalRouteUrl(window.location.href);

  function checkRoute() {
    if (document.visibilityState !== 'visible') return;
    const nowCanonical = getCanonicalRouteUrl(window.location.href);
    if (nowCanonical !== lastRecordedUrl) {
      lastRecordedUrl = nowCanonical;
      const newId = extractArxivId(nowCanonical);
      if (newId && newId !== currentPaperId) {
        if (uncommittedSeconds > 0) {
          syncWithBackground(uncommittedSeconds);
        }
        initPaper(newId);
      } else if (!newId) {
        // Navigated away or on a potential research blog
        if (uncommittedSeconds > 0) {
          syncWithBackground(uncommittedSeconds);
        }
        currentPaperId = null;
        if (widgetContainer) widgetContainer.style.display = 'none';
        if (tickerTimer) clearInterval(tickerTimer);
        detectAndInitBlogPage();
      }
    }
  }

  // Intercept pushState & replaceState
  const origPush = history.pushState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    setTimeout(checkRoute, 50);
  };
  const origReplace = history.replaceState;
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    setTimeout(checkRoute, 50);
  };
  window.addEventListener('popstate', () => setTimeout(checkRoute, 50));
  const routeIntervalTimer = setInterval(checkRoute, 2000);

  // Initial check on load
  const initialId = extractArxivId(window.location.href);
  if (initialId) {
    initPaper(initialId);
  } else {
    detectAndInitBlogPage();
  }

})();
