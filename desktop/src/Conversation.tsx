// One tab's conversation: what was said, the work of each turn folded into a line, and what
// waits for the owner. Each kind of line is a small component; the list only draws what changed.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AgentDetail, apiFor, media, type TranscriptEntry } from "./api.ts";
import { bridge } from "./bridge.ts";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./markdown.tsx";
import { type Item, type Part, store, type Tab, type Tone, useModel, useSignal } from "./model.ts";
import { childKind, clock, count, MODES, oneLine, plural, short, speedText, tilde, took } from "./text.ts";
import { Button, Icon, Pulse } from "./ui.tsx";

const TONE_ICON: Record<Tone, string> = { muted: "info", warn: "alert", bad: "alert", good: "check", accent: "undo" };

function Status({ status }: { status: "run" | "ok" | "fail" | "done" | "failed" | "cancelled" }) {
	if (status === "run") return <span className="st"><Pulse size={11} /></span>;
	const ok = status === "ok" || status === "done";
	return <span className={`st ${ok ? "ok" : "fail"}`}><Icon name={ok ? "check" : "x"} size={12} /></span>;
}

function Thought({ part, live }: { part: Extract<Part, { p: "thought" }>; live: boolean }) {
	const [open, setOpen] = useState(false);
	const secs = part.done ? undefined : Math.round((Date.now() - part.startedAt) / 1000);
	return (
		<div className="thought">
			<button type="button" className="thought-head" onClick={() => setOpen(!open)}>
				<span className="st"><Icon name={open ? "down" : "right"} size={11} /></span>
				{part.done ? `thought for ${took(part.ms)}` : `thinking ${secs}s`}
				{part.speed ? <span className="faint" style={{ fontStyle: "normal" }}>{part.speed}</span> : null}
			</button>
			{open ? <div className="thought-text" onClick={() => !window.getSelection()?.toString() && setOpen(false)}>{part.text}</div> : live && !part.done ? <div className="thought-text peek"><span>{part.text.slice(-600)}</span></div> : null}
		</div>
	);
}

function PartLine({ env, part, live }: { env: string; part: Part; live: boolean }) {
	if (part.p === "thought") return <Thought part={part} live={live} />;
	if (part.p === "words") return <div className="part-words">{part.text}</div>;
	if (part.p === "child")
		return (
			<div className="part" style={{ paddingLeft: Math.max(0, part.depth - 1) * 14 }}>
				<Status status={part.status} />
				<span className="tool">↳ {part.agent}</span>
				<span className="subject" style={{ fontFamily: "inherit" }}>{childKind(part.kind)} #{part.task}{part.how ? ` ${part.how}` : part.label ? `: ${part.label}` : ""}</span>
				<button type="button" className="open-link" onClick={() => void store.openTask(env, part.task)}>open</button>
			</div>
		);
	return (
		<>
			<div className="part" style={{ paddingLeft: part.depth * 14 }}>
				<Status status={part.status} />
				<span className="tool">{part.tool}</span>
				<span className="subject" title={part.subject}>{part.subject}</span>
				{part.ms !== undefined ? <span className="ms">{took(part.ms)}</span> : null}
			</div>
			{part.status === "fail" && part.preview ? <div className="part-err" style={{ marginLeft: 22 + part.depth * 14 }}>{part.preview}</div> : null}
		</>
	);
}

/** "12 tool calls · bash ×6 · read ×4 · edit · +1 more · 2 thoughts · 1 failed · 48s" */
function workHead(parts: Part[], done: boolean, ms?: number): string {
	const tools = parts.filter((p) => p.p === "tool") as Array<Extract<Part, { p: "tool" }>>;
	const by = new Map<string, number>();
	for (const t of tools) by.set(t.tool, (by.get(t.tool) ?? 0) + 1);
	const top = [...by].sort((a, b) => b[1] - a[1]);
	const thoughts = parts.filter((p) => p.p === "thought").length;
	const subs = parts.filter((p) => p.p === "child").length;
	const failed = tools.filter((t) => t.status === "fail").length;
	return [
		tools.length ? `${plural(tools.length, "tool call")}${done ? "" : " so far"}` : "",
		...top.slice(0, 3).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)),
		top.length > 3 ? `+${top.length - 3} more` : "",
		subs ? plural(subs, "sub-task") : "",
		thoughts ? plural(thoughts, "thought") : "",
		failed ? `${failed} failed` : "",
		done && ms !== undefined ? took(ms) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function Work({ env, item }: { env: string; item: Extract<Item, { t: "work" }> }) {
	const [open, setOpen] = useState(item.open);
	const parts = item.parts;
	// A turn with a single call or thought is that call or thought itself, with no line above it.
	if (parts.length === 1 && item.done) return <div className="work"><div className="work-parts" style={{ borderTop: "none", paddingTop: 6 }}><PartLine env={env} part={parts[0]} live={false} /></div></div>;
	const shown = open ? parts : item.done ? [] : parts.slice(-6);
	return (
		<div className={`work${open ? " open" : ""}`}>
			<button type="button" className="work-head" onClick={() => ((item.open = !open), setOpen(!open))}>
				{item.done ? <Icon name="right" size={12} className="chev" /> : <Pulse size={12} />}
				<span className="grow cut">{workHead(parts, item.done, item.ms) || "working"}</span>
				{!item.done && !open && parts.length > 6 ? <span className="faint">show all</span> : null}
			</button>
			{shown.length ? (
				<div className="work-parts">
					{shown.map((p, i) => (
						<PartLine key={open ? i : parts.length - shown.length + i} env={env} part={p} live={!item.done} />
					))}
				</div>
			) : null}
		</div>
	);
}

function Entry({ env, entry, agent }: { env: string; entry: TranscriptEntry; agent: string }) {
	const [open, setOpen] = useState(false);
	if (entry.kind === "user") return <div className="it-user"><span className="from">task</span>{entry.text}</div>;
	if (entry.kind === "text") return <Markdown text={entry.text ?? ""} where={{ env, agent }} />;
	if (entry.kind === "thinking")
		return (
			<div className="thought">
				<button type="button" className="thought-head" onClick={() => setOpen(!open)}><span className="st"><Icon name={open ? "down" : "right"} size={11} /></span>thought</button>
				{open ? <div className="thought-text">{entry.text}</div> : null}
			</div>
		);
	return (
		<div style={{ fontSize: 12.5 }}>
			<div className="part">
				<Status status={entry.ok === undefined ? "run" : entry.ok ? "ok" : "fail"} />
				<span className="tool">{entry.tool}</span>
				<span className="subject">{entry.subject ? oneLine(entry.subject) : ""}</span>
				{entry.ms !== undefined ? <span className="ms">{took(entry.ms)}</span> : null}
			</div>
			{entry.result ? <div className="entry-result" style={entry.ok === false ? { color: "var(--bad)" } : undefined}>{short(entry.result, 4000)}</div> : null}
			{(entry.images ?? []).map((id) => (
				<div className="it-media" key={id} style={{ marginTop: 6, marginLeft: 22 }}><img src={media.tool(env, id)} alt="" onClick={(e) => window.dispatchEvent(new CustomEvent("pine:zoom", { detail: (e.target as HTMLImageElement).src }))} /></div>
			))}
		</div>
	);
}

function ApprovalCard({ env, item }: { env: string; item: Extract<Item, { t: "approval" }> }) {
	const { req, state } = item;
	const question = req.tool === "question";
	const head =
		state === "open" ? (question ? `${req.agent} asks` : "Approval needed") : state === "gone" ? "No longer open" : question ? (state === "allowed" ? "Answered" : "No answer") : state === "allowed" ? "Allowed" : "Denied";
	return (
		<div className={`card it-approval ${state}`}>
			<Icon name={state === "open" ? (question ? "chat" : "alert") : state === "allowed" ? "check" : "x"} className={state === "open" ? "" : "faint"} />
			<div className="what">
				<div>
					<b>{head}</b>
					{question ? null : <> · <span className="mono">{req.tool}</span></>}
					{state !== "open" && item.by ? <span className="faint"> ({item.by}){item.always && req.remember ? ` · ${req.remember} will not ask again in this conversation` : ""}</span> : null}
					{state === "gone" ? <span className="faint"> · pine was restarted, or the question ran out of time</span> : null}
				</div>
				<div className="sum">{req.summary}</div>
				{state === "open" && !question ? <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{req.why}</div> : null}
			</div>
			{state === "open" ? <Button variant="primary" small onClick={() => store.ask(env, req.id)}>{question ? "Answer" : "Decide"}</Button> : null}
		</div>
	);
}

export function Steps({ items }: { items: Array<{ text: string; status: string }> }) {
	const done = items.filter((t) => t.status === "done").length;
	return (
		<div className="steps">
			<div className="head">
				steps · {done} of {items.length} done
				<span className="bar"><i style={{ width: `${(100 * done) / Math.max(1, items.length)}%` }} /></span>
			</div>
			{items.map((t, i) => (
				<div key={i} className={`step ${t.status}`}>
					<span className="box">{t.status === "done" ? <Icon name="check" size={10} /> : null}</span>
					<span className="selectable">{t.text}</span>
				</div>
			))}
		</div>
	);
}

/** The menu of a message of the owner's: what can be done from it. */
async function branchMenu(tab: Tab, task: number): Promise<void> {
	const picked = await bridge.contextMenu([{ id: "branch", label: "Branch from here" }, ...(tab.folder ? [{ id: "worktree", label: "Branch from here into a worktree" }] : [])]);
	if (picked === "branch" || picked === "worktree") await store.branch(tab.env, tab.agent, tab.session, task, picked === "worktree");
}

const zoom = (src: string) => window.dispatchEvent(new CustomEvent("pine:zoom", { detail: src }));

const Row = memo(function Row({ item, tab }: { item: Item; v: number; tab: Tab }) {
	switch (item.t) {
		case "user":
			return (
				<div className="it-user" onContextMenu={item.task !== undefined && tab.kind === "chat" ? (e) => (e.preventDefault(), void branchMenu(tab, item.task!)) : undefined}>
					{item.task !== undefined && tab.kind === "chat" ? (
						<span className="branch-from">
							<Button small variant="ghost" icon="branch" title="Branch from here: a new conversation that goes on from this message, with what was said up to it. This one stays as it is." onClick={() => void store.branch(tab.env, tab.agent, tab.session, item.task)} />
						</span>
					) : null}
					{item.from ? <span className="from">{item.from}</span> : null}
					{item.text}
					{item.files?.length ? <div className="files">{item.files.map((f) => <span className="tag" key={f}><Icon name="clip" size={11} />{f}</span>)}</div> : null}
				</div>
			);
		case "answer":
			return <Markdown text={item.text} live={item.live} where={{ env: tab.env, agent: item.agent, session: tab.kind === "chat" ? tab.session : undefined }} />;
		case "work":
			return <Work env={tab.env} item={item} />;
		case "note":
			return (
				<div className={`it-note ${item.tone}`}>
					<Icon name={TONE_ICON[item.tone]} size={14} />
					<div className="grow">
						<span className="head">{item.text}</span>
						{item.action ? <button type="button" className="open-link" style={{ marginLeft: 8 }} onClick={item.action.run}>{item.action.label}</button> : null}
						{item.lines?.length ? <div className="lines">{item.lines.filter((l) => l.text).map((l, i) => <span key={i} className={l.tone ?? ""}>{l.text}</span>)}</div> : null}
					</div>
				</div>
			);
		case "event":
			return (
				<div className="it-event">
					<Icon name="bolt" size={14} />
					<div className="grow">
						<b>{item.label}</b>
						<div className="body">{short(oneLine(tilde(item.body)), 400)}</div>
					</div>
				</div>
			);
		case "approval":
			return <ApprovalCard env={tab.env} item={item} />;
		case "steps":
			return <div className="card"><Steps items={item.items} /></div>;
		case "media":
			return (
				<div className="it-media">
					{item.kind === "image" ? <img src={item.url} alt={item.name} draggable={false} onClick={() => zoom(item.url)} /> : item.kind === "video" ? <video src={item.url} controls preload="metadata" /> : <audio src={item.url} controls preload="metadata" />}
					<div className="cap">{item.name}</div>
				</div>
			);
		case "goal": {
			const g = item.goal;
			const wait = g.status !== "met" && g.status !== "active";
			return (
				<div className={`it-goal${wait ? " wait" : ""}`}>
					<span className="mark"><Icon name={g.status === "met" ? "check" : wait ? "clock" : "target"} size={14} /></span>
					<div>
						<b>goal</b> <span className="muted">{g.note}</span>
						{g.reason ? <div className="reason">{short(oneLine(g.reason), 240)}</div> : null}
						{item.full ? <div className="reason">the goal: {short(oneLine(g.objective), 320)}</div> : null}
					</div>
				</div>
			);
		}
		case "divider":
			return <div className="it-divider">{item.text}</div>;
		case "entry":
			return <Entry env={tab.env} entry={item.entry} agent={tab.agent} />;
	}
});

/** Where a conversation begins: who this agent is, what it runs on and reaches, and what it has. */
function Welcome({ tab }: { tab: Tab }) {
	useModel(store);
	const info = store.agent(tab.env, tab.agent);
	const [has, setHas] = useState<AgentDetail>();
	useEffect(() => {
		let live = true;
		// (An older pine does not say; the line is then left out.)
		apiFor(tab.env).agentDetail(tab.agent).then((d) => live && setHas(d), () => {});
		return () => {
			live = false;
		};
	}, [tab.agent]);
	const say = (text: string) => {
		tab.draft = text;
		tab.touch();
		store.ask_("focus-input");
	};
	const mode = MODES.find((m) => m.value === info?.mode);
	const h = has?.holdings;
	const counts: Array<[string, number]> = h ? [["skill", h.skills.length], ["event source", h.sources.length], ["schedule", h.schedules.length], ["MCP server", h.servers.length], ["conversation", h.conversations.length]] : [];
	return (
		<div className="welcome">
			<span className="avatar big">{tab.agent.slice(0, 1).toUpperCase()}</span>
			<h1>{tab.agent}</h1>
			<p>{info?.description || "An agent of yours."}</p>
			<div className="facts">
				<span className="fact" title="The model it runs on"><Icon name="cpu" size={12} /><b>{info?.model ?? "no model"}</b></span>
				<span className="fact" title={mode?.about}><Icon name="shield" size={12} /><b>{info?.mode}</b>{info?.mode === "auto" || info?.mode === "bypass" ? "your account, no sandbox" : "in its sandbox"}</span>
				{info?.main ? <span className="fact" title="It creates and changes the other agents and pine's settings when you ask it to">administers pine</span> : null}
				{info?.delegates.length ? <span className="fact" title="Agents it can hand work to">hands work to <b>{info.delegates.includes("*") ? "every agent" : info.delegates.join(", ")}</b></span> : null}
				{counts.filter(([, n]) => n > 0).map(([what, n]) => <span className="fact" key={what}><b>{n}</b>{n === 1 ? what : `${what}s`}</span>)}
			</div>
			{info?.modelProblem ? (
				<div className="notice no-model">
					<Icon name="alert" />
					<div className="grow">{info.modelProblem} Sign in to a provider (a Claude, ChatGPT or Copilot subscription, or an API key) or add a model server of your own, then choose the model {tab.agent} runs on.</div>
					<Button small onClick={() => store.openSettings("models")}>Models…</Button>
				</div>
			) : null}
			<p className="faint">
				{tab.session === "main" ? "Its main conversation: the one it keeps for good, and where what it is subscribed to as an agent arrives." : `Conversation ${tab.session}.`} {tab.folder ? `It works in ${tilde(tab.folder)}.` : "It works in its own workspace."}
			</p>
			<div className="hints">
				<Button small onClick={() => say("What can you do for me, and what are you set up with?")}>What can you do?</Button>
				<Button small icon="gear" onClick={() => store.openSettings("agents", tab.agent, tab.env)}>Agent settings</Button>
				<Button small icon="folder" onClick={() => void store.pickFolder(tab)}>Give it a folder</Button>
				<Button small icon="command" onClick={() => void store.command("palette")}>Commands <kbd>⌘K</kbd></Button>
			</div>
		</div>
	);
}

/**
 * Find in the conversation. The matches are marked with the browser's own highlights, which
 * change nothing in the page: no element is added to what an answer drew.
 */
function FindBar({ root, close, initial }: { root: () => HTMLElement | null; close: () => void; initial?: string }) {
	const [query, setQuery] = useState(initial ?? "");
	const [at, setAt] = useState(0);
	const ranges = useRef<Range[]>([]);
	const [count, setCount] = useState(0);
	const marks = (CSS as any).highlights as Map<string, unknown> | undefined;
	useEffect(() => {
		const el = root();
		ranges.current = [];
		const q = query.toLowerCase();
		if (el && q) {
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node && ranges.current.length < 2000; node = walker.nextNode()) {
				const text = (node.textContent ?? "").toLowerCase();
				for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
					const r = new Range();
					r.setStart(node, i);
					r.setEnd(node, i + q.length);
					ranges.current.push(r);
				}
			}
		}
		setCount(ranges.current.length);
		// The newest match first: what is looked for is usually near the end.
		setAt(Math.max(0, ranges.current.length - 1));
		marks?.set("pine-find", new (window as any).Highlight(...ranges.current));
		return () => void (marks?.delete("pine-find"), marks?.delete("pine-find-at"));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query]);
	useEffect(() => {
		const r = ranges.current[at];
		if (!r) return void marks?.delete("pine-find-at");
		marks?.set("pine-find-at", new (window as any).Highlight(r));
		(r.startContainer.parentElement as HTMLElement | null)?.closest("details:not([open])")?.setAttribute("open", "");
		r.startContainer.parentElement?.scrollIntoView({ block: "center" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [at, count]);
	const step = (by: number) => count && setAt((at + by + count) % count);
	return (
		<div className="find">
			<Icon name="search" size={13} className="faint" />
			<input
				autoFocus
				placeholder="Find in this conversation"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") close();
					if (e.key === "Enter") step(e.shiftKey ? 1 : -1);
				}}
			/>
			<span className="faint">{query ? (count ? `${at + 1} of ${count}` : "nothing") : ""}</span>
			<Button small variant="ghost" icon="up" title="Earlier (↩)" onClick={() => step(-1)} />
			<Button small variant="ghost" icon="down" title="Later (⇧↩)" onClick={() => step(1)} />
			<Button small variant="ghost" icon="x" onClick={close} />
		</div>
	);
}

/** The line above the input: what is going on right now, and the way to stop it. */
function StatusLine({ tab }: { tab: Tab }) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!tab.busy) return;
		const t = window.setInterval(() => tick((n) => n + 1), 1000);
		return () => window.clearInterval(t);
	}, [tab.busy]);
	const waiting = [...tab.approvals.values()];
	const elsewhere = store.tabs.find((t) => t !== tab && t.approvals.size > 0);
	const goal = tab.goal?.status === "active" ? tab.goal : undefined;
	if (!tab.busy) {
		if (waiting.length) return <div className="status warn"><Icon name="alert" size={14} /><span>{waiting[0].req.tool === "question" ? "A question waits for your answer." : "A request waits for your approval."}</span><Button small onClick={() => store.ask(tab.env, waiting[0].req.id)}>Open</Button></div>;
		if (goal) return <div className="status"><Icon name="target" size={14} /><span>goal · round {goal.round} of {goal.until} · checking whether it is met</span><Button small onClick={() => void store.setGoal(tab, "pause")}>Pause</Button></div>;
		if (elsewhere) return <div className="status warn"><Icon name="alert" size={14} /><span>{elsewhere.agent}{store.on(elsewhere.env)} · {elsewhere.session} waits for you.</span><Button small onClick={() => store.activate(elsewhere)}>Go there</Button></div>;
		if (tab.programs.length) return <div className="status"><Icon name="play" size={13} /><span>{plural(tab.programs.length, "program")} still running</span><Button small variant="ghost" onClick={() => void store.command("code-running")}>Show</Button></div>;
		return <div className="status" />;
	}
	const secs = Math.max(0, Math.round((Date.now() - tab.startedAt) / 1000));
	const steps = tab.steps?.items ?? [];
	const at = steps.findIndex((s) => s.status === "in_progress");
	const helpers = [...tab.children.values()].filter((c) => c.running).length;
	const total = tab.tokens.input + tab.tokens.cached;
	const parts = [
		waiting.length ? "waiting for you" : tab.thinking ? "thinking" : "working",
		clock(secs),
		at >= 0 ? `step ${at + 1} of ${steps.length}` : "",
		tab.toolCalls ? plural(tab.toolCalls, "tool call") : "",
		helpers ? `${plural(helpers, "sub-task")} running` : "",
		tab.tokens.output ? `${count(total)}↑${tab.tokens.cached ? ` (${Math.round((100 * tab.tokens.cached) / Math.max(1, total))}% cached)` : ""} ${count(tab.tokens.output)}↓` : "",
		speedText(tab.speed),
	].filter(Boolean);
	return (
		<div className={`status${waiting.length ? " warn" : ""}`}>
			<Pulse size={13} />
			{goal ? <span>goal · round {goal.round} of {goal.until}</span> : null}
			{parts.map((p, i) => <span key={i} className={i || goal ? "sep" : ""}>{p}</span>)}
			<span className="grow" />
			{waiting.length ? <Button small onClick={() => store.ask(tab.env, waiting[0].req.id)}>Open</Button> : null}
		</div>
	);
}

/** What a conversation is, in one line at its top: whose, which, where it works; and how full its context is. */
function ConvHead({ tab }: { tab: Tab }) {
	useModel(store);
	const chat = tab.kind === "chat";
	const total = tab.tokens.input + tab.tokens.cached;
	return (
		<div className="conv-head">
			<span className="avatar">{tab.agent.slice(0, 1).toUpperCase()}</span>
			{store.shown.length > 1 ? <><span className="faint" title="The environment whose pine this is">{store.env(tab.env)?.label}</span><span className="faint">/</span></> : null}
			<span className="muted">{tab.agent}</span>
			<span className="faint">/</span>
			<b className="cut" title={chat ? `conversation ${tab.session}` : undefined}>{chat ? store.titleOf(tab.env, tab.agent, tab.session) : `task #${tab.task}`}</b>
			{chat && tab.worktree ? (
				<button type="button" className="chip worktree" title={`Works in the worktree ${tab.worktree.branch} of ${tab.worktree.base}${tab.folder ? `, at ${tab.folder}` : ""}: merge it, update it or discard it`} onClick={() => void store.worktreeMenu(tab)}>
					<Icon name="branch" size={12} />
					<span className="cut">{tab.worktree.branch}</span>
				</button>
			) : chat && tab.folder ? (
				<button type="button" className="chip" title={`Works in ${tab.folder}`} onClick={() => void store.pickFolder(tab)}><Icon name="folder" size={12} /><span className="cut">{tilde(tab.folder)}</span></button>
			) : null}
			{chat && store.isPinned(tab) ? <Icon name="star" size={12} className="faint" /> : null}
			<span className="grow" />
			{tab.context !== undefined ? (
				<span className="conv-meta" title={`Context ${tab.context}% full${tab.cacheShare !== undefined ? ` · ${tab.cacheShare}% of the last request came from the model server's cache` : ""}${speedText(tab.speed) ? ` · ${speedText(tab.speed)}` : ""}`}>
					<Ring percent={tab.context} />
					{total ? `${count(total)} · ` : ""}{Math.round(tab.context)}%
				</span>
			) : null}
			{chat ? <Button small variant="ghost" className={store.code ? "on" : ""} icon="panel" title="The agent and its workspace: what it has, files, changes, output (⌥⌘B)" onClick={() => void store.command("code")} /> : null}
		</div>
	);
}

/** A small ring that fills with the conversation's context window. */
function Ring({ percent }: { percent: number }) {
	const r = 6;
	const c = 2 * Math.PI * r;
	const colour = percent >= 85 ? "var(--bad)" : percent >= 65 ? "var(--warn)" : "var(--muted)";
	return (
		<svg className="ring" width="16" height="16" viewBox="0 0 16 16">
			<circle cx="8" cy="8" r={r} fill="none" stroke="var(--press)" strokeWidth="2" />
			<circle cx="8" cy="8" r={r} fill="none" stroke={colour} strokeWidth="2" strokeDasharray={`${(c * Math.min(100, percent)) / 100} ${c}`} strokeLinecap="round" />
		</svg>
	);
}

export function Conversation({ tab }: { tab: Tab }) {
	useModel(tab);
	// It opens by a key, and by itself when the conversation was found by words that are in it.
	const take = () => (store.pendingFind?.key === tab.key ? store.pendingFind.query : undefined);
	const [finding, setFinding] = useState(() => take() !== undefined);
	const [looked, setLooked] = useState(() => {
		const q = take();
		if (q !== undefined) store.pendingFind = undefined;
		return q;
	});
	useSignal("find", () => {
		if (store.active !== tab) return;
		const q = take();
		if (q !== undefined) (store.pendingFind = undefined), setLooked(q);
		setFinding(true);
	});
	// The words are marked once what was said is on the page.
	const loaded = tab.loaded;
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [away, setAway] = useState(false);
	const toEnd = () => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	};
	// A new tab starts at its end; what arrives keeps the end in view unless the reader went up.
	useLayoutEffect(() => {
		stick.current = true;
		toEnd();
	}, [tab.id]);
	useLayoutEffect(() => {
		if (stick.current) toEnd();
	});
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		// Text that is drawn a frame later (an answer that is still arriving) grows the page after the layout above.
		const ro = new ResizeObserver(() => stick.current && toEnd());
		for (const child of el.children) ro.observe(child);
		return () => ro.disconnect();
	}, [tab.id]);
	const chat = tab.kind === "chat";
	return (
		<div className="conv">
			<ConvHead tab={tab} />
			{finding && loaded ? <FindBar key={looked ?? ""} initial={looked} root={() => scroller.current} close={() => (setFinding(false), setLooked(undefined))} /> : null}
			<div
				className="transcript"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					stick.current = near;
					if (away === near) setAway(!near);
				}}
			>
				<div className="column">
					{!tab.loaded ? <div className="empty"><Pulse /></div> : !tab.items.length && chat ? <Welcome tab={tab} /> : tab.items.map((item) => <Row key={item.id} item={item} v={item.v} tab={tab} />)}
				</div>
			</div>
			{away ? <Button className="jump" small icon="down" onClick={() => ((stick.current = true), toEnd(), setAway(false))}>Latest</Button> : null}
			<div className="dock">
				<div className="dock-in">
					<StatusLine tab={tab} />
					{chat ? (
						<Composer tab={tab} />
					) : tab.busy ? (
						<div className="row"><span className="muted grow">This tab shows one task's work and takes no messages.</span><Button small icon="stop" onClick={() => void store.stop(tab)}>Stop this task</Button></div>
					) : null}
				</div>
			</div>
		</div>
	);
}
