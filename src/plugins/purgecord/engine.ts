/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast } from "@webpack/common";

import { confirmPurge } from "./confirm";
import { isSnowflake, PurgecordCore } from "./core";
import { getToken } from "./discord";
import { buildPurgePlan } from "./plan";
import { settings } from "./settings";
import { addLog, clearLogs, getDraft, setStatus } from "./store";

/**
 * One engine for the whole client: the panel can be closed and reopened
 * mid-run, and the toolbar button has to know a run is already going.
 */
export const core = new PurgecordCore();

core.onLog = addLog;
core.onConfirm = confirmPurge;

core.onStart = (state, stats) => {
    setStatus({
        running: true,
        startedAt: stats.startTime.getTime(),
        delCount: state.delCount,
        failCount: state.failCount,
        grandTotal: state.grandTotal,
        historyMode: state.historyMode,
        historyScanned: state.historyScanned,
        etr: stats.etr,
        throttleBackoff: stats.deleteBackoff,
        throttledCount: stats.throttledCount
    });
};

core.onProgress = (state, stats) => {
    setStatus({
        delCount: state.delCount,
        failCount: state.failCount,
        grandTotal: state.grandTotal,
        historyMode: state.historyMode,
        historyScanned: state.historyScanned,
        etr: stats.etr,
        throttleBackoff: stats.deleteBackoff,
        throttledCount: stats.throttledCount
    });
};

core.onStop = (state, stats) => {
    setStatus({ running: false, etr: 0, throttleBackoff: stats.deleteBackoff });

    // The panel may well be closed by now, so finish with a toast either way.
    if (state.delCount > 0 || state.failCount > 0) {
        showToast({
            text: `Purgecord: deleted ${state.delCount} message(s), ${state.failCount} failed.`,
            variant: state.failCount > 0 ? "critical" : undefined
        });
    }
};

/**
 * Validates the panel's form and starts the run it describes.
 * Throws with a user-facing message instead of starting something invalid.
 */
export async function startRun() {
    if (core.isBusy) throw new Error("Already running!");

    const draft = getDraft();
    const authorId = draft.authorId.trim();

    if (authorId && !isSnowflake(authorId)) throw new Error("\"Author ID\" must be a Discord id.");

    const plan = buildPurgePlan(draft.guildId, draft.channelId);
    const [first] = plan.jobs;

    if (plan.guildIds.length > 1 && !authorId) {
        throw new Error("\"Author ID\" is required when purging multiple servers. Click \"me\" to use your own account.");
    }
    if (first.guildId === "@me" && !authorId) {
        throw new Error("\"Author ID\" is required for DMs and group DMs. Click \"me\" to use your own account.");
    }
    if (first.guildId !== "@me" && !first.channelId && !authorId && !draft.content.trim() && !draft.pattern) {
        throw new Error("Fill in \"Author ID\" or a filter, otherwise this deletes every message in the server it is allowed to.");
    }
    if (draft.minId.trim() && !isSnowflake(draft.minId.trim())) throw new Error("\"After a message\" must be a message id.");
    if (draft.maxId.trim() && !isSnowflake(draft.maxId.trim())) throw new Error("\"Before a message\" must be a message id.");

    const token = getToken();
    if (!token) throw new Error("Could not read your session token. Restart Discord and try again.");

    clearLogs();
    core.resetState();
    setStatus({
        running: true,
        startedAt: Date.now(),
        delCount: 0,
        failCount: 0,
        grandTotal: 0,
        historyMode: first.guildId === "@me",
        historyScanned: 0,
        etr: 0,
        throttleBackoff: 0,
        throttledCount: 0
    });

    core.options = {
        ...core.options,
        token,
        authorId,
        guildId: first.guildId,
        channelId: first.channelId,
        // A message interval wins over a date interval, as it did originally.
        minId: draft.minId.trim() || draft.minDate,
        maxId: draft.maxId.trim() || draft.maxDate,
        content: draft.content.trim(),
        hasLink: draft.hasLink,
        hasFile: draft.hasFile,
        includeNsfw: draft.includeNsfw,
        includePinned: draft.includePinned,
        pattern: draft.pattern,
        searchDelay: Number(settings.store.searchDelay) || 2000,
        deleteDelay: Number(settings.store.deleteDelay) || 1000
    };

    try {
        if (plan.jobs.length > 1) await core.runBatch(plan.jobs);
        else await core.run();
    } catch (err: any) {
        addLog("error", `CoreException: ${err?.message || err}`);
    } finally {
        // run() unlocks the UI itself; this only covers a throw that escaped it.
        if (core.state.running) core.stop();
    }
}
