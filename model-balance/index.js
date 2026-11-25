/**
 * Host half of the model-balance bundle.
 *
 * Remaining balances and subscription quotas for the model providers this
 * profile pays for, normalized into one shape:
 *
 * - `glm` (GLM Coding Plan, api.z.ai or open.bigmodel.cn): the plan's
 *   5-hour rolling window and weekly window (usage percentage, remaining,
 *   reset timestamps) plus the tool-call window with its per-tool breakdown.
 *   The quota endpoint is the same one the provider consoles use; it is not
 *   part of the published API reference, so the normalizer keeps unknown
 *   window shapes visible instead of dropping them.
 * - `deepseek` (DeepSeek open platform): `/user/balance` wallet rows with
 *   granted and topped-up splits and the "sufficient for calls" flag.
 * - `openrouter`: `/api/v1/credits` total credits versus total usage.
 *
 * Accounts (provider, display name, optional base URL override, API key)
 * live in one atomically-written JSON file under ~/.dsh/model-balance with
 * 0600 permissions — never in the profile patch. A key can also be named
 * indirectly through `apiKeyEnv`: the variable is read from the Host process
 * environment at query time, which keeps secrets out of the data file for
 * setups that already carry them as environment variables (a stored key
 * wins over the env name). Keys never leave this half: the HTTP face and
 * the tool answer with a short key tail only, and the browser reaches
 * providers only through this half's same-origin plugin routes (the
 * provider APIs send no CORS headers, and the key must stay server-side).
 *
 * Agents read the same numbers through the `balance_query` tool; a short
 * result cache keeps panel polling (60s) and agent calls from hammering the
 * provider consoles. Requests go out with `Authorization: Bearer <key>`,
 * falling back to the bare key when the provider answers 401/403 — both
 * spellings occur across these consoles.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Required Host services: the web face, the tool registry, and composed plugin configs. */
export const inject = ['webServer', 'tools', 'configEditor']

/** Durable account state lives here: ~/.dsh/model-balance/accounts.json. */
const DATA_DIR = join(homedir(), '.dsh', 'model-balance')
const DATA_FILE = join(DATA_DIR, 'accounts.json')
/** Routes served under this path prefix on the GUI origin. */
const ROUTE_PREFIX = '/plugins/model-balance'
/** Fresh-result cache window; panel polling and agent calls share it. */
const CACHE_TTL_MS = 30_000
/** Failed results are cached briefly so a poll burst cannot hammer a console. */
const ERROR_TTL_MS = 15_000
/** One outbound provider request gives up after this long. */
const FETCH_TIMEOUT_MS = 12_000
/** Longest request body accepted on the plugin routes. */
const MAX_BODY_BYTES = 64 * 1024
/** Most accounts one store keeps. */
const MAX_ACCOUNTS = 32
/** Shape of an environment-variable name for `apiKeyEnv`. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Provider catalog: normalization strategy and console defaults per id. */
const PROVIDERS = {
  glm: {
    id: 'glm',
    label: 'GLM Coding Plan',
    defaultBase: 'https://api.z.ai',
    keyHint: 'https://z.ai/manage-apikey/apikey-list',
    baseUrlHint: 'Mainland consoles may use https://open.bigmodel.cn',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek Platform',
    defaultBase: 'https://api.deepseek.com',
    keyHint: 'https://platform.deepseek.com/api_keys',
    baseUrlHint: '',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBase: 'https://openrouter.ai',
    keyHint: 'https://openrouter.ai/settings/keys',
    baseUrlHint: '',
  },
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Coerce one value to a finite number, else null. */
function asFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Coerce one decimal-string money field to a finite number, else null. */
function asMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Pick the first human message out of one error payload, truncated. */
function firstMessage(body) {
  const parts = []
  if (body !== null && typeof body === 'object') {
    if (typeof body.msg === 'string') parts.push(body.msg)
    else if (typeof body.message === 'string') parts.push(body.message)
    if (body.error !== null && typeof body.error === 'object') {
      if (typeof body.error.message === 'string') parts.push(body.error.message)
      if (typeof body.error.code === 'string') parts.push(body.error.code)
    } else if (typeof body.error === 'string') {
      parts.push(body.error)
    }
  }
  const text = parts.join(' · ').trim().replaceAll('\n', ' ')
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

/** Normalize one configured base URL to `origin` form; '' selects the default. */
function normalizeBase(baseUrl, providerId) {
  const provider = PROVIDERS[providerId]
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (raw === '') return provider?.defaultBase ?? ''
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.origin
}

/** Stable JSON payload writer for one plugin route response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/** Read and length-check one JSON request body; resolves null on malformed input. */
function readJsonBody(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({})
        return
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** Random identifier with a readable prefix. */
function rid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------------------------------------------ */
/* Provider queries and normalization                                  */
/* ------------------------------------------------------------------ */

/** One GET against a provider console endpoint; resolves parsed JSON. */
async function httpGetJson(url, headers) {
  if (typeof fetch !== 'function') {
    throw new Error('this runtime exposes no fetch(); cannot query provider consoles')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
      redirect: 'error',
    })
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    if (!response.ok) {
      const detail = firstMessage(body)
      throw Object.assign(
        new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`),
        { status: response.status },
      )
    }
    if (body === null || typeof body !== 'object') {
      throw new Error('provider returned an empty or non-JSON body')
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One provider query with the account's resolved key. A stored key wins
 * over `apiKeyEnv`; the Bearer spelling goes first, and the bare key
 * spelling is retried once when the console answers 401/403, because both
 * spellings occur across the GLM consoles.
 */
async function fetchProviderJson(account, urlPath, resolveKeyFn) {
  const base = normalizeBase(account.baseUrl, account.provider)
  const url = `${base}${urlPath}`
  const key = await resolveKeyFn(account)
  const attempt = scheme => httpGetJson(url, {
    Authorization: scheme === 'bearer' ? `Bearer ${key}` : key,
  })
  try {
    return await attempt('bearer')
  } catch (error) {
    if ((error?.status === 401 || error?.status === 403) && key !== '') return attempt('raw')
    throw error
  }
}

/**
 * The account's key: the stored one wins; otherwise the `apiKeyEnv` name
 * resolves through the DSH credentials service (where console-managed keys
 * live as references), falling back to the Host process environment.
 */
async function resolveAccountKey(ctx, account) {
  // Auto-discovered accounts carry the key resolved from the DSH Models
  // configuration for this query only; it is never stored.
  if (account.auto === true && typeof account._key === 'string' && account._key !== '') return account._key
  if (typeof account.apiKey === 'string' && account.apiKey !== '') return account.apiKey
  const envName = typeof account.apiKeyEnv === 'string' ? account.apiKeyEnv : ''
  if (envName === '') return ''
  let credentials
  try {
    credentials = ctx?.get?.('credentials')
  } catch {
    credentials = undefined
  }
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(envName)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return hit.value.trim()
      }
    } catch {
      // A name outside the reference grammar reads as "not set" there; the
      // ambient environment decides instead.
    }
  }
  const value = process.env[envName]
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize one env-name input: '' clears, a bad identifier is rejected. */
function normalizeEnvName(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name === '') return ''
  return ENV_NAME_RE.test(name) ? name : null
}

/* ------------------------------------------------------------------ */
/* Automatic discovery of the DSH Models configuration                 */
/* ------------------------------------------------------------------ */

/**
 * Map one llm route id (the id half of an `llm-pi-ai/<route>` credential
 * record, or an environment variable name) to a balance provider.
 * @returns `{ provider, baseUrl? }`, or null when no console applies.
 */
function balanceProviderForRoute(routeId) {
  const id = String(routeId).toLowerCase()
  if (id.includes('deepseek')) return { provider: 'deepseek' }
  if (id.includes('openrouter')) return { provider: 'openrouter' }
  if (id.includes('glm') || id.includes('zai') || id.includes('bigmodel')) {
    const mainland = id.includes('cn') || id.includes('bigmodel') || id.includes('mainland')
    return { provider: 'glm', baseUrl: mainland ? 'https://open.bigmodel.cn' : 'https://api.z.ai' }
  }
  return null
}

/** Environment fallbacks, tried in order, when no configuration names a key. */
const ENV_KEY_FALLBACKS = [
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['glm', 'GLM_CODING_PLAN_API_KEY'],
  ['glm', 'ZAI_CODING_CN_API_KEY'],
  ['glm', 'ZAI_CODING_GLOBAL_API_KEY'],
  ['glm', 'ZAI_API_KEY'],
  ['glm', 'BIGMODEL_API_KEY'],
]

/** Resolve one credential reference (ref name) to its secret, '' when unset. */
async function resolveRef(credentials, ref) {
  if (ref === '' || credentials === undefined || credentials === null
    || typeof credentials.resolve !== 'function') return ''
  try {
    const hit = await credentials.resolve(ref)
    const value = hit === undefined || hit === null ? '' : hit.value
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/** One discovered route: its key, the route id a session projection reports, and its base. */
function routeEntry(provider, apiKey, routeId, baseUrl) {
  return { provider, apiKey, routeId, baseUrl: baseUrl ?? '' }
}

/**
 * Discover the model-provider routes DSH already has, without manual entry.
 * Every route becomes its OWN entry, so switching a session between two
 * routes (for example the `zai` alias and the official `glm-coding-plan`)
 * switches which account the composer dock matches. Sources:
 * 1. the `llm-pi-ai` entry's composed config — the settings section the web
 *    Models page and the model-alias plugin write (`providers.<route>` with
 *    `apiKeyEnv` + optional `baseURL`); route ids are exactly what a session's
 *    model-selection projection reports;
 * 2. `llm-pi-ai/<route>` api-key credential records;
 * 3. standard credential references and ambient environment variables, one
 *    per provider that none of the above furnished.
 * @returns array of `{ provider, apiKey, routeId, baseUrl }`
 */
async function discoverConfiguredKeys(ctx) {
  const found = []
  const seenRoutes = new Set()
  const push = (provider, apiKey, routeId, baseUrl) => {
    if (apiKey === '' || seenRoutes.has(routeId)) return
    seenRoutes.add(routeId)
    found.push(routeEntry(provider, apiKey, routeId, baseUrl))
  }
  const providersWithRoutes = () => new Set(found.map(entry => entry.provider))

  let credentials
  try {
    credentials = ctx?.get?.('credentials')
  } catch {
    credentials = undefined
  }

  // 1. The llm-pi-ai entry's composed config: route ids straight from the
  //    settings document (model-alias and the Models page both land here).
  let configEditor
  try {
    configEditor = ctx?.get?.('configEditor')
  } catch {
    configEditor = undefined
  }
  if (configEditor !== undefined && configEditor !== null && typeof configEditor.configuration === 'function') {
    try {
      const row = configEditor.configuration()
        .find(candidate => candidate?.entry?.options?.id === 'llm-pi-ai')
      if (row !== undefined) {
        const merged = { ...row.inherited, ...row.override }
        const providers = merged?.providers
        if (providers !== null && typeof providers === 'object') {
          for (const [routeId, profile] of Object.entries(providers)) {
            const target = balanceProviderForRoute(routeId)
            if (target === null || profile === null || typeof profile !== 'object') continue
            const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
            let apiKey = ref === '' ? '' : await resolveRef(credentials, ref)
            if (apiKey === '' && ref !== '' && typeof process.env[ref] === 'string') apiKey = process.env[ref].trim()
            if (apiKey === '') continue
            const baseUrl = typeof profile.baseURL === 'string' && profile.baseURL.trim() !== ''
              ? profile.baseURL.trim()
              : (target.baseUrl ?? '')
            push(target.provider, apiKey, routeId, baseUrl)
          }
        }
      }
    } catch {
      // Configuration reads never break the panel; later sources still apply.
    }
  }

  // 2. api-key records addressed `llm-pi-ai/<route>`.
  if (credentials !== undefined && credentials !== null
    && typeof credentials.listRecords === 'function' && typeof credentials.readRecord === 'function') {
    let entries = []
    try {
      entries = await credentials.listRecords()
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const key = typeof entry?.key === 'string' ? entry.key : ''
      const match = /^llm-pi-ai\/(.+)$/.exec(key)
      if (match === null) continue
      const routeId = match[1]
      const target = balanceProviderForRoute(routeId)
      if (target === null) continue
      try {
        const record = await credentials.readRecord(key)
        const apiKey = record !== undefined && record !== null && record.kind === 'api-key'
          && typeof record.key === 'string' ? record.key.trim() : ''
        if (apiKey === '') continue
        push(target.provider, apiKey, routeId, target.baseUrl)
      } catch {
        // A grant record is not an API key; skip it.
      }
    }
  }

  // 3. Standard credential references and ambient environment variables, one
  //    per provider that no configured route provided.
  const covered = providersWithRoutes()
  for (const [provider, refName] of ENV_KEY_FALLBACKS) {
    if (covered.has(provider)) continue
    let value = await resolveRef(credentials, refName)
    if (value === '') {
      const ambient = process.env[refName]
      if (typeof ambient === 'string') value = ambient.trim()
    }
    if (value !== '') push(provider, value, refName, provider === 'glm' ? 'https://api.z.ai' : '')
  }
  return found
}

/**
 * Ephemeral auto accounts: one per discovered route, minus providers whose
 * enabled manual account already answers for that route. The key rides
 * `_key` for this process only.
 */
async function autoAccounts(ctx, store) {
  const manual = [...store.accounts.values()].filter(account => account.enabled)
  const discovered = await discoverConfiguredKeys(ctx)
  const list = []
  for (const entry of discovered) {
    const manualCovers = manual.some(account => account.provider === entry.provider
      && (String(account.matchRoutes ?? '').split(/[\s,，;；]+/).filter(Boolean).includes(entry.routeId)
        || String(account.matchRoutes ?? '').trim() === ''))
    if (manualCovers) continue
    const catalog = PROVIDERS[entry.provider]
    const safeRoute = entry.routeId.replace(/[^A-Za-z0-9._-]/g, '-')
    list.push({
      id: `auto:${entry.provider}:${safeRoute}`,
      provider: entry.provider,
      label: `${catalog.label} (${entry.routeId})`,
      baseUrl: entry.baseUrl,
      apiKey: '',
      apiKeyEnv: '',
      matchRoutes: entry.routeId,
      enabled: true,
      auto: true,
      _key: entry.apiKey,
      createdAt: '',
    })
  }
  return list
}

/** Normalize the matched-route list: split on separators, collapse whitespace, keep order. */
function normalizeMatchRoutes(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  return value.split(/[\s,，;；]+/).filter(Boolean).join(' ').slice(0, 400)
}

/** One normalized quota window from one provider `limits[]` entry. */
function wireWindow(id, kind, limit) {
  const window = {
    id,
    kind,
    used: asFinite(limit.currentValue),
    limit: asFinite(limit.usage),
    remaining: asFinite(limit.remaining),
    percentage: asFinite(limit.percentage),
    resetAt: asFinite(limit.nextResetTime),
  }
  if (window.percentage === null && window.used !== null && window.limit !== null && window.limit > 0) {
    window.percentage = Math.round((window.used / window.limit) * 100)
  }
  return window
}

/** Normalize one quota-limit payload into plan + window list. */
function normalizeGlm(payload) {
  const data = payload !== null && typeof payload === 'object' ? payload.data : null
  if (data === null || typeof data !== 'object') throw new Error('unexpected quota response shape')
  const limits = Array.isArray(data.limits) ? data.limits : []
  const windows = []
  for (const limit of limits) {
    if (limit === null || typeof limit !== 'object') continue
    const type = typeof limit.type === 'string' ? limit.type : ''
    const unit = asFinite(limit.unit)
    const number = asFinite(limit.number)
    if (type === 'TOKENS_LIMIT' && unit === 3 && number === 5) {
      // The 5-hour rolling token window.
      windows.push(wireWindow('tokens-5h', 'tokens-5h', limit))
    } else if (type === 'TOKENS_LIMIT' && unit === 6) {
      // The weekly token window; legacy plans omit it.
      windows.push(wireWindow('tokens-week', 'tokens-week', limit))
    } else if (type === 'CREDIT_LIMIT' && unit === 3 && number === 5) {
      // Newer z.ai plans report the 5-hour window in credits instead of tokens.
      windows.push(wireWindow('credits-5h', 'credits-5h', limit))
    } else if (type === 'CREDIT_LIMIT' && unit === 6) {
      // Its weekly counterpart.
      windows.push(wireWindow('credits-week', 'credits-week', limit))
    } else if (type === 'TIME_LIMIT') {
      // The tool-call window, with its per-tool breakdown.
      const window = wireWindow('calls', 'calls', limit)
      const details = Array.isArray(limit.usageDetails)
        ? limit.usageDetails
          .filter(item => item !== null && typeof item === 'object' && typeof item.modelCode === 'string')
          .map(item => ({ code: item.modelCode, usage: asFinite(item.usage) }))
        : []
      if (details.length > 0) window.details = details
      windows.push(window)
    } else {
      // Unknown window shape: keep it visible rather than silently dropped.
      const suffix = unit === null ? '' : `-u${unit}${number === null ? '' : `n${number}`}`
      windows.push(wireWindow(`other-${type === '' ? 'unknown' : type}${suffix}`, 'other', limit))
    }
  }
  return { kind: 'plan', plan: typeof data.level === 'string' ? data.level : null, windows }
}

/** Normalize one DeepSeek balance payload into wallet rows. */
function normalizeDeepSeek(payload) {
  if (payload === null || typeof payload !== 'object') throw new Error('unexpected balance response shape')
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  const wallets = infos
    .filter(info => info !== null && typeof info === 'object')
    .map(info => ({
      currency: typeof info.currency === 'string' && info.currency !== '' ? info.currency : '?',
      balance: asMoney(info.total_balance),
      granted: asMoney(info.granted_balance),
      toppedUp: asMoney(info.topped_up_balance),
      available: payload.is_available !== false,
    }))
  if (wallets.length === 0) throw new Error('balance response carried no currency rows')
  return { kind: 'wallet', wallets }
}

/** Normalize one OpenRouter credits payload into wallet rows. */
function normalizeOpenRouter(payload) {
  const data = payload !== null && typeof payload === 'object' ? payload.data : null
  if (data === null || typeof data !== 'object') throw new Error('unexpected credits response shape')
  const quota = asMoney(data.total_credits)
  const used = asMoney(data.total_usage)
  const balance = quota !== null && used !== null ? quota - used : null
  return {
    kind: 'wallet',
    wallets: [{
      currency: 'USD',
      balance,
      granted: null,
      toppedUp: null,
      quota,
      used,
      available: balance === null || balance > 0,
    }],
  }
}

/** Dispatch one account query to its provider fetcher + normalizer. */
async function fetchAccountData(account, resolveKeyFn) {
  switch (account.provider) {
    case 'glm':
      return normalizeGlm(await fetchProviderJson(account, '/api/monitor/usage/quota/limit', resolveKeyFn))
    case 'deepseek':
      return normalizeDeepSeek(await fetchProviderJson(account, '/user/balance', resolveKeyFn))
    case 'openrouter':
      return normalizeOpenRouter(await fetchProviderJson(account, '/api/v1/credits', resolveKeyFn))
    default:
      throw new Error(`unknown provider "${account.provider}"`)
  }
}

/* ------------------------------------------------------------------ */
/* Account store                                                       */
/* ------------------------------------------------------------------ */

/**
 * Durable account records over one JSON file. Every mutation serializes
 * the whole (small) dataset to a temp file and renames it into place, so a
 * crash leaves either the previous or the new state. A corrupt file is
 * quarantined once and the store starts empty rather than refusing to boot.
 */
class AccountStore {
  constructor(logger) {
    this.logger = logger
    this.accounts = new Map()
  }

  /** Load the file once. */
  load() {
    let raw
    try {
      raw = readFileSync(DATA_FILE, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const quarantined = `${DATA_FILE}.corrupt-${Date.now()}`
      try {
        renameSync(DATA_FILE, quarantined)
      } catch { /* keep going with an empty store either way */ }
      this.logger.warn(`model-balance: account file was unreadable and moved to ${quarantined}: ${String(error)}`)
      return
    }
    const list = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    for (const record of list) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id === '') continue
      if (!(record.provider in PROVIDERS)) continue
      this.accounts.set(record.id, {
        id: record.id,
        provider: record.provider,
        label: typeof record.label === 'string' && record.label !== '' ? record.label : PROVIDERS[record.provider].label,
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
        apiKeyEnv: typeof record.apiKeyEnv === 'string' && ENV_NAME_RE.test(record.apiKeyEnv) ? record.apiKeyEnv : '',
        matchRoutes: typeof record.matchRoutes === 'string' ? record.matchRoutes : '',
        enabled: record.enabled !== false,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      })
    }
  }

  /** Serialize every account to the file, atomically, owner-only. */
  persist() {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ version: 1, accounts: [...this.accounts.values()] }, null, 2)
    const temp = `${DATA_FILE}.tmp-${process.pid}`
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, DATA_FILE)
  }

  /** One durable put. */
  put(account) {
    this.accounts.set(account.id, account)
    this.persist()
  }

  /** One durable delete; absent ids are no-ops. */
  delete(id) {
    if (!this.accounts.has(id)) return false
    this.accounts.delete(id)
    this.persist()
    return true
  }
}

/* ------------------------------------------------------------------ */
/* Plugin service                                                      */
/* ------------------------------------------------------------------ */

/**
 * One plugin instance: owns the account store, provider queries with their
 * short-lived result cache, the HTTP face for the Client half, and the
 * `balance_query` agent tool.
 */
class ModelBalance {
  constructor(ctx) {
    this.ctx = ctx
    this.store = new AccountStore(ctx.logger)
    /** accountId -> { at, payload }; payload is the redacted status value. */
    this.cache = new Map()
    /** accountId -> in-flight query promise, so bursts share one request. */
    this.inflight = new Map()
    this.stopping = false
  }

  /* ---------------- accounts ---------------- */

  /** Redacted wire record for one account: never the key itself. */
  accountWire(account) {
    const provider = PROVIDERS[account.provider]
    const stored = typeof account.apiKey === 'string' ? account.apiKey : ''
    return {
      id: account.id,
      provider: account.provider,
      providerLabel: provider.label,
      defaultBase: provider.defaultBase,
      keyHint: provider.keyHint,
      baseUrlHint: provider.baseUrlHint,
      label: account.label,
      baseUrl: normalizeBase(account.baseUrl, account.provider),
      hasStoredKey: stored !== '',
      keySource: account.auto === true ? 'dsh' : (stored !== '' ? 'stored' : (account.apiKeyEnv ? 'env' : '')),
      auto: account.auto === true,
      apiKeyEnv: account.apiKeyEnv ?? '',
      matchRoutes: account.matchRoutes ?? '',
      enabled: account.enabled,
    }
  }

  /** Snapshot array of redacted account records, including auto-discovered ones. */
  async accounts() {
    const autos = await autoAccounts(this.ctx, this.store)
    return [...this.store.accounts.values(), ...autos].map(account => this.accountWire(account))
  }

  /** Validate and create one account from one request body. */
  async createAccount(input) {
    if (input === null || typeof input !== 'object') throw new Error('body must be an object')
    const provider = typeof input.provider === 'string' ? input.provider : ''
    if (!(provider in PROVIDERS)) {
      throw new Error(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`)
    }
    if (this.store.accounts.size >= MAX_ACCOUNTS) {
      throw new Error(`at most ${MAX_ACCOUNTS} accounts are kept`)
    }
    const label = typeof input.label === 'string' && input.label.trim() !== ''
      ? input.label.trim().slice(0, 80)
      : PROVIDERS[provider].label
    if (normalizeBase(input.baseUrl, provider) === null) throw new Error('base URL must be an http(s) URL')
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    const apiKeyEnv = normalizeEnvName(input.apiKeyEnv)
    if (apiKeyEnv === null) throw new Error('API key environment variable must look like an identifier')
    const matchRoutes = normalizeMatchRoutes(input.matchRoutes)
    if (matchRoutes === null) throw new Error('matched routes must be a string')
    const account = {
      id: rid('acct'),
      provider,
      label,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
      apiKey,
      apiKeyEnv: apiKeyEnv ?? '',
      matchRoutes,
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
    }
    this.store.put(account)
    this.cache.delete(account.id)
    return this.accountWire(account)
  }

  /** Update one account; an absent field keeps its value, empty key clears. */
  async updateAccount(id, input) {
    const account = this.store.accounts.get(id)
    if (account === undefined) throw new Error('account not found')
    if (input === null || typeof input !== 'object') throw new Error('body must be an object')
    const next = { ...account }
    if (typeof input.label === 'string' && input.label.trim() !== '') next.label = input.label.trim().slice(0, 80)
    if (input.baseUrl !== undefined) {
      if (normalizeBase(input.baseUrl, next.provider) === null) throw new Error('base URL must be an http(s) URL')
      next.baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
    }
    if (input.apiKey !== undefined) {
      if (input.apiKey !== null && typeof input.apiKey !== 'string') throw new Error('apiKey must be a string or null')
      next.apiKey = input.apiKey === null ? '' : input.apiKey.trim()
    }
    if (input.apiKeyEnv !== undefined) {
      if (input.apiKeyEnv !== null && typeof input.apiKeyEnv !== 'string') throw new Error('apiKeyEnv must be a string or null')
      const envName = input.apiKeyEnv === null ? '' : normalizeEnvName(input.apiKeyEnv)
      if (envName === null) throw new Error('API key environment variable must look like an identifier')
      next.apiKeyEnv = envName
    }
    if (input.matchRoutes !== undefined) {
      if (input.matchRoutes !== null && typeof input.matchRoutes !== 'string') throw new Error('matchRoutes must be a string or null')
      const matchRoutes = input.matchRoutes === null ? '' : normalizeMatchRoutes(input.matchRoutes)
      if (matchRoutes === null) throw new Error('matched routes must be a string')
      next.matchRoutes = matchRoutes
    }
    if (input.enabled !== undefined) next.enabled = input.enabled !== false
    this.store.put(next)
    this.cache.delete(next.id)
    return this.accountWire(next)
  }

  /** Remove one account and its cached result. */
  async deleteAccount(id) {
    if (!this.store.delete(id)) throw new Error('account not found')
    this.cache.delete(id)
    this.inflight.delete(id)
  }

  /* ---------------- status queries ---------------- */

  /** The redacted status payload of one account, cached unless forced. */
  async snapshot(account, force) {
    if (!account.enabled) return { state: 'disabled' }
    const resolved = await resolveAccountKey(this.ctx, account)
    if (resolved === '') return { state: 'missing-key' }
    const cached = this.cache.get(account.id)
    const ttl = cached?.payload?.state === 'error' ? ERROR_TTL_MS : CACHE_TTL_MS
    if (force !== true && cached !== undefined && Date.now() - cached.at < ttl) return cached.payload
    const pending = this.inflight.get(account.id)
    if (pending !== undefined && force !== true) return pending
    const query = (async () => {
      let payload
      try {
        const data = await fetchAccountData(account, () => resolveAccountKey(this.ctx, account))
        payload = { state: 'ok', data, hasKey: true, keyTail: `…${resolved.slice(-4)}`, fetchedAt: new Date().toISOString() }
      } catch (error) {
        payload = { state: 'error', error: String(error instanceof Error ? error.message : error), fetchedAt: new Date().toISOString() }
      }
      this.cache.set(account.id, { at: Date.now(), payload })
      this.inflight.delete(account.id)
      return payload
    })()
    this.inflight.set(account.id, query)
    return query
  }

  /** Status payload for every account (panel shape: all, tool shape: enabled only). */
  async statusAll({ force, includeDisabled }) {
    const autos = await autoAccounts(this.ctx, this.store)
    const accounts = [
      ...[...this.store.accounts.values()].filter(account => includeDisabled || account.enabled),
      ...autos,
    ]
    const settled = await Promise.all(accounts.map(account => this.snapshot(account, force)))
    return {
      checkedAt: new Date().toISOString(),
      accounts: settled.map((payload, index) => ({
        ...this.accountWire(accounts[index]),
        ...payload,
      })),
    }
  }

  /* ---------------- agent tool ---------------- */

  registerTools() {
    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    const errorSchema = {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: { code: { type: 'string' }, message: { type: 'string' } },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    }
    const statusOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            checkedAt: { type: 'string' },
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  provider: { type: 'string' },
                  state: { type: 'string', enum: ['ok', 'error', 'disabled', 'missing-key'] },
                  error: { type: 'string' },
                  fetchedAt: { type: 'string' },
                  data: { type: 'object' },
                },
                required: ['id', 'label', 'provider', 'state'],
              },
            },
          },
          required: ['checkedAt', 'accounts'],
        },
        errorSchema,
      ],
    }

    this.ctx.tools.register({
      name: 'balance_query',
      description: 'Query remaining balances and subscription quotas of configured model-provider accounts: '
        + 'GLM Coding Plan 5-hour and weekly windows (usage percentage, remaining quota, reset time) plus the tool-call window, '
        + 'DeepSeek wallet balance, and OpenRouter credits. Omit account to fetch every enabled account; '
        + 'pass an account id or display name for one. Results are cached for a short window; refresh bypasses it.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Account id or display name; omit for all enabled accounts.' },
          refresh: { type: 'boolean', description: 'Query the provider again even when the cache is fresh.' },
        },
      },
      output: { schema: statusOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async args => {
        try {
          const status = await this.statusAll({ force: args?.refresh === true, includeDisabled: false })
          const wanted = typeof args?.account === 'string' ? args.account.trim().toLowerCase() : ''
          const picked = wanted === ''
            ? status.accounts
            : status.accounts.filter(entry => entry.id.toLowerCase() === wanted || entry.label.toLowerCase() === wanted)
          if (wanted !== '' && picked.length === 0) {
            return { error: { code: 'unknown-account', message: `no enabled account matches "${args.account}"` } }
          }
          return { checkedAt: status.checkedAt, accounts: picked }
        } catch (error) {
          return { error: { code: 'query-failed', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'balance: query' })
  }

  /* ---------------- HTTP face ---------------- */

  registerRoutes() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        this.handleHttp(req, res).catch(error => {
          this.ctx.logger.warn(`model-balance: route failure: ${String(error)}`)
          if (res.headersSent === false) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), 'model-balance: routes')
  }

  /** Dispatch one request inside the plugin route prefix. */
  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length)
    const query = url.searchParams

    if (req.method === 'GET' && path === '/providers') {
      sendJson(res, 200, {
        providers: Object.values(PROVIDERS).map(provider => ({
          id: provider.id,
          label: provider.label,
          defaultBase: provider.defaultBase,
          keyHint: provider.keyHint,
          baseUrlHint: provider.baseUrlHint,
        })),
      })
      return
    }

    if (req.method === 'GET' && path === '/accounts') {
      sendJson(res, 200, { accounts: await this.accounts() })
      return
    }

    if (req.method === 'POST' && path === '/accounts') {
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { error: 'malformed body' })
        return
      }
      try {
        sendJson(res, 200, { account: await this.createAccount(body) })
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    const idMatch = /^\/accounts\/([^/]+)$/.exec(path)
    if (idMatch !== null) {
      const id = decodeURIComponent(idMatch[1])
      if (req.method === 'PATCH' || req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) {
          sendJson(res, 400, { error: 'malformed body' })
          return
        }
        try {
          sendJson(res, 200, { account: await this.updateAccount(id, body) })
        } catch (error) {
          sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
        }
        return
      }
      if (req.method === 'DELETE') {
        try {
          await this.deleteAccount(id)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
        }
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (req.method === 'GET' && path === '/status') {
      const status = await this.statusAll({ force: query.get('refresh') === '1', includeDisabled: true })
      sendJson(res, 200, status)
      return
    }

    if (req.method === 'POST' && path === '/refresh') {
      const body = await readJsonBody(req)
      const only = typeof body?.id === 'string' ? body.id : null
      const status = await this.statusAll({ force: true, includeDisabled: true })
      sendJson(res, 200, only === null
        ? status
        : { checkedAt: status.checkedAt, accounts: status.accounts.filter(entry => entry.id === only) })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    this.store.load()
    this.registerRoutes()
    this.registerTools()
  }

  stop() {
    this.stopping = true
    this.inflight.clear()
    this.cache.clear()
  }
}

/**
 * Plugin entry: the effect's disposer undoes what the store and caches hold.
 */
export function apply(ctx) {
  const balance = new ModelBalance(ctx)
  ctx.effect(() => {
    balance.start()
    return () => balance.stop()
  }, 'model-balance: start')
}
