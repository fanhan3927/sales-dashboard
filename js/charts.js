/* ============================================================
 * charts.js — 看板渲染
 * 指标卡 / 趋势 / Top 销售员 / 热销产品 / 区域占比 / 完成率仪表
 * 图表联动筛选 + 时间范围切换 + AI 洞察条
 * ============================================================ */
(function (global) {
  'use strict';

  const ACCENT = ['#4f46e5', '#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe',
    '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];

  const RANGE_LABELS = { month: '本月', quarter: '本季', year: '本年', all: '全部' };

  const charts = new Map(); // id → echarts instance

  /* ---------- 数值格式化 ---------- */
  function fmtCompact(n) {
    const abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return Math.round(n).toLocaleString('zh-CN');
  }
  function fmtMoney(n) { return '¥' + Math.round(n).toLocaleString('zh-CN'); }
  function fmtDeltaPct(d) { return (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + '%'; }

  /* ---------- 时间范围计算 ---------- */
  function computeRange(records, range) {
    if (!records.length) return { label: RANGE_LABELS[range] || '全部', cur: [], prev: [] };
    let minD = records[0].date, maxD = records[0].date;
    for (const r of records) {
      if (r.date < minD) minD = r.date;
      if (r.date > maxD) maxD = r.date;
    }
    const y = maxD.getFullYear(), mo = maxD.getMonth();
    let start, prevStart = null, prevEnd = null;
    if (range === 'month') { start = new Date(y, mo, 1); prevEnd = new Date(y, mo, 0); prevStart = new Date(y, mo - 1, 1); }
    else if (range === 'quarter') { const q = Math.floor(mo / 3); start = new Date(y, q * 3, 1); prevEnd = new Date(y, q * 3, 0); prevStart = new Date(y, q * 3 - 3, 1); }
    else if (range === 'year') { start = new Date(y, 0, 1); prevEnd = new Date(y, 0, 0); prevStart = new Date(y - 1, 0, 1); }
    else { start = minD; }

    const inWin = (r, s, e) => r.date >= s && r.date <= e;
    const cur = records.filter(r => inWin(r, start, maxD));
    const prev = prevStart ? records.filter(r => inWin(r, prevStart, prevEnd)) : [];
    return { label: RANGE_LABELS[range] || '全部', cur, prev, start, end: maxD };
  }

  function applyFilters(records, filters) {
    if (!filters) return records;
    return records.filter(r =>
      (!filters.salesperson || r.salesperson === filters.salesperson) &&
      (!filters.product || r.product === filters.product) &&
      (!filters.region || r.region === filters.region));
  }

  /* ---------- 目标完成率（按 维度+月份 去重目标额） ---------- */
  function completionStats(cur) {
    const groups = new Map();
    for (const r of cur) {
      if (r.target == null) continue;
      const dim = r.salesperson || r.region || r.product || '?';
      const key = dim + '|' + r.period;
      const g = groups.get(key) || { amount: 0, target: 0 };
      g.amount += r.amount || 0;
      g.target = Math.max(g.target, r.target);
      groups.set(key, g);
    }
    if (!groups.size) return null;
    let amount = 0, target = 0;
    for (const g of groups.values()) { amount += g.amount; target += g.target; }
    return { amount, target, rate: target > 0 ? amount / target : null };
  }

  /* ---------- 聚合 ---------- */
  function groupSum(records, dim, topN) {
    const map = new Map();
    for (const r of records) {
      const k = r[dim];
      if (!k) continue;
      map.set(k, (map.get(k) || 0) + (r.amount || 0));
    }
    const arr = [...map.entries()].map(([key, amount]) => ({ key, amount }))
      .sort((a, b) => b.amount - a.amount);
    return topN ? arr.slice(0, topN) : arr;
  }

  function bucketTrend(records) {
    if (!records.length) return { labels: [], series: [], mode: 'day' };
    let minD = records[0].date, maxD = records[0].date;
    for (const r of records) {
      if (r.date < minD) minD = r.date;
      if (r.date > maxD) maxD = r.date;
    }
    const spanDays = (maxD - minD) / 86400000;
    const mode = spanDays > 200 ? 'month' : spanDays > 31 ? 'week' : 'day';
    const map = new Map();
    for (const r of records) {
      const d = r.date;
      let key;
      if (mode === 'day') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      else if (mode === 'week') {
        const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        key = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
      } else key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      map.set(key, (map.get(key) || 0) + (r.amount || 0));
    }
    const sorted = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return {
      mode,
      labels: sorted.map(([k]) => (mode === 'month' ? k.slice(5) : k.slice(5))),
      series: sorted.map(([, v]) => Math.round(v))
    };
  }

  /* ---------- 基础 option 风格 ---------- */
  const baseText = '#5b6270';
  function baseTooltip(extra) {
    return Object.assign({
      backgroundColor: '#fff', borderColor: '#e8eaee', borderWidth: 1,
      textStyle: { color: '#1a1d26', fontSize: 12 },
      extraCssText: 'box-shadow:0 8px 24px rgba(16,24,40,.12);border-radius:10px;padding:10px 12px;'
    }, extra || {});
  }

  /* ============================================================
   * 主渲染入口
   * ============================================================ */
  function update() {
    const st = global.SD.state;
    if (!st || !st.records || !st.records.length) return;

    const range = computeRange(st.records, st.range);
    const cur = applyFilters(range.cur, st.filters);
    const prev = applyFilters(range.prev, st.filters);

    renderKpis(cur, prev, range.label);
    renderInsights(cur, prev, range.label);
    renderTrend(cur, range.label);
    renderSalesperson(cur);
    renderProduct(cur);
    renderRegion(cur);
    renderGauge(cur, range.label);
    renderFilterChips();
    updateMeta(range);
  }

  function updateMeta(range) {
    const el = document.getElementById('dashMeta');
    if (el) {
      const n = global.SD.state.records.length;
      el.textContent = `${global.SD.state.fileName || '看板'} · ${n.toLocaleString()} 条记录 · ${range.label}`;
    }
    const sub = document.getElementById('sub-trend');
    if (sub) sub.textContent = `${range.label} · 时间分布`;
  }

  /* ---------- KPI 指标卡 ---------- */
  function renderKpis(cur, prev, label) {
    const total = cur.reduce((s, r) => s + (r.amount || 0), 0);
    const prevTotal = prev.reduce((s, r) => s + (r.amount || 0), 0);
    const cnt = cur.length;
    const prevCnt = prev.length;
    const avg = cnt ? total / cnt : 0;
    const prevAvg = prevCnt ? prevTotal / prevCnt : 0;
    const cs = completionStats(cur);
    const csPrev = completionStats(prev);

    const deltaSub = (curV, prevV, fmt) => {
      if (!prevV || prevV <= 0) return '<span class="flat">暂无上期对比</span>';
      const d = (curV - prevV) / prevV;
      const cls = d >= 0 ? 'up' : 'down';
      const arrow = d >= 0 ? '↑' : '↓';
      return `<span class="${cls}">${arrow} ${fmtDeltaPct(d)}</span><span>环比上期</span>`;
    };

    const cards = [
      { label: '总销售额', value: '¥' + fmtCompact(total), sub: deltaSub(total, prevTotal) },
      { label: '订单数', value: fmtCompact(cnt) + ' 笔', sub: deltaSub(cnt, prevCnt) },
      { label: '客单价', value: '¥' + fmtCompact(avg), sub: deltaSub(avg, prevAvg) },
      { label: '目标完成率', value: cs && cs.rate != null ? (cs.rate * 100).toFixed(1) + '%' : '—', sub: cs ? (csPrev && csPrev.rate != null ? deltaSub(cs.rate, csPrev.rate) : '<span class="flat">按 ' + fmtMoney(cs.target) + ' 目标</span>') : '<span class="flat">无目标数据</span>' }
    ];

    document.getElementById('kpiRow').innerHTML = cards.map(c =>
      `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div><div class="kpi-sub">${c.sub}</div></div>`
    ).join('');
  }

  /* ---------- AI 洞察条 ---------- */
  function renderInsights(cur, prev, label) {
    const cards = global.SD.insights.generate({ records: cur, prevRecords: prev, label });
    const wrap = document.getElementById('insightStrip');
    if (!cards.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML =
      `<span class="i-note">AI 洞察 · 原型规则引擎</span>` +
      cards.map(c =>
        `<div class="insight-card"><div class="i-tag ${c.level === 'warn' ? 'warn' : c.level === 'bad' ? 'bad' : ''}">${c.tag}</div><div class="i-text">${c.text}</div></div>`
      ).join('');
  }

  /* ---------- 销售趋势 ---------- */
  function renderTrend(cur, label) {
    const el = document.getElementById('chart-trend');
    const inst = getChart('chart-trend', el);
    if (!cur.length) { inst.clear(); return; }
    const t = bucketTrend(cur);
    inst.setOption({
      color: [ACCENT[0]],
      grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
      tooltip: baseTooltip({ trigger: 'axis', valueFormatter: v => fmtMoney(v) }),
      xAxis: {
        type: 'category', data: t.labels, boundaryGap: false,
        axisLine: { lineStyle: { color: '#e8eaee' } },
        axisTick: { show: false },
        axisLabel: { color: baseText, fontSize: 11 }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: baseText, fontSize: 11, formatter: v => fmtCompact(v) },
        splitLine: { lineStyle: { color: '#f0f1f4' } }
      },
      series: [{
        name: '销售额', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6,
        data: t.series,
        lineStyle: { width: 2.5, color: ACCENT[0] },
        itemStyle: { color: ACCENT[0] },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(79,70,229,.22)' },
            { offset: 1, color: 'rgba(79,70,229,.02)' }
          ])
        }
      }]
    }, true);
  }

  /* ---------- 排名条形图（销售员 / 产品共用） ---------- */
  function renderRanking(id, records, dim, title) {
    const el = document.getElementById(id);
    const inst = getChart(id, el);
    const list = groupSum(records, dim, 10);
    if (!list.length) { inst.clear(); return; }
    inst.setOption({
      grid: { left: 8, right: 40, top: 10, bottom: 4, containLabel: true },
      tooltip: baseTooltip({ trigger: 'item', formatter: p => `${p.name}<br/>${fmtMoney(p.value)}` }),
      xAxis: {
        type: 'value',
        axisLabel: { color: baseText, fontSize: 11, formatter: v => fmtCompact(v) },
        splitLine: { lineStyle: { color: '#f0f1f4' } }
      },
      yAxis: {
        type: 'category', inverse: true, data: list.map(g => g.key),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a1d26', fontSize: 12 }
      },
      series: [{
        name: title, type: 'bar', data: list.map((g, i) => ({
          value: Math.round(g.amount),
          itemStyle: { color: i === 0 ? ACCENT[0] : '#d9dcff', borderRadius: [0, 6, 6, 0] }
        })),
        barWidth: 14,
        label: { show: true, position: 'right', color: baseText, fontSize: 11, formatter: p => fmtCompact(p.value) }
      }]
    }, true);
    // 点击联动
    inst.off('click');
    inst.on('click', p => toggleFilter(dim === 'salesperson' ? 'salesperson' : 'product', p.name));
  }

  function renderSalesperson(cur) { renderRanking('chart-salesperson', cur, 'salesperson', '销售额'); }
  function renderProduct(cur) { renderRanking('chart-product', cur, 'product', '销售额'); }

  /* ---------- 区域占比环形图 ---------- */
  function renderRegion(cur) {
    const el = document.getElementById('chart-region');
    const inst = getChart('chart-region', el);
    const list = groupSum(cur, 'region');
    const total = list.reduce((s, g) => s + g.amount, 0);
    if (!list.length) { inst.clear(); return; }
    inst.setOption({
      color: ACCENT,
      tooltip: baseTooltip({ trigger: 'item', formatter: p => `${p.name}<br/>${fmtMoney(p.value)}（${p.percent}%）` }),
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: baseText, fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['55%', '78%'], center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
        label: { show: true, formatter: p => `${p.name}\n${p.percent}%`, color: baseText, fontSize: 11, lineHeight: 15 },
        data: list.map(g => ({ name: g.key, value: Math.round(g.amount) }))
      }]
    }, true);
    inst.off('click');
    inst.on('click', p => toggleFilter('region', p.name));
  }

  /* ---------- 完成率仪表盘 ---------- */
  function renderGauge(cur, label) {
    const el = document.getElementById('chart-gauge');
    const inst = getChart('chart-gauge', el);
    const cs = completionStats(cur);
    const sub = document.getElementById('sub-gauge');
    if (!cs || cs.rate == null) {
      inst.clear();
      if (sub) sub.textContent = '无目标数据';
      return;
    }
    if (sub) sub.textContent = `实际 ${fmtMoney(cs.amount)} / 目标 ${fmtMoney(cs.target)}`;
    const rate = Math.min(cs.rate, 1.6);
    inst.setOption({
      series: [{
        type: 'gauge',
        startAngle: 210, endAngle: -30,
        min: 0, max: 1.5,
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color: rate >= 1 ? ACCENT[0] : '#f59e0b' } },
        axisLine: { lineStyle: { width: 14, color: [[1, '#eef0f5']] } },
        pointer: { show: false },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        anchor: { show: false },
        detail: {
          valueAnimation: true, offsetCenter: [0, 0], formatter: v => (v * 100).toFixed(0) + '%',
          fontSize: 30, fontWeight: 800, color: '#1a1d26'
        },
        title: { offsetCenter: [0, '72%'], fontSize: 12, color: baseText },
        data: [{ value: rate, name: label + '完成率' }]
      }]
    }, true);
  }

  /* ---------- 筛选 chips ---------- */
  function renderFilterChips() {
    const wrap = document.getElementById('filterChips');
    const f = global.SD.state.filters;
    const items = [];
    for (const k of ['salesperson', 'region', 'product']) {
      if (f[k]) items.push(`<span class="fchip">${k === 'salesperson' ? '销售员' : k === 'region' ? '区域' : '产品'}：${f[k]}<button data-k="${k}" title="取消筛选">×</button></span>`);
    }
    wrap.innerHTML = items.join('');
    wrap.hidden = !items.length;
    wrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      global.SD.state.filters[b.dataset.k] = null;
      global.SD.app.refresh();
    }));
  }

  /* ---------- 联动筛选 ---------- */
  function toggleFilter(key, name) {
    const f = global.SD.state.filters;
    f[key] = f[key] === name ? null : name;
    global.SD.app.refresh();
  }

  function getChart(id, el) {
    let inst = charts.get(id);
    if (!inst) {
      inst = echarts.init(el);
      charts.set(id, inst);
    }
    return inst;
  }

  function init() {
    window.addEventListener('resize', () => {
      for (const inst of charts.values()) inst.resize();
    });
  }

  global.SD = global.SD || {};
  global.SD.charts = { init, update, computeRange, fmtMoney, fmtCompact };
})(window);
