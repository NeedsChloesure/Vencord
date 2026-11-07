/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { Logger } from "@utils/Logger";
import { FluxDispatcher, SelectedChannelStore, UserStore, useStateFromStores } from "@webpack/common";

import { getNativeScheduledMessage, getScheduledMessages, ScheduledMessageActions, ScheduledMessageStore } from "./native";

const logger = new Logger("ScheduledMessages");

/** Rows are dropped once their send time passes, so a slow sweep keeps the view honest */
const SYNC_INTERVAL = 30_000;
const DISCORD_EPOCH = 1_420_070_400_000n;

interface InjectedRow {
    scheduledId: string;
    messageId: string;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let active = false;
let idSequence = 0n;

/** Channel id → the local rows injected for it */
const rows = new Map<string, InjectedRow[]>();
/** Local message id → id of the scheduled message the row renders */
const rowToScheduled = new Map<string, string>();
/** Channel id → what its rows were built from, so untouched channels are not rebuilt */
const signatures = new Map<string, string>();

/** Local messages use negative snowflakes, like Discord's own local messages */
function nextLocalMessageId() {
    return `-${((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) + idSequence++}`;
}

export function getScheduledIdForMessage(messageId: string) {
    return rowToScheduled.get(messageId);
}

export function useScheduledMessages() {
    return useStateFromStores([ScheduledMessageStore], () => getScheduledMessages());
}

function removeRows(channelId: string) {
    signatures.delete(channelId);

    const injected = rows.get(channelId);
    if (!injected) return;

    rows.delete(channelId);

    for (const { messageId } of injected) {
        rowToScheduled.delete(messageId);
        try {
            FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id: messageId, channelId });
        } catch (e) {
            logger.debug("Could not remove a pending message row", e);
        }
    }
}

/**
 * Discord has no inline view for scheduled messages, so the open channel gets a local "only you"
 * message per schedule. They are local messages, not stored data: rebuilt whenever the list or the
 * open channel changes.
 */
export function syncChannel() {
    if (!active) return;

    const selected = SelectedChannelStore.getChannelId();

    for (const channelId of [...rows.keys()]) {
        if (channelId !== selected) removeRows(channelId);
    }

    if (!selected) return;

    const pending = getScheduledMessages(selected);
    if (!pending) return;

    const signature = pending.map(m => `${m.id}|${m.sendAt}|${m.content}`).join("\n");
    if (signatures.get(selected) === signature) return;

    removeRows(selected);
    signatures.set(selected, signature);

    const author = UserStore.getCurrentUser();
    const injected: InjectedRow[] = [];

    for (const scheduled of pending) {
        const messageId = nextLocalMessageId();

        try {
            sendBotMessage(selected, {
                id: messageId,
                content: scheduled.content,
                author
            });

            rowToScheduled.set(messageId, scheduled.id);
            injected.push({ scheduledId: scheduled.id, messageId });
        } catch (e) {
            logger.error("Could not show a pending message", e);
        }
    }

    rows.set(selected, injected);
}

export async function refreshScheduledMessages() {
    try {
        await ScheduledMessageActions.fetch();
    } catch (e) {
        logger.error("Could not fetch scheduled messages", e);
    }

    syncChannel();
}

export function init() {
    active = true;
    try {
        ScheduledMessageStore.addChangeListener?.(syncChannel);
    } catch (e) {
        logger.error("Could not listen to scheduled messages", e);
    }

    syncTimer = setInterval(syncChannel, SYNC_INTERVAL);

    void refreshScheduledMessages();
    syncChannel();
}

export function dispose() {
    active = false;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;

    try {
        ScheduledMessageStore.removeChangeListener?.(syncChannel);
    } catch (e) {
        logger.debug("Could not stop listening to scheduled messages", e);
    }

    for (const channelId of [...rows.keys()]) removeRows(channelId);
}

export async function updateScheduledMessage(id: string, patch: { content?: string; sendAt?: number; }) {
    const scheduled = getNativeScheduledMessage(id);
    if (!scheduled) throw new Error("This scheduled message is no longer available");

    await ScheduledMessageActions.update({
        scheduledMessageId: id,
        ...(patch.sendAt == null ? {} : { scheduledTimestamp: new Date(patch.sendAt).toISOString() }),
        ...(patch.content == null ? {} : { content: patch.content, flags: scheduled.createArgs.flags })
    });

    syncChannel();
}

export async function cancelScheduledMessage(id: string) {
    await ScheduledMessageActions.cancel(id);
    syncChannel();
}

export async function sendScheduledMessageNow(id: string) {
    await ScheduledMessageActions.sendNow(id);
    syncChannel();
}
