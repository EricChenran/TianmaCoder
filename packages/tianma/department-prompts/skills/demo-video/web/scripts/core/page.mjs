/**
 * 通用页面交互层
 *
 * 抽象要点：把「组件库差异」收敛为一张选择器表（UI kit adapter），
 * 默认 auto 取多套选择器的并集，因此同一份步骤脚本可以跑在
 * Element Plus / Ant Design / Bootstrap / 原生 HTML 页面上。
 *
 * 三条铁律（踩过坑，不能改）：
 *   1. 可见性判断不用 offsetParent —— position:fixed 元素的 offsetParent 恒为 null
 *   2. 输入框必须用原生 value setter + 派发 input/change 事件，否则框架的 v-model 不更新
 *   3. 所有动作返回机器可读结果（ok / NO-XXX:...），失败时附 AVAIL 可用清单
 */
import { CDP } from './cdp.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------- UI 适配器 */

export const UI_KITS = {
  element: {
    button: ['.el-button', '.el-link', 'button', '[role="button"]'],
    clickable: ['.el-button', '.el-link', 'button', 'a', '.el-menu-item'],
    nav: ['.el-menu-item', '.el-sub-menu__title', '.el-tabs__item', 'a', 'li'],
    select: ['.el-select'],
    selectOption: ['.el-select-dropdown__item'],
    overlay: ['.el-dialog', '.el-drawer', '.el-message-box'],
    overlayClose: ['.el-dialog__headerbtn', '.el-drawer__close-btn', '.el-message-box__headerbtn'],
    msgBoxBtn: ['.el-message-box__btns button'],
    toast: ['.el-message', '.el-notification'],
    formItem: ['.el-form-item'],
    formLabel: ['.el-form-item__label'],
    tableRow: ['.el-table__row', '.el-table__body tr'],
    checkbox: ['.el-checkbox'],
    segment: ['.el-radio-button', '.el-segmented__item'],
  },
  antd: {
    button: ['.ant-btn', 'button', '[role="button"]', 'a'],
    clickable: ['.ant-btn', 'button', 'a', '.ant-menu-item'],
    nav: ['.ant-menu-item', '.ant-menu-submenu-title', '.ant-tabs-tab', 'a', 'li'],
    select: ['.ant-select'],
    selectOption: ['.ant-select-item-option'],
    overlay: ['.ant-modal', '.ant-drawer', '.ant-modal-confirm'],
    overlayClose: ['.ant-modal-close', '.ant-drawer-close'],
    msgBoxBtn: ['.ant-modal-confirm-btns button', '.ant-modal-footer button'],
    toast: ['.ant-message', '.ant-notification'],
    formItem: ['.ant-form-item'],
    formLabel: ['.ant-form-item-label'],
    tableRow: ['.ant-table-row', '.ant-table-tbody tr'],
    checkbox: ['.ant-checkbox'],
    segment: ['.ant-radio-button-wrapper', '.ant-segmented-item'],
  },
  basic: {
    button: ['button', '[role="button"]', 'input[type="submit"]', 'a'],
    clickable: ['button', '[role="button"]', 'a', 'input[type="submit"]'],
    nav: ['nav a', '[role="menuitem"]', 'a', 'li'],
    select: ['select', '[role="combobox"]'],
    selectOption: ['option', '[role="option"]'],
    overlay: ['dialog', '[role="dialog"]', '.modal'],
    overlayClose: ['[aria-label="Close"]', '.close', '[data-dismiss="modal"]'],
    msgBoxBtn: ['.modal-footer button', 'dialog button'],
    toast: ['[role="alert"]', '.toast', '.alert'],
    formItem: ['.form-group', 'label'],
    formLabel: ['label'],
    tableRow: ['table tbody tr', '[role="row"]'],
    checkbox: ['input[type="checkbox"]'],
    segment: ['[role="tab"]', '.tab'],
  },
}

/** auto = 多套选择器并集（对未知应用最稳） */
export function resolveSelectors(kit = 'auto') {
  if (kit !== 'auto' && UI_KITS[kit]) return UI_KITS[kit]
  const merged = {}
  for (const k of Object.keys(UI_KITS)) {
    for (const [key, list] of Object.entries(UI_KITS[k])) {
      merged[key] = [...(merged[key] || []), ...list]
    }
  }
  for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key])]
  return merged
}

/* ------------------------------------------------------- 注入的辅助函数库 */

export function helpersSource(selectors, options = {}) {
  const sel = JSON.stringify(selectors)
  const readOnly = JSON.stringify(options.readOnly || false)
  return String.raw`
window.__demo = (function () {
  const SEL = ${sel}
  const READ_ONLY = ${readOnly}
  const DANGER = /保存|提交|删除|移除|停用|启用|重置|确认驳回|通过并上线|批量通过|立即|结清/
  const api = {
    /* 铁律 1：position:fixed 元素的 offsetParent 恒为 null，必须用盒模型 + 计算样式 */
    vis(el) {
      if (!el) return false
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const st = getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05
    },
    all(keys) {
      const out = []
      for (const k of [].concat(keys)) out.push(...document.querySelectorAll(k))
      return [...new Set(out)]
    },
    /* 统一收敛空白：导航项常带角标，innerText 会是「入驻审核\n1」 */
    norm(s) { return String(s || '').replace(/\s+/g, ' ').trim() },
    visibleTexts(keys) {
      return [...new Set(api.all(keys).filter(api.vis).map((n) => api.norm(n.innerText)).filter(Boolean))]
    },
    /* 铁律 2：原生 value setter + 事件，否则 v-model 拿不到值 */
    setValue(el, value) {
      const proto = Object.getPrototypeOf(el)
      const d = Object.getOwnPropertyDescriptor(proto, 'value')
      if (!d || !d.set) { el.value = value } else { d.set.call(el, value) }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      const ev = new Event('blur', { bubbles: true })
      el.dispatchEvent(ev)
      return 'ok'
    },
    tap(text, kind) {
      const keys = kind === 'nav' ? SEL.nav : SEL.clickable
      const want = api.norm(text)
      const all = api.all(keys).filter(api.vis)
      // 先精确匹配，再退化为「归一化后前缀匹配」——导航项常带角标数字，
      // 例如「入驻审核 1」，精确匹配会漏掉；前缀匹配取最短的那个，避免点到大容器。
      let hit = all.filter((n) => api.norm(n.innerText) === want).sort((a, b) => api.norm(a.innerText).length - api.norm(b.innerText).length)[0]
      if (!hit) {
        hit = all.filter((n) => api.norm(n.innerText).startsWith(want)).sort((a, b) => api.norm(a.innerText).length - api.norm(b.innerText).length)[0] || null
      }
      if (!hit) return 'NO-TEXT:' + text + ' AVAIL:' + api.visibleTexts(keys).slice(0, 20).join('|')
      if (READ_ONLY && DANGER.test(text)) return 'REFUSED_READONLY:' + text
      const target = hit.closest(SEL.clickable.join(',')) || hit
      target.click()
      return 'ok'
    },
    type(by, match, value) {
      let el = null
      if (by === 'label') {
        const item = api.all(SEL.formItem).filter(api.vis).find((i) => {
          const lb = i.querySelector(SEL.formLabel.join(',')) || i.querySelector('label')
          return lb && (lb.innerText || '').trim().includes(match)
        })
        el = item ? item.querySelector('input, textarea') : null
      } else if (by === 'selector') {
        el = api.all(match).find(api.vis) || null
      } else {
        el = [...document.querySelectorAll('input, textarea')].find((i) => (i.placeholder || '').includes(match) && api.vis(i)) || null
      }
      if (!el) {
        return 'NO-INPUT:' + match + ' AVAIL:' + [...document.querySelectorAll('input, textarea')].map((i) => i.placeholder || i.name || i.id || '(无名)').slice(0, 12).join('|')
      }
      return api.setValue(el, value)
    },
    async pick(selectLabel, optionText) {
      const sels = api.all(SEL.select).filter(api.vis)
      const target = selectLabel
        ? sels.find((s) => (s.innerText || '').trim().includes(selectLabel)) || sels.find((s) => (s.getAttribute('placeholder') || '').includes(selectLabel))
        : sels[0]
      if (!target) return 'NO-SELECT:' + (selectLabel || '') + ' AVAIL:' + sels.map((s) => (s.innerText || '').trim().slice(0, 12)).join('|')
      const trigger = target.querySelector('.el-select__wrapper, .ant-select-selector, select') || target.querySelector('input') || target
      if (READ_ONLY === false) {
        trigger.click()
        await new Promise((r) => setTimeout(r, 400))
      }
      const items = api.all(SEL.selectOption).filter(api.vis)
      const opt = items.find((i) => (i.innerText || '').trim() === optionText) || items.find((i) => (i.innerText || '').trim().includes(optionText))
      if (!opt) return 'NO-OPTION:' + optionText + ' AVAIL:' + items.map((i) => (i.innerText || '').trim()).join('|')
      opt.click()
      await new Promise((r) => setTimeout(r, 600))
      return 'ok'
    },
    confirm(buttonText) {
      const btns = api.all(SEL.msgBoxBtn).filter(api.vis)
      const pool = btns.length ? btns : api.all(SEL.overlay).filter(api.vis).slice(-1).flatMap((o) => [...o.querySelectorAll('button')].filter(api.vis))
      if (!pool.length) return 'NO-MSGBOX'
      const b = buttonText ? pool.find((x) => (x.innerText || '').trim().includes(buttonText)) : pool[pool.length - 1]
      if (!b) return 'NO-MSGBTN:' + buttonText + ' AVAIL:' + pool.map((x) => (x.innerText || '').trim()).join('|')
      b.click()
      return 'ok'
    },
    closeTop() {
      const boxes = api.all(SEL.overlay).filter(api.vis)
      if (!boxes.length) return 'NO-OVERLAY'
      const top = boxes[boxes.length - 1]
      const btn = top.querySelector(SEL.overlayClose.join(','))
      if (btn) { btn.click(); return 'ok-close' }
      const cancel = [...top.querySelectorAll('button')].find((b) => /取消|关闭|知道了|确定/.test(b.innerText || ''))
      if (cancel) { cancel.click(); return 'ok-cancel' }
      return 'NO-CLOSE-BTN'
    },
    overlayTitle() {
      const t = api.all(['.el-dialog__title', '.el-drawer__title', '.el-message-box__title', '.ant-modal-title', '.ant-drawer-title'])
        .filter(api.vis)
      return t.length ? (t[t.length - 1].innerText || '').trim().slice(0, 40) : ''
    },
    /* 数据行：只看可见的行。
       坑：SEL.tableRow 里的 table tbody tr 会命中隐藏元素——Element Plus 的 el-date-picker
       在关闭状态下日历表仍留在 DOM 里（两个面板 14 行），不过滤可见性就会把
       用户列表的 6 行数成 18 行、订单总览的 10 行数成 22 行。
       行索引（rowAction/checkRow）与计数（rows()）必须共用这一个来源，否则两者对不上。
       注意：本函数体在 String.raw 模板里，注释中不能出现反引号。 */
    dataRows() {
      return api.all(SEL.tableRow).filter((r) => api.vis(r) && (r.querySelector('td') || r.getAttribute('role') === 'row'))
    },
    rows() { return api.dataRows().length },
    rowAction(index, text) {
      const row = api.dataRows()[index]
      if (!row) return 'NO-ROW:' + index + ' (共 ' + api.rows() + ' 行)'
      const btns = [...row.querySelectorAll('button, .el-button, .el-link, .ant-btn, a')]
      const btn = btns.find((b) => (b.innerText || '').trim() === text)
      if (!btn) return 'NO-ROWBTN:' + text + ' AVAIL:' + btns.map((b) => (b.innerText || '').trim()).join('|')
      if (READ_ONLY && DANGER.test(text)) return 'REFUSED_READONLY:' + text
      btn.click()
      return 'ok'
    },
    rowActionAny(index, texts) {
      const row = api.dataRows()[index]
      if (!row) return 'NO-ROW:' + index
      const btns = [...row.querySelectorAll('button, .el-button, .el-link, .ant-btn, a')]
      for (const t of texts) {
        const btn = btns.find((b) => (b.innerText || '').trim() === t)
        if (btn) { if (READ_ONLY && DANGER.test(t)) return 'REFUSED_READONLY:' + t; btn.click(); return 'ok:' + t }
      }
      return 'NO-ROWBTN-ANY:' + texts.join('/') + ' AVAIL:' + btns.map((b) => (b.innerText || '').trim()).join('|')
    },
    checkRow(index) {
      const row = api.dataRows()[index]
      if (!row) return 'NO-ROW:' + index
      const box = row.querySelector(SEL.checkbox.join(',')) || row.querySelector('input[type="checkbox"]')
      if (!box) return 'NO-CHECKBOX'
      box.click()
      return 'ok'
    },
    seg(text) {
      const nodes = api.all(SEL.segment).filter((s) => (s.innerText || '').trim().includes(text) && api.vis(s))
      if (!nodes.length) return 'NO-SEG:' + text
      nodes[0].click()
      return 'ok'
    },
    toggleBox(label) {
      const hit = api.all(SEL.checkbox).filter(api.vis).find((b) => (b.innerText || '').trim() === label)
      if (!hit) return 'NO-CHECKBOX:' + label
      hit.click()
      return 'ok'
    },
    hasText(t) { return (document.body.innerText || '').includes(t) },
    path() { return location.pathname + location.search },
    toast() {
      const m = api.all(SEL.toast).filter(api.vis)
      return m.length ? (m[m.length - 1].innerText || '').trim().slice(0, 60) : ''
    },
    scroll(y) { window.scrollTo({ top: y }); return 'ok' },
    downloadCount() { return window.__demoDownloads ? window.__demoDownloads.length : 0 },
    inventory() {
      return {
        path: api.path(),
        title: document.title,
        buttons: api.visibleTexts(SEL.button || SEL.clickable),
        nav: api.visibleTexts(SEL.nav),
        selects: api.all(SEL.select).filter(api.vis).map((s) => api.norm(s.innerText).slice(0, 24)),
        segments: api.visibleTexts(SEL.segment),
        rowCount: api.rows(),
        firstRow: (() => {
          const r = api.dataRows()[0]
          if (!r) return []
          return [...r.querySelectorAll('td, [role="cell"]')].map((td) => api.norm(td.innerText).slice(0, 28))
        })(),
        overlays: api.all(SEL.overlay).filter(api.vis).map((o) => api.norm((o.querySelector('.el-dialog__title,.el-drawer__title,.ant-modal-title') || {}).innerText) || '(无标题)'),
      }
    },
  }
  return api
})()
'ready'
`
}

/** 注入辅助库（注意：页面导航后必须重新注入） */
export async function injectHelpers(cdp, selectors, options = {}) {
  const r = await cdp.ev(helpersSource(selectors, options))
  if (r && r.__err) throw new Error(`注入辅助库失败：${r.__err}`)
  return r
}

/* --------------------------------------------------------------- 等待能力 */

export async function waitFor(cdp, expr, timeoutMs = 15000, label = expr) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.ev(`(() => { try { return !!(${expr}) } catch (e) { return false } })()`)
    if (last === true) return true
    await sleep(200)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

/* -------------------------------------------------------------- 动作执行器 */

/**
 * 执行单个动作。返回 'ok' 或以 NO-/REFUSED/E_ 开头的诊断串。
 * 调用方（CLI）负责把诊断串升级为错误，或按 continueOnError 继续。
 */
export async function runAction(cdp, action, ctx) {
  const s = ctx.selectors
  const a = typeof action === 'string' ? { type: 'click', text: action } : action
  switch (a.type) {
    case 'nav':
      return cdp.ev(`window.__demo.tap(${JSON.stringify(a.text)}, 'nav')`)
    case 'click':
      if (a.selector) return cdp.ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(a.selector)})].find(window.__demo.vis); if (!el) return 'NO-SELECTOR:${a.selector}'; el.click(); return 'ok' })()`)
      return cdp.ev(`window.__demo.tap(${JSON.stringify(a.text)})`)
    case 'fill':
      return cdp.ev(`window.__demo.type(${JSON.stringify(a.by || 'placeholder')}, ${JSON.stringify(a.match)}, ${JSON.stringify(a.value)})`)
    case 'pick':
      return cdp.ev(`window.__demo.pick(${JSON.stringify(a.select || '')}, ${JSON.stringify(a.option)})`)
    case 'confirm':
      return cdp.ev(`window.__demo.confirm(${a.buttonText ? JSON.stringify(a.buttonText) : 'null'})`)
    case 'closeTop':
      return cdp.ev(`window.__demo.closeTop()`)
    case 'overlayTitle':
      return cdp.ev(`window.__demo.overlayTitle()`)
    case 'checkRow':
      return cdp.ev(`window.__demo.checkRow(${Number(a.index) || 0})`)
    case 'rowAction':
      return cdp.ev(`window.__demo.rowAction(${Number(a.index) || 0}, ${JSON.stringify(a.text)})`)
    case 'rowActionAny':
      return cdp.ev(`window.__demo.rowActionAny(${Number(a.index) || 0}, ${JSON.stringify(a.texts || [])})`)
    case 'seg':
      return cdp.ev(`window.__demo.seg(${JSON.stringify(a.text)})`)
    case 'toggleBox':
      return cdp.ev(`window.__demo.toggleBox(${JSON.stringify(a.label)})`)
    case 'scroll':
      return cdp.ev(`window.__demo.scroll(${Number(a.y) || 0})`)
    case 'toast':
      return cdp.ev(`window.__demo.toast()`)
    case 'wait':
      await sleep(Number(a.ms) || 500)
      return 'ok'
    case 'waitText':
      await waitFor(cdp, `window.__demo.hasText(${JSON.stringify(a.text)})`, a.timeoutMs || 15000, `文本「${a.text}」`)
      return 'ok'
    case 'waitPath':
      await waitFor(cdp, `window.__demo.path().startsWith(${JSON.stringify(a.startsWith)})`, a.timeoutMs || 15000, `路径以 ${a.startsWith} 开头`)
      return 'ok'
    case 'assert': {
      const expr = restrictedAssert(a.expr)
      // timeoutMs 可选：给了就在超时内反复求值，用来等一个「会自动消失的瞬时状态」
      // （典型：Toast 出现的时刻取决于接口延迟，固定 wait 必然偶发失败）。
      const timeoutMs = Math.max(0, Number(a.timeoutMs) || 0)
      const deadline = Date.now() + timeoutMs
      let ok = false
      do {
        ok = (await cdp.ev(`(() => { try { return !!(${expr}) } catch (e) { return false } })()`)) === true
        if (!ok && Date.now() < deadline) await sleep(200)
      } while (!ok && Date.now() < deadline)
      if (ok) return 'ok'
      const snap = await cdp.ev(`JSON.stringify(window.__demo.inventory())`)
      const waited = timeoutMs ? `（轮询 ${timeoutMs}ms 未满足）` : ''
      return `E_ASSERT_FAILED:${a.expr}${waited} 现场快照:${String(snap).slice(0, 300)}`
    }
    case 'eval': {
      if (!ctx.allowEval) return 'E_EVAL_DISABLED:未开启 allowEval，拒绝执行任意 JS'
      return cdp.ev(a.js)
    }
    default:
      return `E_UNKNOWN_ACTION:${a.type}`
  }
}

/**
 * 受限断言：只允许只读探针，禁止任意 JS（缩小注入面）。
 * 允许写法：rows() > 0、hasText('x')、path().includes('/a')、overlayTitle()、toast()
 */
export function restrictedAssert(expr) {
  const raw = String(expr || '')
  if (/[;{}[\]]|=>|function|eval|Function|import|require|fetch|XMLHttpRequest|__proto__|constructor/i.test(raw)) {
    throw new Error(`断言表达式包含不允许的语法：${raw}`)
  }
  return raw.replace(/\b(rows|hasText|path|toast|overlayTitle|downloadCount)\s*\(/g, 'window.__demo.$1(')
}

/* ------------------------------------------------------------- 登录配方 */

/**
 * 通用登录：按配置填字段 → 提交 → 等路由。
 * 不假设任何具体站点；字段全由配置给出。
 */
export async function performLogin(cdp, login, ctx) {
  if (!login) return
  for (const f of login.fill || []) {
    const r = await runAction(cdp, { type: 'fill', ...f }, ctx)
    if (r !== 'ok') throw new Error(`登录填写失败：${JSON.stringify(f)} → ${r}`)
    await sleep(300)
  }
  if (login.submit) {
    const r = await runAction(cdp, { type: 'click', ...login.submit }, ctx)
    if (r !== 'ok') throw new Error(`登录提交失败：${JSON.stringify(login.submit)} → ${r}`)
  }
  if (login.waitPath) {
    await waitFor(cdp, `window.__demo.path().startsWith(${JSON.stringify(login.waitPath.startsWith)})`, login.timeoutMs || 20000, '登录后跳转')
  }
  if (login.waitText) {
    await waitFor(cdp, `window.__demo.hasText(${JSON.stringify(login.waitText)})`, login.timeoutMs || 20000, '登录后页面')
  }
  // 仅等路由变化是不够的：SPA 常先切路由再拉数据渲染，此时立刻断言会失败。
  // 这里给一个可配置的稳定期，默认 900ms。
  await sleep(Number(login.settleMs ?? 900))
  // 登录后页面通常已重渲染，重新注入一次保证辅助库可用
  await injectHelpers(cdp, ctx.selectors, { readOnly: ctx.readOnly })
}
