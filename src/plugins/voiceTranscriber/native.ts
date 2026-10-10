/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";

/*
 * Cloudflare Workers are deployed to *.workers.dev by default, which Discord's
 * Content-Security-Policy does not allow. Whitelist it so the renderer can talk to
 * a Worker deployed there.
 *
 * The Worker URL is configurable, so a Worker on a custom domain additionally needs
 * its host added under Settings -> Vencord -> Custom CSP Rules (or here).
 */
CspPolicies["*.workers.dev"] = ConnectSrc;
