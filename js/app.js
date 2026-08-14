/* ============================================================
 * app.js — 应用主逻辑
 * 视图切换 / 上传流程 / 字段校对 / 看板刷新 / 分享与历史
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    fileName: '未命名',
    sheets: [],
    sheetIdx: 0,
    targetSheetIdx: -1,
    targetLike: new Set(),
    detectionCache: {},
    mapping: {},
    targets: null,
    records: [],
    filters: { salesperson: null, region: null, product: null },
    range: 'all'
  };
  global.SD.state = state;

  let toastTimer = null;

  /* ---------- 视图切换 ---------- */
  function showView(name) {
    for (const v of ['upload', 'mapping', 'dashboard']) {
      $(`view-${v}`).hidden = v !== name;
    }
    $('topbarActions').hidden = name !== 'dashboard';
    if (name === 'dashboard') {
      // 等容器可见后再渲染，避免图表尺寸为 0
      requestAnimationFrame(() => SD.charts.update());
    }
  }

  function refresh() { SD.charts.update(); }

  global.SD.app = { refresh, showView };

  /* ---------- Toast ---------- */
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  /* ============================================================
   * 上传流程
   * ============================================================ */
  function handleFile(file) {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      toast('仅支持 .xlsx / .xls / .csv 文件');
      return;
    }
    toast('正在解析文件…');
    SD.parser.readFile(file).then(sheets => {
      const total = sheets.reduce((s, x) => s + x.rowCount, 0);
      if (total > 100000) {
        toast('文件超过 10 万行上限，请拆分后重试');
        return;
      }
      if (sheets.length > 1 && sheets[0].rowCount > 90000) {
        toast('文件过大，建议拆分到单表 ≤ 10 万行');
        return;
      }
      state.fileName = file.name;
      state.sheets = sheets;
      state.sheetIdx = 0;
      state.targetSheetIdx = -1;
      state.detectionCache = {};
      state.mapping = {};
      state.targetLike = new Set();
      sheets.forEach((s, i) => {
        if (SD.fields.isTargetSheet(s.header, s.rows.slice(0, 20))) state.targetLike.add(i);
      });
      // 自动选中第一个被识别为目标表的 Sheet
      const firstTarget = [...state.targetLike][0];
      if (firstTarget != null && firstTarget !== 0) state.targetSheetIdx = firstTarget;
      showView('mapping');
      renderMapping();
    }).catch(e => {
      console.error(e);
      toast('文件解析失败：' + (e.message || '未知错误'));
    });
  }

  /* ---------- 字段校对页渲染 ---------- */
  function renderMapping() {
    const sheets = state.sheets;
    if (!sheets.length) return;
    $('fileNameLabel').textContent = state.fileName;

    const sheetSel = $('sheetSelect');
    sheetSel.innerHTML = sheets.map((s, i) =>
      `<option value="${i}">${s.name || 'Sheet' + (i + 1)}（${s.rowCount.toLocaleString()} 行 · ${s.colCount} 列）</option>`).join('');
    sheetSel.value = String(state.sheetIdx);

    const tsSel = $('targetSheetSelect');
    tsSel.innerHTML = '<option value="">不使用目标表</option>' + sheets.map((s, i) => {
      if (i === state.sheetIdx) return '';
      const flag = state.targetLike.has(i) ? ' ✓ 识别为目标表' : '';
      return `<option value="${i}">${s.name || 'Sheet' + (i + 1)}${flag}</option>`;
    }).join('');
    if (state.targetSheetIdx >= 0) tsSel.value = String(state.targetSheetIdx);

    const det = detect();
    renderMapTable(det);
    updateBuildBtn();
  }

  function detect() {
    const s = state.sheets[state.sheetIdx];
    if (state.detectionCache[state.sheetIdx]) return state.detectionCache[state.sheetIdx];
    const det = SD.fields.detectColumns(s.header, s.rows.slice(0, 20));
    state.detectionCache[state.sheetIdx] = det;
    state.mapping = {};
    for (const d of det) if (d.detected) state.mapping[d.detected] = d.col;
    return det;
  }

  function renderMapTable(det) {
    const tbody = $('mapTableBody');
    const confLabel = { high: ['高', 'conf-high'], mid: ['中', 'conf-mid'], low: ['低', 'conf-low'] };
    tbody.innerHTML = det.map(d => {
      const [cl, cc] = confLabel[d.confidence] || ['中', 'conf-mid'];
      const sample = (d.sample || []).slice(0, 3).map(v =>
        v == null || v === '' ? '<i style="color:#c0c5cf">(空)</i>' : escapeHtml(String(v))).join(' · ');
      return `<tr class="${d.confidence === 'low' ? 'conf-low' : ''}">
        <td><div class="col-name"><span class="idx">${d.col + 1}</span>${escapeHtml(d.name)}
          <span class="conf-badge ${cc}">${cl}</span></div></td>
        <td><div class="sample" title="${sample.replace(/"/g, '&quot;')}">${sample}</div></td>
        <td><select class="map-select" data-col="${d.col}">${mapOptions(d.detected)}</select></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.map-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const col = +sel.dataset.col;
        const key = sel.value;
        // 移除旧映射
        for (const k of Object.keys(state.mapping)) {
          if (state.mapping[k] === col) delete state.mapping[k];
        }
        if (key) state.mapping[key] = col;
        updateBuildBtn();
      });
    });
  }

  function mapOptions(selected) {
    return SD.fields.FIELD_OPTIONS.map(o =>
      `<option value="${o.key}" ${o.key === selected ? 'selected' : ''}>${o.label}</option>`).join('');
  }

  function updateBuildBtn() {
    const ok = state.mapping.date != null && state.mapping.amount != null;
    $('btnBuild').disabled = !ok;
    $('btnBuild').textContent = ok ? '生成看板' : '请先指定「日期」和「金额」字段';
  }

  function buildDashboard() {
    const sheet = state.sheets[state.sheetIdx];
    state.sheet = sheet;
    const { records, issues } = SD.parser.buildRecords(sheet, state.mapping);
    if (!records.length) { toast('没有解析出有效记录，请检查字段映射'); return; }

    let targets = null;
    if (state.targetSheetIdx >= 0) {
      const t = SD.parser.parseTargetSheet(state.sheets[state.targetSheetIdx]);
      if (t.targets.length) {
        targets = t.targets;
        SD.parser.attachTargets(records, targets);
        toast(`已关联目标表（${t.targets.length} 条目标）`);
      }
    }

    state.records = records;
    state.targets = targets;
    state.filters = { salesperson: null, region: null, product: null };
    state.range = 'all';

    SD.share.pushHistory({
      fileName: state.fileName,
      sheet,
      mapping: state.mapping,
      targets,
      records
    });

    showView('dashboard');
    const skipped = (issues.date + issues.amount);
    setTimeout(() => {
      toast(skipped
        ? `已生成看板：${records.length.toLocaleString()} 条记录（跳过 ${skipped} 行无效数据）`
        : `已生成看板：${records.length.toLocaleString()} 条记录`);
    }, 60);
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function bindEvents() {
    const dz = $('dropzone');
    dz.addEventListener('click', () => $('fileInput').click());
    dz.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
    });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.remove('dragover');
    }));
    dz.addEventListener('drop', e => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    $('fileInput').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      e.target.value = '';
    });

    $('btnDemo').addEventListener('click', () => {
      const demo = SD.demo.gen();
      state.fileName = demo.fileName;
      state.sheets = demo.sheets.map(s => {
        const n = SD.parser.normalizeSheet([s.header].concat(s.rows));
        n.name = s.name;
        return n;
      });
      state.sheetIdx = 0;
      state.targetSheetIdx = -1;
      state.detectionCache = {};
      state.mapping = {};
      state.targetLike = new Set();
      demo.sheets.forEach((s, i) => {
        if (SD.fields.isTargetSheet(s.header, s.rows.slice(0, 20))) state.targetLike.add(i);
      });
      const firstTarget = [...state.targetLike][0];
      if (firstTarget != null && firstTarget !== 0) state.targetSheetIdx = firstTarget;
      showView('mapping');
      renderMapping();
    });

    $('sheetSelect').addEventListener('change', e => {
      state.sheetIdx = +e.target.value;
      if (state.targetSheetIdx === state.sheetIdx) state.targetSheetIdx = -1;
      renderMapping();
    });
    $('targetSheetSelect').addEventListener('change', e => {
      state.targetSheetIdx = e.target.value === '' ? -1 : +e.target.value;
    });
    $('btnRedetect').addEventListener('click', () => {
      delete state.detectionCache[state.sheetIdx];
      renderMapping();
    });
    $('btnBuild').addEventListener('click', buildDashboard);
    $('btnBackUpload').addEventListener('click', () => showView('upload'));

    // 看板交互
    document.querySelectorAll('#rangeSeg .seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#rangeSeg .seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.range = b.dataset.range;
        SD.charts.update();
      });
    });
    $('btnExport').addEventListener('click', async () => {
      toast('正在导出图片…');
      const ok = await SD.share.exportPNG();
      toast(ok ? '看板图片已导出' : '导出失败，请重试');
    });
    $('btnNew').addEventListener('click', () => showView('upload'));

    // 分享
    $('btnShare').addEventListener('click', openShare);
    $('shareClose').addEventListener('click', () => $('shareModal').hidden = true);
    $('shareModal').addEventListener('click', e => { if (e.target === $('shareModal')) $('shareModal').hidden = true; });
    $('btnCopyLink').addEventListener('click', async () => {
      const ok = await SD.share.copyText($('shareBox').value);
      toast(ok ? '链接已复制，发送给同事即可打开同一看板' : '复制失败，请手动选择复制');
    });

    // 历史
    $('btnHistory').addEventListener('click', openHistory);
    $('historyClose').addEventListener('click', () => $('historyModal').hidden = true);
    $('historyModal').addEventListener('click', e => { if (e.target === $('historyModal')) $('historyModal').hidden = true; });

    $('brandHome').addEventListener('click', () => showView('upload'));
  }

  /* ============================================================
   * 分享 / 历史
   * ============================================================ */
  async function openShare() {
    const modal = $('shareModal');
    const box = $('shareBox');
    const warn = $('shareWarn');
    box.value = '正在生成分享链接…';
    warn.textContent = '';
    modal.hidden = false;
    try {
      const link = await SD.share.buildShareLink(state);
      box.value = link;
      const kb = (link.length / 1024).toFixed(1);
      warn.textContent = `链接长度 ${kb} KB，对方浏览器需支持 CompressionStream（现代浏览器均可）。`;
    } catch (e) {
      box.value = '';
      warn.textContent = e.message || '链接生成失败';
    }
  }

  function renderHistoryChips() {
    const strip = $('historyStrip');
    const chips = $('historyChips');
    const list = SD.share.loadHistory();
    strip.hidden = !list.length;
    if (!list.length) { chips.innerHTML = ''; return; }
    chips.innerHTML = list.map(h =>
      `<span class="hchip" data-id="${h.id}" title="打开「${escapeHtml(h.name)}」">
        ${escapeHtml(h.name)} · ${(h.rows || 0).toLocaleString()} 行 · ${timeAgo(h.time)}
        <span class="hchip-x" data-del="${h.id}">×</span>
      </span>`).join('');
    chips.querySelectorAll('[data-del]').forEach(x => x.addEventListener('click', e => {
      e.stopPropagation();
      SD.share.removeHistory(x.dataset.del);
      renderHistoryChips();
    }));
    chips.querySelectorAll('.hchip').forEach(c => c.addEventListener('click', () => {
      const entry = SD.share.loadHistory().find(h => h.id === c.dataset.id);
      if (entry) openHistoryEntry(entry);
    }));
  }

  function openHistory() {
    const listEl = $('historyList');
    const list = SD.share.loadHistory();
    if (!list.length) {
      listEl.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:20px 0">暂无历史看板</p>';
    } else {
      listEl.innerHTML = list.map(h => `
        <div class="hist-item">
          <div><div class="hi-name">${escapeHtml(h.name)}</div>
          <div class="hi-meta">${(h.rows || 0).toLocaleString()} 条记录 · ${timeAgo(h.time)}${h.payload ? '' : ' · 无内嵌数据'}</div></div>
          <div class="hi-actions">
            <button class="btn btn-secondary btn-sm" data-open="${h.id}">打开</button>
            <button class="btn btn-ghost btn-sm" data-del="${h.id}">删除</button>
          </div>
        </div>`).join('');
      listEl.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
        const entry = list.find(h => h.id === b.dataset.open);
        openHistoryEntry(entry);
      }));
      listEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
        SD.share.removeHistory(b.dataset.del);
        openHistory();
      }));
    }
    $('historyModal').hidden = false;
  }

  async function openHistoryEntry(entry) {
    const payload = await SD.share.restoreFromEntry(entry);
    if (!payload) { toast('该历史记录数据已丢失'); return; }
    buildFromPayload(payload, entry.name);
    $('historyModal').hidden = true;
    toast('已打开历史看板');
  }

  /* ---------- 从分享/历史 payload 重建看板 ---------- */
  function buildFromPayload(payload, fallbackName) {
    const sheet = { name: '', header: payload.header, rows: payload.rows };
    state.sheet = sheet;
    const { records } = SD.parser.buildRecords(sheet, payload.mapping);
    if (!records.length) { toast('数据还原失败'); return; }
    state.fileName = payload.fileName || fallbackName || '分享看板';
    state.sheets = [sheet];
    state.sheetIdx = 0;
    state.mapping = payload.mapping;
    state.targets = payload.targets || null;
    if (state.targets) SD.parser.attachTargets(records, state.targets);
    state.records = records;
    state.filters = { salesperson: null, region: null, product: null };
    state.range = 'all';
    SD.share.pushHistory({ fileName: state.fileName, sheet, mapping: state.mapping, targets: state.targets, records });
    showView('dashboard');
  }

  /* ---------- 工具 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  function init() {
    SD.charts.init();
    bindEvents();
    renderHistoryChips();
    SD.share.tryRestoreFromHash().then(payload => {
      if (payload) {
        buildFromPayload(payload, '分享看板');
        setTimeout(() => toast('已从分享链接加载看板'), 80);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
