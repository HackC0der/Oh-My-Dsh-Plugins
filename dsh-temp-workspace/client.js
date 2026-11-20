window.__ModuleLoader__.load({
  id: '@local/dsh-temp-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace registered by this bundle. */
    const NS = 'tempWorkspace'
    /** Segments appended to the Host home directory to form the temp root. */
    const ROOT_SEGMENTS = ['.dsh', 'temp-workspace']
    /** Longest run of `tmp-NN` names one attempt tries before falling back to a timestamped name. */
    const MAX_SEQUENCE_ATTEMPTS = 100
    /** How long one creation waits for the Host to group the new Session. */
    const ATTACH_TIMEOUT_MS = 5000

    const zh = {
      'action.label': '新建临时会话',
      'action.busy': '正在创建临时会话…',
      'error.title': '临时会话创建失败',
      'error.create': '无法创建临时会话：{message}',
      'error.noHome': '尚未连接 Host，无法确定主目录。',
      'error.attach': '临时会话已创建，但页面尚未同步到它的工作区；请稍候，输入框恢复可用后再输入，必要时刷新页面。',
      'toast.dismiss': '关闭',
    }
    const en = {
      'action.label': 'New temporary session',
      'action.busy': 'Creating temporary session…',
      'error.title': 'Could not create temporary session',
      'error.create': 'Could not create temporary session: {message}',
      'error.noHome': 'The Host is not connected yet, so its home directory is unknown.',
      'error.attach': 'The temporary session was created, but this page has not caught up with its workspace yet. Wait for the composer to unlock, or refresh the page.',
      'toast.dismiss': 'Dismiss',
    }

    const TRIGGER_CSS = `
      .dsh-tw-trigger {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        padding: 0;
        box-sizing: border-box;
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-md);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .dsh-tw-trigger.dsh-tw-wide {
        width: 38px;
        height: 38px;
        border-color: var(--dsw-alias-border-l3);
        background: var(--dsw-alias-button-elevated-fill);
      }
      @media (hover: hover) {
        .dsh-tw-trigger:not([aria-disabled='true']):hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-tw-trigger.dsh-tw-wide:not([aria-disabled='true']):hover {
          background: var(--dsw-alias-button-floating-hover);
        }
      }
      .dsh-tw-trigger:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .dsh-tw-trigger[aria-disabled='true'] {
        cursor: progress;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsh-tw-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 1.5px solid var(--dsw-alias-border-l3);
        border-top-color: var(--dsw-alias-state-business-primary);
        animation: dsh-tw-spin 0.8s linear infinite;
      }
      @keyframes dsh-tw-spin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-tw-spinner { animation: none; }
      }
    `

    const TOAST_CSS = `
      .dsh-tw-toast {
        position: fixed;
        left: 50%;
        bottom: 32px;
        z-index: 60;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        box-sizing: border-box;
        max-width: min(520px, calc(100vw - 48px));
        padding: 10px 12px 10px 14px;
        transform: translateX(-50%);
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-elevation-prominent);
        font-size: 13px;
        line-height: 20px;
        pointer-events: auto;
      }
      .dsh-tw-toast-body {
        min-width: 0;
        flex: 1 1 auto;
      }
      .dsh-tw-toast-head {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
      }
      .dsh-tw-toast-icon {
        flex: none;
        display: inline-flex;
        color: var(--dsw-alias-state-error-primary);
      }
      .dsh-tw-toast-title {
        min-width: 0;
        flex: 1 1 auto;
      }
      .dsh-tw-toast-close {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        margin: -2px -4px -2px 0;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .dsh-tw-toast-close:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-tw-toast-close:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .dsh-tw-toast-detail {
        margin-top: 4px;
        color: var(--dsw-alias-label-secondary);
        word-break: break-word;
      }
    `

    /** Join one path segment without importing a path module in the browser. */
    function joinPath(parent, child) {
      return parent.endsWith('/') || parent.endsWith('\\') ? `${parent}${child}` : `${parent}/${child}`
    }

    /** The stable `code` of a rejected Remote or directory-browse call. */
    function failureCode(error) {
      if (typeof error !== 'object' || error === null) return undefined
      if (typeof error.rpcError === 'object' && error.rpcError !== null && typeof error.rpcError.code === 'string') {
        return error.rpcError.code
      }
      return typeof error.code === 'string' ? error.code : undefined
    }

    /** A short, stable description of a failure for the notice. */
    function describeFailure(error) {
      if (typeof error === 'object' && error !== null) {
        const message = typeof error.message === 'string' && error.message !== '' ? error.message : undefined
        const code = typeof error.code === 'string' ? error.code : undefined
        if (code !== undefined && message !== undefined) return `${code}: ${message}`
        if (message !== undefined) return message
      }
      return String(error)
    }

    /** A unique name for hosts whose picker cannot list or create directories. */
    function timestampName() {
      return `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    }

    /** The first sequence number not used by an existing `tmp-NN` entry. */
    function nextSequence(entries) {
      let highest = 0
      for (const entry of entries) {
        const match = /^tmp-(\d+)$/.exec(entry.name)
        if (match !== null) highest = Math.max(highest, Number(match[1]))
      }
      return highest + 1
    }

    /** Create one child directory, treating an existing directory as success. */
    async function ensureChild(uiWorkspace, parent, name) {
      try {
        return await uiWorkspace.createDirectory(parent, name)
      } catch (error) {
        if (failureCode(error) === 'directory-picker/exists') return joinPath(parent, name)
        throw error
      }
    }

    /** One small notice store shared by the trigger and the overlay toast. */
    function createNoticeStore() {
      let current = null
      let seq = 0
      const listeners = new Set()
      const publish = () => {
        for (const listener of listeners) listener()
      }
      const dismiss = () => {
        if (current === null) return
        current = null
        publish()
      }
      return {
        get: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        report(message) {
          seq += 1
          current = { message, seq }
          publish()
        },
        dismiss,
        dispose() {
          current = null
          listeners.clear()
        },
      }
    }

    /** One shared boolean store so every trigger instance renders the same busy state. */
    function createFlagStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (value === next) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Subscribe a component to one observable store. */
    function useStore(store) {
      const [value, setValue] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => {
        setValue(store.get())
      }), [store])
      return value
    }

    /** Folder-plus mark used by the trigger. */
    function TempIcon({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('path', {
        d: 'M2.75 6.25c0-0.97 0.78-1.75 1.75-1.75h2.76c0.46 0 0.9 0.18 1.23 0.51l1.06 1.06h4.7c0.97 0 1.75 0.78 1.75 1.75v5.93c0 0.97-0.78 1.75-1.75 1.75H4.5c-0.97 0-1.75-0.78-1.75-1.75V6.25Z',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M10 8.4v4.2M7.9 10.5h4.2',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
      }))
    }

    /** Warning mark used by the toast. */
    function WarningIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('path', {
        d: 'M8 2.1 14.3 13.2H1.7L8 2.1Z',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M8 6.1v3.1',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
      }),
      h('circle', { cx: 8, cy: 11.2, r: 0.75, fill: 'currentColor' }))
    }

    /**
     * Resolve the directory one new temporary Session runs in.
     * @returns the absolute directory and whether this call created it through
     * the composed picker (false means the Host must create it via Session cwd).
     */
    async function resolveSessionDirectory(ctx, uiWorkspace, t) {
      const home = ctx.remote.$host.home
      if (typeof home !== 'string' || home === '') throw new Error(t('error.noHome'))
      const root = ROOT_SEGMENTS.reduce((parent, segment) => joinPath(parent, segment), home)
      // Ensure every level once; an existing level answers directory-picker/exists.
      let parent = home
      try {
        for (const segment of ROOT_SEGMENTS) {
          parent = await ensureChild(uiWorkspace, parent, segment)
        }
      } catch (error) {
        if (failureCode(error) !== 'directory-picker/unavailable') throw error
        // A native chooser cannot create or list directories; the Host creates
        // the whole chain when the Session is created with this cwd.
        return { cwd: joinPath(root, timestampName()), created: false }
      }
      try {
        const listing = await uiWorkspace.listDirectory(root)
        let next = nextSequence(listing.entries)
        for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt += 1, next += 1) {
          const name = `tmp-${String(next).padStart(2, '0')}`
          try {
            return { cwd: await uiWorkspace.createDirectory(root, name), created: true }
          } catch (error) {
            const code = failureCode(error)
            if (code === 'directory-picker/exists') continue
            if (code === 'directory-picker/unavailable') return { cwd: joinPath(root, timestampName()), created: false }
            throw error
          }
        }
      } catch (error) {
        // A listing or create failure that is not an expected conflict still
        // leaves Session creation as the authority; it reports the real error.
        if (failureCode(error) === 'directory-picker/unavailable') return { cwd: joinPath(root, timestampName()), created: false }
        ctx.logger.warn('temp-workspace: falling back to a timestamped directory', error)
      }
      return { cwd: joinPath(root, timestampName()), created: false }
    }

    /**
     * Wait until the Workspace snapshot lists `sessionId` as a member.
     * @returns true once a Workspace contains the Session, false at the deadline.
     */
    function waitForWorkspaceMembership(ctx, sessionId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      return new Promise((resolve) => {
        const check = () => {
          const snapshot = ctx.workspaces.list.getSnapshot()
          if (snapshot.items.some((workspace) => workspace.sessionIds.includes(sessionId))) {
            resolve(true)
            return
          }
          if (Date.now() >= deadline) {
            resolve(false)
            return
          }
          setTimeout(check, 50)
        }
        check()
      })
    }

    /**
     * Create the directory, its Workspace, and the Session, then open the Session.
     *
     * With the composed picker the directory can be claimed first, so the
     * Workspace and Session are created through their normal commands: the
     * Session is attached to the Workspace atomically before `create` resolves.
     * A native chooser cannot create directories; there the Host creates the
     * cwd and the Host half groups the Session afterwards.
     */
    async function createTemporarySession(ctx, uiWorkspace, t) {
      const { cwd, created } = await resolveSessionDirectory(ctx, uiWorkspace, t)
      if (!created) {
        const sessionId = await ctx.sessions.create({ cwd })
        const attached = await waitForWorkspaceMembership(ctx, sessionId, ATTACH_TIMEOUT_MS)
        uiWorkspace.openSession(sessionId)
        return { sessionId, attached }
      }
      let workspace
      try {
        workspace = await ctx.workspaces.create({ path: cwd })
        const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
        const attached = await waitForWorkspaceMembership(ctx, sessionId, ATTACH_TIMEOUT_MS)
        uiWorkspace.openSession(sessionId)
        return { sessionId, attached }
      } catch (error) {
        // The directory and its registration were created for this attempt
        // only; do not leave an empty group behind when the Session failed.
        // Deleting the registration never touches the directory or any log.
        if (workspace !== undefined) {
          await ctx.workspaces.delete(workspace.workspaceId).catch(() => {})
        }
        throw error
      }
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'workspaces', 'remote', 'locale'],
      apply(ctx) {
        const notices = createNoticeStore()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'temp-workspace: dictionaries')
        ctx.effect(() => () => notices.dispose(), 'temp-workspace: notice lifetime')
        const t = ctx.locale.bind(NS)
        // Shared across trigger instances: the sidebar unmounts its wide row at
        // rail settle, so a component-local flag alone would allow a second
        // creation while the first one is still in flight.
        const busyStore = createFlagStore(false)

        function TempSessionTrigger(props) {
          const { wide } = props
          // A temporary session also registers a Workspace; hide the trigger
          // when this Peer may create neither.
          const canCreateSession = props.useRemoteAccess('session/create')
          const canCreateWorkspace = props.useRemoteAccess('workspace/create')
          const allowed = canCreateSession && canCreateWorkspace
          const busy = useStore(busyStore)
          const start = () => {
            if (busy) return
            busyStore.set(true)
            notices.dismiss()
            void createTemporarySession(ctx, ctx.uiWorkspace, t).then(({ attached }) => {
              if (attached) return
              ctx.logger.warn('temp-workspace: the temporary Workspace did not appear before the deadline')
              notices.report(t('error.attach'))
            }).catch((error) => {
              ctx.logger.warn('temp-workspace: creating the temporary session failed', error)
              notices.report(t('error.create', { message: describeFailure(error) }))
            }).finally(() => {
              busyStore.set(false)
            })
          }
          if (!allowed) return props.children
          return h(React.Fragment, null,
            h('style', null, TRIGGER_CSS),
            props.children,
            h('button', {
              type: 'button',
              className: wide ? 'dsh-tw-trigger dsh-tw-wide' : 'dsh-tw-trigger',
              'aria-label': busy ? t('action.busy') : t('action.label'),
              'aria-disabled': busy ? 'true' : undefined,
              'aria-busy': busy ? 'true' : undefined,
              'data-temp-workspace-trigger': '',
              'data-busy': busy ? '' : undefined,
              title: busy ? t('action.busy') : t('action.label'),
              onClick: start,
            }, busy
              ? h('span', { className: 'dsh-tw-spinner', 'aria-hidden': true })
              : h(TempIcon, { size: wide ? 14 : 18 })))
        }

        function TempWorkspaceToast(props) {
          const notice = useStore(notices)
          return h(React.Fragment, null,
            h('style', null, TOAST_CSS),
            notice === null ? null : h('div', {
              key: notice.seq,
              className: 'dsh-tw-toast',
              'data-temp-workspace-toast': '',
            },
            h('div', { className: 'dsh-tw-toast-body', role: 'alert' },
              h('div', { className: 'dsh-tw-toast-head' },
                h('span', { className: 'dsh-tw-toast-icon' }, h(WarningIcon)),
                h('span', { className: 'dsh-tw-toast-title' }, props.t('error.title'))),
              h('div', { className: 'dsh-tw-toast-detail' }, notice.message)),
            h('button', {
              type: 'button',
              className: 'dsh-tw-toast-close',
              'aria-label': props.t('toast.dismiss'),
              onClick: () => {
                notices.dismiss()
              },
            }, '×')))
        }

        ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
          name: 'sidebar.session.action',
          id: 'temp-workspace',
          locale: NS,
        }, TempSessionTrigger))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'temp-workspace-toast',
          locale: NS,
          order: 80,
        }, TempWorkspaceToast))
      },
    }
  },
})
