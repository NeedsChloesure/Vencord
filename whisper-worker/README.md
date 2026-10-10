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
npx wrangler secret put AUTH_TOKEN   # optional but recommended, paste any long random string
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
| `ALLOWED_HOSTS`   | no       | Discord CDN hosts                | Comma separated allowlist of hosts audio may be fetched from. |
| `MAX_AUDIO_BYTES` | no       | `25165824` (24 MiB)              | Largest accepted audio payload.                           |

`AUTH_TOKEN` is a secret (`wrangler secret put`); the other two can be plain `vars` in
`wrangler.jsonc`.

## API

`GET /` returns a small health/usage payload.

`POST /` accepts either:

- `Content-Type: application/json` with `{ "url": "https://cdn.discordapp.com/attachments/..." }`
  plus optional `"task"` (`transcribe` | `translate`) and `"language"` fields, or
- raw audio bytes with any other content type (e.g. `audio/ogg`).

Optional `language` and `task` query parameters work for both forms.

Requests must send `Authorization: Bearer <AUTH_TOKEN>` (or `X-Api-Key: <AUTH_TOKEN>`) when
`AUTH_TOKEN` is configured.

Responses:

```jsonc
// 200
{ "text": "hello world", "vtt": "WEBVTT ...", "wordCount": 2 }

// non-2xx
{ "error": "Failed to download the audio (HTTP 404)." }
```

```sh
curl -X POST "https://vencord-whisper.<subdomain>.workers.dev" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://cdn.discordapp.com/attachments/.../voice-message.ogg","task":"transcribe"}'
```

## Notes

- Long audio is sent to Whisper in a single request. Very long files may exceed the model's
  input limits; see the [chunking tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/)
  if you need to handle hour-long recordings.
- The Worker downloads only from hosts in `ALLOWED_HOSTS`, which prevents it from being used as
  an open proxy (SSRF).
- Cost is billed by Cloudflare per audio minute after the free daily allocation.
