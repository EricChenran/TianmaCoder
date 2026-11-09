#!/usr/bin/env node
/**
 * 小程序演示视频 · 环境体检
 * 用法：node doctor.mjs [--config demo/config.json]
 * 只依赖 Node 标准库；逐项给出「通过 / 缺失 + 修复命令」，缺失项按阶梯降级。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const args = process.argv.slice(2);
const ci = args.indexOf('--config');
const cfgPath = ci > -1 ? args[ci + 1] : 'config.json';
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')) : {};

const ok = (m) => console.log('  [ok]   ' + m);
const warn = (m) => console.log('  [warn] ' + m);
const bad = (m, fix) => { console.log('  [FAIL] ' + m); if (fix) console.log('         -> ' + fix); };
const title = (m) => console.log('\n' + m);

let fail = 0;

/* 1. Node */
title('1. Node');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node ${process.versions.node}`);
else { fail++; bad(`Node ${process.versions.node} 过低`, '升级到 Node 18+'); }

/* 2. 开发者工具与项目 */
title('2. 微信开发者工具');
const devtools = cfg.devtools || 'D:\\微信web开发者工具';
if (existsSync(path.join(devtools, 'cli.bat'))) ok('cli.bat: ' + devtools);
else { fail++; bad('找不到 cli.bat（' + devtools + '）', 'config.json 的 devtools 指向安装目录'); }

const project = cfg.project;
if (project && existsSync(path.join(project, 'app.json'))) ok('小程序项目: ' + project);
else { fail++; bad('app.json 不存在（' + project + '）', 'config.json 的 project 指向含 app.json 的目录'); }

/* 3. 自动化端口 */
title('3. 自动化端口');
const port = Number(cfg.autoPort || 9420);
const probe = (p) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: p }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
});
if (await probe(port)) ok(`ws://127.0.0.1:${port} 可连`);
else {
  warn('端口未监听 —— 录制前先启动：');
  console.log(`         "${devtools}\\cli.bat" auto --project "${project}" --auto-port ${port}`);
}

/* 4. automator 模块 */
title('4. miniprogram-automator');
let found = null;
if (cfg.automatorModule && existsSync(cfg.automatorModule)) found = cfg.automatorModule;
if (!found) {
  const bases = [cfg.workDir, process.cwd(), path.join(cfg.workDir || '.', '..'), path.join(project || '.', '..')].filter(Boolean);
  for (const base of bases) {
    try { found = require_.resolve('miniprogram-automator', { paths: [path.resolve(base)] }); break; } catch { /* next */ }
  }
}
if (found) ok(found);
else {
  fail++;
  bad('未安装', '在 workDir 里 `npm i miniprogram-automator`，或 config.json 写 automatorModule 指向入口文件');
}

/* 5. ffmpeg */
title('5. ffmpeg（抓屏 + 合成）');
const win = process.platform === 'win32';
const tempCands = [];
if (win && process.env.TEMP && existsSync(process.env.TEMP)) {
  try {
    for (const d of readdirSync(process.env.TEMP)) {
      if (!/^ffmpeg/i.test(d)) continue;
      const root = path.join(process.env.TEMP, d);
      for (const rel of readdirSync(root, { recursive: true })) {
        if (/ffmpeg\.exe$/i.test(rel)) tempCands.push(path.join(root, rel));
      }
    }
  } catch { /* ignore */ }
}
const ff = [cfg.ffmpeg, process.env.DSH_FFMPEG_PATH, ...tempCands,
  'C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\ffmpeg.exe')]
  .filter(Boolean).find((p) => existsSync(p));
if (ff) {
  const v = spawnSync(ff, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  ok(v + '  (' + ff + ')');
  if (/(version|ffmpeg)\s*[7-9]\./.test(v)) ok('支持 ddagrab（DXGI 抓屏）');
  else warn('版本偏旧，ddagrab 可能不可用；建议 ffmpeg 7+');
} else { fail++; bad('未找到 ffmpeg', 'winget install Gyan.FFmpeg；或把路径写进 config.json 的 ffmpeg'); }

/* 6. Python 与图像库 */
title('6. Python（合成用）');
const py = cfg.python || 'python';
const r = spawnSync(py, ['-c', 'import PIL, numpy; print(PIL.__version__, numpy.__version__)'], { encoding: 'utf8' });
if (r.status === 0 && r.stdout) ok('Pillow/numpy: ' + r.stdout.trim());
else warn('默认 python 缺少 Pillow/numpy —— 用 DSH 自带 Python（load_workspace_dependencies 返回的路径）跑 compose.py');

/* 7. 字体 */
title('7. 中文字体');
const fonts = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'msyh.ttc'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'msyhbd.ttc')];
const miss = fonts.filter((f) => !existsSync(f));
miss.length ? warn('缺少 ' + miss.join(', ') + '（compose.py 里改字体路径即可）')
  : ok('微软雅黑：' + fonts.join(' / '));

/* 8. 目录 */
title('8. 目录');
for (const key of ['outDir', 'workDir']) {
  const d = cfg[key];
  if (!d) { warn(`${key} 未配置`); continue; }
  try { mkdirSync(d, { recursive: true }); ok(`${key}: ${d}`); }
  catch (e) { fail++; bad(`${key} 不可写：${e.message}`, '换一个有写权限的目录'); }
}

title('结论');
if (fail === 0) console.log('  必需项全部通过，可以写 scenes.json / actions.cjs 并干跑。');
else console.log(`  ${fail} 项必需能力缺失，先按上面的修复命令处理。`);
process.exit(fail === 0 ? 0 : 1);
