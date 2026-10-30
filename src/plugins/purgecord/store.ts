/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useReducer } from "@webpack/common";

import type { LogLevel } from "./core";

/** A run may produce thousands of lines; the panel only ever shows the tail. */
const MAX_LOG_LINES = 2000;

export interface LogLine {
    level: LogLevel;
    text: string;
    /** Masked by streamer mode. */
    secret?: string;
    time: number;
}

export interface Draft {
    authorId: string;
    guildId: string;
    channelId: string;
    includeNsfw: boolean;
    content: string;
    hasLink: boolean;
    hasFile: boolean;
    includePinned: boolean;
    pattern: string;
    minId: string;
    maxId: string;
    minDate: string;
    maxDate: string;
    streamerMode: boolean;
    autoScroll: boolean;
}

export interface RunStatus {
    running: boolean;
    delCount: number;
    failCount: number;
    grandTotal: number;
    historyMode: boolean;
    historyScanned: number;
    startedAt: number;
    etr: number;
    /** Extra delete spacing the engine added by itself after being throttled. */
    throttleBackoff: number;
    throttledCount: number;
}

/*
 * The form and the log deliberately live outside React: the panel is a modal
 * the user can close mid-run, and starting a run must not lose what was typed
 * or what has already been deleted.
 */

let draft: Draft = {
    authorId: "",
    guildId: "",
    channelId: "",
    includeNsfw: false,
    content: "",
    hasLink: false,
    hasFile: false,
    includePinned: false,
    pattern: "",
    minId: "",
    maxId: "",
    minDate: "",
    maxDate: "",
    streamerMode: true,
    autoScroll: true
};

let logs: LogLine[] = [];

let status: RunStatus = {
    running: false,
    delCount: 0,
    failCount: 0,
    grandTotal: 0,
    historyMode: false,
    historyScanned: 0,
    startedAt: 0,
    etr: 0,
    throttleBackoff: 0,
    throttledCount: 0
};

const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

/** Re-render subscribers after a change the store does not own (e.g. settings). */
export function notify() {
    emit();
}

export function getDraft() {
    return draft;
}

export function setDraft(patch: Partial<Draft>) {
    draft = { ...draft, ...patch };
    emit();
}

export function getLogs() {
    return logs;
}

export function addLog(level: LogLevel, text: string, secret?: string) {
    logs.push({ level, text, secret, time: Date.now() });
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
    emit();
}

export function clearLogs() {
    logs = [];
    emit();
}

export function getStatus() {
    return status;
}

export function setStatus(patch: Partial<RunStatus>) {
    status = { ...status, ...patch };
    emit();
}

export function resetStatus() {
    status = {
        running: false,
        delCount: 0,
        failCount: 0,
        grandTotal: 0,
        historyMode: false,
        historyScanned: 0,
        startedAt: 0,
        etr: 0,
        throttleBackoff: 0,
        throttledCount: 0
    };
    emit();
}

/** Snowflakes are what streamer mode exists to hide. */
export function maskIds(text: string) {
    return text.replace(/\b\d{17,20}\b/g, "[id]");
}

/** Subscribe a component to the panel store. */
export function usePanelStore() {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    return { draft, logs, status };
}
