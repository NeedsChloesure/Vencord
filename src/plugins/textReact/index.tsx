/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { sleep } from "@utils/misc";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { Forms, Menu, MessageStore, Modal, openModal, RestAPI, showToast, useState } from "@webpack/common";

const cl = classNameFactory("vc-text-react-");
const logger = new Logger("TextReact");

/** Discord does not allow more than 20 distinct reactions on a single message */
const MAX_REACTIONS = 20;
const REGIONAL_INDICATOR_A = 0x1F1E6;

/** Spacing between reaction requests, plus a random extra bit so bursts do not line up */
const REACTION_DELAY_MS = 120;
const REACTION_JITTER_MS = 90;

/** The minimum amount of message data needed to add reactions to it */
type ReactionTarget = Pick<Message, "channel_id" | "id">;

const settings = definePluginSettings({
    wordSpacer: {
        type: OptionType.STRING,
        description: "Emoji used to separate words (leave empty to ignore spaces)",
        default: "⬜",
        placeholder: "⬜"
    },
    modifier: {
        type: OptionType.SELECT,
        description: "Modifier to hold while clicking the Add Reaction button",
        options: [
            { label: "Any (Ctrl, Shift or Alt)", value: "any", default: true },
            { label: "Ctrl", value: "ctrl" },
            { label: "Shift", value: "shift" },
            { label: "Alt", value: "alt" }
        ]
    }
});

/**
 * Turns text into a list of reactions. Letters become regional indicators, digits become
 * keycaps and spaces become the configured word spacer. Everything else is ignored.
 */
function getReactions(text: string) {
    const reactions: string[] = [];

    for (const char of text.toLowerCase()) {
        if (char >= "a" && char <= "z") {
            reactions.push(String.fromCodePoint(REGIONAL_INDICATOR_A + char.charCodeAt(0) - 97));
        } else if (char >= "0" && char <= "9") {
            reactions.push(`${char}\uFE0F\u20E3`);
        } else if (char === " ") {
            const spacer = settings.store.wordSpacer.trim();
            if (spacer) reactions.push(spacer);
        }
    }

    // Discord only allows a single reaction of each emoji per message, so duplicates would be no-ops.
    // Set preserves the insertion order, so the text stays readable.
    return [...new Set(reactions)];
}

async function reactWithText(message: ReactionTarget, text: string) {
    const reactions = getReactions(text);
    if (!reactions.length) {
        showToast({ text: "Nothing to react with! Only letters, digits and spaces are supported.", variant: "critical" });
        return;
    }

    if (reactions.length > MAX_REACTIONS) {
        showToast({
            text: `Discord only allows ${MAX_REACTIONS} reactions per message, so only the first ${MAX_REACTIONS} were added.`,
            variant: "critical"
        });
    }

    const toAdd = reactions.slice(0, MAX_REACTIONS);

    for (let i = 0; i < toAdd.length; i++) {
        // Space the requests out so a long word does not hit the reaction rate limit
        if (i !== 0) await sleep(REACTION_DELAY_MS + Math.random() * REACTION_JITTER_MS);

        try {
            await RestAPI.put({
                url: `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(toAdd[i])}/@me`
            });
        } catch {
            showToast({ text: `Failed to add the ${toAdd[i]} reaction`, variant: "critical" });
            return;
        }
    }
}

function TextReactModal({ message, modalProps }: { message: ReactionTarget; modalProps: RenderModalProps; }) {
    const [text, setText] = useState("");
    const reactions = getReactions(text);
    const willAdd = reactions.slice(0, MAX_REACTIONS);

    return (
        <Modal
            {...modalProps}
            title="React with Text"
            actions={[{
                text: "Add Reactions",
                variant: "primary",
                disabled: !reactions.length,
                onClick() {
                    reactWithText(message, text);
                    modalProps.onClose();
                }
            }]}
        >
            <Forms.FormText>
                Letters are turned into regional indicator emojis, digits into keycaps and spaces into your word spacer.
            </Forms.FormText>

            {/* Not Discord's TextInput: its className replaces the input's own styling classes,
                which leaves a bare native input behind. This field is styled entirely by us. */}
            <div className={cl("field")}>
                <input
                    className={cl("field-input")}
                    type="text"
                    value={text}
                    onChange={e => setText(e.currentTarget.value)}
                    placeholder="Type the text to react with"
                    aria-label="Text to react with"
                    spellCheck={false}
                    autoFocus
                />
            </div>

            <Forms.FormTitle className={Margins.top16}>Preview</Forms.FormTitle>
            <div className={cl("preview")}>
                {willAdd.length
                    ? willAdd.map((emoji, i) => <span key={i} className={cl("reaction")}>{emoji}</span>)
                    : <Forms.FormText>Nothing to preview yet</Forms.FormText>
                }
            </div>

            {reactions.length > MAX_REACTIONS && (
                <Forms.FormText className={cl("hint")}>
                    Only the first {MAX_REACTIONS} reactions will be added.
                </Forms.FormText>
            )}
        </Modal>
    );
}

function openTextReactModal(message: ReactionTarget) {
    openModal(modalProps => <TextReactModal message={message} modalProps={modalProps} />);
}

const TextReactIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        aria-hidden
        role="img"
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="currentColor"
    >
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm-3.5-9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-8.06 3.7a1 1 0 0 1 1.4-.14A5.48 5.48 0 0 0 12 15.5c1.2 0 2.33-.4 3.16-1.44a1 1 0 1 1 1.54 1.28A7.47 7.47 0 0 1 12 17.5a7.47 7.47 0 0 1-4.7-2.16 1 1 0 0 1 .14-1.4Z" />
    </svg>
);

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message?.channel_id || !message.id) return;

    const menuItem = (
        <Menu.MenuItem
            id="vc-text-react"
            key="vc-text-react"
            label="React with Text"
            leadingAccessory={{ type: "icon", icon: TextReactIcon }}
            action={() => openTextReactModal(message)}
        />
    );

    // Put it right below the other reaction entries, falling back to the end of the menu
    const reactionGroup = findGroupChildrenByChildId("reaction", children, true);
    if (reactionGroup) {
        reactionGroup.push(menuItem);
        return;
    }

    children.push(
        <Menu.MenuGroup key="vc-text-react-group">
            <Menu.MenuSeparator />
            {menuItem}
        </Menu.MenuGroup>
    );
};

/*
 * Hooking the hover toolbar's Add Reaction button
 *
 * Discord renders that button inside the message utilities toolbar. Instead of patching its
 * minified onClick (which changes every build), a capture phase listener claims the click before
 * Discord sees it when a modifier is held, so the emoji picker never opens.
 */

/** English labels of the button. Other locales are covered by the icon check below */
const REACTION_LABELS = ["add reaction", "add reactions"];

/** Fragments of Discord's add reaction icon, which is the same in every language */
const REACTION_ICON_FRAGMENTS = ["M12 23a11 11 0 1 0 0-22", "1.39.27"];

function isAddReactionButton(button: Element) {
    const label = button.getAttribute("aria-label")?.toLowerCase();
    if (label && REACTION_LABELS.includes(label)) return true;

    const path = button.querySelector("svg path")?.getAttribute("d");
    return !!path && REACTION_ICON_FRAGMENTS.every(fragment => path.includes(fragment));
}

/** Makes sure the button is part of a message's hover toolbar rather than its content */
function isInMessageUtilities(button: Element, row: Element) {
    const group = button.closest("[role='group']");
    return !!group && row.contains(group);
}

function isModifierHeld(event: MouseEvent) {
    switch (settings.store.modifier) {
        case "ctrl": return event.ctrlKey;
        case "shift": return event.shiftKey;
        case "alt": return event.altKey;
        default: return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
    }
}

function getMessageFromRow(row: Element): ReactionTarget | null {
    // Message rows are chat-messages-<channelId>-<messageId>
    const parts = row.id.split("-");
    const messageId = parts.pop();
    const channelId = parts.pop();
    if (!channelId || !messageId) return null;

    return MessageStore.getMessage(channelId, messageId) ?? { channel_id: channelId, id: messageId };
}

/** Walks up from the clicked node to the nearest interactive element inside the message row */
function findButton(target: Element, row: Element) {
    for (let element: Element | null = target; element && element !== row; element = element.parentElement) {
        if (element.matches("button, [role='button'], [aria-haspopup]")) return element;
    }

    return null;
}

function onDocumentClick(event: MouseEvent) {
    if (event.button !== 0 || event.defaultPrevented) return;
    if (!isModifierHeld(event)) return;

    const { target } = event;
    if (!(target instanceof Element)) return;

    const row = target.closest("[id^='chat-messages-']");
    if (!row) return;

    const button = findButton(target, row);
    if (!button || !isAddReactionButton(button) || !isInMessageUtilities(button, row)) {
        // Helpful when tuning the button detection against a new Discord build
        logger.debug("Modifier click was not the add reaction button", {
            label: button?.getAttribute("aria-label"),
            haspopup: button?.getAttribute("aria-haspopup")
        });
        return;
    }

    const message = getMessageFromRow(row);
    if (!message) return;

    // Keep Discord from opening the emoji picker instead
    event.preventDefault();
    event.stopPropagation();

    openTextReactModal(message);
}

export default definePlugin({
    name: "TextReact",
    description: "React to messages with text by turning it into regional indicator emojis",
    tags: ["Chat", "Emotes", "Reactions"],
    authors: [{ name: "Chloe", id: 0n }],
    settings,
    contextMenus: {
        "message": messageContextMenuPatch
    },

    start() {
        document.addEventListener("click", onDocumentClick, true);
    },

    stop() {
        document.removeEventListener("click", onDocumentClick, true);
    }
});
