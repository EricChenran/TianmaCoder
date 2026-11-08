// 微信小程序逐页截图：node mp-capture.cjs <plan.json>
// 依赖：npm i miniprogram-automator（装在技能目录或任意 node_modules 可见处）
// plan.json 见 ../references/mp-plan-example.json
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const planPath = process.argv[2];
if (!planPath) {
  console.error('用法: node mp-capture.cjs <plan.json>');
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
const baseDir = path.dirname(path.resolve(planPath));
const outDir = path.resolve(baseDir, plan.outDir || 'screenshots-mp');
const ws = plan.wsEndpoint || 'ws://127.0.0.1:9420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let automator;
try {
  automator = require('miniprogram-automator');
} catch {
  console.error('缺少依赖：请先在本技能目录执行 npm i miniprogram-automator');
  process.exit(1);
}

// 可选：先跑一次 cli auto 打开自动化通道（plan.auto = {cli, project, port}）
(async () => {
  if (plan.auto && plan.auto.cli && plan.auto.project) {
    const args = ['auto', '--project', plan.auto.project, '--auto-port', String(plan.auto.port || 9420)];
    console.log('启用自动化:', plan.auto.cli, args.join(' '));
    spawnSync('cmd', ['/c', plan.auto.cli, ...args], { stdio: 'inherit' });
    await sleep(7000);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const mp = await automator.connect({ wsEndpoint: ws });
  console.log('已连接自动化通道', ws);

  const shot = async (name) => {
    await sleep(plan.settle || 350);
    const file = path.join(outDir, name + '.png');
    await mp.screenshot({ path: file });
    const cur = await mp.currentPage();
    console.log(`  ${name}  <${cur ? cur.path : '?'}>`);
  };

  const tap = async (selector) => {
    const page = await mp.currentPage();
    const el = await page.$(selector);
    if (!el) throw new Error('元素未找到: ' + selector);
    await el.tap();
    await sleep(plan.tapWait || 900);
  };

  // 登录（可选）：同意协议 → 授权登录
  if (plan.login) {
    await mp.reLaunch(plan.login.page);
    await sleep(1200);
    if (plan.login.agree) await tap(plan.login.agree);
    if (plan.login.button) await tap(plan.login.button);
    await sleep(plan.login.wait || 1800);
    const token = await mp.callWxMethod('getStorageSync', plan.login.tokenKey || 'hn_token').catch(() => '');
    console.log('登录态:', token ? '已登录' : '未登录（后续需登录的页面会被拦截）');
  }

  for (const item of plan.shots) {
    const url = item.page + (item.query ? (item.page.includes('?') ? '&' : '?') + item.query : '');
    await mp.reLaunch(url);
    await sleep(item.wait || plan.pageWait || 1500);
    for (const sel of item.taps || []) await tap(sel);
    await shot(item.name);
  }

  if (plan.close !== false) {
    await mp.close().catch(() => {});
    console.log('已关闭自动化会话（如需继续操作请设置 close:false，或重新执行 cli auto）');
  }
})().catch((e) => {
  console.error('截图失败:', e && e.message ? e.message : e);
  process.exit(1);
});
