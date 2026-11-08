// Web 管理后台逐屏截图：node web-capture.mjs <plan.json>
// plan.json 见 ../references/plan-example.json
import { launch } from './cdp.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const planPath = process.argv[2];
if (!planPath) {
  console.error('用法: node web-capture.mjs <plan.json>');
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
const baseDir = dirname(resolve(planPath));
const outDir = resolve(baseDir, plan.outDir || 'screenshots');
const width = plan.viewport?.[0] || 1440;
const height = plan.viewport?.[1] || 900;
const baseUrl = plan.baseUrl || 'http://localhost:5173';

const browser = await launch({
  chrome: plan.chrome,
  profileDir: resolve(baseDir, plan.profileDir || '.chrome-profile'),
  baseUrl,
  port: plan.port,
  width,
  height,
  dsf: plan.dsf || 2
});

try {
  await browser.setViewport(width, height);
  if (baseUrl) await browser.goto(baseUrl + (plan.startPath || '/'));
  await browser.act('wait', { ms: 500 });

  for (const shot of plan.shots) {
    for (const action of shot.actions || []) {
      const { type, ...args } = action;
      if (type === 'goto') {
        await browser.goto(baseUrl + args.url);
        continue;
      }
      if (type === 'setViewport') {
        await browser.setViewport(args.width || width, args.height || height);
        continue;
      }
      await browser.act(type, args);
    }
    if (shot.fit) await browser.fitHeight({ width, min: shot.minHeight || 900, max: shot.maxHeight || 1400 });
    const { size } = await browser.shot(shot.name, outDir);
    console.log(`  ${shot.name}  ${size.w}x${size.h}`);
  }
} catch (err) {
  console.error('截图失败:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log('\n输出目录:', outDir);
  for (const f of readdirSync(outDir).sort()) console.log('  ' + f);
}
