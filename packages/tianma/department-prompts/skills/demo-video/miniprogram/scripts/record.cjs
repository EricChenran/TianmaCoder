#!/usr/bin/env node
/**
 * 小程序演示视频 · 录制器
 * 用法：node record.cjs --config demo/config.json --actions demo/actions.cjs [--dry] [--out capture/mp-demo.mkv]
 *
 * 做三件事：
 *   1) ffmpeg ddagrab 抓整个桌面（gdigrab 抓 Electron 会全黑，别换）
 *   2) 驱动 actions.cjs 里定义的真实交互：默认优先开发者工具自带的 wechatide CLI
 *      （自带登录门禁、窗口生命周期与异步授权），CLI 不在时退回 miniprogram-automator
 *   3) 按墙上时钟记录每个场景的起止，写 marks.json —— 合成阶段的唯一时间轴
 *
 * 场景时长 = max(scenes[i].minSec, 旁白时长 + 2.0)，旁白时长读 <audio>/durations.json；
 * 没有旁白时直接按 minSec 走。
 *
 * 驱动选择：config.driver 或 --driver 取 auto（默认）/ wechatide / automator。
 * auto 找到 wechatide 就用它；显式指定 wechatide 但找不到则报错，不静默降级。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { locateCli, createDriver, mpShim } = require('./wechatide.cjs');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i > -1 ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const cfgPath = path.resolve(argOf('config', 'config.json'));
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const CFG_BASE = path.dirname(cfgPath);
const WORK = path.resolve(CFG_BASE, CFG.workDir || '.');
const ACTIONSPath = path.resolve(argOf('actions', path.join(CFG_BASE, 'actions.cjs')));
const SCENES_PATH = path.resolve(CFG_BASE, CFG.scenes || 'scenes.json');
const SCENES = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8').replace(/^\uFEFF/, ''));
const DRY = has('dry');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const exists = fs.existsSync;

function resolveFfmpeg() {
  const cands = [CFG.ffmpeg, process.env.DSH_FFMPEG_PATH];
  for (const dir of (process.env.TEMP ? fs.readdirSync(process.env.TEMP).filter((d) => /^ffmpeg/i.test(d)) : [])) {
    const root = path.join(process.env.TEMP, dir);
    try {
      for (const rel of fs.readdirSync(root, { recursive: true })) if (/ffmpeg\.exe$/i.test(rel)) cands.push(path.join(root, rel));
    } catch { /* ignore */ }
  }
  cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  return cands.find((p) => p && exists(p));
}
function resolveAutomator() {
  if (CFG.automatorModule && exists(CFG.automatorModule)) return require(CFG.automatorModule);
  const others = [WORK, path.dirname(cfgPath), process.cwd()];
  for (const base of others) {
    try { return require(require.resolve('miniprogram-automator', { paths: [base] })); } catch { /* next */ }
  }
  throw new Error('找不到 miniprogram-automator：在 workDir 里 npm i miniprogram-automator，或在 config.json 指定 automatorModule');
}

const FF = resolveFfmpeg();
if (!DRY && !FF) throw new Error('找不到 ffmpeg（config.ffmpeg / DSH_FFMPEG_PATH / TEMP/ffmpeg-* / winget 路径都没有）');

const DRIVER = String(argOf('driver', CFG.driver || 'auto')).toLowerCase();
const ACT = require(ACTIONSPath);
const ACTIONS = ACT.scenes || ACT;

const audioDir = path.resolve(path.dirname(cfgPath), CFG.audio || 'audio');
const durations = exists(path.join(audioDir, 'durations.json')) ? readJson(path.join(audioDir, 'durations.json')) : [];
const durOf = (id) => {
  const hit = durations.find((d) => d.id === id);
  return hit ? Number(hit.sec) : 0;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, DRY ? Math.min(ms, 160) : ms));
let T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(2)}s]`, ...a);

let mp = null;
let cli = null;

/** 按 config.driver / --driver 决定用哪个驱动；显式指定 wechatide 却找不到就报错。 */
function pickDriver() {
  if (DRIVER === 'automator') return 'automator';
  const located = locateCli({ explicit: CFG.wechatide, devtools: CFG.devtools });
  if (DRIVER === 'wechatide') {
    if (!located) {
      throw new Error('driver=wechatide，但找不到 wechatide CLI：在 config.json 写 wechatide 绝对路径，或让 devtools 指向开发者工具安装目录');
    }
    return 'wechatide';
  }
  return located ? 'wechatide' : 'automator';
}

/** 连驱动：CLI 优先（登录门禁 → 开窗 → 等首页），找不到 CLI 才退回 automator。 */
async function connectDriver() {
  const name = pickDriver();
  if (name === 'wechatide') {
    const located = locateCli({ explicit: CFG.wechatide, devtools: CFG.devtools });
    cli = createDriver({
      cliPath: located.path,
      project: CFG.project,
      clientName: CFG.clientName || 'TianmaCoder',
      skillVersion: CFG.skillVersion,
      authTimeoutMs: CFG.authTimeoutMs,
      log: (...parts) => log(...parts),
    });
    const status = cli.ensureReady();
    if (status && status.loginUser) {
      log('  已登录：' + (status.loginUser.nickName || status.loginUser.openid || '(未知用户)'));
    }
    log(`  驱动：wechatide（${located.path}，来源 ${located.source}）`);
    await cli.openWindow(CFG.windowMode || 'liteMode');
    // 首次开窗要等模拟器渲染出首页；等不到不致命，后续 waitPage 还会兜一次。
    await cli.waitPage('pages/', CFG.pageTimeoutMs || 30000).catch(() => {});
    return name;
  }
  const automator = resolveAutomator();
  const port = CFG.autoPort || 9420;
  mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
  log(`  驱动：miniprogram-automator（ws://127.0.0.1:${port}，需先跑 cli.bat auto）`);
  return name;
}

async function waitPage(part, timeout = 9000) {
  if (cli) return cli.waitPage(part, timeout);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await mp.currentPage().catch(() => null);
    if (p && String(p.path).includes(part)) return p;
    await sleep(200);
  }
  throw new Error('等待页面超时: ' + part);
}

async function tap(sel, { index = 0, hold = 700, optional = false } = {}) {
  if (cli) {
    try {
      await cli.tap(sel, { index, waitForSelector: sel });
    } catch (e) {
      // 索引点击不支持是配置问题，不是「元素没找到」，必须暴露给作者去改。
      if (e.code === 'WECHATIDE_INDEX_UNSUPPORTED') throw e;
      if (!optional) throw e;
      log('  !! ' + e.message + '（跳过）');
      await sleep(hold);
      return false;
    }
    log('  tap', sel, '#' + index);
    await sleep(hold);
    return true;
  }
  const page = await mp.currentPage();
  let els = [];
  try { els = await page.$$(sel); } catch { els = []; }
  if (!els.length) {
    log('  !! 未找到元素', sel, optional ? '(跳过)' : '');
    if (!optional) throw new Error('元素不存在: ' + sel);
    await sleep(hold);
    return false;
  }
  await els[Math.min(index, els.length - 1)].tap();
  log('  tap', sel, '#' + index);
  await sleep(hold);
  return true;
}

async function input(sel, value) {
  if (cli) {
    log('  input', sel);
    return cli.input(sel, value);
  }
  const page = await mp.currentPage();
  log('  input', sel);
  return page.callMethod('onInput', { detail: { value: String(value) } });
}

async function scroll(top, ms = 700) {
  if (cli) {
    await cli.pageScrollTo(top);
    log('  scroll', top);
    await sleep(350);
    return;
  }
  try {
    await mp.evaluate((t, d) => new Promise((res) => {
      wx.pageScrollTo({ scrollTop: t, duration: d, complete: () => res(true) });
      setTimeout(() => res(true), d + 400);
    }), top, DRY ? 120 : ms);
  } catch { await mp.pageScrollTo(top).catch(() => {}); }
  log('  scroll', top);
  await sleep(350);
}

const ctx = { mp: null, cli: null, sleep, tap, input, scroll, waitPage, log, config: CFG, workDir: WORK };

(async () => {
  fs.mkdirSync(path.join(WORK, 'capture'), { recursive: true });
  const OUT = path.resolve(argOf('out', path.join(WORK, 'capture', 'mp-demo.mkv')));

  const driverName = await connectDriver();
  ctx.mp = mp;
  ctx.cli = cli;

  for (const s of SCENES.scenes) {
    if (!ACTIONS[s.id]) throw new Error('actions.cjs 缺少场景动作: ' + s.id);
  }

  let rec = null;
  let spawnWall = Date.now();
  if (!DRY) {
    rec = spawn(FF, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-filter_complex', 'ddagrab=0:framerate=25,hwdownload,format=bgra',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
      '-pix_fmt', 'yuv420p', '-r', '25', OUT
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    rec.stderr.on('data', (d) => process.stderr.write('[ffmpeg] ' + d));
    spawnWall = Date.now();
    await sleep(1500);
  }

  T0 = spawnWall;
  console.log('recording:', DRY ? '(dry run)' : OUT);

  const sync = CFG.sync || {};
  const from = sync.from || '/pages/home/index';
  const to = sync.to || '/pages/login/index';

  // 稳定页 → 整屏跳变，作为合成阶段的对齐锚点
  await mp.reLaunch(from);
  await waitPage(from.split('?')[0].replace(/^\//, '').replace(/\/index$/, ''));
  await sleep(sync.stableMs || 1400);
  const syncWall = Date.now();
  await mp.reLaunch(to);
  await sleep(900);

  const marks = [];
  for (const sc of SCENES.scenes) {
    const narration = durOf(sc.id);
    const target = Math.max(Number(sc.minSec) || 6, narration + 2.0);
    const start = Date.now();
    console.log(`\n=== ${sc.chapter} (${sc.id}) target=${target.toFixed(1)}s${narration ? ` 旁白=${narration.toFixed(2)}s` : ''} ===`);
    try {
      await ACTIONS[sc.id](ctx);
    } catch (e) {
      console.log('  !! 动作异常:', e.message);
    }
    const used = (Date.now() - start) / 1000;
    if (target - used > 0) await sleep((target - used) * 1000);
    marks.push({
      id: sc.id, chapter: sc.chapter, caption: sc.caption,
      startWall: start, endWall: Date.now(),
      start: (start - spawnWall) / 1000,
      end: (Date.now() - spawnWall) / 1000,
      targetSec: target, narrationSec: narration
    });
    console.log(`  scene done ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  await mp.switchTab(from).catch(() => {});
  await sleep(1200);

  if (rec) {
    rec.stdin.write('q');
    await new Promise((res) => { rec.on('exit', res); setTimeout(res, 8000); });
  }

  if (cli && CFG.closeWindow) {
    try {
      cli.closeWindow();
      log('  已关闭项目窗口');
    } catch (e) {
      log('  [warn] 关闭项目窗口失败：' + e.message);
    }
  }

  const meta = {
    name: CFG.slug || CFG.outName || 'demo',
    title: CFG.cover ? CFG.cover.title : CFG.brand,
    fps: 25, file: OUT, dry: DRY,
    driver: driverName, cliPath: cli ? cli.cliPath : undefined,
    spawnWall, syncWall, syncAt: (syncWall - spawnWall) / 1000,
    totalSec: (Date.now() - spawnWall) / 1000,
    scenes: marks
  };
  fs.writeFileSync(path.join(WORK, 'marks.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log(`\nmarks saved -> ${path.join(WORK, 'marks.json')}  total ${meta.totalSec.toFixed(1)}s`);
  process.exit(0);
})().catch((e) => {
  console.error('录制失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
