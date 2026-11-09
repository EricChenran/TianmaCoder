/**
 * 示例动作表：每个场景一个 async 函数，收到 ctx = { mp, sleep, tap, scroll, waitPage, log }。
 *
 * 心法：
 *   1. 每个场景至少一次真实交互（切页签、切规格、加购、展开明细），不要只有「打开页面」。
 *   2. 每个导航后 sleep 1000–1400ms 等渲染，否则录到骨架屏。
 *   3. 拿不准选择器时先 node record.cjs --dry 干跑，日志会打出「未找到元素」。
 *   4. 自定义组件（商品卡等）点击不冒泡，直接 mp.navigateTo 走路由。
 */
module.exports = {
  scenes: {
    async login({ mp, tap, waitPage, sleep }) {
      // 清登录态 → 登录页，演示真实授权流程
      await mp.callWxMethod('clearStorageSync').catch(() => {});
      await mp.reLaunch('/pages/login/index');
      await waitPage('login');
      await sleep(900);
      await tap('.ck', { hold: 500 });          // 勾选协议
      await tap('.btn-auth', { hold: 400 });    // 一键登录
      await waitPage('home', 9000);             // 登录成功后自动回首页
      await sleep(900);
    },

    async home({ waitPage, scroll, sleep }) {
      await waitPage('home');
      await sleep(700);
      await scroll(340, 900);                   // 滑过轮播与类目
      await sleep(700);
      await scroll(1040, 900);                  // 瀑布流
      await sleep(600);
      await scroll(0, 600);
    },

    async detail({ mp, tap, scroll, waitPage, sleep }) {
      // 真实入口一般从列表点进去；这里演示组件卡片走路由的写法
      await mp.navigateTo('/packageA/pages/detail/index?id=p01');
      await waitPage('detail');
      await sleep(1200);
      await tap('.spec-pill', { index: 1, hold: 700, optional: true });   // 切规格
      await scroll(470, 800);                   // 图文详情
      await sleep(800);
      await tap('.act-btn', { index: 0, hold: 900, optional: true });      // 加入购物车
    },

    async orders({ mp, tap, scroll, waitPage, sleep }) {
      await mp.navigateTo('/packageA/pages/order/list');
      await waitPage('order/list');
      await sleep(1400);
      await tap('.tab', { index: 3, hold: 1300, optional: true });         // 切「配送中」
      await tap('.goods-row', { index: 0, hold: 700, optional: true });    // 打开订单详情
      await waitPage('order/detail');
      await sleep(1400);
      await scroll(420, 800);                   // 物流轨迹
      await sleep(700);
      await mp.navigateBack().catch(() => {});
    }
  }
};
