/**
 * PaperTracker - Popup Script
 * Renders daily progress ring, ADHD dopamine feedback, streak, and today's paper stream.
 */

document.addEventListener('DOMContentLoaded', () => {
  let todayData = null;

  // DOM elements
  const goalRing = document.getElementById('goal-ring');
  const ringProgressText = document.getElementById('ring-progress-text');
  const streakCount = document.getElementById('streak-count');
  const todayTotalTime = document.getElementById('today-total-time');
  const heroStatusMessage = document.getElementById('hero-status-message');
  const heroCard = document.getElementById('hero-card');
  const paperStream = document.getElementById('paper-stream');
  const paperListCount = document.getElementById('paper-list-count');
  const btnCopyDigest = document.getElementById('btn-copy-digest');
  const btnOpenDashboard = document.getElementById('btn-open-dashboard');
  const btnSendFeishu = document.getElementById('btn-send-feishu');
  const btnSettings = document.getElementById('btn-settings');
  const settingsDrawer = document.getElementById('settings-drawer');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const toggleHud = document.getElementById('toggle-hud');
  const inputGlmKey = document.getElementById('input-glm-key');
  const inputGlmModel = document.getElementById('input-glm-model');
  const btnSaveAiSettings = document.getElementById('btn-save-ai-settings');
  const nanoStatusBadge = document.getElementById('nano-status-badge');
  const inputFeishuWebhook = document.getElementById('input-feishu-webhook');
  const inputFeishuAppId = document.getElementById('input-feishu-appid');
  const inputFeishuSecret = document.getElementById('input-feishu-appsecret');
  const inputFeishuReceiver = document.getElementById('input-feishu-receiver');
  const btnSaveFeishuSettings = document.getElementById('btn-save-feishu-settings');
  const toast = document.getElementById('pt-toast');
  const toastMsg = document.getElementById('toast-msg');

  // SVG Ring Circumference: 2 * PI * 34 = 213.628
  const CIRCUMFERENCE = 213.63;

  function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(msg) {
    toastMsg.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 2500);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('[PaperTracker] navigator.clipboard failed, using fallback:', err);
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (success) return true;
    } catch (err) {
      console.error('[PaperTracker] copy fallback failed:', err);
    }
    return false;
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remainM = mins % 60;
      return `${hrs} 小时 ${remainM} 分钟`;
    }
    if (mins === 0) {
      return `${secs} 秒`;
    }
    return `${mins} 分钟 ${secs} 秒`;
  }

  function formatShortTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remainM = mins % 60;
      return `${hrs}h ${remainM}m`;
    }
    return `${mins}m ${secs}s`;
  }

  function getDepthBadge(seconds) {
    if (seconds < 120) {
      return `<span class="pt-depth-badge pt-depth-skim">⚡ 扫读</span>`;
    } else if (seconds < 600) {
      return `<span class="pt-depth-badge pt-depth-read">📖 细读</span>`;
    } else {
      return `<span class="pt-depth-badge pt-depth-deep">🧠 精读</span>`;
    }
  }

  function renderData(data) {
    todayData = data;
    const { today, stats, settings, streak, papers } = data;
    const count = papers.length;
    const goal = settings.dailyGoal || 3;
    const totalSecs = stats.totalSeconds || 0;

    // 1. Progress Ring
    ringProgressText.textContent = `${count}/${goal}`;
    const progress = Math.min(1, count / goal);
    const offset = CIRCUMFERENCE * (1 - progress);
    goalRing.style.strokeDashoffset = offset;

    // Ring stroke gradient / color
    if (count >= goal && goal > 0) {
      goalRing.style.stroke = 'url(#ring-gradient-achieved)';
      heroCard.classList.add('pt-goal-achieved');
    } else {
      goalRing.style.stroke = 'url(#ring-gradient)';
      heroCard.classList.remove('pt-goal-achieved');
    }

    // 2. Streaks and Total Time
    streakCount.textContent = `${streak.currentStreak || 0} 天连击`;
    todayTotalTime.textContent = formatTime(totalSecs);
    paperListCount.textContent = count;

    // 3. Hero Message (Dopamine feedback)
    if (count >= goal && goal > 0) {
      heroStatusMessage.innerHTML = `🎉 <strong>太强了！今日目标已达成！</strong>已阅读 ${count} 篇论文，连击已续上！`;
    } else if (count > 0) {
      heroStatusMessage.innerHTML = `还差 <strong>${goal - count} 篇</strong> 达成今日目标，保持专注！`;
    } else {
      heroStatusMessage.textContent = '今天还没有开始看论文，去 arXiv 或 alphaXiv 逛逛，哪怕读 2 分钟也算起步！';
    }

    // 4. Paper Cards
    paperStream.innerHTML = '';
    if (papers.length === 0) {
      paperStream.innerHTML = `
        <div class="pt-empty-state">
          <div class="pt-empty-icon">🪐</div>
          <div class="pt-empty-title">今日暂无阅读记录</div>
          <div class="pt-empty-desc">打开任意 arXiv 或 alphaXiv 论文，插件会自动静默监督与记录时长。</div>
          <div class="pt-quick-links">
            <a href="https://arxiv.org" target="_blank" class="pt-quick-link-btn">前往 arXiv ↗</a>
            <a href="https://alphaxiv.org" target="_blank" class="pt-quick-link-btn">前往 alphaXiv ↗</a>
          </div>
        </div>
      `;
      return;
    }

    papers.forEach(p => {
      const card = document.createElement('div');
      card.className = 'pt-paper-card';
      const sourceClass = p.source === 'alphaxiv' ? 'pt-source-alphaxiv' : (p.source === 'blog' ? 'pt-source-blog' : 'pt-source-arxiv');
      const sourceName = p.source === 'alphaxiv' ? 'alphaXiv' : (p.source === 'blog' ? 'Blog' : 'arXiv');
      const depthBadgeHtml = getDepthBadge(p.todaySeconds || 0);

      const safeId = escapeHtml(p.id);
      const safeTitle = escapeHtml(p.title);
      const safeAuthors = p.authors ? escapeHtml(p.authors) : '';
      const safeUrl = p.url && (p.url.startsWith('https://') || p.url.startsWith('http://'))
        ? encodeURI(p.url)
        : `https://arxiv.org/abs/${encodeURIComponent(p.id)}`;

      card.innerHTML = `
        <div class="pt-card-top">
          <div class="pt-card-meta-left">
            <span class="pt-source-badge ${sourceClass}">${sourceName}</span>
            <a href="${safeUrl}" target="_blank" class="pt-paper-id-link">
              ${safeId}
            </a>
          </div>
          <div class="pt-card-actions">
            <button class="pt-btn-card-action pt-btn-copy-link" data-id="${safeId}" title="复制 Markdown 链接">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <button class="pt-btn-card-action pt-btn-card-delete" data-id="${safeId}" title="从今日移除此记录">✕</button>
          </div>
        </div>

        <a href="${safeUrl}" target="_blank" class="pt-paper-title" title="${safeTitle}">
          ${safeTitle}
        </a>

        ${safeAuthors ? `<div class="pt-paper-authors">${safeAuthors}</div>` : ''}

        <div class="pt-card-footer">
          <div class="pt-reading-stat">
            ${depthBadgeHtml}
            <span class="pt-time-text">${formatShortTime(p.todaySeconds || 0)}</span>
          </div>
        </div>
      `;

      // Copy Markdown Link Button
      card.querySelector('.pt-btn-copy-link').addEventListener('click', async (e) => {
        e.stopPropagation();
        const md = `[${p.title}](${p.url || `https://arxiv.org/abs/${p.id}`})`;
        const ok = await copyToClipboard(md);
        if (ok) {
          showToast(`已复制：${p.title.slice(0, 20)}...`);
        } else {
          showToast('复制失败，请重试');
        }
      });

      // Delete from today Button (instant smooth removal, confirm() is blocked in popups)
      const deleteBtn = card.querySelector('.pt-btn-card-delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        card.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.92)';

        chrome.runtime.sendMessage({
          type: 'DELETE_PAPER_FROM_TODAY',
          payload: { paperId: p.id }
        }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[PaperTracker] delete error:', chrome.runtime.lastError);
          }
          showToast(`已从今日移除：${p.title.slice(0, 18)}...`);
          setTimeout(() => {
            loadTodayData();
          }, 180);
        });
      });

      paperStream.appendChild(card);
    });

    // Check if goal was newly achieved to fire celebration
    if (count >= goal && goal > 0 && !window.__confettiFired) {
      window.__confettiFired = true;
      triggerConfetti();
    }
  }

  function loadTodayData() {
    chrome.runtime.sendMessage({ type: 'GET_TODAY_DATA' }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('[PaperTracker] loadTodayData error:', chrome.runtime.lastError);
        return;
      }
      if (!res) return;
      renderData(res);
      // Sync settings drawer state
      if (res.settings) {
        document.querySelectorAll('.pt-goal-btn').forEach(btn => {
          btn.classList.toggle('active', parseInt(btn.dataset.goal, 10) === res.settings.dailyGoal);
        });
        toggleHud.checked = res.settings.showFloatingWidget !== false;
        if (inputGlmKey && res.settings.glmApiKey !== undefined) {
          inputGlmKey.value = res.settings.glmApiKey;
        }
        if (inputGlmModel && res.settings.glmModel) {
          inputGlmModel.value = res.settings.glmModel;
        }
        if (inputFeishuWebhook && res.settings.feishuWebhook !== undefined) {
          inputFeishuWebhook.value = res.settings.feishuWebhook;
        }
        if (inputFeishuAppId && res.settings.feishuAppId !== undefined) {
          inputFeishuAppId.value = res.settings.feishuAppId;
        }
        if (inputFeishuSecret && res.settings.feishuAppSecret !== undefined) {
          inputFeishuSecret.value = res.settings.feishuAppSecret;
        }
        if (inputFeishuReceiver && res.settings.feishuReceiverId !== undefined) {
          inputFeishuReceiver.value = res.settings.feishuReceiverId;
        }
      }
    });
  }

  // Copy Digest Button (Markdown)
  btnCopyDigest.addEventListener('click', async () => {
    if (!todayData || !todayData.papers || todayData.papers.length === 0) {
      showToast('今日还没有已读论文记录可复制');
      return;
    }

    const { today, stats, streak, papers } = todayData;
    const totalSecs = stats.totalSeconds || 0;
    const totalTimeStr = formatTime(totalSecs);

    let md = `## 📄 今日论文阅读清单 (${today})\n`;
    md += `> 今日共读 **${papers.length}** 篇 · 专注时长 **${totalTimeStr}** · 🔥 连续打卡 **${streak.currentStreak || 1}** 天\n\n`;

    papers.forEach((p, idx) => {
      const depth = p.todaySeconds < 120 ? '⚡ 扫读' : p.todaySeconds < 600 ? '📖 细读' : '🧠 精读';
      const timeStr = formatShortTime(p.todaySeconds || 0);
      md += `${idx + 1}. **[${p.title}](${p.url || `https://arxiv.org/abs/${p.id}`})**\n`;
      md += `   - **来源**: ${p.source} (\`${p.id}\`) · **阅读深度**: ${depth} (${timeStr})\n`;
      if (p.authors) {
        md += `   - **作者**: ${p.authors}\n`;
      }
      md += `\n`;
    });

    const ok = await copyToClipboard(md);
    if (ok) {
      showToast('📋 已复制今日论文 Digest (Markdown)！');
    } else {
      showToast('复制失败，请重试');
    }
  });

  // Open Dashboard Button (reuse existing options tab if open, otherwise create tab)
  btnOpenDashboard.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    }
  });

  // Settings Drawer Toggle
  btnSettings.addEventListener('click', () => {
    const isHidden = settingsDrawer.style.display === 'none';
    settingsDrawer.style.display = isHidden ? 'flex' : 'none';
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsDrawer.style.display = 'none';
  });

  // Goal Selector
  document.querySelectorAll('.pt-goal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newGoal = parseInt(btn.dataset.goal, 10);
      document.querySelectorAll('.pt-goal-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { dailyGoal: newGoal }
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[PaperTracker] updateSettings error:', chrome.runtime.lastError);
        }
        loadTodayData();
      });
    });
  });

  // Toggle HUD
  toggleHud.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: { showFloatingWidget: toggleHud.checked }
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[PaperTracker] updateSettings error:', chrome.runtime.lastError);
      }
    });
  });

  // Save AI Settings (GLM Key & Model)
  if (btnSaveAiSettings) {
    btnSaveAiSettings.addEventListener('click', () => {
      const key = inputGlmKey ? inputGlmKey.value.trim() : '';
      const model = (inputGlmModel && inputGlmModel.value.trim()) || 'glm-4-flash';
      chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { glmApiKey: key, glmModel: model }
      }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          showToast('保存设置失败');
        } else {
          showToast('✓ AI 设置已保存');
        }
      });
    });
  }

  // Save Feishu Settings (Webhook, App ID, App Secret, Receiver)
  if (btnSaveFeishuSettings) {
    btnSaveFeishuSettings.addEventListener('click', () => {
      const webhook = inputFeishuWebhook ? inputFeishuWebhook.value.trim() : '';
      const appId = inputFeishuAppId ? inputFeishuAppId.value.trim() : '';
      const secret = inputFeishuSecret ? inputFeishuSecret.value.trim() : '';
      const receiver = inputFeishuReceiver ? inputFeishuReceiver.value.trim() : '';

      chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: {
          feishuWebhook: webhook,
          feishuAppId: appId,
          feishuAppSecret: secret,
          feishuReceiverId: receiver
        }
      }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          showToast('保存飞书设置失败');
        } else {
          showToast('✓ 飞书设置已保存');
        }
      });
    });
  }

  // Send Today Reading List to Feishu Button
  if (btnSendFeishu) {
    btnSendFeishu.addEventListener('click', () => {
      if (!todayData || !todayData.papers || todayData.papers.length === 0) {
        showToast('今日暂无已读论文记录可同步');
        return;
      }

      const originalHtml = btnSendFeishu.innerHTML;
      btnSendFeishu.disabled = true;
      btnSendFeishu.style.opacity = '0.7';
      btnSendFeishu.innerHTML = `<span>发送中...</span>`;

      chrome.runtime.sendMessage({ type: 'SEND_TO_FEISHU' }, (res) => {
        btnSendFeishu.disabled = false;
        btnSendFeishu.style.opacity = '1';
        btnSendFeishu.innerHTML = originalHtml;

        if (chrome.runtime.lastError) {
          showToast(`发送失败: ${chrome.runtime.lastError.message}`);
          return;
        }

        if (res && res.success) {
          showToast(res.message || '🎉 已成功同步到飞书！');
        } else if (res && res.reason === 'NOT_CONFIGURED') {
          showToast('请先配置飞书 Webhook 或应用凭据');
          if (settingsDrawer) {
            settingsDrawer.style.display = 'flex';
            if (inputFeishuWebhook) inputFeishuWebhook.focus();
          }
        } else {
          showToast(res?.error || '飞书发送失败，请检查配置');
        }
      });
    });
  }

  // Check Chrome Built-in AI (Gemini Nano) availability
  async function checkNanoAvailability() {
    if (!nanoStatusBadge) return;
    try {
      const aiObj = window.ai || (typeof ai !== 'undefined' ? ai : null);
      const modelFactory = aiObj?.languageModel || aiObj?.assistant;
      if (modelFactory) {
        const cap = await modelFactory.capabilities();
        if (cap && (cap.available === 'readily' || cap.available === 'yes')) {
          nanoStatusBadge.textContent = '⚡ Nano 就绪';
          nanoStatusBadge.classList.add('pt-nano-ready');
          return;
        } else if (cap && cap.available === 'after-download') {
          nanoStatusBadge.textContent = '⏳ Nano 待下载';
          return;
        }
      }
    } catch (e) {}
    nanoStatusBadge.textContent = '☁️ 依赖 GLM';
  }

  // Confetti Particle System
  function triggerConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth || 400;
    canvas.height = window.innerHeight || 580;

    const particles = [];
    const colors = ['#6366F1', '#A855F7', '#10B981', '#F59E0B', '#F43F5E', '#38BDF8'];

    for (let i = 0; i < 50; i++) {
      particles.push({
        x: canvas.width / 2,
        y: 120,
        r: Math.random() * 5 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.7) * 9,
        gravity: 0.18,
        alpha: 1,
        decay: Math.random() * 0.015 + 0.01
      });
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.alpha -= p.decay;

        if (p.alpha > 0) {
          alive = true;
          ctx.save();
          ctx.globalAlpha = p.alpha;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      if (alive) {
        requestAnimationFrame(animate);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    animate();
  }

  // Initial load
  loadTodayData();
  checkNanoAvailability();
});
