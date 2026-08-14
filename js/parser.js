/* ============================================================
 * parser.js — 数据解析与清洗
 * 职责：读取 Excel/CSV → 表头定位 → 字段映射 → 标准化记录
 * ============================================================ */
(function (global) {
  'use strict';

  const fieldsApi = () => global.SD.fields;

  /* ---------- 读取文件 → 工作簿 → sheets ---------- */
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* 保持 utf-8 */ }
      }
      wb = XLSX.read(text, { type: 'string', cellDates: true });
    } else {
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
    }

    const sheets = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      const sheet = normalizeSheet(aoa);
      if (sheet.rows.length > 0) {
        sheet.name = name;
        sheets.push(sheet);
      }
    }
    if (!sheets.length) throw new Error('文件中没有找到可读取的数据表');
    return sheets;
  }

  /* ---------- 表头定位与行列裁剪 ---------- */
  function normalizeSheet(aoa) {
    // 去掉尾部全空行
    while (aoa.length && aoa[aoa.length - 1].every(c => c == null || String(c).trim() === '')) aoa.pop();
    // 计算最大列宽并补齐
    let maxCols = 0;
    for (const r of aoa) maxCols = Math.max(maxCols, r.length);
    for (const r of aoa) while (r.length < maxCols) r.push(null);

    const headerIdx = findHeaderRow(aoa);
    let header, rows;
    if (headerIdx >= 0) {
      header = aoa[headerIdx].map((c, i) => String(c == null ? '' : c).trim() || `列${i + 1}`);
      rows = aoa.slice(headerIdx + 1);
    } else {
      header = aoa[0].map((c, i) => `列${i + 1}`);
      rows = aoa;
    }
    // 去掉全空行
    rows = rows.filter(r => r.some(c => c != null && String(c).trim() !== ''));
    // 去掉内容重复的表头残留行（与 header 完全相同的行）
    rows = rows.filter(r => !(r.length === header.length && r.every((c, i) => String(c).trim() === header[i])));

    return {
      name: '',
      header,
      rows,
      rowCount: rows.length,
      colCount: header.length
    };
  }

  function findHeaderRow(aoa) {
    const scan = Math.min(aoa.length, 15);
    for (let r = 0; r < scan; r++) {
      const row = aoa[r] || [];
      const filled = row.filter(c => c != null && String(c).trim() !== '').length;
      if (filled < 2) continue;
      const isDataLike = row.some(c => fieldsApi().parseDateStr(c) != null);
      const ratio = filled / Math.max(row.length, 1);
      if (ratio >= 0.6 && !isDataLike) return r;
      // 行内含"日期/金额/销售"等表头词也视为表头
      const joined = row.join(' ');
      if (/日期|金额|销售|产品|数量|区域/.test(joined) && filled >= 3) return r;
    }
    return -1;
  }

  /* ---------- 字段映射 → 标准化记录 ---------- */
  function buildRecords(sheet, mapping) {
    const { parseDateStr, parseNum } = fieldsApi();
    const records = [];
    const issues = { date: 0, amount: 0 };
    const periodOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    for (const row of sheet.rows) {
      const rec = { date: null, amount: null, quantity: null, salesperson: null, region: null, product: null, customer: null, target: null };
      if (mapping.date != null) {
        const d = parseDateStr(row[mapping.date]);
        if (d) rec.date = d;
        else { issues.date++; continue; }
      }
      if (mapping.amount != null) {
        const a = parseNum(row[mapping.amount]);
        if (a != null && a > 0) rec.amount = a;
        else { issues.amount++; continue; }
      }
      if (mapping.quantity != null) {
        const q = parseNum(row[mapping.quantity]);
        rec.quantity = q != null ? q : null;
      }
      const txt = (key) => {
        const i = mapping[key];
        if (i == null) return null;
        const v = row[i];
        const s = v == null ? '' : String(v).trim();
        return s || null;
      };
      rec.salesperson = txt('salesperson');
      rec.region = txt('region');
      rec.product = txt('product');
      rec.customer = txt('customer');
      if (mapping.target != null) {
        const t = parseNum(row[mapping.target]);
        rec.target = t != null && t > 0 ? t : null;
      }
      if (rec.date) rec.period = periodOf(rec.date);
      records.push(rec);
    }
    return { records, issues };
  }

  /* ---------- 目标表解析（独立表：维度 + 月份 + 目标额） ---------- */
  function parseTargetSheet(sheet) {
    const det = fieldsApi().detectColumns(sheet.header, sheet.rows.slice(0, 20));
    const m = {};
    for (const d of det) if (d.detected) m[d.detected] = d.col;

    const targets = [];
    for (const row of sheet.rows) {
      let period = null;
      if (m.date != null) {
        const d = fieldsApi().parseDateStr(row[m.date]);
        if (d) period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      if (!period) {
        for (const c of row) {
          const s = String(c == null ? '' : c).trim();
          const mm = s.match(/^(\d{4})[-年/.](\d{1,2})月?$/);
          if (mm) { period = `${mm[1]}-${String(+mm[2]).padStart(2, '0')}`; break; }
        }
      }
      const tv = fieldsApi().parseNum(m.target != null ? row[m.target] : null);
      if (!period || tv == null || tv <= 0) continue;
      const t = {
        period,
        target: tv,
        salesperson: m.salesperson != null ? String(row[m.salesperson] ?? '').trim() : null,
        region: m.region != null ? String(row[m.region] ?? '').trim() : null,
        product: m.product != null ? String(row[m.product] ?? '').trim() : null
      };
      if (t.salesperson || t.region || t.product) targets.push(t);
    }
    return { targets, detected: m };
  }

  /* 把目标表挂到记录上：按 销售员/区域 与 月份 匹配 */
  function attachTargets(records, targets) {
    if (!targets || !targets.length) return records;
    const byPeriod = {};
    for (const t of targets) {
      (byPeriod[t.period] = byPeriod[t.period] || []).push(t);
    }
    for (const rec of records) {
      const list = byPeriod[rec.period];
      if (!list) continue;
      for (const t of list) {
        const dimMatch =
          (t.salesperson && rec.salesperson === t.salesperson) ||
          (!t.salesperson && t.region && rec.region === t.region) ||
          (!t.salesperson && !t.region && t.product && rec.product === t.product);
        if (dimMatch) { rec.target = t.target; break; }
      }
    }
    return records;
  }

  global.SD = global.SD || {};
  global.SD.parser = { readFile, buildRecords, parseTargetSheet, attachTargets, normalizeSheet };
})(window);
