/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AuthenticationStore, GuildStore, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

/**
 * The session's own auth token.
 *
 * The original userscript had to scrape this out of local storage or webpack
 * and keep it in a text field. Vencord already runs inside the client, so the
 * token never has to be shown to the user or stored anywhere.
 */
export function getToken(): string | null {
    const token = (AuthenticationStore as any)?.getToken?.();
    return typeof token === "string" && token.length > 0 ? token : null;
}

export function getCurrentUserId(): string | null {
    return AuthenticationStore.getId() || null;
}

/** "@me" for DMs and group DMs, which Discord addresses as the pseudo-guild. */
export function getCurrentGuildId(): string {
    return SelectedGuildStore.getGuildId() ?? "@me";
}

export function getCurrentChannelId(): string | null {
    return SelectedChannelStore.getChannelId() || null;
}

export function getAllGuildIds(): string[] {
    return Object.keys(GuildStore.getGuilds());
}
