/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * The deletion engine in this file is a port of Purgecord, itself a fork of
 * Undiscord. Both are MIT licensed:
 *   https://github.com/feelmypain/purgecord  (c) 2026 feelmypain and contributors
 *   https://github.com/victornpb/undiscord   (c) 2019-2025 Victornpb and contributors
 * See README.md for the full license notice.
 */

import { FluxDispatcher } from "@webpack/common";

export type LogLevel = "info" | "success" | "warn" | "error" | "verb" | "debug";
/**
 * `secret` is rendered separately so streamer mode can blur it without hiding
 * the rest of the line. It carries message content, which is the part a user
 * screen sharing does not want on screen.
 */
export type LogFn = (level: LogLevel, text: string, secret?: string) => void;

/** Discord search pages contain at most 25 hits; history pages contain 100 messages. */
const PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 100;
const REQUEST_TIMEOUT = 30_000;
const MAX_SEARCH_ATTEMPTS = 20;
/** How many times a finished walk may restart to sweep up stragglers. */
const MAX_SWEEPS = 2;
/** Transient retries for one message, separate from the configured maxAttempt. */
const MAX_TRANSIENT_RETRIES = 5;
const MAX_SEARCH_DELAY = 60_000;
const MAX_DELETE_DELAY = 30_000;
/** Padding on top of the retry_after Discord asks for, to survive clock skew. */
const RETRY_MARGIN = 250;
/** Discord snowflakes count milliseconds from 2015-01-01T00:00:00Z. */
const DISCORD_EPOCH = 1_420_070_400_000;

/**
 * Message types Discord refuses to delete.
 * Mirrors discord.js' UndeletableMessageTypes plus the client-only types
 * documented as non-deletable. Everything not listed here is deletable, so new
 * Discord message types keep working without a code change.
 * @see https://discord.com/developers/docs/resources/message#message-object-message-types
 */
const UNDELETABLE_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 21, 33, 34, 35, 56, 57, 64]);

/**
 * Discord error codes that will never succeed for this message. Retrying them
 * only burns the invalid-request budget that leads to a Cloudflare ban.
 */
const PERMANENT_DELETE_ERRORS: Record<number, string> = {
    50021: "it is a system message",
    160005: "the thread is locked",
    50013: "you do not have permission to delete it",
    50001: "you do not have access to that channel",
    50003: "that action cannot be performed on a DM channel"
};

// Outcome of a single delete attempt.
const DELETED = "DELETED"; // we removed it
const ALREADY_GONE = "ALREADY_GONE"; // it was gone before we got there
const RETRY = "RETRY"; // transient, worth another attempt
const SKIPPED = "SKIPPED"; // permanently undeletable, move on
const FAILED = "FAILED"; // unknown failure, retryable

type DeleteResult = typeof DELETED | typeof ALREADY_GONE | typeof RETRY | typeof SKIPPED | typeof FAILED;

export interface ApiMessage {
    id: string;
    channel_id?: string;
    author?: {
        id?: string;
        username?: string;
        global_name?: string;
        discriminator?: string;
    };
    content?: string;
    timestamp: string;
    type: number;
    pinned?: boolean;
    attachments?: unknown[];
    embeds?: { url?: string; }[];
    flags?: number;
    poll?: { question?: { text?: string; }; };
    message_snapshots?: { message?: { content?: string; }; }[];
}

interface SearchResponse {
    _history?: boolean;
    total_results?: number;
    messages?: unknown[];
}

export interface PurgeOptions {
    /** The account's own auth token, read from Discord's store. */
    token: string;
    authorId?: string;
    guildId: string;
    channelId?: string;
    minId?: string;
    maxId?: string;
    content?: string;
    hasLink?: boolean;
    hasFile?: boolean;
    includeNsfw?: boolean;
    includePinned?: boolean;
    pattern?: string;
    searchDelay: number;
    deleteDelay: number;
    maxAttempt?: number;
    emptyPageRetries?: number;
    jobDelay?: number;
    askForConfirmation?: boolean;
    debug?: boolean;
}

export interface PurgeState {
    running: boolean;
    delCount: number;
    /** Deletes the API confirmed, i.e. not "already gone". */
    confirmedDelCount: number;
    failCount: number;
    grandTotal: number;
    iterations: number;
    /** ID before which the next page is fetched. */
    cursorId: string | null;
    emptyPages: number;
    /** DMs are walked directly because channel search is unreliable. */
    historyMode: boolean;
    historyDone: boolean;
    historyValidated: boolean;
    historyScanned: number;

    _pageMessages: ApiMessage[];
    _messagesToDelete: ApiMessage[];
    _skippedMessages: ApiMessage[];
}

export interface PurgeStats {
    startTime: Date;
    endTime?: Date;
    throttledCount: number;
    throttledTotalTime: number;
    lastPing: number | null;
    avgPing: number | null;
    etr: number;

    // Adaptive pacing. These are added on top of the delays the user configured
    // and decay back to zero; options is never written to.
    searchBackoff: number;
    deleteBackoff: number;
    searchNextAt: number;
    deleteNextAt: number;
}

export class PurgecordError extends Error {
    fatal: boolean;
    status: number;
    code: number;

    constructor(message: string, opts: { fatal?: boolean; status?: number; code?: number; } = {}) {
        super(message);
        this.name = "PurgecordError";
        this.fatal = opts.fatal ?? false;
        this.status = opts.status ?? 0;
        this.code = opts.code ?? 0;
    }
}

/** Read a response body exactly once, parsing it as JSON when possible. */
async function readBody(resp: Response) {
    let text = "";
    try { text = await resp.text(); } catch { /* body already gone */ }
    try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

/**
 * How long Discord asked us to wait, in milliseconds.
 * Both the Retry-After header and the JSON body report seconds.
 */
function retryAfterMs(resp: Response, body: any) {
    const header = parseFloat(resp.headers.get("retry-after") ?? "");
    if (Number.isFinite(header)) return header * 1000;
    const fromBody = body && Number(body.retry_after);
    if (Number.isFinite(fromBody) && fromBody > 0) return fromBody * 1000;
    return 0;
}

/**
 * A 429 that is not Discord JSON came from Cloudflare, which bans the IP for
 * up to 24h. Retrying it makes things strictly worse.
 */
function isEdgeBlock(resp: Response, body: any) {
    if (body && body.code === 40333) return true;
    return resp.status === 429 && !body;
}

const clamp = (value: number, min: number, max: number) => value < min ? min : value > max ? max : value;

/** Discord ids are 17-20 digit snowflakes. */
export const isSnowflake = (value: unknown) => /^\d{17,20}$/.test(String(value).trim());

/**
 * Accept either a snowflake or a date and return a snowflake string.
 * BigInt is required here: the shift overflows Number.MAX_SAFE_INTEGER, which
 * used to quantize every date-range bound to a garbage value.
 * Returns undefined for anything unusable so the query drops the parameter.
 */
export function toSnowflake(value?: string | null) {
    if (value === undefined || value === null) return undefined;
    const str = String(value).trim();
    if (!str) return undefined;
    if (isSnowflake(str)) return str;
    const time = Date.parse(str);
    if (Number.isNaN(time)) return undefined;
    // Anything before Discord existed is the same as no bound at all.
    return ((BigInt(Math.max(time, DISCORD_EPOCH)) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

/**
 * Render a user the way Discord does today. Migrated ("pomelo") accounts have
 * a literal "0" discriminator, so the old username#discriminator form prints
 * names like "someone#0".
 */
export function displayName(user?: ApiMessage["author"]) {
    if (!user) return "unknown";
    if (user.global_name) return user.global_name;
    if (user.discriminator && user.discriminator !== "0") return `${user.username}#${user.discriminator}`;
    return user.username || "unknown";
}

/** The text of a message as a user thinks of it, including modern shapes. */
export function messageText(message: ApiMessage) {
    const parts = [message.content || ""];
    // Forwarded messages carry their text in a snapshot, not in content.
    if (Array.isArray(message.message_snapshots)) {
        for (const snapshot of message.message_snapshots) {
            if (snapshot?.message?.content) parts.push(snapshot.message.content);
        }
    }
    if (message.poll?.question) parts.push(message.poll.question.text || "");
    return parts.join("\n");
}

function messageHasLink(message: ApiMessage) {
    if (/(?:https?:\/\/|www\.)\S+/i.test(messageText(message))) return true;
    return Array.isArray(message.embeds) && message.embeds.some(embed => typeof embed?.url === "string" && embed.url);
}

function matchesHistoryFilters(message: ApiMessage, options: PurgeOptions) {
    if (!/^\d+$/.test(message.id)) return false;
    const id = BigInt(message.id);
    const minId = toSnowflake(options.minId);
    const maxId = toSnowflake(options.maxId);
    if (minId && id <= BigInt(minId)) return false;
    if (maxId && id >= BigInt(maxId)) return false;
    if (options.authorId && String(message.author?.id) !== String(options.authorId)) return false;
    if (options.content && !messageText(message).toLocaleLowerCase().includes(String(options.content).toLocaleLowerCase())) return false;
    if (options.hasLink && !messageHasLink(message)) return false;
    if (options.hasFile && !(Array.isArray(message.attachments) && message.attachments.length)) return false;
    return true;
}

/** A short human label for messages that have no text of their own. */
export function messagePreview(message: ApiMessage) {
    const text = messageText(message);
    if (text) return text;
    if (message.attachments?.length) return "[ATTACHMENTS]";
    if (message.poll) return "[POLL]";
    if (message.flags && message.flags & (1 << 14)) return "[FORWARDED]";
    if (message.flags && message.flags & (1 << 13)) return "[VOICE MESSAGE]";
    if (message.embeds?.length) return "[EMBED]";
    return "";
}

/**
 * Walks Discord's own search (or channel history for DMs) and deletes matching
 * messages one at a time, pacing itself against the API's rate limits.
 */
export class PurgecordCore {
    options: PurgeOptions = {
        token: "",
        guildId: "",
        searchDelay: 2000,
        deleteDelay: 1000,
        maxAttempt: 2,
        emptyPageRetries: 3,
        jobDelay: 10_000,
        askForConfirmation: true
    };

    state: PurgeState = this.createState();

    stats: PurgeStats = this.createStats();

    onStart?: (state: PurgeState, stats: PurgeStats) => void;
    onProgress?: (state: PurgeState, stats: PurgeStats) => void;
    onStop?: (state: PurgeState, stats: PurgeStats) => void;
    onLog: LogFn = () => { };
    /** Asks the user to confirm a page of deletions. Resolves false to abort. */
    onConfirm?: (summary: string, preview: string[]) => Promise<boolean>;

    private busy = false;
    private batchIndex = 0;
    private batchTotal = 0;

    /** Used to calculate latency. */
    private beforeTs = 0;

    /** Whether a run or batch is currently in flight. */
    get isBusy() { return this.busy; }

    private createState(): PurgeState {
        return {
            running: false,
            delCount: 0,
            confirmedDelCount: 0,
            failCount: 0,
            grandTotal: 0,
            iterations: 0,
            cursorId: null,
            emptyPages: 0,
            historyMode: false,
            historyDone: false,
            historyValidated: false,
            historyScanned: 0,
            _pageMessages: [],
            _messagesToDelete: [],
            _skippedMessages: []
        };
    }

    private createStats(): PurgeStats {
        return {
            startTime: new Date(),
            throttledCount: 0,
            throttledTotalTime: 0,
            lastPing: null,
            avgPing: null,
            etr: 0,
            searchBackoff: 0,
            deleteBackoff: 0,
            searchNextAt: 0,
            deleteNextAt: 0
        };
    }

    resetState() {
        this.state = this.createState();

        // Keep the cumulative throttle counters, drop everything that would poison
        // the next run (a stale backoff would silently slow it down).
        this.stats.searchBackoff = 0;
        this.stats.deleteBackoff = 0;
        this.stats.searchNextAt = 0;
        this.stats.deleteNextAt = 0;
        this.stats.etr = 0;

        this.options.askForConfirmation = true;
    }

    private log(level: LogLevel, ...parts: string[]) {
        this.onLog(level, parts.filter(Boolean).join(" "));
    }

    /** Automate the deletion process across multiple channels or servers. */
    async runBatch(queue: Partial<PurgeOptions>[]) {
        if (this.busy) {
            this.log("error", "Already running!");
            return;
        }
        this.busy = true;
        this.batchTotal = queue.length;

        // Job options must not leak into the next job.
        const baseOptions = { ...this.options };

        this.log("info", `Running batch with queue of ${queue.length} jobs`);
        this.state.running = true;
        // The batch owns the lifecycle: firing these per job would unlock the UI
        // (and kill the Stop button) during every inter-job pause.
        this.onStart?.(this.state, this.stats);

        try {
            for (let i = 0; i < queue.length; i++) {
                if (!this.state.running) break;

                // Firing every job's first search back to back is a self-inflicted 429.
                if (i > 0) {
                    this.log("verb", `Waiting ${((this.options.jobDelay ?? 0) / 1000).toFixed(1)}s before the next job...`);
                    await this.cooldown(this.options.jobDelay ?? 0);
                    if (!this.state.running) break;
                }

                this.options = { ...baseOptions, ...queue[i] } as PurgeOptions;
                this.batchIndex = i + 1;
                this.log("info", `Starting job... (${i + 1}/${queue.length})`);

                try {
                    await this.run(true);
                } catch (err: any) {
                    this.log("error", `Job ${i + 1} failed: ${err?.message || err}`);
                    // A dead token or an edge block fails identically for every remaining
                    // job, so there is nothing to be gained by continuing.
                    if (err?.fatal) {
                        this.state.running = false;
                        break;
                    }
                }

                if (!this.state.running) break;

                this.log("info", `Job ended. (${i + 1}/${queue.length})`);
                // Carry the prompt state forward only if this job actually prompted;
                // a job that died early must not silence the rest of the batch.
                baseOptions.askForConfirmation = this.options.askForConfirmation;
                this.resetState();
                this.state.running = true; // continue running
            }
        } finally {
            this.options = baseOptions;
            this.state.running = false;
            this.busy = false;
            this.batchIndex = 0;
            this.batchTotal = 0;
            this.log("info", "Batch finished.");
            this.onStop?.(this.state, this.stats);
        }
    }

    /** Start the deletion process. */
    async run(isJob = false) {
        if (this.busy && !isJob) {
            this.log("error", "Already running!");
            return;
        }
        if (!this.options.guildId) {
            this.log("error", "You must fill the \"Server ID\" field!");
            return;
        }
        if (this.options.guildId === "@me" && !this.options.channelId) {
            this.log("error", "You must fill the \"Channel ID\" field to delete direct messages!");
            return;
        }
        if (this.options.guildId === "@me" && !this.options.authorId) {
            this.log("error", "You must fill the \"Author ID\" field to delete direct messages safely!");
            return;
        }
        if (!isJob) this.busy = true;

        this.state.running = true;
        this.stats.startTime = new Date();
        // The walk starts at the user's upper bound and moves backwards in time.
        this.state.cursorId = toSnowflake(this.options.maxId) || null;
        this.state.historyMode = this.options.guildId === "@me";

        this.log("success", `Started at ${this.stats.startTime.toLocaleString()}`);
        this.log("debug",
            `authorId = "${this.options.authorId}"`,
            `guildId = "${this.options.guildId}"`,
            `channelId = "${this.options.channelId}"`,
            `minId = "${this.options.minId}"`,
            `maxId = "${this.options.maxId}"`,
            `hasLink = ${!!this.options.hasLink}`,
            `hasFile = ${!!this.options.hasFile}`
        );

        if (!isJob) this.onStart?.(this.state, this.stats); // a batch owns its own lifecycle

        // When a walk finishes having actually removed something we sweep the
        // channel again, because Discord's search index can hide messages that were
        // there all along. A pass has to confirm a deletion to earn the next one,
        // and MAX_SWEEPS bounds it regardless.
        let deletedBeforePass = 0;
        let sweeps = 0;

        try {
            do {
                this.state.iterations++;

                this.log("verb", "Fetching messages...");
                await this.pace("search");
                if (!this.state.running) break;

                const data = await this.search();
                if (!this.state.running) break;
                if (!data) break; // nothing more we can do with this channel

                this.filterResponse(data);
                if (this.state.historyMode) this.onProgress?.(this.state, this.stats);

                const found = this.state._messagesToDelete.length + this.state._skippedMessages.length;
                if (this.state.historyMode) {
                    this.log("verb",
                        `Matching messages found so far: ${this.state.grandTotal}`,
                        `(Messages scanned: ${this.state.historyScanned}`,
                        `In current page: ${this.state._pageMessages.length}`,
                        `Matching filters: ${found}`,
                        `To be deleted: ${this.state._messagesToDelete.length}`,
                        `Skipped: ${this.state._skippedMessages.length})`
                    );
                } else {
                    this.log("verb",
                        `Grand total: ${this.state.grandTotal}`,
                        `(Messages in current page: ${found}`,
                        `To be deleted: ${this.state._messagesToDelete.length}`,
                        `Skipped: ${this.state._skippedMessages.length})`
                    );
                }
                this.printStats();

                if (this.state.historyMode) {
                    this.stats.etr = 0;
                    this.log("verb", "Estimated time remaining: unknown until the full history is scanned.");
                } else {
                    this.calcEtr();
                    this.log("verb", `Estimated time remaining: ${msToHMS(this.stats.etr)}`);
                }

                const pageSize = this.state.historyMode ? this.state._pageMessages.length : found;
                if (pageSize === 0) {
                    // A direct history walk ends on the first empty page. Search results
                    // get extra checks because Discord's index can briefly hide hits.
                    const remaining = Number(data.total_results) || 0;
                    if (this.state.historyMode || remaining === 0 || this.state.emptyPages >= (this.options.emptyPageRetries ?? 3)) {
                        if (!this.state.historyMode && this.state.confirmedDelCount > deletedBeforePass && sweeps < MAX_SWEEPS) {
                            sweeps++;
                            this.log("verb", `Reached the end. Sweeping the channel again to catch anything the search index was hiding... (${sweeps}/${MAX_SWEEPS})`);
                            deletedBeforePass = this.state.confirmedDelCount;
                            this.state.cursorId = toSnowflake(this.options.maxId) || null;
                            this.state.emptyPages = 0;
                            continue;
                        }
                        this.log("verb", this.state.historyMode
                            ? "Reached the beginning of the channel history."
                            : "Ended because the API returned an empty page.");
                        if (isJob) break; // break without stopping if this is part of a job
                        this.state.running = false;
                        break;
                    }
                    this.state.emptyPages++;
                    const settle = this.state.emptyPages * Math.max(this.options.searchDelay, 2000);
                    this.log("warn",
                        `The page came back empty but the API still reports ${remaining} message(s).`,
                        `Waiting ${(settle / 1000).toFixed(1)}s for the search index to catch up...`,
                        `(${this.state.emptyPages}/${this.options.emptyPageRetries})`
                    );
                    await this.cooldown(settle);
                    continue;
                }

                this.state.emptyPages = 0;

                if (this.state._messagesToDelete.length > 0) {
                    if (await this.confirm() === false) {
                        this.state.running = false; // break out of a job
                        break; // immediately stop this iteration
                    }

                    await this.deleteMessagesFromList();
                } else {
                    this.log("verb", this.state.historyMode
                        ? "No matching messages on this history page, checking older messages..."
                        : "There's nothing we can delete on this page, checking next page...");
                }

                // Walk past everything this page returned. Paging by id instead of by
                // offset means deleting messages cannot shift the window under us, and
                // there is no 9975 offset ceiling to hit.
                this.advanceCursor();

            } while (this.state.running);
        } finally {
            this.stats.endTime = new Date();
            this.log("success", `Ended at ${this.stats.endTime.toLocaleString()}! Total time: ${msToHMS(this.stats.endTime.getTime() - this.stats.startTime.getTime())}`);
            this.printStats();
            this.log("debug", `Deleted ${this.state.delCount} messages, ${this.state.failCount} failed.`);
            if (this.state.failCount > 0) this.log("info", "Run it again to retry the messages that failed.");

            if (!isJob) {
                // A batch keeps state.running set so its loop can continue; a plain run
                // owns the flag and must clear it however it exited.
                this.state.running = false;
                this.busy = false;
                this.onStop?.(this.state, this.stats);
            }
        }
    }

    stop() {
        this.state.running = false;
        // The loop's finally block unlocks the UI once it actually unwinds; doing it
        // here as well would re-enable Start while a request is still in flight.
        if (!this.busy) this.onStop?.(this.state, this.stats);
    }

    /**
     * Move the pagination cursor just past the oldest message of the current
     * page. Snowflakes are time-ordered, so forcing the cursor to strictly
     * decrease guarantees the walk terminates even if the API ever treats max_id
     * as inclusive.
     */
    advanceCursor() {
        const page = this.state._pageMessages;
        if (!page.length) return;

        // The page is sorted newest first, but do not trust that for correctness.
        let oldest: bigint | null = null;
        for (const message of page) {
            if (!/^\d+$/.test(message.id)) continue;
            const id = BigInt(message.id);
            if (oldest === null || id < oldest) oldest = id;
        }
        if (oldest === null) return;

        const current = this.state.cursorId ? BigInt(this.state.cursorId) : null;
        if (current !== null && oldest >= current) oldest = current - 1n;
        this.state.cursorId = oldest.toString();
    }

    /** Calculate the estimated time remaining based on the current stats. */
    calcEtr() {
        const remaining = Math.max(0, this.state.grandTotal - this.state.delCount - this.state.failCount);
        const perMessage = this.options.deleteDelay + this.stats.deleteBackoff + (this.stats.avgPing || 0);
        const perPage = this.options.searchDelay + this.stats.searchBackoff;
        this.stats.etr = (perPage * Math.ceil(remaining / PAGE_SIZE)) + (perMessage * remaining);
    }

    /** Ask for confirmation at the beginning of a page. */
    async confirm() {
        if (!this.options.askForConfirmation) return true;

        this.log("verb", "Waiting for your confirmation...");
        const preview = this.state._messagesToDelete.map(m => `${displayName(m.author)}: ${messagePreview(m)}`);

        const batchNotice = this.batchTotal > 1
            ? `\n\nThis is job ${this.batchIndex} of ${this.batchTotal}. The remaining jobs will continue without another confirmation.`
            : "";
        const summary = this.state.historyMode
            ? `Do you want to scan this entire chat history and delete every matching message?\n${this.state.grandTotal} matching message(s) found so far; the final total is unknown until older history is scanned.`
            : `Do you want to delete ~${this.state.grandTotal} messages? (Estimated time: ${msToHMS(this.stats.etr)})\n`
            + "(The actual number of messages may be less, depending if you're using filters to skip some messages)";

        const answer = await this.onConfirm?.(summary + batchNotice, preview) ?? false;

        if (!answer) {
            this.log("error", "Aborted by you!");
            return false;
        }

        this.log("verb", "OK");
        this.options.askForConfirmation = false; // do not ask for confirmation again on the next request
        return true;
    }

    /** Ensure an @me target is a DM or group DM before walking its history. */
    private async validatePrivateChannel(): Promise<boolean> {
        const url = `/api/v9/channels/${this.options.channelId}`;

        for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
            if (!this.state.running) return false;

            let resp: Response;
            try {
                resp = await this.request(url);
            } catch (err: any) {
                this.log("warn", `Channel lookup failed: ${err?.message || err}`);
                this.penalize("search", MAX_SEARCH_DELAY);
                await this.cooldown(this.effectiveDelay("search"));
                continue;
            }

            const { json, text } = await readBody(resp);
            if (isEdgeBlock(resp, json)) throw this.edgeBlocked();

            if (resp.status === 429) {
                this.penalize("search", MAX_SEARCH_DELAY);
                const asked = retryAfterMs(resp, json);
                const w = (asked > 0 ? asked : clamp(this.effectiveDelay("search"), 1000, MAX_SEARCH_DELAY)) + RETRY_MARGIN;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.log("warn", `Being rate limited by the API for ${w}ms! Slowing down channel lookups...`);
                this.printStats();
                await this.cooldown(w);
                continue;
            }

            if (!resp.ok) {
                const code = json?.code;
                if (resp.status === 401) {
                    throw new PurgecordError("Your session token was rejected. Restart Discord and try again.", { fatal: true, status: 401 });
                }
                if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50024) {
                    this.log("warn", `Skipping this channel, the API responded with status ${resp.status}: ${text}`);
                    return false;
                }
                throw new PurgecordError(`Error checking the channel, API responded with status ${resp.status}! ${text}`, { status: resp.status, code });
            }

            this.updatePace("search", resp);
            this.relax("search");

            if (!json || (json.type !== 1 && json.type !== 3)) {
                this.log("warn", "Skipping this archive entry because it is not a DM or group DM.");
                return false;
            }

            this.state.historyValidated = true;
            return true;
        }

        throw new PurgecordError(`Giving up on checking the channel after ${MAX_SEARCH_ATTEMPTS} attempts.`);
    }

    private async history(): Promise<SearchResponse | null> {
        if (this.state.historyDone) return { _history: true, total_results: 0, messages: [] };
        if (!this.state.historyValidated) {
            if (!await this.validatePrivateChannel()) return null;
            await this.pace("search");
        }

        const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
        if (this.state.cursorId) params.set("before", this.state.cursorId);
        const url = `/api/v9/channels/${this.options.channelId}/messages?${params}`;

        for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
            if (!this.state.running) return null;

            let resp: Response;
            try {
                resp = await this.request(url);
            } catch (err: any) {
                this.log("warn", `History request failed: ${err?.message || err}`);
                this.penalize("search", MAX_SEARCH_DELAY);
                await this.cooldown(this.effectiveDelay("search"));
                continue;
            }

            const { json, text } = await readBody(resp);
            if (isEdgeBlock(resp, json)) throw this.edgeBlocked();

            if (resp.status === 429) {
                this.penalize("search", MAX_SEARCH_DELAY);
                const asked = retryAfterMs(resp, json);
                const w = (asked > 0 ? asked : clamp(this.effectiveDelay("search"), 1000, MAX_SEARCH_DELAY)) + RETRY_MARGIN;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.log("warn", `Being rate limited by the API for ${w}ms! Slowing down history requests...`);
                this.printStats();
                await this.cooldown(w);
                continue;
            }

            if (!resp.ok) {
                const code = json?.code;
                if (resp.status === 401) {
                    throw new PurgecordError("Your session token was rejected. Restart Discord and try again.", { fatal: true, status: 401 });
                }
                if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50024) {
                    this.log("warn", `Skipping this channel, the API responded with status ${resp.status}: ${text}`);
                    return null;
                }
                throw new PurgecordError(`Error fetching channel history, API responded with status ${resp.status}! ${text}`, { status: resp.status, code });
            }

            this.updatePace("search", resp);
            this.relax("search");

            if (!Array.isArray(json)) {
                throw new PurgecordError("Discord returned an invalid channel history response. Stopping instead of guessing what to delete.");
            }
            const rawMessages = json as ApiMessage[];
            this.state.historyScanned += rawMessages.length;
            let messages = rawMessages;
            const minId = toSnowflake(this.options.minId);
            if (minId) {
                const boundary = BigInt(minId);
                messages = rawMessages.filter(message => /^\d+$/.test(message.id) && BigInt(message.id) > boundary);
                if (messages.length !== rawMessages.length) this.state.historyDone = true;
            }

            const data = { _history: true, total_results: 0, messages };
            if (this.options.debug) this.log("debug", `history page: ${messages.length} messages`);
            return data;
        }

        throw new PurgecordError(`Giving up on fetching channel history after ${MAX_SEARCH_ATTEMPTS} attempts.`);
    }

    private async search(): Promise<SearchResponse | null> {
        if (this.state.historyMode) return this.history();

        const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort_by: "timestamp", sort_order: "desc" });
        if (this.options.authorId) params.set("author_id", this.options.authorId);
        if (this.options.channelId) params.set("channel_id", this.options.channelId);
        const minId = toSnowflake(this.options.minId);
        if (minId) params.set("min_id", minId);
        if (this.state.cursorId) params.set("max_id", this.state.cursorId);
        // Repeated, not overwritten: Discord accepts has=link&has=file together.
        if (this.options.hasLink) params.append("has", "link");
        if (this.options.hasFile) params.append("has", "file");
        if (this.options.content) params.set("content", this.options.content);
        if (this.options.includeNsfw) params.set("include_nsfw", "true");
        const url = `/api/v9/guilds/${this.options.guildId}/messages/search?${params}`;

        for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
            if (!this.state.running) return null;

            let resp: Response;
            try {
                resp = await this.request(url);
            } catch (err: any) {
                // Network error or timeout. Worth retrying, the API never saw it.
                this.log("warn", `Search request failed: ${err?.message || err}`);
                this.penalize("search", MAX_SEARCH_DELAY);
                await this.cooldown(this.effectiveDelay("search"));
                continue;
            }

            const { json, text } = await readBody(resp);

            if (isEdgeBlock(resp, json)) throw this.edgeBlocked();

            // Not indexed yet
            if (resp.status === 202) {
                const w = clamp(retryAfterMs(resp, json) || 5000, 1000, MAX_SEARCH_DELAY);
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.log("warn", `This channel isn't indexed yet. Waiting ${(w / 1000).toFixed(1)}s for discord to index it...`);
                await this.cooldown(w);
                continue;
            }

            if (resp.status === 429) {
                this.penalize("search", MAX_SEARCH_DELAY);
                // Honour whatever Discord asked for in full — capping it would just put
                // us back inside the window it told us to stay out of. A retry_after of
                // 0 means "we did not say", so fall back to our own pace.
                const asked = retryAfterMs(resp, json);
                const w = (asked > 0 ? asked : clamp(this.effectiveDelay("search"), 1000, MAX_SEARCH_DELAY)) + RETRY_MARGIN;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.log("warn", `Being rate limited by the API for ${w}ms! Slowing down searches...`);
                this.printStats();
                await this.cooldown(w);
                continue;
            }

            if (!resp.ok) {
                const code = json?.code;

                if (resp.status === 401) {
                    throw new PurgecordError("Your session token was rejected. Restart Discord and try again.", { fatal: true, status: 401 });
                }
                // The channel is gone, or was never ours to read. End this job quietly
                // so a batch over an old archive is not killed by one dead server.
                if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50024) {
                    this.log("warn", `Skipping this channel, the API responded with status ${resp.status}: ${text}`);
                    return null;
                }
                throw new PurgecordError(`Error searching messages, API responded with status ${resp.status}! ${text}`, { status: resp.status, code });
            }

            this.updatePace("search", resp);
            this.relax("search");

            const data = (json || {}) as SearchResponse;
            if (this.options.debug) this.log("debug", `search page: ${(data.messages as unknown[] | undefined)?.length ?? 0} groups`);
            return data;
        }

        throw new PurgecordError(`Giving up on searching after ${MAX_SEARCH_ATTEMPTS} attempts.`);
    }

    private filterResponse(data: SearchResponse) {
        const historyPage = data._history === true;
        if (!historyPage) {
            // The search total will decrease as we delete stuff.
            const total = Number(data.total_results) || 0;
            if (total > this.state.grandTotal) this.state.grandTotal = total;
        }

        // Search hits may be wrapped in conversation arrays; history rows are not.
        const groups = Array.isArray(data.messages) ? data.messages : [];
        const discoveredMessages = groups
            .map(group => {
                if (!Array.isArray(group)) return group as ApiMessage;
                return (group.find(message => message?.hit === true) || (group.length === 1 ? group[0] : null)) as ApiMessage;
            })
            .filter((message): message is ApiMessage => !!message?.id);

        this.state._pageMessages = discoveredMessages;

        // Guild search applies these filters remotely. Direct DM history does not,
        // so apply the same constraints before anything becomes deletable.
        let candidates = discoveredMessages;
        if (historyPage) {
            candidates = candidates.filter(message => matchesHistoryFilters(message, this.options));
            this.state.grandTotal += candidates.length;
        }

        let messagesToDelete = candidates;
        messagesToDelete = messagesToDelete.filter(msg => !UNDELETABLE_MESSAGE_TYPES.has(msg.type));
        messagesToDelete = messagesToDelete.filter(msg => msg.pinned ? !!this.options.includePinned : true);

        const { pattern } = this.options;
        if (pattern) {
            try {
                const regex = new RegExp(pattern, "i");
                messagesToDelete = messagesToDelete.filter(msg => regex.test(messageText(msg)));
            } catch (e) {
                this.log("warn", `Ignoring RegExp because pattern is malformed! ${e}`);
            }
        }

        const skippedMessages = candidates.filter(msg => !messagesToDelete.includes(msg));

        this.state._messagesToDelete = messagesToDelete;
        this.state._skippedMessages = skippedMessages;

        if (this.options.debug) this.log("debug", `filterResponse: ${messagesToDelete.length} to delete, ${skippedMessages.length} skipped, cursor ${this.state.cursorId}`);
    }

    private async deleteMessagesFromList() {
        for (let i = 0; i < this.state._messagesToDelete.length; i++) {
            const message = this.state._messagesToDelete[i];
            if (!this.state.running) {
                this.log("error", "Stopped by you!");
                return;
            }

            // The preview goes out separately so streamer mode can blur just that.
            this.onLog("debug",
                `[${this.state.delCount + 1}/${this.state.grandTotal}] `
                + `${new Date(message.timestamp).toLocaleString()} `
                + `${displayName(message.author)} {ID:${message.id}}`,
                messagePreview(message).replace(/\n/g, "↵")
            );

            // Rate limits and one-time thread recovery are not the message's fault,
            // so they get a larger budget than an actual request failure.
            let result: DeleteResult = FAILED;
            let failures = 0;
            let transientRetries = 0;
            for (;;) {
                await this.pace("delete");
                if (!this.state.running) {
                    this.log("error", "Stopped by you!");
                    return;
                }

                result = await this.deleteMessage(message);

                if (result === RETRY) {
                    if (++transientRetries >= MAX_TRANSIENT_RETRIES) break;
                } else if (result === FAILED) {
                    if (++failures >= (this.options.maxAttempt ?? 2)) break;
                    this.log("verb", `Retrying... (${failures}/${this.options.maxAttempt})`);
                } else break;
            }

            if (result === DELETED || result === ALREADY_GONE) {
                this.state.delCount++;
                // Only a message we actually removed proves the run is progressing.
                if (result === DELETED) this.state.confirmedDelCount++;
            } else {
                // Counted once, then left behind. The cursor moves past it either way,
                // which is what stops an undeletable message from being re-found forever.
                this.state.failCount++;
            }

            this.calcEtr();
            this.onProgress?.(this.state, this.stats);
        }
    }

    /** Reopen an archived thread so the failed deletion can be retried. */
    private async unarchiveThread(channelId: string): Promise<DeleteResult> {
        // The failed DELETE also counts as a mutation request. Keep the configured
        // spacing before PATCHing the thread instead of firing both back to back.
        await this.pace("delete");
        if (!this.state.running) return RETRY;

        let resp: Response;
        try {
            resp = await this.request(`/api/v9/channels/${channelId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ archived: false })
            });
        } catch (err: any) {
            this.log("error", `Unarchive request threw an error: ${err?.message || err}`);
            this.stats.deleteNextAt = Date.now() + this.effectiveDelay("delete");
            return FAILED;
        }

        const { json, text } = await readBody(resp);

        if (isEdgeBlock(resp, json)) throw this.edgeBlocked();
        if (resp.status === 429) return this.deferDeleteForRateLimit(resp, json);
        if (resp.status === 401) {
            throw new PurgecordError("Your session token was rejected. Restart Discord and try again.", { fatal: true, status: 401 });
        }

        this.updatePace("delete", resp);

        if (resp.ok) {
            this.relax("delete");
            this.log("success", "Reopened the archived thread. Retrying the deletion...");
            return RETRY;
        }

        const code = json?.code;
        if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50013 || code === 160005) {
            const reason = code === 160005
                ? "it is locked"
                : "you do not have permission to reopen it";
            this.log("warn", `Could not reopen the archived thread because ${reason}. Skipping this message.`);
            return SKIPPED;
        }

        this.log("error", `Error reopening the archived thread, API responded with status ${resp.status}! ${text}`);
        return FAILED;
    }

    /** Apply Discord's requested cooldown to any mutation of a message/thread. */
    private deferDeleteForRateLimit(resp: Response, body: any): DeleteResult {
        this.penalize("delete", MAX_DELETE_DELAY);
        const asked = retryAfterMs(resp, body);
        const w = (asked > 0 ? asked : clamp(this.effectiveDelay("delete"), 500, MAX_DELETE_DELAY)) + RETRY_MARGIN;
        this.stats.throttledCount++;
        this.stats.throttledTotalTime += w;
        this.log("warn", `Being rate limited by the API for ${w}ms! Slowing down deletions...`);
        this.printStats();
        this.stats.deleteNextAt = Date.now() + w;
        return RETRY;
    }

    private async deleteMessage(message: ApiMessage): Promise<DeleteResult> {
        const channelId = message.channel_id ?? this.options.channelId;
        let resp: Response;
        try {
            resp = await this.request(`/api/v9/channels/${channelId}/messages/${message.id}`, { method: "DELETE" });
        } catch (err: any) {
            // No response at all (network error, timeout). Nothing updated the pacing
            // clock, so re-arm it by hand or the retries fire back to back.
            this.log("error", `Delete request threw an error: ${err?.message || err}`);
            this.stats.deleteNextAt = Date.now() + this.effectiveDelay("delete");
            return FAILED;
        }

        const { json, text } = await readBody(resp);

        if (isEdgeBlock(resp, json)) throw this.edgeBlocked();

        if (resp.ok) {
            this.updatePace("delete", resp);
            this.relax("delete");
            // The raw request bypasses Discord's own action, so the local message
            // cache has to be told the message is gone or the chat keeps showing it.
            FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId, id: message.id });
            return DELETED;
        }

        const code = json?.code;

        if (resp.status === 429) return this.deferDeleteForRateLimit(resp, json);

        // Someone (or a previous run) already deleted it. That is the outcome we
        // wanted, but it is not proof that this run is making progress — see the
        // sweep accounting in run().
        if (resp.status === 404 && code === 10008) {
            this.log("verb", "That message was already gone.");
            this.updatePace("delete", resp);
            return ALREADY_GONE;
        }

        if (resp.status === 401) {
            throw new PurgecordError("Your session token was rejected. Restart Discord and try again.", { fatal: true, status: 401 });
        }

        // Documented as "Unknown Message", but a 403 carrying it means Discord's
        // anti-abuse systems blocked the request. Hammering it makes it worse.
        if (resp.status === 403 && code === 10008) {
            throw new PurgecordError("Discord blocked this request. Stopping — wait a while before trying again.", { fatal: true, status: 403, code });
        }

        this.updatePace("delete", resp);

        if (code === 50083) {
            this.log("warn", "This message is in an archived thread. Reopening the thread...");
            return this.unarchiveThread(channelId!);
        }

        const reason = PERMANENT_DELETE_ERRORS[code];
        if (reason || resp.status === 403) {
            this.log("warn", `Skipping a message because ${reason || "the API refused it"}. {ID:${message.id}}`);
            return SKIPPED;
        }

        this.log("error", `Error deleting message, API responded with status ${resp.status}! ${text}`);
        return FAILED;
    }

    /** All API traffic goes through here so pings and timeouts are handled once. */
    private async request(url: string, init: RequestInit = {}) {
        this.beforeTs = Date.now();
        try {
            return await fetch(url, {
                ...init,
                headers: {
                    "Authorization": this.options.token,
                    ...init.headers
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT)
            });
        } finally {
            this.stats.lastPing = Date.now() - this.beforeTs;
            this.stats.avgPing = this.stats.avgPing && this.stats.avgPing > 0
                ? (this.stats.avgPing * 0.9) + (this.stats.lastPing * 0.1)
                : this.stats.lastPing;
        }
    }

    private edgeBlocked() {
        return new PurgecordError(
            "Blocked by Cloudflare — too many requests reached Discord's edge. "
            + "Stop for a while (this can last up to 24h) and use larger delays next time.",
            { fatal: true, status: 429 }
        );
    }

    /** The delay we should currently keep between requests of a given kind. */
    effectiveDelay(kind: "search" | "delete") {
        const configured = kind === "search" ? this.options.searchDelay : this.options.deleteDelay;
        const ceiling = kind === "search" ? MAX_SEARCH_DELAY : MAX_DELETE_DELAY;
        const backoff = kind === "search" ? this.stats.searchBackoff : this.stats.deleteBackoff;
        return clamp((Number(configured) || 0) + backoff, 0, ceiling);
    }

    /** Wait until we are allowed to issue the next request of this kind. */
    private async pace(kind: "search" | "delete") {
        const due = kind === "search" ? this.stats.searchNextAt : this.stats.deleteNextAt;
        await this.cooldown(due - Date.now());
    }

    /**
     * Sleep, but in slices, so pressing Stop during a multi-minute cooldown does
     * not leave the run frozen.
     */
    private async cooldown(ms: number) {
        const until = Date.now() + ms;
        for (;;) {
            const left = until - Date.now();
            if (left <= 0 || !this.state.running) return;
            await new Promise(done => setTimeout(done, Math.min(left, 1000)));
        }
    }

    /**
     * Schedule the earliest time the next request of this kind may go out.
     * Discord only reliably sends bucket headers to bots, so they are used when
     * present and the configured delay carries the rest.
     */
    private updatePace(kind: "search" | "delete", resp: Response, extraWaitMs = 0) {
        let delay = this.effectiveDelay(kind);

        // Missing headers must not look like an empty bucket: Headers.get() returns
        // null when absent and Number(null) is 0.
        const remaining = resp.headers.get("x-ratelimit-remaining");
        const resetAfter = resp.headers.get("x-ratelimit-reset-after");
        if (remaining !== null && resetAfter !== null && Number(remaining) === 0) {
            const refillMs = Number(resetAfter) * 1000;
            // Bucket is empty: never issue the next request before it refills.
            if (Number.isFinite(refillMs)) delay = Math.max(delay, refillMs + RETRY_MARGIN);
        }

        const next = Date.now() + delay + extraWaitMs;
        if (kind === "search") this.stats.searchNextAt = next;
        else this.stats.deleteNextAt = next;
    }

    /** Grow the adaptive backoff after being throttled. */
    private penalize(kind: "search" | "delete", ceiling: number) {
        const current = kind === "search" ? this.stats.searchBackoff : this.stats.deleteBackoff;
        const next = clamp(current * 2 + 500, 0, ceiling);
        if (kind === "search") this.stats.searchBackoff = next;
        else this.stats.deleteBackoff = next;
    }

    /** Ease the backoff back down after a request that was not throttled. */
    private relax(kind: "search" | "delete") {
        const current = kind === "search" ? this.stats.searchBackoff : this.stats.deleteBackoff;
        const next = Math.max(0, current * 0.8 - 50);
        if (kind === "search") this.stats.searchBackoff = next;
        else this.stats.deleteBackoff = next;
    }

    printStats() {
        this.log("verb",
            `Delete delay: ${this.effectiveDelay("delete") | 0}ms, Search delay: ${this.effectiveDelay("search") | 0}ms`,
            `Last Ping: ${this.stats.lastPing}ms, Average Ping: ${(this.stats.avgPing ?? 0) | 0}ms`
        );
        this.log("verb",
            `Rate Limited: ${this.stats.throttledCount} times.`,
            `Total time throttled: ${msToHMS(this.stats.throttledTotalTime)}.`
        );
    }
}

export function msToHMS(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return "--h --m --s";
    return `${ms / 3.6e6 | 0}h ${(ms % 3.6e6) / 6e4 | 0}m ${(ms % 6e4) / 1000 | 0}s`;
}
