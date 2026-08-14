/* ============================================================
 * insights.js — AI 洞察（原型版规则引擎）
 * 根据当前范围数据与上一周期数据，生成自然语言结论卡片。
 * ============================================================ */
(function (global) {
  'use strict';

  const fmtMoney = n => '¥' + Math.round(n).toLocaleString('zh-CN');
  const pct = n => (n * 100).toFixed(1) + '%';

  function groupSum(records, dim) {
    const map = new Map();
    for (const r of records) {
      const k = r[dim];
      if (!k) continue;
      const g = map.get(k) || { key: k, amount: 0, count: 0, quantity: 0 };
      g.amount += r.amount || 0;
      g.count += 1;
      g.quantity += r.quantity || 0;
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }

  function fmtDelta(cur, prev) {
    if (!prev || prev <= 0) return null;
    return (cur - prev) / prev;
  }

  /* 区间内后半段 vs 前半段趋势（下滑预警用） */
  function halfTrend(records) {
    if (records.length < 30) return null;
    const sorted = [...records].sort((a, b) => a.date - b.date);
    const mid = Math.floor(sorted.length / 2);
    const s1 = sorted.slice(0, mid).reduce((s, r) => s + (r.amount || 0), 0);
    const s2 = sorted.slice(mid).reduce((s, r) => s + (r.amount || 0), 0);
    if (s1 <= 0) return null;
    return (s2 - s1) / s1;
  }

  /**
   * @param {object} ctx
   * @param {Array}  ctx.records      当前范围记录
   * @param {Array}  ctx.prevRecords  上一周期记录（可为空）
   * @param {string} ctx.label        范围名称（如"本月"）
   * @returns {Array<{tag:string,text:string,level:'info'|'warn'|'bad'}>}
   */
  function generate(ctx) {
    const { records, prevRecords, label } = ctx;
    const cards = [];
    if (!records.length) return cards;

    const total = records.reduce((s, r) => s + (r.amount || 0), 0);
    const prevTotal = prevRecords ? prevRecords.reduce((s, r) => s + (r.amount || 0), 0) : 0;
    const delta = fmtDelta(total, prevTotal);
    const orderCnt = records.length;
    const prevOrder = prevRecords ? prevRecords.length : 0;

    /* 1. 总览 */
    if (delta != null) {
      const up = delta >= 0;
      cards.push({
        tag: label + '总览',
        text: `销售额 ${fmtMoney(total)}，环比${up ? '增长' : '下降'} ${pct(Math.abs(delta))}（${orderCnt} 笔订单 vs 上期 ${prevOrder} 笔）`,
        level: up ? 'info' : (delta < -0.1 ? 'bad' : 'warn')
      });
    } else {
      cards.push({ tag: label + '总览', text: `销售额 ${fmtMoney(total)}，共 ${orderCnt} 笔订单，暂无上期数据对比`, level: 'info' });
    }

    /* 2. 人员 / 产品 / 区域榜首 */
    const topBy = (dim, unit) => {
      const list = groupSum(records, dim);
      if (!list.length) return null;
      const top = list[0];
      const share = total > 0 ? top.amount / total : 0;
      return { top, share, unit };
    };
    const topP = topBy('salesperson', '销售员');
    if (topP) cards.push({
      tag: 'Top 销售员',
      text: `${topP.top.key} 以 ${fmtMoney(topP.top.amount)} 位居榜首，占${label}销售额 ${pct(topP.share)}`,
      level: 'info'
    });
    const topPr = topBy('product', '产品');
    if (topPr) cards.push({
      tag: 'Top 产品',
      text: `热销产品为「${topPr.top.key}」，贡献 ${fmtMoney(topPr.top.amount)}（占比 ${pct(topPr.share)}）`,
      level: 'info'
    });

    /* 3. 增长之星（与上期对比） */
    if (prevRecords && prevRecords.length) {
      const cur = new Map(groupSum(records, 'salesperson').map(g => [g.key, g.amount]));
      const prev = new Map(groupSum(prevRecords, 'salesperson').map(g => [g.key, g.amount]));
      let best = null;
      for (const [k, v] of cur) {
        if (!prev.has(k) || prev.get(k) <= 0) continue;
        const g = (v - prev.get(k)) / prev.get(k);
        if (!best || g > best.g) best = { key: k, g };
      }
      if (best && best.g > 0.15) {
        cards.push({ tag: '增长之星', text: `${best.key} 较上期增长 ${pct(best.g)}，是${label}增长最快的销售员`, level: 'info' });
      }
    }

    /* 4. 下滑预警：整体后段 vs 前段 */
    const ht = halfTrend(records);
    if (ht != null && ht < -0.15) {
      cards.push({ tag: '下滑预警', text: `${label}后半段销售额较前半段下滑 ${pct(Math.abs(ht))}，增速放缓需关注`, level: 'warn' });
    }

    /* 5. 区域预警：区域后半段下滑 */
    const regions = groupSum(records, 'region');
    const regWarn = [];
    for (const g of regions) {
      const sub = records.filter(r => r.region === g.key);
      const t = halfTrend(sub);
      if (t != null && t < -0.15) regWarn.push({ key: g.key, t });
    }
    regWarn.sort((a, b) => a.t - b.t);
    if (regWarn.length) {
      const w = regWarn[0];
      cards.push({
        tag: '区域预警',
        text: `「${w.key}」${label}后段业绩下滑 ${pct(Math.abs(w.t))}${regWarn.length > 1 ? `，另有 ${regWarn.length - 1} 个区域需留意` : ''}`,
        level: 'bad'
      });
    }

    /* 6. 客单价 */
    if (orderCnt > 0) {
      const avg = total / orderCnt;
      const prevAvg = prevOrder > 0 && prevTotal > 0 ? prevTotal / prevOrder : null;
      const ad = prevAvg ? (avg - prevAvg) / prevAvg : null;
      cards.push({
        tag: '客单价',
        text: `平均客单价 ${fmtMoney(avg)}${ad != null ? `，${ad >= 0 ? '较上期提升' : '较上期下降'} ${pct(Math.abs(ad))}` : ''}`,
        level: ad != null && ad < -0.1 ? 'warn' : 'info'
      });
    }

    return cards.slice(0, 6);
  }

  global.SD = global.SD || {};
  global.SD.insights = { generate, groupSum };
})(window);
