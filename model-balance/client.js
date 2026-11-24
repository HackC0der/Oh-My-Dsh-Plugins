/**
 * Client half of the model-balance bundle.
 *
 * Registers one right-sidebar tab ("Model balances") through the public
 * two-stage protocol (type in `ctx.sidebarRightTabs`, body under the keyed
 * `sidebar.right.pane.tab` seat). The tab lists every configured provider
 * account as a card:
 *
 * - GLM Coding Plan: plan tier chip plus one meter row per quota window —
 *   the 5-hour rolling window, the weekly window, and the tool-call window
 *   with its per-tool breakdown — each with usage percentage, used/limit,
 *   and a live reset countdown.
 * - DeepSeek Platform: wallet rows per currency with granted/topped-up
 *   splits and the "sufficient for calls" dot.
 * - OpenRouter: remaining credits with a used-versus-total meter.
 *
 * The same bundle also feeds the composer dock: one entry (id
 * `model-balance.windows`) renders a context-meter-style ring pair — the
 * 5-hour and the weekly window — per enabled GLM account, beside the shipped
 * tokens/s and cache-hit pills; clicking it opens a panel with the full
 * numbers. It renders nothing while no GLM plan data is available.
 *
 * Accounts are created, edited, and removed here; the dialog never shows or
 * sends a saved key back — edits leave the key field empty to keep it. All
 * data comes from this bundle's Host half over same-origin plugin routes,
 * which also own the outbound provider calls (the provider consoles send no
 * CORS headers, and the key must stay off the browser).
 */
window.__ModuleLoader__.load({
  id: '@local/model-balance',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const {
      Fragment, useCallback, useEffect, useMemo, useRef, useState,
    } = React
    const h = React.createElement

    const NS = 'modelBalance'
    /** Identity in the tab system: registration keys and type ids. */
    const PANEL_ID = '@local/model-balance'
    /** Tab kind of the balance panel. */
    const KIND = 'balance'
    /** Base of the Host half's plugin routes. */
    const API = '/plugins/model-balance'
    /** Panel polling cadence while the tab is open (the Host caches 30s). */
    const POLL_MS = 60_000
    /** Local re-render cadence for countdowns and relative times. */
    const TICK_MS = 30_000
    /** Usage percentage where a meter turns warning color. */
    const WARN_AT = 60
    /** Usage percentage where a meter turns danger color. */
    const BAD_AT = 85
    /** Known GLM window ids, in display order; unknown windows follow. */
    const WINDOW_ORDER = { 'tokens-5h': 0, 'credits-5h': 1, 'tokens-week': 2, 'credits-week': 3, calls: 4 }

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copies, registered under the locale service)  */
    /* ------------------------------------------------------------------ */

    const en = {
      'tab.title': 'Model balances',
      'guide.title': 'Model balances',
      'guide.description': 'GLM plan windows, DeepSeek and OpenRouter balances',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.add': 'Add account',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.retry': 'Retry',
      'header.updated': 'Updated {time}',
      'header.never': 'Not fetched yet',
      'empty.title': 'No accounts yet',
      'empty.body': 'Add a GLM Coding Plan key, a DeepSeek key, or an OpenRouter key to watch their remaining quota here.',
      'plan.label': 'Plan',
      'window.tokens-5h': '5-hour window',
      'window.tokens-week': 'Weekly window',
      'window.calls': 'Tool calls',
      'window.other': 'Other window',
      'reset.in': 'resets in {time}',
      'reset.soon': 'resets soon',
      'reset.unknown': 'reset time unknown',
      'remaining.label': '{n} left',
      'wallet.available': 'Available',
      'wallet.insufficient': 'Insufficient for calls',
      'wallet.granted': 'granted {n}',
      'wallet.toppedUp': 'topped up {n}',
      'credits.used': '{used} of {quota} used',
      'state.error': 'Query failed',
      'state.disabled': 'Disabled',
      'state.missingKey': 'No API key',
      'missingKey.hint': 'Edit this account to add its API key.',
      'dialog.titleAdd': 'Add account',
      'dialog.titleEdit': 'Edit account',
      'dialog.provider': 'Provider',
      'dialog.label': 'Display name',
      'dialog.labelPlaceholder': 'e.g. GLM Coding Plan',
      'dialog.baseUrl': 'API base URL',
      'dialog.baseUrlHint': 'Leave empty for the default ({default})',
      'dialog.apiKey': 'API key',
      'dialog.apiKeyHintAdd': 'Stored only on this machine, in the Host data directory.',
      'dialog.apiKeyHintEdit': 'Leave empty to keep the saved key.',
      'dialog.apiKeyEnv': '…or the name of an environment variable',
      'dialog.apiKeyEnvHint': 'The variable is read on the Host at query time; a stored key wins over it.',
      'dialog.matchRoutes': 'Session model routes this account answers for',
      'dialog.matchRoutesHint': 'Space-separated provider-route ids (e.g. zai-coding-cn); its rings show only in sessions running one of these routes.',
      'dialog.enabled': 'Query this account',
      'dialog.save': 'Save',
      'dialog.saving': 'Saving…',
      'dialog.cancel': 'Cancel',
      'error.load': 'Could not load: {message}',
      'error.save': 'Could not save: {message}',
      'error.delete': 'Could not delete: {message}',
      'delete.confirm': 'Sure?',
      'time.now': 'just now',
      'time.minute': '{n} min ago',
      'time.hour': '{n} h ago',
      'time.day': '{n} d ago',
      'key.tail': 'key {tail}',
      'key.env': 'env {name}',
      'dock.5h.aria': '5-hour window: {percent}% used, resets in {time}',
      'dock.week.aria': 'Weekly window: {percent}% used, resets in {time}',
      'dock.5h.label': '5-hour window quota used',
      'dock.week.label': 'Weekly window quota used',
      'dock.panel.title': 'Subscription windows',
      'dock.panel.aria': 'Quota windows of {name}',
    }

    const zh = {
      'tab.title': '模型余额',
      'guide.title': '模型余额',
      'guide.description': 'GLM 套餐窗口、DeepSeek 与 OpenRouter 余额',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'action.add': '添加账号',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.retry': '重试',
      'header.updated': '更新于 {time}',
      'header.never': '尚未查询',
      'empty.title': '还没有账号',
      'empty.body': '添加 GLM Coding Plan、DeepSeek 或 OpenRouter 的密钥，在这里查看它们的剩余额度。',
      'plan.label': '套餐',
      'window.tokens-5h': '5 小时窗口',
      'window.tokens-week': '每周窗口',
      'window.calls': '工具调用',
      'window.other': '其他窗口',
      'reset.in': '{time}后重置',
      'reset.soon': '即将重置',
      'reset.unknown': '重置时间未知',
      'remaining.label': '剩 {n}',
      'wallet.available': '可用',
      'wallet.insufficient': '余额不足',
      'wallet.granted': '赠送 {n}',
      'wallet.toppedUp': '充值 {n}',
      'credits.used': '已用 {used} / {quota}',
      'state.error': '查询失败',
      'state.disabled': '已停用',
      'state.missingKey': '未配置密钥',
      'missingKey.hint': '编辑该账号以填写 API 密钥。',
      'dialog.titleAdd': '添加账号',
      'dialog.titleEdit': '编辑账号',
      'dialog.provider': '服务商',
      'dialog.label': '显示名称',
      'dialog.labelPlaceholder': '如：GLM Coding Plan',
      'dialog.baseUrl': 'API 基础地址',
      'dialog.baseUrlHint': '留空使用默认值（{default}）',
      'dialog.apiKey': 'API 密钥',
      'dialog.apiKeyHintAdd': '只保存在本机的 Host 数据目录中。',
      'dialog.apiKeyHintEdit': '留空表示保留已保存的密钥。',
      'dialog.apiKeyEnv': '…或环境变量名',
      'dialog.apiKeyEnvHint': '查询时由 Host 读取该变量；已保存的密钥优先于它。',
      'dialog.matchRoutes': '对应的会话模型路由',
      'dialog.matchRoutesHint': '空格分隔的路由 id（如 zai-coding-cn）；只有运行这些路由的会话才会显示它的仪表。',
      'dialog.enabled': '查询该账号',
      'dialog.save': '保存',
      'dialog.saving': '保存中…',
      'dialog.cancel': '取消',
      'error.load': '加载失败：{message}',
      'error.save': '保存失败：{message}',
      'error.delete': '删除失败：{message}',
      'delete.confirm': '确认？',
      'time.now': '刚刚',
      'time.minute': '{n} 分钟前',
      'time.hour': '{n} 小时前',
      'time.day': '{n} 天前',
      'key.tail': '密钥 {tail}',
      'key.env': '环境变量 {name}',
      'dock.5h.aria': '5 小时窗口已用 {percent}%，{time}后重置',
      'dock.week.aria': '每周窗口已用 {percent}%，{time}后重置',
      'dock.5h.label': '5小时窗口额度使用',
      'dock.week.label': '每周窗口额度使用',
      'dock.panel.title': '订阅窗口',
      'dock.panel.aria': '{name} 的额度窗口',
    }

    /* ------------------------------------------------------------------ */
    /* Host route access                                                   */
    /* ------------------------------------------------------------------ */

    /** One same-origin JSON call to the Host half; throws Error with a message. */
    async function callApi(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...options,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let value = null
      try {
        value = await response.json()
      } catch {
        value = null
      }
      if (!response.ok) {
        const detail = value !== null && typeof value.error === 'string' ? value.error : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return value
    }

    const loadAccounts = () => callApi('/accounts')
    const loadProviders = () => callApi('/providers')
    const loadStatus = refresh => callApi(`/status${refresh ? '?refresh=1' : ''}`)
    const refreshOne = id => callApi('/refresh', { method: 'POST', body: { id } })
    const createAccount = input => callApi('/accounts', { method: 'POST', body: input })
    const updateAccount = (id, input) => callApi(`/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })
    const deleteAccount = id => callApi(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })

    /* ------------------------------------------------------------------ */
    /* Formatting helpers                                                  */
    /* ------------------------------------------------------------------ */

    /** Compact number: large quota figures stay one glance readable. */
    function fmtNumber(value) {
      if (value === null || value === undefined) return '—'
      const abs = Math.abs(value)
      if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
      if (abs >= 10_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`
      return Math.round(value).toLocaleString()
    }

    /** Money: two decimals at most, locale separators. */
    function fmtMoney(value) {
      if (value === null || value === undefined) return '—'
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }

    /** Millisecond countdown as a bare duration: "2h 14m" / "36m" / "40s". */
    function fmtCountdown(msLeft) {
      if (msLeft === null || msLeft === undefined) return ''
      if (msLeft <= 60_000) return '<1m'
      const minutes = Math.floor(msLeft / 60_000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    /** The reset phrase for one window: unknown, imminent, or a countdown. */
    function resetPhrase(resetAt, now, t) {
      if (resetAt === null || resetAt === undefined) return t('reset.unknown')
      const left = resetAt - now
      if (left <= 60_000) return t('reset.soon')
      return t('reset.in', { time: fmtCountdown(left) })
    }

    /** Relative time for the fetched-at stamp. */
    function relativeTime(iso, now, t) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const seconds = Math.max(0, Math.round((now - at) / 1000))
      if (seconds < 60) return t('time.now')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t('time.minute', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hour', { n: hours })
      return t('time.day', { n: Math.floor(hours / 24) })
    }

    /** Meter fill class from one usage percentage. */
    function meterClass(percentage) {
      if (percentage >= BAD_AT) return 'mb-bad'
      if (percentage >= WARN_AT) return 'mb-warn'
      return 'mb-ok'
    }

    /** Clamp a percentage into 0..100 for bar widths. */
    function clampPct(percentage) {
      return Math.max(0, Math.min(100, percentage))
    }

    /** Absolute local time for tooltips. */
    function absTime(resetAt) {
      if (resetAt === null) return ''
      try {
        return new Date(resetAt).toLocaleString()
      } catch {
        return ''
      }
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.mb-panel { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }
.mb-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 10px 12px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.mb-head-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.mb-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; height: 26px; min-width: 26px; padding: 0 5px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.mb-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mb-icon-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.mb-icon-btn.mb-danger { color: var(--dsw-alias-state-error-primary); }
.mb-updated { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mb-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 14px; }
.mb-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 11px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.mb-card.mb-dim { opacity: 0.55; }
.mb-card-head { display: flex; align-items: center; gap: 6px; }
.mb-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.mb-chip { flex: none; padding: 1px 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.mb-chip.mb-brand { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.mb-chip.mb-state-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.mb-chip.mb-state-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.mb-card-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mb-rows { display: flex; flex-direction: column; gap: 8px; }
.mb-row { display: flex; flex-direction: column; gap: 3px; }
.mb-row-top { display: flex; align-items: baseline; gap: 6px; }
.mb-row-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mb-row-value { flex: 1; min-width: 0; text-align: right; font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.mb-row-remaining { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.mb-meter { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.mb-meter-fill { height: 100%; border-radius: 999px; }
.mb-meter-fill.mb-ok { background: var(--dsw-alias-state-success-primary); }
.mb-meter-fill.mb-warn { background: var(--dsw-alias-state-warn-primary); }
.mb-meter-fill.mb-bad { background: var(--dsw-alias-state-error-primary); }
.mb-row-foot { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mb-reset { flex: 1; min-width: 0; }
.mb-chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
.mb-chip.mb-mini { padding: 0 6px; font-size: 10px; line-height: 15px; }
.mb-balance { display: flex; align-items: baseline; gap: 6px; }
.mb-balance-num { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mb-balance-cur { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mb-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.mb-dot.mb-off { background: var(--dsw-alias-state-error-primary); }
.mb-wallet-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mb-state-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mb-state-row.mb-row-error { color: var(--dsw-alias-state-error-primary); }
.mb-state-text { flex: 1; min-width: 0; word-break: break-word; }
.mb-empty { padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; text-align: center; }
.mb-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.mb-error button { flex: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; padding: 2px 8px; cursor: pointer; }
.mb-backdrop { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); padding: 20px; box-sizing: border-box; }
.mb-modal { width: min(420px, 100%); max-height: 100%; display: flex; flex-direction: column; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.mb-modal-title { flex: none; padding: 14px 16px 6px; font-size: 15px; font-weight: 600; }
.mb-modal-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 6px 16px 4px; }
.mb-field { display: flex; flex-direction: column; gap: 4px; }
.mb-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mb-input, .mb-select { flex: 1; min-width: 0; height: 32px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 8px; }
.mb-input:focus, .mb-select:focus { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -1px; }
.mb-modal-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 16px; }
.mb-check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.mb-check-row input { accent-color: var(--dsw-alias-brand-primary); }
.mb-modal-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px; }
.mb-modal-error { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.mb-button { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; }
.mb-button-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.mb-button:disabled { opacity: 0.5; cursor: default; }
`

    /* Composer-dock rings: same strip as the shipped stats pills, modeled on
       the context-occupancy meter (14px viewBox ring, 2px stroke) plus its
       click-open panel. */
    const DOCK_CSS = `
.mbd-group { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.mbd-trigger { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: var(--dsh-content-font-size-secondary, 13px); font-variant-numeric: tabular-nums; line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); white-space: nowrap; cursor: pointer; }
.mbd-trigger:hover, .mbd-trigger[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.mbd-trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.mbd-ring-track { fill: none; stroke: var(--dsw-alias-border-l3); stroke-width: 2; }
.mbd-gauge-used { fill: none; stroke: var(--dsw-alias-label-tertiary); stroke-width: 2; stroke-linecap: round; }
.mbd-label { color: var(--dsw-alias-label-tertiary); }
.mbd-reading { min-width: 24px; text-align: left; }
.mbd-reading.mbd-warn { color: var(--dsw-alias-state-warn-primary); }
.mbd-reading.mbd-bad { color: var(--dsw-alias-state-error-primary); }
.mbd-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: min(300px, calc(100vw - 24px)); padding: 12px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay)); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); font-size: 13px; }
.mbd-panel-head { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; }
.mbd-panel-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.mbd-chip { flex: none; padding: 1px 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.mbd-chip.mb-brand { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.mbd-rule { height: 0.5px; background: var(--dsw-alias-border-l2); margin: 0 0 8px; }
.mbd-rows { display: flex; flex-direction: column; gap: 8px; }
.mbd-row-top { display: flex; align-items: baseline; gap: 6px; }
.mbd-row-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mbd-row-value { flex: 1; min-width: 0; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.mbd-meter { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.mbd-meter-fill { height: 100%; border-radius: 999px; }
.mbd-row-foot { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.mbd-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
`

    /* ------------------------------------------------------------------ */
    /* Row components                                                      */
    /* ------------------------------------------------------------------ */

    /** One thin usage meter. */
    function Meter({ percentage }) {
      return h('div', { className: 'mb-meter', role: 'img', 'aria-label': `${Math.round(percentage)}%` },
        h('div', { className: `mb-meter-fill ${meterClass(percentage)}`, style: { width: `${clampPct(percentage)}%` } }))
    }

    /** Locale keys of the known GLM window ids; unknown ids share one label. */
    const WINDOW_LABEL_KEY = {
      'tokens-5h': 'window.tokens-5h',
      'credits-5h': 'window.tokens-5h',
      'tokens-week': 'window.tokens-week',
      'credits-week': 'window.tokens-week',
      calls: 'window.calls',
    }

    /** One quota-window row: label, meter, used/limit, reset countdown. */
    function WindowRow({ window: win, t, now }) {
      const pct = win.percentage ?? 0
      const value = win.limit !== null && win.limit !== undefined
        ? `${fmtNumber(win.used)} / ${fmtNumber(win.limit)}`
        : `${Math.round(pct)}%`
      const label = t(WINDOW_LABEL_KEY[win.id] ?? 'window.other')
      const details = Array.isArray(win.details) ? win.details : []
      return h('div', { className: 'mb-row' },
        h('div', { className: 'mb-row-top' },
          h('span', { className: 'mb-row-label' }, label),
          win.remaining !== null && win.remaining !== undefined
            ? h('span', { className: 'mb-row-remaining' }, t('remaining.label', { n: fmtNumber(win.remaining) }))
            : null,
          h('span', { className: 'mb-row-value' }, value),
        ),
        h(Meter, { percentage: pct }),
        h('div', { className: 'mb-row-foot' },
          h('span', { className: 'mb-reset', title: absTime(win.resetAt) }, resetPhrase(win.resetAt, now, t)),
        ),
        details.length > 0 ? h(ToolBreakdown, { details }) : null,
      )
    }

    /** One DeepSeek/OpenRouter wallet row. */
    function WalletRow({ wallet, t }) {
      const balance = wallet.balance ?? null
      const hasSplit = wallet.granted !== null || wallet.toppedUp !== null
      const subParts = []
      if (wallet.granted !== null) subParts.push(t('wallet.granted', { n: fmtMoney(wallet.granted) }))
      if (wallet.toppedUp !== null) subParts.push(t('wallet.toppedUp', { n: fmtMoney(wallet.toppedUp) }))
      return h('div', { className: 'mb-row' },
        h('div', { className: 'mb-row-top' },
          h('span', { className: 'mb-row-label', title: wallet.available ? t('wallet.available') : t('wallet.insufficient') },
            h('span', { className: `mb-dot${wallet.available ? '' : ' mb-off'}`, style: { display: 'inline-block', marginRight: 6 } }),
          ),
          h('span', { className: 'mb-balance' },
            h('span', { className: 'mb-balance-num' }, balance === null ? '—' : fmtMoney(balance)),
            h('span', { className: 'mb-balance-cur' }, wallet.currency ?? ''),
          ),
        ),
        hasSplit ? h('div', { className: 'mb-wallet-sub' }, subParts.join(' · ')) : null,
        wallet.quota !== null && wallet.quota !== undefined
          ? h(Fragment, null,
            h(Meter, { percentage: wallet.quota > 0 ? ((wallet.used ?? 0) / wallet.quota) * 100 : 0 }),
            h('div', { className: 'mb-row-foot' },
              h('span', { className: 'mb-reset' }, t('credits.used', { used: fmtMoney(wallet.used), quota: fmtMoney(wallet.quota) }))),
          )
          : null,
      )
    }

    /** Per-tool breakdown chips for the tool-call window. */
    function ToolBreakdown({ details }) {
      return h('div', { className: 'mb-chip-row' },
        details.map(detail => {
          const usage = detail.usage === null || detail.usage === undefined ? '' : ` ×${fmtNumber(detail.usage)}`
          return h('span', {
            key: detail.code, className: 'mb-chip mb-mini',
            title: `${detail.code}: ${detail.usage === null ? '?' : detail.usage}`,
          }, `${detail.code}${usage}`)
        }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Composer-dock rings                                                 */
    /* ------------------------------------------------------------------ */

    /** Window ids shown as dock gauges, and their panel order. */
    const FIVE_HOUR_IDS = ['tokens-5h', 'credits-5h']
    const WEEK_IDS = ['tokens-week', 'credits-week']
    /** Dock data poll cadence; the Host caches provider answers for 30s. */
    const DOCK_POLL_MS = 60_000
    /**
     * 270° gauge arc, open at the bottom: deliberately NOT the context
     * meter's full circle, so the two readings never read as one. The dark
     * used arc shares the context ring's shadow tone, and the dash runs in
     * real arc-length units (no pathLength normalization) so the proportion
     * renders exactly on every engine.
     */
    const GAUGE_D = 'M4.111 11.889A5.5 5.5 0 1 1 11.889 11.889'
    const RING_RADIUS = 5.5
    const GAUGE_ARC_LEN = 2 * Math.PI * RING_RADIUS * 0.75

    /**
     * One usage gauge: the shaded arc spans the used percentage, the pale
     * track the remainder; the percentage text next to it carries the
     * threshold color instead.
     */
    function Gauge({ percent }) {
      const width = clampPct(percent)
      const dash = GAUGE_ARC_LEN * width / 100
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
        h('path', { d: GAUGE_D, className: 'mbd-ring-track' }),
        h('path', {
          d: GAUGE_D,
          className: 'mbd-gauge-used',
          strokeDasharray: `${dash} ${GAUGE_ARC_LEN - dash + 1}`,
        }),
      )
    }

    /** The session's current model selection: the recorded request, else the pending choice. */
    function sessionProviderId(useProjection) {
      if (typeof useProjection !== 'function') return null
      let selection = null
      try {
        selection = useProjection('modelSelection')
      } catch {
        return null
      }
      const current = selection?.lastUsed ?? selection?.next ?? null
      return typeof current?.provider === 'string' && current.provider !== '' ? current.provider.toLowerCase() : null
    }

    /** Whether one account answers for one provider-route id (exact token match). */
    function accountMatchesRoute(account, providerId) {
      if (providerId === null) return false
      const tokens = String(account.matchRoutes ?? '')
        .split(/[\s,，;；]+/)
        .filter(Boolean)
        .map(token => token.toLowerCase())
      return tokens.some(token => token === providerId)
    }

    /** One window row inside the dock panel: label, bar, used/limit, reset. */
    function DockWindowRow({ window: win, t, now }) {
      const pct = win.percentage ?? 0
      const label = t(WINDOW_LABEL_KEY[win.id] ?? 'window.other')
      const value = win.limit !== null && win.limit !== undefined
        ? `${fmtNumber(win.used)} / ${fmtNumber(win.limit)}`
        : `${Math.round(pct)}%`
      return h('div', { className: 'mbd-row' },
        h('div', { className: 'mbd-row-top' },
          h('span', { className: 'mbd-row-label' }, label),
          win.remaining !== null && win.remaining !== undefined
            ? h('span', { className: 'mbd-row-foot' }, t('remaining.label', { n: fmtNumber(win.remaining) }))
            : null,
          h('span', { className: 'mbd-row-value' }, value),
        ),
        h('div', { className: 'mbd-meter' },
          h('div', { className: `mbd-meter-fill ${meterClass(pct)}`, style: { width: `${clampPct(pct)}%` } }),
        ),
        h('div', { className: 'mbd-row-foot' }, resetPhrase(win.resetAt, now, t)),
      )
    }

    /** The click-open panel of one account: header plus every window row. */
    function DockPanel({ entry, t, now, pos, panelRef }) {
      const data = entry.data ?? {}
      const windows = [...(data.windows ?? [])]
        .sort((a, b) => (WINDOW_ORDER[a.id] ?? 99) - (WINDOW_ORDER[b.id] ?? 99))
      return h('div', {
        ref: panelRef,
        className: 'mbd-panel',
        role: 'dialog',
        'aria-label': t('dock.panel.aria', { name: entry.label }),
        style: { left: pos.left, bottom: pos.bottom },
      },
        h('div', { className: 'mbd-panel-head' },
          h('span', { className: 'mbd-panel-title' }, entry.label),
          data.plan ? h('span', { className: 'mbd-chip mb-brand' }, `${t('plan.label')} ${data.plan}`) : null,
          h('span', { className: 'mbd-chip' }, entry.providerLabel ?? entry.provider),
        ),
        h('div', { className: 'mbd-rule', 'aria-hidden': true }),
        h('div', { className: 'mbd-rows' },
          windows.map(win => h(DockWindowRow, { key: win.id, window: win, t, now })),
        ),
      )
    }

    /**
     * The dock entry: one gauge pair (5-hour, weekly) per GLM account that
     * answers for the CURRENT session's model route, beside the shipped stats
     * pills and the context meter. The session's durable `modelSelection`
     * projection names the route; accounts bind to routes through their
     * `matchRoutes` tokens, so an unrelated provider's session shows nothing.
     * Renders nothing without a matched account with usable plan data; the
     * click-open panel carries the full numbers so the gauges stay compact.
     */
    function DockBalance(props) {
      const { t, useProjection } = props
      const [entries, setEntries] = useState(null)
      const [openId, setOpenId] = useState(null)
      const [panelPos, setPanelPos] = useState(null)
      const [tick, setTick] = useState(() => Date.now())
      const triggerRefs = useRef(new Map())
      const panelRef = useRef(null)
      const aliveRef = useRef(true)
      // Subscribe to the projection so a route switch re-renders the match.
      const providerId = sessionProviderId(useProjection)

      useEffect(() => {
        aliveRef.current = true
        const clock = setInterval(() => setTick(Date.now()), TICK_MS)
        const load = () => {
          loadStatus(false).then(value => {
            if (!aliveRef.current) return
            setEntries((value?.accounts ?? [])
              .filter(entry => entry.provider === 'glm' && entry.enabled !== false && entry.state === 'ok'))
          }).catch(() => { /* the dock stays silent; the sidebar tab owns errors */ })
        }
        load()
        const poll = setInterval(load, DOCK_POLL_MS)
        return () => {
          aliveRef.current = false
          clearInterval(clock)
          clearInterval(poll)
        }
      }, [])

      useEffect(() => {
        if (openId === null) return undefined
        const onKeyDown = event => {
          if (event.key === 'Escape') setOpenId(null)
        }
        const onPointerDown = event => {
          const panel = panelRef.current
          if (panel !== null && panel.contains(event.target)) return
          for (const element of triggerRefs.current.values()) {
            if (element !== null && element.contains(event.target)) return
          }
          setOpenId(null)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown)
        }
      }, [openId])

      const togglePanel = entry => {
        if (openId === entry.id) {
          setOpenId(null)
          return
        }
        const element = triggerRefs.current.get(entry.id)
        if (element !== undefined && element !== null) {
          const rect = element.getBoundingClientRect()
          setPanelPos({
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 312)),
            bottom: window.innerHeight - rect.top + 8,
          })
        }
        setOpenId(entry.id)
      }

      const groups = (entries ?? [])
        .filter(entry => entry.provider === 'glm' && entry.enabled !== false && entry.state === 'ok')
        .filter(entry => accountMatchesRoute(entry, providerId))
        .filter(entry => {
          const windows = entry.data?.windows ?? []
          return windows.some(win => FIVE_HOUR_IDS.includes(win.id)) || windows.some(win => WEEK_IDS.includes(win.id))
        })
      if (groups.length === 0) return null
      const openEntry = openId === null ? null : groups.find(entry => entry.id === openId) ?? null

      return h(Fragment, null,
        h('style', { key: 'mbd-css' }, DOCK_CSS),
        h('div', { className: 'mbd-group', 'data-composer-stat': 'model-balance' },
          groups.map(entry => {
            const five = (entry.data.windows ?? []).find(win => FIVE_HOUR_IDS.includes(win.id)) ?? null
            const week = (entry.data.windows ?? []).find(win => WEEK_IDS.includes(win.id)) ?? null
            const open = openId === entry.id
            const aria = [
              five !== null ? t('dock.5h.aria', { percent: Math.round(five.percentage ?? 0), time: resetPhrase(five.resetAt, tick, t) }) : null,
              week !== null ? t('dock.week.aria', { percent: Math.round(week.percentage ?? 0), time: resetPhrase(week.resetAt, tick, t) }) : null,
            ].filter(Boolean).join(' · ')
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'mbd-trigger',
              title: entry.label,
              'aria-label': aria,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              ref: element => {
                if (element === null) triggerRefs.current.delete(entry.id)
                else triggerRefs.current.set(entry.id, element)
              },
              onClick: () => togglePanel(entry),
            },
              five !== null
                ? h(Fragment, { key: 'five' },
                  h(Gauge, { percent: five.percentage ?? 0 }),
                  h('span', { className: 'mbd-label' }, t('dock.5h.label')),
                  h('span', { className: `mbd-reading ${meterClass(five.percentage ?? 0)}` }, `${Math.round(five.percentage ?? 0)}%`),
                )
                : null,
              week !== null
                ? h(Fragment, { key: 'week' },
                  h(Gauge, { percent: week.percentage ?? 0 }),
                  h('span', { className: 'mbd-label' }, t('dock.week.label')),
                  h('span', { className: `mbd-reading ${meterClass(week.percentage ?? 0)}` }, `${Math.round(week.percentage ?? 0)}%`),
                )
                : null,
            )
          }),
        ),
        openEntry !== null && panelPos !== null
          ? createPortal(
            h(DockPanel, { entry: openEntry, t, now: tick, pos: panelPos, panelRef }),
            document.body,
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Account card                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * One provider account: header (provider chip, plan tier, key tail,
     * actions) plus the body that matches its status — meters and wallets
     * when ok, otherwise the error / missing-key / disabled notice.
     */
    function AccountCard({ entry, t, now, busyId, deletingId, onRefreshOne, onEdit, onDelete }) {
      const { state } = entry
      const data = state === 'ok' ? entry.data : null
      const isGlm = entry.provider === 'glm'
      const windows = data?.kind === 'plan' && Array.isArray(data.windows)
        ? [...data.windows].sort((a, b) => (WINDOW_ORDER[a.id] ?? 99) - (WINDOW_ORDER[b.id] ?? 99))
        : []
      const wallets = data?.kind === 'wallet' && Array.isArray(data.wallets) ? data.wallets : []
      return h('div', { className: `mb-card${entry.enabled === false || state === 'disabled' ? ' mb-dim' : ''}` },
        h('div', { className: 'mb-card-head' },
          h('span', { className: 'mb-chip mb-brand' }, entry.providerLabel ?? entry.provider),
          isGlm && data?.plan ? h('span', { className: 'mb-chip' }, `${t('plan.label')} ${data.plan}`) : null,
          h('span', { className: 'mb-card-title', title: entry.label }, entry.label),
          h('button', {
            type: 'button', className: 'mb-icon-btn', disabled: busyId === entry.id,
            title: t('action.refresh'), onClick: () => onRefreshOne(entry.id),
          }, busyId === entry.id ? '…' : '⟳'),
          h('button', {
            type: 'button', className: 'mb-icon-btn', title: t('action.edit'), onClick: () => onEdit(entry),
          }, '✎'),
          h('button', {
            type: 'button',
            className: `mb-icon-btn${deletingId === entry.id ? ' mb-danger' : ''}`,
            title: t('action.delete'), onClick: () => onDelete(entry.id),
          }, deletingId === entry.id ? t('delete.confirm') : '✕'),
        ),
        h('div', { className: 'mb-card-sub' },
          entry.state === 'ok' && entry.keyTail
            ? t('key.tail', { tail: entry.keyTail })
            : (entry.keySource === 'env' && entry.apiKeyEnv
              ? t('key.env', { name: entry.apiKeyEnv })
              : (entry.hasStoredKey ? t('key.tail', { tail: '…' }) : null)),
          entry.baseUrl && entry.baseUrl !== entry.defaultBase ? entry.baseUrl : null,
        ),
        state === 'ok' && data !== null
          ? h('div', { className: 'mb-rows' },
            windows.map(win => h(WindowRow, { key: win.id, window: win, t, now })),
            wallets.map((wallet, index) => h(WalletRow, { key: `${wallet.currency ?? 'w'}-${index}`, wallet, t })),
          )
          : null,
        state === 'error'
          ? h('div', { className: 'mb-state-row mb-row-error' },
            h('span', { className: 'mb-chip mb-state-error' }, t('state.error')),
            h('span', { className: 'mb-state-text' }, entry.error ?? ''),
          )
          : null,
        state === 'missing-key'
          ? h('div', { className: 'mb-state-row' },
            h('span', { className: 'mb-chip mb-state-warn' }, t('state.missingKey')),
            h('span', { className: 'mb-state-text' }, t('missingKey.hint')),
          )
          : null,
        state === 'disabled'
          ? h('div', { className: 'mb-state-row' },
            h('span', { className: 'mb-chip' }, t('state.disabled')),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Account dialog                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Add/edit dialog. The key input starts empty every time and is only
     * sent when the user typed one; the Host never returns the saved key.
     */
    function AccountDialog({ t, providers, account, onClose, onSaved }) {
      const editing = account !== null
      const [provider, setProvider] = useState(editing ? account.provider : (providers[0]?.id ?? 'glm'))
      const [label, setLabel] = useState(editing ? account.label : '')
      const [baseUrl, setBaseUrl] = useState(editing ? (account.baseUrl === account.defaultBase ? '' : (account.baseUrl ?? '')) : '')
      const [apiKey, setApiKey] = useState('')
      const [apiKeyEnv, setApiKeyEnv] = useState(editing ? (account.apiKeyEnv ?? '') : '')
      const [matchRoutes, setMatchRoutes] = useState(editing ? (account.matchRoutes ?? '') : '')
      const [enabled, setEnabled] = useState(editing ? account.enabled !== false : true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const current = useMemo(
        () => providers.find(candidate => candidate.id === provider) ?? providers[0] ?? null,
        [providers, provider],
      )

      const save = async () => {
        setBusy(true)
        setError(null)
        const body = { label: label.trim(), baseUrl: baseUrl.trim(), enabled, apiKeyEnv: apiKeyEnv.trim(), matchRoutes: matchRoutes.trim() }
        if (apiKey !== '') body.apiKey = apiKey.trim()
        try {
          const saved = editing
            ? await updateAccount(account.id, body)
            : await createAccount({ ...body, provider, apiKey: apiKey.trim() })
          onSaved(saved)
        } catch (caught) {
          setError(String(caught instanceof Error ? caught.message : caught))
          setBusy(false)
        }
      }

      return h('div', { className: 'mb-backdrop', onClick: event => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'mb-modal', role: 'dialog', 'aria-label': editing ? t('dialog.titleEdit') : t('dialog.titleAdd') },
          h('div', { className: 'mb-modal-title' }, editing ? t('dialog.titleEdit') : t('dialog.titleAdd')),
          h('div', { className: 'mb-modal-body' },
            h('div', { className: 'mb-field' },
              h('span', { className: 'mb-field-label' }, t('dialog.provider')),
              editing
                ? h('span', { className: 'mb-chip mb-brand', style: { alignSelf: 'flex-start' } }, account.providerLabel ?? account.provider)
                : h('select', { className: 'mb-select', value: provider, onChange: event => setProvider(event.target.value) },
                  providers.map(candidate => h('option', { key: candidate.id, value: candidate.id }, candidate.label))),
            ),
            h('div', { className: 'mb-field' },
              h('span', { className: 'mb-field-label' }, t('dialog.label')),
              h('input', {
                className: 'mb-input', value: label, maxLength: 80,
                placeholder: editing ? '' : t('dialog.labelPlaceholder'),
                onChange: event => setLabel(event.target.value),
              }),
            ),
            h('div', { className: 'mb-field' },
              h('span', { className: 'mb-field-label' }, t('dialog.baseUrl')),
              h('input', {
                className: 'mb-input', value: baseUrl, placeholder: current?.defaultBase ?? '',
                onChange: event => setBaseUrl(event.target.value),
              }),
              current?.baseUrlHint ? h('span', { className: 'mb-modal-hint' }, current.baseUrlHint) : null,
              h('span', { className: 'mb-modal-hint' }, t('dialog.baseUrlHint', { default: current?.defaultBase ?? '' })),
            ),
            h('div', { className: 'mb-field' },
              h('span', { className: 'mb-field-label' }, t('dialog.apiKey')),
              h('input', {
                className: 'mb-input', type: 'password', value: apiKey, autoComplete: 'off',
                onChange: event => setApiKey(event.target.value),
              }),
              current?.keyHint !== undefined && current?.keyHint !== ''
                ? h('span', { className: 'mb-modal-hint' }, current.keyHint)
                : null,
              h('span', { className: 'mb-modal-hint' }, editing ? t('dialog.apiKeyHintEdit') : t('dialog.apiKeyHintAdd')),
              h('span', { className: 'mb-field-label' }, t('dialog.apiKeyEnv')),
              h('input', {
                className: 'mb-input', value: apiKeyEnv, autoComplete: 'off', spellCheck: false,
                placeholder: 'ZAI_CODING_CN_API_KEY',
                onChange: event => setApiKeyEnv(event.target.value),
              }),
              h('span', { className: 'mb-modal-hint' }, t('dialog.apiKeyEnvHint')),
            ),
            h('div', { className: 'mb-field' },
              h('span', { className: 'mb-field-label' }, t('dialog.matchRoutes')),
              h('input', {
                className: 'mb-input', value: matchRoutes, autoComplete: 'off', spellCheck: false,
                placeholder: 'zai-coding-cn',
                onChange: event => setMatchRoutes(event.target.value),
              }),
              h('span', { className: 'mb-modal-hint' }, t('dialog.matchRoutesHint')),
            ),
            h('label', { className: 'mb-check-row' },
              h('input', { type: 'checkbox', checked: enabled, onChange: event => setEnabled(event.target.checked) }),
              t('dialog.enabled'),
            ),
          ),
          h('div', { className: 'mb-modal-foot' },
            h('span', { className: 'mb-modal-error' }, error ?? ''),
            h('button', { type: 'button', className: 'mb-button', onClick: onClose, disabled: busy }, t('dialog.cancel')),
            h('button', { type: 'button', className: 'mb-button mb-button-primary', onClick: save, disabled: busy },
              busy ? t('dialog.saving') : t('dialog.save')),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    function BalanceTab({ t }) {
      const [providers, setProviders] = useState([])
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [busyId, setBusyId] = useState(null)
      const [deletingId, setDeletingId] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [saveError, setSaveError] = useState(null)
      const [tick, setTick] = useState(() => Date.now())
      const aliveRef = useRef(true)
      const statusRef = useRef(null)

      useEffect(() => {
        aliveRef.current = true
        const clock = setInterval(() => setTick(Date.now()), TICK_MS)
        return () => {
          aliveRef.current = false
          clearInterval(clock)
        }
      }, [])

      const applyStatus = useCallback(value => {
        statusRef.current = value
        setStatus(value)
        setTick(Date.now())
      }, [])

      const refreshStatus = useCallback(async (force, quiet) => {
        if (!quiet) setBusy(true)
        try {
          const value = await loadStatus(force === true)
          if (aliveRef.current) {
            applyStatus(value)
            setError(null)
          }
        } catch (caught) {
          if (aliveRef.current) setError(String(caught instanceof Error ? caught.message : caught))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [applyStatus])

      useEffect(() => {
        let cancelled = false
        const initial = async () => {
          try {
            const [accountList, providerList] = await Promise.all([loadAccounts(), loadProviders()])
            if (cancelled) return
            setProviders(providerList.providers ?? [])
            if ((accountList.accounts ?? []).length === 0) {
              applyStatus({ checkedAt: null, accounts: [] })
            }
          } catch (caught) {
            if (!cancelled) setError(String(caught instanceof Error ? caught.message : caught))
          }
          void refreshStatus(false, false)
        }
        void initial()
        const poll = setInterval(() => void refreshStatus(false, true), POLL_MS)
        return () => {
          cancelled = true
          clearInterval(poll)
        }
      }, [applyStatus, refreshStatus])

      const onRefreshOne = useCallback(async id => {
        setBusyId(id)
        try {
          const value = await refreshOne(id)
          if (aliveRef.current && value !== null && typeof value === 'object') {
            const merged = { ...(statusRef.current ?? { checkedAt: null, accounts: [] }) }
            const list = [...(merged.accounts ?? [])]
            for (const entry of value.accounts ?? []) {
              const at = list.findIndex(candidate => candidate.id === entry.id)
              if (at >= 0) list[at] = entry
              else list.push(entry)
            }
            merged.accounts = list
            merged.checkedAt = value.checkedAt ?? merged.checkedAt
            applyStatus(merged)
            setError(null)
          }
        } catch (caught) {
          if (aliveRef.current) setError(String(caught instanceof Error ? caught.message : caught))
        } finally {
          if (aliveRef.current) setBusyId(null)
        }
      }, [applyStatus])

      const onDelete = useCallback(id => {
        if (deletingId !== id) {
          setDeletingId(id)
          return
        }
        setDeletingId(null)
        deleteAccount(id).then(() => {
          if (!aliveRef.current) return
          const merged = { ...(statusRef.current ?? { checkedAt: null, accounts: [] }) }
          merged.accounts = (merged.accounts ?? []).filter(entry => entry.id !== id)
          applyStatus(merged)
        }).catch(caught => {
          if (aliveRef.current) setSaveError(String(caught instanceof Error ? caught.message : caught))
        })
      }, [applyStatus, deletingId])

      const entries = status?.accounts ?? []
      const updated = status?.checkedAt != null && status.checkedAt !== ''
        ? t('header.updated', { time: relativeTime(status.checkedAt, tick, t) })
        : t('header.never')

      return h('div', { className: 'mb-panel' },
        h('style', { key: 'mb-css' }, CSS),
        h('div', { className: 'mb-head' },
          h('span', { className: 'mb-head-title' }, t('tab.title')),
          h('span', { className: 'mb-updated' }, updated),
          h('button', {
            type: 'button', className: 'mb-icon-btn', disabled: busy,
            title: t('action.refresh'), onClick: () => void refreshStatus(true, false),
          }, busy ? '…' : '⟳'),
          h('button', {
            type: 'button', className: 'mb-icon-btn', title: t('action.add'),
            onClick: () => { setSaveError(null); setDialog({ mode: 'add' }) },
          }, '+'),
        ),
        saveError !== null
          ? h('div', { className: 'mb-error' }, saveError,
            h('button', { type: 'button', onClick: () => setSaveError(null) }, t('action.retry')))
          : null,
        error !== null
          ? h('div', { className: 'mb-error' }, t('error.load', { message: error }),
            h('button', { type: 'button', onClick: () => void refreshStatus(true, false) }, t('action.retry')))
          : null,
        h('div', { className: 'mb-body' },
          entries.length === 0 && status !== null
            ? h('div', { className: 'mb-empty' },
              h('span', null, t('empty.title')),
              h('span', null, t('empty.body')),
              h('button', {
                type: 'button', className: 'mb-button mb-button-primary', onClick: () => { setSaveError(null); setDialog({ mode: 'add' }) },
              }, t('action.add')),
            )
            : entries.map(entry => h(AccountCard, {
              key: entry.id, entry, t, now: tick, busyId,
              deletingId, onRefreshOne,
              onEdit: candidate => { setSaveError(null); setDialog({ mode: 'edit', account: candidate }) },
              onDelete,
            })),
        ),
        dialog !== null
          ? h(AccountDialog, {
            t,
            providers,
            account: dialog.mode === 'edit' ? dialog.account : null,
            onClose: () => setDialog(null),
            onSaved: () => {
              setDialog(null)
              void refreshStatus(true, false)
            },
          })
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-balance: locale')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: `${PANEL_ID}:${KIND}`,
        kind: KIND,
        title: () => t('tab.title'),
        guide: [{
          id: 'open',
          order: 110,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
        }],
      }), 'model-balance: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: `${PANEL_ID}:${KIND}`,
          inject: sessionId => ({ sessionId, t }),
        },
        BalanceTab,
      )), 'model-balance: tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: `${PANEL_ID}:${KIND}` },
        function Title() { return t('tab.title') },
      )), 'model-balance: tab title')

      // Composer-dock gauge pair (5-hour, weekly) for the GLM account bound
      // to the current session's model route, beside the shipped stats pills
      // and the context meter; one entry, its own id, so the shipped dock
      // never needs to know about it.
      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'model-balance.windows', order: 2, locale: NS },
        DockBalance,
      )), 'model-balance: dock gauges')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply,
    }
  },
})
