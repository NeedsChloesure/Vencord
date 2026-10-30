# Purgecord

Bulk delete your own messages in a channel, a DM, or across an entire server.

This is a port of [Purgecord](https://github.com/feelmypain/purgecord) — itself a fork of
[Undiscord](https://github.com/victornpb/undiscord) — from a standalone userscript into a Vencord
plugin. All credit for the deletion engine goes to those projects.

> [!WARNING]
> **Automating a user account is against Discord's Terms of Service** and can get your account
> terminated. Use it at your own risk, and keep the delays conservative.

> [!CAUTION]
> **Deletion is permanent.** There is no undo and no recycle bin. Read the confirmation preview
> before accepting it.

## Opening it

Click the 🗑️ **trash can in the channel header**. That's the panel: a form on the left, a live log
on the right.

## Quick start

**Everything you ever said in one channel or DM:**

1. Open the channel.
2. Click **me** next to *Author ID* and **current** next to *Channel ID*.
3. Click **Delete**.

**Everything you said in a whole server:** set *Server ID* with **current** and leave *Channel ID*
empty.

**Several or all servers:** set *Author ID*, leave *Channel ID* empty, and either paste a comma
separated list into *Server ID* or click **all**. Each server is purged one after another with a
pause in between.

**Direct messages:** *Server ID* `@me` (what **current** fills in for a DM), plus *Author ID* and
*Channel ID*. Both are mandatory there.

## Fields

| Field | Meaning |
| --- | --- |
| **Author ID** | Whose messages to delete. **me** fills in your own id. Must be set for DMs and for multi-server runs. |
| **Server ID** | One server id, a comma separated list, or `@me` for DMs. **current** uses the open channel's server, **all** loads every server you are in. |
| **Channel ID** | One channel or a comma separated list. Leave empty to search the whole server. |
| **Include NSFW channels** | Discord omits age restricted channels from search otherwise. |
| **Containing text** | Only messages containing this text, case insensitive. |
| **Pattern** | Case insensitive regular expression, applied on top of the other filters. A malformed pattern is ignored rather than matching everything. |
| **has: link / has: file** | Only messages with a link or an attachment. |
| **Include pinned** | Pinned messages are left alone unless this is on. |
| **After / Before a message** | Restrict to a slice of history by message id. **pick** closes the panel so you can click a message. |
| **After / Before date** | The same with dates. A message range wins if you fill in both. |
| **Search delay / Delete delay** | Milliseconds between pages and between deletions. Saved to the plugin settings, so they survive a restart. |
| **Discord data archive** | Feed in `messages/index.json` from your requested data package: every listed channel is queued as a DM target. |
| **Streamer mode** | Masks ids in the log and hides message previews in the confirmation, for screenshots. |
| **Auto scroll / Clear log** | Log pane behaviour. |

## How it works

1. **Retrieve.** Servers use Discord's guild search endpoint, newest first, 25 results per page.
   DMs and group DMs use the channel history endpoint in 100 message pages, because Discord does
   not document a search endpoint for them.
2. **Filter.** Private history is checked locally against the same author, range, text, link, file,
   pinned, type and pattern constraints. Server search applies most of them remotely.
3. **Delete.** Each message is deleted individually, which — unlike bulk deletion — has no two week
   age limit. Every request is paced against Discord's rate limits.
4. **Page.** The cursor moves to just before the oldest message of the page, so deleting messages
   cannot shift the window underneath the scan.
5. **Sweep.** When an indexed server search reaches the end after deleting something, it searches
   again, because the search index can hide results that are still there.

Errors are classified rather than blindly retried. A message that can never be deleted (system
message, locked thread, missing permission) is skipped once with an explanation. An expired token,
or a block from Discord's edge, stops the run immediately. Archived threads are reopened
automatically and the deletion retried; reopening is visible to other server members.

## What changed when porting it

- **No auth token field.** The userscript had to scrape the token out of local storage or webpack
  and keep it in a text box. Vencord already runs inside the client, so the token is read from
  `AuthenticationStore` and never displayed or stored.
- **A modal instead of a floating window.** The drag and resize machinery is gone; the panel is a
  Discord modal. Form state and the log live outside React so closing the panel mid-run loses
  nothing.
- **The message picker** closes the panel and lets you click a message instead of injecting a hover
  overlay with a fixed `z-index` over the chat.
- **Confirmation** is a proper destructive `ConfirmModal` showing the summary and the page preview,
  including during a batch, rather than a blocking `window.confirm`.
- **Deletions update the UI.** A raw `DELETE` bypasses Discord's own action, so the local message
  cache is told the message is gone; without that the chat keeps rendering deleted messages.
- **The log is plain text.** Log lines are React text, not injected HTML, with streamer mode
  masking ids and previews.
- **"all servers"** reads the client's own guild store instead of making an extra API request.
- **A bare whole-server run needs a filter.** Running against a whole server with no author, no
  text filter and no pattern is refused, because an empty form should not be able to start a
  server-wide delete. A channel target, an author, or any filter is enough to proceed.

Everything else — the pagination model, rate limit handling, message type and error handling,
thread reopening, multi-server batching — is the original engine.

## License

The deletion engine is MIT licensed:

```
Copyright (c) 2019-2025 Victornpb and contributors (original project, Undiscord)
Copyright (c) 2026 feelmypain and contributors (this fork, Purgecord)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Vencord side of the port (panel, wiring, Discord integration) is GPL-3.0-or-later, matching the
rest of this repository.
