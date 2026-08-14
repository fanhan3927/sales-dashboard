/* ============================================================
 * fields.js — AI 字段识别引擎（原型版规则引擎）
 *
 * 不做真实 LLM 调用，采用"列名同义词匹配 + 数据内容类型推断"
 * 的启发式分类器，输出每个字段的识别结果与置信度。
 * ============================================================ */
(function (global) {
  'use strict';

  const FIELDS = [
    { key: 'date',         label: '日期' },
    { key: 'amount',       label: '金额' },
    { key: 'quantity',     label: '数量' },
    { key: 'salesperson',  label: '销售员' },
    { key: 'region',       label: '区域' },
    { key: 'product',      label: '产品' },
    { key: 'customer',     label: '客户' },
    { key: 'target',       label: '目标值' }
  ];

  const FIELD_OPTIONS = [{ key: '', label: '不使用' }].concat(FIELDS);

  /* 同义词词典：regex 命中计 8 分，完全词命中计 10 分，子串命中计 5 分 */
  const DICT = {
    date: [
      /日期/, /时间/, /下单/, /订单日/, /成交日/, /销售日/, /发货日/, /创建/, /登记/,
      /date/, /time/, /created/, /order/, /day/, /month/, /年月/
    ],
    amount: [
      /金额/, /销售额/, /成交额/, /营收/, /收入/, /售价/, /总额/, /货款/, /回款/,
      /amount/, /revenue/, /sales/, /price/, /total/, /fee/, /gmv/, /收入额/
    ],
    quantity: [
      /数量/, /件数/, /销量/, /订购量/, /个数/, /qty/, /quantity/, /count/, /units/
    ],
    salesperson: [
      /销售员/, /业务员/, /销售人员/, /销售人/, /负责人/, /员工/, /销售顾问/, /跟单人/,
      /salesperson/, /salesman/, /salesrep/, /rep/, /seller/, /owner/, /^sales$/, /^name$/, /姓名/
    ],
    region: [
      /区域/, /地区/, /城市/, /省份/, /大区/, /片区/, /市场/, /地域/, /省市/,
      /region/, /area/, /city/, /province/, /district/, /territory/
    ],
    product: [
      /产品/, /商品/, /品名/, /型号/, /货品/, /物料/, /品类/, /项目/,
      /product/, /item/, /goods/, /sku/, /category/
    ],
    customer: [
      /客户/, /公司/, /门店/, /店铺/, /渠道商/, /经销商/,
      /customer/, /company/, /account/, /client/, /store/
    ],
    target: [
      /目标/, /指标/, /任务/, /配额/, /预算/, /kpi/,
      /target/, /goal/, /quota/
    ]
  };

  /* 从名称中提取的关键词（用于高亮与判断） */
  function normalize(name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[\s()（）\[\]【】_\-—/\\]/g, '')
      .replace(/[（(].*?[)）]/g, '')   // 去掉括号说明，如 销售金额(元)
      .replace(/[¥￥元块]/g, '');
  }

  function nameScore(name, regexes) {
    const n = normalize(name);
    if (!n) return 0;
    let best = 0;
    for (const rx of regexes) {
      const src = rx.source.replace(/^\^|\$$/g, ''); // 粗取词面
      if (rx.test(name)) {
        // 完全相等（去掉首尾锚点后）给最高分
        if (rx.source === '^' + src + '$') best = Math.max(best, 10);
        else if (rx.source === '^' + src) best = Math.max(best, 9);
        else best = Math.max(best, 8);
      } else if (n.length >= 2 && src.length >= 2 && n.includes(src)) {
        best = Math.max(best, 5);
      }
    }
    return best;
  }

  /* ---------- 数据内容推断 ---------- */
  function parseDateStr(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      if (v > 20000 && v < 60000) {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return isNaN(d) ? null : d;
      }
      return null;
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日 / M/D/YYYY
    const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      return isNaN(d) ? null : d;
    }
    const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m2) {
      const d = new Date(+m2[3], +m2[1] - 1, +m2[2]);
      return isNaN(d) ? null : d;
    }
    const m3 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T].*$/);
    if (m3) {
      const d = new Date(+m3[1], +m3[2] - 1, +m3[3]);
      return isNaN(d) ? null : d;
    }
    return null;
  }

  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    let s = v.replace(/[¥￥,\s元]/g, '');
    if (!s) return null;
    let mult = 1;
    if (/万$/.test(s)) { mult = 10000; s = s.slice(0, -1); }
    else if (/亿$/.test(s)) { mult = 100000000; s = s.slice(0, -1); }
    const n = parseFloat(s);
    return isFinite(n) ? n * mult : null;
  }

  function inferType(values) {
    const n = values.length;
    if (!n) return 'empty';
    let date = 0, num = 0, numInt = 0, text = 0;
    const nums = [];
    for (const v of values) {
      if (v == null || v === '') continue;
      if (parseDateStr(v)) { date++; continue; }
      const numv = parseNum(v);
      if (numv != null) {
        num++;
        nums.push(numv);
        if (Number.isInteger(numv)) numInt++;
        continue;
      }
      text++;
    }
    const total = date + num + text;
    if (total === 0) return { type: 'empty', rate: 0 };
    const rate = Math.max(date, num, text) / total;
    if (date / total >= 0.8) return { type: 'date', rate };
    if (num / total >= 0.8) {
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const allSmallInt = numInt / num >= 0.9 && max <= 1000;
      if (allSmallInt && max < 200 && mean < 50) return { type: 'quantity', rate };
      if (mean >= 100 || max >= 10000) return { type: 'amount', rate };
      return { type: 'number', rate };
    }
    return { type: 'text', rate };
  }

  /* ---------- 主识别入口 ----------
   * headerRow: string[]  列名
   * sampleRows: any[][]  前若干行示例数据
   * returns: [{ col, name, sample, detected, confidence, reason }]
   */
  function detectColumns(headerRow, sampleRows) {
    const cols = headerRow.map((name, i) => ({ col: i, name: String(name == null ? '' : name).trim() }));
    const values = cols.map(c => sampleRows.map(r => r[c.col]).filter(v => v != null && v !== ''));

    const scoreMap = cols.map(() => ({}));
    for (let i = 0; i < cols.length; i++) {
      const name = cols[i].name;
      const type = inferType(values[i]);
      for (const f of FIELDS) {
        let score = nameScore(name, DICT[f.key]);
        const typeBoost = typeOfField(f.key, type);
        score += typeBoost.score;
        scoreMap[i][f.key] = { score, reason: typeBoost.reason };
      }
      // 类型兜底：没有名称命中时，纯类型也能给出弱建议
    }

    // 分配：每个字段最多一个列，每列一个字段
    const assigned = new Array(cols.length).fill(null);
    const used = new Set();
    const order = [...FIELDS].sort((a, b) => {
      // 优先级：日期、金额最高
      const pri = { date: 0, amount: 1, salesperson: 2, region: 3, product: 4, target: 5, quantity: 6, customer: 7 };
      return (pri[a.key] ?? 9) - (pri[b.key] ?? 9);
    });

    const result = cols.map(c => null);

    for (const f of order) {
      let bestI = -1, bestScore = 0;
      for (let i = 0; i < cols.length; i++) {
        if (used.has(i)) continue;
        const s = scoreMap[i][f.key];
        if (s && s.score > bestScore) { bestScore = s.score; bestI = i; }
      }
      if (bestI >= 0 && bestScore > 0) {
        assigned[bestI] = f.key;
        used.add(bestI);
      }
    }

    // 兜底：若金额/日期未被分配，尝试用类型强制指定
    if (!assigned.includes('date')) {
      const i = cols.findIndex((c, idx) => !used.has(idx) && inferType(values[idx]).type === 'date');
      if (i >= 0) { assigned[i] = 'date'; used.add(i); }
    }
    if (!assigned.includes('amount')) {
      const i = cols.findIndex((c, idx) => !used.has(idx) && inferType(values[idx]).type === 'amount');
      if (i >= 0) { assigned[i] = 'amount'; used.add(i); }
    }

    for (let i = 0; i < cols.length; i++) {
      const key = assigned[i];
      const sm = key ? scoreMap[i][key] : null;
      let confidence = 'mid';
      let reason = '';
      if (!key) {
        confidence = 'low';
        reason = '未识别，请手动指定';
      } else {
        const nameHit = nameScore(cols[i].name, DICT[key]);
        const typeInfo = inferType(values[i]);
        const typeReason = typeOfField(key, typeInfo).reason;
        if (nameHit >= 9) { confidence = 'high'; reason = '列名强匹配'; }
        else if (nameHit >= 5) { confidence = 'high'; reason = '列名匹配'; }
        else if (sm && sm.score >= 3) { confidence = 'mid'; reason = typeReason || '类型推断'; }
        else { confidence = 'low'; reason = typeReason || '推断较弱，请确认'; }
        if (sm && typeInfo.rate && typeInfo.rate < 0.6) {
          confidence = confidence === 'high' ? 'mid' : confidence;
          reason += ' · 数据混杂';
        }
      }
      result[i] = {
        col: i,
        name: cols[i].name,
        sample: values[i].slice(0, 3),
        detected: key || '',
        confidence,
        reason
      };
    }

    return result;
  }

  function typeOfField(key, type) {
    switch (key) {
      case 'date':   return type.type === 'date'     ? { score: 6, reason: '内容为日期格式' } : { score: 0, reason: '' };
      case 'amount': return type.type === 'amount'   ? { score: 6, reason: '内容为金额数值' } : { score: 0, reason: '' };
      case 'quantity': return type.type === 'quantity' ? { score: 6, reason: '内容为小整数（数量）' } : { score: 0, reason: '' };
      case 'target': return type.type === 'amount'   ? { score: 2, reason: '内容为大额数值' } : { score: 0, reason: '' };
      default: return { score: 0, reason: '' };
    }
  }

  /* 目标表识别：整张表只有"维度+目标"两列语义时判定为目标表 */
  function isTargetSheet(headerRow, sampleRows) {
    const det = detectColumns(headerRow, sampleRows);
    const keys = det.map(d => d.detected);
    const hasTarget = keys.includes('target');
    const dims = keys.filter(k => ['salesperson', 'region', 'product'].includes(k)).length;
    return hasTarget && dims >= 1;
  }

  global.SD = global.SD || {};
  global.SD.fields = {
    FIELDS,
    FIELD_OPTIONS,
    detectColumns,
    isTargetSheet,
    parseDateStr,
    parseNum
  };
})(window);
