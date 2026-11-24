/**
 * Host half of the session-shared-blackboard bundle.
 *
 * Chat-room boards between the human user and several member sessions or
 * workspaces. A board names 1–8 members; each member is either one exact
 * session or a whole workspace, so every session that runs in that workspace
 * joins as that member. The user is a first-class participant of their own:
 * panel-composed messages carry the synthetic side "user" and render on the
 * right, while every member message (agent posts) renders on the left under
 * its member label. Messages are plugin-owned data in one atomically-written
 * JSON file — never session-log events, because a board is shared state that
 * outlives and crosses its member sessions. (The storage-domain KV facility
 * is the shipped home for such data, but a directory-linked local bundle
 * resolves its imports from the plugins directory, where the harness packages
 * are not reachable; a dependency-free store keeps this bundle loadable
 * everywhere.)
 *
 * Agents reach boards through four tools (blackboard_list / blackboard_read
 * / blackboard_post / blackboard_whoami) registered for every agent; per-agent
 * guidance is a system-prompt section on `agent.ctx` that renders live
 * membership and unread counts at each assembly. Posting never wakes a peer
 * agent: the section is the lazy notification surface, so an agent notices
 * new messages at its next natural turn.
 *
 * Membership tracks the workspace lifecycle: a session created inside a
 * member workspace joins every board of that workspace automatically, and a
 * session that is archived (the registry-global archive set) or leaves the
 * host (agent disposal) is recorded in a durable roster + activity log and
 * cut off from communication — it can no longer read, post, edit, or be
 * woken, and other members see it flagged as archived/left. Every session
 * also gets an identity card (its own prompt section plus the
 * `blackboard_whoami` tool) stating its session id, display name, owning
 * workspace, lifecycle status, and its member label on each board.
 *
 * The Client half (the shared board panel) talks to this half over
 * same-origin plugin routes on the web server: JSON for reads and writes and
 * one SSE stream fed by the store's change listeners. Generated typert
 * Remote namespaces are mounted only for shipped packages, so plain HTTP is
 * the stable channel a local bundle can rely on.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/** Required Host services: the web face and the registries the tools read. */
export const inject = ['webServer', 'workspaceRegistry', 'tools', 'systemPrompt', 'sessions', 'agents']

/** Durable state lives here: ~/.dsh/session-blackboard/data.json. */
const DATA_DIR = join(homedir(), '.dsh', 'session-blackboard')
const DATA_FILE = join(DATA_DIR, 'data.json')
/** Longest message text accepted from any writer. */
const MAX_MESSAGE_CHARS = 8000
/** Longest request body accepted on the plugin routes. */
const MAX_BODY_BYTES = 64 * 1024
/** SSE keep-alive cadence. */
const HEARTBEAT_MS = 25_000
/** Longest message excerpt carried in prompts and board summaries. */
const EXCERPT_CHARS = 120
/** Where the guidance section sits: after TOOL_SCHEDULE (2500), before TOOL_WORKFLOW (2600). */
const PROMPT_ORDER = 2550
/** Routes served under this path prefix on the GUI origin. */
const ROUTE_PREFIX = '/plugins/session-blackboard'
/** Synthetic side of the human participant; never a member key (members are s1..s8). */
const USER_SIDE = 'user'
/** Most members one board accepts. */
const MAX_MEMBERS = 8
/** Most lifecycle events kept in the durable activity log. */
const MAX_ACTIVITY = 400
/** Session lifecycle statuses shared by the roster, prompts, and wire shapes. */
const SESSION_ACTIVE = 'active'
const SESSION_ARCHIVED = 'archived'
const SESSION_DEPARTED = 'departed'
/** Lifecycle event types recorded in the activity log. */
const ACTIVITY_JOINED = 'joined'
const ACTIVITY_RETURNED = 'returned'
const ACTIVITY_ARCHIVED = 'archived'
const ACTIVITY_UNARCHIVED = 'unarchived'
const ACTIVITY_LEFT = 'left'
/** Longest one document edit lease runs before auto-release (agent crashed mid-edit). */
const DOC_LEASE_MS = 5 * 60_000
/** Default and maximum queue wait for `docboard_begin_edit`. */
const DOC_QUEUE_WAIT_DEFAULT_MS = 120_000
const DOC_QUEUE_WAIT_MAX_MS = 300_000
/** Longest one shared document's content may be. */
const MAX_DOC_CHARS = 200_000
/** Tokens that mention every member at once (checked with @ and fullwidth ＠). */
const MENTION_ALL_TOKENS = ['all', 'everyone', '全体', '所有人']
/** Characters that may follow a mention label and still end it. */
const MENTION_BOUNDARY = /[\s,.!?;:、，。！？；：…~@#^&*()[\]{}<>《》【】「」""'']$/u

/** Whether one mention label ends cleanly at this position in the text. */
function mentionEndsCleanly(text, nextIndex) {
  if (nextIndex >= text.length) return true
  return MENTION_BOUNDARY.test(text[nextIndex])
}

/** Whether the text contains `@label` (or fullwidth `＠label`) as a whole mention. */
function textMentionsLabel(text, label) {
  if (label === '') return false
  for (const prefix of ['@', '＠']) {
    const needle = `${prefix}${label}`
    let at = text.indexOf(needle)
    while (at !== -1) {
      if (mentionEndsCleanly(text, at + needle.length)) return true
      at = text.indexOf(needle, at + 1)
    }
  }
  return false
}

/**
 * Collect the mentions one message carries: the member side keys whose labels
 * appear as `@label`, plus whether an everyone-token (`@all`, …) fired.
 * Longer labels match first so "AB" is not eaten by a side labeled "A".
 */
function parseMentions(board, text) {
  const sides = []
  const ordered = [...board.sides].sort((a, b) => b.label.length - a.label.length)
  for (const side of ordered) {
    if (textMentionsLabel(text, side.label)) sides.push(side.key)
  }
  const all = MENTION_ALL_TOKENS.some(token => textMentionsLabel(text, token))
  return { sides, all }
}

/** Build the frozen relay UserMessage that wakes one mentioned agent. */
function mentionMessage(board, message, side, senderLabel) {
  const text = `【Shared blackboard @mention】${senderLabel} mentioned you (${side.label}) on board "${board.title}": "${excerpt(message.text)}". `
    + `Read the full conversation with blackboard_read (boardId: ${board.id}).`
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'session-blackboard', form: 'relay' }),
  })
}
/** Default member labels when the creator gives none: M1..M8. */
const DEFAULT_MEMBER_LABELS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
/** Messages blackboard_read returns at most in one call. */
const READ_PAGE = 50

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
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/** Excerpt one message for summaries and prompts. */
function excerpt(text) {
  const flat = text.replaceAll('\n', ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`
}

/** Coerce one loaded string field with a fallback. */
function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Durable board state: three plain maps over one JSON file. Every mutation
 * serializes the whole (small) dataset to a temp file and renames it into
 * place, so a crash leaves either the previous or the new state, never a
 * partial file. A corrupt file is moved aside once and reported; the store
 * then starts empty rather than refusing to boot.
 */
class BoardStore {
  /** @param {(change: { table: string, key: string, operation: 'put' | 'deleted' }) => void} notify */
  constructor(logger, notify) {
    this.logger = logger
    this.notify = notify
    this.boards = new Map()
    this.messages = new Map()
    this.cursors = new Map()
    /** Shared documents (the literal blackboards): content + version. */
    this.docs = new Map()
    /** Session lifecycle records, keyed by sessionId: last known status. */
    this.roster = new Map()
    /** Durable lifecycle event log, keyed by event id, ordered by seq. */
    this.activity = new Map()
  }

  /** Load the file once; a malformed file is quarantined with a suffix. */
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
      this.logger.warn(`session-blackboard: data file was unreadable and moved to ${quarantined}: ${String(error)}`)
      return
    }
    const adopt = (table, map, guard, migrate) => {
      const list = parsed?.[table]
      if (!Array.isArray(list)) return
      for (const record of list) {
        if (record !== null && typeof record === 'object' && guard(record)) {
          map.set(record.id ?? `${record.boardId}::${record.sessionId}`, migrate?.(record) ?? record)
        }
      }
    }
    adopt('boards', this.boards, record => typeof record.id === 'string' && Array.isArray(record.sides))
    // v1 boards let the user speak as a member side; the chat-room model gives
    // the user their own identity, so old user messages fold onto `user`.
    adopt('messages', this.messages, record => typeof record.id === 'string' && typeof record.boardId === 'string',
      record => (record.authorKind === 'user' && record.sideKey !== USER_SIDE
        ? { ...record, sideKey: USER_SIDE }
        : record))
    adopt('cursors', this.cursors, record => typeof record.boardId === 'string' && typeof record.sessionId === 'string')
    adopt('docs', this.docs, record => typeof record.id === 'string' && Array.isArray(record.sides)
      && typeof record.content === 'string' && Number.isInteger(record.version))
    adopt('roster', this.roster, record => typeof record.id === 'string' && typeof record.sessionId === 'string'
      && typeof record.status === 'string')
    adopt('activity', this.activity, record => typeof record.id === 'string'
      && typeof record.sessionId === 'string' && typeof record.type === 'string' && Number.isInteger(record.seq))
  }

  /** Serialize every table to the file, atomically. */
  persist() {
    mkdirSync(DATA_DIR, { recursive: true })
    const payload = JSON.stringify({
      version: 1,
      boards: [...this.boards.values()],
      messages: [...this.messages.values()],
      cursors: [...this.cursors.values()],
      docs: [...this.docs.values()],
      roster: [...this.roster.values()],
      activity: [...this.activity.values()],
    })
    const temp = `${DATA_FILE}.tmp-${process.pid}`
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, DATA_FILE)
  }

  /** One durable put: mutate, persist, then notify watchers. */
  put(table, map, key, record) {
    map.set(key, record)
    this.persist()
    this.notify({ table, key, operation: 'put' })
  }

  /** One durable delete; absent keys are no-ops. */
  delete(table, map, key) {
    if (!map.has(key)) return
    map.delete(key)
    this.persist()
    this.notify({ table, key, operation: 'deleted' })
  }
}

/**
 * One plugin instance: owns the store, membership resolution, tools,
 * per-agent prompt sections, and the HTTP face.
 */
class Blackboards {
  constructor(ctx) {
    this.ctx = ctx
    /** Change listeners: the SSE stream and nothing else today. */
    this.listeners = new Set()
    this.store = new BoardStore(ctx.logger, change => {
      for (const listener of [...this.listeners]) {
        try { listener(change) } catch { /* one consumer cannot break the others */ }
      }
    })
    /** sessionId -> workspaceId reverse map with a short TTL. */
    this.workspaceIndex = { at: 0, map: new Map() }
    /** Per-board promise chains that serialize seq allocation and writes. */
    this.boardChains = new Map()
    /** Per-agent prompt-section disposers, so plugin unload removes them too. */
    this.sectionStops = new Map()
    /**
     * Per-document edit queues, in memory only: `{ holder, queue }` where
     * holder/queue entries carry `{ owner, token, at, expiresAt?, resolve? }`.
     * A host restart empties them; an abandoned lease expires by timeout.
     */
    this.docLocks = new Map()
    /** Set when stop() ran before start() finished. */
    this.stopping = false
  }

  /* ---------------------------------------------------------------- */
  /* Lookup helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** The workspace a session currently belongs to, or undefined. */
  workspaceOf(sessionId) {
    const now = Date.now()
    if (now - this.workspaceIndex.at > 5000) {
      const map = new Map()
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        for (const id of workspace.sessionIds) map.set(id, workspace.id)
      }
      this.workspaceIndex = { at: now, map }
    }
    return this.workspaceIndex.map.get(sessionId)
  }

  /** Drop the cached session→workspace index (membership may have just changed). */
  invalidateWorkspaceIndex() {
    this.workspaceIndex = { at: 0, map: new Map() }
  }

  /** Whether one top-level session is live in this host right now. */
  sessionLive(sessionId) {
    const session = this.ctx.sessions.get(sessionId)
    return session !== undefined && session.header.origin !== 'subagent'
  }

  /** Whether the host's registry-global archive set currently holds the session. */
  sessionArchived(sessionId) {
    try {
      return this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
    } catch {
      return false
    }
  }

  /** Derived lifecycle status: live + unarchived beats any stale roster row. */
  sessionStatus(sessionId) {
    if (!this.sessionLive(sessionId)) return SESSION_DEPARTED
    if (this.sessionArchived(sessionId)) return SESSION_ARCHIVED
    return SESSION_ACTIVE
  }

  /**
   * Whether the session is allowed to communicate: live, unarchived, and
   * top-level. Archived or departed members are cut off from reads, posts,
   * edits, and mention wakes even when a board still names them.
   */
  communicable(sessionId) {
    return this.sessionStatus(sessionId) === SESSION_ACTIVE
  }

  /**
   * Whether any board or document names this session — by exact id, or via a
   * workspace member covering it — ignoring its current lifecycle status
   * (unlike boardsOf/docsOf, which exclude archived and departed sessions).
   */
  coversSession(sessionId) {
    const workspaceId = this.workspaceOf(sessionId)
    for (const board of this.boards()) {
      if (board.sides.some(side => side.ref === sessionId
        || (side.kind === 'workspace' && side.ref === workspaceId))) return true
    }
    for (const doc of this.docs()) {
      if (doc.sides.some(side => side.ref === sessionId
        || (side.kind === 'workspace' && side.ref === workspaceId))) return true
    }
    return false
  }

  /** All boards whose sides cover the session (exact id or owning workspace). */
  boardsOf(sessionId) {
    if (!this.communicable(sessionId)) return []
    const workspaceId = this.workspaceOf(sessionId)
    const result = []
    for (const board of this.boards()) {
      const side = board.sides.find(candidate => candidate.ref === sessionId
        || (candidate.kind === 'workspace' && candidate.ref === workspaceId))
      if (side !== undefined) result.push({ board, side })
    }
    return result
  }

  /** Snapshot array of every board record. */
  boards() {
    return [...this.store.boards.values()]
  }

  /** One board by id. */
  board(id) {
    return this.store.boards.get(id)
  }

  /** Messages of one board in seq order. */
  messagesOf(boardId) {
    const list = []
    for (const message of this.store.messages.values()) {
      if (message.boardId === boardId) list.push(message)
    }
    list.sort((a, b) => a.seq - b.seq)
    return list
  }

  /** Highest allocated seq of one board (0 when empty). */
  maxSeq(boardId) {
    let max = 0
    for (const message of this.store.messages.values()) {
      if (message.boardId === boardId && message.seq > max) max = message.seq
    }
    return max
  }

  /** Read cursor of one session on one board. */
  cursorOf(boardId, sessionId) {
    return this.store.cursors.get(`${boardId}::${sessionId}`)?.lastReadSeq ?? 0
  }

  /** Unread count of one session on one board. */
  unreadOf(boardId, sessionId) {
    return Math.max(0, this.maxSeq(boardId) - this.cursorOf(boardId, sessionId))
  }

  /** Latest message of one board, or null. */
  lastMessageOf(boardId) {
    const messages = this.messagesOf(boardId)
    return messages.length === 0 ? null : messages[messages.length - 1]
  }

  /** Human title for one side's referenced session or workspace. */
  refTitle(side) {
    if (side.kind === 'workspace') {
      return this.ctx.workspaceRegistry.get(side.ref)?.title ?? side.ref
    }
    const session = this.ctx.sessions.get(side.ref)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return basename(cwd)
    return side.ref
  }

  /**
   * "Workspace-Session" display name for one session: the owning workspace's
   * title, a dash, then the log-backed session title (directory-name
   * fallback), so same-named sessions in different workspaces never collide
   * and same-workspace sessions stay distinguishable.
   */
  sessionDisplayName(sessionId) {
    const workspaceId = this.workspaceOf(sessionId)
    const workspaceTitle = workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(workspaceId)?.title
    let sessionTitle = ''
    try {
      const titleService = this.ctx.get?.('sessionTitle')
      sessionTitle = titleService?.get(this.ctx.sessions.get(sessionId))?.title ?? ''
    } catch {
      sessionTitle = ''
    }
    if (sessionTitle === '') {
      const session = this.ctx.sessions.get(sessionId)
      const cwd = session?.header?.cwd
      sessionTitle = typeof cwd === 'string' && cwd !== '' ? basename(cwd) : sessionId.slice(0, 8)
    }
    return workspaceTitle === undefined ? sessionTitle : `${workspaceTitle}-${sessionTitle}`
  }

  /* ---------------------------------------------------------------- */
  /* Session lifecycle (roster + activity log)                         */
  /* ---------------------------------------------------------------- */

  /** Lifecycle status annotation for one board/doc side on the wire. */
  sideStatus(side) {
    if (side.kind === 'workspace') {
      return this.ctx.workspaceRegistry.get(side.ref) === undefined ? 'removed' : SESSION_ACTIVE
    }
    return this.sessionStatus(side.ref)
  }

  /** Next monotonic seq for the activity log. */
  nextActivitySeq() {
    let max = 0
    for (const entry of this.store.activity.values()) {
      if (entry.seq > max) max = entry.seq
    }
    return max + 1
  }

  /**
   * Upsert one session's roster row and append one lifecycle event. The
   * roster row stores the derived status (the live registries stay
   * authoritative — this row is a durable record, never the enforcement
   * source); the event records what happened and when.
   * @param forcedStatus - optional status override (the unarchiving event
   *   dispatches before the archive set write, so the derived read is stale).
   */
  trackSession(sessionId, type, forcedStatus) {
    const now = new Date().toISOString()
    const previous = this.store.roster.get(sessionId)
    const workspaceId = this.workspaceOf(sessionId)
    const workspaceTitle = workspaceId === undefined
      ? null
      : this.ctx.workspaceRegistry.get(workspaceId)?.title ?? null
    const displayName = this.sessionDisplayName(sessionId)
    const record = {
      id: sessionId,
      sessionId,
      status: forcedStatus ?? this.sessionStatus(sessionId),
      displayName,
      workspaceId: workspaceId ?? null,
      updatedAt: now,
      joinedAt: previous?.joinedAt ?? now,
    }
    this.store.put('roster', this.store.roster, sessionId, record)
    const event = {
      id: rid('ev'),
      seq: this.nextActivitySeq(),
      at: now,
      sessionId,
      type,
      displayName,
      workspaceTitle,
    }
    this.store.put('activity', this.store.activity, event.id, event)
    // The log is capped: drop the oldest entry once over budget.
    if (this.store.activity.size > MAX_ACTIVITY) {
      let oldest = null
      for (const entry of this.store.activity.values()) {
        if (oldest === null || entry.seq < oldest.seq) oldest = entry
      }
      if (oldest !== null) this.store.delete('activity', this.store.activity, oldest.id)
    }
  }

  /**
   * Record a session that appeared (`agent/created`): relevant sessions are
   * those boards already know — exact members, roster alumni, or sessions of
   * a workspace member. A session being created may race the workspace
   * attach (serial listeners), so the cwd is resolved to a workspace
   * directly when the cached index does not know it yet.
   */
  async trackSessionJoined(sessionId) {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined || session.header.origin === 'subagent') return
    const known = this.store.roster.has(sessionId)
    this.invalidateWorkspaceIndex()
    if (known || this.coversSession(sessionId)) {
      this.trackSession(sessionId, known ? ACTIVITY_RETURNED : ACTIVITY_JOINED)
      return
    }
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    try {
      const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
      if (workspace === undefined) return
      this.invalidateWorkspaceIndex()
      if (this.coversSession(sessionId)) this.trackSession(sessionId, ACTIVITY_JOINED)
    } catch {
      // An unresolvable cwd covers no workspace member.
    }
  }

  /** Record a session that left the host (`agent/disposed`). */
  trackSessionLeft(sessionId) {
    const session = this.ctx.sessions.get(sessionId)
    if (session !== undefined && session.header.origin === 'subagent') return
    if (!this.store.roster.has(sessionId) && !this.coversSession(sessionId)) return
    this.trackSession(sessionId, ACTIVITY_LEFT)
  }

  /** Record a session entering the registry-global archive set. */
  trackSessionArchived(sessionId) {
    if (!this.store.roster.has(sessionId) && !this.coversSession(sessionId)) return
    this.trackSession(sessionId, ACTIVITY_ARCHIVED)
  }

  /**
   * Record a session leaving the archive set. Dispatched before the durable
   * write (the only unarchive event), so the roster row is forced active;
   * the derived status stays the real source of truth either way.
   */
  trackSessionUnarchived(sessionId) {
    if (!this.store.roster.has(sessionId) && !this.coversSession(sessionId)) return
    this.trackSession(sessionId, ACTIVITY_UNARCHIVED, SESSION_ACTIVE)
  }

  /** Client-facing lifecycle event record. */
  activityWire(entry) {
    return {
      id: entry.id,
      at: entry.at,
      type: entry.type,
      sessionId: entry.sessionId,
      displayName: entry.displayName,
      workspaceTitle: entry.workspaceTitle ?? null,
    }
  }

  /** Recent lifecycle events involving one board's member scope, newest first. */
  activityFor(board, limit = 6) {
    const memberSessionIds = new Set()
    const workspaceIds = new Set()
    for (const side of board.sides) {
      if (side.kind === 'session') memberSessionIds.add(side.ref)
      else workspaceIds.add(side.ref)
    }
    // Roster rows remember the workspace a session belonged to when it was
    // tracked, so departed members keep surfacing in the board's activity
    // even after the workspace account drops them.
    for (const record of this.store.roster.values()) {
      if (record.workspaceId !== null && workspaceIds.has(record.workspaceId)) {
        memberSessionIds.add(record.sessionId)
      }
    }
    return [...this.store.activity.values()]
      .filter(entry => memberSessionIds.has(entry.sessionId))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map(entry => ({
        ...this.activityWire(entry),
        label: board.sides.find(side => side.ref === entry.sessionId)?.label ?? null,
      }))
  }

  /* ---------------------------------------------------------------- */
  /* Document blackboards (shared documents with queued editing)       */
  /* ---------------------------------------------------------------- */

  /** Snapshot array of every document record. */
  docs() {
    return [...this.store.docs.values()]
  }

  /** One document by id. */
  doc(id) {
    return this.store.docs.get(id)
  }

  /** All documents whose members cover the session. */
  docsOf(sessionId) {
    if (!this.communicable(sessionId)) return []
    const workspaceId = this.workspaceOf(sessionId)
    const result = []
    for (const doc of this.docs()) {
      const side = doc.sides.find(candidate => candidate.ref === sessionId
        || (candidate.kind === 'workspace' && candidate.ref === workspaceId))
      if (side !== undefined) result.push({ doc, side })
    }
    return result
  }

  /**
   * Validate members (same rules as chat rooms, plus "Workspace-Session"
   * default labels for session members) and create one document.
   */
  async createDoc(input) {
    if (input === null || typeof input !== 'object') throw new Error('body must be an object')
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : ''
    const rawSides = Array.isArray(input.sides) ? input.sides : null
    if (rawSides === null || rawSides.length < 1 || rawSides.length > MAX_MEMBERS) {
      throw new Error(`a document needs between 1 and ${MAX_MEMBERS} members`)
    }
    const seenRefs = new Set()
    const sides = rawSides.map((side, index) => {
      if (side === null || typeof side !== 'object') throw new Error(`member ${index + 1} must be an object`)
      if (side.kind !== 'session' && side.kind !== 'workspace') throw new Error(`member ${index + 1} kind must be session or workspace`)
      if (typeof side.ref !== 'string' || side.ref === '') throw new Error(`member ${index + 1} needs a ref`)
      if (side.kind === 'session' && this.ctx.sessions.get(side.ref) === undefined) {
        throw new Error(`member ${index + 1} references a session that is not live in this host`)
      }
      if (side.kind === 'workspace' && this.ctx.workspaceRegistry.get(side.ref) === undefined) {
        throw new Error(`member ${index + 1} references an unknown workspace`)
      }
      const refKey = `${side.kind}:${side.ref}`
      if (seenRefs.has(refKey)) throw new Error('each session or workspace may join a document once')
      seenRefs.add(refKey)
      const fallback = side.kind === 'session'
        ? this.sessionDisplayName(side.ref)
        : this.ctx.workspaceRegistry.get(side.ref)?.title ?? DEFAULT_MEMBER_LABELS[index] ?? `M${index + 1}`
      const label = typeof side.label === 'string' && side.label.trim() !== ''
        ? side.label.trim().slice(0, 60)
        : fallback
      return { key: `s${index + 1}`, kind: side.kind, ref: side.ref, label }
    })
    const content = typeof input.content === 'string' ? input.content.slice(0, MAX_DOC_CHARS) : ''
    const now = new Date().toISOString()
    const doc = {
      id: rid('doc'),
      title: title === '' ? sides.map(side => side.label).join('、') : title,
      sides,
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.store.put('docs', this.store.docs, doc.id, doc)
    return doc
  }

  /** Delete one document (its transient queue is dropped with it). */
  async deleteDoc(docId) {
    if (this.doc(docId) === undefined) throw new Error('document not found')
    this.docLocks.delete(docId)
    this.store.delete('docs', this.store.docs, docId)
  }

  /** The live lock record of one document (an expired lease releases first). */
  docLockOf(docId) {
    const lock = this.docLocks.get(docId)
    if (lock === undefined) return undefined
    if (lock.holder !== undefined && lock.holder.expiresAt <= Date.now()) {
      // An abandoned lease (agent crashed mid-edit) releases silently and the
      // next waiter takes the turn.
      lock.holder = undefined
      this.grantNextDocLock(docId)
    }
    return lock
  }

  /** Hand the freed lease to the queue head, if any. */
  grantNextDocLock(docId) {
    const lock = this.docLocks.get(docId)
    if (lock === undefined || lock.holder !== undefined) return
    const next = lock.queue.shift()
    if (next === undefined) {
      this.docLocks.delete(docId)
      return
    }
    const now = Date.now()
    lock.holder = { owner: next.owner, token: next.token, at: now, expiresAt: now + DOC_LEASE_MS }
    if (next.resolve !== undefined) next.resolve()
  }

  /**
   * Join one document's edit queue and wait for the turn, up to `waitMs`.
   * The turn grants a fresh read: the caller receives the content CURRENT at
   * grant time, so every edit starts from the latest committed state.
   * @returns `{ granted, token?, version?, content?, position? }`
   */
  async acquireDocEdit(docId, owner, waitMs) {
    const doc = this.doc(docId)
    if (doc === undefined) throw new Error('document not found')
    const budget = Math.min(Math.max(0, waitMs ?? DOC_QUEUE_WAIT_DEFAULT_MS), DOC_QUEUE_WAIT_MAX_MS)
    const token = rid('edit')
    let lock = this.docLocks.get(docId)
    if (lock === undefined) {
      lock = { holder: undefined, queue: [] }
      this.docLocks.set(docId, lock)
    }
    if (lock.holder === undefined || lock.holder.expiresAt <= Date.now()) {
      lock.holder = undefined
      const now = Date.now()
      lock.holder = { owner, token, at: now, expiresAt: now + DOC_LEASE_MS }
      // A queue may hold waiters while the lease had expired: keep them parked.
      const fresh = this.doc(docId)
      return { granted: true, token, version: fresh.version, content: fresh.content }
    }
    if (lock.holder.owner === owner) {
      throw new Error('you already hold this document\'s edit turn')
    }
    return await new Promise(resolve => {
      const entry = { owner, token, at: Date.now(), resolve: () => {
        const fresh = this.doc(docId)
        resolve({ granted: true, token, version: fresh.version, content: fresh.content })
      } }
      lock.queue.push(entry)
      const timer = setTimeout(() => {
        const index = lock.queue.indexOf(entry)
        if (index !== -1) {
          lock.queue.splice(index, 1)
          resolve({ granted: false, token, position: 0 })
        }
      }, budget)
      // A grant resolves first; the leftover timer is harmless but clear it.
      const original = entry.resolve
      entry.resolve = () => {
        clearTimeout(timer)
        original()
      }
    })
  }

  /**
   * Commit one edit: the caller must hold the turn and quote the version it
   * read (fresh-read guarantee), and the turn is released on success.
   */
  commitDocEdit(docId, owner, token, expectedVersion, newContent) {
    const doc = this.doc(docId)
    if (doc === undefined) throw new Error('document not found')
    if (typeof newContent !== 'string') throw new Error('newContent must be a string')
    if (newContent.length > MAX_DOC_CHARS) throw new Error(`content exceeds ${MAX_DOC_CHARS} characters`)
    const lock = this.docLockOf(docId)
    if (lock === undefined || lock.holder === undefined) throw new Error('no edit turn is held')
    if (lock.holder.owner !== owner || lock.holder.token !== token) throw new Error('you do not hold this document\'s edit turn')
    if (expectedVersion !== doc.version) {
      // Cannot happen while the turn is held, but guards stale calls.
      throw new Error(`version mismatch: document is at ${doc.version}, you read ${expectedVersion}`)
    }
    const next = {
      ...doc,
      content: newContent,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.put('docs', this.store.docs, docId, next)
    lock.holder = undefined
    this.grantNextDocLock(docId)
    return next
  }

  /** Release one edit turn without writing (also drops the caller's queue slot). */
  cancelDocEdit(docId, owner, token) {
    const lock = this.docLocks.get(docId)
    if (lock === undefined) return
    if (lock.holder !== undefined && lock.holder.owner === owner && lock.holder.token === token) {
      lock.holder = undefined
      this.grantNextDocLock(docId)
      return
    }
    const index = lock.queue.findIndex(entry => entry.owner === owner && entry.token === token)
    if (index !== -1) lock.queue.splice(index, 1)
  }

  /** Client-facing document summary with live lock state. */
  docSummary(doc, sessionId) {
    const lock = this.docLockOf(doc.id)
    const mine = sessionId === undefined || sessionId === ''
      ? undefined
      : doc.sides.find(side => side.ref === sessionId
        || (side.kind === 'workspace' && side.ref === this.workspaceOf(sessionId)))
    return {
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      version: doc.version,
      sides: doc.sides.map(side => ({ ...side, refTitle: this.refTitle(side), status: this.sideStatus(side) })),
      mySideKey: mine?.key ?? null,
      edit: {
        holder: lock?.holder === undefined ? null
          : { owner: lock.holder.owner, ownerName: lock.holder.owner === 'user' ? null : this.sessionDisplayName(lock.holder.owner), grantedAt: new Date(lock.holder.at).toISOString(), expiresAt: new Date(lock.holder.expiresAt).toISOString() },
        queue: (lock?.queue ?? []).map(entry => ({
          owner: entry.owner,
          ownerName: entry.owner === 'user' ? null : this.sessionDisplayName(entry.owner),
          joinedAt: new Date(entry.at).toISOString(),
        })),
        mine: lock?.holder?.owner === sessionId || (lock?.queue ?? []).some(entry => entry.owner === sessionId),
        mineUser: lock?.holder?.owner === 'user' || (lock?.queue ?? []).some(entry => entry.owner === 'user'),
      },
      excerpt: excerpt(doc.content.replaceAll('\n', ' ')),
    }
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */

  /** Serialize one board's seq allocation and writes behind a promise chain. */
  enqueue(boardId, task) {
    const previous = this.boardChains.get(boardId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.boardChains.set(boardId, next)
    return next
  }

  /**
   * Validate and create one board with 1..8 members.
   * @returns the created board record; throws Error with a user-facing message.
   */
  async createBoard(input) {
    if (input === null || typeof input !== 'object') throw new Error('body must be an object')
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : ''
    const rawSides = Array.isArray(input.sides) ? input.sides : null
    if (rawSides === null || rawSides.length < 1 || rawSides.length > MAX_MEMBERS) {
      throw new Error(`a board needs between 1 and ${MAX_MEMBERS} members`)
    }
    const seenRefs = new Set()
    const sides = rawSides.map((side, index) => {
      if (side === null || typeof side !== 'object') throw new Error(`member ${index + 1} must be an object`)
      if (side.kind !== 'session' && side.kind !== 'workspace') throw new Error(`member ${index + 1} kind must be session or workspace`)
      if (typeof side.ref !== 'string' || side.ref === '') throw new Error(`member ${index + 1} needs a ref`)
      if (side.kind === 'session' && this.ctx.sessions.get(side.ref) === undefined) {
        throw new Error(`member ${index + 1} references a session that is not live in this host`)
      }
      if (side.kind === 'workspace' && this.ctx.workspaceRegistry.get(side.ref) === undefined) {
        throw new Error(`member ${index + 1} references an unknown workspace`)
      }
      const refKey = `${side.kind}:${side.ref}`
      if (seenRefs.has(refKey)) throw new Error('each session or workspace may join a board once')
      seenRefs.add(refKey)
      const provisional = { key: `s${index + 1}`, kind: side.kind, ref: side.ref, label: '' }
      // Session members default to the "Workspace-Session" display name so
      // same-named sessions stay distinguishable across workspaces.
      const fallback = (side.kind === 'session'
        ? this.sessionDisplayName(side.ref)
        : this.refTitle(provisional)) || DEFAULT_MEMBER_LABELS[index] || `M${index + 1}`
      const label = typeof side.label === 'string' && side.label.trim() !== ''
        ? side.label.trim().slice(0, 60)
        : fallback
      return { ...provisional, label }
    })
    const board = {
      id: rid('bb'),
      title: title === '' ? sides.map(side => side.label).join('、') : title,
      sides,
      createdAt: new Date().toISOString(),
    }
    this.store.put('boards', this.store.boards, board.id, board)
    return board
  }

  /**
   * Append one message. Agent posts carry the member side their session
   * belongs to; user posts always speak as the human participant. Mentions
   * (`@label`, `@all`) are parsed here and wake the mentioned members'
   * agents right after the message is durable.
   * @returns the stored message; throws with a user-facing message on refusal.
   */
  async postMessage(boardId, text, authorKind, authorSessionId) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('message text is required')
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`message text exceeds ${MAX_MESSAGE_CHARS} characters`)
    return this.enqueue(boardId, () => {
      const board = this.board(boardId)
      if (board === undefined) throw new Error('board not found')
      let side
      if (authorKind === 'agent') {
        if (this.sessionArchived(authorSessionId)) {
          throw new Error('this session is archived: archived sessions cannot read or post to boards')
        }
        if (!this.sessionLive(authorSessionId)) {
          throw new Error('this session is no longer live in this host and cannot post to boards')
        }
        const membership = this.boardsOf(authorSessionId).find(entry => entry.board.id === boardId)
        if (membership === undefined) throw new Error('this session is not a member of the board')
        side = membership.side
      } else {
        side = { key: USER_SIDE, label: null }
      }
      const message = {
        id: rid('m'),
        boardId,
        seq: this.maxSeq(boardId) + 1,
        sideKey: side.key,
        authorKind,
        authorSessionId: authorKind === 'agent' ? authorSessionId : null,
        text,
        createdAt: new Date().toISOString(),
        mentions: parseMentions(board, text),
      }
      this.store.put('messages', this.store.messages, message.id, message)
      // The author has obviously read its own message.
      if (authorKind === 'agent') this.advanceCursor(boardId, authorSessionId, message.seq)
      // A mention is the one "push" channel: wake the mentioned members.
      this.wakeMentioned(board, message)
      return message
    })
  }

  /**
   * Wake the live agents of every mentioned member: an exact-session member's
   * agent, and every non-subagent agent whose session sits in a mentioned
   * workspace member. The author's own session is never woken by its post.
   * @returns how many agents received the relay.
   */
  wakeMentioned(board, message) {
    const mentions = message.mentions ?? { sides: [], all: false }
    const targetKeys = new Set(mentions.all ? board.sides.map(side => side.key) : mentions.sides)
    if (targetKeys.size === 0) return 0
    const senderLabel = message.sideKey === USER_SIDE
      ? 'The user'
      : board.sides.find(side => side.key === message.sideKey)?.label ?? 'A member'
    let woken = 0
    for (const agent of this.ctx.agents.list()) {
      const session = agent.session
      if (session.header.origin === 'subagent') continue
      if (message.authorKind === 'agent' && session.id === message.authorSessionId) continue
      // boardsOf covers communicable members only, so archived or departed
      // sessions are never woken even when a board still names them.
      const membership = this.boardsOf(session.id).find(entry => entry.board.id === board.id)
      if (membership === undefined || !targetKeys.has(membership.side.key)) continue
      try {
        agent.followup(mentionMessage(board, message, membership.side, senderLabel))
        woken += 1
      } catch (error) {
        this.ctx.logger.warn(`session-blackboard: could not wake session "${session.id}": ${String(error)}`)
      }
    }
    if (woken > 0) {
      this.ctx.logger.info(`session-blackboard: mention woke ${woken} agent(s) on board "${board.id}"`)
    }
    return woken
  }

  /** Move one session's read cursor forward (never backward). */
  advanceCursor(boardId, sessionId, seq) {
    const key = `${boardId}::${sessionId}`
    const current = this.store.cursors.get(key)
    if (current !== undefined && current.lastReadSeq >= seq) return current
    const record = { id: key, boardId, sessionId, lastReadSeq: seq }
    this.store.put('cursors', this.store.cursors, key, record)
    return record
  }

  /** Remove one board with its messages and cursors. */
  async deleteBoard(boardId) {
    if (this.board(boardId) === undefined) throw new Error('board not found')
    for (const message of this.messagesOf(boardId)) {
      this.store.delete('messages', this.store.messages, message.id)
    }
    for (const [key, cursor] of this.store.cursors.entries()) {
      if (cursor.boardId === boardId) this.store.delete('cursors', this.store.cursors, key)
    }
    this.store.delete('boards', this.store.boards, boardId)
  }

  /* ---------------------------------------------------------------- */
  /* Wire shapes                                                       */
  /* ---------------------------------------------------------------- */

  /** Client-facing board summary, annotated for one viewing session. */
  boardSummary(board, sessionId) {
    const messages = this.messagesOf(board.id)
    const last = messages.length === 0 ? null : messages[messages.length - 1]
    const mine = sessionId === undefined || sessionId === ''
      ? undefined
      : board.sides.find(side => side.ref === sessionId
        || (side.kind === 'workspace' && side.ref === this.workspaceOf(sessionId)))
    return {
      id: board.id,
      title: board.title,
      createdAt: board.createdAt,
      sides: board.sides.map(side => ({ ...side, refTitle: this.refTitle(side), status: this.sideStatus(side) })),
      mySideKey: mine?.key ?? null,
      unread: mine === undefined ? null : this.unreadOf(board.id, sessionId),
      messageCount: messages.length,
      activity: this.activityFor(board),
      lastMessage: last === null ? null : {
        seq: last.seq,
        sideKey: last.sideKey,
        authorKind: last.authorKind,
        excerpt: excerpt(last.text),
        createdAt: last.createdAt,
      },
    }
  }

  /** Client-facing message record; `you` is true for the human participant's rows. */
  messageWire(message, board) {
    const side = message.sideKey === USER_SIDE
      ? undefined
      : board.sides.find(candidate => candidate.key === message.sideKey)
    return {
      id: message.id,
      seq: message.seq,
      sideKey: message.sideKey,
      sideLabel: side?.label ?? message.sideKey,
      authorKind: message.authorKind,
      authorSessionId: message.authorSessionId,
      text: message.text,
      createdAt: message.createdAt,
      mentions: message.mentions ?? { sides: [], all: false },
    }
  }

  /* ---------------------------------------------------------------- */
  /* System prompt                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Identity card for one session: its id, display name, owning workspace,
   * and lifecycle status, so every session can state its own positioning.
   * @returns the identity lines; empty when the session is unknown.
   */
  identityLines(sessionId) {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return []
    const displayName = this.sessionDisplayName(sessionId)
    const workspaceId = this.workspaceOf(sessionId)
    const workspace = workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(workspaceId)
    const origin = session.header.origin === 'subagent' ? 'subagent' : 'top-level'
    return [
      `Your identity: session "${displayName}" (id: ${sessionId}, ${origin})`
        + (workspace !== undefined
          ? ` in workspace "${workspace.title}" (${workspace.path})`
          : ' with no owning workspace')
        + `; current status: ${this.sessionStatus(sessionId)}.`,
      'Sessions created inside a member workspace join its boards automatically; '
        + 'archived or closed members are cut off — they cannot read, post, edit, or be woken, '
        + 'so treat any listed member not marked "active" as unavailable and do not wait for their replies. '
        + 'Call blackboard_whoami to re-check your identity and memberships at any time.',
    ]
  }

  /** Guidance text for one session; identity only when it sits on no board. */
  promptFor(sessionId) {
    const entries = this.boardsOf(sessionId)
    const docEntries = this.docsOf(sessionId)
    if (entries.length === 0 && docEntries.length === 0) {
      const identity = this.identityLines(sessionId)
      return identity.length === 0 ? '' : [
        '## Shared blackboards (group chat + documents)',
        '',
        ...identity,
      ].join('\n')
    }
    const lines = []
    if (entries.length > 0) {
      lines.push('Group chats (agent group chat):')
      for (const { board, side } of entries) {
        const peers = board.sides.filter(candidate => candidate.key !== side.key)
          .map(candidate => `"${candidate.label}" (${candidate.kind}: ${this.refTitle(candidate)})`)
        const peerText = peers.length === 0 ? '' : ` Other members: ${peers.join(', ')}.`
        const unavailable = board.sides
          .filter(candidate => candidate.key !== side.key && this.sideStatus(candidate) !== SESSION_ACTIVE)
          .map(candidate => `"${candidate.label}" (${this.sideStatus(candidate)})`)
        const unavailableText = unavailable.length === 0 ? '' : ` Unavailable members (do not wait for them): ${unavailable.join(', ')}.`
        const unread = this.unreadOf(board.id, sessionId)
        const last = this.lastMessageOf(board.id)
        const news = unread > 0 && last !== null
          ? ` ${unread} unread; latest from ${last.sideKey === USER_SIDE ? 'the user' : board.sides.find(candidate => candidate.key === last.sideKey)?.label ?? 'a member'}: "${excerpt(last.text)}"`
          : ''
        lines.push(`- Chat "${board.title}" — you are member "${side.label}" (${side.kind}: ${this.refTitle(side)}); the user also posts here.${peerText}${unavailableText}${news}`)
      }
      lines.push('Chat tools: blackboard_list / blackboard_read / blackboard_post. Posting does not wake other members — each sees your message at its next turn — EXCEPT mentions: @member-label actively pings that member (its agent is woken to check the board), or @all for everyone. Use mentions sparingly; mentions never wake archived or closed members.')
    }
    if (docEntries.length > 0) {
      lines.push('Shared document blackboards (one shared Markdown document per board; everyone reads, edits are serialized through a queue):')
      for (const { doc, side } of docEntries) {
        const peers = doc.sides.filter(candidate => candidate.key !== side.key)
          .map(candidate => `"${candidate.label}"`)
        const lock = this.docLockOf(doc.id)
        const busy = lock?.holder !== undefined ? ` (edit turn held by ${lock.holder.owner === 'user' ? 'the user' : this.sessionDisplayName(lock.holder.owner)}${lock.queue.length > 0 ? `, ${lock.queue.length} waiting` : ''})` : ''
        lines.push(`- Document "${doc.title}" — you are member "${side.label}"; others: ${peers.join(', ') || 'none'}. Version ${doc.version}${busy}`)
      }
      lines.push('Document tools: docboard_read fetches the latest content; docboard_begin_edit joins the edit queue and, when your turn is granted, returns the CURRENT content and version (always edit from that fresh read); docboard_commit_edit writes your full replacement content quoting that version and releases the turn; docboard_cancel_edit abandons it. One turn at a time; keep turns short.')
    }
    return [
      '## Shared blackboards (group chat + documents)',
      '',
      'Both are OPTIONAL channels: use them when exchanging information with the user or other members would help your work, and ignore them otherwise.',
      ...this.identityLines(sessionId),
      ...lines,
    ].join('\n')
  }

  /** Per-agent section registration, disposed with the agent and with the plugin. */
  trackAgent(agent) {
    const sessionId = agent.session.id
    const stop = agent.ctx.systemPrompt.section({
      name: 'tool:blackboard',
      order: PROMPT_ORDER,
      text: () => this.promptFor(sessionId),
    })
    this.sectionStops.set(sessionId, stop)
  }

  forgetAgent(sessionId) {
    this.sectionStops.delete(sessionId)
  }

  disposeSections() {
    for (const stop of this.sectionStops.values()) {
      try { stop() } catch { /* an agent disposal may have removed it already */ }
    }
    this.sectionStops.clear()
  }

  /* ---------------------------------------------------------------- */
  /* Agent tools                                                       */
  /* ---------------------------------------------------------------- */

  /** Resolve the calling agent or return a canonical error value. */
  callerOf(exec) {
    const agent = exec.agent
    if (agent === undefined || agent.session?.id === undefined) {
      return { error: { code: 'caller-unavailable', message: 'Blackboard tools need a calling session.' } }
    }
    return { sessionId: agent.session.id }
  }

  /** Assert the model gave a plain string argument. */
  requireString(args, name) {
    const value = args?.[name]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${name} must be a non-empty string`)
    }
    return value
  }

  registerTools() {
    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    /** Shared error branch: every tool's refused path returns `{ error: { code, message } }`. */
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
    const listOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            boards: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  mySideKey: { type: 'string' },
                  mySideLabel: { type: 'string' },
                  otherSides: { type: 'array', items: { type: 'string' } },
                  unread: { type: 'integer' },
                  messageCount: { type: 'integer' },
                  lastExcerpt: { type: 'string' },
                },
                required: ['id', 'title', 'mySideKey', 'mySideLabel', 'otherSides', 'unread', 'messageCount', 'lastExcerpt'],
              },
            },
          },
          required: ['boards'],
        },
        errorSchema,
      ],
    }
    const readOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            boardId: { type: 'string' },
            fromSeq: { type: 'integer' },
            toSeq: { type: 'integer' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'integer' },
                  sideKey: { type: 'string' },
                  sideLabel: { type: 'string' },
                  authorKind: { type: 'string' },
                  text: { type: 'string' },
                  createdAt: { type: 'string' },
                },
                required: ['seq', 'sideKey', 'sideLabel', 'authorKind', 'text', 'createdAt'],
              },
            },
            remainingUnread: { type: 'integer' },
          },
          required: ['boardId', 'fromSeq', 'toSeq', 'messages', 'remainingUnread'],
        },
        errorSchema,
      ],
    }
    const postOutput = {
      oneOf: [
        {
          type: 'object',
          properties: { boardId: { type: 'string' }, seq: { type: 'integer' }, message: { type: 'string' } },
          required: ['boardId', 'seq', 'message'],
        },
        errorSchema,
      ],
    }

    this.ctx.tools.register({
      name: 'blackboard_list',
      description: 'List the shared blackboards this session belongs to, with your member identity, unread count, and the latest message excerpt. '
        + 'Shared boards are chat rooms between the user and several member sessions.',
      parameters: { type: 'object', properties: {} },
      output: { schema: listOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => {
        const caller = this.callerOf(exec)
        if (caller.error !== undefined) return { error: caller.error }
        const boards = this.boardsOf(caller.sessionId).map(({ board, side }) => {
          const last = this.lastMessageOf(board.id)
          return {
            id: board.id,
            title: board.title,
            mySideKey: side.key,
            mySideLabel: side.label,
            otherSides: board.sides.filter(candidate => candidate.key !== side.key)
              .map(candidate => {
                const status = this.sideStatus(candidate)
                return `${candidate.label} (${candidate.kind}: ${this.refTitle(candidate)})${status === SESSION_ACTIVE ? '' : ` [${status}]`}`
              }),
            unread: this.unreadOf(board.id, caller.sessionId),
            messageCount: this.messagesOf(board.id).length,
            lastExcerpt: last === null
              ? ''
              : `${last.sideKey === USER_SIDE ? 'user' : board.sides.find(candidate => candidate.key === last.sideKey)?.label ?? 'member'}: "${excerpt(last.text)}"`,
          }
        })
        return { boards }
      },
    }, { label: 'blackboard: list' })

    const whoamiOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            displayName: { type: 'string' },
            cwd: { type: 'string' },
            status: { type: 'string', enum: ['active', 'archived', 'departed'] },
            workspace: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
              },
              required: ['id', 'title', 'path'],
            },
            chats: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  boardId: { type: 'string' },
                  title: { type: 'string' },
                  mySideKey: { type: 'string' },
                  mySideLabel: { type: 'string' },
                  unread: { type: 'integer' },
                },
                required: ['boardId', 'title', 'mySideKey', 'mySideLabel', 'unread'],
              },
            },
            docs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  docId: { type: 'string' },
                  title: { type: 'string' },
                  mySideKey: { type: 'string' },
                  mySideLabel: { type: 'string' },
                  version: { type: 'integer' },
                },
                required: ['docId', 'title', 'mySideKey', 'mySideLabel', 'version'],
              },
            },
            note: { type: 'string' },
          },
          required: ['sessionId', 'displayName', 'status', 'chats', 'docs'],
        },
        errorSchema,
      ],
    }

    this.ctx.tools.register({
      name: 'blackboard_whoami',
      description: 'Report this session\'s own identity: session id, display name, owning workspace, lifecycle status '
        + '(active / archived / departed), and every chat and shared-document membership with your member label in each. '
        + 'Call it whenever you need to confirm who you are or where you stand in the collaboration surfaces.',
      parameters: { type: 'object', properties: {} },
      output: { schema: whoamiOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => {
        const caller = this.callerOf(exec)
        if (caller.error !== undefined) return { error: caller.error }
        const sessionId = caller.sessionId
        const session = this.ctx.sessions.get(sessionId)
        if (session === undefined) {
          return { error: { code: 'caller-unavailable', message: 'This session is no longer live in this host.' } }
        }
        const workspaceId = this.workspaceOf(sessionId)
        const workspace = workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(workspaceId)
        return {
          sessionId,
          displayName: this.sessionDisplayName(sessionId),
          cwd: typeof session.header.cwd === 'string' ? session.header.cwd : '',
          status: this.sessionStatus(sessionId),
          workspace: workspace === undefined ? null : {
            id: workspace.id, title: workspace.title, path: workspace.path,
          },
          chats: this.boardsOf(sessionId).map(({ board, side }) => ({
            boardId: board.id,
            title: board.title,
            mySideKey: side.key,
            mySideLabel: side.label,
            unread: this.unreadOf(board.id, sessionId),
          })),
          docs: this.docsOf(sessionId).map(({ doc, side }) => ({
            docId: doc.id,
            title: doc.title,
            mySideKey: side.key,
            mySideLabel: side.label,
            version: doc.version,
          })),
          note: 'You post to chats under your member label; @member-label pings that member (never archived or closed ones), @all pings everyone available. '
            + 'Sessions created inside a member workspace join its boards automatically.',
        }
      },
    }, { label: 'blackboard: whoami' })

    this.ctx.tools.register({
      name: 'blackboard_read',
      description: 'Read messages of one shared blackboard, oldest first, and mark them read for this session. '
        + 'Omit boardId to read the board with the most unread messages; the response carries the board id.',
      parameters: {
        type: 'object',
        properties: {
          boardId: { type: 'string', description: 'Board id from blackboard_list; omit to pick the board with the most unread messages.' },
          sinceSeq: { type: 'integer', description: `Return messages with seq greater than this; omit for the last ${READ_PAGE}.` },
        },
      },
      output: { schema: readOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const caller = this.callerOf(exec)
        if (caller.error !== undefined) return { error: caller.error }
        let target
        if (typeof args?.boardId === 'string' && args.boardId !== '') {
          target = this.boardsOf(caller.sessionId).find(entry => entry.board.id === args.boardId)
          if (target === undefined) return { error: { code: 'not-a-member', message: 'this session is not a member of that board' } }
        } else {
          const candidates = this.boardsOf(caller.sessionId)
            .filter(entry => this.unreadOf(entry.board.id, caller.sessionId) > 0)
            .sort((a, b) => this.unreadOf(b.board.id, caller.sessionId) - this.unreadOf(a.board.id, caller.sessionId))
          target = candidates[0]
          if (target === undefined) return { boardId: '', fromSeq: 0, toSeq: 0, messages: [], remainingUnread: 0 }
        }
        const since = typeof args?.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0
          ? args.sinceSeq
          : Math.max(0, this.maxSeq(target.board.id) - READ_PAGE)
        const all = this.messagesOf(target.board.id)
        const picked = all.filter(message => message.seq > since)
        if (picked.length > 0) {
          this.advanceCursor(target.board.id, caller.sessionId, picked[picked.length - 1].seq)
        }
        return {
          boardId: target.board.id,
          fromSeq: since,
          toSeq: this.maxSeq(target.board.id),
          messages: picked.map(message => this.messageWire(message, target.board)),
          remainingUnread: this.unreadOf(target.board.id, caller.sessionId),
        }
      },
    }, { label: 'blackboard: read' })

    this.ctx.tools.register({
      name: 'blackboard_post',
      description: 'Post one message to a shared blackboard as your member identity. Other members see it at their next turn — '
        + 'EXCEPT mentions: include @member-label to actively ping that member (its agent is woken to check the board), or @all for everyone. Use mentions sparingly.',
      parameters: {
        type: 'object',
        properties: {
          boardId: { type: 'string', description: 'Board id from blackboard_list.' },
          text: { type: 'string', description: 'Message text for the room, up to 8000 characters. @member-label mentions that member; @all mentions everyone.' },
        },
        required: ['boardId', 'text'],
      },
      output: { schema: postOutput, render: renderJson },
      execute: async (args, exec) => {
        const caller = this.callerOf(exec)
        if (caller.error !== undefined) return { error: caller.error }
        try {
          const boardId = this.requireString(args, 'boardId')
          const text = this.requireString(args, 'text')
          const message = await this.postMessage(boardId, text, 'agent', caller.sessionId)
          return { boardId: message.boardId, seq: message.seq, message: 'posted' }
        } catch (error) {
          return { error: { code: 'post-refused', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'blackboard: post' })

    // ---- Document blackboard tools (shared documents, queued editing) ----

    const docErrorSchema = errorSchema
    const docReadOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            version: { type: 'integer' },
            content: { type: 'string' },
            updatedAt: { type: 'string' },
            editing: {
              type: 'object',
              properties: {
                /** Empty string means no holder (free to edit). */
                holder: { type: 'string' },
                /** Empty string when nobody holds the turn. */
                holderName: { type: 'string' },
                queueLength: { type: 'integer' },
              },
              required: ['holder', 'holderName', 'queueLength'],
            },
          },
          required: ['id', 'title', 'version', 'content', 'updatedAt', 'editing'],
        },
        docErrorSchema,
      ],
    }
    const docBeginOutput = {
      oneOf: [
        {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['granted', 'queued'] },
            token: { type: 'string' },
            version: { type: 'integer' },
            content: { type: 'string' },
          },
          required: ['status', 'token'],
        },
        docErrorSchema,
      ],
    }
    const docCommitOutput = {
      oneOf: [
        {
          type: 'object',
          properties: { version: { type: 'integer' }, updatedAt: { type: 'string' } },
          required: ['version', 'updatedAt'],
        },
        docErrorSchema,
      ],
    }
    const docCancelOutput = {
      oneOf: [
        { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        docErrorSchema,
      ],
    }

    /** Resolve the caller's document membership or a canonical error value. */
    const docCallerOf = (exec, docId) => {
      const agent = exec.agent
      if (agent === undefined || agent.session?.id === undefined) {
        return { error: { code: 'caller-unavailable', message: 'Document tools need a calling session.' } }
      }
      if (this.sessionArchived(agent.session.id)) {
        return { error: { code: 'session-archived', message: 'this session is archived: archived sessions cannot read or edit shared documents' } }
      }
      if (!this.sessionLive(agent.session.id)) {
        return { error: { code: 'session-departed', message: 'this session is no longer live in this host' } }
      }
      const entry = this.docsOf(agent.session.id).find(candidate => candidate.doc.id === docId)
      if (entry === undefined) {
        return { error: { code: 'not-a-member', message: 'this session is not a member of that document' } }
      }
      return { sessionId: agent.session.id }
    }

    this.ctx.tools.register({
      name: 'docboard_read',
      description: 'Read one shared document blackboard: its current Markdown content, version, and who holds the edit turn. '
        + 'Reads are free for every member; only edits queue.',
      parameters: {
        type: 'object',
        properties: { docId: { type: 'string', description: 'Document id from your system-prompt board list.' } },
        required: ['docId'],
      },
      output: { schema: docReadOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        try {
          const docId = this.requireString(args, 'docId')
          const caller = docCallerOf(exec, docId)
          if (caller.error !== undefined) return { error: caller.error }
          const doc = this.doc(docId)
          if (doc === undefined) throw new Error('document not found')
          const lock = this.docLockOf(docId)
          return {
            id: doc.id,
            title: doc.title,
            version: doc.version,
            content: doc.content,
            updatedAt: doc.updatedAt,
            editing: {
              holder: lock?.holder?.owner ?? '',
              holderName: lock?.holder === undefined
                ? ''
                : lock.holder.owner === 'user' ? 'the user' : this.sessionDisplayName(lock.holder.owner),
              queueLength: lock?.queue.length ?? 0,
            },
          }
        } catch (error) {
          return { error: { code: 'read-failed', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'docboard: read' })

    this.ctx.tools.register({
      name: 'docboard_begin_edit',
      description: 'Join a shared document\'s edit queue. When your turn is granted the response carries the document\'s CURRENT content and version — '
        + 'always base your edit on exactly that fresh read. Call docboard_commit_edit with the full replacement content and that version, or docboard_cancel_edit to give the turn back. '
        + 'If the wait budget expires first, status is "queued": retry later. Keep the turn short.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Document id.' },
          waitMs: { type: 'integer', description: `How long to wait for the turn, in milliseconds (default ${DOC_QUEUE_WAIT_DEFAULT_MS}, max ${DOC_QUEUE_WAIT_MAX_MS}).` },
        },
        required: ['docId'],
      },
      output: { schema: docBeginOutput, render: renderJson },
      timeoutMs: DOC_QUEUE_WAIT_MAX_MS + 10_000,
      execute: async (args, exec) => {
        let docId
        try {
          docId = this.requireString(args, 'docId')
          const caller = docCallerOf(exec, docId)
          if (caller.error !== undefined) return { error: caller.error }
          const waitMs = typeof args?.waitMs === 'number' && Number.isFinite(args.waitMs)
            ? Math.min(Math.max(0, args.waitMs), DOC_QUEUE_WAIT_MAX_MS)
            : DOC_QUEUE_WAIT_DEFAULT_MS
          const result = await this.acquireDocEdit(docId, caller.sessionId, waitMs)
          return result.granted
            ? { status: 'granted', token: result.token, version: result.version, content: result.content }
            : { status: 'queued', token: result.token }
        } catch (error) {
          return { error: { code: 'begin-failed', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'docboard: begin edit' })

    this.ctx.tools.register({
      name: 'docboard_commit_edit',
      description: 'Commit your held edit turn on a shared document: writes the full replacement Markdown content, quoting the version docboard_begin_edit returned, and releases the turn.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Document id.' },
          token: { type: 'string', description: 'Edit token from docboard_begin_edit.' },
          version: { type: 'integer', description: 'Document version you read when the turn was granted.' },
          content: { type: 'string', description: `The complete new document content (Markdown), up to ${MAX_DOC_CHARS} characters.` },
        },
        required: ['docId', 'token', 'version', 'content'],
      },
      output: { schema: docCommitOutput, render: renderJson },
      execute: async (args, exec) => {
        try {
          const docId = this.requireString(args, 'docId')
          const token = this.requireString(args, 'token')
          if (typeof args?.content !== 'string') throw new Error('content must be a string')
          const caller = docCallerOf(exec, docId)
          if (caller.error !== undefined) return { error: caller.error }
          const next = this.commitDocEdit(docId, caller.sessionId, token, args.version, args.content)
          return { version: next.version, updatedAt: next.updatedAt }
        } catch (error) {
          return { error: { code: 'commit-failed', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'docboard: commit edit' })

    this.ctx.tools.register({
      name: 'docboard_cancel_edit',
      description: 'Abandon a held or queued edit turn on a shared document without writing.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Document id.' },
          token: { type: 'string', description: 'Edit token from docboard_begin_edit.' },
        },
        required: ['docId', 'token'],
      },
      output: { schema: docCancelOutput, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        try {
          const docId = this.requireString(args, 'docId')
          const token = this.requireString(args, 'token')
          const caller = docCallerOf(exec, docId)
          if (caller.error !== undefined) return { error: caller.error }
          this.cancelDocEdit(docId, caller.sessionId, token)
          return { ok: true }
        } catch (error) {
          return { error: { code: 'cancel-failed', message: String(error instanceof Error ? error.message : error) } }
        }
      },
    }, { label: 'docboard: cancel edit' })
  }

  /* ---------------------------------------------------------------- */
  /* HTTP face for the Client half                                     */
  /* ---------------------------------------------------------------- */

  registerRoutes() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        this.handleHttp(req, res).catch(error => {
          this.ctx.logger.warn(`session-blackboard: route failure: ${String(error)}`)
          if (res.headersSent === false) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), 'session-blackboard: routes')
  }

  /** Dispatch one request inside the plugin route prefix. */
  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length)
    const query = url.searchParams

    if (req.method === 'GET' && path === '/catalog') {
      // Real session titles come from the log-backed title service the
      // sidebar itself reads; it may be absent in a bare profile.
      let titleService
      try {
        titleService = this.ctx.get?.('sessionTitle')
      } catch {
        titleService = undefined
      }
      const sessions = this.ctx.sessions.list()
        .filter(session => session.header.origin !== 'subagent')
        .map(session => {
          let title = ''
          try {
            title = titleService?.get(session)?.title ?? ''
          } catch {
            title = ''
          }
          return {
            id: session.id,
            cwd: asString(session.header.cwd, ''),
            name: typeof session.header.cwd === 'string' && session.header.cwd !== ''
              ? basename(session.header.cwd)
              : session.id.slice(0, 8),
            title,
            displayName: this.sessionDisplayName(session.id),
            workspaceId: this.workspaceOf(session.id) ?? null,
            status: this.sessionStatus(session.id),
          }
        })
      const workspaces = this.ctx.workspaceRegistry.list()
        .map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
      sendJson(res, 200, { sessions, workspaces })
      return
    }

    if (req.method === 'GET' && path === '/roster') {
      const limit = Number(query.get('limit') ?? '50')
      const entries = [...this.store.activity.values()]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_ACTIVITY) : 50)
      sendJson(res, 200, { activity: entries.map(entry => this.activityWire(entry)) })
      return
    }

    if (req.method === 'GET' && path === '/boards') {
      const sessionId = query.get('sessionId') ?? ''
      sendJson(res, 200, { boards: this.boards().map(board => this.boardSummary(board, sessionId)) })
      return
    }

    const messagesMatch = /^\/boards\/([^/]+)\/messages$/.exec(path)
    if (req.method === 'GET' && messagesMatch !== null) {
      const board = this.board(decodeURIComponent(messagesMatch[1]))
      if (board === undefined) {
        sendJson(res, 404, { error: 'board not found' })
        return
      }
      const after = Number(query.get('after') ?? '0')
      const since = Number.isInteger(after) && after >= 0 ? after : 0
      const all = this.messagesOf(board.id)
      sendJson(res, 200, {
        boardId: board.id,
        maxSeq: all.length === 0 ? 0 : all[all.length - 1].seq,
        messages: all.filter(message => message.seq > since).map(message => this.messageWire(message, board)),
      })
      return
    }

    if (req.method === 'POST' && path === '/boards') {
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { error: 'malformed body' })
        return
      }
      try {
        const board = await this.createBoard(body)
        sendJson(res, 200, { board: this.boardSummary(board, '') })
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    if (req.method === 'POST' && messagesMatch !== null) {
      const boardId = decodeURIComponent(messagesMatch[1])
      const body = await readJsonBody(req)
      if (body === null || typeof body.text !== 'string') {
        sendJson(res, 400, { error: 'text is required' })
        return
      }
      try {
        const message = await this.postMessage(boardId, body.text, 'user', null)
        sendJson(res, 200, { message: this.messageWire(message, this.board(boardId)) })
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    const deleteMatch = /^\/boards\/([^/]+)$/.exec(path)
    if (req.method === 'DELETE' && deleteMatch !== null) {
      try {
        await this.deleteBoard(decodeURIComponent(deleteMatch[1]))
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    if (req.method === 'GET' && path === '/stream') {
      this.openStream(req, res)
      return
    }

    // ---- Document blackboards (shared documents, queued editing) ----

    if (req.method === 'GET' && path === '/docs') {
      const sessionId = query.get('sessionId') ?? ''
      sendJson(res, 200, { docs: this.docs().map(doc => this.docSummary(doc, sessionId)) })
      return
    }

    if (req.method === 'POST' && path === '/docs') {
      const body = await readJsonBody(req)
      if (body === null) {
        sendJson(res, 400, { error: 'malformed body' })
        return
      }
      try {
        const doc = await this.createDoc(body)
        sendJson(res, 200, { doc: this.docSummary(doc, '') })
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    const docMatch = /^\/docs\/([^/]+)$/.exec(path)
    if (docMatch !== null) {
      const docId = decodeURIComponent(docMatch[1])
      const doc = this.doc(docId)
      if (doc === undefined) {
        sendJson(res, 404, { error: 'document not found' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { doc: this.docSummary(doc, query.get('sessionId') ?? ''), content: doc.content })
        return
      }
      if (req.method === 'DELETE') {
        try {
          await this.deleteDoc(docId)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
        }
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    const docEditMatch = /^\/docs\/([^/]+)\/edit\/(begin|commit|cancel|poll)$/.exec(path)
    if (docEditMatch !== null) {
      const docId = decodeURIComponent(docEditMatch[1])
      const action = docEditMatch[2]
      const who = query.get('who') === 'user' ? 'user' : (query.get('who') ?? '')
      const body = action === 'begin' ? {} : await readJsonBody(req)
      if (action !== 'begin' && body === null) {
        sendJson(res, 400, { error: 'malformed body' })
        return
      }
      try {
        if (action === 'begin') {
          const waitMs = Number(query.get('waitMs') ?? String(DOC_QUEUE_WAIT_DEFAULT_MS))
          const result = await this.acquireDocEdit(docId, who || 'user', Number.isFinite(waitMs) ? waitMs : DOC_QUEUE_WAIT_DEFAULT_MS)
          sendJson(res, 200, result)
        } else if (action === 'poll') {
          const docNow = this.doc(docId)
          if (docNow === undefined) throw new Error('document not found')
          sendJson(res, 200, { doc: this.docSummary(docNow, who) })
        } else if (action === 'commit') {
          if (typeof body?.token !== 'string' || typeof body?.content !== 'string') {
            throw new Error('token and content are required')
          }
          const next = this.commitDocEdit(docId, who || 'user', body.token, Number(body.expectedVersion), body.content)
          sendJson(res, 200, { version: next.version, updatedAt: next.updatedAt })
        } else {
          this.cancelDocEdit(docId, who || 'user', typeof body?.token === 'string' ? body.token : '')
          sendJson(res, 200, { ok: true })
        }
      } catch (error) {
        sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  /** One SSE connection fed by the store's change notifications. */
  openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write('event: hello\ndata: {"domain":"session_blackboard"}\n\n')
    const onChange = change => {
      const payload = JSON.stringify({ table: change.table, key: change.key, operation: change.operation })
      res.write(`event: changed\ndata: ${payload}\n\n`)
    }
    this.listeners.add(onChange)
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n')
    }, HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      this.listeners.delete(onChange)
      res.end()
    })
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Load the store, then register the routes, tools, and per-agent sections. */
  async start() {
    this.store.load()
    this.registerRoutes()
    this.registerTools()
    this.ctx.on('agent/created', ({ agent }) => this.trackAgent(agent))
    this.ctx.on('agent/disposed', ({ agent }) => this.forgetAgent(agent.session.id))
    // Session lifecycle roster: creation/return, archive, unarchive, and
    // departure are all recorded so boards can flag (and cut off) members
    // that are gone. Serial listeners may await these handlers, so the
    // creation path can resolve a workspace even before the attach lands.
    this.ctx.on('agent/created', ({ agent }) => this.trackSessionJoined(agent.session.id))
    this.ctx.on('agent/disposed', ({ agent }) => {
      if (this.stopping) return
      this.trackSessionLeft(agent.session.id)
    })
    this.ctx.on('workspace/session-archived', ({ sessionId }) => {
      this.invalidateWorkspaceIndex()
      this.trackSessionArchived(sessionId)
    })
    this.ctx.on('workspace/session-unarchiving', ({ sessionId }) => {
      this.invalidateWorkspaceIndex()
      this.trackSessionUnarchived(sessionId)
    })
    // Agents that were already live when this plugin activated get the same
    // guidance section; without it they would never learn about their boards.
    for (const agent of this.ctx.agents.list()) this.trackAgent(agent)
    this.ctx.effect(() => () => this.disposeSections(), 'session-blackboard: sections')
  }

  /** Tear down what start() set up beyond context-owned registrations. */
  stop() {
    this.stopping = true
    this.disposeSections()
    this.listeners.clear()
  }
}

/**
 * Plugin entry. start() awaits nothing today, but it stays async-shaped so
 * the domain-backed variant this grew from can return without rework; the
 * effect's disposer undoes everything context-owned registrations cannot.
 */
export function apply(ctx) {
  const blackboards = new Blackboards(ctx)
  ctx.effect(() => {
    blackboards.start().catch(error => {
      ctx.logger.error(`session-blackboard: failed to start: ${String(error)}`)
    })
    return () => blackboards.stop()
  }, 'session-blackboard: start')
}
