/**
 * Client half of the workspace-suite bundle.
 *
 * Shadows the sidebar's `sidebar.workspaces` seat (priority -1; the shipped
 * browser stays registered at 0 and returns when this plugin unloads) and
 * renders the browsing region as `group (nested) > workspace > session`.
 * Groups are a view-only classification stored in this browser and may nest
 * arbitrarily deep; no directory on disk is created, moved, or renamed.
 * Archived sessions are hidden behind a header toggle by default.
 *
 * Workspaces under `~/.dsh/temp-workspace/tmp-*` never join that tree: they
 * are pinned into one built-in "Temporary workspaces" group above the user
 * groups. The hide action on such a row only filters it out of this list —
 * registration, directory, and sessions all stay — and the group's "Hidden"
 * section lists them again with a restore action, so hiding is always
 * reversible.
 *
 * The same bundle also owns those temporary workspaces' creation: a trigger
 * beside the sidebar's "New Session" button claims the next `tmp-NN`
 * directory under the shared temp root, registers it as a workspace, and
 * opens a fresh session inside it; the Host half groups sessions created
 * through the native-picker fallback.
 *
 * The seat cannot re-declare the shipped browser's child slots (a register
 * call rejects an already-declared child), so this half owns the surfaces it
 * needs itself: the workspace/session context menus come from the shared
 * context-menu service, and adding a workspace uses a small in-plugin
 * directory dialog instead of the shipped directory-flow slot.
 */
window.__ModuleLoader__.load({
  id: '@local/workspace-suite',
  factory(require) {
    const React = require('react')
    const {
      Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React
    const h = React.createElement

    const NS = 'workspace-suite'
    /** Persisted tree (v2 adds parent links and the archived toggle); v1 is read once and migrated. */
    const STORAGE_KEY_V1 = 'dsh.workspace.folders.v1'
    const STORAGE_KEY_V2 = 'dsh.workspace.folders.v2'
    /** Extra inline padding per nesting level (folder > workspace > session). */
    const INDENT_PX = 14
    /** Milliseconds between relative-time refreshes while the sidebar is visible. */
    const CLOCK_MS = 60_000
    /** Host-home segments below which the companion temp-workspace plugin files its `tmp-*` directories. */
    const TEMP_ROOT_SEGMENTS = ['.dsh', 'temp-workspace']
    /** Longest run of `tmp-NN` names one attempt tries before falling back to a timestamped name. */
    const MAX_SEQUENCE_ATTEMPTS = 100
    /** How long one creation waits for the Host to group the new Session. */
    const ATTACH_TIMEOUT_MS = 5000

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copies of locale/*.json, minus metadata)      */
    /* ------------------------------------------------------------------ */

    const en = {
      'action.label': 'New temporary session',
      'action.busy': 'Creating temporary session…',
      'error.title': 'Could not create temporary session',
      'error.create': 'Could not create temporary session: {message}',
      'error.noHome': 'The Host is not connected yet, so its home directory is unknown.',
      'error.attach': 'The temporary session was created, but this page has not caught up with its workspace yet. Wait for the composer to unlock, or refresh the page.',
      'toast.dismiss': 'Dismiss',
      'section.title': 'Workspaces',
      'group.ungrouped': 'Ungrouped',
      'folder.new': 'New group',
      'folder.newChild': 'New subgroup',
      'folder.name.placeholder': 'Group name',
      'folder.actions': 'Actions for group {name}',
      'folder.rename': 'Rename group',
      'folder.delete': 'Delete group',
      'folder.deleted': 'Deleted group "{name}"',
      'folder.move': 'Move group to…',
      'folder.root': 'Root',
      'folder.empty': 'Empty group. Drag a workspace or a group here.',
      undo: 'Undo',
      'workspace.newSession': 'New session in {name}',
      'workspace.moveTo': 'Move to group',
      'workspace.removeFrom': 'Remove from group',
      'workspace.add': 'Add workspace',
      'workspace.defaultName': 'Workspace',
      'workspace.actions': 'Actions for workspace {name}',
      'workspace.rename': 'Rename workspace',
      'workspace.delete': 'Delete workspace',
      'menu.deleteSession': 'Delete session',
      'wsdialog.renameTitle': 'Rename workspace',
      'wsdialog.deleteTitle': 'Delete workspace',
      'wsdialog.deleteBody': 'Remove workspace "{name}" from the list? Its directory and files on disk are kept.',
      'wsdialog.deleteFiles': 'Also delete the files on disk',
      'wsdialog.deleteFilesHint': 'The directory is moved to ~/.dsh/trash/workspaces, where you can restore it.',
      'wsdialog.deleteSessions': 'Also delete its sessions ({n}, including archived)',
      'wsdialog.sessionTitle': 'Delete session',
      'wsdialog.sessionBody': 'Permanently delete session "{name}" and its storage on disk? This cannot be undone.',
      'wsdialog.nameLabel': 'Name',
      'wsdialog.confirmDelete': 'Delete',
      'wsdialog.confirmRename': 'Rename',
      'wsdialog.cancel': 'Cancel',
      'wsdialog.busy': 'Working…',
      'wsdialog.error': 'Failed: {message}',
      'session.new': 'New session',
      'session.untitled': 'Untitled',
      'session.actions': 'Actions for session {name}',
      'session.archived': 'This session is archived and cannot be opened',
      'archive.show': 'Show archived sessions',
      'archive.hide': 'Hide archived sessions',
      'temp.title': 'Temporary workspaces',
      'temp.hidden': 'Hidden',
      'temp.hide': 'Hide temporary workspace',
      'temp.hideHint': 'Only hides the row; the directory and sessions stay and can be restored here',
      'temp.restore': 'Restore hidden workspace',
      'temp.hiddenNotice': 'Hidden "{name}"; its directory and sessions are kept',
      'temp.showHiddenCount': 'Show hidden temporary workspaces ({n})',
      'temp.collapseHidden': 'Collapse the hidden list',
      'search.placeholder': 'Search workspaces or sessions',
      'search.clear': 'Clear search',
      'search.empty': 'No matching results',
      'empty.none': 'No workspaces yet',
      'time.now': 'now',
      'time.minute': '{n}min',
      'time.hour': '{n}h',
      'time.day': '{n}d',
      'rail.expand': 'Expand workspaces',
      'dialog.title': 'Add workspace',
      'dialog.home': 'Home',
      'dialog.parent': 'Parent folder',
      'dialog.empty': 'No subfolders',
      'dialog.truncated': 'List truncated',
      'dialog.loading': 'Loading…',
      'dialog.newFolder': 'New folder name',
      'dialog.create': 'Create',
      'dialog.choose': 'Add this folder',
      'dialog.busy': 'Adding…',
      'dialog.cancel': 'Cancel',
      'dialog.error': 'Could not add the folder: {message}',
    }

    const zh = {
      'action.label': '新建临时会话',
      'action.busy': '正在创建临时会话…',
      'error.title': '临时会话创建失败',
      'error.create': '无法创建临时会话：{message}',
      'error.noHome': '尚未连接 Host，无法确定主目录。',
      'error.attach': '临时会话已创建，但页面尚未同步到它的工作区；请稍候，输入框恢复可用后再输入，必要时刷新页面。',
      'toast.dismiss': '关闭',
      'section.title': '工作区',
      'group.ungrouped': '未分组',
      'folder.new': '新建分组',
      'folder.newChild': '新建子分组',
      'folder.name.placeholder': '分组名称',
      'folder.actions': '分组 {name} 的操作',
      'folder.rename': '重命名分组',
      'folder.delete': '删除分组',
      'folder.deleted': '已删除分组“{name}”',
      'folder.move': '移动分组到…',
      'folder.root': '根级',
      'folder.empty': '空分组，可把工作区或分组拖到这里',
      undo: '撤销',
      'workspace.newSession': '在 {name} 中新建会话',
      'workspace.moveTo': '移入分组',
      'workspace.removeFrom': '移出分组',
      'workspace.add': '添加工作区',
      'workspace.defaultName': '工作区',
      'workspace.actions': '工作区 {name} 的操作',
      'workspace.rename': '重命名工作区',
      'workspace.delete': '删除工作区',
      'menu.deleteSession': '删除会话',
      'wsdialog.renameTitle': '重命名工作区',
      'wsdialog.deleteTitle': '删除工作区',
      'wsdialog.deleteBody': '从列表移除工作区“{name}”吗？磁盘上的目录和文件会保留。',
      'wsdialog.deleteFiles': '同时删除磁盘文件',
      'wsdialog.deleteFilesHint': '目录将移入回收站 ~/.dsh/trash/workspaces，可随时找回。',
      'wsdialog.deleteSessions': '同时删除其中的会话（{n} 条，含已归档）',
      'wsdialog.sessionTitle': '删除会话',
      'wsdialog.sessionBody': '永久删除会话“{name}”及其磁盘存储？此操作不可恢复。',
      'wsdialog.nameLabel': '名称',
      'wsdialog.confirmDelete': '删除',
      'wsdialog.confirmRename': '重命名',
      'wsdialog.cancel': '取消',
      'wsdialog.busy': '处理中…',
      'wsdialog.error': '操作失败：{message}',
      'session.new': '新会话',
      'session.untitled': '未命名',
      'session.actions': '会话 {name} 的操作',
      'session.archived': '该会话已归档，无法打开',
      'archive.show': '显示已归档会话',
      'archive.hide': '隐藏已归档会话',
      'temp.title': '临时工作区',
      'temp.hidden': '已隐藏',
      'temp.hide': '隐藏临时工作区',
      'temp.hideHint': '仅从列表隐藏；目录与会话都保留，可随时在这里恢复',
      'temp.restore': '恢复显示',
      'temp.hiddenNotice': '已隐藏“{name}”；目录与会话均保留',
      'temp.showHiddenCount': '显示已隐藏的临时工作区（{n} 个）',
      'temp.collapseHidden': '收起已隐藏列表',
      'search.placeholder': '搜索工作区或会话',
      'search.clear': '清除搜索',
      'search.empty': '无匹配结果',
      'empty.none': '暂无工作区',
      'time.now': '刚刚',
      'time.minute': '{n} 分钟',
      'time.hour': '{n} 小时',
      'time.day': '{n} 天',
      'rail.expand': '展开工作区',
      'dialog.title': '添加工作区',
      'dialog.home': '主目录',
      'dialog.parent': '上一级',
      'dialog.empty': '没有子文件夹',
      'dialog.truncated': '列表已截断',
      'dialog.loading': '加载中…',
      'dialog.newFolder': '新文件夹名称',
      'dialog.create': '创建',
      'dialog.choose': '添加此文件夹',
      'dialog.busy': '正在添加…',
      'dialog.cancel': '取消',
      'dialog.error': '无法添加该文件夹：{message}',
    }

    /* ------------------------------------------------------------------ */
    /* Folder store: view state persisted in this browser                  */
    /* ------------------------------------------------------------------ */

    function emptyState() {
      return { version: 2, folders: [], workspaceExpanded: {}, showArchived: false, temp: emptyTempState() }
    }

    /** Built-in temporary-group state; a v2 payload without `temp` starts fresh. */
    function emptyTempState() {
      return { expanded: true, showHidden: false, hiddenPaths: [] }
    }

    /** Keep only well-formed temp entries; duplicate paths collapse. */
    function normalizeTemp(raw) {
      if (raw === null || typeof raw !== 'object') return emptyTempState()
      const hiddenPaths = Array.isArray(raw.hiddenPaths)
        ? [...new Set(raw.hiddenPaths.filter(path => typeof path === 'string' && path !== ''))]
        : []
      return { expanded: raw.expanded !== false, showHidden: raw.showHidden === true, hiddenPaths }
    }

    /**
     * Accept a v1 or v2 payload. Folder rows are rebuilt with parent links:
     * duplicate ids, unknown parents, and cycles degrade to the root, and a
     * v1 list (flat folders) migrates to parentless groups.
     */
    function normalizeState(raw) {
      if (raw === null || typeof raw !== 'object') return emptyState()
      if (raw.version !== 1 && raw.version !== 2) return emptyState()
      const seen = new Set()
      const folders = []
      if (Array.isArray(raw.folders)) {
        for (const folder of raw.folders) {
          if (folder === null || typeof folder !== 'object') continue
          if (typeof folder.id !== 'string' || typeof folder.name !== 'string') continue
          if (seen.has(folder.id)) continue
          seen.add(folder.id)
          const workspaceIds = Array.isArray(folder.workspaceIds)
            ? [...new Set(folder.workspaceIds.filter(id => typeof id === 'string'))]
            : []
          const parentId = raw.version === 2
            && typeof folder.parentId === 'string'
            && folder.parentId !== folder.id
            ? folder.parentId
            : null
          folders.push({ id: folder.id, name: folder.name, parentId, workspaceIds, expanded: folder.expanded !== false })
        }
      }
      // Break parent links that dangle or sit on a cycle.
      const byId = new Map(folders.map(folder => [folder.id, folder]))
      for (const folder of folders) {
        const visited = new Set([folder.id])
        let ok = true
        let cursor = folder.parentId
        while (cursor !== null) {
          if (visited.has(cursor) || !byId.has(cursor)) {
            ok = false
            break
          }
          visited.add(cursor)
          cursor = byId.get(cursor).parentId
        }
        if (!ok) folder.parentId = null
      }
      const workspaceExpanded = {}
      if (raw.workspaceExpanded !== null && typeof raw.workspaceExpanded === 'object') {
        for (const [key, value] of Object.entries(raw.workspaceExpanded)) {
          if (typeof value === 'boolean') workspaceExpanded[key] = value
        }
      }
      return { version: 2, folders, workspaceExpanded, showArchived: raw.showArchived === true, temp: normalizeTemp(raw.temp) }
    }

    function createFolderStore() {
      let persisted = null
      try {
        persisted = window.localStorage.getItem(STORAGE_KEY_V2) ?? window.localStorage.getItem(STORAGE_KEY_V1)
      } catch {
        persisted = null
      }
      let state
      try {
        state = normalizeState(JSON.parse(persisted || 'null'))
      } catch {
        state = emptyState()
      }
      const listeners = new Set()
      const commit = (next) => {
        if (next === state) return
        state = next
        try {
          window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(state))
        } catch {
          /* A full or blocked storage keeps the in-memory view; nothing else to do. */
        }
        for (const listener of [...listeners]) {
          try { listener() } catch { /* one consumer cannot break the others */ }
        }
      }
      const get = () => state
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const update = (fn) => { commit(fn(get())) }
      const folderIndex = s => new Map(s.folders.map(folder => [folder.id, folder]))
      const ancestorIds = (s, id) => {
        const byId = folderIndex(s)
        const chain = []
        let cursor = byId.get(id)?.parentId ?? null
        while (cursor !== null) {
          chain.push(cursor)
          cursor = byId.get(cursor)?.parentId ?? null
        }
        return chain
      }
      /** Expand a group plus every ancestor so the group becomes visible. */
      const withExpandedChain = (s, folderId) => {
        const ids = new Set([folderId, ...ancestorIds(s, folderId)])
        return {
          ...s,
          folders: s.folders.map(folder => (ids.has(folder.id) && folder.expanded !== true ? { ...folder, expanded: true } : folder)),
        }
      }
      return {
        get,
        subscribe,
        /** Create a group under a parent (null = root) and expand the chain to it. */
        create(name, parentId = null) {
          const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
          update((s) => {
            const byId = folderIndex(s)
            if (parentId !== null && !byId.has(parentId)) parentId = null
            let next = { ...s, folders: [...s.folders, { id, name, parentId, workspaceIds: [], expanded: true }] }
            if (parentId !== null) next = withExpandedChain(next, parentId)
            return next
          })
          return id
        },
        rename(id, name) {
          update(s => ({ ...s, folders: s.folders.map(f => (f.id === id ? { ...f, name } : f)) }))
        },
        /**
         * Delete a group; its subgroups and member workspaces return to the
         * deleted group's parent. Returns the pre-delete folder tree for undo,
         * or null when nothing was removed.
         */
        remove(id) {
          const before = get().folders
          let removed = false
          update((s) => {
            const target = s.folders.find(f => f.id === id)
            if (target === undefined) return s
            removed = true
            const folders = []
            for (const folder of s.folders) {
              if (folder.id === id) continue
              if (folder.parentId === id) folders.push({ ...folder, parentId: target.parentId })
              else folders.push(folder)
            }
            if (target.parentId !== null) {
              const index = folders.findIndex(f => f.id === target.parentId)
              if (index !== -1) {
                const parent = folders[index]
                const adopted = target.workspaceIds.filter(wid => !parent.workspaceIds.includes(wid))
                folders[index] = { ...parent, workspaceIds: [...parent.workspaceIds, ...adopted] }
              }
            }
            return { ...s, folders }
          })
          return removed ? before : null
        },
        /** Roll the folder tree back to an earlier snapshot (delete undo). */
        restore(folders) {
          if (!Array.isArray(folders)) return
          update(s => (s.folders === folders ? s : { ...s, folders }))
        },
        /** Re-parent a group; self, descendant, unknown, and no-op targets are rejected. */
        move(id, parentId) {
          update((s) => {
            const byId = folderIndex(s)
            const target = byId.get(id)
            if (target === undefined) return s
            if (parentId === id || target.parentId === parentId) return s
            if (parentId === null) {
              return { ...s, folders: [...s.folders.filter(f => f.id !== id), { ...target, parentId: null }] }
            }
            if (!byId.has(parentId)) return s
            for (let cursor = parentId; cursor !== null; cursor = byId.get(cursor)?.parentId ?? null) {
              if (cursor === id) return s
            }
            const next = { ...s, folders: [...s.folders.filter(f => f.id !== id), { ...target, parentId }] }
            return withExpandedChain(next, parentId)
          })
        },
        reveal(id) {
          update(s => withExpandedChain(s, id))
        },
        /** File one workspace under a group, or return it to the root with null. */
        assign(workspaceId, folderId) {
          update((s) => {
            let changed = false
            const folders = s.folders.map((folder) => {
              if (folder.id === folderId) {
                if (folder.workspaceIds.includes(workspaceId)) return folder
                changed = true
                return { ...folder, workspaceIds: [...folder.workspaceIds, workspaceId] }
              }
              if (!folder.workspaceIds.includes(workspaceId)) return folder
              changed = true
              return { ...folder, workspaceIds: folder.workspaceIds.filter(id => id !== workspaceId) }
            })
            if (!changed) return s
            const next = { ...s, folders }
            return folderId === null ? next : withExpandedChain(next, folderId)
          })
        },
        toggleExpanded(id) {
          update(s => ({
            ...s,
            folders: s.folders.map(f => (f.id === id ? { ...f, expanded: !f.expanded } : f)),
          }))
        },
        toggleWorkspace(workspaceId) {
          update(s => ({
            ...s,
            workspaceExpanded: { ...s.workspaceExpanded, [workspaceId]: s.workspaceExpanded[workspaceId] === false },
          }))
        },
        /** Whether archived sessions are listed (hidden by default). */
        setShowArchived(show) {
          update(s => (s.showArchived === show ? s : { ...s, showArchived: show === true }))
        },
        /** Hide one temporary workspace: the row leaves the list, nothing is deleted. */
        hideTemp(path) {
          update(s => (s.temp.hiddenPaths.includes(path)
            ? s
            : { ...s, temp: { ...s.temp, hiddenPaths: [...s.temp.hiddenPaths, path] } }))
        },
        /** Bring one hidden temporary workspace back into the list. */
        restoreTemp(path) {
          update(s => ({ ...s, temp: { ...s.temp, hiddenPaths: s.temp.hiddenPaths.filter(p => p !== path) } }))
        },
        toggleTempExpanded() {
          update(s => ({ ...s, temp: { ...s.temp, expanded: !s.temp.expanded } }))
        },
        /** Reveal or collapse the "Hidden" section inside the temporary group. */
        setShowTempHidden(show) {
          update(s => (s.temp.showHidden === show ? s : { ...s, temp: { ...s.temp, showHidden: show === true } }))
        },
        /** Drop hidden entries whose workspace no longer exists; callers gate on a known host home. */
        pruneTemp(validPaths) {
          update((s) => {
            const hiddenPaths = s.temp.hiddenPaths.filter(path => validPaths.has(path))
            return hiddenPaths.length === s.temp.hiddenPaths.length ? s : { ...s, temp: { ...s.temp, hiddenPaths } }
          })
        },
        /** Drop folder members and expansion entries of workspaces that no longer exist. */
        prune(validIds) {
          update((s) => {
            const knownFolderIds = new Set(s.folders.map(folder => folder.id))
            const folders = s.folders.map(folder => ({
              ...folder,
              parentId: folder.parentId !== null && !knownFolderIds.has(folder.parentId) ? null : folder.parentId,
              workspaceIds: folder.workspaceIds.filter(id => validIds.has(id)),
            }))
            const workspaceExpanded = Object.fromEntries(
              Object.entries(s.workspaceExpanded).filter(([id]) => validIds.has(id)),
            )
            const sameFolders = folders.length === s.folders.length
              && folders.every((folder, index) => {
                const before = s.folders[index]
                return before !== undefined
                  && before.parentId === folder.parentId
                  && before.workspaceIds.length === folder.workspaceIds.length
                  && before.workspaceIds.every((id, i) => id === folder.workspaceIds[i])
              })
            const sameExpansion = Object.keys(workspaceExpanded).length === Object.keys(s.workspaceExpanded).length
            return sameFolders && sameExpansion ? s : { ...s, folders, workspaceExpanded }
          })
        },
      }
    }

    /** One-slot request bus (folder menu action or add-workspace dialog state). */
    function createBus(initial = null) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) {
            try { listener() } catch { /* ignore one consumer */ }
          }
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    function mainSessionId(list) {
      return Object.values(list.byId).find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id
    }

    /** Join one path segment without importing a path module in the browser. */
    function joinPath(parent, child) {
      return parent.endsWith('/') || parent.endsWith('\\') ? `${parent}${child}` : `${parent}/${child}`
    }

    /** The host directory that holds every `tmp-*` temporary workspace directory. */
    function tempRootOf(home) {
      return TEMP_ROOT_SEGMENTS.reduce((parent, segment) => joinPath(parent, segment), home)
    }

    /**
     * Whether a workspace path is one temporary directory this feature owns:
     * a `tmp-*` child (not the root itself) below the shared temp root. The
     * companion plugin's Host half registers exactly these as workspaces.
     */
    function isTempPath(path, tempRoot) {
      if (typeof path !== 'string' || path === '') return false
      const normalized = path.replaceAll('\\', '/')
      if (!normalized.startsWith(`${tempRoot}/`)) return false
      const relative = normalized.slice(tempRoot.length + 1)
      const name = relative.includes('/') ? relative.slice(relative.lastIndexOf('/') + 1) : relative
      return name.startsWith('tmp-')
    }

    /** "Parent / Child" label for a group, used by move-to submenus. */
    function folderPathLabel(folders, folder) {
      const byId = new Map(folders.map(candidate => [candidate.id, candidate]))
      const names = []
      let cursor = folder
      while (cursor !== undefined) {
        names.unshift(cursor.name)
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
      }
      return names.join(' / ')
    }

    function relativeTime(updatedAt, now) {
      const delta = Math.max(0, now - updatedAt)
      if (delta < 60_000) return { unit: 'now' }
      if (delta < 3_600_000) return { unit: 'minute', n: Math.floor(delta / 60_000) }
      if (delta < 86_400_000) return { unit: 'hour', n: Math.floor(delta / 3_600_000) }
      return { unit: 'day', n: Math.floor(delta / 86_400_000) }
    }

    function indent(depth) {
      return {
        paddingInlineStart: `calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset) + ${depth * INDENT_PX}px)`,
        paddingInlineEnd: '8px',
      }
    }

    /** Order a workspace's members: pinned first, then recency, archived last. */
    function orderMembers(list, sessionIds, pinnedIds, archivedSet) {
      const pinnedRank = new Map(pinnedIds.map((id, index) => [id, index]))
      const members = []
      for (const id of sessionIds) {
        const summary = list.byId[id]
        if (summary !== undefined) members.push(summary)
      }
      members.sort((a, b) => {
        const pa = pinnedRank.has(a.id) ? pinnedRank.get(a.id) : Number.MAX_SAFE_INTEGER
        const pb = pinnedRank.has(b.id) ? pinnedRank.get(b.id) : Number.MAX_SAFE_INTEGER
        if (pa !== pb) return pa - pb
        const aa = archivedSet.has(a.id) ? 1 : 0
        const ab = archivedSet.has(b.id) ? 1 : 0
        if (aa !== ab) return aa - ab
        return b.updatedAt - a.updatedAt
      })
      return members
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    const svg = (paths, size = 16) => h(
      'svg',
      { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      paths,
    )

    const IconChevron = () => svg(h('path', {
      d: 'M6 3.5 10.5 8 6 12.5', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }))

    /** Filled folder silhouette: groups keep the filesystem-classification metaphor. */
    const IconFolder = ({ open }) => svg(
      open
        ? [
          h('path', {
            key: 'a',
            d: 'M2.5 4.6c0-.6.4-1 1-1h2.6l1.2 1.2h5.2c.6 0 1 .4 1 1v.4H2.5z',
            fill: 'currentColor', opacity: 0.9,
          }),
          h('path', {
            key: 'b',
            d: 'M2.5 6.6h11l-1.4 5.2c-.1.5-.6.8-1.1.8H3.9c-.5 0-.9-.3-1-.8z',
            fill: 'currentColor', opacity: 0.55,
          }),
        ]
        : h('path', {
          d: 'M2.5 4.6c0-.6.4-1 1-1h2.6l1.2 1.2h5.2c.6 0 1 .4 1 1v5.4c0 .6-.4 1-1 1H3.5c-.6 0-1-.4-1-1z',
          fill: 'currentColor', opacity: 0.8,
        }),
    )

    /** Outlined stack of disks: workspaces read as containers of sessions, not directories. */
    const IconWorkspace = ({ size = 16 }) => svg([
      h('ellipse', { key: 't', cx: 8, cy: 4.1, rx: 5.2, ry: 2.1, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', {
        key: 's',
        d: 'M2.8 4.1v7.8c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V4.1',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
      h('path', {
        key: 'm',
        d: 'M2.8 8c0 1.2 2.3 2.1 5.2 2.1S13.2 9.2 13.2 8',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
    ], size)

    /** Inbox tray: the catch-all pseudo-group for sessions outside any workspace. */
    const IconInbox = ({ size = 16 }) => svg([
      h('path', {
        key: 't',
        d: 'M2.5 9.4V5.3c0-.5.4-.9.9-.9h9.2c.5 0 .9.4.9.9v4.1',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
      h('path', {
        key: 'b',
        d: 'M2.5 9.4h3.1l1 1.7h2.8l1-1.7h3.1v1.6c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
    ], size)

    const IconEye = ({ size = 16 }) => svg([
      h('path', {
        key: 'o',
        d: 'M1.8 8s2.3-4 6.2-4 6.2 4 6.2 4-2.3 4-6.2 4S1.8 8 1.8 8z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('circle', { key: 'c', cx: 8, cy: 8, r: 1.9, stroke: 'currentColor', strokeWidth: 1.3 }),
    ], size)

    const IconEyeOff = ({ size = 16 }) => svg([
      h('path', {
        key: 'o',
        d: 'M1.8 8s2.3-4 6.2-4c1.3 0 2.5.4 3.5 1M14.2 8s-2.3 4-6.2 4c-1.3 0-2.5-.4-3.5-1',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
      h('path', { key: 's', d: 'm3 13 10-10', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconFolderPlus = ({ size = 16 }) => svg([
      h('path', {
        key: 'f',
        d: 'M1.8 4.4c0-.6.4-1 1-1h2.7l1.2 1.2h5.5c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'p', d: 'M8 7v3M6.5 8.5h3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    /** Stack + plus: adds a workspace, visually distinct from the group button. */
    const IconProjectAdd = ({ size = 16 }) => svg([
      h('ellipse', { key: 't', cx: 6.6, cy: 4.2, rx: 4, ry: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', {
        key: 's',
        d: 'M2.6 4.2v5.6c0 1 1.8 1.8 4 1.8 1.1 0 2.2-.2 3-.6',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
      h('path', {
        key: 'm',
        d: 'M2.6 7c0 1 1.8 1.8 4 1.8 1 0 1.9-.1 2.7-.5',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }),
      h('path', { key: 'p', d: 'M12.4 9.6v4M10.4 11.6h4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconNewChat = ({ size = 14 }) => svg([
      h('path', {
        key: 'c',
        d: 'M13 7.6a5.1 5.1 0 0 1-7.7 4.5L2.4 13l.9-2.8A5.1 5.1 0 1 1 13 7.6z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'p', d: 'M8 5.3v4.4M5.8 7.5h4.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconSearch = ({ size = 16 }) => svg([
      h('circle', { key: 'c', cx: 7, cy: 7, r: 4.2, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { key: 'l', d: 'm10.2 10.2 3 3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconClose = ({ size = 14 }) => svg(h('path', {
      d: 'm4 4 8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
    }), size)

    const IconUp = ({ size = 14 }) => svg(h('path', {
      d: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7', stroke: 'currentColor', strokeWidth: 1.4,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }), size)

    const IconMoveFolder = ({ size = 16 }) => svg([
      h('path', {
        key: 'f',
        d: 'M1.8 4.4c0-.6.4-1 1-1h2.7l1.2 1.2h5.5c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'l', d: 'M6 8h4M8.2 6.2 10 8l-1.8 1.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ], size)

    const IconRemoveFolder = ({ size = 16 }) => svg([
      h('path', {
        key: 'f',
        d: 'M1.8 4.4c0-.6.4-1 1-1h2.7l1.2 1.2h5.5c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'm', d: 'M6 8h4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconRename = ({ size = 16 }) => svg([
      h('path', {
        key: 'p',
        d: 'M10.6 2.9l2.5 2.5-7.3 7.3-3.1.6.6-3.1z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
    ], size)

    const IconTrash = ({ size = 16 }) => svg([
      h('path', {
        key: 'b',
        d: 'M3.5 4.5h9M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.6 4.5l.6 7.7c0 .4.4.8.9.8h3.8c.5 0 .9-.4.9-.8l.6-7.7',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
    ], size)

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dwf-root { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box; }
.dwf-root:not(.dwf-rail) { flex: none; max-height: 100cqh; }
.dwf-header { flex: none; display: flex; align-items: center; gap: 4px; height: 36px; padding-inline: var(--dsh-sidebar-row-padding) 4px; box-sizing: border-box; color: var(--dsw-alias-label-tertiary); }
.dwf-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 20px; }
.dwf-header-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.dwf-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dwf-icon-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
@media (hover: hover) { .dwf-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dwf-search { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 var(--dsh-sidebar-row-padding) 6px; }
.dwf-search-input { flex: 1; min-width: 0; height: 28px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 8px; }
.dwf-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: 8px; }
.dwf-row { display: flex; align-items: center; gap: var(--dsh-sidebar-label-gap); border-radius: var(--dsw-radius-md); border-inline: var(--dsh-sidebar-paint-inset) solid transparent; background-clip: padding-box; padding-block: 0; cursor: pointer; user-select: none; -webkit-user-select: none; color: var(--dsw-alias-label-primary); box-sizing: border-box; }
.dwf-folder-row { height: 30px; }
.dwf-workspace-row { height: 32px; }
.dwf-session-row { height: 32px; }
@media (hover: hover) { .dwf-row:hover { background-color: var(--dsw-alias-interactive-bg-hover); } }
.dwf-session-row.dwf-selected { background-color: var(--dsw-alias-interactive-bg-hover); }
.dwf-session-row.dwf-archived { color: var(--dsw-alias-label-secondary); }
.dwf-chevron { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.dwf-chevron svg { transition: transform 120ms ease; }
.dwf-chevron-open svg { transform: rotate(90deg); }
.dwf-glyph { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }
.dwf-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px; }
.dwf-folder-row .dwf-label { font-weight: 500; }
.dwf-count { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dwf-time { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dwf-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dwf-dot-idle { background: var(--dsw-alias-state-idle-primary); }
.dwf-dot-ongoing { background: var(--dsw-alias-brand-primary); }
.dwf-dot-done { background: var(--dsw-alias-state-success-primary); }
.dwf-dot-warning { background: var(--dsw-alias-state-warn-primary); }
.dwf-lead { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.dwf-actions { flex: none; display: none; align-items: center; gap: 0; }
@media (hover: hover) { .dwf-row:hover .dwf-actions { display: inline-flex; } .dwf-row:hover .dwf-time { display: none; } }
@media (hover: none) { .dwf-actions { display: inline-flex; } }
.dwf-actions .dwf-icon-btn { width: 24px; height: 24px; }
.dwf-input { flex: 1; min-width: 0; height: 24px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; padding: 0 6px; }
.dwf-drop { background-color: var(--dsw-alias-interactive-bg-hover); outline: 1px dashed var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dwf-dragging { opacity: 0.55; }
.dwf-glyph-current { color: var(--dsw-alias-brand-primary); }
.dwf-toggle-on { color: var(--dsw-alias-brand-primary); }
.dwf-dim { color: var(--dsw-alias-label-secondary); }
.dwf-empty { padding: 6px 12px 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dwf-hint { padding: 0 12px 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dwf-rail { flex: none; display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 4px; }
.dwf-rail-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
@media (hover: hover) { .dwf-rail-btn:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dwf-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); pointer-events: auto; padding: 24px; box-sizing: border-box; }
.dwf-modal { width: min(560px, 100%); max-height: min(560px, 100%); display: flex; flex-direction: column; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dwf-modal-title { flex: none; padding: 14px 16px 8px; font-size: 15px; font-weight: 600; }
.dwf-crumbs { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 0 16px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dwf-crumb { border: none; background: transparent; padding: 2px 4px; border-radius: var(--dsw-radius-sm); color: inherit; font: inherit; cursor: pointer; }
.dwf-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dwf-crumb-sep { color: var(--dsw-alias-label-tertiary); }
.dwf-dir-list { flex: 1; min-height: 96px; overflow-y: auto; margin: 0 8px; padding: 4px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); }
.dwf-dir-row { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; width: 100%; text-align: left; cursor: pointer; }
.dwf-dir-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dwf-dir-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwf-dir-note { padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dwf-modal-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px; }
.dwf-modal-error { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dwf-modal-spacer { flex: 1; }
.dwf-field { display: flex; align-items: center; gap: 6px; padding: 8px 16px 0; }
.dwf-button { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 6px 12px; cursor: pointer; }
.dwf-button-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dwf-button:disabled { opacity: 0.5; cursor: default; }
`

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
      const root = TEMP_ROOT_SEGMENTS.reduce((parent, segment) => joinPath(parent, segment), home)
      // Ensure every level once; an existing level answers directory-picker/exists.
      let parent = home
      try {
        for (const segment of TEMP_ROOT_SEGMENTS) {
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
        ctx.logger.warn('workspace-suite: falling back to a timestamped directory', error)
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


    /* ------------------------------------------------------------------ */
    /* Rows                                                                */
    /* ------------------------------------------------------------------ */

    function InlineNameInput({ initial, placeholder, onCommit, onCancel }) {
      const [value, setValue] = useState(initial ?? '')
      const ref = useRef(null)
      useEffect(() => {
        ref.current?.focus()
        ref.current?.select()
      }, [])
      return h('input', {
        ref,
        className: 'dwf-input',
        type: 'text',
        value,
        placeholder,
        'aria-label': placeholder,
        onChange: event => { setValue(event.target.value) },
        onClick: event => { event.stopPropagation() },
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            const name = value.trim()
            if (name === '') onCancel()
            else onCommit(name)
          } else if (event.key === 'Escape') {
            onCancel()
          }
          event.stopPropagation()
        },
        onBlur: () => { onCancel() },
      })
    }

    function FolderRow({
      folder, count, depth, expanded, renaming, isDropTarget, isFolderDragSource, t,
      onToggle, onRenameCommit, onRenameCancel, onFolderDragStart, onFolderDragEnd, onDragOver, onDragLeave, onDrop,
      useContextMenu, renderFactorySlot,
    }) {
      const { getTriggerProps } = useContextMenu()
      const target = { kind: 'folder', value: { folderId: folder.id } }
      return h('div', {
        className: `dwf-row dwf-folder-row${isDropTarget ? ' dwf-drop' : ''}${isFolderDragSource ? ' dwf-dragging' : ''}`,
        style: indent(depth),
        role: 'treeitem',
        'aria-expanded': expanded,
        'aria-level': depth + 1,
        onClick: onToggle,
        draggable: !renaming,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move'
          try { event.dataTransfer.setData('text/x-dsh-folder', folder.id) } catch { /* ignore */ }
          onFolderDragStart()
        },
        onDragEnd: () => { onFolderDragEnd() },
        onDragOver,
        onDragLeave,
        onDrop,
        ...getTriggerProps(target),
      },
      h('span', { className: `dwf-chevron${expanded ? ' dwf-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevron)),
      h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: expanded })),
      renaming
        ? h(InlineNameInput, {
          initial: folder.name,
          placeholder: t('folder.name.placeholder'),
          onCommit: onRenameCommit,
          onCancel: onRenameCancel,
        })
        : h('span', { className: 'dwf-label' }, folder.name),
      !renaming && count > 0 && h('span', { className: 'dwf-count' }, String(count)),
      !renaming && h('span', { className: 'dwf-actions', onClick: event => { event.stopPropagation() } },
        renderFactorySlot('contextMenu.button', {
          target,
          label: t('folder.actions', { name: folder.name }),
          className: 'dwf-icon-btn',
        }),
      ))
    }

    /**
     * The built-in "Temporary workspaces" group row: not a stored folder, not
     * draggable, and not a drop target. Its eye button (visible only once
     * something is hidden) expands the in-group "Hidden" section.
     */
    function TempFolderRow({ count, hiddenCount, depth, expanded, showHidden, t, onToggle, onToggleHidden }) {
      return h('div', {
        className: 'dwf-row dwf-folder-row',
        style: indent(depth),
        role: 'treeitem',
        'aria-expanded': expanded,
        'aria-level': depth + 1,
        onClick: onToggle,
      },
      h('span', { className: `dwf-chevron${expanded ? ' dwf-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevron)),
      h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: expanded })),
      h('span', { className: 'dwf-label' }, t('temp.title')),
      count > 0 && h('span', { className: 'dwf-count' }, String(count)),
      hiddenCount > 0 && h('span', {
        className: 'dwf-count dwf-dim',
        title: t('temp.showHiddenCount', { n: hiddenCount }),
      }, `+${hiddenCount}`),
      h('span', { className: 'dwf-actions', onClick: event => { event.stopPropagation() } },
        hiddenCount > 0 && h('button', {
          type: 'button',
          className: `dwf-icon-btn${showHidden ? ' dwf-toggle-on' : ''}`,
          'aria-label': showHidden ? t('temp.collapseHidden') : t('temp.showHiddenCount', { n: hiddenCount }),
          title: showHidden ? t('temp.collapseHidden') : t('temp.showHiddenCount', { n: hiddenCount }),
          'aria-pressed': showHidden,
          onClick: onToggleHidden,
        }, showHidden ? h(IconEye) : h(IconEyeOff))))
    }

    /**
     * One workspace row. `temp` marks the built-in temporary group's members:
     * `'visible'` rows add the hide action and stop being draggable, and
     * `'hidden'` rows render dimmed, nested under the "Hidden" header, with a
     * restore action instead.
     */
    function WorkspaceRow({
      workspace, title, depth, expanded, containsCurrent, isDropTarget, temp, t,
      onToggle, onCreate, onDragStart, onDragEnd, onHide, onRestore,
      useWorkspaceAccess, useContextMenu, renderFactorySlot,
    }) {
      const { getTriggerProps } = useContextMenu()
      const canCreate = useWorkspaceAccess(workspace.workspaceId, 'session/create')
      const target = { kind: 'workspace', value: { workspaceId: workspace.workspaceId, path: workspace.path, displayTitle: title } }
      return h('div', {
        className: `dwf-row dwf-workspace-row${isDropTarget ? ' dwf-drop' : ''}${temp === 'hidden' ? ' dwf-dim' : ''}`,
        style: indent(depth),
        role: 'treeitem',
        'aria-expanded': expanded,
        'aria-level': depth + 1,
        'aria-description': temp === 'hidden' ? t('temp.hidden') : undefined,
        'data-ws-row': workspace.workspaceId,
        onClick: onToggle,
        draggable: temp === undefined,
        onDragStart: (event) => {
          if (temp !== undefined) return
          event.dataTransfer.effectAllowed = 'move'
          try { event.dataTransfer.setData('text/x-dsh-workspace', workspace.workspaceId) } catch { /* ignore */ }
          onDragStart()
        },
        onDragEnd: () => { onDragEnd() },
        ...getTriggerProps(target),
      },
      h('span', { className: `dwf-chevron${expanded ? ' dwf-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevron)),
      h('span', { className: `dwf-glyph${containsCurrent ? ' dwf-glyph-current' : ''}`, 'aria-hidden': true },
        h(IconWorkspace)),
      h('span', { className: 'dwf-label' }, title),
      h('span', { className: 'dwf-actions', onClick: event => { event.stopPropagation() } },
        temp === 'visible' && h('button', {
          type: 'button',
          className: 'dwf-icon-btn',
          'aria-label': t('temp.hide'),
          title: t('temp.hideHint'),
          onClick: onHide,
        }, h(IconEyeOff)),
        temp === 'hidden' && h('button', {
          type: 'button',
          className: 'dwf-icon-btn',
          'aria-label': t('temp.restore'),
          title: t('temp.restore'),
          onClick: onRestore,
        }, h(IconEye)),
        temp !== 'hidden' && canCreate && h('button', {
          type: 'button',
          className: 'dwf-icon-btn',
          'aria-label': t('workspace.newSession', { name: title }),
          title: t('workspace.newSession', { name: title }),
          onClick: onCreate,
        }, h(IconNewChat)),
        renderFactorySlot('contextMenu.button', {
          target,
          label: t('workspace.actions', { name: title }),
          className: 'dwf-icon-btn',
        }),
      ))
    }

    function SessionRow({
      node, depth, selected, now, t, onOpen,
      renderFactorySlot, useContextMenu,
    }) {
      const { getTriggerProps } = useContextMenu()
      const displayTitle = node.blank ? t('session.new') : (node.title || t('session.untitled'))
      const status = node.status
      let dot = 'idle'
      if (status?.pendingInteraction !== undefined) dot = 'warning'
      else if (status?.running === true) dot = 'ongoing'
      else if (status?.completionUnread === true) dot = 'done'
      const time = relativeTime(node.updatedAt, now)
      const target = { kind: 'session', value: { sessionId: node.id, displayTitle: node.title } }
      return h('div', {
        className: `dwf-row dwf-session-row${selected ? ' dwf-selected' : ''}${node.archived ? ' dwf-archived' : ''}`,
        style: indent(depth),
        role: 'treeitem',
        'aria-selected': selected,
        'aria-level': depth + 1,
        'aria-description': node.archived ? t('session.archived') : undefined,
        tabIndex: 0,
        onClick: () => { onOpen(node) },
        ...getTriggerProps(node.blank ? undefined : target, {
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return
            if (event.key !== 'Enter' && event.key !== ' ') return
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            event.preventDefault()
            onOpen(node)
          },
        }),
      },
      h('span', { className: 'dwf-lead' },
        node.archived || node.blank
          ? null
          : dot === 'idle'
            ? null
            : h('span', { className: `dwf-dot dwf-dot-${dot}` }),
      ),
      h('span', { className: 'dwf-label' }, displayTitle),
      !node.blank && h('span', { className: 'dwf-time' }, time.unit === 'now'
        ? t('time.now')
        : t(`time.${time.unit}`, { n: time.n })),
      !node.blank && h('span', { className: 'dwf-actions', onClick: event => { event.stopPropagation() } },
        renderFactorySlot('contextMenu.button', {
          target,
          label: t('session.actions', { name: displayTitle }),
          className: 'dwf-icon-btn',
        }),
      ))
    }

    /* ------------------------------------------------------------------ */
    /* Add-workspace dialog (frame overlay entry)                          */
    /* ------------------------------------------------------------------ */

    function AddWorkspaceDialog({ bus, t, listDirectory, createDirectory, createWorkspace, startSession, notify }) {
      const open = useSyncExternalStore(bus.subscribe, bus.get, bus.get)
      const [listing, setListing] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [newName, setNewName] = useState('')
      const dialogRef = useRef(null)
      const requestSeq = useRef(0)

      const load = useCallback((path) => {
        const seq = ++requestSeq.current
        setBusy(true)
        setError(null)
        Promise.resolve(listDirectory(path)).then((next) => {
          if (seq !== requestSeq.current) return
          setListing(next)
          setBusy(false)
        }).catch((reason) => {
          if (seq !== requestSeq.current) return
          setBusy(false)
          setError(String((reason && reason.message) || reason))
        })
      }, [listDirectory])

      useEffect(() => {
        if (!open) return
        setListing(null)
        setError(null)
        setNewName('')
        load(undefined)
      }, [open, load])

      useEffect(() => {
        if (open) dialogRef.current?.focus()
      }, [open])

      const close = () => { bus.set(false) }

      const choose = () => {
        if (listing === null || busy) return
        setBusy(true)
        Promise.resolve(createWorkspace({ path: listing.path })).then((workspace) => {
          setBusy(false)
          close()
          startSession(workspace.workspaceId, { clearPreviousDraft: false })
        }).catch((reason) => {
          setBusy(false)
          const message = String((reason && reason.message) || reason)
          setError(t('dialog.error', { message }))
          notify(t('dialog.error', { message }))
        })
      }

      const create = () => {
        const name = newName.trim()
        if (name === '' || listing === null || busy) return
        setBusy(true)
        setError(null)
        Promise.resolve(createDirectory(listing.path, name)).then((path) => {
          setNewName('')
          setBusy(false)
          load(path)
        }).catch((reason) => {
          setBusy(false)
          setError(String((reason && reason.message) || reason))
        })
      }

      if (!open) return null

      return h('div', {
        className: 'dwf-backdrop',
        onClick: (event) => { if (event.target === event.currentTarget) close() },
        onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } },
      },
      h('div', {
        ref: dialogRef,
        className: 'dwf-modal',
        role: 'dialog',
        'aria-modal': true,
        'aria-label': t('dialog.title'),
        tabIndex: -1,
      },
      h('div', { className: 'dwf-modal-title' }, t('dialog.title')),
      listing !== null && h('div', { className: 'dwf-crumbs' },
        h('button', {
          type: 'button',
          className: 'dwf-crumb',
          onClick: () => { load(listing.home) },
        }, t('dialog.home')),
        ...listing.crumbs.map(crumb => h(Fragment, { key: crumb.path },
          h('span', { className: 'dwf-crumb-sep', 'aria-hidden': true }, '/'),
          h('button', {
            type: 'button',
            className: 'dwf-crumb',
            onClick: () => { load(crumb.path) },
          }, crumb.name),
        )),
      ),
      h('div', { className: 'dwf-dir-list', role: 'listbox', 'aria-label': t('dialog.title') },
        listing === null
          ? h('div', { className: 'dwf-dir-note' }, t('dialog.loading'))
          : listing.entries.length === 0
            ? h('div', { className: 'dwf-dir-note' }, t('dialog.empty'))
            : listing.entries.map(entry => h('button', {
              key: entry.path,
              type: 'button',
              className: 'dwf-dir-row',
              role: 'option',
              onClick: () => { load(entry.path) },
            },
            h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: false })),
            h('span', { className: 'dwf-dir-name' }, entry.name),
            )),
      ),
      h('div', { className: 'dwf-field' },
        h('input', {
          className: 'dwf-input',
          type: 'text',
          value: newName,
          placeholder: t('dialog.newFolder'),
          'aria-label': t('dialog.newFolder'),
          onChange: event => { setNewName(event.target.value) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            create()
          },
        }),
        h('button', {
          type: 'button',
          className: 'dwf-button',
          disabled: newName.trim() === '' || busy,
          onClick: create,
        }, t('dialog.create')),
      ),
      error !== null && h('div', { className: 'dwf-modal-error', style: { padding: '8px 16px 0' } }, error),
      h('div', { className: 'dwf-modal-foot' },
        h('span', { className: 'dwf-modal-spacer' }),
        h('button', { type: 'button', className: 'dwf-button', onClick: close }, t('dialog.cancel')),
        h('button', {
          type: 'button',
          className: 'dwf-button dwf-button-primary',
          disabled: listing === null || busy,
          onClick: choose,
        }, busy ? t('dialog.busy') : t('dialog.choose')),
      )))
    }

    /* ------------------------------------------------------------------ */
    /* Browser                                                             */
    /* ------------------------------------------------------------------ */

    function WorkspaceFoldersBrowser(props) {
      const {
        wide, expandSidebar, useSectionScroller, useSessions, useSessionStatus,
        useWorkspaces, useWorkspaceAccess, useContextMenu, renderFactorySlot, t,
        startSession, open, notify, folderStore, folderActions, addWorkspaceBus, hostHome,
      } = props

      const list = useSessions(state => state)
      const statuses = useSessionStatus(state => state)
      const workspaceState = useWorkspaces(state => state)
      const storeState = useSyncExternalStore(folderStore.subscribe, folderStore.get, folderStore.get)
      const action = useSyncExternalStore(folderActions.subscribe, folderActions.get, folderActions.get)
      const home = useSyncExternalStore(hostHome.subscribe, hostHome.getSnapshot, hostHome.getSnapshot)
      const sectionScroller = useSectionScroller()
      const defaultWorkspaceName = t('workspace.defaultName')

      const [now, setNow] = useState(() => Date.now())
      /** null while idle, otherwise `{ parent: folderId | null }` for the inline rename row. */
      const [creating, setCreating] = useState(null)
      const [searchOpen, setSearchOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [draggingId, setDraggingId] = useState(null)
      const [draggingFolderId, setDraggingFolderId] = useState(null)
      const [dropFolderId, setDropFolderId] = useState(null)
      const searchRef = useRef(null)

      useEffect(() => {
        const timer = window.setInterval(() => { setNow(Date.now()) }, CLOCK_MS)
        return () => { window.clearInterval(timer) }
      }, [])

      useEffect(() => {
        if (searchOpen) searchRef.current?.focus({ preventScroll: true })
      }, [searchOpen])

      // A "New subgroup" menu action asks for an inline input under that group.
      useEffect(() => {
        if (action === null || action.mode !== 'create-child') return
        setCreating({ parent: action.folderId })
        folderActions.set(null)
      }, [action, folderActions])

      const workspaces = workspaceState.items ?? []
      const workspacePhase = workspaceState.phase
      const archivedSessionIds = workspaceState.archivedSessionIds ?? []
      const pinnedSessionIds = workspaceState.pinnedSessionIds ?? []
      const workspaceReady = workspacePhase === 'ready'
      const archivedSet = new Set(archivedSessionIds)
      const showArchived = storeState.showArchived === true
      const currentId = mainSessionId(list)

      // Temporary workspaces: known only once the Host home is, so an unknown
      // home leaves the temp set empty (and pruning below untouched) instead
      // of guessing paths from workspace titles.
      const tempRoot = typeof home === 'string' && home !== '' ? tempRootOf(home).replaceAll('\\', '/') : null
      const isTemp = workspace => tempRoot !== null && isTempPath(workspace.path, tempRoot)
      const tempWorkspaces = workspaces.filter(isTemp)
      const tempIds = new Set(tempWorkspaces.map(workspace => workspace.workspaceId))
      const hiddenTempPaths = new Set(storeState.temp.hiddenPaths)
      const visibleTemp = tempWorkspaces.filter(workspace => !hiddenTempPaths.has(workspace.path))
      const hiddenTemp = tempWorkspaces.filter(workspace => hiddenTempPaths.has(workspace.path))

      useEffect(() => {
        if (!workspaceReady) return
        folderStore.prune(new Set(workspaces.map(workspace => workspace.workspaceId)))
        if (tempRoot !== null) {
          const tempPaths = new Set(workspaces
            .filter(workspace => isTempPath(workspace.path, tempRoot))
            .map(workspace => workspace.path))
          folderStore.pruneTemp(tempPaths)
        }
      }, [workspaceReady, workspaces, tempRoot, folderStore])

      const byId = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]))
      const folderById = new Map(storeState.folders.map(folder => [folder.id, folder]))
      /** Direct child groups per parent key (null = root level), in store order. */
      const folderChildren = new Map()
      for (const folder of storeState.folders) {
        if (!folderChildren.has(folder.parentId)) folderChildren.set(folder.parentId, [])
        folderChildren.get(folder.parentId).push(folder)
      }
      const childFoldersOf = folderId => folderChildren.get(folderId) ?? []
      const descendantsOf = (folderId) => {
        const out = []
        const stack = [...childFoldersOf(folderId)]
        while (stack.length > 0) {
          const folder = stack.pop()
          out.push(folder)
          stack.push(...childFoldersOf(folder.id))
        }
        return out
      }
      /**
       * Registered workspaces directly filed under this group. Temporary
       * workspaces never render here: even a stale stored membership from
       * before they were pinned stays out of the user tree.
       */
      const ownWorkspacesOf = folder => folder.workspaceIds
        .map(id => byId.get(id))
        .filter(workspace => workspace !== undefined && !tempIds.has(workspace.workspaceId))
      /** Member count shown on a group row: the whole subtree's workspaces. */
      const folderCount = (folder) => {
        let count = ownWorkspacesOf(folder).length
        for (const descendant of descendantsOf(folder.id)) count += ownWorkspacesOf(descendant).length
        return count
      }

      const titleOf = useCallback((workspace) => {
        if (workspace.title === 'default-workspace') return defaultWorkspaceName
        return workspace.title || defaultWorkspaceName
      }, [defaultWorkspaceName])

      /** Visible member rows of one workspace (blank placeholder only while current). */
      const membersOf = (workspace) => orderMembers(list, workspace.sessionIds, pinnedSessionIds, archivedSet)
        .filter((summary) => {
          if (summary.origin === 'subagent') return false
          if (summary.blank) return summary.id === currentId
          if (!showArchived && archivedSet.has(summary.id)) return false
          return true
        })

      const q = query.trim().toLowerCase()
      const sessionMatches = summary => q !== '' && (
        (summary.title ?? '').toLowerCase().includes(q) || summary.id.toLowerCase().includes(q)
      )
      const memberCache = new Map()
      const membersCached = (workspace) => {
        if (!memberCache.has(workspace.workspaceId)) memberCache.set(workspace.workspaceId, membersOf(workspace))
        return memberCache.get(workspace.workspaceId)
      }
      const workspaceMatches = (workspace) => {
        if (q === '') return true
        if (titleOf(workspace).toLowerCase().includes(q)) return true
        if (workspace.path.toLowerCase().includes(q)) return true
        return membersCached(workspace).some(sessionMatches)
      }
      /** A group matches when its name, any of its workspaces, or any descendant matches. */
      const subtreeMatches = (folder) => {
        if (folder.name.toLowerCase().includes(q)) return true
        if (ownWorkspacesOf(folder).some(workspaceMatches)) return true
        return childFoldersOf(folder.id).some(subtreeMatches)
      }

      const filed = new Set(storeState.folders.flatMap(folder => folder.workspaceIds))
      const rootWorkspaces = workspaces.filter(workspace => !filed.has(workspace.workspaceId) && !tempIds.has(workspace.workspaceId))
      const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
      const looseMembers = list.ids
        .map(id => list.byId[id])
        .filter(summary => summary !== undefined
          && !accounted.has(summary.id)
          && summary.origin !== 'subagent'
          && !(summary.blank && summary.id !== currentId)
          && (showArchived || !archivedSet.has(summary.id)))

      const sessionNode = (summary) => ({
        id: summary.id,
        title: summary.title ?? '',
        blank: summary.blank === true,
        archived: archivedSet.has(summary.id),
        updatedAt: summary.updatedAt,
        status: statuses.get(summary.id),
      })

      const openSession = (node) => {
        if (node.archived) {
          notify(t('session.archived'))
          return
        }
        open(node.id)
      }

      const beginCreate = (parent = null) => { setCreating({ parent }) }
      const commitCreate = (name) => {
        folderStore.create(name, creating === null ? null : creating.parent)
        setCreating(null)
      }
      const cancelCreate = () => { setCreating(null) }
      const cancelRename = () => { folderActions.set(null) }
      const commitRename = (folderId, name) => {
        folderStore.rename(folderId, name)
        folderActions.set(null)
      }

      const toggleWorkspace = (workspaceId) => { folderStore.toggleWorkspace(workspaceId) }
      const isExpanded = workspaceId => storeState.workspaceExpanded[workspaceId] !== false

      /** A folder drop is allowed on any group except itself and its own descendants. */
      const canDropFolderOn = (targetFolderId) => {
        if (draggingFolderId === null) return false
        if (draggingFolderId === targetFolderId) return false
        for (let cursor = targetFolderId; cursor !== null; cursor = folderById.get(cursor)?.parentId ?? null) {
          if (cursor === draggingFolderId) return false
        }
        return true
      }

      const rows = []
      const inlineCreateRow = (depth) => h('div', {
        key: `creating:${creating === null ? 'root' : creating.parent ?? 'root'}`,
        className: 'dwf-row dwf-folder-row',
        style: indent(depth),
      },
      h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: true })),
      h(InlineNameInput, {
        initial: '',
        placeholder: t('folder.name.placeholder'),
        onCommit: commitCreate,
        onCancel: cancelCreate,
      }),
      )

      const emitSession = (summary, depth) => {
        rows.push(h(SessionRow, {
          key: `session:${summary.id}`,
          node: sessionNode(summary),
          depth,
          selected: summary.id === currentId,
          now,
          t,
          onOpen: openSession,
          renderFactorySlot,
          useContextMenu,
        }))
      }

      const emitWorkspace = (workspace, depth, tempVariant) => {
        if (!workspaceMatches(workspace)) return
        const title = titleOf(workspace)
        const expanded = q !== '' || isExpanded(workspace.workspaceId)
        rows.push(h(WorkspaceRow, {
          key: `ws:${workspace.workspaceId}`,
          workspace,
          title,
          depth,
          expanded,
          containsCurrent: membersCached(workspace).some(node => node.id === currentId),
          isDropTarget: false,
          temp: tempVariant,
          t,
          useWorkspaceAccess,
          useContextMenu,
          renderFactorySlot,
          onToggle: () => { toggleWorkspace(workspace.workspaceId) },
          onCreate: () => { startSession(workspace.workspaceId) },
          onHide: () => {
            folderStore.hideTemp(workspace.path)
            // The row vanishes silently otherwise; the toast says nothing was
            // deleted and carries the one-click way back.
            notify(t('temp.hiddenNotice', { name: title }), true, {
              label: t('temp.restore'),
              run: () => { folderStore.restoreTemp(workspace.path) },
              failureLabel: t('temp.restore'),
            })
          },
          onRestore: () => { folderStore.restoreTemp(workspace.path) },
          onDragStart: () => { setDraggingId(workspace.workspaceId) },
          onDragEnd: () => { setDraggingId(null); setDropFolderId(null) },
        }))
        if (!expanded) return
        for (const summary of membersCached(workspace)) {
          if (q !== '' && !sessionMatches(summary) && summary.id !== currentId) continue
          emitSession(summary, depth + 1)
        }
      }

      const emitFolder = (folder, depth) => {
        if (q !== '' && !subtreeMatches(folder)) return
        const expandedForQuery = q !== '' || folder.expanded
        const childFolders = childFoldersOf(folder.id)
        const ownWorkspaces = ownWorkspacesOf(folder)
        rows.push(h(FolderRow, {
          key: `folder:${folder.id}`,
          folder,
          count: folderCount(folder),
          depth,
          expanded: expandedForQuery,
          renaming: action !== null && action.mode === 'rename' && action.folderId === folder.id,
          isDropTarget: dropFolderId === folder.id,
          isFolderDragSource: draggingFolderId === folder.id,
          t,
          useContextMenu,
          renderFactorySlot,
          onToggle: () => { folderStore.toggleExpanded(folder.id) },
          onRenameCommit: name => { commitRename(folder.id, name) },
          onRenameCancel: cancelRename,
          onFolderDragStart: () => { setDraggingFolderId(folder.id) },
          onFolderDragEnd: () => { setDraggingFolderId(null); setDropFolderId(null) },
          onDragOver: (event) => {
            if (draggingId === null && draggingFolderId === null) return
            if (draggingFolderId !== null && !canDropFolderOn(folder.id)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropFolderId(folder.id)
          },
          onDragLeave: () => { setDropFolderId(current => (current === folder.id ? null : current)) },
          onDrop: (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (draggingFolderId !== null) {
              if (canDropFolderOn(folder.id)) folderStore.move(draggingFolderId, folder.id)
            } else {
              const workspaceId = draggingId ?? event.dataTransfer.getData('text/x-dsh-workspace')
              // Temporary workspaces are pinned to their built-in group.
              if (workspaceId !== null && workspaceId !== '' && !tempIds.has(workspaceId)) folderStore.assign(workspaceId, folder.id)
            }
            setDraggingId(null)
            setDraggingFolderId(null)
            setDropFolderId(null)
          },
        }))
        if (!expandedForQuery) return
        if (creating !== null && creating.parent === folder.id) rows.push(inlineCreateRow(depth + 1))
        if (childFolders.length === 0 && ownWorkspaces.length === 0 && (creating === null || creating.parent !== folder.id)) {
          rows.push(h('div', { key: `empty:${folder.id}`, className: 'dwf-hint', style: indent(depth + 1) }, t('folder.empty')))
          return
        }
        for (const child of childFolders) emitFolder(child, depth + 1)
        for (const workspace of ownWorkspaces) emitWorkspace(workspace, depth + 1)
      }

      /**
       * The built-in temporary group, pinned above every user group. Hidden
       * rows leave the main list but stay reachable through the in-group
       * "Hidden" section; a search forces both levels open.
       */
      const emitTempFolder = () => {
        if (tempRoot === null) return
        if (tempWorkspaces.length === 0) return
        const title = t('temp.title')
        const matches = q === ''
          || title.toLowerCase().includes(q)
          || tempWorkspaces.some(workspaceMatches)
        if (!matches) return
        const expanded = q !== '' || storeState.temp.expanded
        const showHidden = q !== '' || storeState.temp.showHidden
        rows.push(h(TempFolderRow, {
          key: 'temp-folder',
          count: visibleTemp.length,
          hiddenCount: hiddenTemp.length,
          depth: 0,
          expanded,
          showHidden,
          t,
          onToggle: () => { folderStore.toggleTempExpanded() },
          onToggleHidden: () => { folderStore.setShowTempHidden(!storeState.temp.showHidden) },
        }))
        if (!expanded) return
        for (const workspace of visibleTemp) emitWorkspace(workspace, 1, 'visible')
        if (hiddenTemp.length > 0) {
          rows.push(h('div', {
            key: 'temp-hidden',
            className: 'dwf-row dwf-folder-row dwf-dim',
            style: indent(1),
            role: 'treeitem',
            'aria-expanded': showHidden,
            'aria-level': 2,
            onClick: () => { folderStore.setShowTempHidden(!storeState.temp.showHidden) },
          },
          h('span', { className: `dwf-chevron${showHidden ? ' dwf-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevron)),
          h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconEyeOff)),
          h('span', { className: 'dwf-label' }, t('temp.hidden')),
          h('span', { className: 'dwf-count' }, String(hiddenTemp.length))))
          if (showHidden) {
            // One level below the "Hidden" header: the nesting is real for
            // both the indent and the aria-level, so the header's chevron
            // matches the rows it owns.
            for (const workspace of hiddenTemp) emitWorkspace(workspace, 2, 'hidden')
          }
        }
      }

      emitTempFolder()
      for (const folder of childFoldersOf(null)) emitFolder(folder, 0)
      for (const workspace of rootWorkspaces) emitWorkspace(workspace, 0)

      const visibleLoose = looseMembers.filter(summary => q === '' || sessionMatches(summary))
      if (visibleLoose.length > 0) {
        rows.push(h('div', {
          key: 'group:ungrouped',
          className: 'dwf-row dwf-folder-row',
          style: indent(0),
          role: 'treeitem',
          'aria-expanded': true,
        },
        h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconInbox)),
        h('span', { className: 'dwf-label' }, t('group.ungrouped')),
        ))
        for (const summary of visibleLoose) {
          rows.push(h(SessionRow, {
            key: `session:${summary.id}`,
            node: sessionNode(summary),
            depth: 1,
            selected: summary.id === currentId,
            now,
            t,
            onOpen: openSession,
            renderFactorySlot,
            useContextMenu,
          }))
        }
      }

      const style = h('style', { key: 'workspace-suite-css' }, CSS)

      if (!wide) {
        return h(Fragment, null,
          style,
          h('div', { className: 'dwf-root dwf-rail' },
            h('button', {
              type: 'button',
              className: 'dwf-rail-btn',
              'aria-label': t('rail.expand'),
              title: t('rail.expand'),
              onClick: () => { expandSidebar(); beginCreate(null) },
            }, h(IconFolderPlus, { size: 18 })),
          ),
        )
      }

      return h(Fragment, null,
        style,
        h('div', { className: 'dwf-root' },
          h('div', { className: 'dwf-header' },
            h('span', { className: 'dwf-title' }, t('section.title')),
            h('div', { className: 'dwf-header-actions' },
              h('button', {
                type: 'button',
                className: `dwf-icon-btn${showArchived ? ' dwf-toggle-on' : ''}`,
                'aria-label': showArchived ? t('archive.hide') : t('archive.show'),
                title: showArchived ? t('archive.hide') : t('archive.show'),
                'aria-pressed': showArchived,
                onClick: () => { folderStore.setShowArchived(!showArchived) },
              }, showArchived ? h(IconEye) : h(IconEyeOff)),
              h('button', {
                type: 'button',
                className: 'dwf-icon-btn',
                'aria-label': searchOpen ? t('search.clear') : t('search.placeholder'),
                title: searchOpen ? t('search.clear') : t('search.placeholder'),
                onClick: () => {
                  if (searchOpen) {
                    setQuery('')
                    setSearchOpen(false)
                  } else {
                    setSearchOpen(true)
                  }
                },
              }, searchOpen ? h(IconClose) : h(IconSearch)),
              h('button', {
                type: 'button',
                className: 'dwf-icon-btn',
                'aria-label': t('folder.new'),
                title: t('folder.new'),
                onClick: () => { beginCreate(null) },
              }, h(IconFolderPlus)),
              h('button', {
                type: 'button',
                className: 'dwf-icon-btn',
                'aria-label': t('workspace.add'),
                title: t('workspace.add'),
                onClick: () => { addWorkspaceBus.set(true) },
              }, h(IconProjectAdd)),
            ),
          ),
          searchOpen && h('div', { className: 'dwf-search' },
            h('input', {
              ref: searchRef,
              className: 'dwf-search-input',
              type: 'text',
              value: query,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              onChange: event => { setQuery(event.target.value) },
              onKeyDown: (event) => {
                if (event.key !== 'Escape') return
                setQuery('')
                setSearchOpen(false)
              },
            }),
          ),
          h('div', {
            className: 'dwf-list',
            ref: sectionScroller.bindScrollerRef,
            role: 'tree',
            'aria-label': t('section.title'),
            onDragOver: (event) => {
              if (draggingId === null && draggingFolderId === null) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            },
            onDrop: (event) => {
              if (event.target !== event.currentTarget) return
              event.preventDefault()
              if (draggingFolderId !== null) {
                folderStore.move(draggingFolderId, null)
              } else {
                const workspaceId = draggingId ?? event.dataTransfer.getData('text/x-dsh-workspace')
                if (workspaceId !== null && workspaceId !== '' && !tempIds.has(workspaceId)) folderStore.assign(workspaceId, null)
              }
              setDraggingId(null)
              setDraggingFolderId(null)
              setDropFolderId(null)
            },
          },
          creating !== null && creating.parent === null && inlineCreateRow(0),
          ...rows,
          workspaceReady && workspaces.length === 0 && h('div', { className: 'dwf-empty' }, t('empty.none')),
          q !== '' && rows.length === 0 && h('div', { className: 'dwf-empty' }, t('search.empty')),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'workspace-suite: locale')
      const t = ctx.locale.bind(NS)

      // Temporary-session notices share one store between the trigger and the
      // overlay toast; dispose listeners with the plugin.
      const notices = createNoticeStore()
      ctx.effect(() => () => notices.dispose(), 'workspace-suite: notice lifetime')
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
            ctx.logger.warn('workspace-suite: the temporary Workspace did not appear before the deadline')
            notices.report(t('error.attach'))
          }).catch((error) => {
            ctx.logger.warn('workspace-suite: creating the temporary session failed', error)
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

      const WSDIALOG_CSS = `
      .dsh-wsd-backdrop {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.4);
      }
      .dsh-wsd {
        box-sizing: border-box;
        width: min(400px, calc(100vw - 48px));
        padding: 16px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-elevation-prominent);
      }
      .dsh-wsd-title { margin: 0 0 8px; font-size: 14px; font-weight: 600; line-height: 20px; }
      .dsh-wsd-body { margin: 0 0 12px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .dsh-wsd-input {
        box-sizing: border-box;
        width: 100%;
        margin-bottom: 12px;
        padding: 6px 10px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 20px;
      }
      .dsh-wsd-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .dsh-wsd-btn {
        padding: 5px 14px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 20px;
        cursor: pointer;
      }
      .dsh-wsd-btn[disabled] { opacity: 0.5; cursor: default; }
      .dsh-wsd-btn-danger {
        border-color: transparent;
        background: var(--dsw-alias-bg-critical, #d64545);
        color: #fff;
      }
      .dsh-wsd-error { margin: 0 0 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-critical, #d64545); }
      .dsh-wsd-check {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 4px;
        font-size: 13px;
        line-height: 20px;
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .dsh-wsd-check input { margin: 0; accent-color: var(--dsw-alias-bg-critical, #d64545); }
      .dsh-wsd-hint {
        margin: 0 0 12px 22px;
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
      `

      /** Dialog heading per request mode. */
      const dialogTitleKey = mode => (mode === 'rename'
        ? 'wsdialog.renameTitle'
        : mode === 'delete-session' ? 'wsdialog.sessionTitle' : 'wsdialog.deleteTitle')

      /**
       * Confirm dialog for the workspace rename and delete this replacement
       * browser owns. The shipped browser renders its own dialogs, but it is
       * shadowed by the folder browser, so without this component the native
       * menu entries would resolve and then do nothing.
       */
      function WorkspaceActionDialog({ bus, t, renameWorkspace, deleteWorkspace, deleteWorkspaceWithFiles, countWorkspaceSessions, deleteSession }) {
        const request = useSyncExternalStore(bus.subscribe, bus.get, bus.get)
        const [draft, setDraft] = useState(request?.title ?? '')
        const [withFiles, setWithFiles] = useState(false)
        const [withDeleteSessions, setWithDeleteSessions] = useState(false)
        const [sessionCount, setSessionCount] = useState(0)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState(null)
        const inputRef = useRef(null)
        useEffect(() => {
          if (request === null) return
          setDraft(request.title)
          setWithFiles(false)
          setWithDeleteSessions(false)
          setSessionCount(request.mode === 'delete' ? countWorkspaceSessions(request.workspaceId) : 0)
          setError(null)
          setBusy(false)
        }, [request])
        useEffect(() => {
          if (request?.mode === 'rename') inputRef.current?.focus()
        }, [request])
        if (request === null) return null
        const close = () => { if (!busy) bus.set(null) }
        const trimmed = draft.trim()
        const renameBlocked = busy || trimmed === '' || trimmed === request.title
        const confirm = () => {
          if (busy) return
          setBusy(true)
          setError(null)
          const run = request.mode === 'delete-session'
            ? deleteSession(request.workspaceId)
            : request.mode === 'delete'
              ? (withFiles === true || withDeleteSessions === true
                  ? deleteWorkspaceWithFiles(request.workspaceId, { deleteFiles: withFiles, deleteSessions: withDeleteSessions })
                  : deleteWorkspace(request.workspaceId))
              : renameWorkspace(request.workspaceId, trimmed)
          Promise.resolve(run).then(() => { bus.set(null) }).catch(reason => {
            setBusy(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          })
        }
        return h(React.Fragment, null,
          h('style', null, WSDIALOG_CSS),
          h('div', {
            className: 'dsh-wsd-backdrop',
            onClick: close,
            onKeyDown: (event) => {
              if (event.key === 'Escape') close()
            },
          },
          h('div', {
            className: 'dsh-wsd',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t(dialogTitleKey(request.mode)),
            onClick: (event) => { event.stopPropagation() },
          },
          h('h2', { className: 'dsh-wsd-title' }, t(dialogTitleKey(request.mode))),
          request.mode === 'delete-session'
            ? h('p', { className: 'dsh-wsd-body' }, t('wsdialog.sessionBody', { name: request.title }))
            : request.mode === 'delete'
            ? h(React.Fragment, null,
              h('p', { className: 'dsh-wsd-body' }, t('wsdialog.deleteBody', { name: request.title })),
              h('label', { className: 'dsh-wsd-check' },
                h('input', {
                  type: 'checkbox',
                  checked: withFiles,
                  onChange: (event) => { setWithFiles(event.target.checked) },
                }),
                h('span', null, t('wsdialog.deleteFiles'))),
              withFiles && h('p', { className: 'dsh-wsd-hint' }, t('wsdialog.deleteFilesHint')),
              sessionCount > 0 && h('label', { className: 'dsh-wsd-check' },
                h('input', {
                  type: 'checkbox',
                  checked: withDeleteSessions,
                  onChange: (event) => { setWithDeleteSessions(event.target.checked) },
                }),
                h('span', null, t('wsdialog.deleteSessions', { n: sessionCount }))))
            : h('label', null,
              h('div', { className: 'dsh-wsd-body' }, t('wsdialog.nameLabel')),
              h('input', {
                ref: inputRef,
                className: 'dsh-wsd-input',
                value: draft,
                onChange: (event) => { setDraft(event.target.value) },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !renameBlocked) confirm()
                },
              })),
          error !== null && h('p', { className: 'dsh-wsd-error' }, t('wsdialog.error', { message: error })),
          h('div', { className: 'dsh-wsd-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-wsd-btn',
              disabled: busy,
              onClick: close,
            }, t('wsdialog.cancel')),
            h('button', {
              type: 'button',
              className: `dsh-wsd-btn${request.mode !== 'rename' ? ' dsh-wsd-btn-danger' : ''}`,
              disabled: busy || (request.mode === 'rename' && renameBlocked),
              onClick: confirm,
            }, busy
              ? t('wsdialog.busy')
              : t(request.mode === 'rename' ? 'wsdialog.confirmRename' : 'wsdialog.confirmDelete'))))))
      }

      // The temporary-session trigger beside the sidebar's New Session row.
      ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
        name: 'sidebar.session.action',
        id: 'workspace-suite.temp-session',
        locale: NS,
      }, TempSessionTrigger))
      const folderStore = createFolderStore()
      const folderActions = createBus()
      const addWorkspaceBus = createBus(false)
      /** Owns the rename/delete confirm dialog for this replacement browser. */
      const workspaceDialogBus = createBus(null)

      const injectProps = () => ({
        startSession: (workspaceId, options) => { ctx.uiWorkspace.startSession(workspaceId, options) },
        open: sessionId => { ctx.uiWorkspace.openSession(sessionId) },
        notify: (text, success, action) => { ctx.contextMenus.notify(text, success, action) },
        folderStore,
        folderActions,
        addWorkspaceBus,
        // The temp root depends on Host facts, so the browser reads the home
        // through a hook instead of a value frozen into the inject factory.
        hostHome: {
          getSnapshot: () => (typeof ctx.remote.$host?.home === 'string' ? ctx.remote.$host.home : ''),
          subscribe: listener => ctx.on('connection/reset', listener),
        },
      })

      /** The temp root right now, for menu resolution outside React. */
      const tempRootNow = () => {
        const home = typeof ctx.remote.$host?.home === 'string' ? ctx.remote.$host.home : ''
        return home === '' ? null : tempRootOf(home).replaceAll('\\', '/')
      }

      // Shadow the shipped browser (lowest priority renders). Declaring the
      // shipped child seats again is rejected, so this seat owns only the list.
      ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces',
        priority: -1,
        locale: NS,
        inject: injectProps,
      }, WorkspaceFoldersBrowser))

      // Group menu: new subgroup, rename in place, move within the tree,
      // delete with an undo notice.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.folder',
        target: 'folder',
        order: 100,
        resolve: ({ folderId }) => {
          const state = folderStore.get()
          const folder = state.folders.find(candidate => candidate.id === folderId)
          if (folder === undefined) return []
          const descendantIds = new Set()
          const pending = [folderId]
          while (pending.length > 0) {
            const id = pending.pop()
            for (const candidate of state.folders) {
              if (candidate.parentId === id && !descendantIds.has(candidate.id)) {
                descendantIds.add(candidate.id)
                pending.push(candidate.id)
              }
            }
          }
          const moveTargets = state.folders
            .filter(candidate => candidate.id !== folderId && !descendantIds.has(candidate.id))
            .map(candidate => ({
              id: `to:${candidate.id}`,
              label: folderPathLabel(state.folders, candidate),
              run: () => { folderStore.move(folderId, candidate.id) },
            }))
          return [
            {
              id: 'new-subgroup',
              label: t('folder.newChild'),
              icon: { key: 'workspace-suite.newsub' },
              run: () => {
                folderStore.reveal(folderId)
                folderActions.set({ mode: 'create-child', folderId })
              },
            },
            {
              id: 'rename',
              label: t('folder.rename'),
              icon: { key: 'workspace-suite.rename' },
              run: () => { folderActions.set({ mode: 'rename', folderId }) },
            },
            {
              id: 'move-to-folder',
              label: t('folder.move'),
              icon: { key: 'workspace-suite.move' },
              children: [
                {
                  id: 'to:root',
                  label: t('folder.root'),
                  run: () => { folderStore.move(folderId, null) },
                },
                ...moveTargets,
              ],
            },
            {
              id: 'delete',
              label: t('folder.delete'),
              icon: { key: 'workspace-suite.delete' },
              danger: true,
              separatorBefore: true,
              run: () => {
                const snapshot = folderStore.remove(folder.id)
                folderActions.set(null)
                ctx.contextMenus.notify(t('folder.deleted', { name: folder.name }), true, {
                  label: t('undo'),
                  run: () => { folderStore.restore(snapshot) },
                  failureLabel: t('undo'),
                })
              },
            },
          ]
        },
      }), 'workspace-suite: folder menu')

      // Temporary-workspace menu: hide instead of delete, restore from the
      // group's "Hidden" section. The registration, directory, and sessions
      // are all kept — the shipped delete stays available for real removal.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.temp',
        target: 'workspace',
        order: 150,
        resolve: ({ path, displayTitle }) => {
          const tempRoot = tempRootNow()
          if (tempRoot === null || !isTempPath(path, tempRoot)) return []
          const hidden = folderStore.get().temp.hiddenPaths.includes(path)
          return [hidden
            ? {
              id: 'restore',
              label: t('temp.restore'),
              icon: { key: 'workspace-suite.eye' },
              run: () => { folderStore.restoreTemp(path) },
            }
            : {
              id: 'hide',
              label: t('temp.hide'),
              icon: { key: 'workspace-suite.eyeOff' },
              run: () => {
                folderStore.hideTemp(path)
                ctx.contextMenus.notify(t('temp.hiddenNotice', { name: displayTitle }), true, {
                  label: t('temp.restore'),
                  run: () => { folderStore.restoreTemp(path) },
                  failureLabel: t('temp.restore'),
                })
              },
            }]
        },
      }), 'workspace-suite: temp menu')

      // Workspace rename and delete owned by this browser: the shipped menu
      // entries only stage a request that the shipped browser's dialogs
      // consume, and this folder browser shadows that browser, so the plugin
      // provides the working pair (plus its confirm dialog, above). Gated the
      // same way the shipped entries are.
      const workspaceAccessAllowed = (workspaceId, action) => {
        try {
          const gate = ctx.remoteAccess?.source?.(`workspace`, workspaceId, action)
          return gate === undefined || gate === null || gate.getSnapshot() !== false
        } catch {
          return true
        }
      }
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.ws-rename',
        target: 'workspace',
        order: 98,
        resolve: ({ workspaceId, displayTitle }) => workspaceAccessAllowed(workspaceId, 'workspace/rename')
          ? [{
            id: 'rename-workspace',
            label: t('workspace.rename'),
            icon: { key: 'workspace-suite.rename' },
            run: () => { workspaceDialogBus.set({ mode: 'rename', workspaceId, title: displayTitle }) },
          }]
          : [],
      }), 'workspace-suite: rename workspace menu')

      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.ws-delete',
        target: 'workspace',
        order: 298,
        resolve: ({ workspaceId, displayTitle }) => workspaceAccessAllowed(workspaceId, 'workspace/delete')
          ? [{
            id: 'delete-workspace',
            label: t('workspace.delete'),
            icon: { key: 'workspace-suite.delete' },
            danger: true,
            separatorBefore: true,
            run: () => { workspaceDialogBus.set({ mode: 'delete', workspaceId, title: displayTitle }) },
          }]
          : [],
      }), 'workspace-suite: delete workspace menu')

      // Session menu: permanently delete one persisted session and its
      // storage artifact. The Host route refuses sessions that are open in
      // the running process, and the dialog surfaces that error.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.session-delete',
        target: 'session',
        order: 300,
        resolve: ({ sessionId, displayTitle }) => [sessionId !== '' ? {
          id: 'delete-session',
          label: t('menu.deleteSession'),
          icon: { key: 'workspace-suite.delete' },
          danger: true,
          separatorBefore: true,
          run: () => { workspaceDialogBus.set({ mode: 'delete-session', workspaceId: sessionId, title: displayTitle }) },
        } : []],
      }), 'workspace-suite: delete session menu')

      // Workspace menu: move into a group (nested groups carry their path),
      // or back to the root. Temporary workspaces are pinned and offer the
      // hide/restore pair above instead.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-suite.move',
        target: 'workspace',
        order: 200,
        resolve: ({ workspaceId, path }) => {
          const tempRoot = tempRootNow()
          if (tempRoot !== null && isTempPath(path, tempRoot)) return []
          const state = folderStore.get()
          const current = state.folders.find(folder => folder.workspaceIds.includes(workspaceId))
          const actions = []
          if (state.folders.length > 0) {
            actions.push({
              id: 'move-to-folder',
              label: t('workspace.moveTo'),
              icon: { key: 'workspace-suite.move' },
              children: state.folders.map(folder => ({
                id: `to:${folder.id}`,
                label: folderPathLabel(state.folders, folder),
                run: () => { folderStore.assign(workspaceId, folder.id) },
              })),
            })
          }
          if (current !== undefined) {
            actions.push({
              id: 'remove-from-folder',
              label: t('workspace.removeFrom'),
              icon: { key: 'workspace-suite.remove' },
              run: () => { folderStore.assign(workspaceId, null) },
            })
          }
          return actions
        },
      }), 'workspace-suite: move workspace menu')

      // Overlay layer: the add-workspace dialog, then the temporary-session
      // error toast, both frame-wide.
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-suite.add-workspace',
          order: 40,
          locale: NS,
        }, function AddWorkspaceOverlay(props) {
          return h(AddWorkspaceDialog, {
            bus: addWorkspaceBus,
            t: props.t,
            listDirectory: path => ctx.uiWorkspace.listDirectory(path),
            createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
            createWorkspace: input => ctx.workspaces.create(input),
            startSession: (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options),
            notify: (text) => { ctx.contextMenus.notify(text) },
          })
        })
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-suite.temp-toast',
          locale: NS,
          order: 80,
        }, TempWorkspaceToast)
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-suite.ws-dialog',
          locale: NS,
          order: 60,
        }, function WorkspaceActionDialogSlot(props) {
          return h(WorkspaceActionDialog, {
            bus: workspaceDialogBus,
            t: props.t,
            renameWorkspace: (workspaceId, title) => ctx.workspaces.rename(workspaceId, title),
            deleteWorkspace: workspaceId => ctx.workspaces.delete(workspaceId),
            deleteWorkspaceWithFiles: async (workspaceId, { deleteFiles, deleteSessions }) => {
              const response = await fetch('/plugins/workspace-suite/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, deleteFiles, deleteSessions }),
              })
              const payload = await response.json().catch(() => null)
              if (!response.ok) {
                throw new Error(payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
                  ? payload.error
                  : `HTTP ${response.status}`)
              }
            },
            deleteSession: async sessionId => {
              const response = await fetch('/plugins/workspace-suite/delete-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              })
              const payload = await response.json().catch(() => null)
              if (!response.ok) {
                throw new Error(payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
                  ? payload.error
                  : `HTTP ${response.status}`)
              }
            },
            countWorkspaceSessions: workspaceId => {
              const snapshot = ctx.workspaces.list.getSnapshot()
              const workspace = snapshot.items.find(item => item.workspaceId === workspaceId)
              if (workspace === undefined) return 0
              return workspace.sessionIds.length
            },
          })
        })
      })

      ctx.slots.inject('contextMenu.icon', function* () {
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.newsub' }, IconFolderPlus)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.rename' }, IconRename)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.delete' }, IconTrash)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.move' }, IconMoveFolder)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.remove' }, IconRemoveFolder)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.eye' }, IconEye)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-suite.eyeOff' }, IconEyeOff)
      })
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'workspaces', 'contextMenus', 'remote', 'remoteAccess', 'locale'],
      apply,
    }
  },
})
