/* ============================================================
 * demo.js — 示例数据生成器
 * 生成 2024-10 ~ 2024-11 两个月的"订单明细 + 销售目标"两表，
 * 内置下滑/增长趋势，方便演示 AI 识别与洞察。
 * ============================================================ */
(function (global) {
  'use strict';

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SALESPEOPLE = [
    { name: '王芳', region: '华东', trend: -0.55 },   // 明显下滑 → 触发预警
    { name: '李强', region: '华北', trend: 0.5 },     // 明显增长 → 增长之星
    { name: '张伟', region: '华南', trend: 0.08 },
    { name: '刘洋', region: '西南', trend: -0.05 },
    { name: '陈静', region: '华东', trend: 0.15 },
    { name: '赵磊', region: '华中', trend: 0.02 },
    { name: '孙丽', region: '华北', trend: -0.1 },
    { name: '周杰', region: '华南', trend: 0.2 }
  ];

  const PRODUCTS = [
    ['无线蓝牙耳机', 299], ['智能手环', 199], ['便携充电宝', 129], ['机械键盘', 399],
    ['4K显示器', 1899], ['人体工学椅', 1299], ['智能音箱', 249], ['便携投影仪', 2599],
    ['空气净化器', 1099], ['胶囊咖啡机', 899], ['电动牙刷', 349], ['桌面升降桌', 1599]
  ];

  const CITY_PRE = ['杭州', '上海', '北京', '深圳', '成都', '武汉', '广州', '南京', '苏州', '西安'];
  const CITY_SUF = ['科技', '贸易', '电商', '实业', '网络', '商贸', '供应链', '零售', '智能', '物联'];

  const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function genDemoData() {
    const rnd = mulberry32(20241117);
    const rows = [];
    const start = new Date(2024, 9, 1);          // 2024-10-01
    const end = new Date(2024, 10, 30);          // 2024-11-30
    const totalDays = Math.round((end - start) / 86400000) + 1;

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const dow = d.getDay();
      const weekend = dow === 5 || dow === 6 || dow === 0 ? 1.45 : dow === 1 ? 0.72 : 1.0;
      const prog = i / (totalDays - 1); // 0 → 1

      for (const sp of SALESPEOPLE) {
        const personFactor = 1 + sp.trend * (prog - 0.5) * 2; // 线性趋势
        const orders = Math.round((2.5 + rnd() * 3) * weekend * personFactor);
        for (let k = 0; k < orders; k++) {
          const [pname, price] = PRODUCTS[weightedProduct(rnd)];
          const qty = 1 + Math.floor(rnd() * rnd() * 4); // 偏小数量
          const discount = 0.85 + rnd() * 0.15;
          const amount = Math.round(price * qty * discount);
          const customer = CITY_PRE[Math.floor(rnd() * CITY_PRE.length)] +
            CITY_SUF[Math.floor(rnd() * CITY_SUF.length)] + '有限公司';
          rows.push([
            fmtDate(d),              // 下单日期
            amount,                  // 销售金额(元)
            qty,                     // 购买数量
            sp.name,                 // 销售员
            sp.region,               // 所属区域
            pname,                   // 商品名称
            customer                 // 客户公司
          ]);
        }
      }
    }

    const orderHeader = ['下单日期', '销售金额(元)', '购买数量', '销售员', '所属区域', '商品名称', '客户公司'];

    /* 目标表：按 销售员 × 月份 计算目标（≈当月实际 × 1.2） */
    const targetRows = [];
    for (const sp of SALESPEOPLE) {
      for (const m of [9, 10]) { // 2024-10 / 2024-11
        const monthRows = rows.filter(r =>
          new Date(r[0]).getMonth() === m && r[3] === sp.name);
        const actual = monthRows.reduce((s, r) => s + r[1], 0);
        const target = Math.round(actual * 1.2 / 10000) * 10000;
        targetRows.push([sp.name, `2024-${String(m + 1).padStart(2, '0')}`, target]);
      }
    }
    const targetHeader = ['销售员', '月份', '目标额(元)'];

    return {
      fileName: '示例订单明细_2024年10-11月.xlsx',
      sheets: [
        { name: '订单明细', header: orderHeader, rows },
        { name: '销售目标', header: targetHeader, rows: targetRows }
      ]
    };
  }

  function weightedProduct(rnd) {
    // 低价产品更常见
    const weights = PRODUCTS.map(([, p]) => Math.max(0.3, 42000 / p));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rnd() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  global.SD = global.SD || {};
  global.SD.demo = { gen: genDemoData };
})(window);
