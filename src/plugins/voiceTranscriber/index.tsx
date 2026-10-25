/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { CopyIcon, Microphone } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { Menu, showToast, useEffect, useState } from "@webpack/common";

export const cl = classNameFactory("vc-voice-transcriber-");

const settings = definePluginSettings({
    workerUrl: {
        type: OptionType.STRING,
        description: "URL of your deployed Cloudflare Worker (see whisper-worker/README.md in the repo).",
        default: "",
        placeholder: "https://vencord-whisper.<your-subdomain>.workers.dev"
    },
    apiKey: {
        type: OptionType.STRING,
        description: "Shared secret sent as a Bearer token. Must match the Worker's AUTH_TOKEN secret. Leave empty if you did not set one.",
        default: ""
    },
    task: {
        type: OptionType.SELECT,
        description: "Keep the spoken language, or translate the audio into English.",
        options: [
            { label: "Transcribe", value: "transcribe", default: true },
            { label: "Translate to English", value: "translate" }
        ]
    },
    language: {
        type: OptionType.STRING,
        description: "Optional language hint for Whisper, e.g. \"en\" or \"de\". Leave empty to auto-detect.",
        default: "",
        placeholder: "auto"
    },
    autoTranscribe: {
        type: OptionType.BOOLEAN,
        description: "Transcribe every voice message and audio attachment as soon as it appears. This uses your Cloudflare quota automatically.",
        default: false
    },
    showOnAllAudio: {
        type: OptionType.BOOLEAN,
        description: "Also offer transcription on regular audio attachments, not just voice messages.",
        default: true
    }
});

interface Transcript {
    status: "loading" | "done" | "error";
    text?: string;
    error?: string;
}

/** Transcripts are kept per message so they survive re-renders and scrolling. */
const transcripts = new Map<string, Transcript>();
const listeners = new Set<() => void>();

function updateTranscript(messageId: string, transcript?: Transcript) {
    if (transcript) transcripts.set(messageId, transcript);
    else transcripts.delete(messageId);

    for (const listener of listeners) listener();
}

function useTranscript(messageId: string) {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        const listener = () => forceUpdate(count => count + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);

    return transcripts.get(messageId);
}

function isAudioAttachment(attachment: MessageAttachment) {
    if (attachment.content_type?.startsWith("audio/")) return true;
    return /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm)$/i.test(attachment.filename);
}

function getAudioAttachment(message: Message, includeRegularAudio: boolean) {
    const attachments = message.attachments ?? [];

    if (message.hasFlag(MessageFlags.IS_VOICE_MESSAGE)) {
        return attachments.find(a => a.content_type?.startsWith("audio/")) ?? attachments[0];
    }

    return includeRegularAudio ? attachments.find(isAudioAttachment) : undefined;
}

async function transcribe(messageId: string, attachment: MessageAttachment) {
    const workerUrl = settings.store.workerUrl.trim().replace(/\/+$/, "");
    if (!workerUrl) {
        showToast({ text: "Set your Cloudflare Worker URL in the VoiceTranscriber plugin settings first.", variant: "critical" });
        updateTranscript(messageId, {
            status: "error",
            error: "No Cloudflare Worker URL configured."
        });
        return;
    }

    const source = attachment.url || attachment.proxy_url;
    if (!source) {
        updateTranscript(messageId, { status: "error", error: "This attachment has no downloadable URL." });
        return;
    }

    updateTranscript(messageId, { status: "loading" });

    try {
        const res = await fetch(workerUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(settings.store.apiKey ? { Authorization: `Bearer ${settings.store.apiKey}` } : {})
            },
            body: JSON.stringify({
                url: source,
                filename: attachment.filename,
                task: settings.store.task,
                language: settings.store.language.trim() || undefined
            })
        });

        const data = await res.json().catch(() => null) as { text?: string; error?: string; } | null;

        if (!res.ok)
            throw new Error(data?.error ?? `the Worker responded with HTTP ${res.status}`);

        const text = data?.text?.trim();
        if (!text)
            throw new Error("Whisper returned an empty transcription.");

        updateTranscript(messageId, { status: "done", text });
    } catch (e) {
        updateTranscript(messageId, { status: "error", error: e instanceof Error ? e.message : String(e) });
    }
}

function TranscriptionAccessory({ message }: { message: Message; }) {
    const attachment = getAudioAttachment(message, settings.store.showOnAllAudio);
    const transcript = useTranscript(message.id);

    useEffect(() => {
        if (!attachment || !settings.store.autoTranscribe) return;
        // Already transcribed, loading, failed, or dismissed for this message.
        if (transcripts.has(message.id)) return;

        void transcribe(message.id, attachment);
    }, []);

    if (!attachment) return null;

    if (transcript?.status === "loading") {
        return (
            <div className={cl("accessory")}>
                <Microphone width={16} height={16} className={cl("icon")} />
                <span className={cl("status")}>Transcribing...</span>
            </div>
        );
    }

    if (transcript?.status === "error") {
        return (
            <div className={cl("accessory")}>
                <span className={cl("error")}>Transcription failed: {transcript.error}</span>
                <button className={cl("button")} onClick={() => void transcribe(message.id, attachment)}>Retry</button>
                <button className={cl("button")} onClick={() => updateTranscript(message.id)}>Dismiss</button>
            </div>
        );
    }

    if (transcript?.status === "done") {
        return (
            <div className={cl("accessory")}>
                <Microphone width={16} height={16} className={cl("icon")} />
                <span className={cl("text")}>{transcript.text}</span>
                <span className={cl("actions")}>
                    <button className={cl("button")} onClick={() => copyWithToast(transcript.text!, "Transcription copied!")}>
                        <CopyIcon width={14} height={14} /> Copy
                    </button>
                    <button className={cl("button")} onClick={() => updateTranscript(message.id)}>Dismiss</button>
                </span>
            </div>
        );
    }

    return (
        <div className={cl("accessory")}>
            <button className={cl("button")} onClick={() => void transcribe(message.id, attachment)}>
                <Microphone width={16} height={16} className={cl("icon")} />
                Transcribe
            </button>
        </div>
    );
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message) return;

    const isVoiceMessage = message.hasFlag(MessageFlags.IS_VOICE_MESSAGE);
    const attachment = getAudioAttachment(message, settings.store.showOnAllAudio);
    if (!attachment) return;

    const group = findGroupChildrenByChildId(["copy-text", "copy-link"], children) ?? children;

    group.push(
        <Menu.MenuItem
            id="vc-transcribe-audio"
            label={isVoiceMessage ? "Transcribe Voice Message" : "Transcribe Audio"}
            leadingAccessory={{ type: "icon", icon: Microphone }}
            action={() => void transcribe(message.id, attachment)}
        />
    );
};

export default definePlugin({
    name: "VoiceTranscriber",
    description: "Transcribes voice messages and audio attachments inline with your own Cloudflare Workers AI Whisper Large worker.",
    tags: ["Voice", "Utility"],
    authors: [Devs.localAuthor],
    searchTerms: ["Whisper", "speech to text", "speech recognition", "transcription", "Cloudflare"],
    settings,

    contextMenus: {
        "message": messageContextMenuPatch
    },

    renderMessageAccessory: props => <TranscriptionAccessory message={props.message} />,

    messagePopoverButton: {
        icon: Microphone,
        render(message) {
            const attachment = getAudioAttachment(message, settings.store.showOnAllAudio);
            if (!attachment) return null;

            return {
                label: transcripts.has(message.id) ? "Transcribe Again" : "Transcribe",
                icon: Microphone,
                onClick: () => void transcribe(message.id, attachment)
            };
        }
    }
});
