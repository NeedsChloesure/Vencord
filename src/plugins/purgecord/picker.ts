/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Rows look like `chat-messages-<channelId>-<messageId>`. */
const PICKING_CLASS = "vc-purgecord-picking";
const BEFORE_CLASS = "vc-purgecord-picking-before";
const AFTER_CLASS = "vc-purgecord-picking-after";

function findRow(target: Element) {
    return target.closest("[data-list-item-id^='chat-messages___'], [id^='chat-messages-']");
}

function idOfRow(row: Element) {
    const listItem = row.getAttribute("data-list-item-id");
    if (listItem) {
        const parts = listItem.split("___");
        const last = parts[parts.length - 1];
        if (/^\d{17,20}$/.test(last)) return last;
    }

    const parts = row.id.split("-");
    const last = parts[parts.length - 1];
    return /^\d{17,20}$/.test(last) ? last : null;
}

/**
 * Resolves with the id of the next message the user clicks, or null if they
 * press Escape. The caller is expected to close its own UI first: this needs a
 * clickable chat behind it.
 */
export function pickMessageId(kind: "before" | "after"): Promise<string | null> {
    const kindClass = kind === "before" ? BEFORE_CLASS : AFTER_CLASS;

    return new Promise(resolve => {
        document.body.classList.add(PICKING_CLASS, kindClass);

        function done(id: string | null) {
            document.body.classList.remove(PICKING_CLASS, BEFORE_CLASS, AFTER_CLASS);
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("keydown", onKeyDown, true);
            resolve(id);
        }

        function onClick(event: MouseEvent) {
            const { target } = event;
            if (!(target instanceof Element)) return;

            // Accept a click anywhere on the message row, not only on its text.
            const row = findRow(target);
            if (!row) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            done(idOfRow(row));
        }

        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") done(null); // otherwise the handler leaks forever
        }

        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKeyDown, true);
    });
}
