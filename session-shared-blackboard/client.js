/**
 * Client half of the session-shared-blackboard bundle.
 *
 * Registers two right-sidebar tab types through the public two-stage
 * protocol (type in `ctx.sidebarRightTabs`, body under the keyed
 * `sidebar.right.pane.tab` seat):
 *
 * - "Agent group chat" (kind `agent-chat`): chat rooms between the user and
 *   several member sessions/workspaces. Member messages gather on the LEFT
 *   under their member labels with deterministic avatars, the user's on the
 *   RIGHT; every bubble renders Markdown; @label mentions actively ping.
 * - "Blackboard" (kind `docboard`): one shared Markdown document per board.
 *   Everyone reads freely; edits serialize through a queue — the editor
 *   joins the queue, receives the content CURRENT at grant time, and commits
 *   quoting that version (fresh-read guarantee).
 *
 * Data comes from this bundle's Host half over same-origin plugin routes
 * (JSON + one SSE stream); see index.js for why plain HTTP is used.
 */
window.__ModuleLoader__.load({
  id: '@local/session-shared-blackboard',
  factory(require) {
    const React = require('react')
    const {
      Fragment, useEffect, useMemo, useRef, useState,
    } = React
    const h = React.createElement

    const NS = 'sessionBlackboard'
    /** Identity in the tab system: registration keys and type ids. */
    const PANEL_ID = '@local/session-shared-blackboard'
    /** Tab kind of the agent group chat. */
    const CHAT_KIND = 'agent-chat'
    /** Tab kind of the shared document blackboard. */
    const DOC_KIND = 'docboard'
    /** Base of the Host half's plugin routes. */
    const API = '/plugins/session-blackboard'
    /** Debounce window that collapses a burst of SSE change events. */
    const REFETCH_DEBOUNCE_MS = 200
    /** Most members the create dialog offers (the Host accepts the same). */
    const MAX_MEMBERS = 8
    /** Doc edit-state polling cadence while a doc tab is open. */
    const DOC_POLL_MS = 1500
    /** How long one user begin-edit call parks in the queue before polling. */
    const DOC_USER_WAIT_MS = 8000

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copies of locale/*.json, minus metadata)      */
    /* ------------------------------------------------------------------ */

    const en = {
      'chat.tab.title': 'Agent group chat',
      'chat.guide.title': 'Agent group chat',
      'chat.guide.description': 'Chat rooms between you and several sessions or workspaces',
      'doc.tab.title': 'Blackboards',
      'doc.guide.title': 'Blackboards',
      'doc.guide.description': 'Shared Markdown documents with queued editing',
      'list.empty': 'Nothing here yet. Create one to start.',
      'list.new': 'New',
      'list.delete': 'Delete',
      'list.deleteConfirm': 'Delete this and all its content?',
      'list.count': '{n} messages',
      'list.doc.version': 'v{n}',
      'chat.back': 'Back',
      'chat.empty': 'No messages yet. Say hello — or let the member agents find the room on their next turn.',
      'chat.you': 'you',
      'chat.members': 'Members',
      'chat.send': 'Send',
      'chat.sendBusy': 'Sending…',
      'chat.placeholder': 'Message the room…',
      'chat.mentionHint': '@label mentions that member (actively pings them to check the room); @all pings everyone.',
      'chat.agentUnread': '{n} unread for this session',
      'chat.activity': 'Member activity',
      'activity.joined': 'joined',
      'activity.returned': 'returned',
      'activity.archived': 'was archived',
      'activity.unarchived': 'was unarchived',
      'activity.left': 'has left',
      'status.archivedShort': 'archived',
      'status.departedShort': 'left',
      'status.removedShort': 'removed',
      'doc.back': 'Back',
      'doc.emptyBody': 'This blackboard is empty. Be the first to write.',
      'doc.edit': 'Edit',
      'doc.editing': 'Editing…',
      'doc.queue': 'Queued',
      'doc.queuePosition': 'Queued · position {n}',
      'doc.heldBy': 'Edit turn: {who}',
      'doc.heldByYou': 'Edit turn: you',
      'doc.queueLength': '{n} waiting',
      'doc.free': 'Free to edit',
      'doc.refresh': 'Refresh',
      'doc.save': 'Save',
      'doc.saveBusy': 'Saving…',
      'doc.cancel': 'Cancel',
      'doc.editorNote': 'Content loaded fresh when your turn was granted (v{n}); Save writes your full replacement.',
      'doc.updated': 'Updated {time} · v{n}',
      'error.load': 'Could not load data: {message}',
      'error.send': 'Could not send: {message}',
      'error.create': 'Could not create: {message}',
      'error.edit': 'Edit failed: {message}',
      'retry': 'Retry',
      'create.title': 'New shared board',
      'create.chat': 'Agent group chat',
      'create.doc': 'Blackboard (document)',
      'create.boardTitle': 'Name',
      'create.boardTitlePlaceholderChat': 'e.g. Research ↔ Implementation',
      'create.boardTitlePlaceholderDoc': 'e.g. API alignment notes',
      'create.member': 'Member {n}',
      'create.memberLabel': 'Label',
      'create.kindSession': 'Session',
      'create.kindWorkspace': 'Workspace',
      'create.pickSession': 'Pick a session',
      'create.pickWorkspace': 'Pick a workspace',
      'create.pickWorkspaceFirst': 'Filter by workspace…',
      'create.noWorkspace': '(no workspace)',
      'create.sessionOption': '{name} ({id})',
      'create.workspaceOption': '{title} — {path}',
      'create.addMember': 'Add member',
      'create.removeMember': 'Remove',
      'create.submit': 'Create',
      'create.busy': 'Creating…',
      'create.cancel': 'Cancel',
      'create.hint': 'Members may mix single sessions and whole workspaces; every session in a workspace joins as that member — including sessions created later. Sessions are named "workspace-session".',
      'create.workspaceQuick': 'Start from a workspace',
      'create.workspaceQuickBtn': 'Use this workspace',
      'create.workspaceQuickHint': 'Creates the board with this whole workspace as its only member: every session in it joins automatically, and sessions created there later register themselves.',
      'create.archivedMark': '(archived)',
      'time.now': 'now',
      'time.minute': '{n}m',
      'time.hour': '{n}h',
      'time.day': '{n}d',
      'unread.badge': '{n} unread',
    }

    const zh = {
      'chat.tab.title': '智能体群聊',
      'chat.guide.title': '智能体群聊',
      'chat.guide.description': '你与多个会话、工作区之间的聊天室',
      'doc.tab.title': '黑板',
      'doc.guide.title': '黑板',
      'doc.guide.description': '共享 Markdown 文档，编辑排队进行',
      'list.empty': '还没有内容。新建一块开始。',
      'list.new': '新建',
      'list.delete': '删除',
      'list.deleteConfirm': '删除及其全部内容？',
      'list.count': '{n} 条消息',
      'list.doc.version': 'v{n}',
      'chat.back': '返回',
      'chat.empty': '还没有消息。打个招呼——或者让成员智能体在下一回合自行发现这里。',
      'chat.you': '我',
      'chat.members': '成员',
      'chat.send': '发送',
      'chat.sendBusy': '发送中…',
      'chat.placeholder': '发言…',
      'chat.mentionHint': '输入 @标签 可提及该成员（主动提醒对方查看）；@all 提及全体。',
      'chat.agentUnread': '本会话有 {n} 条未读',
      'chat.activity': '成员动态',
      'activity.joined': '加入',
      'activity.returned': '重新上线',
      'activity.archived': '已被归档',
      'activity.unarchived': '已取消归档',
      'activity.left': '已离开',
      'status.archivedShort': '已归档',
      'status.departedShort': '已离开',
      'status.removedShort': '已移除',
      'doc.back': '返回',
      'doc.emptyBody': '这块黑板还是空的。来写第一笔。',
      'doc.edit': '编辑',
      'doc.editing': '编辑中…',
      'doc.queue': '排队中',
      'doc.queuePosition': '排队中 · 第 {n} 位',
      'doc.heldBy': '编辑权：{who}',
      'doc.heldByYou': '编辑权：你',
      'doc.queueLength': '{n} 人等候',
      'doc.free': '空闲可编辑',
      'doc.refresh': '刷新',
      'doc.save': '保存',
      'doc.saveBusy': '保存中…',
      'doc.cancel': '取消',
      'doc.editorNote': '内容在获得编辑权时最新读取（v{n}）；保存将整体替换为你编辑的全文。',
      'doc.updated': '更新于 {time} · v{n}',
      'error.load': '无法加载数据：{message}',
      'error.send': '发送失败：{message}',
      'error.create': '创建失败：{message}',
      'error.edit': '编辑失败：{message}',
      'retry': '重试',
      'create.title': '新建共享板',
      'create.chat': '智能体群聊',
      'create.doc': '黑板（文档）',
      'create.boardTitle': '名称',
      'create.boardTitlePlaceholderChat': '例如：论文科研 ↔ 工程实现',
      'create.boardTitlePlaceholderDoc': '例如：API 对齐笔记',
      'create.member': '成员 {n}',
      'create.memberLabel': '标签',
      'create.kindSession': '会话',
      'create.kindWorkspace': '工作区',
      'create.pickSession': '选择会话',
      'create.pickWorkspace': '选择工作区',
      'create.pickWorkspaceFirst': '先按工作区筛选…',
      'create.noWorkspace': '（无工作区）',
      'create.sessionOption': '{name}（{id}）',
      'create.workspaceOption': '{title} — {path}',
      'create.addMember': '添加成员',
      'create.removeMember': '移除',
      'create.submit': '创建',
      'create.busy': '创建中…',
      'create.cancel': '取消',
      'create.hint': '成员可混合单个会话与整个工作区；工作区中的所有会话都算该成员——之后新建的会话也会自动注册。会话以“工作区-会话”命名。',
      'create.workspaceQuick': '从工作区发起',
      'create.workspaceQuickBtn': '以此工作区开板',
      'create.workspaceQuickHint': '以整个工作区为唯一成员开板：其中所有会话自动加入，之后在该工作区新建的会话也会自动注册进群聊/黑板。',
      'create.archivedMark': '（已归档）',
      'time.now': '刚刚',
      'time.minute': '{n} 分钟',
      'time.hour': '{n} 小时',
      'time.day': '{n} 天',
      'unread.badge': '{n} 条未读',
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

    const loadBoards = sessionId => callApi(`/boards${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`)
    const loadMessages = (boardId, after) => callApi(`/boards/${encodeURIComponent(boardId)}/messages?after=${after}`)
    const loadDocs = sessionId => callApi(`/docs${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`)
    const loadDoc = (docId, sessionId) => callApi(`/docs/${encodeURIComponent(docId)}${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`)
    const loadCatalog = () => callApi('/catalog')
    const createBoard = input => callApi('/boards', { method: 'POST', body: input })
    const createDoc = input => callApi('/docs', { method: 'POST', body: input })
    const postMessage = (boardId, text) => callApi(
      `/boards/${encodeURIComponent(boardId)}/messages`,
      { method: 'POST', body: { text } },
    )
    const deleteBoard = boardId => callApi(`/boards/${encodeURIComponent(boardId)}`, { method: 'DELETE' })
    const deleteDoc = docId => callApi(`/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' })
    const beginDocEdit = (docId, who, waitMs) => callApi(
      `/docs/${encodeURIComponent(docId)}/edit/begin?who=${encodeURIComponent(who)}&waitMs=${waitMs}`,
      { method: 'POST' },
    )
    const commitDocEdit = (docId, who, body) => callApi(
      `/docs/${encodeURIComponent(docId)}/edit/commit?who=${encodeURIComponent(who)}`,
      { method: 'POST', body },
    )
    const cancelDocEdit = (docId, who, token) => callApi(
      `/docs/${encodeURIComponent(docId)}/edit/cancel?who=${encodeURIComponent(who)}`,
      { method: 'POST', body: { token } },
    )

    /** Shared change bus fed by the SSE stream; every view refetches on a bump. */
    function createChangeBus() {
      const listeners = new Set()
      let source = null
      let revision = 0
      let bumpTimer = null
      const emit = () => {
        for (const listener of [...listeners]) {
          try { listener() } catch { /* one consumer cannot break the others */ }
        }
      }
      const scheduleBump = () => {
        if (bumpTimer !== null) return
        bumpTimer = setTimeout(() => {
          bumpTimer = null
          revision += 1
          emit()
        }, REFETCH_DEBOUNCE_MS)
      }
      return {
        getRevision: () => revision,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /** Ensure the SSE connection exists; a failure falls back to revision 0. */
        ensureStream() {
          if (source !== null || typeof EventSource !== 'function') return
          try {
            source = new EventSource(`${API}/stream`)
            source.addEventListener('changed', scheduleBump)
            source.onerror = () => {
              /* EventSource retries on its own; views also refetch on remount. */
            }
          } catch {
            source = null
          }
        },
        dispose() {
          if (bumpTimer !== null) clearTimeout(bumpTimer)
          listeners.clear()
          source?.close()
          source = null
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    function relativeTime(iso, now) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const delta = Math.max(0, now - at)
      if (delta < 60_000) return 'now'
      if (delta < 3_600_000) return { key: 'time.minute', n: Math.floor(delta / 60_000) }
      if (delta < 86_400_000) return { key: 'time.hour', n: Math.floor(delta / 3_600_000) }
      return { key: 'time.day', n: Math.floor(delta / 86_400_000) }
    }

    /** Subscribe one component to one observable store. */
    function useStore(store) {
      const [value, setValue] = useState(store.getRevision)
      useEffect(() => store.subscribe(() => setValue(store.getRevision())), [store])
      return value
    }

    /** The label a message shows: members use their label, the user is you. */
    function authorLabel(message, board, t) {
      if (message.authorKind === 'user' || message.sideKey === 'user') return t('chat.you')
      return message.sideLabel
        ?? board.sides.find(side => side.key === message.sideKey)?.label
        ?? message.sideKey
    }

    /** Deterministic hue for one avatar label. */
    function hashHue(label) {
      let hash = 0
      for (const char of label) hash = (hash * 31 + char.codePointAt(0)) >>> 0
      return hash % 360
    }

    /** Round avatar chip with the label's first character. */
    function Avatar({ label, user, size }) {
      const trimmed = label.trim()
      const initial = [...trimmed][0]?.toUpperCase() ?? '?'
      const style = user === true
        ? { background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)' }
        : { background: `hsl(${hashHue(trimmed)} 48% 46%)`, color: '#fff' }
      return h('span', {
        className: 'sbb-avatar',
        style: size === undefined ? style : { ...style, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` },
        'aria-hidden': true,
      }, initial)
    }

    /** Human suffix for one member's non-active lifecycle status ('' when fine). */
    const ACTIVITY_TYPES = ['joined', 'returned', 'archived', 'unarchived', 'left']
    function sideGoneMark(side, t) {
      if (side?.status === 'archived') return t('status.archivedShort')
      if (side?.status === 'departed') return t('status.departedShort')
      if (side?.status === 'removed') return t('status.removedShort')
      return ''
    }

    /** One member chip: label plus an archival/left mark when it is gone. */
    function MemberChip({ side, mine, t }) {
      const mark = sideGoneMark(side, t)
      return h('span', {
        className: `sbb-chip ${mine ? 'sbb-mine' : ''}${mark === '' ? '' : ' sbb-gone'}`,
        title: `${side.kind}: ${side.refTitle}${mark === '' ? '' : ` — ${mark}`}`,
      }, mark === '' ? side.label : `${side.label} ${mark}`)
    }

    /** Recent member lifecycle events of one board, newest first. */
    function ActivityList({ activity, t }) {
      if (!Array.isArray(activity) || activity.length === 0) return null
      return h('div', { className: 'sbb-activity' },
        h('span', { className: 'sbb-roster-label' }, `${t('chat.activity')}:`),
        h('div', { className: 'sbb-activity-rows' },
          activity.map(entry => {
            const time = relativeTime(entry.at, Date.now())
            const timeText = typeof time === 'string' ? t('time.now') : t(time.key, { n: time.n })
            const who = `${entry.displayName ?? entry.sessionId}${entry.label != null ? ` (${entry.label})` : ''}`
            return h('div', { key: entry.id, className: 'sbb-activity-row' },
              h('span', { className: 'sbb-activity-what' },
                ACTIVITY_TYPES.includes(entry.type) ? t(`activity.${entry.type}`) : entry.type),
              h('span', { className: 'sbb-activity-who' }, who),
              h('span', { className: 'sbb-activity-when' }, timeText),
            )
          }),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Markdown (small, safe: React elements, never raw HTML)              */
    /* ------------------------------------------------------------------ */

    const INLINE_RE = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]\n]+)\]\((https?:[^)\s]+)\))/g

    /** Inline spans of one text run: code, bold, italic, and safe links. */
    function inlineNodes(text, prefix) {
      const nodes = []
      let cursor = 0
      let match
      INLINE_RE.lastIndex = 0
      while ((match = INLINE_RE.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
        if (match[2] !== undefined) {
          nodes.push(h('code', { key: `${prefix}-c${nodes.length}`, className: 'sbb-md-code' }, match[2]))
        } else if (match[4] !== undefined) {
          nodes.push(h('strong', { key: `${prefix}-b${nodes.length}` }, match[4]))
        } else if (match[6] !== undefined) {
          nodes.push(h('em', { key: `${prefix}-i${nodes.length}` }, match[6]))
        } else if (match[9] !== undefined && match[8] !== undefined) {
          nodes.push(h('a', {
            key: `${prefix}-a${nodes.length}`,
            href: match[9],
            target: '_blank',
            rel: 'noopener noreferrer',
          }, match[8]))
        }
        cursor = match.index + match[0].length
      }
      if (cursor < text.length) nodes.push(text.slice(cursor))
      return nodes
    }

    /** Merge consecutive list marker lines of one kind into a single list. */
    function collectList(lines, start, ordered) {
      const marker = ordered ? /^\d+[.、]\s+(.*)$/ : /^[-*]\s+(.*)$/
      const items = []
      let i = start
      while (i < lines.length) {
        const line = lines[i]
        const hit = marker.exec(line)
        if (hit === null) break
        items.push(hit[1])
        i += 1
      }
      return { items, end: i }
    }

    /** Render one Markdown text as React elements (headings, lists, quotes, fences, inline). */
    function Markdown({ text }) {
      const blocks = []
      const lines = String(text ?? '').split('\n')
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === '') {
          i += 1
          continue
        }
        const fence = /^\s*```/.exec(line)
        if (fence !== null) {
          const code = []
          i += 1
          while (i < lines.length && /^\s*```/.exec(lines[i]) === null) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(h('pre', { key: `f${blocks.length}`, className: 'sbb-md-pre' },
            h('code', null, code.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = Math.min(6, heading[1].length)
          blocks.push(h(`h${level}`, { key: `h${blocks.length}`, className: 'sbb-md-h' },
            inlineNodes(heading[2], `h${blocks.length}`)))
          i += 1
          continue
        }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
          blocks.push(h('hr', { key: `r${blocks.length}`, className: 'sbb-md-hr' }))
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const { items, end } = collectList(lines, i, false)
          blocks.push(h('ul', { key: `u${blocks.length}`, className: 'sbb-md-list' },
            items.map((item, index) => h('li', { key: index }, inlineNodes(item, `u${blocks.length}-${index}`)))))
          i = end
          continue
        }
        if (/^\s*\d+[.、]\s+/.test(line)) {
          const { items, end } = collectList(lines, i, true)
          blocks.push(h('ol', { key: `o${blocks.length}`, className: 'sbb-md-list' },
            items.map((item, index) => h('li', { key: index }, inlineNodes(item, `o${blocks.length}-${index}`)))))
          i = end
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            quote.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: `q${blocks.length}`, className: 'sbb-md-quote' },
            inlineNodes(quote.join(' '), `q${blocks.length}`)))
          continue
        }
        const para = []
        while (i < lines.length && lines[i].trim() !== ''
          && /^\s*```/.exec(lines[i]) === null
          && /^(#{1,6})\s+/.exec(lines[i]) === null
          && !/^\s*[-*]\s+/.test(lines[i])
          && !/^\s*\d+[.、]\s+/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        blocks.push(h('p', { key: `p${blocks.length}`, className: 'sbb-md-p' },
          inlineNodes(para.join(' '), `p${blocks.length}`)))
      }
      return h('div', { className: 'sbb-md' }, blocks)
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.sbb-panel { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }
.sbb-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 10px 12px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.sbb-head-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.sbb-head-sub { flex: none; display: flex; align-items: center; gap: 6px; }
.sbb-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; height: 26px; min-width: 26px; padding: 0 5px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.sbb-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sbb-icon-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.sbb-icon-btn.sbb-danger { color: var(--dsw-alias-state-error-primary); }
.sbb-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.sbb-roster { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 12px 0; }
.sbb-roster-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.sbb-chip { padding: 0 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.sbb-chip.sbb-mine { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.sbb-chip.sbb-gone { opacity: 0.55; border-style: dashed; }
.sbb-activity { display: flex; flex-direction: column; gap: 3px; padding: 4px 12px 0; }
.sbb-activity-rows { display: flex; flex-direction: column; gap: 1px; }
.sbb-activity-row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.sbb-activity-who { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sbb-activity-when { margin-inline-start: auto; flex: none; }
.sbb-quick-row { display: flex; align-items: center; gap: 6px; }
.sbb-list { display: flex; flex-direction: column; gap: 4px; padding: 10px 10px 12px; }
.sbb-card { display: flex; flex-direction: column; gap: 3px; padding: 9px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); cursor: pointer; text-align: left; color: inherit; font: inherit; width: 100%; box-sizing: border-box; }
.sbb-card:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sbb-card:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.sbb-card-top { display: flex; align-items: center; gap: 6px; }
.sbb-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sbb-badge { flex: none; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11px; line-height: 16px; }
.sbb-card-sides { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sbb-card-last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.sbb-empty { padding: 24px 16px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; text-align: center; }
.sbb-notice { padding: 6px 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.sbb-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.sbb-error button { flex: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; padding: 2px 8px; cursor: pointer; }
.sbb-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; font-size: 13px; font-weight: 600; user-select: none; -webkit-user-select: none; }
.sbb-chat { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 16px; }
.sbb-msg { display: flex; gap: 8px; max-width: 90%; }
.sbb-msg.sbb-peer { align-self: flex-start; align-items: flex-start; }
.sbb-msg.sbb-mine { align-self: flex-end; align-items: flex-start; flex-direction: row-reverse; }
.sbb-msg-col { display: flex; flex-direction: column; min-width: 0; }
.sbb-msg-head { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 0 2px 2px; }
.sbb-msg.sbb-mine .sbb-msg-head { flex-direction: row-reverse; }
.sbb-msg-label { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sbb-bubble { padding: 7px 10px; border-radius: 12px; border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); word-break: break-word; line-height: 20px; overflow: hidden; }
.sbb-msg.sbb-peer .sbb-bubble { border-bottom-left-radius: 4px; }
.sbb-msg.sbb-mine .sbb-bubble { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); border-bottom-right-radius: 4px; }
.sbb-composer { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.sbb-mention-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 16px; }
.sbb-composer-row { display: flex; align-items: flex-end; gap: 6px; }
.sbb-input { flex: 1; min-width: 0; height: 32px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 8px; }
.sbb-textarea { flex: 1; min-width: 0; height: 54px; resize: vertical; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; padding: 6px 8px; }
.sbb-input:focus, .sbb-textarea:focus, .sbb-select:focus { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -1px; }
.sbb-send { flex: none; display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 12px; border: none; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font: inherit; font-size: 13px; cursor: pointer; }
.sbb-send:disabled { opacity: 0.5; cursor: default; }
.sbb-backdrop { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); padding: 20px; box-sizing: border-box; }
.sbb-modal { width: min(400px, 100%); max-height: 100%; display: flex; flex-direction: column; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.sbb-modal-title { flex: none; padding: 14px 16px 6px; font-size: 15px; font-weight: 600; }
.sbb-modal-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 6px 16px 4px; }
.sbb-field { display: flex; flex-direction: column; gap: 4px; }
.sbb-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sbb-modal-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px; }
.sbb-modal-error { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.sbb-modal-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 16px; }
.sbb-button { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; }
.sbb-button-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.sbb-button:disabled { opacity: 0.5; cursor: default; }
.sbb-member-row { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); }
.sbb-member-row-top { display: flex; align-items: center; gap: 4px; }
.sbb-member-row-title { flex: 1; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sbb-select { flex: 1; min-width: 0; height: 32px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 8px; }
.sbb-member-kind { flex: none; width: 112px; }
.sbb-member-label { flex: 1 1 auto; }
.sbb-member-ref { flex: 1 1 auto; }
.sbb-member-controls { display: flex; align-items: center; gap: 6px; }
.sbb-add-member { align-self: flex-start; }
.sbb-type-toggle { display: flex; gap: 6px; }
.sbb-doc-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sbb-doc-state { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); font-size: 11px; }
.sbb-doc-state.sbb-busy { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sbb-doc-state.sbb-free { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.sbb-doc-content { padding: 10px 14px 20px; }
.sbb-doc-editor { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.sbb-doc-editor textarea { min-height: 200px; font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace); }
.sbb-doc-actions { display: flex; align-items: center; gap: 6px; }
.sbb-doc-actions-row { display: flex; align-items: center; gap: 6px; padding: 6px 12px 10px; }
.sbb-md { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sbb-md-p { margin: 0; white-space: pre-wrap; }
.sbb-md-h { margin: 2px 0 0; line-height: 1.3; }
.sbb-md-h.h1, .sbb-md-h.h2 { font-size: 15px; }
.sbb-md-h.h3, .sbb-md-h.h4 { font-size: 14px; }
.sbb-md-list { margin: 0; padding-inline-start: 20px; display: flex; flex-direction: column; gap: 2px; }
.sbb-md-quote { margin: 0; padding: 2px 10px; border-inline-start: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.sbb-md-pre { margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); overflow-x: auto; font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace); font-size: 12px; line-height: 18px; }
.sbb-md-code { padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace); font-size: 12px; }
.sbb-md-hr { border: none; border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 4px 0; }
.sbb-md a { color: inherit; text-decoration: underline; }
`

    /* ------------------------------------------------------------------ */
    /* Chat components                                                     */
    /* ------------------------------------------------------------------ */

    /** One chat bubble row: avatar + label + Markdown body; you on the right. */
    function MessageRow({ message, board, t }) {
      const mine = message.authorKind === 'user' || message.sideKey === 'user'
      const label = authorLabel(message, board, t)
      const now = Date.now()
      const time = relativeTime(message.createdAt, now)
      const timeText = typeof time === 'string' ? t('time.now') : t(time.key, { n: time.n })
      return h('div', { className: `sbb-msg ${mine ? 'sbb-mine' : 'sbb-peer'}` },
        h(Avatar, { label: mine ? t('chat.you') : label, user: mine }),
        h('div', { className: 'sbb-msg-col' },
          h('div', { className: 'sbb-msg-head' },
            h('span', { className: 'sbb-msg-label' }, label),
            h('span', null, timeText),
          ),
          h('div', { className: 'sbb-bubble' }, h(Markdown, { text: message.text })),
        ),
      )
    }

    /** Chat-room list with member chips, unread badges, and the latest excerpt. */
    function BoardList({ boards, t, onOpen, deletingId, onDeleteIntent }) {
      if (boards.length === 0) {
        return h('div', { className: 'sbb-empty' }, t('list.empty'))
      }
      return h('div', { className: 'sbb-list' },
        boards.map(board => h('div', { key: board.id, className: 'sbb-card', role: 'button', tabIndex: 0,
          onClick: () => onOpen(board.id),
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(board.id) } },
        },
        h('div', { className: 'sbb-card-top' },
          h('span', { className: 'sbb-card-title', title: board.title }, board.title),
          board.unread !== null && board.unread > 0
            ? h('span', { className: 'sbb-badge', title: t('chat.agentUnread', { n: board.unread }) }, String(board.unread))
            : null,
          h('button', {
            type: 'button',
            className: `sbb-icon-btn ${deletingId === board.id ? 'sbb-danger' : ''}`,
            onClick: event => { event.stopPropagation(); onDeleteIntent(board.id) },
            onKeyDown: event => event.stopPropagation(),
          }, deletingId === board.id ? t('list.deleteConfirm') : t('list.delete')),
        ),
        h('div', { className: 'sbb-card-sides' },
          board.sides.map(side => h(MemberChip, { key: side.key, side, mine: side.key === board.mySideKey, t })),
          h('span', null, `· ${t('list.count', { n: board.messageCount })}`),
        ),
        board.lastMessage !== null
          ? h('div', { className: 'sbb-card-last' },
            `${board.lastMessage.authorKind === 'user' || board.lastMessage.sideKey === 'user'
              ? t('chat.you')
              : board.sides.find(side => side.key === board.lastMessage.sideKey)?.label ?? ''}: ${board.lastMessage.excerpt}`)
          : null,
        )),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Document blackboard components                                     */
    /* ------------------------------------------------------------------ */

    /** The document list. */
    function DocList({ docs, t, onOpen, deletingId, onDeleteIntent }) {
      if (docs.length === 0) {
        return h('div', { className: 'sbb-empty' }, t('list.empty'))
      }
      return h('div', { className: 'sbb-list' },
        docs.map(doc => h('div', { key: doc.id, className: 'sbb-card', role: 'button', tabIndex: 0,
          onClick: () => onOpen(doc.id),
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(doc.id) } },
        },
        h('div', { className: 'sbb-card-top' },
          h('span', { className: 'sbb-card-title', title: doc.title }, doc.title),
          h('span', { className: 'sbb-card-sides' }, t('list.doc.version', { n: doc.version })),
          h('button', {
            type: 'button',
            className: `sbb-icon-btn ${deletingId === doc.id ? 'sbb-danger' : ''}`,
            onClick: event => { event.stopPropagation(); onDeleteIntent(doc.id) },
            onKeyDown: event => event.stopPropagation(),
          }, deletingId === doc.id ? t('list.deleteConfirm') : t('list.delete')),
        ),
        h('div', { className: 'sbb-card-sides' },
          doc.sides.map(side => h(MemberChip, { key: side.key, side, mine: side.key === doc.mySideKey, t })),
        ),
        doc.excerpt !== '' ? h('div', { className: 'sbb-card-last' }, doc.excerpt) : null,
        )),
      )
    }

    /** Live edit-state chip of one document. */
    function DocStateChip({ edit, t }) {
      const holder = edit?.holder
      if (holder === null || holder === undefined) {
        return h('span', { className: 'sbb-doc-state sbb-free' }, t('doc.free'))
      }
      const waiting = (edit.queue?.length ?? 0) > 0 ? ` · ${t('doc.queueLength', { n: edit.queue.length })}` : ''
      return h('span', { className: 'sbb-doc-state sbb-busy' },
        holder.owner === 'user' ? t('doc.heldByYou') : t('doc.heldBy', { who: holder.ownerName ?? holder.owner }),
        waiting)
    }

    /**
     * The blackboard tab body: rendered document + queue-based editing.
     * The user's edit flow mirrors the agents': begin (join queue) → wait for
     * the turn → the editor opens with the content CURRENT at grant time →
     * Save commits quoting that version → the turn passes to the next waiter.
     */
    function DocTab(props) {
      const sessionId = props.sessionId
      const t = props.t
      const changes = props.changes
      const revision = useStore(changes)
      const [view, setView] = useState('list')
      const [docId, setDocId] = useState(null)
      const [docs, setDocs] = useState(null)
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState(null)
      const [retry, setRetry] = useState(0)
      const [deletingId, setDeletingId] = useState(null)
      const [creating, setCreating] = useState(false)
      /** Edit session: idle | waiting | editing; carries token/version/draft. */
      const [edit, setEdit] = useState({ phase: 'idle' })
      const [busy, setBusy] = useState(false)
      const [editError, setEditError] = useState(null)
      const deleteTimer = useRef(null)

      const current = detail?.doc ?? null

      // Reload the document summaries on every change notification.
      useEffect(() => {
        let cancelled = false
        setError(null)
        loadDocs(sessionId).then(value => {
          if (!cancelled) setDocs(value.docs)
        }).catch(err => {
          if (!cancelled) setError(String(err instanceof Error ? err.message : err))
        })
        return () => { cancelled = true }
      }, [sessionId, revision, retry])

      // Load and poll the open document so the edit banner stays live.
      useEffect(() => {
        if (view !== 'doc' || docId === null) {
          setDetail(null)
          return
        }
        let cancelled = false
        let timer = null
        const pull = () => {
          loadDoc(docId, sessionId).then(value => {
            if (cancelled) return
            setDetail(value)
          }).catch(err => {
            if (!cancelled) setEditError(String(err instanceof Error ? err.message : err))
          }).finally(() => {
            if (!cancelled) timer = setTimeout(pull, DOC_POLL_MS)
          })
        }
        pull()
        return () => { cancelled = true; if (timer !== null) clearTimeout(timer) }
      }, [view, docId, sessionId, revision])

      // A waiting editor watches the poll: when the user holds the turn, open
      // the editor with the freshest content.
      useEffect(() => {
        if (edit.phase !== 'waiting' || detail === null) return
        if (detail.doc?.edit?.holder?.owner === 'user' && detail.doc.edit.mineUser) {
          setEdit({ phase: 'editing', token: edit.token, version: detail.doc.version, draft: detail.content ?? '' })
        }
      }, [edit.phase, edit.token, detail])

      // A deleted or vanished document sends the viewer back to the list.
      useEffect(() => {
        if (view === 'doc' && docs !== null && current === null && detail !== null) {
          setView('list')
          setDocId(null)
          setDetail(null)
          setEdit({ phase: 'idle' })
        }
      }, [view, docs, current, detail])

      useEffect(() => () => {
        if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
      }, [])

      const openDoc = id => {
        setDocId(id)
        setView('doc')
        setDetail(null)
        setEdit({ phase: 'idle' })
        setEditError(null)
      }

      const backToList = () => {
        if (edit.phase !== 'idle' && docId !== null && edit.token !== undefined) {
          void cancelDocEdit(docId, 'user', edit.token).catch(() => { /* the lease expires on its own */ })
        }
        setView('list')
        setDocId(null)
        setDetail(null)
        setEdit({ phase: 'idle' })
      }

      const onDeleteIntent = id => {
        if (deletingId !== id) {
          setDeletingId(id)
          if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
          deleteTimer.current = setTimeout(() => setDeletingId(null), 3000)
          return
        }
        setDeletingId(null)
        if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
        deleteDoc(id).catch(() => { /* the next refresh reveals a survivor */ })
          .finally(() => { if (docId === id) backToList() })
      }

      const beginEdit = async () => {
        if (current === null || busy) return
        setBusy(true)
        setEditError(null)
        try {
          const result = await beginDocEdit(current.id, 'user', DOC_USER_WAIT_MS)
          if (result.granted === true) {
            setEdit({ phase: 'editing', token: result.token, version: result.version, draft: result.content ?? '' })
          } else {
            // Parked in the queue: the poll above opens the editor when the
            // turn arrives.
            setEdit({ phase: 'waiting', token: result.token })
          }
        } catch (err) {
          setEditError(String(err instanceof Error ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const saveEdit = async () => {
        if (edit.phase !== 'editing' || current === null || busy) return
        setBusy(true)
        setEditError(null)
        try {
          await commitDocEdit(current.id, 'user', {
            token: edit.token,
            expectedVersion: edit.version,
            content: edit.draft,
          })
          setEdit({ phase: 'idle' })
          const fresh = await loadDoc(current.id, sessionId)
          setDetail(fresh)
        } catch (err) {
          setEditError(String(err instanceof Error ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const cancelEdit = async () => {
        if (current === null || edit.token === undefined) {
          setEdit({ phase: 'idle' })
          return
        }
        setBusy(true)
        try {
          await cancelDocEdit(current.id, 'user', edit.token)
        } catch { /* the lease expires on its own */ }
        finally {
          setBusy(false)
          setEdit({ phase: 'idle' })
        }
      }

      const headTitle = view === 'doc' && current !== null ? current.title : t('doc.tab.title')
      const updated = current === null ? '' : (() => {
        const time = relativeTime(current.updatedAt, Date.now())
        return typeof time === 'string' ? t('time.now') : t(time.key, { n: time.n })
      })()

      return h(Fragment, null,
        h('style', { key: 'sbb-css' }, CSS),
        h('div', { className: 'sbb-panel' },
          h('div', { className: 'sbb-head' },
            view === 'doc'
              ? h('button', { type: 'button', className: 'sbb-icon-btn', onClick: backToList, 'aria-label': t('doc.back') }, '‹')
              : null,
            h('span', { className: 'sbb-head-title', title: headTitle }, headTitle),
            view === 'list'
              ? h('div', { className: 'sbb-head-sub' },
                h('button', {
                  type: 'button',
                  className: 'sbb-icon-btn',
                  onClick: () => setCreating(true),
                }, t('list.new')))
              : null,
          ),
          error !== null
            ? h('div', { className: 'sbb-error' }, t('error.load', { message: error }),
              h('button', { type: 'button', onClick: () => setRetry(x => x + 1) }, t('retry')))
            : null,
          h('div', { className: 'sbb-body' },
            view === 'list'
              ? h(DocList, { docs: docs ?? [], t, onOpen: openDoc, deletingId, onDeleteIntent })
              : current === null
                ? h('div', { className: 'sbb-empty' }, '…')
                : h(Fragment, null,
                  h('div', { className: 'sbb-doc-meta' },
                    h(DocStateChip, { edit: current.edit, t }),
                    h('span', null, t('doc.updated', { time: updated, n: current.version })),
                    current.sides.map(side => h(MemberChip, { key: side.key, side, mine: side.key === current.mySideKey, t })),
                  ),
                  edit.phase === 'editing'
                    ? h('div', { className: 'sbb-doc-editor' },
                      editError !== null ? h('div', { className: 'sbb-modal-error' }, t('error.edit', { message: editError })) : null,
                      h('div', { className: 'sbb-mention-hint' }, t('doc.editorNote', { n: edit.version })),
                      h('textarea', {
                        className: 'sbb-textarea',
                        value: edit.draft,
                        onChange: event => setEdit(current => ({ ...current, draft: event.target.value })),
                      }),
                      h('div', { className: 'sbb-doc-actions' },
                        h('button', {
                          type: 'button', className: 'sbb-button sbb-button-primary', disabled: busy, onClick: saveEdit,
                        }, busy ? t('doc.saveBusy') : t('doc.save')),
                        h('button', { type: 'button', className: 'sbb-button', disabled: busy, onClick: cancelEdit }, t('doc.cancel')),
                      ),
                    )
                    : h(Fragment, null,
                      edit.phase === 'waiting'
                        ? h('div', { className: 'sbb-notice' }, t('doc.queuePosition', { n: current.edit?.queue?.findIndex(entry => entry.owner === 'user') + 1 || 1 }))
                        : null,
                      h('div', { className: 'sbb-doc-content' },
                        current.excerpt === '' && (detail?.content ?? '') === ''
                          ? h('div', { className: 'sbb-empty' }, t('doc.emptyBody'))
                          : h(Markdown, { text: detail?.content ?? '' })),
                    ),
                ),
          ),
          view === 'doc' && current !== null && edit.phase === 'idle'
            ? h('div', { className: 'sbb-doc-actions-row' },
              h('button', {
                type: 'button', className: 'sbb-button sbb-button-primary', disabled: busy, onClick: beginEdit,
              }, busy ? t('doc.editing') : t('doc.edit')))
            : null,
          edit.phase === 'waiting' && current !== null
            ? h('div', { className: 'sbb-doc-actions-row' },
              h('button', { type: 'button', className: 'sbb-button', disabled: busy, onClick: cancelEdit }, t('doc.cancel')))
            : null,
          creating
            ? h(CreateDialog, {
              t,
              onClose: () => setCreating(false),
              onCreated: (type, id) => {
                setCreating(false)
                if (type === 'doc') openDoc(id)
              },
            })
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Create dialog (chat or document)                                   */
    /* ------------------------------------------------------------------ */

    /** Create dialog: one type toggle plus a growing list of 1..8 members. */
    function CreateDialog({ t, onClose, onCreated }) {
      const emptyMember = () => ({ kind: 'workspace', ws: '', ref: '', label: '' })
      const [type, setType] = useState('chat')
      const [catalog, setCatalog] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [title, setTitle] = useState('')
      const [members, setMembers] = useState([emptyMember()])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [tick, setTick] = useState(0)
      /** Quick start: a whole workspace as the board's only member. */
      const [quickWs, setQuickWs] = useState('')

      useEffect(() => {
        let cancelled = false
        loadCatalog().then(value => {
          if (!cancelled) setCatalog(value)
        }).catch(err => {
          if (!cancelled) setLoadError(String(err instanceof Error ? err.message : err))
        })
        return () => { cancelled = true }
      }, [tick])

      const patch = (index, fields) => {
        setMembers(current => current.map((member, i) => (i === index ? { ...member, ...fields } : member)))
      }
      const addMember = () => {
        setMembers(current => (current.length >= MAX_MEMBERS ? current : [...current, emptyMember()]))
      }
      const removeMember = index => {
        setMembers(current => (current.length <= 1 ? current : current.filter((_, i) => i !== index)))
      }
      const useQuickWorkspace = () => {
        if (quickWs === '') return
        setMembers([{ kind: 'workspace', ws: quickWs, ref: quickWs, label: '' }])
      }

      const canSubmit = catalog !== null && !busy
        && members.length >= 1 && members.every(member => member.ref !== '')

      const submit = async () => {
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        const sides = members.map(member => ({ kind: member.kind, ref: member.ref, label: member.label }))
        try {
          const value = type === 'chat'
            ? await createBoard({ title, sides })
            : await createDoc({ title, sides })
          onCreated(type, value.doc?.id ?? value.board.id)
        } catch (err) {
          setError(String(err instanceof Error ? err.message : err))
          setBusy(false)
        }
      }

      return h('div', { className: 'sbb-backdrop', onClick: onClose },
        h('div', { className: 'sbb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('create.title'), onClick: event => event.stopPropagation() },
          h('div', { className: 'sbb-modal-title' }, t('create.title')),
          h('div', { className: 'sbb-modal-body' },
            loadError !== null
              ? h('div', { className: 'sbb-error' }, t('error.load', { message: loadError }),
                h('button', { type: 'button', onClick: () => { setLoadError(null); setTick(x => x + 1) } }, t('retry')))
              : null,
            h('div', { className: 'sbb-field' },
              h('label', { className: 'sbb-field-label' }, t('create.boardTitle')),
              h('div', { className: 'sbb-type-toggle' },
                h('button', {
                  type: 'button',
                  className: `sbb-button ${type === 'chat' ? 'sbb-button-primary' : ''}`,
                  onClick: () => setType('chat'),
                }, t('create.chat')),
                h('button', {
                  type: 'button',
                  className: `sbb-button ${type === 'doc' ? 'sbb-button-primary' : ''}`,
                  onClick: () => setType('doc'),
                }, t('create.doc'))),
            ),
            h('div', { className: 'sbb-field' },
              h('label', { className: 'sbb-field-label' }, t('create.boardTitle')),
              h('input', {
                className: 'sbb-input',
                value: title,
                placeholder: type === 'chat' ? t('create.boardTitlePlaceholderChat') : t('create.boardTitlePlaceholderDoc'),
                maxLength: 200,
                onChange: event => setTitle(event.target.value),
              }),
            ),
            h('div', { className: 'sbb-field' },
              h('label', { className: 'sbb-field-label' }, t('create.workspaceQuick')),
              h('div', { className: 'sbb-quick-row' },
                h('select', {
                  className: 'sbb-select',
                  value: quickWs,
                  onChange: event => setQuickWs(event.target.value),
                },
                h('option', { value: '' }, t('create.pickWorkspace')),
                (catalog === null ? [] : catalog.workspaces)
                  .map(entry => h('option', { key: entry.id, value: entry.id },
                    t('create.workspaceOption', { title: entry.title, path: entry.path })))),
                h('button', {
                  type: 'button',
                  className: 'sbb-button',
                  disabled: quickWs === '',
                  onClick: useQuickWorkspace,
                }, t('create.workspaceQuickBtn')),
              ),
              h('div', { className: 'sbb-modal-hint' }, t('create.workspaceQuickHint')),
            ),
            members.map((member, index) => {
              // Archived sessions cannot chat: keep them out of the pools.
              const sessionPool = member.kind === 'session' && catalog !== null && member.ws !== ''
                ? catalog.sessions.filter(candidate => (candidate.status ?? 'active') === 'active'
                  && (member.ws === '__none__' ? candidate.workspaceId === null : candidate.workspaceId === member.ws))
                : []
              const nameCounts = new Map()
              for (const candidate of sessionPool) {
                const label = candidate.displayName || candidate.title || candidate.name
                nameCounts.set(label, (nameCounts.get(label) ?? 0) + 1)
              }
              const wsOptions = catalog === null
                ? []
                : catalog.workspaces.filter(workspace => catalog.sessions.some(candidate => candidate.workspaceId === workspace.id))
              const hasUnassigned = catalog !== null && catalog.sessions.some(candidate => candidate.workspaceId === null)
              return h('div', { key: index, className: 'sbb-member-row' },
                h('div', { className: 'sbb-member-row-top' },
                  h('span', { className: 'sbb-member-row-title' }, t('create.member', { n: index + 1 })),
                  members.length > 1
                    ? h('button', {
                      type: 'button',
                      className: 'sbb-icon-btn sbb-danger',
                      onClick: () => removeMember(index),
                    }, t('create.removeMember'))
                    : null,
                ),
                h('div', { className: 'sbb-member-controls' },
                  h('select', {
                    className: 'sbb-select sbb-member-kind',
                    value: member.kind,
                    onChange: event => patch(index, { kind: event.target.value, ws: '', ref: '' }),
                  },
                  h('option', { value: 'session' }, t('create.kindSession')),
                  h('option', { value: 'workspace' }, t('create.kindWorkspace'))),
                  h('input', {
                    className: 'sbb-input sbb-member-label',
                    value: member.label,
                    placeholder: t('create.memberLabel'),
                    maxLength: 60,
                    onChange: event => patch(index, { label: event.target.value }),
                  }),
                ),
                member.kind === 'workspace'
                  ? h('select', {
                    className: 'sbb-select sbb-member-ref',
                    value: member.ref,
                    onChange: event => patch(index, { ref: event.target.value }),
                  },
                  h('option', { value: '' }, t('create.pickWorkspace')),
                  (catalog === null ? [] : catalog.workspaces)
                    .map(entry => h('option', { key: entry.id, value: entry.id },
                      t('create.workspaceOption', { title: entry.title, path: entry.path }))))
                  : h(Fragment, null,
                    h('select', {
                      className: 'sbb-select sbb-member-ref',
                      value: member.ws,
                      onChange: event => patch(index, { ws: event.target.value, ref: '' }),
                    },
                    h('option', { value: '' }, t('create.pickWorkspaceFirst')),
                    wsOptions.map(entry => h('option', { key: entry.id, value: entry.id }, entry.title)),
                    hasUnassigned ? h('option', { value: '__none__' }, t('create.noWorkspace')) : null),
                    h('select', {
                      className: 'sbb-select sbb-member-ref',
                      value: member.ref,
                      disabled: member.ws === '',
                      onChange: event => patch(index, { ref: event.target.value }),
                    },
                    h('option', { value: '' }, member.ws === '' ? t('create.pickWorkspaceFirst') : t('create.pickSession')),
                    sessionPool.map(entry => {
                      const label = entry.displayName || entry.title || entry.name
                      const display = (nameCounts.get(label) ?? 0) > 1
                        ? t('create.sessionOption', { name: label, id: entry.id.slice(0, 8) })
                        : label
                      return h('option', { key: entry.id, value: entry.id }, display)
                    })),
                  ),
              )
            }),
            members.length < MAX_MEMBERS
              ? h('button', { type: 'button', className: 'sbb-button sbb-add-member', onClick: addMember }, t('create.addMember'))
              : null,
            h('div', { className: 'sbb-modal-hint' }, t('create.hint')),
          ),
          h('div', { className: 'sbb-modal-foot' },
            error !== null ? h('div', { className: 'sbb-modal-error' }, t('error.create', { message: error })) : h('div', { className: 'sbb-modal-error' }),
            h('button', { type: 'button', className: 'sbb-button', onClick: onClose }, t('create.cancel')),
            h('button', { type: 'button', className: 'sbb-button sbb-button-primary', disabled: !canSubmit, onClick: submit }, busy ? t('create.busy') : t('create.submit')),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Chat tab body                                                      */
    /* ------------------------------------------------------------------ */

    /** The agent-group-chat tab body. */
    function ChatTab(props) {
      const sessionId = props.sessionId
      const t = props.t
      const changes = props.changes
      const revision = useStore(changes)
      const [view, setView] = useState('list')
      const [boardId, setBoardId] = useState(null)
      const [boards, setBoards] = useState(null)
      const [messages, setMessages] = useState(null)
      const [error, setError] = useState(null)
      const [creating, setCreating] = useState(false)
      const [deletingId, setDeletingId] = useState(null)
      const [sending, setSending] = useState(false)
      const [draft, setDraft] = useState('')
      const [sendError, setSendError] = useState(null)
      const [retry, setRetry] = useState(0)
      const bodyRef = useRef(null)
      const deleteTimer = useRef(null)

      const current = boards?.find(board => board.id === boardId) ?? null

      // Reload the summaries on every change notification (or manual retry).
      useEffect(() => {
        let cancelled = false
        setError(null)
        loadBoards(sessionId).then(value => {
          if (!cancelled) setBoards(value.boards)
        }).catch(err => {
          if (!cancelled) setError(String(err instanceof Error ? err.message : err))
        })
        return () => { cancelled = true }
      }, [sessionId, revision, retry])

      // Reload the open board's messages (full refetch; boards are small).
      useEffect(() => {
        if (view !== 'chat' || boardId === null) {
          setMessages(null)
          return
        }
        let cancelled = false
        loadMessages(boardId, 0).then(value => {
          if (!cancelled) setMessages(value.messages)
        }).catch(err => {
          if (!cancelled) setSendError(String(err instanceof Error ? err.message : err))
        })
        return () => { cancelled = true }
      }, [view, boardId, revision])

      // Follow the conversation tail when the viewer already sits near it.
      useEffect(() => {
        const element = bodyRef.current
        if (element === null || messages === null) return
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
        if (nearBottom) element.scrollTop = element.scrollHeight
      }, [messages])

      // A deleted or vanished board sends the viewer back to the list.
      useEffect(() => {
        if (view === 'chat' && boards !== null && current === null) {
          setView('list')
          setBoardId(null)
          setMessages(null)
        }
      }, [view, boards, current])

      useEffect(() => () => {
        if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
      }, [])

      const openBoard = id => {
        setBoardId(id)
        setView('chat')
        setMessages(null)
        setDraft('')
        setSendError(null)
      }

      const backToList = () => {
        setView('list')
        setBoardId(null)
        setMessages(null)
      }

      const onDeleteIntent = id => {
        if (deletingId !== id) {
          setDeletingId(id)
          if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
          deleteTimer.current = setTimeout(() => setDeletingId(null), 3000)
          return
        }
        setDeletingId(null)
        if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
        deleteBoard(id).catch(() => { /* the next refresh reveals a surviving board */ })
          .finally(() => {
            if (boardId === id) backToList()
          })
      }

      const send = async () => {
        if (sending || current === null || draft.trim() === '') return
        setSending(true)
        setSendError(null)
        try {
          await postMessage(current.id, draft)
          setDraft('')
          const value = await loadMessages(current.id, 0)
          setMessages(value.messages)
        } catch (err) {
          setSendError(String(err instanceof Error ? err.message : err))
        } finally {
          setSending(false)
        }
      }

      const headTitle = view === 'chat' && current !== null ? current.title : t('chat.tab.title')

      return h(Fragment, null,
        h('style', { key: 'sbb-css' }, CSS),
        h('div', { className: 'sbb-panel' },
          h('div', { className: 'sbb-head' },
            view === 'chat'
              ? h('button', { type: 'button', className: 'sbb-icon-btn', onClick: backToList, 'aria-label': t('chat.back') }, '‹')
              : null,
            h('span', { className: 'sbb-head-title', title: headTitle }, headTitle),
            view === 'list'
              ? h('div', { className: 'sbb-head-sub' },
                h('button', { type: 'button', className: 'sbb-icon-btn', onClick: () => setCreating(true) }, t('list.new')))
              : null,
          ),
          error !== null
            ? h('div', { className: 'sbb-error' }, t('error.load', { message: error }),
              h('button', { type: 'button', onClick: () => setRetry(x => x + 1) }, t('retry')))
            : null,
          h('div', { className: 'sbb-body', ref: bodyRef },
            view === 'list'
              ? h(BoardList, { boards: boards ?? [], t, onOpen: openBoard, deletingId, onDeleteIntent })
              : current === null || messages === null
                ? h('div', { className: 'sbb-empty' }, '…')
                : h(Fragment, null,
                  h('div', { className: 'sbb-roster' },
                    h('span', { className: 'sbb-roster-label' }, `${t('chat.members')}:`),
                    current.sides.map(side => h(MemberChip, { key: side.key, side, mine: side.key === current.mySideKey, t })),
                    h('span', { className: 'sbb-roster-label' }, '+'),
                    h('span', { className: 'sbb-chip sbb-mine' }, t('chat.you')),
                  ),
                  h(ActivityList, { activity: current.activity, t }),
                  h('div', { className: 'sbb-chat' },
                    messages.length === 0
                      ? h('div', { className: 'sbb-empty' }, t('chat.empty'))
                      : messages.map(message => h(MessageRow, {
                        key: message.id, message, board: current, t,
                      })),
                  ),
                ),
          ),
          view === 'chat' && current !== null
            ? h('div', { className: 'sbb-composer' },
              sendError !== null ? h('div', { className: 'sbb-modal-error' }, t('error.send', { message: sendError })) : null,
              h('div', { className: 'sbb-mention-hint' }, t('chat.mentionHint')),
              h('div', { className: 'sbb-composer-row' },
                h('textarea', {
                  className: 'sbb-textarea',
                  value: draft,
                  placeholder: t('chat.placeholder'),
                  maxLength: 8000,
                  onChange: event => setDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void send()
                    }
                  },
                }),
                h('button', {
                  type: 'button', className: 'sbb-send', disabled: sending || draft.trim() === '', onClick: send,
                }, sending ? t('chat.sendBusy') : t('chat.send')),
              ),
            )
            : null,
          creating
            ? h(CreateDialog, {
              t,
              onClose: () => setCreating(false),
              onCreated: (type, id) => {
                setCreating(false)
                // A document created here lives in the blackboard tab; the
                // SSE refresh already lists it there.
                if (type === 'chat') openBoard(id)
              },
            })
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-blackboard: locale')
      const t = ctx.locale.bind(NS)
      // One change bus feeds every tab occurrence; its SSE stream lives with
      // the plugin, not with any one component tree.
      const changes = createChangeBus()
      changes.ensureStream()
      ctx.effect(() => () => changes.dispose(), 'session-blackboard: change bus')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: `${PANEL_ID}:chat`,
        kind: CHAT_KIND,
        title: () => t('chat.tab.title'),
        guide: [{
          id: 'open',
          order: 100,
          title: () => t('chat.guide.title'),
          description: () => t('chat.guide.description'),
        }],
      }), 'session-blackboard: chat tab type')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: `${PANEL_ID}:doc`,
        kind: DOC_KIND,
        title: () => t('doc.tab.title'),
        guide: [{
          id: 'open',
          order: 101,
          title: () => t('doc.guide.title'),
          description: () => t('doc.guide.description'),
        }],
      }), 'session-blackboard: doc tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: `${PANEL_ID}:chat`,
          inject: sessionId => ({ sessionId, t, changes }),
        },
        ChatTab,
      )), 'session-blackboard: chat tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: `${PANEL_ID}:doc`,
          inject: sessionId => ({ sessionId, t, changes }),
        },
        DocTab,
      )), 'session-blackboard: doc tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: `${PANEL_ID}:chat` },
        function Title() { return t('chat.tab.title') },
      )), 'session-blackboard: chat tab title')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: `${PANEL_ID}:doc` },
        function Title() { return t('doc.tab.title') },
      )), 'session-blackboard: doc tab title')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply,
    }
  },
})
