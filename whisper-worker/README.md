# vencord-whisper-worker

A standalone Cloudflare Worker that transcribes audio with Cloudflare Workers AI
(`@cf/openai/whisper-large-v3-turbo`, "Whisper Large").

It is deliberately self-contained: it has no dependency on Vencord, its services, or this
repository's build system. Deploy it to your own Cloudflare account and point the
`VoiceTranscriber` plugin at it.

## Deploy

```sh
cd whisper-worker
npm install
npx wrangler login
npx wrangler secret put AUTH_TOKEN     # optional but recommended, paste any long random string
npx wrangler secret put KAGI_SESSION   # optional, only for POST /translate (see below)
npx wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g. `https://vencord-whisper.<subdomain>.workers.dev`.
Paste that URL (and the token, if you set one) into the plugin's settings in Vencord.

Local development:

```sh
cp .dev.vars.example .dev.vars   # then edit it
npx wrangler dev
```

## Configuration

| Variable          | Required | Default                          | Description                                              |
| ----------------- | -------- | -------------------------------- | -------------------------------------------------------- |
| `AUTH_TOKEN`      | no       | unset (auth disabled)            | Shared secret; clients must send it as a Bearer token.    |
| `KAGI_SESSION`    | no       | unset (`POST /translate` is off) | Kagi account session token, used to proxy text translation. |
| `ALLOWED_HOSTS`   | no       | Discord CDN hosts                | Comma separated allowlist of hosts audio may be fetched from. |
| `MAX_AUDIO_BYTES` | no       | `25165824` (24 MiB)              | Largest accepted audio payload.                           |

`AUTH_TOKEN` and `KAGI_SESSION` are secrets (`wrangler secret put`); the other two can be plain
`vars` in `wrangler.jsonc`.

### Kagi session token

Kagi's Translate endpoint is authenticated with a **session cookie**, not an API key, so the token
lives in the Worker and is never sent to (or accepted from) clients. To get it, sign in at
`translate.kagi.com` and copy the value of the `kagi_session` cookie from your browser's devtools.
Tokens expire eventually; if translations start failing with HTTP 401, put a fresh one.

## API

`GET /` returns a small health/usage payload.

`POST /` accepts either:

- `Content-Type: application/json` with `{ "url": "https://cdn.discordapp.com/attachments/..." }`
  plus optional `"task"` (`transcribe` | `translate`) and `"language"` fields, or
- raw audio bytes with any other content type (e.g. `audio/ogg`).

Optional `language` and `task` query parameters work for both forms.

`POST /translate` translates text with Kagi and requires the `KAGI_SESSION` secret:

- `Content-Type: application/json` with `{ "text": "hola", "from": "auto", "to": "en" }`.
  `from`/`to` are optional and default to `auto` / `en`, matching the language codes the Translate
  plugin uses. Text is capped at 10,000 characters.

Requests must send `Authorization: Bearer <AUTH_TOKEN>` (or `X-Api-Key: <AUTH_TOKEN>`) when
`AUTH_TOKEN` is configured.

Responses:

```jsonc
// 200
{ "text": "hello world", "vtt": "WEBVTT ...", "wordCount": 2 }
{ "translation": "hello", "detectedLanguage": "Spanish" }

// non-2xx
{ "error": "Failed to download the audio (HTTP 404)." }
{ "error": "This Worker has no KAGI_SESSION secret configured." }
```

```sh
curl -X POST "https://vencord-whisper.<subdomain>.workers.dev" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://cdn.discordapp.com/attachments/.../voice-message.ogg","task":"transcribe"}'

curl -X POST "https://vencord-whisper.<subdomain>.workers.dev/translate" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"hola mundo","from":"auto","to":"en"}'
```

## Notes

- Long audio is sent to Whisper in a single request. Very long files may exceed the model's
  input limits; see the [chunking tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/)
  if you need to handle hour-long recordings.
- The Worker downloads only from hosts in `ALLOWED_HOSTS`, which prevents it from being used as
  an open proxy (SSRF).
- Cost is billed by Cloudflare per audio minute after the free daily allocation.
