/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { TranslateIcon } from "./TranslateIcon";
import { cl, TranslationValue } from "./utils";

type TranslationState =
    | { status: "loading"; }
    | { status: "done"; translation: TranslationValue; };

interface TranslationSetter {
    messageId: string;
    setState(state?: TranslationState): void;
}

const TranslationSetters = new Set<TranslationSetter>();

function updateTranslationState(messageId: string, state?: TranslationState) {
    for (const setter of TranslationSetters) {
        if (setter.messageId === messageId) {
            setter.setState(state);
        }
    }
}

/** Show the "Translating..." subtext while the request is in flight. */
export function handleTranslateStart(messageId: string) {
    updateTranslationState(messageId, { status: "loading" });
}

export function handleTranslate(messageId: string, data: TranslationValue) {
    updateTranslationState(messageId, { status: "done", translation: data });
}

/** The request failed and translate() already showed a toast, so just drop the subtext. */
export function handleTranslateError(messageId: string) {
    updateTranslationState(messageId);
}

function Dismiss({ onDismiss }: { onDismiss: () => void; }) {
    return (
        <button
            onClick={onDismiss}
            className={cl("dismiss")}
        >
            Dismiss
        </button>
    );
}

export function TranslationAccessory({ message }: { message: Message; }) {
    const [state, setState] = useState<TranslationState>();

    useEffect(() => {
        // Ignore MessageLinkEmbeds messages
        if ((message as any).vencordEmbeddedBy) return;

        const setter: TranslationSetter = {
            messageId: message.id,
            setState
        };

        TranslationSetters.add(setter);
        return () => void TranslationSetters.delete(setter);
    }, []);

    if (!state) return null;

    if (state.status === "loading") {
        return (
            <span className={cl("accessory")}>
                <TranslateIcon width={16} height={16} className={cl("accessory-icon")} />
                Translating...
            </span>
        );
    }

    const { text, sourceLanguage } = state.translation;

    return (
        <span className={cl("accessory")}>
            <TranslateIcon width={16} height={16} className={cl("accessory-icon")} />
            {Parser.parse(text)}
            <br />
            (translated from {sourceLanguage} - <Dismiss onDismiss={() => setState(undefined)} />)
        </span>
    );
}
