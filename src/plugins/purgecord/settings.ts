/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    searchDelay: {
        type: OptionType.NUMBER,
        description: "Milliseconds to wait between pages of search results",
        default: 2000
    },
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Milliseconds to wait between individual deletions",
        default: 1000
    }
});
