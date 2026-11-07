/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addMessagePopoverButton, addMessagePopoverPolicy, removeMessagePopoverButton, removeMessagePopoverPolicy } from "@api/MessagePopover";
import ErrorBoundary from "@components/ErrorBoundary";
import { ClockIcon, DeleteIcon, PencilIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { getIntlMessage } from "@utils/discord";
import { useTimer } from "@utils/react";
import definePlugin, { IconProps } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { LocaleStore, Modal, openModal, TextArea, UserSettingsProtoStore,useState, useStateFromStores } from "@webpack/common";

import {
    getNativeScheduledMessage,
    ScheduledMessageUI,
    showScheduledError
} from "./native";
import {
    cancelScheduledMessage,
    dispose,
    getScheduledIdForMessage,
    init,
    refreshScheduledMessages,
    sendScheduledMessageNow,
    syncChannel,
    updateScheduledMessage,
    useScheduledMessages
} from "./store";
import { formatRelative, formatSendTime } from "./time";

const cl = classNameFactory("vc-scheduled-");

const act = (action: () => Promise<unknown>) => void action().catch(showScheduledError);

const SendNowIcon = ({ height = 20, width = 20 }: IconProps) => (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
);

/** Most messages are not ours, so only tracked rows mount the stateful component below */
function PendingScheduleAccessory({ message }: { message: Message; }) {
    const scheduledId = getScheduledIdForMessage(message.id);
    if (!scheduledId) return null;

    return <PendingSchedule scheduledId={scheduledId} />;
}

function PendingSchedule({ scheduledId }: { scheduledId: string; }) {
    const scheduled = useScheduledMessages()?.find(m => m.id === scheduledId);
    const locale = useStateFromStores([LocaleStore], () => LocaleStore.locale);
    const timestampHourCycle = useStateFromStores([UserSettingsProtoStore], () => UserSettingsProtoStore.settings.appearance?.timestampHourCycle ?? 0);

    // Keeps the relative time from going stale while the row stays on screen
    useTimer({ interval: 30_000 });

    if (!scheduled) return null;

    return (
        <div className={cl("time")}>
            <ClockIcon height={14} width={14} />
            {formatRelative(scheduled.sendAt, locale)} · {formatSendTime(scheduled.sendAt, locale, timestampHourCycle)}
        </div>
    );
}

const EditScheduledMessageModal = ErrorBoundary.wrap(function EditScheduledMessageModal({ scheduledId, content, modalProps }: {
    scheduledId: string;
    content: string;
    modalProps: RenderModalProps;
}) {
    const [text, setText] = useState(content);
    const [saving, setSaving] = useState(false);

    async function save() {
        setSaving(true);
        try {
            await updateScheduledMessage(scheduledId, { content: text });
            modalProps.onClose();
        } catch (e) {
            showScheduledError(e);
            setSaving(false);
        }
    }

    return (
        <Modal
            {...modalProps}
            title="Edit Scheduled Message"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: saving },
                { text: "Save", variant: "primary", onClick: save, disabled: saving || text === content }
            ]}
        >
            <TextArea value={text} onChange={setText} aria-label="Scheduled message text" autosize />
        </Modal>
    );
});

let moreButtonStyle: HTMLStyleElement | undefined;

const popoverButtons = {
    ScheduledMessages: (scheduledId: string) => ({
        label: "Send now",
        icon: SendNowIcon,
        onClick: () => act(() => sendScheduledMessageNow(scheduledId))
    }),
    ScheduledMessagesEdit: (scheduledId: string) => ({
        label: "Edit message",
        icon: PencilIcon,
        onClick: () => {
            const native = getNativeScheduledMessage(scheduledId);
            if (!native) return;
            const content = native.createArgs.content ?? "";
            const initialText = (native.createArgs.flags ?? 0) & MessageFlags.SUPPRESS_NOTIFICATIONS
                ? `@silent ${content}`
                : content;
            openModal(modalProps => <EditScheduledMessageModal scheduledId={scheduledId} content={initialText} modalProps={modalProps} />);
        }
    }),
    ScheduledMessagesChangeTime: (scheduledId: string) => ({
        label: "Change time",
        icon: ClockIcon,
        onClick: () => {
            const native = getNativeScheduledMessage(scheduledId);
            if (!native) return;
            try {
                ScheduledMessageUI.openEditTimeModal({ scheduledMessage: native });
            } catch (e) {
                showScheduledError(e);
            }
        }
    }),
    ScheduledMessagesCancel: (scheduledId: string) => ({
        label: "Cancel",
        icon: DeleteIcon,
        dangerous: true,
        onClick: () => act(() => cancelScheduledMessage(scheduledId))
    })
};

export default definePlugin({
    name: "ScheduledMessages",
    description: "Shows Discord's scheduled messages inline in the channel, with edit, send now, change time and cancel buttons.",
    tags: ["Chat", "Utility"],
    authors: [Devs.localAuthor],
    dependencies: ["MessagePopoverAPI"],

    patches: [
        {
            find: "#{intl::MESSAGE_UTILITIES_A11Y_LABEL}),children",
            replacement: [
                {
                    match: /(\(0,\i\.\i\)\((\i)\.flags,\i\.\i\.EPHEMERAL\))(?=,\i=)/,
                    replace: "($1&&!$self.isTracked($2))"
                },
                {
                    match: /return\{(channel:\i,message:(\i),canPin:\i,.+?isFocused:\i)\}/,
                    replace: "return $self.gateNative($2,{$1})"
                }
            ]
        }
    ],

    isTracked(message: Message) {
        return !!getScheduledIdForMessage(message.id);
    },

    gateNative<T extends object>(message: Message, props: T) {
        if (!this.isTracked(message)) return props;
        return {
            ...props,
            isExpanded: false,
            canPin: false,
            canEdit: false,
            canDelete: false,
            canReport: false,
            canReply: false,
            canStartThread: false,
            canViewThread: false,
            canForward: false,
            canManageOfficialMessages: false,
            canCopy: false,
            canPublish: false,
            canConfigureJoin: false,
            canReact: false,
            isMessageBookmark: false,
            isMessageReminder: false
        };
    },

    renderMessageAccessory: props => <PendingScheduleAccessory message={props.message} />,

    flux: {
        CHANNEL_SELECT() {
            syncChannel();
        },
        CONNECTION_OPEN() {
            // The native store is cleared on reconnect, so pull the list again
            void refreshScheduledMessages();
        }
    },

    start() {
        init();
        addMessagePopoverPolicy("ScheduledMessages", message => getScheduledIdForMessage(message.id) ? {
            allowedButtons: Object.keys(popoverButtons),
            markerClassName: "vc-scheduled-toolbar-marker"
        } : null);
        const labels = [getIntlMessage("MORE"), getIntlMessage("MORE_OPTIONS")];
        moreButtonStyle = document.createElement("style");
        moreButtonStyle.textContent = labels.map(label =>
            `[class*="buttonsInner"]:has(> .vc-scheduled-toolbar-marker) [aria-label="${CSS.escape(label)}"] { display: none; }`
        ).join("\n");
        document.head.appendChild(moreButtonStyle);
        for (const [id, render] of Object.entries(popoverButtons)) {
            addMessagePopoverButton(id, message => {
                const scheduledId = getScheduledIdForMessage(message.id);
                return scheduledId ? render(scheduledId) : null;
            }, DeleteIcon);
        }
    },

    stop() {
        dispose();
        removeMessagePopoverPolicy("ScheduledMessages");
        moreButtonStyle?.remove();
        moreButtonStyle = undefined;
        for (const id of Object.keys(popoverButtons)) removeMessagePopoverButton(id);
    }
});
