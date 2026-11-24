/**
 * Host half of the workspace-suite bundle.
 *
 * The browser half's temporary-session trigger creates a Session whose cwd
 * is a `tmp-…` directory under `~/.dsh/temp-workspace`. A Session with only
 * a cwd has no owning Workspace, and the blank-session hero treats "ready
 * but unowned" as a deleted Workspace: it disables the composer. The
 * Workspace registry can only attach a Session to a Workspace whose
 * canonical path equals the Session's stored cwd, and the create command
 * accepts either `workspaceId` or `cwd`, never both. So this half finishes
 * the job once the Agent is published: it registers that directory as a
 * Workspace titled after it and attaches the Session. `agent/created` runs
 * serially before creation is released, so the browser half normally finds
 * the membership as soon as `sessions.create` resolves. A failed creation
 * never reaches this listener, so no dangling Session is ever attached.
 *
 * The grouped sidebar itself is Client-only and needs no Host resources.
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** The shared temporary root; the browser half computes the same path from the Host home. */
const TEMP_ROOT = join(homedir(), '.dsh', 'temp-workspace')
/** Prefix comparison in one separator form, because the browser builds paths with `/`. */
const TEMP_ROOT_POSIX = TEMP_ROOT.replaceAll('\\', '/')
/** Trash root for workspace directories removed together with their files. */
const TRASH_ROOT = join(homedir(), '.dsh', 'trash', 'workspaces')
/** HTTP face served under this prefix on the GUI origin. */
const ROUTE_PREFIX = '/plugins/workspace-suite'

/** Wait for the Workspace registry, the web face, session facts, and persistence. */
export const inject = ['workspaceRegistry', 'webServer', 'sessions', 'sessionPersistence']

/**
 * Register a Workspace per temporary Session directory and attach the Session.
 * @param ctx - Host context carrying the Workspace registry.
 */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const session = agent.session
    const cwd = session.header.cwd
    if (typeof cwd !== 'string') return
    // Subagent children inherit the parent's cwd; the Workspace row lists only
    // top-level Sessions, so leave them to their parent.
    if (session.header.origin === 'subagent') return
    const normalized = cwd.replaceAll('\\', '/')
    if (!normalized.startsWith(`${TEMP_ROOT_POSIX}/`)) return
    const title = basename(cwd)
    // Only the numbered (or timestamped) directories this feature owns.
    if (!title.startsWith('tmp-')) return
    try {
      const workspace = await ctx.workspaceRegistry.create(cwd, title)
      await workspace.attachSession(session.id)
    } catch (error) {
      // Never fail Agent creation for grouping: the browser half opens the
      // Session anyway and tells the user its composer may stay unavailable.
      ctx.logger.warn(`workspace-suite: could not group session "${session.id}" under "${cwd}"`, error)
    }
  })

  registerRoutes(ctx)
}

/**
 * Move one directory into the trash root under a unique, timestamped name.
 * Falls back to copy-plus-remove when the rename crosses filesystems.
 * @param source - Absolute directory path to move.
 * @returns The trash path the directory now lives at.
 */
function trashDirectory(source) {
  mkdirSync(TRASH_ROOT, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  let destination = join(TRASH_ROOT, `${basename(source)}-${stamp}`)
  let attempt = 1
  while (existsSync(destination)) {
    attempt += 1
    destination = join(TRASH_ROOT, `${basename(source)}-${stamp}-${attempt}`)
  }
  try {
    renameSync(source, destination)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    // Cross-device rename: copy the tree into the trash, then remove the source.
    cpSync(source, destination, { recursive: true, force: false, errorOnExist: true })
    rmSync(source, { recursive: true, force: true })
  }
  return destination
}

/**
 * Serve the delete-with-files face. The browser asks once per confirmed
 * dialog; the route deregisters the Workspace and, when asked, moves its
 * directory into the trash instead of erasing it.
 */
function registerRoutes(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      handle(req, res, ctx).catch(error => {
        ctx.logger.warn(`workspace-suite: route failure: ${String(error)}`)
        if (res.headersSent === false) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal' }))
        } else {
          res.end()
        }
      })
    },
  }), 'workspace-suite: delete route')
}

/** Handle one route request. */
async function handle(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/delete`) return handleWorkspaceDelete(req, res, ctx)
  if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/delete-session`) return handleSessionDelete(req, res, ctx)
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not found' }))
}

/** Delete one persisted session artifact; refuses sessions open in this process. */
async function handleSessionDelete(req, res, ctx) {
  const body = await readJsonBody(req, 16 * 1024)
  if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'sessionId is required' }))
    return
  }
  const refusal = await sessionRefusalReason(ctx, body.sessionId)
  if (refusal !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: `session "…": ${refusal}` }))
    return
  }
  try {
    const removed = await deleteSessionArtifact(ctx, body.sessionId)
    ctx.logger.info(`workspace-suite: deleted session "${body.sessionId}" (${removed === 0 ? 'no persisted artifact' : 'artifact removed'})`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, removed }))
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
  }
}

/** Delete one workspace (plus optional file/session removal) — the confirmed dialog flow. */
async function handleWorkspaceDelete(req, res, ctx) {
  const body = await readJsonBody(req, 16 * 1024)
  if (body === null || typeof body.workspaceId !== 'string' || body.workspaceId === '') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'workspaceId is required' }))
    return
  }
  const entity = ctx.workspaceRegistry.get(body.workspaceId)
  if (entity === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'workspace not found' }))
    return
  }
  const path = entity.path
  // Refuse to move anything that looks like a mount root or the home itself.
  if (typeof path !== 'string' || path === '' || path === '/' || path === homedir()) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'refusing to delete this path' }))
    return
  }

  let sessionsDeleted = 0
  if (body.deleteSessions === true) {
    const sessionErrors = []
    for (const id of entity.sessionIds) {
      const refusal = await sessionRefusalReason(ctx, id)
      if (refusal !== null) {
        sessionErrors.push(`session "${id}": ${refusal}`)
        continue
      }
      try {
        sessionsDeleted += await deleteSessionArtifact(ctx, id)
      } catch (error) {
        sessionErrors.push(`session "${id}": ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    if (sessionErrors.length > 0) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: sessionErrors.join('; ') }))
      return
    }
  }

  let trashPath = null
  if (body.deleteFiles === true) {
    // A Workspace record can outlive its directory (deleted outside dsh).
    // Nothing to move then: deregistering is the whole job.
    if (existsSync(path)) {
      try {
        trashPath = trashDirectory(path)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `could not move the directory to the trash: ${String(error instanceof Error ? error.message : error)}` }))
        return
      }
    } else {
      ctx.logger.info(`workspace-suite: workspace "${body.workspaceId}" path "${path}" is already gone; only deregistering`)
    }
  }
  try {
    await ctx.workspaceRegistry.delete(body.workspaceId)
  } catch (error) {
    // Roll the move back so the Workspace row keeps pointing at real files.
    if (trashPath !== null) {
      try {
        renameSync(trashPath, path)
      } catch (rollbackError) {
        ctx.logger.warn(`workspace-suite: could not restore "${trashPath}" to "${path}"`, rollbackError)
      }
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
    return
  }
  ctx.logger.info(`workspace-suite: deleted workspace "${body.workspaceId}"`
    + `${trashPath === null ? '' : ` (files moved to ${trashPath})`}`
    + `${body.deleteSessions === true ? ` (${sessionsDeleted} session artifacts removed)` : ''}`)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, trashPath, sessionsDeleted }))
}

/**
 * Why the session's artifact must not be removed right now, or null when
 * removal is safe. An in-memory store entry alone is not activity: what
 * matters is whether the session is doing work (a pending interaction, a
 * running agent), checked through the same activity waterfall the workspace
 * registry uses before archiving. If the waterfall is unavailable, falling
 * back to the conservative live-entry check.
 */
async function sessionRefusalReason(ctx, sessionId) {
  let activity = null
  try {
    activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  } catch {
    activity = null
  }
  if (activity !== null) {
    if (activity.length > 0) {
      return `session is currently active (${activity.map(entry => entry.kind).join(', ')}); stop it first`
    }
    return null
  }
  return ctx.sessions?.get?.(sessionId) !== undefined
    ? 'session is still open in this dsh process; restart dsh, then delete again'
    : null
}

/**
 * Remove one persisted session artifact through the persistence backend's own
 * listing, so the path resolution stays in sync with the storage layout. The
 * session's directory is removed too when the artifact was its last file.
 * @returns 1 when an artifact was removed, 0 when none was persisted.
 */
async function deleteSessionArtifact(ctx, id) {
  const snapshots = await ctx.sessionPersistence.list()
  const hit = snapshots.find(snapshot => snapshot.header?.id === id)
  if (hit === undefined || hit.location?.path === undefined) return 0
  rmSync(hit.location.path)
  try {
    rmdirSync(dirname(hit.location.path))
  } catch {
    // The directory still holds other sessions' artifacts; leave it.
  }
  return 1
}

/** Read and length-check one JSON request body; resolves null on bad input. */
function readJsonBody(req, maxBytes) {
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
      if (size > maxBytes) {
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
