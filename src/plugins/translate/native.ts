/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { IpcMainInvokeEvent } from "electron";

// The "Kagi Translate — via your own Worker" provider fetches a Cloudflare Worker, which normally
// lives on *.workers.dev. Discord's Content-Security-Policy does not allow that by default.
// A Worker on a custom domain additionally needs that host under Custom CSP Rules in Vencord settings.
CspPolicies["*.workers.dev"] = ConnectSrc;

export async function makeDeeplTranslateRequest(_: IpcMainInvokeEvent, pro: boolean, apiKey: string, payload: string) {
    const url = pro
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `DeepL-Auth-Key ${apiKey}`
            },
            body: payload
        });

        const data = await res.text();
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}

export async function makeKagiTranslateRequest(_: IpcMainInvokeEvent, token: string, text: string, sourceLang: string, targetLang: string) {
    const url = "https://translate.kagi.com/api/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cookie": `kagi_session=${token}`
            },
            body: JSON.stringify({
                text,
                from: sourceLang,
                to: targetLang,
                model: "standard"
            }),
        });

        const data = await res.json();
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}
