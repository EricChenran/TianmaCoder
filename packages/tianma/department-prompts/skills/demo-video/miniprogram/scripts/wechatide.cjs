#!/usr/bin/env node
/**
 * 微信开发者工具 CLI（wechatide）驱动。
 *
 * 契约来自开发者工具自带 skill（v0.3.11）的 tools.yaml 与本机实测，三条硬约束：
 *   1) 每次 toolCall 都可能先返回 { ok:true, result:{ status:'pending', taskId } }——
 *      等用户在工具窗口里授权；必须再用 polling_task_result 取最终结果，pending 不是成功。
 *   2) 授权按 clientName 记忆；同一台机器上一个 clientName 只授权一次。
 *   3) 项目窗口未开时先 open_project_window（幂等：已开则返回已有窗口）。
 *
 * 本文件只负责定位 CLI、拼参数、轮询异步结果、把失败分型成可读错误；工具文档不在这里
 * 复制一份——它随开发者工具安装目录走，版本自洽。各工具参数见
 * `wechatide -c <clientName> <tool> -h`。
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLIENT = 'TianmaCoder';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_AUTH_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 800;
const CLI_BASENAMES = { win32: 'wechatide.cmd', darwin: 'wechatide', linux: 'wechatide' };

/** 驱动错误：code 供调用方分支处理，message 供人读。 */
class DriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
  }
}

function driverError(code, message) {
  return new DriverError(code, message);
}

/* --------------------------------------------------------------- 定位 CLI */

/** 按平台取可执行文件名；macOS/Linux 用无扩展名的 wechatide。 */
function cliBasename(platform) {
  return CLI_BASENAMES[platform] || 'wechatide';
}

/**
 * 候选安装目录：先看显式配置，再看系统默认位置。
 * @returns {string[]} 去重后的目录列表。
 */
function installRoots({ devtools, env = process.env, platform = process.platform } = {}) {
  const roots = [];
  const add = (value) => { if (value && !roots.includes(value)) roots.push(value); };
  add(devtools);
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (!base) continue;
      add(path.join(base, '微信web开发者工具'));
      add(path.join(base, 'Tencent', '微信web开发者工具'));
    }
    add('D:\\微信web开发者工具');
    add('C:\\微信web开发者工具');
  } else if (platform === 'darwin') {
    add('/Applications/wechatwebdevtools.app/Contents/MacOS');
    if (env.HOME) add(path.join(env.HOME, 'Applications/wechatwebdevtools.app/Contents/MacOS'));
  }
  return roots;
}

/**
 * 在 PATH 上找 wechatide。
 *
 * 直接扫 PATH 目录，不调 `where.exe`：Windows 下 where 的输出是控制台 OEM 代码页，
 * 按 UTF-8 解码会把中文安装目录变成乱码路径，后面 spawn 必然失败。
 *
 * @returns {string | null} 第一个命中的绝对路径。
 */
function findOnPath({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const pathVariable = env.PATH || env.Path || '';
  const names = platform === 'win32'
    ? ['wechatide.cmd', 'wechatide.exe', 'wechatide.bat']
    : ['wechatide'];
  const directories = pathVariable.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 定位 wechatide 可执行文件：显式配置 → 环境变量 → PATH → 默认安装目录。
 * @returns {{ path: string, source: string } | null}
 */
function locateCli({
  explicit,
  devtools,
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  lookupPath = findOnPath,
} = {}) {
  if (explicit) {
    if (!exists(explicit)) throw driverError('WECHATIDE_MISSING', `config 里的 wechatide 不存在：${explicit}`);
    return { path: explicit, source: 'config' };
  }
  if (env.DSH_WECHATIDE_CMD) {
    if (!exists(env.DSH_WECHATIDE_CMD)) {
      throw driverError('WECHATIDE_MISSING', `DSH_WECHATIDE_CMD 指向的文件不存在：${env.DSH_WECHATIDE_CMD}`);
    }
    return { path: env.DSH_WECHATIDE_CMD, source: 'env' };
  }
  const onPath = lookupPath({ platform, env });
  if (onPath) return { path: onPath, source: 'path' };
  const name = cliBasename(platform);
  for (const root of installRoots({ devtools, env, platform })) {
    const candidate = path.join(root, name);
    if (exists(candidate)) return { path: candidate, source: 'install-root' };
  }
  return null;
}

/** 读安装目录里那套 skill 的版本号，用于 status 的版本关系核对。 */
function readInstalledSkillVersion(root, { exists = fs.existsSync } = {}) {
  if (!root) return null;
  const file = path.join(root, 'resources', 'app.asar.unpacked', 'wechatide-skill', 'SKILL.md');
  if (!exists(file)) return null;
  const match = /^version:\s*(\S+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
  return match ? match[1] : null;
}

/* ----------------------------------------------------------- 参数与输出 */

/** cmd.exe 需要显式引号；`"` 用 `\"` 交给 CommandLineToArgvW。 */
function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/** 拼一整条命令行，只给 .cmd / .bat 走 shell 时用。 */
function commandLine(cliPath, args) {
  return [cliPath, ...args].map(quoteArg).join(' ');
}

/**
 * 解析 CLI 的 stdout。正常是单个 JSON 对象；stderr 的 `[wechatide] …` 提示不混进来。
 * @returns {object | null} 解析失败返回 null。
 */
function parseJsonOutput(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* 继续找 JSON 片段 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 默认执行器：.cmd/.bat 经 shell 起，其它直接 spawn。 */
function defaultExec(cliPath, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  const options = {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: env || process.env,
  };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    return spawnSync(commandLine(cliPath, args), { ...options, shell: true });
  }
  return spawnSync(cliPath, args, options);
}

/** 同步 sleep：主线程上不空转。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* ------------------------------------------------------- 结构容错取值 */

/**
 * 从任意嵌套结果里找页面路由。真实返回形状随工具版本可能变化，这里只认字符串路由。
 * @returns {string | null}
 */
function pickRoute(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value.startsWith('/') ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickRoute(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['route', 'path', 'pagePath', 'page', 'currentPage', 'url']) {
    const found = pickRoute(value[key], depth + 1);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = pickRoute(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 从任意嵌套结果里取第一个数组（元素列表、矩形列表等）。 */
function pickArray(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  for (const item of Object.values(value)) {
    const found = pickArray(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ 驱动 */

/**
 * 创建一个 wechatide 驱动。
 *
 * @param {object} options
 * @param {string} options.cliPath - `locateCli()` 返回的可执行文件路径。
 * @param {string} [options.project] - 小程序项目绝对路径。
 * @param {string} [options.clientName] - 授权用的客户端名，默认 TianmaCoder。
 * @param {(line: string) => void} [options.log] - 进度输出。
 * @param {string} [options.skillVersion] - 传给 check_wechatide_status 的版本。
 * @param {number} [options.timeoutMs] - 单次调用超时。
 * @param {number} [options.authTimeoutMs] - 等待用户授权/登录的总时长。
 * @param {(args: string[], timeoutMs: number) => object} [options.exec] - 测试注入点。
 */
function createDriver(options = {}) {
  const cliPath = options.cliPath;
  if (!cliPath) throw driverError('WECHATIDE_MISSING', '未找到 wechatide（开发者工具 CLI）');
  const clientName = options.clientName || DEFAULT_CLIENT;
  const project = options.project ? path.resolve(options.project) : '';
  const log = options.log || (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const skillVersion = options.skillVersion || '';
  const sleep = options.sleep || sleepSync;
  const exec = options.exec || ((args, limit) => defaultExec(cliPath, args, { timeoutMs: limit || timeoutMs, env: options.env }));
  const state = { authorized: false, polls: 0 };

  function callRaw(tool, flags) {
    const args = ['-c', clientName, tool, ...flags];
    const out = exec(args, timeoutMs);
    if (out.error && out.error.code === 'ENOENT') {
      throw driverError('WECHATIDE_MISSING', `wechatide 无法执行：${cliPath}`);
    }
    if (out.error && out.error.code === 'ETIMEDOUT') {
      throw driverError('WECHATIDE_TIMEOUT', `${tool} 超过 ${timeoutMs}ms 未返回`);
    }
    const payload = parseJsonOutput(out.stdout);
    if (!payload) {
      const tail = String(out.stderr || '').trim().split(/\r?\n/).slice(-4).join(' | ');
      throw driverError('WECHATIDE_BAD_OUTPUT', `${tool} 未返回 JSON（exit=${out.status}）：${tail || '无输出'}`);
    }
    return payload;
  }

  /** 把一次 toolCall 的最终结果摊平；失败按 code 抛出。 */
  function settle(tool, payload) {
    if (payload && payload.ok === false) {
      const code = payload.code || payload.reason || 'WECHATIDE_TOOL_FAILED';
      const message = payload.message || payload.error || code;
      throw driverError(code, `${tool} 失败：${message}`);
    }
    const result = payload && payload.result !== undefined ? payload.result : payload;
    if (result && result.success === false) {
      const code = result.code || 'WECHATIDE_TOOL_FAILED';
      throw driverError(code, `${tool} 失败：${result.message || result.error || code}`);
    }
    return result;
  }

  /** 轮询异步任务直到出结果；授权类提示用户去工具窗口点允许。 */
  function poll(taskId, { kind = 'task' } = {}) {
    const deadline = Date.now() + authTimeoutMs;
    if (kind === 'auth') {
      log(`  等授权：请在微信开发者工具里点「允许」（client=${clientName}）`);
    } else {
      log(`  异步任务 ${taskId} 进行中，等待用户在工具里确认`);
    }
    while (Date.now() < deadline) {
      state.polls += 1;
      const payload = callRaw('polling_task_result', ['--task-id', taskId]);
      const outer = payload.result !== undefined ? payload.result : payload;
      if (outer && outer.status === 'pending') {
        sleep(POLL_INTERVAL_MS);
        continue;
      }
      settle('polling_task_result', payload);
      if (outer && (outer.status === 'failed' || outer.status === 'error')) {
        throw driverError('WECHATIDE_TASK_FAILED', `${taskId}：${outer.detail || outer.message || '任务失败'}`);
      }
      return outer && outer.result !== undefined ? outer.result : outer;
    }
    throw driverError(
      'WECHATIDE_AUTH_TIMEOUT',
      `等待授权/登录超时（${Math.round(authTimeoutMs / 1000)}s）：请在微信开发者工具窗口点「允许」后重跑`,
    );
  }

  /** 调一个工具，必要时先完成授权与轮询，返回摊平后的结果。 */
  function call(tool, flags = [], opts = {}) {
    const payload = callRaw(tool, flags);
    const result = payload && payload.result !== undefined ? payload.result : payload;
    if (result && result.status === 'pending' && result.taskId) {
      const kind = result.taskType === 'auth' ? 'auth' : 'task';
      state.authorized = state.authorized || kind === 'auth';
      return poll(result.taskId, { kind });
    }
    return settle(tool, payload);
  }

  function projectFlags() {
    if (!project) throw driverError('WECHATIDE_NO_PROJECT', '驱动未配置 project');
    return ['--project', project];
  }

  function tempJson(name, value) {
    const dir = path.join(os.tmpdir(), 'wechatide-driver');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    return file;
  }

  const api = {
    cliPath,
    clientName,
    project,
    get polls() { return state.polls; },

    status() {
      const flags = skillVersion ? ['--skill-version', skillVersion] : [];
      let result = call('check_wechatide_status', flags);
      // 首次调用先跑授权；授权完成后的返回可能只有 authorized 而没有登录态，再问一次。
      if (result && result.loginExpired === undefined && result.authorized === true) {
        result = call('check_wechatide_status', flags);
      }
      return result;
    },

    /** 门禁：登录态 + 版本关系。登录过期直接抛，不带着过期会话录。 */
    ensureReady() {
      const status = api.status();
      if (status && status.loginExpired === true) {
        throw driverError(
          'WECHATIDE_LOGIN_EXPIRED',
          '微信开发者工具登录已过期：在工具里扫码登录后重跑（或 wechatide -c ' + clientName + ' login）',
        );
      }
      const relation = status && status.versionRelation;
      if (relation && relation !== 'equal' && relation !== 'agent_ahead') {
        log(`  [warn] skill 版本关系 ${relation}：工具侧接口可能与本文档不一致`);
      }
      return status;
    },

    openWindow(mode = 'liteMode') {
      return call('open_project_window', [...projectFlags(), '--window-mode', mode]);
    },

    closeWindow() {
      return call('close_project_window', projectFlags());
    },

    runtime(action) {
      return call('automation_runtime_info', [...projectFlags(), '--action', action]);
    },

    currentPagePath() {
      return pickRoute(api.runtime('currentPage'));
    },

    /** 等页面路由包含 part；超时抛错，避免录到白屏。 */
    waitPage(part, limitMs = 15000) {
      const deadline = Date.now() + limitMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = api.currentPagePath();
        } catch (error) {
          if (!/WINDOW|NOT_OPEN|not open/i.test(error.message)) throw error;
        }
        if (last && String(last).includes(part)) return last;
        sleep(250);
      }
      throw driverError('WECHATIDE_PAGE_TIMEOUT', `等待页面超时：${part}（当前 ${last || '未知'}）`);
    },

    navigate(action, url) {
      const flags = [...projectFlags(), '--action', action];
      if (url) flags.push('--url', url);
      return call('automation_navigate', flags);
    },

    elementAction(action, selector, extra = []) {
      const flags = [...projectFlags(), '--action', action, '--selector', selector, ...extra];
      return call('automation_element_action', flags);
    },

    /** 元素的包围盒列表；拿不到就返回 null，由调用方决定报错还是降级。 */
    rects(selector) {
      const fn = 'function (sel) { return new Promise(function (resolve) {'
        + ' wx.createSelectorQuery().selectAll(sel).boundingClientRect(function (r) { resolve(r || []) }).exec()'
        + ' }) }';
      try {
        const result = call('automation_evaluate', [
          ...projectFlags(), '--fn-source', fn, '--args-file', tempJson('rects-args', [selector]),
        ]);
        const list = pickArray(result);
        return Array.isArray(list) ? list : null;
      } catch {
        return null;
      }
    },

    /**
     * 点元素。index=0 走选择器；同选择器多命中时按包围盒中心坐标点，
     * 拿不到坐标就报错——宁可失败也不点错元素。
     */
    tap(selector, opts = {}) {
      const index = Number(opts.index || 0);
      const waitFor = opts.waitForSelector === undefined ? selector : opts.waitForSelector;
      if (index === 0) {
        const extra = ['--wait-for-selector', waitFor];
        if (opts.wait) extra.push('--wait', String(opts.wait));
        return api.elementAction('tap', selector, extra);
      }
      const list = api.rects(selector);
      if (!list) {
        throw driverError(
          'WECHATIDE_INDEX_UNSUPPORTED',
          `无法按索引点击 ${selector}[${index}]：取不到元素坐标；改用坐标点击或把 driver 设为 automator`,
        );
      }
      const rect = list[index];
      if (!rect) {
        throw driverError('WECHATIDE_ELEMENT_MISSING', `${selector} 只命中 ${list.length} 个，取不到第 ${index + 1} 个`);
      }
      const x = Math.round(Number(rect.left) + Number(rect.width) / 2);
      const y = Math.round(Number(rect.top) + Number(rect.height) / 2);
      return api.elementAction('tap', selector, ['--x', String(x), '--y', String(y)]);
    },

    input(selector, value) {
      return api.elementAction('input', selector, ['--value', String(value), '--wait-for-selector', selector]);
    },

    text(selector) {
      return api.elementAction('text', selector);
    },

    queryAll(selector) {
      const result = call('automation_page_action', [...projectFlags(), '--action', 'querySelectorAll', '--selector', selector]);
      const list = pickArray(result);
      return Array.isArray(list) ? list : [];
    },

    callMethod(method, args) {
      const flags = [...projectFlags(), '--action', 'callMethod', '--method', method];
      if (args !== undefined) flags.push('--args-file', tempJson(`args-${Date.now()}`, args));
      return call('automation_page_action', flags);
    },

    pageData(dataPath) {
      const flags = [...projectFlags(), '--action', 'getData'];
      if (dataPath) flags.push('--data-path', dataPath);
      return call('automation_page_action', flags);
    },

    pageScrollTo(top) {
      return call('automation_viewport_action', [...projectFlags(), '--action', 'pageScrollTo', '--scroll-top', String(top)]);
    },

    screenshot(outPath) {
      const flags = [...projectFlags()];
      if (outPath) flags.push('--path', outPath);
      return call('simulator_screenshot', flags);
    },

    evaluate(fnSource, args) {
      const flags = [...projectFlags(), '--fn-source', fnSource];
      if (args !== undefined) flags.push('--args-file', tempJson(`fn-${Date.now()}`, args));
      return call('automation_evaluate', flags);
    },

    wxApi(method, args) {
      const flags = [...projectFlags(), '--action', 'call', '--method', method];
      if (args !== undefined) flags.push('--args-file', tempJson(`wx-${Date.now()}`, args));
      return call('automation_wx_api', flags);
    },
  };

  return api;
}

/**
 * 把驱动包装成 miniprogram-automator 的子集，让既有 actions.cjs 的 mp.* 调用继续可用。
 * 只覆盖演示录制需要的接口；未覆盖的接口会抛出明确错误，不静默跳过。
 */
function mpShim(driver) {
  const page = {
    path: undefined,
    async $(selector) {
      const list = await driver.queryAll(selector);
      return list.length ? Object.assign(element({ selector, index: 0 }), { selector, index: 0 }) : null;
    },
    async $$(selector) {
      const list = await driver.queryAll(selector);
      return list.map((_item, index) => Object.assign(element({ selector, index }), { selector, index }));
    },
    async callMethod(method, args) {
      return driver.callMethod(method, args);
    },
    async data(dataPath) {
      return driver.pageData(dataPath);
    },
  };
  const element = (handle) => ({
    async tap() { return driver.tap(handle.selector, { index: handle.index }); },
    async input(value) { return driver.input(handle.selector, value); },
    async text() { return driver.text(handle.selector); },
  });
  return {
    async currentPage() {
      page.path = await driver.currentPagePath();
      return page;
    },
    async reLaunch(url) { return driver.navigate('reLaunch', url); },
    async navigateTo(url) { return driver.navigate('navigateTo', url); },
    async redirectTo(url) { return driver.navigate('redirectTo', url); },
    async switchTab(url) { return driver.navigate('switchTab', url); },
    async navigateBack() { return driver.navigate('navigateBack'); },
    async pageScrollTo(top) { return driver.pageScrollTo(top); },
    async evaluate(fn, ...args) { return driver.evaluate(String(fn), args); },
    async callWxMethod(method, ...args) { return driver.wxApi(method, args); },
    async screenshot(extra = {}) { return driver.screenshot(extra.path); },
  };
}

module.exports = {
  DriverError,
  driverError,
  cliBasename,
  installRoots,
  findOnPath,
  locateCli,
  readInstalledSkillVersion,
  quoteArg,
  commandLine,
  parseJsonOutput,
  pickRoute,
  pickArray,
  createDriver,
  mpShim,
  DEFAULT_CLIENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_AUTH_TIMEOUT_MS,
};
