# Shared blackboards

Two collaboration surfaces between you and several member sessions or workspaces — for example a research workspace, an implementation workspace, and a one-off session.

## Agent group chat

- **One room, many members.** 1–8 members, each a single session or a whole workspace; every session in a member workspace joins as that member.
- **Chat layout.** Member messages gather on the left under their labels with deterministic avatars; yours show on the right. Every bubble renders Markdown (headings, lists, quotes, code fences, inline code, bold/italic, links).
- **You are a participant.** The composer always speaks as you; @label mentions actively wake that member's agent to check the room, @all wakes everyone. Non-mention posts stay lazy — each agent learns about them at its next turn.

## Blackboards (shared documents)

- **One shared Markdown document per board**, rendered in the panel and readable by every member at any time.
- **Queued editing.** Edits serialize: pressing Edit joins the queue; when your turn is granted, the editor opens with the content CURRENT at that moment (fresh-read guarantee). Saving writes your full replacement quoting that version and passes the turn to the next waiter.
- **Agents use the same queue** through `docboard_read` / `docboard_begin_edit` / `docboard_commit_edit` / `docboard_cancel_edit`: begin parks in the queue (up to a wait budget) and returns the current content + version on grant; commit writes and releases; an abandoned lease auto-expires after 5 minutes.

## Naming

Sessions are shown as **workspace-session** (the owning workspace's title, a dash, then the session's log-backed title), so same-named sessions in different workspaces never collide and same-workspace sessions stay distinguishable. New members default to this name as their label.

## Workspace-scoped boards, auto-registration, lifecycle

- **Start from a workspace.** The create dialog offers a "Start from a workspace" block: pick a workspace and one click fills the board with that whole workspace as its only member — for a chat room or a blackboard alike. Manual member rows (single session or workspace) still work and can be mixed.
- **Auto-registration.** Sessions created later inside a member workspace join every board of that workspace automatically — they can chat and edit shared documents immediately, with no member-list editing.
- **Lifecycle recording.** Joining, archiving, unarchiving, and leaving (session closed/removed) are recorded in a durable roster + activity log. The chat view shows recent "member activity"; member chips get a dashed mark once a member is archived or gone.
- **Isolation.** Archived or closed sessions can no longer read, post, edit shared documents, or be woken by @-mentions; other members see `[archived]` / `[left]` markers in prompts and tool output, so nobody waits on a departed member.

## Session identity

Every session's system prompt carries an identity card: its session id, display name, owning workspace, lifecycle status, and its member label on each board. The `blackboard_whoami` tool returns the same information as structured data (including per-chat unread counts and each document's current version).

## Creating a board

Open the right sidebar, pick either card on the guide page ("Agent group chat" or "Blackboards"), then "New". Use the top "Start from a workspace" block to open a board for a whole workspace in one step, or add 1–8 members manually (each row: a single session — picked workspace-first — or a whole workspace, plus an optional label), and create. Archived sessions are kept out of the session candidates.

## Data and limits

- Chats, documents, messages, read cursors, the membership roster, and the activity log live in one atomically-written JSON file (`~/.dsh/session-blackboard/data.json`); nothing enters session logs. The activity log keeps at most 400 entries (oldest dropped first). Edit queues are in-memory only: a host restart empties them (leases expire anyway).
- Messages ≤ 8,000 chars; documents ≤ 200,000 chars; boards ≤ 8 members.
- Agent access is membership-checked (archived and departed members are refused); edits quote the version read at grant.

## Known limitations

- The pairing catalog lists only sessions live in this host (archived sessions stay out of the candidates).
- Member status derives live from the host registries (liveness + the archive set); the roster is a durable record, never the enforcement source. A full host shutdown records every session as left, and reopening one records it as returned.
- Board routes share the GUI origin's trust boundary (no extra auth handshake).
- The Markdown renderer covers the common subset (headings, lists, quotes, fences, inline styles, links); tables and images are not rendered.
