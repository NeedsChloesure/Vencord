# Agent Development Guide

This is Chloe's personal fork of [Vencord](https://github.com/Vendicated/Vencord) (upstream 1.15.13).
Everything described under [Local modifications](#local-modifications) lives on the `my-additions`
branch and is not intended for upstream.

## Working in this repo

- **Package manager is pnpm** (`pnpm@11.9.0`, see `packageManager` in `package.json`). Don't
  `bun install` — it would rewrite `pnpm-lock.yaml`.
- **Checks:** `pnpm test` runs `buildStandalone`, `testTsc`, `lint`, `lint-styles` and
  `generatePluginJson`. During development the individual pieces are faster:
  `npx tsc --noEmit`, `npx eslint <paths>`, `npx stylelint "src/plugins/<name>/*.css"`.
  If pnpm is not installed, the build can be run directly with
  `node --require=./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --standalone`.
- **Plugins are auto-discovered** from `src/plugins/<name>/`. There is no registry to update; a
  directory with an `index.tsx` whose default export is `definePlugin({...})` is enough. The same
  goes for `src/userplugins/` (gitignored).
- **Every source file needs the GPL header** exactly as in `scripts/header-new.txt`. Extra lines
  *inside* that comment block fail `simple-header/header`; put attribution in a separate comment
  below it.
- **Style:** 4 spaces, double quotes, semicolons, sorted imports (`simple-import-sort`), no unused
  imports, and `path-alias/no-relative` — import across directories through `@utils`, `@api`,
  `@components`, `@webpack` aliases, not `../..`.
- **Never commit** `dist/` or `src/userplugins`.
- Plugins should not add third-party dependencies; use what `package.json` already has.

## Local modifications

### Purgecord (new plugin)

`src/plugins/purgecord/` is a port of [Purgecord](https://github.com/feelmypain/purgecord), a
userscript fork of [Undiscord](https://github.com/victornpb/undiscord), into a Vencord plugin. It
bulk deletes your own messages in a channel, DM, or whole server by walking Discord's search (or
channel history for DMs) and issuing individual deletes.

Layout:

| File | Role |
| --- | --- |
| `index.tsx` | Plugin definition, trash-can button in the channel header, settings page text. |
| `core.ts` | The ported engine: search/history pagination, filters, rate limiting, thread reopening, sweeps. |
| `plan.ts` | Turns the Server ID / Channel ID fields into a queue of jobs. |
| `engine.ts` | Singleton engine instance, wires it to the panel store, validates and starts runs. |
| `store.ts` | Panel state (form draft, log lines, run status) held outside React. |
| `Panel.tsx` | The modal: form on the left, live log on the right, plus `openPanel()`. |
| `confirm.tsx` | Destructive `ConfirmModal` shown before the first page is deleted. |
| `picker.ts` | Click-a-message picker for the message range fields. |
| `discord.ts` | Token, current user, current guild/channel and guild list lookups. |
| `settings.ts` | The two pacing settings. |

Things worth knowing before touching it:

- **`core.ts` is the original engine with minimal changes.** Read the comments before "simplifying"
  the pagination, the retry classification or the backoff maths — each one encodes a real Discord
  API behaviour. `core.ts` and `plan.ts` carry the MIT attribution for Undiscord/Purgecord; keep it.
- **The token comes from `AuthenticationStore`**, not from a settings field. There is deliberately
  no token input.
- **Deletes go through raw `fetch`, not `RestAPI`**, because the engine needs response headers
  (`x-ratelimit-*`, `retry-after`) and exact status codes. On success it dispatches
  `MESSAGE_DELETE` so the local message cache drops the message; without that the chat keeps
  rendering messages that no longer exist.
- **The form draft and log live in `store.ts`, not in React state**, so closing the modal mid-run
  loses nothing and reopening shows the run in progress. Subscribers re-render through
  `usePanelStore()`.
- **A whole-server run with no author and no filter is refused** in `engine.ts`; an empty form must
  not be able to start a server-wide delete. Any channel target, author or filter lifts the guard.
- The delays are plugin settings (`settings.ts`), so pacing preferences persist; the panel sliders
  write straight into them.

### VoiceTranscriber (new plugin) and `whisper-worker/`

`src/plugins/voiceTranscriber/` transcribes voice messages and audio attachments in place using
Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`). The transcription runs in
`whisper-worker/`, a standalone Cloudflare Worker at the repository root that has no dependency on
Vencord or this build system. The plugin talks to it over `fetch` with a configurable URL and
optional bearer token.

- The worker also exposes `POST /translate`, which proxies text translation through a Kagi session
  and backs the translate plugin's "Kagi — via your own Worker" provider.
- `src/plugins/voiceTranscriber/native.ts` handles the main-process side; the worker URL is user
  configured, so `*.workers.dev` is added to the CSP connect-src list there.
- `whisper-worker/.dev.vars` is gitignored; start from `.dev.vars.example`.
- Author credit for the plugin uses the fork-local `Devs.localAuthor` in `src/utils/constants.ts`
  (`id: 0n`, no badge) — keep it anonymous.

### Translate (modified)

Upstream's `translate` plugin was extended with:

- A **"Kagi Translate — via your own Worker" provider** (`utils.ts`, `settings.tsx`). Translation
  goes through `whisper-worker`'s `POST /translate`, so the Kagi session token stays server side.
  Configured with `kagiWorkerUrl` plus the optional `kagiWorkerToken` (the worker's `AUTH_TOKEN`).
- **Reply in `<language>`**: replying to a translated message drafts a reply that is automatically
  translated into that message's detected source language (`TranslationAccessory.tsx`, and the
  `CREATE_PENDING_REPLY` flux handler in `index.tsx`). `findTargetLanguage` in `utils.ts` maps the
  detected code onto what the current provider actually accepts (`EN` → `en-us`, `zh_cn` →
  `zh-CN`, ...), which is why `TranslationValue` carries `sourceLanguageCode` as well as the label.
- A **CSP rule for `*.workers.dev`** in `native.ts` so the renderer may fetch the worker at all. A
  worker on a custom domain still needs that host added under Vencord's Custom CSP Rules.

The DeepL and Kagi IPC helpers in `native.ts` are upstream's, not part of this fork. The provider's
server side lives in `whisper-worker/src/index.ts`, so changes there usually belong to both plugins.

### TextReact (new plugin)

`src/plugins/textReact/` reacts to a message with text: letters become regional indicator emojis,
digits become keycaps, spaces use a configurable spacer emoji. Reachable from the message context
menu, or by holding a modifier and clicking the hover toolbar's Add Reaction button (the click is
claimed in the capture phase so the emoji picker never opens).

### UserMessagesPronouns (modified)

Ported from the `r/feat/pronouns-caching` branch: pronoun lookups are cached in IndexedDB through
`@api/DataStore` (`pronounsCache.ts`) instead of being fetched again for every render, with a
**Clear cache** button and a `cacheExpiration` setting in `settings.tsx`.
