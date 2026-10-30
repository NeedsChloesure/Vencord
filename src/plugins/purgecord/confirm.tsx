/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { ConfirmModal, openModal } from "@webpack/common";

import { getDraft } from "./store";

const cl = classNameFactory("vc-purgecord-");

/** Enough to recognise a mis-filtered run without rendering thousands of rows. */
const MAX_PREVIEW_LINES = 100;

/**
 * Asks before the first page of a run is deleted. The modal is independent of
 * the panel, so a run started from a closed panel can still ask.
 */
export function confirmPurge(summary: string, preview: string[]): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (answer: boolean) => {
            if (settled) return;
            settled = true;
            resolve(answer);
        };

        const { streamerMode } = getDraft();
        const shown = preview.slice(0, MAX_PREVIEW_LINES);

        openModal(props => (
            <ConfirmModal
                {...props}
                title="Delete these messages?"
                subtitle="Deletion is permanent. There is no undo and no recycle bin."
                variant="critical-primary"
                confirmText="Delete"
                cancelText="Abort"
                onConfirm={() => finish(true)}
                onCancel={() => finish(false)}
                onCloseCallback={() => finish(false)}
            >
                <Paragraph className={cl("confirm-summary")}>{summary}</Paragraph>

                <div className={cl("confirm-preview")}>
                    {shown.map((line, i) => (
                        <div key={i} className={cl("confirm-preview-line")}>
                            {streamerMode ? "[hidden by streamer mode]" : line || "[no text]"}
                        </div>
                    ))}
                    {preview.length > shown.length && (
                        <div className={cl("confirm-preview-line", "muted")}>
                            ...and {preview.length - shown.length} more on this page
                        </div>
                    )}
                </div>
            </ConfirmModal>
        ));
    });
}
