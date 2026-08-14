/* ============================================================
 * share.js — 导出 PNG / 分享链接 / 历史记录
 * 分享链接把数据压缩后内嵌在 URL hash 中，无需服务器即可还原看板
 * ============================================================ */
(function (global) {
  'use strict';

  const HS_KEY = 'sd_history_v1';
  const MAX_HISTORY = 8;
  const MAX_PAYLOAD = 1200000; // 单条历史 payload 上限（字符）

  /* ---------- 压缩 / 解压 ---------- */
  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function compress(str) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return bytesToB64(new Uint8Array(buf));
  }
  async function decompress(b64) {
    const stream = new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buf);
  }

  /* ---------- 导出 PNG ---------- */
  async function exportPNG() {
    const el = document.getElementById('view-dashboard');
    if (!el || !global.html2canvas) return false;
    try {
      const canvas = await html2canvas(el, {
        backgroundColor: '#f6f7f9',
        scale: 2,
        useCORS: true,
        logging: false
      });
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 10);
      a.download = `销售业绩看板_${ts}.png`;
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch (e) {
      console.error('导出失败', e);
      return false;
    }
  }

  /* ---------- 分享链接（内嵌数据） ---------- */
  async function buildSharePayload(state) {
    const payload = {
      v: 1,
      fileName: state.fileName,
      header: state.sheet.header,
      rows: state.sheet.rows,
      mapping: state.mapping,
      targets: state.targets
    };
    const json = JSON.stringify(payload);
    if (json.length > 2000000) {
      throw new Error('数据量过大，链接会超出浏览器地址栏长度限制，建议使用「导出 PNG」分享。');
    }
    return await compress(json);
  }

  async function buildShareLink(state) {
    const b64 = await buildSharePayload(state);
    return location.origin + location.pathname + '#d=' + b64;
  }

  async function tryRestoreFromHash() {
    const h = location.hash;
    if (!h.startsWith('#d=')) return null;
    try {
      const json = await decompress(h.slice(3));
      const payload = JSON.parse(json);
      if (!payload || !payload.header) return null;
      return payload;
    } catch (e) {
      console.warn('分享链接解析失败', e);
      return null;
    }
  }

  /* ---------- 历史记录（localStorage） ---------- */
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HS_KEY) || '[]');
    } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HS_KEY, JSON.stringify(list)); } catch (e) { /* 存储超限忽略 */ }
  }

  async function pushHistory(state) {
    const list = loadHistory();
    let payload = null;
    try {
      const b64 = await buildSharePayload(state);
      if (b64.length <= MAX_PAYLOAD) payload = b64;
    } catch (e) { payload = null; }
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: state.fileName,
      rows: state.records.length,
      time: Date.now(),
      payload
    };
    const next = [entry].concat(list.filter(x => x.name !== state.fileName)).slice(0, MAX_HISTORY);
    saveHistory(next);
    return entry;
  }

  function removeHistory(id) {
    saveHistory(loadHistory().filter(x => x.id !== id));
  }

  async function restoreFromEntry(entry) {
    if (!entry.payload) return null;
    try {
      const json = await decompress(entry.payload);
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  /* ---------- 剪贴板 ---------- */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  global.SD = global.SD || {};
  global.SD.share = {
    exportPNG,
    buildShareLink,
    buildSharePayload,
    tryRestoreFromHash,
    loadHistory,
    pushHistory,
    removeHistory,
    restoreFromEntry,
    copyText
  };
})(window);
