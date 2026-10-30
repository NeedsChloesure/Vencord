/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Chloe
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { getTheme, Theme } from "@utils/discord";
import { useTimer } from "@utils/react";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, useEffect, useRef } from "@webpack/common";
import type { ChangeEvent, ReactNode } from "react";

import { msToHMS } from "./core";
import { getAllGuildIds, getCurrentChannelId, getCurrentGuildId, getCurrentUserId } from "./discord";
import { core, startRun } from "./engine";
import { pickMessageId } from "./picker";
import { settings } from "./settings";
import { addLog, clearLogs, maskIds, notify, setDraft, usePanelStore } from "./store";

const cl = classNameFactory("vc-purgecord-");

function Row({ label, children }: { label: string; children: ReactNode; }) {
    return (
        <div className={cl("row")}>
            <span className={cl("row-label")}>{label}</span>
            <div className={cl("row-body")}>{children}</div>
        </div>
    );
}

interface TextFieldProps {
    label: string;
    value: string;
    placeholder?: string;
    onChange(value: string): void;
}

function TextField({ label, value, placeholder, onChange }: TextFieldProps) {
    return (
        <Row label={label}>
            <input
                className={cl("input")}
                type="text"
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                onChange={e => onChange(e.currentTarget.value)}
            />
        </Row>
    );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void; }) {
    return (
        <label className={cl("toggle")}>
            <Switch checked={checked} onChange={onChange} />
            <span>{label}</span>
        </label>
    );
}

type DelayField = "searchDelay" | "deleteDelay";

function DelaySlider({ field, label, min, max, step }: { field: DelayField; label: string; min: number; max: number; step: number; }) {
    const value = Number(settings.store[field]) || 0;

    return (
        <Row label={label}>
            <div className={cl("slider")}>
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={e => {
                        // Delays live in the plugin settings so pacing preferences survive a restart.
                        settings.store[field] = Number(e.currentTarget.value);
                        notify();
                    }}
                />
                <span className={cl("slider-value")}>{value}ms</span>
            </div>
        </Row>
    );
}

export function Panel({ modalProps }: { modalProps: RenderModalProps; }) {
    const { draft, logs, status } = usePanelStore();
    // Re-render once a second so the elapsed and remaining timers stay live.
    useTimer({ interval: 1000 });

    const logRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = logRef.current;
        if (el && draft.autoScroll) el.scrollTop = el.scrollHeight;
    }, [logs.length, draft.autoScroll]);

    const processed = status.delCount + status.failCount;
    const total = Math.max(status.grandTotal, processed, 0);
    const elapsed = status.startedAt ? Date.now() - status.startedAt : 0;
    const throttled = status.throttleBackoff > 0 ? ` (throttled +${status.throttleBackoff | 0}ms)` : "";
    const theme = getTheme();

    const statusText = !status.running && processed === 0
        ? "Idle"
        : status.historyMode
            ? `${status.historyScanned} message(s) scanned, ${processed} processed${throttled}`
            : total
                ? `${Math.round(processed / total * 100)}% (${processed}/${total}) · elapsed ${msToHMS(elapsed)} · remaining ${msToHMS(status.etr)}${throttled}`
                : "Waiting for the first page...";

    function fillCurrentChannel() {
        setDraft({
            channelId: getCurrentChannelId() ?? "",
            guildId: getCurrentGuildId()
        });
    }

    function fillCurrentGuild() {
        const guildId = getCurrentGuildId();
        setDraft({
            guildId,
            ...(guildId === "@me" ? { channelId: getCurrentChannelId() ?? "" } : {})
        });
    }

    function fillAllGuilds() {
        if (core.isBusy) {
            addLog("error", "Stop the current run before loading the server list.");
            return;
        }

        const guildIds = getAllGuildIds();
        if (!guildIds.length) {
            addLog("error", "Could not read your server list from the client.");
            return;
        }

        setDraft({
            guildId: guildIds.join(","),
            channelId: "",
            authorId: draft.authorId.trim() || getCurrentUserId() || ""
        });
        addLog("info", `Loaded ${guildIds.length} servers. Channel ID was cleared so every server is purged in full.`);
    }

    async function pick(kind: "before" | "after") {
        // The chat has to be clickable, so the panel gets out of the way.
        modalProps.onClose();
        const id = await pickMessageId(kind);
        if (id) setDraft(kind === "after" ? { minId: id } : { maxId: id });
        openPanel();
    }

    async function onArchiveSelected(event: ChangeEvent<HTMLInputElement>) {
        // React clears currentTarget once the handler returns, and this one awaits.
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) return;

        try {
            const json = JSON.parse(await file.text());
            const channelIds = Object.keys(json);
            if (!channelIds.length) throw new Error("That index does not list any channels.");

            setDraft({
                guildId: "@me",
                channelId: channelIds.join(","),
                authorId: draft.authorId.trim() || getCurrentUserId() || ""
            });
            addLog("info", `Loaded ${channelIds.length} channels from the archive.`);
        } catch (err: any) {
            addLog("error", `Error parsing file! ${err?.message || err}`);
        } finally {
            // Allow picking the same file again after an error.
            input.value = "";
        }
    }

    async function onDelete() {
        try {
            await startRun();
        } catch (err: any) {
            const message = err?.message || String(err);
            addLog("error", message);
            showToast({ text: message, variant: "critical" });
        }
    }

    return (
        <Modal
            {...modalProps}
            size="xl"
            title="Purgecord"
            subtitle="Bulk delete your own messages, one at a time, respecting Discord's rate limits"
            actions={[
                {
                    text: status.running ? "Deleting..." : "Delete",
                    variant: "critical-primary",
                    disabled: status.running,
                    onClick: onDelete
                },
                {
                    text: "Stop",
                    variant: "secondary",
                    disabled: !status.running,
                    onClick: () => core.stop()
                },
                {
                    text: "Close",
                    variant: "secondary",
                    onClick: modalProps.onClose
                }
            ]}
        >
            <div className={cl("layout")}>
                <div className={cl("form")}>
                    <Heading tag="h5">Target</Heading>
                    <Row label="Author ID">
                        <input
                            className={cl("input")}
                            type="text"
                            value={draft.authorId}
                            placeholder="Who wrote the messages"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => setDraft({ authorId: e.currentTarget.value })}
                        />
                        <Button size="min" variant="secondary" onClick={() => setDraft({ authorId: getCurrentUserId() ?? "" })}>
                            me
                        </Button>
                    </Row>
                    <Row label="Server ID">
                        <input
                            className={cl("input")}
                            type="text"
                            value={draft.guildId}
                            placeholder="One or more server IDs, or @me"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => setDraft({ guildId: e.currentTarget.value })}
                        />
                        <Button size="min" variant="secondary" onClick={fillCurrentGuild}>current</Button>
                        <Button size="min" variant="secondary" onClick={fillAllGuilds}>all</Button>
                    </Row>
                    <Row label="Channel ID">
                        <input
                            className={cl("input")}
                            type="text"
                            value={draft.channelId}
                            placeholder="Leave empty for a whole server"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => setDraft({ channelId: e.currentTarget.value })}
                        />
                        <Button size="min" variant="secondary" onClick={fillCurrentChannel}>current</Button>
                    </Row>
                    <Toggle
                        label="Include NSFW channels"
                        checked={draft.includeNsfw}
                        onChange={includeNsfw => setDraft({ includeNsfw })}
                    />

                    <Divider />

                    <Heading tag="h5">Filter</Heading>
                    <TextField
                        label="Containing text"
                        value={draft.content}
                        placeholder="Only delete messages with this text"
                        onChange={content => setDraft({ content })}
                    />
                    <TextField
                        label="Pattern"
                        value={draft.pattern}
                        placeholder="Case insensitive regular expression"
                        onChange={pattern => setDraft({ pattern })}
                    />
                    <Toggle label="has: link" checked={draft.hasLink} onChange={hasLink => setDraft({ hasLink })} />
                    <Toggle label="has: file" checked={draft.hasFile} onChange={hasFile => setDraft({ hasFile })} />
                    <Toggle label="Include pinned" checked={draft.includePinned} onChange={includePinned => setDraft({ includePinned })} />

                    <Divider />

                    <Heading tag="h5">Message range</Heading>
                    <Row label="After a message">
                        <input
                            className={cl("input")}
                            type="text"
                            value={draft.minId}
                            placeholder="Only newer messages"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => setDraft({ minId: e.currentTarget.value })}
                        />
                        <Button size="min" variant="secondary" onClick={() => pick("after")}>pick</Button>
                    </Row>
                    <Row label="Before a message">
                        <input
                            className={cl("input")}
                            type="text"
                            value={draft.maxId}
                            placeholder="Only older messages"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => setDraft({ maxId: e.currentTarget.value })}
                        />
                        <Button size="min" variant="secondary" onClick={() => pick("before")}>pick</Button>
                    </Row>
                    <Row label="After date">
                        <input
                            className={cl("input")}
                            type="datetime-local"
                            value={draft.minDate}
                            style={{ colorScheme: theme === Theme.Light ? "light" : "dark" }}
                            onChange={e => setDraft({ minDate: e.currentTarget.value })}
                        />
                    </Row>
                    <Row label="Before date">
                        <input
                            className={cl("input")}
                            type="datetime-local"
                            value={draft.maxDate}
                            style={{ colorScheme: theme === Theme.Light ? "light" : "dark" }}
                            onChange={e => setDraft({ maxDate: e.currentTarget.value })}
                        />
                    </Row>
                    <Paragraph className={cl("hint")}>
                        A message range wins over a date range. Leaving both empty deletes everything that matches the filters.
                    </Paragraph>

                    <Divider />

                    <Heading tag="h5">Pacing</Heading>
                    <DelaySlider field="searchDelay" label="Search delay" min={100} max={10000} step={100} />
                    <DelaySlider field="deleteDelay" label="Delete delay" min={50} max={10000} step={50} />
                    <Paragraph className={cl("hint")}>
                        These are floors, not fixed values. When Discord rate limits you, Purgecord waits as long as it asked
                        and adds a backoff of its own until requests succeed again.
                    </Paragraph>

                    <Divider />

                    <Heading tag="h5">Discord data archive</Heading>
                    <Row label="index.json">
                        <input className={cl("input", "file")} type="file" accept="application/json,.json" onChange={onArchiveSelected} />
                    </Row>
                    <Paragraph className={cl("hint")}>
                        Pick <code>messages/index.json</code> from the archive Discord emailed you. The server ID is set to
                        <code> @me</code> and every listed channel is queued.
                    </Paragraph>
                </div>

                <div className={cl("output")}>
                    <div className={cl("output-bar")}>
                        {status.running && !status.historyMode && total > 0
                            ? <progress className={cl("progress")} value={processed} max={total} />
                            : <progress className={cl("progress")} />}
                        <span className={cl("status")}>{statusText}</span>
                    </div>

                    <div className={cl("log")} ref={logRef}>
                        {logs.length === 0
                            ? <Paragraph className={cl("hint")}>Nothing yet. Fill in a target and press Delete.</Paragraph>
                            : logs.map((line, i) => (
                                <div key={i} className={cl("log-line", line.level)}>
                                    <span>{draft.streamerMode ? maskIds(line.text) : line.text}</span>
                                    {line.secret && (
                                        <span className={cl("log-secret")}>
                                            {draft.streamerMode ? "[hidden]" : line.secret}
                                        </span>
                                    )}
                                </div>
                            ))
                        }
                    </div>

                    <div className={cl("output-bar")}>
                        <Toggle label="Streamer mode" checked={draft.streamerMode} onChange={streamerMode => setDraft({ streamerMode })} />
                        <Toggle label="Auto scroll" checked={draft.autoScroll} onChange={autoScroll => setDraft({ autoScroll })} />
                        <Button size="min" variant="secondary" onClick={clearLogs}>Clear log</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openPanel() {
    openModal(props => <Panel modalProps={props} />, { modalKey: "vc-purgecord-panel" });
}
