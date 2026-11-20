/**
 * Client half of the Workspace folders bundle.
 *
 * Shadows the sidebar's `sidebar.workspaces` seat (priority -1; the shipped
 * browser stays registered at 0 and returns when this plugin unloads) and
 * renders the browsing region as `virtual folder > workspace > session`.
 * Folders are a view-only classification stored in this browser; no directory
 * on disk is created, moved, or renamed.
 *
 * The seat cannot re-declare the shipped browser's child slots (a register
 * call rejects an already-declared child), so this half owns the surfaces it
 * needs itself: the workspace/session context menus come from the shared
 * context-menu service, and adding a workspace uses a small in-plugin
 * directory dialog instead of the shipped directory-flow slot.
 */
window.__ModuleLoader__.load({
  id: '@local/workspace-folders',
  factory(require) {
    const React = require('react')
    const {
      Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React
    const h = React.createElement

    const NS = 'workspace-folders'
    const STORAGE_KEY = 'dsh.workspace.folders.v1'
    /** Extra inline padding per nesting level (folder > workspace > session). */
    const INDENT_PX = 14
    /** Milliseconds between relative-time refreshes while the sidebar is visible. */
    const CLOCK_MS = 60_000

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copies of locale/*.json, minus metadata)      */
    /* ------------------------------------------------------------------ */

    const en = {
      'section.title': 'Workspaces',
      'group.ungrouped': 'Ungrouped',
      'folder.new': 'New folder',
      'folder.name.placeholder': 'Folder name',
      'folder.actions': 'Actions for folder {name}',
      'folder.rename': 'Rename folder',
      'folder.delete': 'Delete folder',
      'folder.deleted': 'Deleted folder "{name}"',
      'folder.count': '{n} workspaces',
      'folder.empty': 'Empty folder. Drag a workspace here.',
      undo: 'Undo',
      'workspace.newSession': 'New session in {name}',
      'workspace.moveTo': 'Move to folder',
      'workspace.removeFrom': 'Remove from folder',
      'workspace.add': 'Add workspace',
      'workspace.defaultName': 'Workspace',
      'workspace.actions': 'Actions for workspace {name}',
      'session.new': 'New session',
      'session.untitled': 'Untitled',
      'session.actions': 'Actions for session {name}',
      'session.archived': 'This session is archived and cannot be opened',
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
      'section.title': '工作区',
      'group.ungrouped': '未分组',
      'folder.new': '新建文件夹',
      'folder.name.placeholder': '文件夹名称',
      'folder.actions': '文件夹 {name} 的操作',
      'folder.rename': '重命名文件夹',
      'folder.delete': '删除文件夹',
      'folder.deleted': '已删除文件夹“{name}”',
      'folder.count': '{n} 个工作区',
      'folder.empty': '空文件夹，可把工作区拖到这里',
      undo: '撤销',
      'workspace.newSession': '在 {name} 中新建会话',
      'workspace.moveTo': '移入文件夹',
      'workspace.removeFrom': '移出文件夹',
      'workspace.add': '添加工作区',
      'workspace.defaultName': '工作区',
      'workspace.actions': '工作区 {name} 的操作',
      'session.new': '新会话',
      'session.untitled': '未命名',
      'session.actions': '会话 {name} 的操作',
      'session.archived': '该会话已归档，无法打开',
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
      return { version: 1, folders: [], workspaceExpanded: {} }
    }

    /** Keep only well-formed folders and boolean expansion entries. */
    function normalizeState(raw) {
      if (raw === null || typeof raw !== 'object' || raw.version !== 1) return emptyState()
      const folders = []
      if (Array.isArray(raw.folders)) {
        for (const folder of raw.folders) {
          if (folder === null || typeof folder !== 'object') continue
          if (typeof folder.id !== 'string' || typeof folder.name !== 'string') continue
          const workspaceIds = Array.isArray(folder.workspaceIds)
            ? [...new Set(folder.workspaceIds.filter(id => typeof id === 'string'))]
            : []
          folders.push({ id: folder.id, name: folder.name, workspaceIds, expanded: folder.expanded !== false })
        }
      }
      const workspaceExpanded = {}
      if (raw.workspaceExpanded !== null && typeof raw.workspaceExpanded === 'object') {
        for (const [key, value] of Object.entries(raw.workspaceExpanded)) {
          if (typeof value === 'boolean') workspaceExpanded[key] = value
        }
      }
      return { version: 1, folders, workspaceExpanded }
    }

    function createFolderStore() {
      let state
      try {
        state = normalizeState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null'))
      } catch {
        state = emptyState()
      }
      const listeners = new Set()
      const commit = (next) => {
        if (next === state) return
        state = next
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
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
      return {
        get,
        subscribe,
        /** Create a folder at the end of the order and mark it expanded. */
        create(name) {
          const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
          update(s => ({
            ...s,
            folders: [...s.folders, { id, name, workspaceIds: [], expanded: true }],
          }))
          return id
        },
        rename(id, name) {
          update(s => ({ ...s, folders: s.folders.map(f => (f.id === id ? { ...f, name } : f)) }))
        },
        /** Delete a folder; its workspaces return to the root. */
        remove(id) {
          update(s => ({ ...s, folders: s.folders.filter(f => f.id !== id) }))
        },
        restore(folder) {
          update(s => (s.folders.some(f => f.id === folder.id) ? s : { ...s, folders: [...s.folders, folder] }))
        },
        toggleExpanded(id) {
          update(s => ({
            ...s,
            folders: s.folders.map(f => (f.id === id ? { ...f, expanded: !f.expanded } : f)),
          }))
        },
        /** File one workspace under a folder, or return it to the root with null. */
        assign(workspaceId, folderId) {
          update((s) => {
            let changed = false
            const folders = s.folders.map((folder) => {
              if (folder.id === folderId) {
                if (folder.workspaceIds.includes(workspaceId)) return folder
                changed = true
                return { ...folder, workspaceIds: [...folder.workspaceIds, workspaceId], expanded: true }
              }
              if (!folder.workspaceIds.includes(workspaceId)) return folder
              changed = true
              return { ...folder, workspaceIds: folder.workspaceIds.filter(id => id !== workspaceId) }
            })
            return changed ? { ...s, folders } : s
          })
        },
        toggleWorkspace(workspaceId) {
          update(s => ({
            ...s,
            workspaceExpanded: { ...s.workspaceExpanded, [workspaceId]: s.workspaceExpanded[workspaceId] === false },
          }))
        },
        /** Drop folder members and expansion entries of workspaces that no longer exist. */
        prune(validIds) {
          update((s) => {
            const folders = s.folders.map(folder => ({
              ...folder,
              workspaceIds: folder.workspaceIds.filter(id => validIds.has(id)),
            }))
            const workspaceExpanded = Object.fromEntries(
              Object.entries(s.workspaceExpanded).filter(([id]) => validIds.has(id)),
            )
            const sameFolders = folders.length === s.folders.length
              && folders.every((folder, index) => {
                const before = s.folders[index]
                return before !== undefined
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

    const IconFolderPlus = ({ size = 16 }) => svg([
      h('path', {
        key: 'f',
        d: 'M1.8 4.4c0-.6.4-1 1-1h2.7l1.2 1.2h5.5c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'p', d: 'M8 7v3M6.5 8.5h3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    ], size)

    const IconProjectAdd = ({ size = 16 }) => svg([
      h('path', {
        key: 'b',
        d: 'M2 3.8c0-.5.4-.9.9-.9h3.2l1.1 1.1h4.9c.5 0 .9.4.9.9v6.8c0 .5-.4.9-.9.9H2.9c-.5 0-.9-.4-.9-.9z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { key: 'p', d: 'M10.6 5.2v4.4M8.4 7.4h4.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
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
      folder, count, depth, expanded, renaming, isDropTarget, t,
      onToggle, onRenameCommit, onRenameCancel, onDragOver, onDragLeave, onDrop,
      useContextMenu, renderFactorySlot,
    }) {
      const { getTriggerProps } = useContextMenu()
      const target = { kind: 'folder', value: { folderId: folder.id } }
      return h('div', {
        className: `dwf-row dwf-folder-row${isDropTarget ? ' dwf-drop' : ''}`,
        style: indent(depth),
        role: 'treeitem',
        'aria-expanded': expanded,
        onClick: onToggle,
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

    function WorkspaceRow({
      workspace, title, depth, expanded, containsCurrent, isDropTarget, t,
      onToggle, onCreate, onDragStart, onDragEnd,
      useWorkspaceAccess, useContextMenu, renderFactorySlot,
    }) {
      const { getTriggerProps } = useContextMenu()
      const canCreate = useWorkspaceAccess(workspace.workspaceId, 'session/create')
      const target = { kind: 'workspace', value: { workspaceId: workspace.workspaceId, path: workspace.path, displayTitle: title } }
      return h('div', {
        className: `dwf-row dwf-workspace-row${isDropTarget ? ' dwf-drop' : ''}`,
        style: indent(depth),
        role: 'treeitem',
        'aria-expanded': expanded,
        'data-ws-row': workspace.workspaceId,
        onClick: onToggle,
        draggable: true,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move'
          try { event.dataTransfer.setData('text/x-dsh-workspace', workspace.workspaceId) } catch { /* ignore */ }
          onDragStart()
        },
        onDragEnd: () => { onDragEnd() },
        ...getTriggerProps(target),
      },
      h('span', { className: `dwf-chevron${expanded ? ' dwf-chevron-open' : ''}`, 'aria-hidden': true }, h(IconChevron)),
      h('span', { className: 'dwf-glyph', 'aria-hidden': true },
        h(IconFolder, { open: expanded && containsCurrent })),
      h('span', { className: 'dwf-label' }, title),
      h('span', { className: 'dwf-actions', onClick: event => { event.stopPropagation() } },
        canCreate && h('button', {
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
        startSession, open, notify, folderStore, folderActions, addWorkspaceBus,
      } = props

      const list = useSessions(state => state)
      const statuses = useSessionStatus(state => state)
      const workspaceState = useWorkspaces(state => state)
      const storeState = useSyncExternalStore(folderStore.subscribe, folderStore.get, folderStore.get)
      const action = useSyncExternalStore(folderActions.subscribe, folderActions.get, folderActions.get)
      const sectionScroller = useSectionScroller()
      const defaultWorkspaceName = t('workspace.defaultName')

      const [now, setNow] = useState(() => Date.now())
      const [creating, setCreating] = useState(false)
      const [searchOpen, setSearchOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [draggingId, setDraggingId] = useState(null)
      const [dropFolderId, setDropFolderId] = useState(null)
      const searchRef = useRef(null)

      useEffect(() => {
        const timer = window.setInterval(() => { setNow(Date.now()) }, CLOCK_MS)
        return () => { window.clearInterval(timer) }
      }, [])

      useEffect(() => {
        if (searchOpen) searchRef.current?.focus({ preventScroll: true })
      }, [searchOpen])

      const workspaces = workspaceState.items ?? []
      const workspacePhase = workspaceState.phase
      const archivedSessionIds = workspaceState.archivedSessionIds ?? []
      const pinnedSessionIds = workspaceState.pinnedSessionIds ?? []
      const workspaceReady = workspacePhase === 'ready'
      const archivedSet = new Set(archivedSessionIds)
      const currentId = mainSessionId(list)

      useEffect(() => {
        if (!workspaceReady) return
        folderStore.prune(new Set(workspaces.map(workspace => workspace.workspaceId)))
      }, [workspaceReady, workspaces, folderStore])

      const byId = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]))
      const folderOf = new Map()
      for (const folder of storeState.folders) {
        for (const id of folder.workspaceIds) {
          if (!folderOf.has(id)) folderOf.set(id, folder.id)
        }
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
      const folderMatches = (folder) => {
        if (q === '') return true
        if (folder.name.toLowerCase().includes(q)) return true
        return folder.workspaceIds.some((id) => {
          const workspace = byId.get(id)
          return workspace !== undefined && workspaceMatches(workspace)
        })
      }

      const folderEntries = storeState.folders.map(folder => ({
        folder,
        workspaces: folder.workspaceIds.map(id => byId.get(id)).filter(workspace => workspace !== undefined),
      }))
      const filed = new Set(folderEntries.flatMap(entry => entry.workspaces.map(workspace => workspace.workspaceId)))
      const rootWorkspaces = workspaces.filter(workspace => !filed.has(workspace.workspaceId))
      const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
      const looseMembers = list.ids
        .map(id => list.byId[id])
        .filter(summary => summary !== undefined
          && !accounted.has(summary.id)
          && summary.origin !== 'subagent'
          && !(summary.blank && summary.id !== currentId))

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

      const beginCreate = () => { setCreating(true) }
      const commitCreate = (name) => {
        folderStore.create(name)
        setCreating(false)
      }
      const cancelCreate = () => { setCreating(false) }
      const cancelRename = () => { folderActions.set(null) }
      const commitRename = (folderId, name) => {
        folderStore.rename(folderId, name)
        folderActions.set(null)
      }

      const toggleWorkspace = (workspaceId) => { folderStore.toggleWorkspace(workspaceId) }
      const isExpanded = workspaceId => storeState.workspaceExpanded[workspaceId] !== false

      const rows = []
      for (const entry of folderEntries) {
        const { folder } = entry
        if (!folderMatches(folder)) continue
        const expandedForQuery = q !== '' || folder.expanded
        rows.push(h(FolderRow, {
          key: `folder:${folder.id}`,
          folder,
          count: entry.workspaces.length,
          depth: 0,
          expanded: expandedForQuery,
          renaming: action !== null && action.mode === 'rename' && action.folderId === folder.id,
          isDropTarget: dropFolderId === folder.id,
          t,
          useContextMenu,
          renderFactorySlot,
          onToggle: () => { folderStore.toggleExpanded(folder.id) },
          onRenameCommit: name => { commitRename(folder.id, name) },
          onRenameCancel: cancelRename,
          onDragOver: (event) => {
            if (draggingId === null) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropFolderId(folder.id)
          },
          onDragLeave: () => { setDropFolderId(current => (current === folder.id ? null : current)) },
          onDrop: (event) => {
            event.preventDefault()
            event.stopPropagation()
            const workspaceId = draggingId ?? event.dataTransfer.getData('text/x-dsh-workspace')
            if (workspaceId !== null && workspaceId !== '') folderStore.assign(workspaceId, folder.id)
            setDraggingId(null)
            setDropFolderId(null)
          },
        }))
        if (!expandedForQuery) continue
        if (entry.workspaces.length === 0) {
          rows.push(h('div', { key: `empty:${folder.id}`, className: 'dwf-hint', style: indent(1) }, t('folder.empty')))
          continue
        }
        for (const workspace of entry.workspaces) {
          if (!workspaceMatches(workspace)) continue
          const title = titleOf(workspace)
          const expanded = q !== '' || isExpanded(workspace.workspaceId)
          rows.push(h(WorkspaceRow, {
            key: `ws:${workspace.workspaceId}`,
            workspace,
            title,
            depth: 1,
            expanded,
            containsCurrent: membersCached(workspace).some(node => node.id === currentId),
            isDropTarget: false,
            t,
            useWorkspaceAccess,
            useContextMenu,
            renderFactorySlot,
            onToggle: () => { toggleWorkspace(workspace.workspaceId) },
            onCreate: () => { startSession(workspace.workspaceId) },
            onDragStart: () => { setDraggingId(workspace.workspaceId) },
            onDragEnd: () => { setDraggingId(null); setDropFolderId(null) },
          }))
          if (!expanded) continue
          for (const summary of membersCached(workspace)) {
            if (q !== '' && !sessionMatches(summary) && summary.id !== currentId) continue
            rows.push(h(SessionRow, {
              key: `session:${summary.id}`,
              node: sessionNode(summary),
              depth: 2,
              selected: summary.id === currentId,
              now,
              t,
              onOpen: openSession,
              renderFactorySlot,
              useContextMenu,
            }))
          }
        }
      }

      for (const workspace of rootWorkspaces) {
        if (!workspaceMatches(workspace)) continue
        const title = titleOf(workspace)
        const expanded = q !== '' || isExpanded(workspace.workspaceId)
        rows.push(h(WorkspaceRow, {
          key: `ws:${workspace.workspaceId}`,
          workspace,
          title,
          depth: 0,
          expanded,
          containsCurrent: membersCached(workspace).some(node => node.id === currentId),
          isDropTarget: false,
          t,
          useWorkspaceAccess,
          useContextMenu,
          renderFactorySlot,
          onToggle: () => { toggleWorkspace(workspace.workspaceId) },
          onCreate: () => { startSession(workspace.workspaceId) },
          onDragStart: () => { setDraggingId(workspace.workspaceId) },
          onDragEnd: () => { setDraggingId(null); setDropFolderId(null) },
        }))
        if (!expanded) continue
        for (const summary of membersCached(workspace)) {
          if (q !== '' && !sessionMatches(summary) && summary.id !== currentId) continue
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

      const visibleLoose = looseMembers.filter(summary => q === '' || sessionMatches(summary))
      if (visibleLoose.length > 0) {
        rows.push(h('div', {
          key: 'group:ungrouped',
          className: 'dwf-row dwf-folder-row',
          style: indent(0),
          role: 'treeitem',
          'aria-expanded': true,
        },
        h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: true })),
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

      const style = h('style', { key: 'workspace-folders-css' }, CSS)

      if (!wide) {
        return h(Fragment, null,
          style,
          h('div', { className: 'dwf-root dwf-rail' },
            h('button', {
              type: 'button',
              className: 'dwf-rail-btn',
              'aria-label': t('rail.expand'),
              title: t('rail.expand'),
              onClick: () => { expandSidebar(); beginCreate() },
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
                onClick: beginCreate,
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
              if (draggingId === null) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            },
            onDrop: (event) => {
              if (event.target !== event.currentTarget) return
              event.preventDefault()
              const workspaceId = draggingId ?? event.dataTransfer.getData('text/x-dsh-workspace')
              if (workspaceId !== null && workspaceId !== '') folderStore.assign(workspaceId, null)
              setDraggingId(null)
              setDropFolderId(null)
            },
          },
          creating && h('div', { className: 'dwf-row dwf-folder-row', style: indent(0) },
            h('span', { className: 'dwf-glyph', 'aria-hidden': true }, h(IconFolder, { open: true })),
            h(InlineNameInput, {
              initial: '',
              placeholder: t('folder.name.placeholder'),
              onCommit: commitCreate,
              onCancel: cancelCreate,
            }),
          ),
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
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'workspace-folders: locale')
      const t = ctx.locale.bind(NS)
      const folderStore = createFolderStore()
      const folderActions = createBus()
      const addWorkspaceBus = createBus(false)

      const injectProps = () => ({
        startSession: (workspaceId, options) => { ctx.uiWorkspace.startSession(workspaceId, options) },
        open: sessionId => { ctx.uiWorkspace.openSession(sessionId) },
        notify: (text, success, action) => { ctx.contextMenus.notify(text, success, action) },
        folderStore,
        folderActions,
        addWorkspaceBus,
      })

      // Shadow the shipped browser (lowest priority renders). Declaring the
      // shipped child seats again is rejected, so this seat owns only the list.
      ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces',
        priority: -1,
        locale: NS,
        inject: injectProps,
      }, WorkspaceFoldersBrowser))

      // Folder menu: rename in place, delete with an undo notice.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-folders.folder',
        target: 'folder',
        order: 100,
        resolve: ({ folderId }) => {
          const folder = folderStore.get().folders.find(candidate => candidate.id === folderId)
          if (folder === undefined) return []
          return [
            {
              id: 'rename',
              label: t('folder.rename'),
              icon: { key: 'workspace-folders.rename' },
              run: () => { folderActions.set({ mode: 'rename', folderId }) },
            },
            {
              id: 'delete',
              label: t('folder.delete'),
              icon: { key: 'workspace-folders.delete' },
              danger: true,
              separatorBefore: true,
              run: () => {
                folderStore.remove(folder.id)
                folderActions.set(null)
                ctx.contextMenus.notify(t('folder.deleted', { name: folder.name }), true, {
                  label: t('undo'),
                  run: () => { folderStore.restore(folder) },
                  failureLabel: t('undo'),
                })
              },
            },
          ]
        },
      }), 'workspace-folders: folder menu')

      // Workspace menu: move into a folder, or back to the root.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'workspace-folders.move',
        target: 'workspace',
        order: 200,
        resolve: ({ workspaceId }) => {
          const state = folderStore.get()
          const current = state.folders.find(folder => folder.workspaceIds.includes(workspaceId))
          const actions = []
          if (state.folders.length > 0) {
            actions.push({
              id: 'move-to-folder',
              label: t('workspace.moveTo'),
              icon: { key: 'workspace-folders.move' },
              children: state.folders.map(folder => ({
                id: `to:${folder.id}`,
                label: folder.name,
                run: () => { folderStore.assign(workspaceId, folder.id) },
              })),
            })
          }
          if (current !== undefined) {
            actions.push({
              id: 'remove-from-folder',
              label: t('workspace.removeFrom'),
              icon: { key: 'workspace-folders.remove' },
              run: () => { folderStore.assign(workspaceId, null) },
            })
          }
          return actions
        },
      }), 'workspace-folders: move workspace menu')

      // Add-workspace dialog lives in the frame-wide overlay layer.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workspace-folders.add-workspace',
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
      }))

      ctx.slots.inject('contextMenu.icon', function* () {
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-folders.rename' }, IconRename)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-folders.delete' }, IconTrash)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-folders.move' }, IconMoveFolder)
        yield ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace-folders.remove' }, IconRemoveFolder)
      })
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'contextMenus'],
      apply,
    }
  },
})
