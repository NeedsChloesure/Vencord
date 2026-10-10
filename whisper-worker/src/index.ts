/*
 * Standalone Cloudflare Worker that turns audio into text with Cloudflare Workers AI.
 *
 * It intentionally does NOT depend on any of the Vencord services in this repository;
 * it is a plain, self-contained Worker you can deploy to your own Cloudflare account.
 *
 * Model: @cf/openai/whisper-large-v3-turbo ("Whisper Large")
 *
 * Routes (all require `Authorization: Bearer <AUTH_TOKEN>` when AUTH_TOKEN is set):
 *
 *   POST /            (or any path other than /translate) - transcribe audio
 *     Content-Type: application/json
 *     { "url": "https://cdn.discordapp.com/attachments/...", "language"?: "en", "task"?: "transcribe" | "translate" }
 *
 *     or POST the raw audio bytes with any other Content-Type ("audio/ogg", ...).
 *     Optional "language" / "task" query parameters work for both forms.
 *     Response: { "text": "...", "vtt"?: "...", "wordCount"?: number }
 *
 *   POST /translate    - translate text with Kagi
 *     Content-Type: application/json
 *     { "text": "hola", "from"?: "auto", "to"?: "en" }
 *     Response: { "translation": "...", "detectedLanguage"?: "Spanish" }
 *
 * Errors: { "error": "..." } with a non-2xx status.
 */

const MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Hosts the Worker is allowed to download audio from unless ALLOWED_HOSTS is set. */
const DEFAULT_ALLOWED_HOSTS = [
    "cdn.discordapp.com",
    "media.discordapp.net",
    "discord.com",
    "discordapp.com"
];

const DEFAULT_MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const KAGI_ENDPOINT = "https://translate.kagi.com/api/translate";
const MAX_TRANSLATE_CHARS = 10000;

interface WhisperResult {
    text?: string;
    vtt?: string;
    word_count?: number;
}

/**
 * Minimal structural type for the Workers AI binding. Kept local so the Worker has
 * no build-time dependency on a specific Workers AI client type.
 */
interface AiBinding {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<WhisperResult>;
}

interface Env {
    AI: AiBinding;
    /** Shared secret. When set, every request must authenticate with it. */
    AUTH_TOKEN?: string;
    /** Comma separated allowlist of hosts the Worker may download audio from. */
    ALLOWED_HOSTS?: string;
    /** Maximum accepted audio size, in bytes. */
    MAX_AUDIO_BYTES?: string;
    /** Kagi account session token (`kagi_session` cookie) used by POST /translate. */
    KAGI_SESSION?: string;
}

interface TranslateBody {
    text?: unknown;
    from?: unknown;
    to?: unknown;
}

interface TranscribeOptions {
    language?: string;
    task?: string;
}

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key",
    "Access-Control-Max-Age": "86400"
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    // Chunked to avoid blowing the argument limit of String.fromCharCode.
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function constantTimeEquals(a: string, b: string): boolean {
    // Length differences are not secret, but compare byte by byte anyway.
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
    if (!env.AUTH_TOKEN) return true;

    const authorization = request.headers.get("authorization") ?? "";
    const provided = authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice("bearer ".length).trim()
        : request.headers.get("x-api-key") ?? "";

    return constantTimeEquals(provided, env.AUTH_TOKEN);
}

function allowedHosts(env: Env): string[] {
    const configured = env.ALLOWED_HOSTS?.split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    return configured?.length ? configured : DEFAULT_ALLOWED_HOSTS;
}

function isAllowedHost(hostname: string, env: Env): boolean {
    const host = hostname.toLowerCase();
    return allowedHosts(env).some(entry => {
        const suffix = entry.replace(/^\*\./, "");
        return host === suffix || host.endsWith(`.${suffix}`);
    });
}

/**
 * Proxies a Kagi Translate request. The Kagi session token is a credential, so it lives
 * in the Worker as a secret and is never sent to (or accepted from) the client.
 */
async function handleTranslate(request: Request, env: Env): Promise<Response> {
    if (!env.KAGI_SESSION) {
        return json({ error: "This Worker has no KAGI_SESSION secret configured." }, 501);
    }

    const body = await request.json().catch(() => null) as TranslateBody | null;
    const text = typeof body?.text === "string" ? body.text : undefined;

    if (!text) return json({ error: "Missing \"text\" in the JSON body." }, 400);
    if (text.length > MAX_TRANSLATE_CHARS) {
        return json({ error: `Text is too long (${text.length} characters, the limit is ${MAX_TRANSLATE_CHARS}).` }, 413);
    }

    const from = typeof body?.from === "string" && body.from ? body.from : "auto";
    const to = typeof body?.to === "string" && body.to ? body.to : "en";

    let upstream: Response;
    try {
        upstream = await fetch(KAGI_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: `kagi_session=${env.KAGI_SESSION}`
            },
            body: JSON.stringify({ text, from, to, model: "standard" })
        });
    } catch (error) {
        return json({ error: `Failed to reach Kagi: ${errorMessage(error)}` }, 502);
    }

    if (!upstream.ok) {
        const detail = (await upstream.text().catch(() => "")).slice(0, 200).trim();
        return json({
            error: upstream.status === 401
                ? "Kagi rejected the Worker's KAGI_SESSION token (HTTP 401). Refresh the secret with a current session token."
                : `Kagi responded with HTTP ${upstream.status}.${detail ? ` ${detail}` : ""}`
        }, upstream.status === 401 ? 401 : 502);
    }

    const data = await upstream.json().catch(() => null) as {
        translation?: string;
        detected_language?: { label?: string; };
    } | null;

    if (!data?.translation) return json({ error: "Kagi returned no translation." }, 502);

    return json({
        translation: data.translation,
        detectedLanguage: data.detected_language?.label
    });
}

async function transcribe(audio: Uint8Array, options: TranscribeOptions, env: Env): Promise<Response> {
    const maxBytes = Number(env.MAX_AUDIO_BYTES) || DEFAULT_MAX_AUDIO_BYTES;

    if (audio.byteLength === 0) return json({ error: "The audio payload is empty." }, 400);
    if (audio.byteLength > maxBytes) {
        return json({ error: `Audio is too large (${audio.byteLength} bytes, the limit is ${maxBytes} bytes).` }, 413);
    }

    const inputs: Record<string, unknown> = { audio: toBase64(audio) };
    if (options.language) inputs.language = options.language;
    if (options.task === "transcribe" || options.task === "translate") inputs.task = options.task;

    let result: WhisperResult;
    try {
        result = await env.AI.run(MODEL, inputs);
    } catch (error) {
        return json({ error: `Workers AI request failed: ${errorMessage(error)}` }, 502);
    }

    return json({
        text: result?.text ?? "",
        vtt: result?.vtt,
        wordCount: result?.word_count
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method === "GET") {
            return json({
                ok: true,
                model: MODEL,
                routes: {
                    "POST /": "transcribe audio: raw bytes, or JSON { \"url\": \"https://cdn.discordapp.com/...\" }",
                    "POST /translate": "translate text with Kagi: JSON { \"text\": \"...\", \"from\": \"auto\", \"to\": \"en\" }"
                }
            });
        }

        if (request.method !== "POST") {
            return json({ error: "Method not allowed, use POST." }, 405);
        }

        if (!isAuthorized(request, env)) {
            return json({ error: "Unauthorized." }, 401);
        }

        const { pathname, searchParams } = new URL(request.url);
        const queryOptions: TranscribeOptions = {
            language: searchParams.get("language") ?? undefined,
            task: searchParams.get("task") ?? undefined
        };

        try {
            if (pathname === "/translate" || pathname === "/translate/") {
                return await handleTranslate(request, env);
            }

            const contentType = request.headers.get("content-type") ?? "";

            if (contentType.includes("application/json")) {
                const body = await request.json() as TranscribeOptions & { url?: string; };
                if (!body?.url) return json({ error: "Missing \"url\" in the JSON body." }, 400);

                let audioUrl: URL;
                try {
                    audioUrl = new URL(body.url);
                } catch {
                    return json({ error: "\"url\" is not a valid URL." }, 400);
                }

                if (!isAllowedHost(audioUrl.hostname, env)) {
                    return json({ error: `Refusing to download audio from the disallowed host "${audioUrl.hostname}".` }, 400);
                }

                const upstream = await fetch(audioUrl.toString(), { redirect: "follow" });
                if (!upstream.ok) {
                    return json({ error: `Failed to download the audio (HTTP ${upstream.status}).` }, 502);
                }

                return await transcribe(new Uint8Array(await upstream.arrayBuffer()), {
                    language: body.language ?? queryOptions.language,
                    task: body.task ?? queryOptions.task
                }, env);
            }

            return await transcribe(new Uint8Array(await request.arrayBuffer()), queryOptions, env);
        } catch (error) {
            return json({ error: `Unexpected Worker error: ${errorMessage(error)}` }, 500);
        }
    }
} satisfies ExportedHandler<Env>;
