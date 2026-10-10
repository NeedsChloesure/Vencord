# VoiceTranscriber

Transcribe Discord voice messages and audio attachments in place, using
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) with the
`@cf/openai/whisper-large-v3-turbo` ("Whisper Large") model.

There are three ways to start a transcription:

- The **Transcribe** button rendered under the clip, right below the voice message or audio attachment.
- The **Transcribe** button in the message hover toolbar.
- The message context menu.

The transcript is then shown inline under the clip, with **Copy**, **Insert** and **Dismiss**
actions. Transcripts are cached per message for the session, so they survive scrolling and
re-rendering, and no modal is needed.

The transcription itself runs in a small, standalone Cloudflare Worker that lives in
[`whisper-worker/`](../../../whisper-worker) at the root of this repository. It does not use
any of the Vencord services in this repo.

## Setup

1. Deploy the Worker. See [`whisper-worker/README.md`](../../../whisper-worker/README.md).
2. Open the plugin settings and fill in:
   - **Worker URL** – the `https://<name>.<subdomain>.workers.dev` URL printed by `wrangler deploy`.
   - **Api Key** – the same value you stored as the Worker's `AUTH_TOKEN` secret (only if you set one).
   - **Task** – `Transcribe` to keep the spoken language, or `Translate to English`.
   - **Language** – optional language hint such as `en` or `de`.
   - **Auto transcribe** – transcribe every voice message and audio attachment as soon as it
     appears, without clicking. Off by default because it spends Cloudflare quota automatically.
   - **Show on regular audio attachments** – also offer the action for non-voice-message audio files.

## Notes

- The audio is not uploaded by the client. The plugin sends the attachment URL to the Worker, which
  downloads it from Discord's CDN and forwards it to Workers AI. This keeps the request small and
  avoids re-uploading audio the client already has a URL for.
- The Worker only downloads from Discord CDN hosts by default. Change `ALLOWED_HOSTS` if you want to
  transcribe audio hosted elsewhere.
- On Discord Desktop the renderer needs the Worker host in its CSP. `native.ts` already allows
  `*.workers.dev`; a Worker on a custom domain must be added under
  **Settings → Vencord → Custom CSP Rules** as well. The browser extension needs no CSP setup.
- Transcription quality and cost are entirely up to your Cloudflare account. Workers AI has a daily
  free allocation, after which Whisper is billed per audio minute.
