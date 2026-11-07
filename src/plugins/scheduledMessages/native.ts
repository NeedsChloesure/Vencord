/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { filters, findByPropsLazy, mapMangledModuleLazy } from "@webpack";
import { showToast } from "@webpack/common";

/**
 * Discord's native scheduled messages. They live on the server
 * (`/users/@me/scheduled-messages`), so they are delivered even when the client is closed.
 */
export interface NativeScheduledMessage {
    scheduledMessageId: string;
    sendAtTimestamp: string;
    createArgs: {
        channelId: string;
        content: string;
        flags?: number;
    };
}

interface ScheduledMessageStore {
    getScheduledMessagesForInbox(): Record<string, NativeScheduledMessage>;
    getMessagesPendingRemoval(): Set<string>;
    addChangeListener?(listener: () => void): void;
    removeChangeListener?(listener: () => void): void;
}

interface ScheduledMessageActions {
    update(options: {
        scheduledMessageId: string;
        scheduledTimestamp?: string;
        content?: string;
        flags?: number;
    }): Promise<unknown>;
    cancel(scheduledMessageId: string): Promise<unknown>;
    sendNow(scheduledMessageId: string): Promise<unknown>;
    fetch(): Promise<unknown>;
}

interface ScheduledMessageUI {
    /** Discord's own "edit send time" dialog used by the scheduled messages inbox */
    openEditTimeModal(options: { scheduledMessage: NativeScheduledMessage; }): void;
}

const logger = new Logger("ScheduledMessages");
let storeReadFailed = false;

/** `scheduledMessageStore` */
export const ScheduledMessageStore = findByPropsLazy("getScheduledMessagesForInbox") as unknown as ScheduledMessageStore;

/** The module behind the endpoints, found by its log strings since its exports are minified */
export const ScheduledMessageActions = mapMangledModuleLazy("Failed to create scheduled message", {
    update: filters.byCode("Failed to update scheduled message"),
    cancel: filters.byCode("Failed to cancel scheduled message"),
    sendNow: filters.byCode("Failed to send scheduled message now"),
    fetch: filters.byCode("Fetched scheduled messages")
}) as unknown as ScheduledMessageActions;

/** Discord's own edit-time dialog */
export const ScheduledMessageUI = mapMangledModuleLazy('id:"custom-time"', {
    openEditTimeModal: filters.byCode("isEditing:!0,channelId:")
}) as unknown as ScheduledMessageUI;

export interface ScheduledMessage {
    id: string;
    channelId: string;
    content: string;
    sendAt: number;
}

/**
 * The client's cached copy of the user's scheduled messages, oldest first.
 * Messages Discord is sending or cancelling right now are left out, as are ones whose time has passed,
 * so the rows disappear on their own if a refetch has not happened yet.
 */
export function getScheduledMessages(channelId?: string): ScheduledMessage[] | null {
    try {
        const store = ScheduledMessageStore;
        const all = Object.values(store.getScheduledMessagesForInbox());
        const pendingRemoval = store.getMessagesPendingRemoval?.() ?? new Set<string>();
        const now = Date.now();

        const messages = all
            .filter(m => m?.createArgs && !pendingRemoval.has(m.scheduledMessageId))
            .filter(m => channelId == null || m.createArgs.channelId === channelId)
            .map(m => ({
                id: m.scheduledMessageId,
                channelId: m.createArgs.channelId,
                content: m.createArgs.content ?? "",
                sendAt: Date.parse(m.sendAtTimestamp)
            }))
            .filter(m => Number.isFinite(m.sendAt) && m.sendAt > now)
            .sort((a, b) => a.sendAt - b.sendAt);
        storeReadFailed = false;
        return messages;
    } catch (e) {
        if (!storeReadFailed) logger.error("Could not read scheduled messages", e);
        storeReadFailed = true;
        return null;
    }
}

export function getNativeScheduledMessage(id: string) {
    try {
        return ScheduledMessageStore.getScheduledMessagesForInbox()?.[id];
    } catch (e) {
        logger.error("Could not read scheduled message", e);
        return undefined;
    }
}

export function showScheduledError(e: unknown) {
    showToast({
        text: (e as any)?.message ?? "Discord could not schedule that message",
        variant: "critical"
    });
}
