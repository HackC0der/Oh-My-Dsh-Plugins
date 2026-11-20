/**
 * Host half of the temporary-workspace bundle.
 *
 * The browser half creates a Session whose cwd is a `tmp-…` directory under
 * `~/.dsh/temp-workspace`. A Session with only a cwd has no owning Workspace,
 * and the blank-session hero treats "ready but unowned" as a deleted
 * Workspace: it disables the composer. The Workspace registry can only attach
 * a Session to a Workspace whose canonical path equals the Session's stored
 * cwd, and the create command accepts either `workspaceId` or `cwd`, never
 * both. So this half finishes the job once the Agent is published: it
 * registers that directory as a Workspace titled after it and attaches the
 * Session. `agent/created` runs serially before creation is released, so the
 * browser half normally finds the membership as soon as `sessions.create`
 * resolves. A failed creation never reaches this listener, so no dangling
 * Session is ever attached.
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** The shared temporary root; the browser half computes the same path from the Host home. */
const TEMP_ROOT = join(homedir(), '.dsh', 'temp-workspace')
/** Prefix comparison in one separator form, because the browser builds paths with `/`. */
const TEMP_ROOT_POSIX = TEMP_ROOT.replaceAll('\\', '/')

/** Wait for the Workspace registry before answering Agent creation. */
export const inject = ['workspaceRegistry']

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
      ctx.logger.warn(`temp-workspace: could not group session "${session.id}" under "${cwd}"`, error)
    }
  })
}
