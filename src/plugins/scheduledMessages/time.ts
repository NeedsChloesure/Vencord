/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function formatSendTime(ms: number, locale: string, timestampHourCycle: number) {
    // Discord's timestampHourCycle enum: 0 = automatic, 1 = 12-hour, 2 = 24-hour.
    const hourCycle = timestampHourCycle === 1 ? "h12" : timestampHourCycle === 2 ? "h23" : undefined;
    return new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hourCycle
    }).format(new Date(ms));
}

export function formatRelative(ms: number, locale: string) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < MINUTE
        ? [Math.round(diff / 1_000), "second"]
        : abs < HOUR
            ? [Math.round(diff / MINUTE), "minute"]
            : abs < DAY
                ? [Math.round(diff / HOUR), "hour"]
                : [Math.round(diff / DAY), "day"];

    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(amount, unit);
}
