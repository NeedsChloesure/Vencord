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

import { classNameFactory } from "@utils/css";
import { onlyOnce } from "@utils/onlyOnce";
import { PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

import { DeeplLanguages, deeplLanguageToGoogleLanguage, GoogleLanguages, KagiLanguages } from "./languages";
import { resetLanguageDefaults, settings } from "./settings";

export const cl = classNameFactory("vc-trans-");

const Native = VencordNative.pluginHelpers.Translate as PluginNative<typeof import("./native")>;

interface GoogleData {
    translation: string;
    sourceLanguage: string;
}

interface DeeplData {
    translations: {
        detected_source_language: string;
        text: string;
    }[];
}

interface KagiData {
    translation: string;
    detected_language: {
        label: string;
    };
}

export interface TranslationValue {
    sourceLanguage: string;
    text: string;
}

export const getLanguages = () => {
    if (settings.store.service === "kagi-worker") {
        return KagiLanguages;
    }

    if (IS_WEB) {
        return GoogleLanguages;
    }

    switch (settings.store.service) {
        case "google":
            return GoogleLanguages;
        case "kagi":
            return KagiLanguages;
        default:
            return DeeplLanguages;
    }
};

/**
 * DeepL and the direct Kagi integration make their requests from the desktop app's main process,
 * which the web/browser build has no equivalent of.
 */
function unavailableOnWeb(): Promise<TranslationValue> {
    throw "This provider only works in the desktop app. Use Google Translate or \"Kagi Translate — via your own Worker\" instead.";
}

function getTranslateProvider() {
    switch (settings.store.service) {
        case "kagi-worker":
            return kagiWorkerTranslate;
        case "kagi":
            return IS_WEB ? unavailableOnWeb : kagiTranslate;
        case "google":
            return googleTranslate;
        case "deepl":
        case "deepl-pro":
            return IS_WEB ? unavailableOnWeb : deeplTranslate;
        default:
            return IS_WEB ? googleTranslate : deeplTranslate;
    }
}

export async function translate(kind: "received" | "sent", text: string): Promise<TranslationValue> {
    const translate = getTranslateProvider();

    try {
        return await translate(
            text,
            settings.store[`${kind}Input`],
            settings.store[`${kind}Output`]
        );
    } catch (e) {
        const userMessage = typeof e === "string"
            ? e
            : "Something went wrong. If this issue persists, please check the console or ask for help in the support server.";

        showToast(userMessage, "failure");

        throw e instanceof Error
            ? e
            : new Error(userMessage);
    }
}

async function googleTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA", // some google API key
        "query.sourceLanguage": sourceLang,
        "query.targetLanguage": targetLang,
        "query.text": text,
    });

    const res = await fetch(url);
    if (!res.ok)
        throw new Error(
            `Failed to translate "${text}" (${sourceLang} -> ${targetLang})`
            + `\n${res.status} ${res.statusText}`
        );

    const { sourceLanguage, translation }: GoogleData = await res.json();

    return {
        sourceLanguage: GoogleLanguages[sourceLanguage] ?? sourceLanguage,
        text: translation
    };
}

function fallbackToGoogle(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    return googleTranslate(
        text,
        deeplLanguageToGoogleLanguage(sourceLang),
        deeplLanguageToGoogleLanguage(targetLang)
    );
}

const showDeeplApiQuotaToast = onlyOnce(
    () => showToast("Deepl API quota exceeded. Falling back to Google Translate", "failure")
);

async function deeplTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    if (!settings.store.deeplApiKey) {
        showToast("DeepL API key is not set. Resetting to Google", "failure");

        settings.store.service = "google";
        resetLanguageDefaults();

        return fallbackToGoogle(text, sourceLang, targetLang);
    }

    // CORS jumpscare
    const { status, data } = await Native.makeDeeplTranslateRequest(
        settings.store.service === "deepl-pro",
        settings.store.deeplApiKey,
        JSON.stringify({
            text: [text],
            target_lang: targetLang,
            source_lang: sourceLang.split("-")[0]
        })
    );

    switch (status) {
        case 200:
            break;
        case -1:
            throw "Failed to connect to DeepL API: " + data;
        case 403:
            throw "Invalid DeepL API key or version";
        case 456:
            showDeeplApiQuotaToast();
            return fallbackToGoogle(text, sourceLang, targetLang);
        default:
            throw new Error(`Failed to translate "${text}" (${sourceLang} -> ${targetLang})\n${status} ${data}`);
    }

    const { translations }: DeeplData = JSON.parse(data);
    const src = translations[0].detected_source_language;

    return {
        sourceLanguage: DeeplLanguages[src] ?? src,
        text: translations[0].text
    };
}

async function kagiTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const { status, data } = await Native.makeKagiTranslateRequest(
        settings.store.kagiSession, text, sourceLang, targetLang
    );

    switch (status) {
        case 200:
            break;
        case 401:
            throw "Invalid or expired Kagi session token";
        default:
            throw new Error(`Failed to translate "${text}" (${sourceLang} -> ${targetLang})\n${status} ${data}`);
    }

    const { detected_language, translation }: KagiData = data;

    return {
        sourceLanguage: detected_language.label,
        text: translation
    };
}

/**
 * Kagi translation proxied through the user's own Cloudflare Worker, which is what makes Kagi
 * usable from the browser build (no main process / pluginHelpers there). The Kagi session token
 * lives in the Worker as a secret and never touches the client.
 */
async function kagiWorkerTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const workerUrl = settings.store.kagiWorkerUrl.trim().replace(/\/+$/, "");
    if (!workerUrl) {
        throw "Set the Kagi Worker URL in the Translate plugin settings first (deploy whisper-worker and run: wrangler secret put KAGI_SESSION)";
    }

    const res = await fetch(`${workerUrl}/translate`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(settings.store.kagiWorkerToken ? { Authorization: `Bearer ${settings.store.kagiWorkerToken}` } : {})
        },
        body: JSON.stringify({ text, from: sourceLang, to: targetLang })
    });

    const data = await res.json().catch(() => null) as {
        translation?: string;
        detectedLanguage?: string;
        error?: string;
    } | null;

    if (!res.ok)
        throw data?.error ?? `Kagi Worker responded with HTTP ${res.status}`;

    if (!data?.translation)
        throw "Kagi returned an empty translation";

    return {
        sourceLanguage: data.detectedLanguage ?? sourceLang,
        text: data.translation
    };
}
