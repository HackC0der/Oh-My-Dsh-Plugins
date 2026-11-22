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

## Creating a board

Open the right sidebar, pick either card on the guide page ("Agent group chat" or "Blackboards"), then "New". Choose the type, name it, add 1–8 members (each row: a single session — picked workspace-first — or a whole workspace, plus an optional label), and create.

## Data and limits

- Chats, documents, messages, and read cursors live in one atomically-written JSON file (`~/.dsh/session-blackboard/data.json`); nothing enters session logs. Edit queues are in-memory only: a host restart empties them (leases expire anyway).
- Messages ≤ 8,000 chars; documents ≤ 200,000 chars; boards ≤ 8 members.
- Agent access is membership-checked; edits quote the version read at grant.

## Known limitations

- The pairing catalog lists only sessions live in this host.
- Board routes share the GUI origin's trust boundary (no extra auth handshake).
- The Markdown renderer covers the common subset (headings, lists, quotes, fences, inline styles, links); tables and images are not rendered.
