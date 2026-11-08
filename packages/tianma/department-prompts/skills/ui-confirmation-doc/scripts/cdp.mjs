// 无头 Chromium 驱动（CDP）：供 web-capture.mjs 使用
// 说明：内置浏览器截图接口在部分环境不可用（UnknownVizError）时，走本模块直连 CDP。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function playwrightChromes() {
  const roots = [
    (process.env.LOCALAPPDATA || '') + '\\ms-playwright',
    (process.env.LOCALAPPDATA || '') + '\\ms-playwright-cache'
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!/^chromium-\d+$/.test(dir)) continue;
      found.push(`${root}\\${dir}\\chrome-win64\\chrome.exe`);
    }
  }
  return found;
}

export const DEFAULT_CHROME = [
  ...playwrightChromes(),
  (process.env.PROGRAMFILES || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  (process.env['PROGRAMFILES(X86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  (process.env['PROGRAMFILES(X86)'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p));

/**
 * 启动浏览器并返回操作句柄。
 * @param {{chrome?:string, profileDir:string, baseUrl:string, port?:number, width?:number, height?:number, dsf?:number}} opt
 */
export async function launch(opt) {
  const chrome = opt.chrome || DEFAULT_CHROME;
  if (!chrome) throw new Error('未找到 Chromium/Chrome/Edge，可用 plan.chrome 指定路径');
  // 端口交给系统分配，避免与开发者工具等其他调试端口冲突
  const port = opt.port || await freePort();
  const dsf = opt.dsf || 2;
  const width = opt.width || 1440;
  const height = opt.height || 900;

  rmSync(opt.profileDir, { recursive: true, force: true });
  mkdirSync(opt.profileDir, { recursive: true });

  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${opt.profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--force-device-scale-factor=${dsf}`, '--hide-scrollbars',
    `--window-size=${width},${height}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let version;
  for (let i = 0; i < 120; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch { await sleep(150); }
  }
  if (!version) throw new Error('Chromium 调试端口未就绪（端口 ' + port + '）');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false });

  const evalp = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  async function injectHelpers() {
    await evalp(HELPERS);
    await evalp(`(()=>{const st=document.createElement('style');st.textContent='::-webkit-scrollbar{width:0;height:0}';document.head.appendChild(st);return 1;})()`);
  }

  async function goto(url) {
    await s('Page.navigate', { url });
    for (let i = 0; i < 120; i++) {
      const ok = await evalp(`document.readyState === 'complete' && !!document.querySelector('#app') && document.querySelector('#app').children.length > 0`).catch(() => false);
      if (ok) break;
      await sleep(150);
    }
    await sleep(500);
    await injectHelpers();
  }

  async function act(type, a = {}) {
    return await evalp(`window.__act(${JSON.stringify(type)}, ${JSON.stringify(a)})`);
  }

  async function setViewport(w, h) {
    await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: false });
    await sleep(450);
  }

  /** 把视口高度撑到内容高度（避免滚动裁剪）；返回实际高度 */
  async function fitHeight({ min = 900, max = 1400, width = 1440 } = {}) {
    let h = min;
    for (let i = 0; i < 3; i++) {
      const need = await evalp(`(()=>{
        const c = document.querySelector('.content');
        const inner = c ? c.scrollHeight : document.documentElement.scrollHeight;
        const header = document.querySelector('.topbar') ? document.querySelector('.topbar').offsetHeight : 0;
        return Math.min(${max}, Math.max(${min}, inner + header));
      })()`);
      h = Math.round(need);
      await setViewport(width, h);
      const overflow = await evalp(`(()=>{const c=document.querySelector('.content'); return c ? c.scrollHeight - c.clientHeight : 0;})()`);
      if (overflow <= 2) break;
    }
    return h;
  }

  async function shot(name, dir) {
    const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(dir, { recursive: true });
    const file = `${dir}\\${name}.png`;
    writeFileSync(file, Buffer.from(data, 'base64'));
    const size = await evalp(`({w: innerWidth, h: innerHeight})`);
    return { file, size };
  }

  async function close() {
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
  }

  return { goto, act, shot, setViewport, fitHeight, close, evalp };
}

export const HELPERS = `
window.__t = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  qa: (sel, root = document) => Array.from(root.querySelectorAll(sel)),
  norm: (s) => (s || '').replace(/\\s+/g, ''),
  find: function (sel, txt, root = document) {
    const w = this.norm(txt);
    return this.qa(sel, root).find(e => this.norm(e.innerText || e.textContent).includes(w));
  },
  set: function (el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
};

window.__act = async (type, a = {}) => {
  const t = window.__t;
  const sleep = t.sleep;
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const waitGone = async (sel, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (!document.querySelector(sel)) return true; await sleep(80); }
    return false;
  };
  const waitFor = async (sel, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (document.querySelector(sel)) return true; await sleep(80); }
    throw new Error('等待元素超时: ' + sel);
  };
  const scopeOf = (sel) => sel ? (document.querySelector(sel) || document) : document;

  switch (type) {
    case 'menu': {
      const sel = '.el-menu-item, .ant-menu-item, .nav-item, [class*="menu-item"], .nav-group button, aside a, nav a, .sidebar a';
      const el = t.qa(sel).filter(visible)
        .find(e => t.norm(e.innerText || e.textContent).includes(t.norm(a.text)));
      if (!el) throw new Error('菜单未找到: ' + a.text);
      el.click();
      await sleep(a.wait || 900);
      return { url: location.pathname };
    }
    case 'btn': {
      const pool = t.qa('button, .el-button, a.btn, .btn', scopeOf(a.scope)).filter(visible);
      const want = t.norm(a.text);
      const el = pool.find(e => t.norm(e.innerText || e.textContent) === want)
        || pool.find(e => t.norm(e.innerText || e.textContent).includes(want));
      if (!el) throw new Error('按钮未找到: ' + a.text);
      el.click();
      await sleep(a.wait || 700);
      return { clicked: a.text };
    }
    case 'rowbtn': {
      const rows = t.qa('.el-table__body-wrapper .el-table__row, .ant-table-row');
      const row = a.rowText
        ? rows.find(r => t.norm(r.innerText || r.textContent).includes(t.norm(a.rowText)))
        : rows[a.row];
      if (!row) throw new Error('行未找到: ' + (a.rowText ?? a.row));
      const want = t.norm(a.text);
      const el = t.qa('button, .el-button, a', row).filter(visible)
        .find(e => t.norm(e.innerText || e.textContent) === want);
      if (!el) throw new Error('行内按钮未找到: ' + a.text);
      el.click();
      await sleep(a.wait || 800);
      return { row: a.rowText ?? a.row, clicked: a.text };
    }
    case 'radio': {
      const el = t.qa('.el-radio-button, .ant-radio-button-wrapper', scopeOf(a.scope)).filter(visible)
        .find(e => t.norm(e.innerText || e.textContent).includes(t.norm(a.text)));
      if (!el) throw new Error('选项未找到: ' + a.text);
      (el.querySelector('.el-radio-button__inner') || el).click();
      await sleep(a.wait || 900);
      return true;
    }
    case 'fill': {
      let el = null;
      if (a.placeholder) {
        el = t.qa('input, textarea').find(e => (e.placeholder || '').includes(a.placeholder) && visible(e));
      } else if (a.selector) {
        el = document.querySelector(a.selector);
      } else {
        el = t.qa('input, textarea', scopeOf(a.scope)).filter(visible)[a.index || 0];
      }
      if (!el) throw new Error('输入框未找到: ' + JSON.stringify(a));
      el.focus();
      t.set(el, String(a.value));
      await sleep(a.wait || 250);
      return true;
    }
    case 'hover': {
      const el = a.selector ? document.querySelector(a.selector) : t.find('*', a.text, scopeOf(a.scope));
      el?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(a.wait || 700);
      return true;
    }
    case 'scroll': {
      const c = document.querySelector(a.selector || '.content') || document.scrollingElement;
      c.scrollTop = a.y || 0;
      await sleep(400);
      return { top: c.scrollTop };
    }
    case 'wait': { await sleep(a.ms || 500); return true; }
    case 'waitFor': { await waitFor(a.selector, a.ms); return true; }
    case 'waitGone': { return await waitGone(a.selector, a.ms); }
    case 'esc': {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(600);
      return true;
    }
    case 'eval': { return await eval(a.js); }
    default: throw new Error('未知动作: ' + type);
  }
};
`;
