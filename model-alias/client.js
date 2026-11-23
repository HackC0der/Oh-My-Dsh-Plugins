/**
 * Client half of the model-alias bundle.
 *
 * Adds a "模型别名 / Model aliases" page to the Settings panel. The built-in
 * Models page removes a standard vendor from its add flow once that vendor has
 * one configuration, so a second API key for the same vendor has nowhere to
 * go. This page is the dedicated place for those additional configurations:
 *
 * - The vendor select lists EVERY standard vendor of the pi-ai family at all
 *   times — configured ones included, marked with a dot — so the option never
 *   exhausts.
 * - Each entry carries an alias (the profile's `displayName`, which is what
 *   the composer model picker shows) and its own API key under the route's
 *   derived credential reference.
 * - A write declares a hand-declared route `llm-pi-ai.providers.<routeId>`
 *   with `displayName` (alias) + `api` + `baseURL` + a non-empty `models`
 *   list — exactly the profile shape a route outside the installed catalog
 *   requires — and stores the key through `credentials/set`. The new route
 *   then shows up on the built-in Models page (marked 自定义) and as its own
 *   provider group in the composer model picker.
 *
 * All reads and writes go through the ordinary wire contracts
 * (`remote.settings`, `remote.llm`, `remote.credentials`); this half owns no
 * Host service of its own. Edits land as minimal path ops so fields this form
 * does not show (retryPolicy, headers, …, possibly pinned via cordis.patch.yml)
 * survive untouched; removal unsets the route and its credential.
 */
window.__ModuleLoader__.load({
  id: '@local/model-alias',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /* ------------------------------------------------------------------ */
    /* Identity and constants                                              */
    /* ------------------------------------------------------------------ */

    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'modelAlias'
    /** settings.section entry id (also the settings.section.icon address). */
    const SECTION_ID = 'models-alias'
    /** Nav order: right after the built-in Models section (order 10). */
    const SECTION_ORDER = 12
    /** The settings namespace the alias profiles are written into. */
    const PI_NS = 'llm-pi-ai'
    /**
     * A route id usable as a settings key AND as the stem of a credential
     * name (same shape the built-in custom-provider card enforces).
     */
    const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
    /** Route ids this page refuses to declare: they belong to other adapter families. */
    const RESERVED_ROUTES = ['deepseek-official', 'deepseek-account']
    /** Protocols when the schema read is unavailable (kept in step with pi-ai's table). */
    const FALLBACK_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
    /** Gemini refuses to run without a key; the form mirrors the built-in rule. */
    const GEMINI = 'google-generative-ai'
    /** Per-vendor protocol guess for the prefill; everything else defaults to OpenAI-compatible. */
    const PROTOCOL_GUESS = {
      'anthropic': 'anthropic-messages',
      'google': 'google-generative-ai',
    }
    /** The probe route the built-in page uses to walk dict schemas without colliding. */
    const PROBE_ROUTE = '\u0000probe'

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copies; locale/*.json carries package meta)   */
    /* ------------------------------------------------------------------ */

    const en = {
      'nav': 'Model aliases',
      'title': 'Model aliases',
      'intro': 'One extra configuration per standard vendor: keep the vendor, add another API key, and tell the configurations apart by alias.',
      'loadFailed': 'Failed to load',
      'retry': 'Retry',
      'readOnly': 'Settings are read-only in this deployment; aliases cannot be added or changed.',
      'adapterAbsent': 'The pi-ai adapter (standard key vendors) is not mounted in this deployment.',
      'aliasEmpty': 'No aliases yet. Add one below to give a vendor a second key.',
      'add': 'Add alias',
      'addHint': 'Pick the vendor, name the configuration, store its key. The alias is what the model picker shows.',
      'vendor': 'Vendor',
      'vendorConfigured': 'configured',
      'vendorAlias': 'Alias',
      'aliasPlaceholder': 'e.g. OpenAI work',
      'routeId': 'Route ID',
      'routeIdHint': 'Lowercase letters/digits separated by hyphens. It addresses the profile, so it cannot change after creation.',
      'routeIdInvalid': 'Use lowercase letters and digits, separated by single hyphens; start with a letter.',
      'routeIdTaken': 'This route ID is already in use.',
      'baseUrl': 'Base URL',
      'baseUrlInvalid': 'Enter an http(s) endpoint.',
      'protocol': 'Protocol',
      'keyInput': 'API key',
      'keyPlaceholder': 'Paste the key',
      'keyPlaceholderRef': 'Paste the key (stored as {ref})',
      'keyRequired': 'This protocol needs an API key.',
      'keyBlank': 'The key is only whitespace.',
      'keyIllegalCharacters': 'The key must be printable ASCII without line breaks.',
      'keySaved': 'Key stored.',
      'keyKeepExisting': 'Leave empty to keep the stored key.',
      'models': 'Models',
      'modelsEmpty': 'No models yet: fetch the vendor list, or add model IDs by hand.',
      'fetchModels': 'Fetch models',
      'fetching': 'Fetching…',
      'fetchNeedsBaseUrl': 'Fix the base URL first.',
      'fetchFailed': 'Fetch failed',
      'fetched': 'Fetched {count} model(s); kept {kept} hand-added.',
      'addModel': 'Add model',
      'modelId': 'Model ID',
      'modelName': 'Display name',
      'contextWindow': 'Context window',
      'maxTokens': 'Max output',
      'modelNeedsId': 'Every row needs a model ID.',
      'modelDuplicate': 'Model "{id}" is listed more than once.',
      'modelBadNumber': 'Row {index}: capacities must be positive whole numbers.',
      'needsAlias': 'Name this configuration.',
      'needsModels': 'At least one model is required.',
      'create': 'Create',
      'creating': 'Creating…',
      'save': 'Apply',
      'saving': 'Applying…',
      'cancel': 'Cancel',
      'close': 'Close',
      'edit': 'Edit',
      'remove': 'Remove',
      'removeConfirm': 'Remove alias and key?',
      'removing': 'Removing…',
      'conflict': 'Settings changed elsewhere; this draft is stale. Reload and try again.',
      'saved': 'Saved.',
      'routeLabel': 'Route',
      'keyStateConfigured': 'Key stored',
      'keyStateMissing': 'Key missing',
      'protocolOpenAiCompletions': 'OpenAI-compatible (Chat Completions)',
      'protocolOpenAiResponses': 'OpenAI Responses',
      'protocolAnthropicMessages': 'Anthropic Messages',
      'protocolGemini': 'Google Gemini',
    }

    const zh = {
      'nav': '模型别名',
      'title': '模型别名',
      'intro': '给同一个标准厂商添加第二份配置：厂商照选、密钥各存，用别名区分不同配置。',
      'loadFailed': '加载失败',
      'retry': '重试',
      'readOnly': '当前部署的设置为只读，无法新增或修改别名。',
      'adapterAbsent': '本部署未挂载 pi-ai 适配器（标准密钥厂商），无法声明别名路由。',
      'aliasEmpty': '还没有别名。在下方为某个厂商添加第二个密钥。',
      'add': '添加别名',
      'addHint': '选择厂商、为配置命名并保存密钥。模型选择器中显示的就是这个别名。',
      'vendor': '厂商',
      'vendorConfigured': '已配置',
      'vendorAlias': '别名',
      'aliasPlaceholder': '例如：OpenAI 工作',
      'routeId': '路由 ID',
      'routeIdHint': '小写字母/数字，用连字符分隔。路由 ID 是配置的地址，创建后不可更改。',
      'routeIdInvalid': '只能用小写字母和数字，单连字符分隔，且以字母开头。',
      'routeIdTaken': '该路由 ID 已被占用。',
      'baseUrl': '接口地址',
      'baseUrlInvalid': '请填写 http(s) 接口地址。',
      'protocol': '接口协议',
      'keyInput': 'API Key',
      'keyPlaceholder': '粘贴密钥',
      'keyPlaceholderRef': '粘贴密钥（将存为 {ref}）',
      'keyRequired': '该协议必须提供 API Key。',
      'keyBlank': '密钥不能只有空白字符。',
      'keyIllegalCharacters': '密钥只能包含可打印 ASCII 字符，且不能换行。',
      'keySaved': '密钥已保存。',
      'keyKeepExisting': '留空表示保留已存密钥。',
      'models': '模型列表',
      'modelsEmpty': '还没有模型：可从厂商拉取列表，或手动填写模型 ID。',
      'fetchModels': '获取模型列表',
      'fetching': '获取中…',
      'fetchNeedsBaseUrl': '请先修正接口地址。',
      'fetchFailed': '获取失败',
      'fetched': '已获取 {count} 个模型，保留 {kept} 个手动条目。',
      'addModel': '添加模型',
      'modelId': '模型 ID',
      'modelName': '显示名',
      'contextWindow': '上下文窗口',
      'maxTokens': '最大输出',
      'modelNeedsId': '每一行都需要模型 ID。',
      'modelDuplicate': '模型 “{id}” 重复出现。',
      'modelBadNumber': '第 {index} 行：容量必须是正整数。',
      'needsAlias': '请为该配置命名。',
      'needsModels': '至少需要一个模型。',
      'create': '创建',
      'creating': '创建中…',
      'save': '应用',
      'saving': '应用中…',
      'cancel': '取消',
      'close': '关闭',
      'edit': '编辑',
      'remove': '删除',
      'removeConfirm': '确认删除该别名及其密钥？',
      'removing': '删除中…',
      'conflict': '设置已在别处被修改，当前草稿已过期。请重载后重试。',
      'saved': '已保存。',
      'routeLabel': '路由',
      'keyStateConfigured': '密钥已存',
      'keyStateMissing': '缺少密钥',
      'protocolOpenAiCompletions': 'OpenAI 兼容（Chat Completions）',
      'protocolOpenAiResponses': 'OpenAI Responses',
      'protocolAnthropicMessages': 'Anthropic Messages',
      'protocolGemini': 'Google Gemini',
    }

    /* ------------------------------------------------------------------ */
    /* Small shared helpers (kept in step with the built-in page)          */
    /* ------------------------------------------------------------------ */

    /** The derived credential reference for a route (built-in derivation rule). */
    function deriveKeyRef(route) {
      return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    }

    /** Twin of the built-in key charset check: printable ASCII, no spaces. */
    const LEGAL_API_KEY = /^[\x21-\x7E]+$/
    const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

    function isQuoted(value) {
      const first = value[0]
      if (first !== '"' && first !== '\'' && first !== '`') return false
      return value.length > 1 && value.endsWith(first)
    }

    /** Judge a typed key; an empty field is not a failure (means keep/none). */
    function apiKeyFailure(draft) {
      if (draft.length === 0) return undefined
      const value = draft.trim()
      if (value.length === 0) return 'keyBlank'
      if (ENV_LINE.test(value) || isQuoted(value)) return 'keyIllegalCharacters'
      if (!LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
      return undefined
    }

    function isHttpUrl(value) {
      try {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      } catch {
        return false
      }
    }

    function protocolNeedsKey(protocol) {
      return protocol === GEMINI
    }

    /** Picker text for one protocol identifier. */
    function protocolLabel(t, protocol) {
      const keys = {
        'openai-completions': 'protocolOpenAiCompletions',
        'openai-responses': 'protocolOpenAiResponses',
        'anthropic-messages': 'protocolAnthropicMessages',
        'google-generative-ai': 'protocolGemini',
      }
      const key = keys[protocol]
      return key === undefined ? protocol : t(key)
    }

    /** ASCII slug of free-form alias text, or '' when nothing survives. */
    function slugify(text) {
      const runs = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []
      return runs.join('-').slice(0, 24).replace(/-+$/, '')
    }

    /** First free `<stem>` / `<stem>-2` / `<stem>-3` … among the taken ids. */
    function freeRouteId(stem, taken) {
      if (!taken.has(stem)) return stem
      for (let n = 2; n < 100; n += 1) {
        const candidate = `${stem}-${n}`
        if (!taken.has(candidate)) return candidate
      }
      return `${stem}-${Date.now().toString(36)}`
    }

    /** Clean one model row into a profile models entry (absent fields omitted). */
    function cleanModelRow(row) {
      const next = { id: row.id }
      if (typeof row.name === 'string' && row.name.length > 0) next.name = row.name
      if (Number.isInteger(row.contextWindow) && row.contextWindow > 0) next.contextWindow = row.contextWindow
      if (Number.isInteger(row.maxTokens) && row.maxTokens > 0) next.maxTokens = row.maxTokens
      if (Array.isArray(row.input) && row.input.length > 0) next.input = [...row.input]
      return next
    }

    /** Validate drafted rows; returns a copy key or undefined when acceptable. */
    function modelsFailure(rows) {
      const seen = new Set()
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        const id = typeof row.id === 'string' ? row.id.trim() : ''
        if (id.length === 0) return { key: 'modelNeedsId' }
        if (seen.has(id)) return { key: 'modelDuplicate', id }
        seen.add(id)
        for (const field of ['contextWindow', 'maxTokens']) {
          const value = row[field]
          if (value === undefined || value === null || String(value).length === 0) continue
          const parsed = Number(value)
          if (!Number.isInteger(parsed) || parsed <= 0) return { key: 'modelBadNumber', index }
        }
      }
      return undefined
    }

    /** Normalize drafted rows into profile entries (numbers parsed). */
    function cleanRows(rows) {
      return rows.map((row) => {
        const next = { id: String(row.id).trim() }
        const name = typeof row.name === 'string' ? row.name.trim() : ''
        if (name.length > 0) next.name = name
        for (const field of ['contextWindow', 'maxTokens']) {
          const raw = row[field]
          if (raw === undefined || raw === null || String(raw).length === 0) continue
          const parsed = Number(raw)
          if (Number.isInteger(parsed) && parsed > 0) next[field] = parsed
        }
        if (Array.isArray(row.input) && row.input.length > 0) next.input = [...row.input]
        return next
      })
    }

    /**
     * Merge edited rows over the stored models list, preserving fields this
     * form does not manage (`reasoningEfforts`, `compat`, …) while removals
     * and cleared fields stay cleared. `storedModels` is the profile's stored
     * array (or undefined on a create).
     */
    function buildModelsCandidate(rows, storedModels) {
      const stored = new Map((Array.isArray(storedModels) ? storedModels : [])
        .filter(entry => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
        .map(entry => [entry.id, entry]))
      return cleanRows(rows).map((row) => {
        const previous = stored.get(row.id)
        if (previous === undefined) return row
        const merged = { ...previous }
        for (const field of ['id', 'name', 'contextWindow', 'maxTokens', 'input']) delete merged[field]
        return { ...merged, ...row }
      })
    }

    /* ------------------------------------------------------------------ */
    /* Wire operations (bound once in apply, used by the components)       */
    /* ------------------------------------------------------------------ */

    function createOps(ctx) {
      return {
        async load() {
          const [registered, declared, described] = await Promise.all([
            ctx.remote.llm.listProviders(),
            ctx.remote.llm.listConfigurableProviders(),
            ctx.remote.settings.describe(),
          ])
          if (!registered.ok) return { kind: 'error', message: registered.error.message }
          if (!declared.ok) return { kind: 'error', message: declared.error.message }
          if (!described.ok) return { kind: 'error', message: described.error.message }
          const view = described.value
          const ns = view.namespaces.find(row => row.ns === PI_NS)
          return { kind: 'ok', registered: registered.value, declared: declared.value, describe: view, ns }
        },
        async storeCredential(ref, value) {
          const response = await ctx.remote.credentials.set(ref, value)
          return response.ok ? undefined : response.error.message
        },
        async removeCredential(ref) {
          const response = await ctx.remote.credentials.unset(ref)
          return response.ok ? undefined : response.error.message
        },
        async writeSettings(ops, expectedRevision) {
          const response = await ctx.remote.settings.mutate(PI_NS, ops, expectedRevision)
          if (response.ok) return { kind: 'written', view: response.value }
          const { code, message } = response.error
          return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
        },
        async discoverModels(request) {
          const response = await ctx.remote.llm.discoverModels(PI_NS, request)
          return response.ok
            ? { kind: 'found', models: response.value }
            : { kind: 'refused', message: response.error.message }
        },
        async describeCredentials(refs) {
          if (refs.length === 0) return { kind: 'ok', credentials: {} }
          const credentials = {}
          // credentials.describe accepts at most 64 references per request.
          for (let index = 0; index < refs.length; index += 64) {
            const response = await ctx.remote.credentials.describe(refs.slice(index, index + 64))
            if (!response.ok) return { kind: 'error', message: response.error.message }
            Object.assign(credentials, response.value)
          }
          return { kind: 'ok', credentials }
        },
      }
    }

    /**
     * Schema callbacks over the settings shell's schema service, used only to
     * read the protocol union out of the pi-ai namespace the same way the
     * built-in page does, so the offered choices cannot drift from the
     * adapter. Every failure falls back to the known protocol table.
     */
    function createSchemaOps(ctx) {
      const service = ctx.get('settingsSchema')
      return {
        protocolsOf(nsView) {
          if (service === undefined || nsView === undefined) return FALLBACK_PROTOCOLS
          try {
            const root = service.rehydrate(nsView.schema)
            const node = service.nodeAtPath(root, ['providers', PROBE_ROUTE, 'api'])
            const list = node?.list
            if (node?.type !== 'union' || list === undefined) return FALLBACK_PROTOCOLS
            const values = list.map(entry => entry.value).filter(value => typeof value === 'string')
            return values.length > 0 ? values : FALLBACK_PROTOCOLS
          } catch {
            return FALLBACK_PROTOCOLS
          }
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Styles (inserted once per Client run)                               */
    /* ------------------------------------------------------------------ */

    const CSS = `
.ma-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}
.ma-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.ma-intro{margin:0;color:var(--dsw-alias-label-secondary)}
.ma-error{margin:0;color:var(--dsw-alias-state-error-primary)}
.ma-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.ma-notice{margin:0;color:var(--dsw-alias-state-warn-primary)}
.ma-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px}
.ma-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}
.ma-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.ma-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ma-rowName{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-rowMeta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-actions{display:flex;gap:6px;flex:0 0 auto}
.ma-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.ma-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.ma-btn:disabled{opacity:.5;cursor:not-allowed}
.ma-btnPrimary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.ma-btnDanger{color:var(--dsw-alias-state-error-primary)}
.ma-btnGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.ma-field{display:flex;flex-direction:column;gap:4px}
.ma-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ma-input{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font-size:13px;min-width:0}
.ma-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ma-input:disabled{opacity:.55}
.ma-select{appearance:auto}
.ma-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ma-gridWide{display:flex;flex-direction:column;gap:10px}
.ma-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.ma-dotOk{background:var(--dsw-alias-state-success-primary)}
.ma-dotMissing{background:var(--dsw-alias-state-warn-primary)}
.ma-dotIdle{background:var(--dsw-alias-state-idle-primary)}
.ma-tag{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap}
.ma-modelRow{display:grid;grid-template-columns:minmax(140px,2fr) minmax(90px,1.4fr) minmax(70px,1fr) minmax(70px,1fr) auto;gap:6px;align-items:center}
.ma-modelHead{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 2px}
.ma-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.ma-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ma-spacer{flex:1}
.ma-confirm{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;flex-wrap:wrap}
`

    /* ------------------------------------------------------------------ */
    /* Components                                                          */
    /* ------------------------------------------------------------------ */

    /** Settings navigation glyph for this section (fallback = shell gear). */
    function AliasIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 12, y: 18, width: 26, height: 12, rx: 5 }),
      h('rect', { x: 26, y: 36, width: 26, height: 12, rx: 5 }),
      h('path', { d: 'M26 24h-8M40 42h8' }))
    }

    /** One editable model row inside a models list. */
    function ModelRow(props) {
      const { row, index, disabled, onChange, onRemove, t } = props
      return h('div', { className: 'ma-modelRow' },
        h('input', {
          className: 'ma-input', type: 'text', value: row.id ?? '', disabled,
          placeholder: t('modelId'), 'aria-label': `${t('modelId')} ${index + 1}`,
          onChange: (event) => { onChange(index, { id: event.target.value }) },
        }),
        h('input', {
          className: 'ma-input', type: 'text', value: row.name ?? '', disabled,
          placeholder: t('modelName'), 'aria-label': `${t('modelName')} ${index + 1}`,
          onChange: (event) => { onChange(index, { name: event.target.value }) },
        }),
        h('input', {
          className: 'ma-input', type: 'text', inputMode: 'numeric',
          value: row.contextWindow ?? '', disabled,
          placeholder: t('contextWindow'), 'aria-label': `${t('contextWindow')} ${index + 1}`,
          onChange: (event) => { onChange(index, { contextWindow: event.target.value }) },
        }),
        h('input', {
          className: 'ma-input', type: 'text', inputMode: 'numeric',
          value: row.maxTokens ?? '', disabled,
          placeholder: t('maxTokens'), 'aria-label': `${t('maxTokens')} ${index + 1}`,
          onChange: (event) => { onChange(index, { maxTokens: event.target.value }) },
        }),
        h('button', {
          type: 'button', className: 'ma-btn ma-btnGhost', disabled,
          'aria-label': t('remove'), onClick: onRemove,
        }, '✕'))
    }

    /** The model rows editor shared by the create card and the row editor. */
    function ModelsEditor(props) {
      const { rows, setRows, disabled, probe, ops, t } = props
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)
      const [fetched, setFetched] = useState(undefined)

      const fetchModels = async () => {
        setBusy(true)
        setFailure(undefined)
        setFetched(undefined)
        try {
          const answer = await ops.discoverModels({
            baseURL: probe.baseURL,
            api: probe.api,
            ...(probe.apiKey?.length ? { apiKey: probe.apiKey } : {}),
          })
          if (answer.kind === 'refused') {
            setFailure(`${t('fetchFailed')}: ${answer.message}`)
            return
          }
          const discovered = answer.models.filter(model => typeof model.id === 'string' && model.id.length > 0)
          if (discovered.length === 0) {
            setFailure(`${t('fetchFailed')}: ${t('modelsEmpty')}`)
            return
          }
          const kept = rows.filter(row => !discovered.some(model => model.id === String(row.id ?? '').trim()))
          const adopted = discovered.map(model => ({
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            ...(model.inputModalities === undefined ? {} : { input: [...model.inputModalities] }),
          }))
          setRows([...kept, ...adopted])
          setFetched({ count: adopted.length, kept: kept.length })
        } finally {
          setBusy(false)
        }
      }

      const edit = (index, patch) => {
        setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row))
      }

      return h('div', { className: 'ma-field' },
        h('div', { className: 'ma-toolbar' },
          h('span', { className: 'ma-label' }, t('models')),
          h('span', { className: 'ma-spacer' }),
          h('button', {
            type: 'button', className: 'ma-btn', disabled: disabled || busy || !probe.fetchable,
            title: probe.fetchable ? undefined : t('fetchNeedsBaseUrl'),
            onClick: () => { void fetchModels() },
          }, busy ? t('fetching') : t('fetchModels')),
          h('button', {
            type: 'button', className: 'ma-btn', disabled,
            onClick: () => { setRows(current => [...current, { id: '' }]); setFetched(undefined) },
          }, t('addModel'))),
        rows.length === 0
          ? h('p', { className: 'ma-hint' }, t('modelsEmpty'))
          : h('div', null,
            h('div', { className: 'ma-modelRow ma-modelHead', 'aria-hidden': true },
              h('span', null, t('modelId')), h('span', null, t('modelName')),
              h('span', null, t('contextWindow')), h('span', null, t('maxTokens')), h('span')),
            h('div', { className: 'ma-list' }, rows.map((row, index) => h(ModelRow, {
              key: index, row, index, disabled, t,
              onChange: edit,
              onRemove: () => { setRows(current => current.filter((_row, at) => at !== index)) },
            })))),
        failure === undefined ? null : h('p', { className: 'ma-error' }, failure),
        fetched === undefined
          ? null
          : h('p', { className: 'ma-ok' }, t('fetched')
            .replace('{count}', () => String(fetched.count))
            .replace('{kept}', () => String(fetched.kept))))
    }

    /** The create card: vendor (always all), alias, route, endpoint, key, models. */
    function CreateCard(props) {
      const { vendors, taken, protocols, revision, writable, ops, schemaOps, t, onDone, onBusy } = props
      const [vendor, setVendor] = useState(vendors[0]?.id ?? '')
      const [alias, setAlias] = useState('')
      const [routeEdited, setRouteEdited] = useState(false)
      const [route, setRoute] = useState('')
      // The first vendor prefills the endpoint and protocol immediately, so
      // the card never shows a half-empty form for the default pick.
      const [baseURL, setBaseURL] = useState(vendors[0]?.defaultBaseURL ?? '')
      const [protocol, setProtocol] = useState(
        vendors[0] === undefined ? '' : (PROTOCOL_GUESS[vendors[0].id] ?? protocols[0] ?? ''),
      )
      const [keyDraft, setKeyDraft] = useState('')
      const [rows, setRows] = useState([])
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)
      const [openedAt, setOpenedAt] = useState(revision)

      useEffect(() => { onBusy(busy) }, [busy, onBusy])
      // A vendor pick prefills what the catalog reports and the protocol guess;
      // a manual edit of any prefill is never overwritten afterwards.
      const pickVendor = (id) => {
        setVendor(id)
        const entry = vendors.find(candidate => candidate.id === id)
        if (entry !== undefined) {
          setBaseURL(entry.defaultBaseURL ?? '')
          setProtocol(PROTOCOL_GUESS[id] ?? protocols[0] ?? '')
        }
      }
      useEffect(() => {
        if (vendor.length === 0 || routeEdited) return
        const slug = slugify(alias)
        const stem = slug.length > 0 ? `${vendor}-${slug}` : vendor
        setRoute(freeRouteId(stem, taken))
      }, [vendor, alias, routeEdited, taken])
      useEffect(() => { setOpenedAt(revision) }, [revision])

      const vendorEntry = vendors.find(candidate => candidate.id === vendor)
      const keyRef = route.length > 0 ? deriveKeyRef(route) : ''
      const normalizedBaseURL = baseURL.trim()
      const aliasOk = alias.trim().length > 0
      const routeOk = ROUTE_PATTERN.test(route) && !taken.has(route) && !RESERVED_ROUTES.includes(route)
      const baseUrlOk = isHttpUrl(normalizedBaseURL)
      const keyFailure = apiKeyFailure(keyDraft)
      const keyMissing = protocolNeedsKey(protocol) && keyDraft.trim().length === 0
      const modelsProblem = modelsFailure(rows)
      const keyText = keyDraft.trim()
      const ready = writable && aliasOk && routeOk && baseUrlOk && !keyMissing && keyFailure === undefined
        && rows.length > 0 && modelsProblem === undefined

      const probe = useMemo(() => ({
        baseURL: normalizedBaseURL,
        api: protocol,
        apiKey: keyText,
        fetchable: baseUrlOk && protocol.length > 0,
      }), [normalizedBaseURL, protocol, keyText, baseUrlOk])

      const create = async () => {
        setBusy(true)
        setFailure(undefined)
        try {
          const profile = {
            displayName: alias.trim(),
            api: protocol,
            baseURL: normalizedBaseURL,
            models: cleanRows(rows),
            // The profile names the derived reference only when a key is being
            // stored, matching the built-in cards: a keyless route keeps its
            // provider-native authentication path.
            ...(keyText.length > 0 ? { apiKeyEnv: keyRef } : {}),
          }
          const written = await ops.writeSettings(
            [{ op: 'set', path: ['providers', route], value: profile }],
            openedAt,
          )
          if (written.kind !== 'written') {
            setFailure(written.kind === 'conflict' ? t('conflict') : written.message)
            return
          }
          if (keyText.length > 0) {
            const stored = await ops.storeCredential(keyRef, keyText)
            if (stored !== undefined) { setFailure(stored); return }
          }
          onDone()
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'ma-card' },
        h('p', { className: 'ma-hint' }, t('addHint')),
        h('div', { className: 'ma-grid' },
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-vendor' }, t('vendor')),
            h('select', {
              id: 'ma-vendor', className: 'ma-input ma-select', value: vendor, disabled: busy,
              onChange: (event) => { pickVendor(event.target.value) },
            },
            vendors.map(entry => h('option', { key: entry.id, value: entry.id },
              entry.displayName + (entry.configured ? ` · ${t('vendorConfigured')}` : '')))),
            vendorEntry?.defaultBaseURL === undefined
              ? null
              : h('span', { className: 'ma-hint' }, vendorEntry.defaultBaseURL)),
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-alias' }, t('vendorAlias')),
            h('input', {
              id: 'ma-alias', className: 'ma-input', type: 'text', value: alias, disabled: busy,
              placeholder: t('aliasPlaceholder'),
              onChange: (event) => { setAlias(event.target.value) },
            }),
            aliasOk ? null : h('span', { className: 'ma-hint' }, t('needsAlias')))),
        h('div', { className: 'ma-grid' },
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-route' }, t('routeId')),
            h('input', {
              id: 'ma-route', className: 'ma-input', type: 'text', value: route, disabled: busy,
              spellCheck: false, onChange: (event) => { setRouteEdited(true); setRoute(event.target.value.trim()) },
            }),
            routeOk
              ? h('span', { className: 'ma-hint' }, t('routeIdHint'))
              : h('span', { className: 'ma-error' },
                route.length === 0
                  ? t('routeIdHint')
                  : taken.has(route) || RESERVED_ROUTES.includes(route) ? t('routeIdTaken') : t('routeIdInvalid'))),
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-protocol' }, t('protocol')),
            h('select', {
              id: 'ma-protocol', className: 'ma-input ma-select', value: protocol, disabled: busy,
              onChange: (event) => { setProtocol(event.target.value) },
            },
            protocols.map(choice => h('option', { key: choice, value: choice }, protocolLabel(t, choice)))))),
        h('div', { className: 'ma-grid' },
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-baseurl' }, t('baseUrl')),
            h('input', {
              id: 'ma-baseurl', className: 'ma-input', type: 'text', value: baseURL, disabled: busy,
              spellCheck: false,
              onChange: (event) => { setBaseURL(event.target.value) },
            }),
            baseUrlOk || baseURL.length === 0 ? null : h('span', { className: 'ma-error' }, t('baseUrlInvalid'))),
          h('div', { className: 'ma-field' },
            h('label', { className: 'ma-label', htmlFor: 'ma-key' }, t('keyInput')),
            h('input', {
              id: 'ma-key', className: 'ma-input', type: 'password', value: keyDraft, disabled: busy,
              autoComplete: 'off',
              placeholder: keyRef.length > 0
                ? t('keyPlaceholderRef').replace('{ref}', () => keyRef)
                : t('keyPlaceholder'),
              onChange: (event) => { setKeyDraft(event.target.value) },
            }),
            keyMissing
              ? h('span', { className: 'ma-error' }, t('keyRequired'))
              : keyFailure === 'keyBlank'
                ? h('span', { className: 'ma-error' }, t('keyBlank'))
                : keyFailure !== undefined
                  ? h('span', { className: 'ma-error' }, t('keyIllegalCharacters'))
                  : h('span', { className: 'ma-hint' }, t('keyKeepExisting')))),
        h(ModelsEditor, {
          rows, setRows, disabled: busy, probe, ops, t,
        }),
        modelsProblem === undefined
          ? null
          : h('p', { className: 'ma-error' }, t(modelsProblem.key)
            .replace('{id}', () => modelsProblem.id ?? '')
            .replace('{index}', () => String((modelsProblem.index ?? 0) + 1))),
        failure === undefined ? null : h('p', { className: 'ma-error' }, failure),
        h('div', { className: 'ma-toolbar' },
          h('span', { className: 'ma-spacer' }),
          h('button', {
            type: 'button', className: 'ma-btn ma-btnPrimary', disabled: !ready,
            onClick: () => { void create() },
          }, busy ? t('creating') : t('create'))))
    }

    /** One existing alias route with its inline editor and removal confirm. */
    function AliasRow(props) {
      const { route, profile, revision, protocols, writable, ops, t, onChanged, onBusy } = props
      const [open, setOpen] = useState(false)
      const [alias, setAlias] = useState(typeof profile.displayName === 'string' ? profile.displayName : '')
      const [baseURL, setBaseURL] = useState(typeof profile.baseURL === 'string' ? profile.baseURL : '')
      const [protocol, setProtocol] = useState(typeof profile.api === 'string' ? profile.api : (protocols[0] ?? ''))
      const [rows, setRows] = useState(() => Array.isArray(profile.models)
        ? profile.models.filter(entry => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
          .map(entry => ({ ...entry }))
        : [])
      const [keyDraft, setKeyDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(undefined)
      const [savedFlash, setSavedFlash] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [removing, setRemoving] = useState(false)

      useEffect(() => { onBusy(busy || removing) }, [busy, removing, onBusy])
      const keyRef = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
        ? profile.apiKeyEnv
        : deriveKeyRef(route)
      const normalizedBaseURL = baseURL.trim()
      const baseUrlOk = isHttpUrl(normalizedBaseURL)
      const keyFailure = apiKeyFailure(keyDraft)
      const keyText = keyDraft.trim()
      const modelsProblem = modelsFailure(rows)
      const storedModels = Array.isArray(profile.models) ? profile.models : []
      const modelsCandidate = buildModelsCandidate(rows, storedModels)
      const dirty = alias.trim() !== (typeof profile.displayName === 'string' ? profile.displayName : '')
        || normalizedBaseURL !== (typeof profile.baseURL === 'string' ? profile.baseURL : '')
        || protocol !== (typeof profile.api === 'string' ? profile.api : '')
        || keyText.length > 0
        || JSON.stringify(modelsCandidate) !== JSON.stringify(storedModels)
      const ready = writable && !busy && baseUrlOk && keyFailure === undefined
        && rows.length > 0 && modelsProblem === undefined && dirty

      const apply = async () => {
        setBusy(true)
        setFailure(undefined)
        try {
          const before = {
            displayName: typeof profile.displayName === 'string' ? profile.displayName : '',
            baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : '',
            api: typeof profile.api === 'string' ? profile.api : '',
          }
          const after = { displayName: alias.trim(), baseURL: normalizedBaseURL, api: protocol }
          const opsList = []
          for (const field of ['displayName', 'baseURL', 'api']) {
            if (after[field] === before[field]) continue
            if (after[field].length === 0) opsList.push({ op: 'unset', path: ['providers', route, field] })
            else opsList.push({ op: 'set', path: ['providers', route, field], value: after[field] })
          }
          if (JSON.stringify(modelsCandidate) !== JSON.stringify(storedModels)) {
            opsList.push({ op: 'set', path: ['providers', route, 'models'], value: modelsCandidate })
          }
          if (opsList.length > 0) {
            const written = await ops.writeSettings(opsList, revision)
            if (written.kind !== 'written') {
              setFailure(written.kind === 'conflict' ? t('conflict') : written.message)
              return
            }
          }
          if (keyText.length > 0) {
            const stored = await ops.storeCredential(keyRef, keyText)
            if (stored !== undefined) { setFailure(stored); return }
          }
          setKeyDraft('')
          setSavedFlash(true)
          onChanged()
        } finally {
          setBusy(false)
        }
      }

      const remove = async () => {
        setRemoving(true)
        setFailure(undefined)
        try {
          const removed = await ops.removeCredential(keyRef)
          if (removed !== undefined) { setFailure(removed); return }
          const written = await ops.writeSettings([{ op: 'unset', path: ['providers', route] }], revision)
          if (written.kind !== 'written') {
            setFailure(written.kind === 'conflict' ? t('conflict') : written.message)
            return
          }
          onChanged()
        } finally {
          setRemoving(false)
        }
      }

      const keyConfigured = props.keyConfigured === true
      return h('li', { className: 'ma-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: open ? 10 : 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', {
            className: `ma-dot ${keyConfigured ? 'ma-dotOk' : 'ma-dotMissing'}`, role: 'img',
            'aria-label': keyConfigured ? t('keyStateConfigured') : t('keyStateMissing'),
            title: keyConfigured ? t('keyStateConfigured') : t('keyStateMissing'),
          }),
          h('div', { className: 'ma-rowMain' },
            h('span', { className: 'ma-rowName' }, alias.length > 0 ? alias : route),
            h('span', { className: 'ma-rowMeta' },
              `${t('routeLabel')} ${route} · ${protocolLabel(t, protocol)}`,
              normalizedBaseURL.length > 0 ? ` · ${normalizedBaseURL}` : '')),
          h('div', { className: 'ma-actions' },
            h('button', {
              type: 'button', className: 'ma-btn', disabled: removing || !writable && !open,
              onClick: () => { setOpen(current => !current); setConfirming(false); setFailure(undefined) },
            }, t('edit')),
            confirming
              ? h('span', { className: 'ma-confirm' },
                t('removeConfirm'),
                h('button', {
                  type: 'button', className: 'ma-btn ma-btnDanger', disabled: removing,
                  onClick: () => { void remove() },
                }, removing ? t('removing') : t('remove')),
                h('button', {
                  type: 'button', className: 'ma-btn ma-btnGhost', disabled: removing,
                  onClick: () => { setConfirming(false) },
                }, t('cancel')))
              : h('button', {
                type: 'button', className: 'ma-btn ma-btnDanger', disabled: !writable || removing,
                onClick: () => { setConfirming(true) },
              }, t('remove')))),
        open
          ? h('div', { className: 'ma-gridWide', style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } },
            h('div', { className: 'ma-grid' },
              h('div', { className: 'ma-field' },
                h('label', { className: 'ma-label', htmlFor: `ma-alias-${route}` }, t('vendorAlias')),
                h('input', {
                  id: `ma-alias-${route}`, className: 'ma-input', type: 'text', value: alias,
                  disabled: busy, placeholder: route,
                  onChange: (event) => { setAlias(event.target.value); setSavedFlash(false) },
                })),
              h('div', { className: 'ma-field' },
                h('label', { className: 'ma-label', htmlFor: `ma-protocol-${route}` }, t('protocol')),
                h('select', {
                  id: `ma-protocol-${route}`, className: 'ma-input ma-select', value: protocol,
                  disabled: busy,
                  onChange: (event) => { setProtocol(event.target.value); setSavedFlash(false) },
                },
                protocols.map(choice => h('option', { key: choice, value: choice }, protocolLabel(t, choice)))))),
            h('div', { className: 'ma-grid' },
              h('div', { className: 'ma-field' },
                h('label', { className: 'ma-label', htmlFor: `ma-baseurl-${route}` }, t('baseUrl')),
                h('input', {
                  id: `ma-baseurl-${route}`, className: 'ma-input', type: 'text', value: baseURL,
                  disabled: busy, spellCheck: false,
                  onChange: (event) => { setBaseURL(event.target.value); setSavedFlash(false) },
                }),
                baseUrlOk || baseURL.length === 0 ? null : h('span', { className: 'ma-error' }, t('baseUrlInvalid'))),
              h('div', { className: 'ma-field' },
                h('label', { className: 'ma-label', htmlFor: `ma-key-${route}` }, t('keyInput')),
                h('input', {
                  id: `ma-key-${route}`, className: 'ma-input', type: 'password', value: keyDraft,
                  disabled: busy, autoComplete: 'off', placeholder: t('keyPlaceholderRef').replace('{ref}', () => keyRef),
                  onChange: (event) => { setKeyDraft(event.target.value); setSavedFlash(false) },
                }),
                keyFailure === 'keyBlank'
                  ? h('span', { className: 'ma-error' }, t('keyBlank'))
                  : keyFailure !== undefined
                    ? h('span', { className: 'ma-error' }, t('keyIllegalCharacters'))
                    : h('span', { className: 'ma-hint' }, t('keyKeepExisting')))),
            h(ModelsEditor, {
              rows, setRows, disabled: busy, t, ops,
              probe: {
                baseURL: normalizedBaseURL,
                api: protocol,
                // Interrogations with the stored key would need the secret
                // itself; only a freshly typed key can ride along.
                apiKey: keyText,
                fetchable: baseUrlOk && protocol.length > 0,
              },
            }),
            modelsProblem === undefined
              ? null
              : h('p', { className: 'ma-error' }, t(modelsProblem.key)
                .replace('{id}', () => modelsProblem.id ?? '')
                .replace('{index}', () => String((modelsProblem.index ?? 0) + 1))),
            failure === undefined ? null : h('p', { className: 'ma-error' }, failure),
            savedFlash ? h('p', { className: 'ma-ok' }, t('saved')) : null,
            h('div', { className: 'ma-toolbar' },
              h('span', { className: 'ma-spacer' }),
              h('button', {
                type: 'button', className: 'ma-btn ma-btnPrimary', disabled: !ready,
                onClick: () => { void apply() },
              }, busy ? t('saving') : t('save'))))
          : null)
    }

    /** The settings section: load, vendor list never exhausts, alias rows. */
    function AliasSection(props) {
      const { t, ops, schemaOps, setRefresh } = props
      const [state, setState] = useState({ status: 'loading' })
      const [addOpen, setAddOpen] = useState(false)
      const [addBusy, setAddBusy] = useState(false)
      const current = useRef(0)

      const load = useCallback(async () => {
        const generation = ++current.current
        const answer = await ops.load()
        if (generation !== current.current) return
        if (answer.kind === 'error') {
          setState({ status: 'error', message: answer.message })
          return
        }
        const { registered, declared, describe } = answer
        const ns = answer.ns
        const catalog = new Map(declared
          .filter(entry => entry.settingsNs === PI_NS && entry.declared === false)
          .map(entry => [entry.provider, entry]))
        const profiles = (ns !== undefined && ns.value !== null && typeof ns.value === 'object'
          ? ns.value.providers : undefined) ?? {}
        // Existing routes: everything already keyed under providers (catalog
        // profiles included) reserves its id; alias rows are the keys outside
        // the installed catalog.
        const taken = new Set([...catalog.keys(), ...Object.keys(profiles), ...RESERVED_ROUTES])
        const keyRefs = new Set()
        for (const [id, profile] of Object.entries(profiles)) {
          if (catalog.has(id)) continue
          const ref = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
            ? profile.apiKeyEnv
            : deriveKeyRef(id)
          keyRefs.add(ref)
        }
        for (const id of catalog.keys()) keyRefs.add(deriveKeyRef(id))
        const credentialsAnswer = await ops.describeCredentials([...keyRefs])
        if (generation !== current.current) return
        const credentials = credentialsAnswer.kind === 'ok' ? credentialsAnswer.credentials : {}
        const vendors = [...catalog.values()].map(entry => ({
          id: entry.provider,
          displayName: entry.displayName,
          defaultBaseURL: entry.defaultBaseURL,
          configured: entry.provider in profiles,
          keyConfigured: credentials[deriveKeyRef(entry.provider)]?.configured === true,
        })).toSorted((left, right) => left.displayName.localeCompare(right.displayName))
        const aliasRoutes = Object.keys(profiles)
          .filter(id => !catalog.has(id))
          .toSorted((left, right) => left.localeCompare(right))
          .map(id => ({
            route: id,
            profile: typeof profiles[id] === 'object' && profiles[id] !== null ? profiles[id] : {},
            revision: ns?.revision,
            keyConfigured: credentials[typeof profiles[id]?.apiKeyEnv === 'string' && profiles[id].apiKeyEnv.length > 0
              ? profiles[id].apiKeyEnv
              : deriveKeyRef(id)]?.configured === true,
          }))
        setState({
          status: 'ready',
          writable: describe.writable === true && ns !== undefined,
          vendors,
          aliasRoutes,
          taken,
          protocols: schemaOps.protocolsOf(ns),
          revision: ns?.revision,
          registered: new Set(registered.map(provider => provider.id)),
        })
      }, [ops, schemaOps])

      useEffect(() => {
        void load()
        setRefresh(() => { void load() })
        return () => { setRefresh(undefined) }
      }, [load, setRefresh])

      if (state.status === 'loading') {
        return h('div', { className: 'ma-section' },
          h('style', { key: 'ma-css' }, CSS),
          h('h2', { className: 'ma-title' }, t('title')),
          h('p', { className: 'ma-intro' }, t('intro')))
      }
      if (state.status === 'error') {
        return h('div', { className: 'ma-section' },
          h('style', { key: 'ma-css' }, CSS),
          h('h2', { className: 'ma-title' }, t('title')),
          h('p', { className: 'ma-error' }, `${t('loadFailed')}: ${state.message ?? ''}`),
          h('div', null,
            h('button', { type: 'button', className: 'ma-btn', onClick: () => { void load() } }, t('retry'))))
      }
      const changed = () => { void load() }
      return h('div', { className: 'ma-section' },
        h('style', { key: 'ma-css' }, CSS),
        h('h2', { className: 'ma-title' }, t('title')),
        h('p', { className: 'ma-intro' }, t('intro')),
        !state.writable ? h('p', { className: 'ma-notice' }, t('readOnly')) : null,
        state.vendors.length === 0
          ? h('p', { className: 'ma-notice' }, t('adapterAbsent'))
          : null,
        state.aliasRoutes.length === 0
          ? h('p', { className: 'ma-hint' }, t('aliasEmpty'))
          : h('ul', { className: 'ma-list' }, state.aliasRoutes.map(entry => h(AliasRow, {
            key: entry.route,
            route: entry.route,
            profile: entry.profile,
            revision: entry.revision,
            keyConfigured: entry.keyConfigured,
            protocols: state.protocols,
            writable: state.writable,
            ops,
            t,
            onChanged: changed,
            onBusy: setAddBusy,
          }))),
        state.vendors.length > 0
          ? (addOpen
            ? h('div', { className: 'ma-card' },
              h(CreateCard, {
                vendors: state.vendors,
                taken: state.taken,
                protocols: state.protocols,
                revision: state.revision,
                writable: state.writable,
                ops,
                schemaOps,
                t,
                onBusy: setAddBusy,
                onDone: () => { setAddOpen(false); changed() },
              }),
              h('div', { className: 'ma-toolbar' },
                h('button', {
                  type: 'button', className: 'ma-btn ma-btnGhost', disabled: addBusy,
                  onClick: () => { setAddOpen(false) },
                }, t('close'))))
            : h('div', { className: 'ma-toolbar' },
              h('button', {
                type: 'button',
                className: 'ma-btn ma-btnPrimary',
                disabled: !state.writable || addBusy || state.vendors.length === 0,
                onClick: () => { setAddOpen(true) },
              }, `＋ ${t('add')}`)))
          : null)
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'settingsSchema'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-alias: locale dictionaries')
        const ops = createOps(ctx)
        const schemaOps = createSchemaOps(ctx)
        // The mounted section registers its reload callback here; pushed
        // invalidations converge it without polling, exactly like the
        // built-in Models page.
        let refresh = undefined
        ctx.effect(() => {
          const subs = [
            ctx.remote.$on('settings/document-updated', () => refresh?.()),
            ctx.remote.$on('credentials/record-updated', () => refresh?.()),
            ctx.remote.$on('credentials/reference-updated', () => refresh?.()),
            ctx.remote.$on('llm/adapters-updated', () => refresh?.()),
            ctx.on('connection/reset', () => refresh?.()),
          ]
          return () => { for (const dispose of subs) dispose(); refresh = undefined }
        }, 'model-alias: pushed invalidations')
        const t = ctx.locale.bind(NS)
        const injected = () => ({
          t,
          ops,
          schemaOps,
          setRefresh: (callback) => { refresh = callback },
        })
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('nav'),
          inject: injected,
        }, AliasSection))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
          order: SECTION_ORDER,
        }, AliasIcon))
      },
    }
  },
})
