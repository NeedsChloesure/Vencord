/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * A port of Purgecord, itself a fork of Undiscord by Victornpb. Both are MIT
 * licensed; see README.md for the full notice.
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import definePlugin, { IconComponent } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";

import { core } from "./engine";
import { openPanel } from "./Panel";
import { settings } from "./settings";

const cl = classNameFactory("vc-purgecord-");

const ChannelToolbarIcon = findComponentByCodeLazy("tooltipPosition:", '"aria-haspopup":', '"data-jump-section":');

const PurgecordIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        aria-hidden
        role="img"
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="currentColor"
    >
        <path d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
        <path d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
    </svg>
);

export default definePlugin({
    name: "Purgecord",
    description: "Bulk delete your own messages in a channel, DM or whole server",
    tags: ["Chat", "Utility"],
    authors: [{ name: "Chloe", id: 0n }],
    settings,

    patches: [{
        find: "Missing channel in Channel.renderHeaderToolbar",
        replacement: {
            match: /(?<=renderHeaderToolbar"\);let (\i)=\[\];)/,
            replace: "$1.push($self.renderPurgeButton(this.props));"
        }
    }],

    renderPurgeButton: ErrorBoundary.wrap((_props: { channel: Channel; }) => (
        <ChannelToolbarIcon
            tooltip="Purgecord"
            icon={PurgecordIcon}
            onClick={openPanel}
            className={cl("button")}
        />
    ), { noop: true }),

    stop() {
        // Disabling the plugin mid-run must not leave a delete loop behind.
        core.stop();
    },

    settingsAboutComponent: () => (
        <>
            <Paragraph>
                Purgecord adds a <strong>trash can</strong> to the channel header. It walks Discord's search for servers,
                or the channel history for DMs, and deletes matching messages one at a time — so the two week age limit
                on bulk deletion does not apply.
            </Paragraph>
            <Paragraph>
                Only messages you are allowed to delete are ever touched. Deletion is permanent: there is no undo and no
                recycle bin, so read the confirmation preview before accepting it.
            </Paragraph>
            <Paragraph>
                Automating a user account is against Discord's terms of service. Keep both delays conservative — being
                rate limited over and over is what escalates into a temporary block.
            </Paragraph>
        </>
    )
});
