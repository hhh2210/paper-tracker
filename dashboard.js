/**
 * PaperTracker - Full Dashboard Script
 * Visual analytics, 30-day heatmap, searchable paper repository, and data export.
 */

document.addEventListener('DOMContentLoaded', () => {
  let allPapers = [];
  let allDailyStats = {};
  let streakInfo = {};

  const statTotalPapers = document.getElementById('stat-total-papers');
  const statTotalTime = document.getElementById('stat-total-time');
  const statCurrentStreak = document.getElementById('stat-current-streak');
  const statBestStreak = document.getElementById('stat-best-streak');
  const heatmapContainer = document.getElementById('heatmap-container');
  const papersTableBody = document.getElementById('papers-table-body');
  const searchInput = document.getElementById('search-input');
  const filterSource = document.getElementById('filter-source');
  const btnExportMarkdown = document.getElementById('btn-export-markdown');
  const btnExportJson = document.getElementById('btn-export-json');
  const toast = document.getElementById('db-toast');

  function showToast(msg) {
    toast.textContent = msg;
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
      const hrs = (seconds / 3600).toFixed(1);
      return `${hrs} 小时`;
    }
    return `${mins} 分钟`;
  }

  function formatPreciseTime(seconds) {
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
      return `<span class="db-depth-badge db-depth-skim">⚡ 扫读</span>`;
    } else if (seconds < 600) {
      return `<span class="db-depth-badge db-depth-read">📖 细读</span>`;
    } else {
      return `<span class="db-depth-badge db-depth-deep">🧠 精读</span>`;
    }
  }

  function renderStats() {
    statTotalPapers.textContent = `${allPapers.length} 篇`;

    const totalSeconds = allPapers.reduce((sum, p) => sum + (p.totalSeconds || 0), 0);
    statTotalTime.textContent = formatTime(totalSeconds);

    statCurrentStreak.textContent = `${streakInfo.currentStreak || 0} 天`;
    statBestStreak.textContent = `${streakInfo.bestStreak || 0} 天`;
  }

  function renderHeatmap() {
    heatmapContainer.innerHTML = '';
    const today = new Date();

    // Generate last 30 days
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const stats = allDailyStats[dateStr];
      const count = stats?.paperIds?.length || 0;
      const seconds = stats?.totalSeconds || 0;

      let levelClass = 'lvl-0';
      if (count === 1) levelClass = 'lvl-1';
      else if (count >= 2 && count <= 3) levelClass = 'lvl-2';
      else if (count >= 4) levelClass = 'lvl-3';

      const cell = document.createElement('div');
      cell.className = `db-heatmap-cell ${levelClass}`;
      cell.title = `${dateStr}\n阅读: ${count} 篇\n时长: ${formatPreciseTime(seconds)}`;
      heatmapContainer.appendChild(cell);
    }
  }

  function renderTable() {
    const query = searchInput.value.toLowerCase().trim();
    const sourceFilter = filterSource.value;

    const filtered = allPapers.filter(p => {
      const matchSource = sourceFilter === 'all' || p.source === sourceFilter;
      const matchQuery = !query ||
        (p.title && p.title.toLowerCase().includes(query)) ||
        (p.id && p.id.toLowerCase().includes(query)) ||
        (p.authors && p.authors.toLowerCase().includes(query));
      return matchSource && matchQuery;
    });

    papersTableBody.innerHTML = '';
    if (filtered.length === 0) {
      papersTableBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--db-text-muted); padding: 32px;">
            暂无匹配的论文阅读记录
          </td>
        </tr>
      `;
      return;
    }

    filtered.forEach(p => {
      const tr = document.createElement('tr');
      const isAlpha = p.source === 'alphaxiv';
      const lastSeenStr = p.lastSeen ? new Date(p.lastSeen).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

      tr.innerHTML = `
        <td>
          <span class="db-source-tag ${isAlpha ? 'db-src-alphaxiv' : 'db-src-arxiv'}">
            ${isAlpha ? 'alphaXiv' : 'arXiv'}
          </span>
        </td>
        <td>
          <span class="db-id-code">${p.id}</span>
        </td>
        <td>
          <a href="${p.url || `https://arxiv.org/abs/${p.id}`}" target="_blank" class="db-paper-link">
            ${p.title}
          </a>
          ${p.authors ? `<div class="db-paper-authors">${p.authors}</div>` : ''}
        </td>
        <td>
          <strong>${formatPreciseTime(p.totalSeconds || 0)}</strong>
        </td>
        <td>
          ${getDepthBadge(p.totalSeconds || 0)}
        </td>
        <td style="color: var(--db-text-muted); font-size: 12px;">
          ${lastSeenStr}
        </td>
        <td>
          <button class="db-table-btn btn-copy" title="复制 Markdown 链接">📋 复制</button>
        </td>
      `;

      tr.querySelector('.btn-copy').addEventListener('click', async () => {
        const md = `[${p.title}](${p.url || `https://arxiv.org/abs/${p.id}`})`;
        const ok = await copyToClipboard(md);
        if (ok) {
          showToast(`已复制：${p.title.slice(0, 20)}...`);
        } else {
          showToast('复制失败，请重试');
        }
      });

      papersTableBody.appendChild(tr);
    });
  }

  function loadData() {
    chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('[PaperTracker] loadData error:', chrome.runtime.lastError);
        return;
      }
      if (!res) return;
      allPapers = Object.values(res.papers || {}).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      allDailyStats = res.daily_stats || {};
      streakInfo = res.streak || {};

      renderStats();
      renderHeatmap();
      renderTable();
    });
  }

  // Live Search & Filtering
  searchInput.addEventListener('input', renderTable);
  filterSource.addEventListener('change', renderTable);

  // Export Full Markdown
  btnExportMarkdown.addEventListener('click', async () => {
    if (allPapers.length === 0) {
      showToast('暂无论文记录可导出');
      return;
    }

    let md = `# 📚 PaperTracker 个人论文阅读全量档案\n\n`;
    md += `> 累积阅读 **${allPapers.length}** 篇论文 · 历史最佳连续打卡 **${streakInfo.bestStreak || 0}** 天 · 导出时间: ${new Date().toLocaleDateString('zh-CN')}\n\n`;
    md += `| 来源 | ID | 论文标题 | 专注时长 | 深度 | 首次阅读 |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    allPapers.forEach(p => {
      const depth = p.totalSeconds < 120 ? '⚡ 扫读' : p.totalSeconds < 600 ? '📖 细读' : '🧠 精读';
      const firstDate = p.firstSeen ? new Date(p.firstSeen).toLocaleDateString('zh-CN') : '-';
      md += `| ${p.source} | \`${p.id}\` | [${p.title.replace(/\|/g, '\\|')}](${p.url || `https://arxiv.org/abs/${p.id}`}) | ${formatPreciseTime(p.totalSeconds || 0)} | ${depth} | ${firstDate} |\n`;
    });

    const ok = await copyToClipboard(md);
    if (ok) {
      showToast('📋 全量 Markdown 已复制到剪贴板！');
    } else {
      showToast('复制失败，请重试');
    }
  });

  // Export JSON Backup
  btnExportJson.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (data) => {
      if (chrome.runtime.lastError || !data) {
        showToast('导出失败：无法读取数据');
        return;
      }
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `papertracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('💾 备份文件已触发下载！');
    });
  });

  loadData();
});
