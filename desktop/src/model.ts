// What the page knows: the tabs, what each conversation shows, and how the daemon's live events
// become that. Nothing here is the truth about pine; the daemon is. This is what was asked of it
// and what it reported since, kept so that it can be drawn.
//
// The models are plain objects that are changed in place and then say that they changed
// (`touch`). A conversation gets a hundred events a second while a model writes; copying its
// list for each would be the slowest thing the app does.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { type AgentInfo, type Api, apiFor, type Approval, type Conversation, type GoalInfo, media, type PineEvent, type Program, type Stats, type Task, type Todo, type TranscriptEntry, type WorktreeMade } from "./api.ts";
import { bridge, type EnvironmentView, type Prefs, type ServiceState, type Update } from "./bridge.ts";
import { baseName, childKind, errText, eventBody, isGoalRound, learnHome, MODES, oneLine, plural, short, type Speed, speedOf, speedText, taskSummary, tilde, took, undoLines } from "./text.ts";

/** The reasoning levels, each with what it means for the answer. */
export const REASONING_ABOUT: Record<string, string> = { off: "answers at once", minimal: "a moment of thought", low: "thinks briefly", medium: "thinks it through", high: "thinks long", xhigh: "thinks very long", max: "as long as the model can" };

export class Model {
	v = 0;
	private listeners = new Set<() => void>();
	subscribe = (fn: () => void) => {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	};
	version = () => this.v;
	touch(): void {
		this.v++;
		for (const fn of this.listeners) fn();
	}
}

/** Draw again whenever the model says it changed. */
export function useModel<T extends Model>(model: T): T {
	useSyncExternalStore(model.subscribe, model.version);
	return model;
}

let ids = 1;
const uid = () => ids++;

export type Tone = "muted" | "warn" | "bad" | "good" | "accent";

export type Part =
	| { p: "tool"; key: string; tool: string; subject?: string; status: "run" | "ok" | "fail"; ms?: number; preview?: string; depth: number }
	| { p: "thought"; text: string; done: boolean; ms?: number; speed?: string; startedAt: number }
	| { p: "words"; text: string }
	| { p: "child"; task: number; agent: string; kind: string; label: string; status: "run" | "done" | "failed" | "cancelled"; how?: string; depth: number };

interface Base {
	id: number;
	/** Counts up when the item changes, so that only what changed is drawn again. */
	v: number;
}

export type Item = Base &
	(
		| { t: "user"; text: string; from?: string; files?: string[]; /** The owner's message as a task, to branch from. */ task?: number }
		| { t: "answer"; task: number; agent: string; text: string; live: boolean }
		| { t: "work"; parts: Part[]; done: boolean; open: boolean; startedAt: number; ms?: number }
		| { t: "note"; tone: Tone; text: string; lines?: Array<{ text: string; tone?: Tone }>; action?: { label: string; run: () => void } }
		| { t: "event"; label: string; body: string }
		| { t: "approval"; req: Approval; state: "open" | "allowed" | "denied" | "gone"; by?: string; always?: boolean }
		| { t: "steps"; task: number; items: Todo[] }
		| { t: "media"; name: string; url: string; kind: "image" | "video" | "audio" }
		| { t: "goal"; goal: GoalInfo; full?: boolean }
		| { t: "divider"; text: string }
		| { t: "entry"; entry: TranscriptEntry }
	);

type Of<K extends Item["t"]> = Extract<Item, { t: K }>;

export interface Attachment {
	name: string;
	size: number;
	/** base64 */
	data: string;
	/** For a picture: an address of the page's own to show it by. */
	preview?: string;
}

export type CodeView = "agent" | "files" | "changes" | "turn" | "browser" | "output" | "running";

const MEDIA_KIND = (name: string): "image" | "video" | "audio" | undefined => (/\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : /\.(mp4|mov|webm|m4v)$/i.test(name) ? "video" : /\.(wav|mp3|m4a|ogg|flac|aiff?)$/i.test(name) ? "audio" : undefined);
export const mediaKind = MEDIA_KIND;

/** One tab: a conversation, the work of one task, or the event log. */
export class Tab extends Model {
	id = uid();
	kind: "chat" | "task" | "events" | "settings";
	/** The environment whose pine it shows: agents, sessions and task numbers are that pine's. */
	env: string;
	agent: string;
	session: string;
	/** For a tab on one task. */
	task?: number;
	baseDepth = 0;
	items: Item[] = [];
	loaded = false;

	roots = new Set<number>();
	running = new Set<number>();
	awaiting: string[] = [];
	answers = new Map<number, Of<"answer">>();
	streamed = new Set<number>();
	said?: { task: number; item: Of<"answer"> };
	work?: Of<"work">;
	tools = new Map<string, Extract<Part, { p: "tool" }>>();
	thoughts = new Map<number, Extract<Part, { p: "thought" }>>();
	lastThought?: { task: number; part: Extract<Part, { p: "thought" }> };
	children = new Map<number, { agent: string; kind: string; label: string; running: boolean }>();
	approvals = new Map<string, Of<"approval">>();
	steps?: Of<"steps">;

	unread = false;
	startedAt = 0;
	toolCalls = 0;
	tokens = { input: 0, output: 0, cached: 0 };
	thinking = false;
	context?: number;
	cacheShare?: number;
	speed?: Speed;
	lastAnswer?: string;
	goal?: GoalInfo;
	folder?: string;
	workspace?: string;
	/** The worktree it works in, if it has one: its branch and what it was made from. */
	worktree?: { branch: string; base: string };
	programs: Program[] = [];
	stopped?: { at: number; waiting: number; spared: Set<number> };
	pauseNoted = false;

	// the composer
	draft = "";
	attachments: Attachment[] = [];
	inputs: string[] = [];
	files = new Set<string>();

	// the event log
	log: PineEvent[] = [];
	logFilter = "";

	// the panel beside it
	codeTick = 0;

	constructor(kind: Tab["kind"], env: string, agent: string, session: string) {
		super();
		this.kind = kind;
		this.env = env;
		this.agent = agent;
		this.session = session;
	}

	/** The conversation as its pine names it: "agent:session". */
	get conv(): string {
		return `${this.agent}:${this.session}`;
	}

	get key(): string {
		return this.kind === "chat" ? `${this.env}|${this.agent}:${this.session}` : this.kind === "task" ? `${this.env}|task:${this.task}` : this.kind === "events" ? `events:${this.env}` : this.kind;
	}

	get busy(): boolean {
		return this.running.size > 0;
	}

	add<T extends Item["t"]>(item: Omit<Of<T>, "id" | "v"> & { t: T }): Of<T> {
		const made = { ...item, id: uid(), v: 0 } as unknown as Of<T>;
		this.items.push(made);
		return made;
	}

	note(text: string, tone: Tone = "muted", more: Partial<Of<"note">> = {}): Of<"note"> {
		return this.add({ t: "note", tone, text, ...more });
	}

	remove(item: Item): void {
		const at = this.items.indexOf(item);
		if (at >= 0) this.items.splice(at, 1);
	}

	clear(): void {
		this.items = [];
		for (const live of [this.roots, this.running, this.answers, this.streamed, this.tools, this.thoughts, this.children, this.approvals]) live.clear();
		this.awaiting = [];
		this.work = this.said = this.lastThought = this.steps = undefined;
		this.thinking = false;
	}
}

const STOP_GRACE = 3000;
const sessionName = () => `s${Date.now().toString(36)}`;
/** What a conversation is told when it moves into a worktree. */
const worktreeNote = (made: WorktreeMade) =>
	`This conversation now works in the worktree ${made.branch} at ${tilde(made.path)}${made.base ? `, made from ${made.base}` : ""}: a checkout of its own, so other conversations' files are not touched. What is not committed in the folder stayed there.${made.copied.length ? ` Copied from .worktreeinclude: ${made.copied.join(", ")}.` : ""} Merge it back from the folder's chip.`;
/** "env|agent", as a list to pick from has it, back into its two parts. */
const refOf = (value: string): AgentRef => {
	const at = value.indexOf("|");
	return { env: value.slice(0, at), agent: value.slice(at + 1) };
};

export type Picker = { title: string; items: Array<{ value: string; label: string; about?: string; tone?: Tone }>; current?: string; done: (value: string | undefined) => void; placeholder?: string; free?: boolean };

/**
 * One environment: a pine of its own (this computer's, or another machine's over SSH) and what
 * the page knows of it. Its agents, conversations and task numbers are its own: two environments
 * can each have a "main".
 */
export class Env {
	id: string;
	label: string;
	host?: string;
	/** On: connected and shown. */
	enabled: boolean;
	service: ServiceState;
	/** Its stream of events is up. */
	connected: boolean;
	api: Api;
	agents: AgentInfo[] = [];
	conversations = new Map<string, Conversation[]>();
	taints = new Map<string, string>();
	sessionModes = new Map<string, string>();
	bypassWhenTainted = false;
	pins = new Set<string>();
	/** Conversations in which an agent is at work right now, whether a tab shows them or not: "agent:session". */
	busy = new Map<string, Set<number>>();
	/** What was said lately, in every conversation: for finding one by its words, and for naming one that has no name of its own. */
	said: Task[] = [];
	titles = new Map<string, string>();
	saidAt = 0;
	saidLater?: number;
	/** Which of its conversations was in front last, as its pine keeps it with the tabs. */
	front = 0;

	constructor(v: EnvironmentView) {
		this.id = v.id;
		this.label = v.label;
		this.host = v.host;
		this.enabled = v.enabled;
		this.service = v.state;
		this.connected = v.connected;
		this.api = apiFor(v.id);
	}

	get ready(): boolean {
		return this.service.status === "ready";
	}

	agent(id: string): AgentInfo | undefined {
		return this.agents.find((a) => a.id === id);
	}
}

/** Something of an agent's in an environment: which pine, which agent. */
export type AgentRef = { env: string; agent: string };

/** The app as a whole. */
export class Store extends Model {
	prefs: Prefs = { keepRunning: false, environments: [], theme: "system", notify: true, updates: true };
	/** This computer and the machines added over SSH, in the order of the settings. */
	envs: Env[] = [];
	platform = "darwin";
	focused = true;
	fullscreen = false;
	versions = { app: "", electron: "" };
	/** Whether this app asks for a newer one at all: an app from a checkout is no release and does not. */
	updates = false;
	/** What GitHub said about a newer app, once it said something. */
	update?: Update;
	/** The dialog that says there is a newer app, after the owner asked. */
	updateAsk = false;
	updateLooking = false;
	/** The pine home the app was told to use, when it is not the usual one. */
	home?: string;

	tabs: Tab[] = [];
	active?: Tab;

	/** The page the settings tab shows, the agent whose page is open there, and the environment whose pine they are. */
	section = "general";
	settingsAgent?: string;
	settingsEnv = "local";
	/** A conversation that is to open with something looked for in it. */
	pendingFind?: { key: string; query: string };
	/** Agents whose list of conversations is folded away in the side bar. */
	folded = new Set<string>(JSON.parse(localStorage.getItem("pine.folded") ?? "[]"));
	/** Whether the side bar shows. Kept like its width, so that it is after a restart as it was left. */
	sidebar = localStorage.getItem("pine.sidebar") !== "hidden";
	code = false;
	codeView: CodeView = "agent";
	palette = false;
	picker?: Picker;
	/** The approval or question whose dialog is open: "env|id" (each pine numbers its own). */
	asking?: string;
	asked = new Set<string>();
	initLines: string[] = [];
	initRunning = false;
	/** Whether the browser build this pine drives is on this computer; nothing while it is not known. */
	browser?: boolean;
	/** The question at the start, when it is not: fetch it now, or later. */
	browserAsk = false;
	browserFetching = false;
	/** Something a menu asked for that only a part of the page can do (save the file in the editor, focus the input). */
	signal = new Model();
	/** The name of what was asked for last. Read with `useSignal`, which several parts can do for the same asking. */
	lastSignal = "";
	/** The language dictation listens for, when it is not the system's. */
	voiceLanguage?: string;

	/** Environments whose tabs of last time are being opened again: nothing is saved meanwhile. */
	private restoring = new Set<string>();
	private started = false;

	// ---- start -----------------------------------------------------------------------------------

	async boot(): Promise<void> {
		if (this.started) return;
		this.started = true;
		bridge.onService((env: string, s: ServiceState) => void this.onService(env, s));
		bridge.onEnvironments((list: EnvironmentView[]) => this.onEnvironments(list));
		bridge.onEvents((env: string, batch: PineEvent[]) => this.onEvents(env, batch));
		bridge.onConnection((id: string, up: boolean) => {
			const env = this.env(id);
			if (!env) return;
			const back = up && !env.connected;
			env.connected = up;
			if (back && env.agents.length) void this.dropAnswered(env);
			this.touch();
		});
		bridge.onMenu((command: string) => void this.command(command));
		bridge.onFocus((f: boolean) => {
			this.focused = f;
			if (f && this.active) this.seen(this.active);
			if (f) for (const env of this.shown) void this.refreshAgents(env);
		});
		bridge.onFullscreen((f: boolean) => ((this.fullscreen = f), this.touch()));
		bridge.onInitLine((line: string) => {
			this.initLines.push(line);
			if (this.initLines.length > 200) this.initLines.shift();
			this.touch();
		});
		const first = await bridge.state();
		this.prefs = first.prefs;
		this.platform = first.platform;
		this.fullscreen = first.fullscreen;
		this.focused = first.focused;
		this.versions = first.versions;
		this.updates = first.updates;
		void this.lookForUpdate();
		this.home = first.home;
		document.documentElement.dataset.platform = this.platform;
		this.onEnvironments(first.environments);
		bridge.ready();
		// What is asked of every pine now and then, whichever answered first.
		window.setInterval(() => void this.pollPrograms(), 3000);
		window.setInterval(() => this.shown.forEach((e) => void this.refreshTaints(e)), 20_000);
		window.setInterval(() => this.shown.forEach((e) => void this.refreshAgents(e)), 8000);
		window.setInterval(() => this.shown.forEach((e) => e.ready && void e.api.browserEmbedded().catch(() => {})), 30_000);
	}

	/**
	 * An address of the conversation's own (the port of a program it left running): opened in the
	 * browser beside the conversation, which the daemon starts for it where it is not up. Where the
	 * conversation has no browser at all, the address goes to the owner's own browser.
	 */
	async showInBrowser(tab: Tab, url: string): Promise<void> {
		const before = this.codeView;
		this.code = true;
		this.codeView = "browser";
		this.touch();
		const state = await this.apiOf(tab).browserOpen(tab.agent, tab.session, url).catch(() => undefined);
		if (state?.open) {
			if (state.error) this.flash(state.error, "warn", 6000);
			tab.codeTick++;
			this.saveTabs(tab.env);
			return this.touch();
		}
		this.codeView = before;
		this.flash("This conversation has no browser, so the address was opened in your own.", "muted", 6000);
		this.touch();
		void bridge.open(url);
	}

	/**
	 * Remove an agent, after asking how: with everything it has, or with its folder kept. The
	 * settings page and the side bar's menu both come here. Says whether it is gone.
	 */
	async removeAgent(env: string, id: string): Promise<boolean> {
		const e = this.env(env);
		if (!e) return false;
		const d = await this.attempt(() => e.api.agentDetail(id));
		if (!d) return false;
		if (d.main) return this.flash("The main agent administers pine and cannot be removed."), false;
		const how = await this.pick({
			title: `Remove the agent ${id}${this.on(env)}?`,
			items: [
				{ value: "erase", label: "Remove it with everything it has", about: `its ${plural(d.holdings.conversations.length, "conversation")}, sources, schedules, servers, skills and its folder. This cannot be undone`, tone: "bad" },
				{ value: "keep", label: "Remove it, but keep its folder", about: "the folder is moved to removed/ in pine's home" },
				{ value: "no", label: "Cancel" },
			],
		});
		if (how !== "erase" && how !== "keep") return false;
		const gone = await this.attempt(() => e.api.eraseAgent(id, how === "keep"));
		if (!gone) return false;
		if (gone.problem) this.flash(`${id} is taken out, but what is left of the configuration does not load: ${gone.problem}`, "bad", 12_000);
		else this.flash(`Removed the agent ${id}.${gone.kept ? ` Its folder is kept at ${tilde(gone.kept)}.` : ""}`, "good");
		e.agents = await this.askAgents(e).catch(() => e.agents);
		this.tabs = this.tabs.filter((t) => t.env !== env || t.agent !== id || t.kind === "events");
		if (this.active?.env === env && this.active.agent === id) this.active = this.tabs[0];
		const main = e.agents.find((a) => a.main) ?? e.agents[0];
		if (!this.tabs.length && main) await this.openTab(env, main.id, "main", false);
		e.conversations.delete(id);
		this.touch();
		return true;
	}

	/**
	 * Whether there is a newer app. At the start it is only noted (the side bar and Settings > App
	 * show it); when the owner asked (the menu, the settings), the answer is said too.
	 */
	async lookForUpdate(asked = false): Promise<void> {
		if (!this.updates) return asked ? this.flash("This Pine runs from a checkout and is no release: update the checkout.") : undefined;
		if (this.updateLooking) return;
		this.updateLooking = asked;
		this.touch();
		const said: Update | undefined = await bridge.update(asked).catch(() => undefined);
		this.updateLooking = false;
		if (said && said.status !== "unknown") this.update = said;
		this.touch();
		if (!asked) return;
		if (said?.status === "newer") this.updateAsk = true;
		else if (said?.status === "latest") this.flash(`Pine ${said.mine} is the latest version.`, "good");
		else this.flash("Could not ask GitHub for the latest version. You may be offline.", "warn", 6000);
		this.touch();
	}

	// ---- environments ------------------------------------------------------------------------------

	env(id: string): Env | undefined {
		return this.envs.find((e) => e.id === id);
	}

	/** The environments that are on: their agents are in the side bar. */
	get shown(): Env[] {
		return this.envs.filter((e) => e.enabled);
	}

	/** Words that say which environment, where more than one is shown: " on server". */
	on(env: string): string {
		const e = this.env(env);
		return e && this.shown.length > 1 ? ` on ${e.label}` : "";
	}

	/** Whether any pine answers with agents, so that there is something to show. */
	get ready(): boolean {
		return this.shown.some((e) => e.ready && e.agents.length > 0);
	}

	/** The list of environments changed (one was added, turned on or off, forgotten): each that is on is shown, with its own state. */
	private onEnvironments(list: EnvironmentView[]): void {
		const was = this.envs;
		this.envs = list.map((v) => {
			const e = was.find((x) => x.id === v.id) ?? new Env(v);
			e.label = v.label;
			e.host = v.host;
			e.enabled = v.enabled;
			return e;
		});
		for (const e of was) if (!this.envs.includes(e) || !e.enabled) this.dropEnv(e);
		this.prefs.environments = list.map((v) => ({ id: v.id, host: v.host, enabled: v.enabled }));
		if (!this.shown.some((e) => e.id === this.settingsEnv)) this.settingsEnv = this.shown[0]?.id ?? "local";
		this.touch();
		for (const v of list) if (v.enabled) void this.onService(v.id, v.state, v.connected);
	}

	/** An environment that was turned off: its tabs close, and nothing of it is kept. */
	private dropEnv(e: Env): void {
		e.agents = [];
		e.service = { status: "starting" };
		e.connected = false;
		const gone = this.tabs.filter((t) => t.env === e.id);
		if (!gone.length) return;
		this.tabs = this.tabs.filter((t) => t.env !== e.id);
		if (this.active && gone.includes(this.active)) {
			this.active = undefined;
			this.activate(this.tabs.find((t) => t.kind === "chat") ?? this.tabs[0]);
		}
		// Nothing of the others was open: the main conversation of the first that answers.
		const next = this.shown.find((x) => x.ready && x.agents.length);
		if (!this.tabs.some((t) => t.kind === "chat") && next) void this.openTab(next.id, (next.agents.find((a) => a.main) ?? next.agents[0]).id, "main", !this.active);
	}

	private async onService(id: string, s: ServiceState, connected?: boolean): Promise<void> {
		const env = this.env(id);
		if (!env?.enabled) return;
		const was = env.service;
		env.service = s;
		if (connected !== undefined) env.connected = connected;
		this.touch();
		if (s.status === "ready" && (was.status !== "ready" || !env.agents.length)) await this.load(env);
	}

	/** Everything that is asked once an environment's pine answers: the agents, the tabs of last time, what waits for an answer. */
	private async load(env: Env): Promise<void> {
		try {
			env.agents = await this.askAgents(env);
		} catch (e) {
			return this.flash(`${env.label}: ${errText(e)}`, "bad");
		}
		for (const a of env.agents) learnHome(a.workspace);
		// The browser of the web tools is this computer's: only its own pine is asked about it.
		if (env.id === "local") void this.checkBrowser(true);
		// The app shows an agent's browser itself, in the panel: each daemon is told so while the app runs, and the browser opens no window.
		void env.api.browserEmbedded().catch(() => {});
		const first = env.agents.find((a) => a.main) ?? env.agents[0];
		if (!first) return this.flash(`The pine on ${env.label} has no agents.`, "bad");
		const saved = await env.api.tabs().catch(() => ({ tabs: [] as Array<{ agent: string; session: string }>, active: 0, code: false }));
		// A daemon that was started again: what its tabs showed is asked for anew. The tabs of the
		// other environments stay as they are.
		const front = this.active;
		const wasFront = front?.env === env.id && front.kind !== "settings";
		this.tabs = this.tabs.filter((t) => t.env !== env.id || t.kind === "settings");
		if (wasFront) this.active = undefined;
		const again = saved.tabs.filter((t) => env.agent(t.agent));
		env.front = Math.max(0, Math.min(saved.active ?? 0, again.length - 1));
		this.restoring.add(env.id);
		try {
			// The first pine to answer fills the window; one that answers later adds its tabs beside.
			const firstHere = !this.tabs.some((t) => t.kind === "chat");
			if (!again.length && firstHere) await this.openTab(env.id, first.id, "main");
			for (const t of again) await this.openTab(env.id, t.agent, t.session, false);
			const chats = this.tabsOf(env.id).filter((t) => t.kind === "chat");
			if (!this.active || wasFront) this.activate(chats[again.length ? env.front : 0] ?? this.tabs[0]);
			if (firstHere) this.code = saved.code === true;
		} finally {
			this.restoring.delete(env.id);
		}
		this.saveTabs(env.id);
		void this.refreshTaints(env);
		void this.refreshConversations(env);
		void this.refreshSaid(env, true);
		void this.pending(env);
		this.touch();
	}

	/** The tabs that show something of an environment's pine. */
	tabsOf(env: string): Tab[] {
		return this.tabs.filter((t) => t.env === env && t.kind !== "settings");
	}

	/** An environment's agents, the main one first: it is the one that administers the others. */
	async askAgents(env: Env): Promise<AgentInfo[]> {
		const list = await env.api.agents();
		return [...list].sort((a, b) => Number(b.main) - Number(a.main));
	}

	/**
	 * Ask which agents there are now. Another hand can make, change or remove one at any time: the
	 * main agent when it is asked to, a `pine agent` command, the terminal UI. The daemon does not
	 * announce it, so it is asked: now and then, when the window comes to the front, and whenever
	 * something happened that may have been it.
	 */
	async refreshAgents(env: Env | undefined): Promise<void> {
		if (!env?.ready || !env.enabled) return;
		const list = await this.askAgents(env).catch(() => undefined);
		if (!list) return;
		const was = env.agents.map((a) => `${a.id}|${a.description}|${a.model}|${a.mode}|${a.thinking}|${a.modelProblem ?? ""}`).join("\n");
		const now = list.map((a) => `${a.id}|${a.description}|${a.model}|${a.mode}|${a.thinking}|${a.modelProblem ?? ""}`).join("\n");
		if (was === now) return;
		const fresh = list.filter((a) => !env.agent(a.id)).map((a) => a.id);
		const gone = env.agents.filter((a) => !list.some((x) => x.id === a.id)).map((a) => a.id);
		env.agents = list;
		for (const a of list) learnHome(a.workspace);
		// An agent that is gone has no conversations to show.
		for (const id of gone) {
			env.conversations.delete(id);
			for (const t of this.tabsOf(env.id).filter((x) => x.agent === id && (x.kind === "chat" || x.kind === "task"))) if (this.tabs.length > 1) this.closeTab(t);
		}
		this.touch();
		for (const id of fresh) void this.refreshConversations(env, id);
	}

	/**
	 * Ask for what was said lately (the last thousand tasks, which is what the daemon hands out
	 * at once). Not more often than every few seconds: it is asked after each answer.
	 */
	async refreshSaid(env: Env | undefined, force = false): Promise<void> {
		if (!env?.ready) return;
		const wait = 4000 - (Date.now() - env.saidAt);
		if (!force && wait > 0) {
			// Asked for too soon: it is done once, when the time is up, so that the last answer is not missed.
			env.saidLater ??= window.setTimeout(() => ((env.saidLater = undefined), void this.refreshSaid(env, true)), wait);
			return;
		}
		env.saidAt = Date.now();
		const list = await env.api.tasks(undefined, 1000).catch(() => undefined);
		if (!list) return;
		env.said = list.filter((t) => t.depth === 0 && !t.session.startsWith("_t") && !t.meta?.compact);
		// A conversation is called by the first thing the owner said in it.
		const titles = new Map<string, string>();
		for (let i = env.said.length - 1; i >= 0; i--) {
			const t = env.said[i];
			const key = `${t.agent}:${t.session.replace(/~u$/, "")}`;
			if (!titles.has(key) && t.kind === "prompt" && t.prompt.trim()) titles.set(key, short(oneLine(t.prompt), 48));
		}
		env.titles = titles;
		this.touch();
	}

	/**
	 * What a conversation is called. One the owner or an agent named keeps its name; one that was
	 * only started (its name is a stamp like "s1x2y3z") is called by how it began.
	 */
	titleOf(env: string, agent: string, session: string): string {
		if (session === "main") return "main conversation";
		// A branch of a conversation that has no name of its own is called after that one's title.
		const branch = /^(s[0-9a-z]{6,10})-branch(?:-(\d+))?$/.exec(session);
		if (branch) return `${this.titleOf(env, agent, branch[1])} · branch${branch[2] ? ` ${branch[2]}` : ""}`;
		if (!/^s[0-9a-z]{6,10}$/.test(session)) return session;
		return this.env(env)?.titles.get(`${agent}:${session}`) ?? "new conversation";
	}

	/** Conversations in which something was said that holds these words, the latest first, each with the place. */
	searchSaid(query: string): Array<{ env: string; agent: string; session: string; snippet: string; who: string; ts: number }> {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		const seen = new Set<string>();
		const out: Array<{ env: string; agent: string; session: string; snippet: string; who: string; ts: number }> = [];
		const around = (text: string, at: number) => `${at > 30 ? "…" : ""}${oneLine(text.slice(Math.max(0, at - 30), at + q.length + 60))}${text.length > at + q.length + 60 ? "…" : ""}`;
		for (const env of this.shown) {
			for (const t of env.said) {
				const session = t.session.replace(/~u$/, "");
				const key = `${env.id}|${t.agent}:${session}`;
				if (seen.has(key) || !env.agent(t.agent)) continue;
				const asked = t.prompt.toLowerCase().indexOf(q);
				const answered = asked < 0 ? (t.result ?? "").toLowerCase().indexOf(q) : -1;
				if (asked < 0 && answered < 0) continue;
				seen.add(key);
				out.push({ env: env.id, agent: t.agent, session, who: asked >= 0 ? (t.kind === "prompt" ? "you" : t.kind) : t.agent, snippet: asked >= 0 ? around(t.prompt, asked) : around(t.result ?? "", answered), ts: t.created });
			}
		}
		return out.sort((a, b) => b.ts - a.ts).slice(0, 30);
	}

	/** Open a conversation at what was looked for: the words are marked in it. */
	async openFound(env: string, agent: string, session: string, query: string): Promise<void> {
		this.pendingFind = { key: `${env}|${agent}:${session}`, query };
		await this.openTab(env, agent, session);
		this.ask_("find");
	}

	/** An agent's group in the side bar, as it is kept folded: by name on this computer (as it always was), with the environment elsewhere. */
	private foldKey(env: string, agent: string): string {
		return env === "local" ? agent : `${env}|${agent}`;
	}

	isFolded(env: string, agent: string): boolean {
		return this.folded.has(this.foldKey(env, agent));
	}

	toggleFold(env: string, agent: string): void {
		const key = this.foldKey(env, agent);
		if (this.folded.has(key)) this.folded.delete(key);
		else this.folded.add(key);
		localStorage.setItem("pine.folded", JSON.stringify([...this.folded]));
		this.touch();
	}

	/** Whether an agent is at work in a conversation, open in a tab or not. */
	isBusy(env: string, agent: string, session?: string): boolean {
		const busy = this.env(env)?.busy;
		if (!busy) return false;
		if (session !== undefined) return (busy.get(`${agent}:${session}`)?.size ?? 0) > 0;
		for (const [key, tasks] of busy) if (tasks.size && key.startsWith(`${agent}:`)) return true;
		return false;
	}


	/** The settings, at a page; with an environment, of that environment's pine. */
	openSettings(section?: string, agent?: string, env?: string): void {
		if (section) this.section = section;
		this.settingsAgent = agent;
		if (env) this.settingsEnv = env;
		let tab = this.tabs.find((t) => t.kind === "settings");
		if (!tab) {
			tab = new Tab("settings", "", "settings", "");
			tab.loaded = true;
			this.tabs.push(tab);
		}
		this.activate(tab);
	}

	/** Questions that were asked before this window was there. */
	private async pending(env: Env): Promise<void> {
		const list = await env.api.approvals().catch(() => [] as Approval[]);
		for (const req of list) {
			const tab = await this.approvalHome(env.id, req);
			if (!tab || tab.approvals.has(req.id)) continue;
			tab.approvals.set(req.id, tab.add({ t: "approval", req, state: "open" }));
			tab.touch();
		}
		this.askNext();
		this.badge();
	}

	/**
	 * The tab a request is shown in: the conversation it came from, else one of that agent's, else
	 * any of that pine's. Never a tab of another environment: the answer goes to the pine that asked.
	 */
	private homeOf(env: string, req: { agent: string; root?: number }): Tab | undefined {
		const tabs = this.tabsOf(env).filter((t) => t.kind === "chat");
		return this.tabFor(env, req) ?? tabs.find((t) => t.agent === req.agent) ?? tabs[0];
	}

	private async approvalHome(env: string, req: { agent: string; root?: number }): Promise<Tab | undefined> {
		const tab = this.homeOf(env, req);
		if (tab || !this.env(env)?.agent(req.agent)) return tab;
		await this.openTab(env, req.agent, "main", false);
		return this.homeOf(env, req);
	}

	// ---- small things ------------------------------------------------------------------------------

	/** A passing notice; the stock `Toaster` shows it. One that says something went wrong stays longer and is
	 * announced at once. An `ms` of Infinity keeps it until it is closed (Base UI's timeout 0). */
	flash(text: string, tone: Tone = "muted", ms = 4500): void {
		const type = { muted: undefined, accent: "info", good: "success", warn: "warning", bad: "error" }[tone];
		const timeout = tone === "bad" ? Math.max(ms, 7000) : ms;
		toast.add({ description: text, type, timeout: Number.isFinite(timeout) ? timeout : 0, priority: tone === "bad" ? "high" : "low" });
	}

	/** Run something the owner asked for; what goes wrong is said, not thrown away. */
	async attempt<T>(what: () => Promise<T>): Promise<T | undefined> {
		try {
			return await what();
		} catch (e) {
			this.flash(errText(e), "bad");
			return undefined;
		}
	}

	/**
	 * Ask whether the browser the web tools drive is there. A home that another pine set up, or a
	 * new app in place of an old one, has a browser on disk and not the build this pine needs:
	 * with `ask` that is put to the owner once for each version of pine, at the start.
	 */
	async checkBrowser(ask = false): Promise<void> {
		const local = this.env("local");
		if (!local?.enabled || !local.ready) return;
		const over = await local.api.overview().catch(() => undefined);
		if (!over) return;
		this.browser = over.browser;
		let later: string | null = null;
		try {
			later = localStorage.getItem("pine.browser.later");
		} catch {
			// No storage: it is asked again next time.
		}
		if (ask && over.browser === false && later !== over.version) this.browserAsk = true;
		if (over.browser !== false) this.browserAsk = this.browserFetching;
		this.touch();
	}

	/** Not now: it is not asked again until pine is another version. Settings > App still offers it. */
	async browserLater(): Promise<void> {
		this.browserAsk = false;
		this.touch();
		const over = await this.env("local")?.api.overview().catch(() => undefined);
		try {
			if (over) localStorage.setItem("pine.browser.later", over.version);
		} catch {
			// Then it is asked again next time.
		}
	}

	/** Fetch the browser build with the pine this app runs; what it prints is shown as it comes. */
	async fetchBrowser(): Promise<void> {
		if (this.browserFetching) return;
		this.browserFetching = true;
		this.initLines = [];
		this.touch();
		const code = await bridge.browserInstall().catch(() => 1);
		this.browserFetching = false;
		await this.checkBrowser();
		if (this.browser) this.flash("The browser of the web tools is on this Mac now.", "good");
		else this.flash(code === 0 ? "The browser is still not there. What was said is shown in Settings > App." : "The browser could not be fetched. What was said is shown in Settings > App; try again when you are online.", "bad", 8000);
		this.touch();
	}

	/**
	 * Choose the model of every agent that has none of its own (`defaults.model`), from `among` or
	 * from all that can be used now. Offered where a model was just made available, and where an
	 * agent's model cannot answer.
	 */
	async chooseDefaultModel(env: Env, among?: string[]): Promise<void> {
		const api = env.api;
		const models = among?.length ? among : await this.attempt(() => api.models());
		if (!models?.length) return this.flash("There is no model to choose yet: sign in to a provider or add a model server first.", "warn");
		const now = (await this.attempt(() => api.settings()))?.find((x) => x.key === "defaults.model")?.now;
		const model = await this.pick({ title: "Model for every agent that has none of its own", items: models.map((m) => ({ value: m, label: m })), current: now, placeholder: "Search models" });
		if (!model || model === now) return;
		if (!(await this.attempt(() => api.setSetting("defaults.model", model)))) return;
		await this.refreshAgents(env);
		this.flash(`Your agents now run on ${model}. An agent with a model of its own keeps it.`, "good", 6000);
	}

	pick(p: Omit<Picker, "done">): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.picker = {
				...p,
				done: (value) => {
					this.picker = undefined;
					this.touch();
					resolve(value);
				},
			};
			this.touch();
		});
	}

	agent(env: string, id: string): AgentInfo | undefined {
		return this.env(env)?.agent(id);
	}

	/** What a tab is about: its pine's api, its agent. */
	apiOf(t: { env: string }): Api {
		return apiFor(t.env);
	}

	taintOf(t: Tab): string | undefined {
		return this.env(t.env)?.taints.get(t.conv);
	}

	isTainted(t: Tab): boolean {
		return this.taintOf(t) !== undefined;
	}

	isPinned(t: Tab): boolean {
		return Boolean(this.env(t.env)?.pins.has(t.conv));
	}

	/** The mode a conversation really works in: bypass that outside content paused is not bypass. */
	modeOf(t: Tab): string {
		return this.agent(t.env, t.agent)?.mode ?? "auto";
	}

	bypassPaused(t: Tab): boolean {
		const env = this.env(t.env);
		return this.modeOf(t) === "bypass" && this.isTainted(t) && !env?.bypassWhenTainted && env?.sessionModes.get(t.conv) !== "bypass";
	}

	private seen(tab: Tab): void {
		if (tab.unread) {
			tab.unread = false;
			this.touch();
			this.badge();
		}
	}

	/** How many tabs want the owner: shown on the app's icon. */
	private badge(): void {
		void bridge.badge(this.tabs.filter((t) => t.approvals.size > 0).length);
	}

	/**
	 * Call for the owner while they look at something else. The words are pine's own: nothing an
	 * agent or a web page wrote goes into a notification.
	 */
	private attention(title: string, body: string, tab: Tab): void {
		if (this.focused && this.active === tab) return;
		if (!this.focused) void bridge.notify(title, body, tab.key);
	}

	// ---- tabs --------------------------------------------------------------------------------------

	activate(tab: Tab | undefined): void {
		if (!tab) return;
		this.active = tab;
		tab.unread = false;
		if (tab.kind === "chat") this.saveTabs(tab.env);
		this.touch();
		this.badge();
		if (tab.kind === "chat") void this.pollPrograms();
		this.askNext();
	}

	/**
	 * Each pine keeps the tabs of its own conversations (the terminal UI reads the same list), and
	 * which of them was in front. A tab of another environment in front leaves that as it was.
	 */
	private saveTabs(env: string): void {
		const e = this.env(env);
		if (this.restoring.has(env) || !e?.ready) return;
		const chats = this.tabsOf(env).filter((t) => t.kind === "chat");
		const at = chats.indexOf(this.active!);
		if (at >= 0) e.front = at;
		void e.api.saveTabs(chats.map((t) => ({ agent: t.agent, session: t.session })), Math.min(e.front, Math.max(0, chats.length - 1)), this.code).catch(() => {});
	}

	async openTab(env: string, agent: string, session: string, front = true): Promise<void> {
		const e = this.env(env);
		if (!e?.enabled) return this.flash("That environment is off. Turn it on in Settings > Environments.", "bad");
		const existing = this.tabs.find((t) => t.kind === "chat" && t.env === env && t.agent === agent && t.session === session);
		if (existing) return front ? this.activate(existing) : undefined;
		if (!e.agent(agent)) e.agents = await this.askAgents(e).catch(() => e.agents);
		if (!e.agent(agent)) return this.flash(`There is no agent called ${agent}${this.on(env)}.`, "bad");
		const tab = new Tab("chat", env, agent, session);
		this.tabs.push(tab);
		if (front) this.activate(tab);
		else {
			tab.unread = !this.restoring.has(env);
			this.saveTabs(env);
			this.touch();
		}
		await this.fill(tab);
		void this.refreshConversations(e, agent);
	}

	/** Ask for what a conversation holds and show it: the folder, the goal, the last messages, the open steps. */
	private async fill(tab: Tab): Promise<void> {
		const { agent, session } = tab;
		const api = this.apiOf(tab);
		const [folder, goal, tree] = await Promise.all([api.folder(agent, session).catch(() => undefined), api.goal(agent, session).catch(() => undefined), api.worktree(agent, session).catch(() => undefined)]);
		tab.folder = folder?.folder;
		tab.worktree = tree?.worktree ? { branch: tree.worktree.branch, base: tree.worktree.base } : undefined;
		tab.workspace = folder?.workspace;
		learnHome(folder?.workspace);
		tab.goal = goal?.goal;
		try {
			const history = (await api.history(agent, session)).filter((t) => t.depth === 0).reverse();
			for (const t of history) this.past(tab, t);
			this.takeStats(tab, history.at(-1)?.meta?.stats);
			// What is still at work goes on live from here.
			for (const t of history) {
				if (t.status === "running" || t.status === "pending") {
					tab.roots.add(t.id);
					if (t.status === "running") tab.running.add(t.id);
				} else tab.roots.add(t.id);
			}
			if (tab.running.size) tab.startedAt = history.find((t) => t.status === "running")?.started ?? Date.now();
			const steps = await api.todos(agent, session).catch(() => [] as Todo[]);
			if (steps.some((t) => t.status !== "done")) this.showSteps(tab, -1, steps);
			if (tab.goal) tab.add({ t: "goal", goal: tab.goal, full: true });
		} catch (e) {
			tab.note(`Could not load the conversation: ${errText(e)}`, "bad");
		}
		tab.loaded = true;
		tab.touch();
	}

	private past(tab: Tab, t: Task): void {
		if (t.meta?.compact) return void tab.note(t.status === "done" ? (t.result ?? "The earlier part of the conversation was summarised.") : `Shortening the conversation: ${t.status}${t.error ? ` (${t.error})` : ""}`);
		if (t.kind === "event" && t.meta?.label) tab.add({ t: "event", label: t.meta.label, body: eventBody(t.prompt) });
		else if (isGoalRound(t.kind, t.meta?.label)) tab.note(`↻ ${t.meta.label}`);
		else tab.add({ t: "user", text: t.prompt, from: t.kind === "prompt" ? undefined : t.kind, task: t.kind === "prompt" && t.meta?.trust === "owner" && t.meta?.steered === undefined ? t.id : undefined });
		(t.meta?.images ?? []).forEach((_, i) => tab.add({ t: "media", kind: "image", name: `attached picture ${i + 1}`, url: media.task(tab.env, t.id, i) }));
		// It was read by work that was already running; the answer is that work's.
		if (t.meta?.steered !== undefined) return;
		if (t.status === "done") {
			if (t.result) tab.lastAnswer = t.result;
			tab.add({ t: "answer", task: t.id, agent: t.agent, text: t.result || "(no answer)", live: false });
		} else if (t.status === "failed" || t.status === "cancelled") tab.note(t.status === "cancelled" ? "Stopped" : `Failed${t.error ? `: ${t.error}` : ""}`, t.status === "cancelled" ? "muted" : "bad");
	}

	/** A tab on one task, typically a sub-agent: what it was given, thought and wrote, and every tool call. */
	async openTask(env: string, id: number): Promise<void> {
		const existing = this.tabs.find((t) => t.kind === "task" && t.env === env && t.task === id);
		if (existing) return this.activate(existing);
		const data = await this.attempt(() => apiFor(env).transcript(id));
		if (!data) return;
		const { task, entries } = data;
		const tab = new Tab("task", env, task.agent, task.session);
		tab.task = id;
		tab.baseDepth = task.depth;
		tab.roots.add(id);
		this.tabs.push(tab);
		const who = task.kind === "subagent" ? `sub-agent of ${task.agent}` : task.kind === "delegate" ? `${task.agent}, on a task from ${task.meta.chain?.at(-1) ?? "another agent"}` : task.agent;
		const live = task.status === "running" || task.status === "pending";
		tab.note(`${who} · task #${id}${task.parent !== undefined ? ` · started by task #${task.parent}` : ""} · ${task.status}`, "muted", { lines: [{ text: "This tab shows the work and takes no messages." }] });
		if (entries.length) for (const entry of entries) tab.add({ t: "entry", entry });
		else {
			tab.add({ t: "user", text: task.prompt, from: "task" });
			if (task.result) tab.add({ t: "answer", task: id, agent: task.agent, text: task.result, live: false });
		}
		if (live) {
			tab.running.add(id);
			tab.startedAt = task.started ?? Date.now();
		} else tab.add({ t: "divider", text: taskSummary(task.status, task.meta.stats, task.error) });
		tab.loaded = true;
		this.activate(tab);
	}

	/** The event log of an environment's pine: the one in front, else the first that is on. */
	async openEvents(env = this.envInFront()): Promise<void> {
		if (!env) return;
		let tab = this.tabs.find((t) => t.kind === "events" && t.env === env);
		if (!tab) {
			tab = new Tab("events", env, "events", "");
			tab.loaded = true;
			this.tabs.push(tab);
			tab.log = (await apiFor(env).events(undefined, 300).catch(() => [] as PineEvent[])).reverse().filter((e) => !/\/(delta|thinking|message)$/.test(e.topic));
			// The log comes newest first from the daemon; here the newest is at the bottom.
			if (tab.log.length > 1 && tab.log[0].id > tab.log[tab.log.length - 1].id) tab.log.reverse();
		}
		this.activate(tab);
	}

	closeTab(tab: Tab): void {
		const i = this.tabs.indexOf(tab);
		if (i < 0) return;
		if (this.tabs.length === 1) return this.flash("The last tab stays open.");
		this.tabs.splice(i, 1);
		// What a conversation was subscribed to on its own ends when its tab closes (not for an agent's main one).
		if (tab.kind === "chat" && tab.session !== "main") {
			void this.apiOf(tab)
				.closeSession(tab.agent, tab.session)
				.then((r) => r.unsubscribed.length && this.flash(`Closed ${tab.agent} · ${tab.session}: its ${plural(r.unsubscribed.length, "subscription")} to ${r.unsubscribed.join(", ")} ended with it.`, "muted", 6000))
				.catch(() => {});
		}
		if (this.active === tab) this.activate(this.tabs[Math.max(0, i - 1)]);
		else this.touch();
		if (tab.kind === "chat") this.saveTabs(tab.env);
		void this.refreshConversations(this.env(tab.env), tab.agent);
	}

	moveTab(from: number, to: number): void {
		if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return;
		const [tab] = this.tabs.splice(from, 1);
		this.tabs.splice(to, 0, tab);
		if (tab.kind === "chat") this.saveTabs(tab.env);
		this.touch();
	}

	cycle(by: number): void {
		if (this.tabs.length < 2 || !this.active) return;
		this.activate(this.tabs[(this.tabs.indexOf(this.active) + by + this.tabs.length) % this.tabs.length]);
	}

	/** The environment something new is meant for when nobody said: the one of the tab in front, else the first that is on. */
	envInFront(): string | undefined {
		const t = this.active;
		if (t && t.kind !== "settings" && this.env(t.env)?.ready) return t.env;
		return this.shown.find((e) => e.ready)?.id;
	}

	/** The agent something new is meant for when nobody said: the one of the tab in front, if that tab is an agent's. */
	agentInFront(): AgentRef | undefined {
		const t = this.active;
		return t && (t.kind === "chat" || t.kind === "task") && this.agent(t.env, t.agent) ? { env: t.env, agent: t.agent } : undefined;
	}

	/** Every agent of every environment that is on, for a list to pick from: "env|agent" and how it is shown. */
	agentChoices(only?: (e: Env) => boolean): Array<{ value: string; label: string; about?: string }> {
		const several = this.shown.length > 1;
		return this.shown.filter((e) => e.ready && (!only || only(e))).flatMap((e) => e.agents.map((x) => ({ value: `${e.id}|${x.id}`, label: several ? `${x.id} · ${e.label}` : x.id, about: x.description || x.model })));
	}

	/** Which agent: the one that was named, the only one there is, or the one the owner picks from the list. */
	async whichAgent(title: string, named?: AgentRef, only?: (e: Env) => boolean): Promise<AgentRef | undefined> {
		if (named) return named;
		const items = this.agentChoices(only);
		if (items.length <= 1) return items[0] ? refOf(items[0].value) : undefined;
		const front = this.agentInFront();
		const picked = await this.pick({ title, items, current: front ? `${front.env}|${front.agent}` : undefined });
		return picked ? refOf(picked) : undefined;
	}

	/** A new conversation: with the agent that is named, else with the one in front, else the owner is asked with whom. */
	async newConversation(named?: AgentRef): Promise<void> {
		const who = named ?? this.agentInFront() ?? (await this.whichAgent("New conversation with"));
		if (who) await this.openTab(who.env, who.agent, sessionName());
	}

	/**
	 * A conversation that works in a folder of the owner's: the one that already does, or a new one
	 * named after it. A folder of this computer (dropped on the app, from the Finder) is only
	 * there for this computer's pine.
	 */
	async openFolder(dir: string, named?: AgentRef, only?: (e: Env) => boolean, worktree = false): Promise<void> {
		const who = await this.whichAgent(`Which agent works in ${worktree ? "a worktree of " : ""}${baseName(dir)}?`, named, only);
		if (!who) return;
		const { env, agent } = who;
		const api = apiFor(env);
		const used = await api.folders(agent).catch(() => [] as Array<{ session: string; folder: string }>);
		const have = used.find((u) => u.folder === dir);
		// In a worktree it is always a new conversation: one of its own, beside the others in that folder.
		if (have && !worktree) return this.openTab(env, agent, have.session);
		const taken = new Set(["main", ...used.map((u) => u.session), ...(await api.sessions(agent).catch(() => [] as Conversation[])).map((x) => x.session)]);
		const base = (baseName(dir).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "folder").slice(0, 24);
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
		const done = await this.attempt(() => api.setFolder(agent, name, dir));
		if (!done) return;
		const made = worktree ? await this.attempt(() => api.makeWorktree(agent, name)) : undefined;
		await this.openTab(env, agent, name);
		if (made && this.active?.kind === "chat") this.active.note(worktreeNote(made));
	}

	/** A new conversation in a worktree: of the folder of the conversation in front, or of one the owner picks. */
	async newInWorktree(): Promise<void> {
		const front = this.active?.kind === "chat" ? this.active : undefined;
		if (front?.folder && !front.worktree) return this.openFolder(front.folder, { env: front.env, agent: front.agent }, undefined, true);
		// Whose first: a folder is of the machine that agent's pine runs on.
		const who = await this.whichAgent("A new conversation in a worktree with");
		const dir = who ? await this.chooseFolder(who.env, `A new conversation in a worktree of which repository${this.on(who.env)}?`) : undefined;
		if (dir) await this.openFolder(dir, who, undefined, true);
	}

	/** What a conversation's tabs and the side bar show of its folder and worktree, as the daemon says now. */
	private async followWorktree(env: string, agent: string, session: string): Promise<void> {
		const api = apiFor(env);
		const [folder, tree] = await Promise.all([api.folder(agent, session).catch(() => undefined), api.worktree(agent, session).catch(() => undefined)]);
		const worktree = tree?.worktree ? { branch: tree.worktree.branch, base: tree.worktree.base } : undefined;
		for (const t of this.tabs) if (t.kind === "chat" && t.env === env && t.agent === agent && t.session === session) ((t.folder = folder?.folder), (t.worktree = worktree), t.codeTick++, t.touch());
		await this.refreshConversations(this.env(env), agent);
	}

	/** Move a conversation into a worktree of its folder's repository. */
	async makeWorktree(tab: Tab, name?: string): Promise<void> {
		if (tab.kind !== "chat") return;
		if (!tab.folder) return this.flash("This conversation has no folder to make a worktree of. Open one for it first.", "bad");
		const made = await this.attempt(() => this.apiOf(tab).makeWorktree(tab.agent, tab.session, name));
		if (!made) return;
		await this.followWorktree(tab.env, tab.agent, tab.session);
		tab.note(worktreeNote(made));
	}

	/** What can be done with a conversation's worktree: merge it, bring its base in, discard it; or make one. */
	async worktreeMenu(tab: Tab): Promise<void> {
		if (tab.kind !== "chat") return;
		const api = this.apiOf(tab);
		const w = (await this.attempt(() => api.worktree(tab.agent, tab.session)))?.worktree;
		if (w === undefined) return;
		if (!w) {
			const make = await this.pick({ title: "Work in a worktree?", items: [{ value: "make", label: "Make a worktree of this folder", about: "A checkout of its own of the repository, on a branch pine/<name>: other conversations' files are not touched, and you merge it back when it is done." }, { value: "no", label: "Cancel" }] });
			return make === "make" ? this.makeWorktree(tab) : undefined;
		}
		const stand = `${plural(w.ahead, "commit")} ahead of ${w.base}${w.behind ? `, ${w.behind} behind` : ""}${w.dirty ? `, ${plural(w.dirty, "file")} not committed` : ""}`;
		const items: Array<{ value: string; label: string; about?: string; tone?: "bad" }> = [];
		if (w.mergeable && w.ahead) items.push({ value: "merge", label: `Merge into ${w.base}`, about: stand }, { value: "squash", label: `Squash into ${w.base}`, about: "All of it as one commit" });
		if (w.behind) items.push({ value: "update", label: `Update from ${w.base}`, about: `Bring the ${plural(w.behind, "new commit")} of ${w.base} into the worktree` });
		if (w.dirty) items.push({ value: "commit", label: "Ask the agent to commit", about: "A merge takes what is committed" });
		items.push({ value: "discard", label: "Discard the worktree…", about: w.merged && !w.dirty ? "Everything of it is merged" : "Its changes and its branch are deleted", tone: w.merged && !w.dirty ? undefined : "bad" });
		items.push({ value: "keep", label: "Discard, keep the branch", about: `The folder goes, ${w.branch} stays for git` });
		const chosen = await this.pick({ title: `${w.branch} · ${stand}`, items });
		if (!chosen) return;
		if (chosen === "merge" || chosen === "squash") {
			const r = await this.attempt(() => api.mergeWorktree(tab.agent, tab.session, chosen));
			if (r) this.flash(`${plural(r.commits, "commit")} of ${w.branch} ${r.how === "squash" ? "squashed into" : "merged into"} ${w.base}${r.how === "ff" ? " (a fast-forward)" : ""}.`, "good");
		} else if (chosen === "update") {
			const r = await this.attempt(() => api.updateWorktree(tab.agent, tab.session));
			if (r) this.flash("conflicts" in r ? `${w.base} and the worktree both changed ${r.conflicts.join(", ")}; nothing was changed. Ask the agent to merge ${w.base} and settle it.` : `The worktree has the ${plural(r.merged, "new commit")} of ${w.base} now.`, "conflicts" in r ? "bad" : "good");
		} else if (chosen === "commit") {
			await this.submit(tab, "Commit what you changed in this worktree that is meant to stay, with a message that says what it does.", "queue");
		} else {
			if (chosen === "discard" && !(w.merged && !w.dirty)) {
				const sure = await this.pick({ title: `Delete ${w.branch} and what is in it?`, items: [{ value: "yes", label: "Delete it", about: `${plural(w.ahead, "commit")} not merged${w.dirty ? `, ${plural(w.dirty, "changed file")}` : ""}. This cannot be undone.`, tone: "bad" }, { value: "no", label: "Cancel" }] });
				if (sure !== "yes") return;
			}
			const r = await this.attempt(() => api.discardWorktree(tab.agent, tab.session, chosen === "keep"));
			if (r) tab.note(`The worktree is gone${chosen === "keep" ? `; its branch ${w.branch} stays` : ""}. This conversation works in ${r.folder ? tilde(r.folder) : "its agent's workspace"} again.`);
		}
		await this.followWorktree(tab.env, tab.agent, tab.session);
	}

	async refreshConversations(env: Env | undefined, agent?: string): Promise<void> {
		if (!env?.ready) return;
		const ids = agent ? [agent] : env.agents.map((a) => a.id);
		await Promise.all(
			ids.map(async (id) => {
				const list = await env.api.sessions(id).catch(() => undefined);
				if (!list) return;
				env.conversations.set(id, list);
				for (const key of [...env.pins]) if (key.startsWith(`${id}:`)) env.pins.delete(key);
				for (const c of list) if (c.pinned) env.pins.add(`${id}:${c.session}`);
			}),
		);
		this.touch();
	}

	async refreshTaints(env: Env | undefined): Promise<void> {
		if (!env?.ready) return;
		try {
			const s = await env.api.status();
			env.taints.clear();
			env.sessionModes.clear();
			env.bypassWhenTainted = s.bypassWhenTainted === true;
			// What is at work right now, as the daemon has it: events only tell what happened since this window opened.
			for (const [key, tasks] of env.busy) if (!s.running.some((r) => `${r.agent}:${r.session}` === key && tasks.has(r.task))) env.busy.delete(key);
			for (const r of s.running) {
				if (r.kind === "subagent" || r.kind === "delegate" && String(r.session).startsWith("_t")) continue;
				const key = `${r.agent}:${r.session}`;
				if (!env.busy.has(key)) env.busy.set(key, new Set());
				env.busy.get(key)!.add(r.task);
			}
			const tabs = this.tabsOf(env.id);
			for (const x of s.sessions) {
				const open = tabs.find((t) => t.kind === "chat" && t.agent === x.agent && t.session === x.session);
				if (open && x.context?.percent !== undefined) open.context = x.context.percent;
				if (x.tainted) env.taints.set(`${x.agent}:${x.session}`, x.tainted);
				env.sessionModes.set(`${x.agent}:${x.session}`, x.mode);
			}
			for (const [id, mode] of Object.entries(s.modes ?? {})) {
				const info = env.agent(id);
				if (info) info.mode = mode;
			}
			// Bypass that stopped applying must not go unnoticed.
			for (const t of tabs) {
				if (t.kind !== "chat" || t.pauseNoted || !this.bypassPaused(t)) continue;
				t.pauseNoted = true;
				t.note(`Bypass is paused in this conversation: it has read outside content (${this.taintOf(t)}).`, "warn", { lines: [{ text: "The agent asks again before a critical action and before it sends something out. Choosing bypass again offers a clean conversation or bypass here anyway; a reset starts over." }] });
				t.touch();
			}
			this.touch();
		} catch {
			// the bar keeps what it showed
		}
	}

	private async pollPrograms(): Promise<void> {
		const t = this.active;
		if (!t || t.kind !== "chat" || !this.env(t.env)?.ready) return;
		const list = await this.apiOf(t).programs(t.agent, t.session).catch(() => undefined);
		if (!list) return;
		const changed = list.length !== t.programs.length || list.some((p, i) => p.id !== t.programs[i]?.id);
		t.programs = list;
		if (changed || list.length) t.touch();
	}

	// ---- what the owner does in a conversation -----------------------------------------------------

	async submit(tab: Tab, raw: string, whenBusy: "steer" | "queue" = "steer"): Promise<void> {
		const text = raw.trim();
		if (!text || tab.kind !== "chat") return;
		tab.inputs.push(text);
		const files = tab.attachments.splice(0);
		tab.draft = "";
		const mine = tab.add({ t: "user", text, files: files.map((f) => f.name) });
		for (const f of files) if (f.preview) tab.add({ t: "media", kind: "image", name: f.name, url: f.preview });
		tab.awaiting.push(text);
		tab.touch();
		try {
			const busy = tab.busy;
			const mentions = [...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]).filter((m) => tab.files.has(m.split("#")[0]));
			const { task, steered } = await this.apiOf(tab).prompt(tab.agent, text, tab.session, files.length ? files.map((f) => ({ name: f.name, data: f.data })) : undefined, whenBusy, mentions.length ? mentions : undefined);
			tab.roots.add(task);
			if (steered === undefined) (mine.task = task), mine.v++;
			if (steered !== undefined) {
				tab.awaiting = tab.awaiting.filter((p) => p !== text);
				this.flash("Given to the agent while it works. ⌥↩ makes a message wait its turn instead.", "muted", 3000);
			} else if (busy) this.flash("It waits its turn: it is answered when the work that is running is done.", "muted", 3000);
		} catch (e) {
			tab.awaiting = tab.awaiting.filter((p) => p !== text);
			tab.attachments.unshift(...files);
			tab.remove(mine);
			tab.draft = text;
			tab.note(`Not sent: ${errText(e)}`, "bad");
			tab.touch();
		}
		void this.refreshConversations(this.env(tab.env), tab.agent);
	}

	/**
	 * Stop what is running. A message typed while the agent worked starts the moment that work
	 * stops: a second stop, pressed because nothing seemed to happen, would stop that message too.
	 * So for a few seconds after a stop, the next one leaves alone a message that was waiting.
	 */
	async stop(tab: Tab): Promise<void> {
		if (!tab.busy) return;
		const recent = tab.stopped && Date.now() - tab.stopped.at < STOP_GRACE ? tab.stopped : undefined;
		const ids = [...tab.running].filter((id) => !recent?.spared.has(id));
		if (!ids.length) return this.flash("Stopped. This is your next message being answered; stop again in a moment to stop it too.");
		tab.stopped = { at: Date.now(), waiting: tab.awaiting.length, spared: recent?.spared ?? new Set() };
		for (const id of ids) await this.apiOf(tab).cancel(id).catch(() => {});
	}

	async undo(tab: Tab, redo: boolean): Promise<void> {
		if (tab.kind !== "chat") return;
		const r = await this.attempt(() => (redo ? this.apiOf(tab).redo(tab.agent, tab.session) : this.apiOf(tab).undo(tab.agent, tab.session)));
		if (!r) return;
		tab.clear();
		const history = (await this.apiOf(tab).history(tab.agent, tab.session).catch(() => [] as Task[])).filter((t) => t.depth === 0).reverse();
		for (const t of history) (this.past(tab, t), tab.roots.add(t.id));
		const said = undoLines(r, redo);
		tab.note(`${redo ? "↷" : "↶"} ${said.head}`, "accent", { lines: said.lines });
		if (!redo) tab.draft = r.prompt;
		tab.codeTick++;
		tab.touch();
		void this.refreshTaints(this.env(tab.env));
	}

	/** Go on in a new conversation from message `at` of this one, or from all of it; this one stays as it is. */
	async branch(env: string, agent: string, session: string, at?: number, worktree = false): Promise<void> {
		const r = await this.attempt(() => apiFor(env).branch(agent, session, at, worktree));
		if (!r) return;
		await this.openTab(env, agent, r.session);
		if (r.worktree && this.active?.kind === "chat") this.active.note(worktreeNote(r.worktree));
		this.flash(`A branch of ${this.titleOf(env, agent, session)}${at !== undefined ? " from that message" : ""}: what you say here stays here.${r.outside ? " It holds outside content, as that conversation did." : ""}`, "muted", 5000);
		void this.refreshConversations(this.env(env), agent);
		void this.refreshTaints(this.env(env));
	}

	async reset(tab: Tab): Promise<void> {
		if (tab.kind !== "chat") return;
		const ok = await this.pick({ title: `Start the conversation ${tab.session} of ${tab.agent} over?`, items: [{ value: "yes", label: "Forget it and start fresh", about: "What was said is gone; what it may do without asking, its goal and what it listens to on its own go with it.", tone: "bad" }, { value: "no", label: "Cancel" }] });
		if (ok !== "yes") return;
		if (!(await this.attempt(() => this.apiOf(tab).reset(tab.agent, tab.session)))) return;
		this.freshen(tab);
	}

	private freshen(t: Tab): void {
		t.clear();
		t.context = t.cacheShare = t.goal = undefined;
		this.env(t.env)?.taints.delete(t.conv);
		t.note("Fresh conversation");
		t.touch();
		this.touch();
	}

	async setFolder(tab: Tab, folder: string | null): Promise<void> {
		if (tab.kind !== "chat") return;
		const r = await this.attempt(() => this.apiOf(tab).setFolder(tab.agent, tab.session, folder));
		if (!r) return;
		for (const t of this.tabsOf(tab.env)) if (t.kind === "chat" && t.agent === tab.agent && t.session === tab.session) ((t.folder = r.folder), t.codeTick++);
		tab.note(r.folder ? `This conversation now works in ${tilde(r.folder)}: ${tab.agent}'s tools start there and may read and change what is in it, from your next message on.` : `This conversation works in ${tab.agent}'s own workspace again; the folder is closed to it from your next message on.`);
		tab.touch();
		this.touch();
	}

	/** The machine of an environment's pine, when it is another one reached over SSH. */
	remoteOf(env: string): string | undefined {
		const e = this.env(env);
		return e?.host ? e.label : undefined;
	}

	/**
	 * A folder for an environment's pine to work in. Folders are that machine's: on another one
	 * there is no Finder to choose from, so its path is typed.
	 */
	async chooseFolder(env: string, title: string): Promise<string | undefined> {
		const remote = this.remoteOf(env);
		if (!remote) return bridge.pickFolder(title);
		const dir = await this.pick({ title: `${title} (on ${remote})`, items: [], free: true, placeholder: `A folder of ${remote}, such as /home/you/project` });
		return dir?.trim() || undefined;
	}

	async pickFolder(tab: Tab): Promise<void> {
		if (tab.kind !== "chat") return;
		const used = await this.apiOf(tab).folders(tab.agent).catch(() => [] as Array<{ session: string; folder: string }>);
		const items = [{ value: "none", label: "No folder", about: `${tab.agent}'s own workspace` }, ...(tab.folder ? [{ value: tab.folder, label: tilde(tab.folder), about: "this conversation's folder" }] : [])];
		for (const u of used) if (!items.some((i) => i.value === u.folder) && items.length < 9) items.push({ value: u.folder, label: tilde(u.folder), about: `also open in ${u.session}` });
		items.push({ value: "pick", label: "Choose a folder…", about: "any folder of yours" });
		const chosen = await this.pick({ title: `Folder for ${tab.agent} · ${tab.session}`, items, current: tab.folder ?? "none" });
		if (!chosen || chosen === (tab.folder ?? "none")) return;
		if (chosen !== "pick") return this.setFolder(tab, chosen === "none" ? null : chosen);
		const picked = await this.chooseFolder(tab.env, `Folder for ${tab.agent} · ${tab.session}`);
		if (picked) await this.setFolder(tab, picked);
	}

	async pickModel(tab: Tab): Promise<void> {
		const info = this.agent(tab.env, tab.agent);
		const models = await this.attempt(() => this.apiOf(tab).models());
		if (!info || !models) return;
		const model = await this.pick({ title: `Model for ${tab.agent}`, items: models.map((m) => ({ value: m, label: m })), current: info.model, placeholder: "Search models" });
		if (!model || model === info.model) return;
		if (!(await this.attempt(() => this.apiOf(tab).setModel(tab.agent, model)))) return;
		info.model = model;
		tab.note(`${tab.agent} now uses ${model}. It is saved, and holds after a restart too.`);
		tab.touch();
		this.touch();
	}

	async pickReasoning(tab: Tab): Promise<void> {
		const info = this.agent(tab.env, tab.agent);
		if (!info) return;
		const level = await this.pick({ title: `Reasoning for ${tab.agent}`, items: Object.entries(REASONING_ABOUT).map(([value, a]) => ({ value, label: value, about: a })), current: info.thinking });
		if (level) await this.setReasoning(tab, level);
	}

	async setReasoning(tab: Tab, level: string): Promise<void> {
		const info = this.agent(tab.env, tab.agent);
		if (!info || level === info.thinking) return;
		if (!(await this.attempt(() => this.apiOf(tab).setThinking(tab.agent, level)))) return;
		info.thinking = level;
		tab.note(`${tab.agent} now reasons at "${level}". A model that cannot reason ignores it.`);
		tab.touch();
		this.touch();
	}

	async pickMode(tab: Tab): Promise<void> {
		const mode = await this.pick({ title: `Mode for ${tab.agent}`, items: MODES.map((m) => ({ value: m.value, label: m.label, about: m.about, tone: m.value === "bypass" ? "bad" : undefined })), current: this.modeOf(tab) });
		if (mode) await this.setMode(tab, mode);
	}

	async setMode(t: Tab, mode: string): Promise<void> {
		const info = this.agent(t.env, t.agent);
		if (!info) return;
		let anyway: string | undefined;
		await this.refreshTaints(this.env(t.env));
		const bypassWhenTainted = this.env(t.env)?.bypassWhenTainted;
		if (mode === "bypass" && this.isTainted(t) && !bypassWhenTainted) {
			// Bypass normally stops applying once a conversation has read outside content. Make that a choice, not a surprise.
			const choice = await this.pick({
				title: "This conversation has read outside content",
				items: [
					{ value: "new", label: "Bypass in a new, clean conversation", about: "recommended" },
					{ value: "anyway", label: "Bypass here anyway", about: "what it read could steer an agent with your whole account", tone: "bad" },
					{ value: "cancel", label: "Cancel" },
				],
			});
			if (!choice || choice === "cancel") return;
			if (choice === "anyway") anyway = t.session;
			else {
				if (!(await this.attempt(() => this.apiOf(t).setMode(t.agent, mode)))) return;
				info.mode = "bypass";
				await this.openTab(t.env, t.agent, sessionName());
				this.active?.note(`${t.agent} is in bypass mode in this new conversation. Nothing waits for approval, and its shell and file tools reach your whole account and the network.`, "warn");
				return void this.active?.touch();
			}
		}
		if (!(await this.attempt(() => this.apiOf(t).setMode(t.agent, mode, anyway)))) return;
		info.mode = mode as AgentInfo["mode"];
		t.pauseNoted = false;
		const more: Record<string, string> = {
			bypass: "Nothing waits for approval now, and its shell and file tools reach your whole account and the network.",
			plan: "It looks, reads and asks, and changes nothing: ask for what you want, read its plan, then switch the mode back to have it carried out.",
			auto: "Its shell and file tools work without a sandbox: your whole account and the network. What is critical is still asked about.",
			safe: "Its shell and file tools work inside its sandbox: its own folders, and what you allow it.",
			manual: "Every command, edit and message waits for your go-ahead.",
		};
		t.note(`${t.agent} is now in ${mode} mode${mode === "bypass" || mode === "plan" ? " (until pine restarts)" : "; it is saved, and holds after a restart too"}.`, mode === "bypass" ? "warn" : "muted", { lines: [{ text: more[mode] ?? "" }] });
		t.touch();
		await this.refreshTaints(this.env(t.env));
	}

	async setGoal(tab: Tab, arg: string): Promise<void> {
		if (tab.kind !== "chat") return;
		const word = arg.trim().toLowerCase();
		if (!arg.trim()) {
			tab.goal = (await this.apiOf(tab).goal(tab.agent, tab.session).catch(() => undefined))?.goal;
			if (tab.goal) tab.add({ t: "goal", goal: tab.goal, full: true });
			else tab.note("This conversation has no goal. Set one, and the agent works until it is met.");
			return tab.touch();
		}
		if (word === "pause" || word === "resume" || word === "clear") {
			// What changes is drawn when the daemon reports it.
			const done = await this.attempt(() => this.apiOf(tab).setGoal(tab.agent, tab.session, { action: word }));
			if (word === "clear" && done && !done.cleared) this.flash("This conversation has no goal.");
			return;
		}
		// The first round is the objective itself, sent as a message of the owner's.
		const mine = tab.add({ t: "user", text: arg.trim() });
		tab.awaiting.push(arg.trim());
		tab.touch();
		try {
			await this.apiOf(tab).setGoal(tab.agent, tab.session, { objective: arg.trim() });
		} catch (e) {
			tab.awaiting = tab.awaiting.filter((x) => x !== arg.trim());
			tab.remove(mine);
			tab.note(`No goal set: ${errText(e)}`, "bad");
			tab.touch();
		}
	}

	async askGoal(tab: Tab): Promise<void> {
		const g = tab.goal;
		const items = g ? [...(g.status === "active" ? [{ value: "pause", label: "Pause", about: "no further rounds until you resume" }] : g.status !== "met" ? [{ value: "resume", label: "Resume", about: "go on with the goal" }] : [{ value: "resume", label: "Resume", about: "it was called met too early" }]), { value: "clear", label: "Clear", about: "take the goal off this conversation" }] : [];
		const answer = await this.pick({ title: g ? `Goal: ${short(oneLine(g.objective), 70)}` : "A goal for this conversation", items, free: true, placeholder: g ? "Or type a new objective and press ↩" : "What should be reached? The agent works until a judge says it is met" });
		if (answer) await this.setGoal(tab, answer);
	}

	async pin(tab: Tab, pinned: boolean): Promise<void> {
		if (tab.session === "main") return this.flash("An agent's main conversation always stays.");
		if (!(await this.attempt(() => this.apiOf(tab).pinSession(tab.agent, tab.session, pinned)))) return;
		const pins = this.env(tab.env)?.pins;
		if (pinned) pins?.add(tab.conv);
		else pins?.delete(tab.conv);
		this.touch();
		void this.refreshConversations(this.env(tab.env), tab.agent);
	}

	async rename(env: string, agent: string, session: string, to: string): Promise<void> {
		const done = await this.attempt(() => apiFor(env).renameSession(agent, session, to));
		if (!done) return;
		for (const t of this.tabsOf(env)) if (t.kind === "chat" && t.agent === agent && t.session === session) ((t.session = done.session), t.touch());
		this.saveTabs(env);
		void this.refreshConversations(this.env(env), agent);
		void this.refreshTaints(this.env(env));
	}

	async askRename(tab: Tab): Promise<void> {
		if (tab.kind !== "chat") return;
		if (tab.session === "main") return this.flash("An agent's main conversation keeps its name.");
		const to = await this.pick({ title: `Another name for ${tab.session}`, items: [], free: true, placeholder: "The new name" });
		if (to?.trim()) await this.rename(tab.env, tab.agent, tab.session, to.trim());
	}

	async removeConversation(env: string, agent: string, session: string): Promise<void> {
		const gone = await this.attempt(() => apiFor(env).removeSession(agent, session));
		if (!gone) return;
		this.dropTabs(env, agent, session);
		const with_ = [...(gone.sources.length ? [`its ${plural(gone.sources.length, "event source")} ${gone.sources.join(", ")}`] : gone.unsubscribed.length ? [`its ${plural(gone.unsubscribed.length, "subscription")} to ${gone.unsubscribed.join(", ")}`] : []), ...(gone.servers.length ? [`its ${plural(gone.servers.length, "MCP server")} ${gone.servers.join(", ")}`] : [])];
		this.flash(`Removed the conversation ${session} of ${agent}${this.on(env)}${with_.length ? `, with ${with_.join(" and ")}` : ""}.`, "muted", with_.length ? 7000 : 4000);
		void this.refreshConversations(this.env(env), agent);
	}

	/** A conversation is gone: a tab that showed it has nothing left to show. */
	private dropTabs(env: string, agent: string, session: string): void {
		const showing = this.tabsOf(env).filter((t) => t.kind === "chat" && t.agent === agent && t.session === session);
		if (!showing.length) return;
		this.tabs = this.tabs.filter((t) => !showing.includes(t));
		if (!this.tabs.length) void this.openTab(env, agent, "main");
		else if (this.active && showing.includes(this.active)) this.activate(this.tabs[0]);
		this.saveTabs(env);
		this.touch();
	}

	async copyAnswer(tab: Tab): Promise<void> {
		if (!tab.lastAnswer) return this.flash("There is no answer to copy yet.");
		await navigator.clipboard.writeText(tab.lastAnswer);
		this.flash("Copied the last answer, as the agent wrote it.");
	}

	/** The conversation as Markdown: what was said, and with `full` what the agent thought and called. */
	async markdownOf(tab: Tab, full: boolean): Promise<string> {
		const tasks = (await this.apiOf(tab).history(tab.agent, tab.session, 500)).filter((t) => t.depth === 0).reverse();
		const out = [`# ${tab.agent} · ${tab.session}`, "", `Exported from pine on ${new Date().toLocaleString("sv-SE")}.`];
		for (const t of tasks) {
			if (t.meta?.compact) {
				out.push("", "---", "", `*${t.result || "The earlier part of the conversation was summarised here."}*`);
				continue;
			}
			out.push("", t.kind === "prompt" ? (t.meta?.steered !== undefined ? "## You, while the agent worked" : "## You") : `## ${t.kind === "event" ? `Event${t.meta?.label ? `: ${t.meta.label}` : ""}` : `pine (${t.kind})`}`, "", t.prompt.trim());
			if (t.meta?.steered !== undefined) continue;
			if (full) {
				const steps = (await this.apiOf(tab).transcript(t.id).catch(() => undefined))?.entries ?? [];
				for (const s of steps) {
					if (s.kind === "thinking" && s.text?.trim()) out.push("", "<details><summary>Thinking</summary>", "", s.text.trim(), "", "</details>");
					else if (s.kind === "tool") out.push("", `- ${s.ok === false ? "✗" : "✓"} \`${s.tool}\`${s.subject ? ` ${oneLine(s.subject)}` : ""}${s.ok === false && s.result ? `: ${short(oneLine(s.result), 300)}` : ""}`);
				}
			}
			out.push("", `## ${t.agent}`, "", t.status === "done" ? t.result?.trim() || "(no answer)" : `*${t.status}${t.error && t.error !== t.status ? `: ${t.error}` : ""}*`);
		}
		return `${out.join("\n")}\n`;
	}

	async exportConversation(tab: Tab, full: boolean): Promise<void> {
		if (tab.kind !== "chat") return;
		const text = await this.attempt(() => this.markdownOf(tab, full));
		if (!text) return;
		const saved = await bridge.saveText(`pine-${tab.env === "local" ? "" : `${this.env(tab.env)?.label ?? tab.env}-`}${tab.agent}-${tab.session}-${new Date().toISOString().slice(0, 10)}.md`, text);
		if (saved) this.flash(`Saved to ${tilde(saved)}.`, "good");
	}

	// ---- approvals and questions -------------------------------------------------------------------

	/** Answer a request of an environment's pine: there, and nowhere else. */
	async decide(env: string, id: string, allow: boolean, always = false, values?: Record<string, string>): Promise<void> {
		const r = await this.attempt(() => apiFor(env).decide(id, allow, always, values));
		if (r && !r.decided) this.flash("That request was already answered.");
	}

	/** The request whose dialog is open, and the environment it came from. */
	get asked_(): { env: string; req: Approval } | undefined {
		if (!this.asking) return undefined;
		const at = this.asking.indexOf("|");
		const env = this.asking.slice(0, at);
		const id = this.asking.slice(at + 1);
		const req = this.tabsOf(env).map((t) => t.approvals.get(id)).find(Boolean)?.req;
		return req ? { env, req } : undefined;
	}

	closeAsking(): void {
		this.asking = undefined;
		this.touch();
		// After what closed this one has run to its end.
		window.setTimeout(() => this.askNext(), 0);
	}

	/**
	 * Several requests can be open side by side. Only one dialog fits, so each of the others gets
	 * its dialog when the one before it is gone. One that was put off is not asked again by itself.
	 */
	askNext(): void {
		if (this.asking || this.picker || !this.active) return;
		const env = this.active.env;
		const next = [...this.active.approvals.values()].find((a) => !this.asked.has(`${env}|${a.req.id}`));
		if (!next) return;
		this.ask(env, next.req.id);
	}

	ask(env: string, id: string): void {
		this.asking = `${env}|${id}`;
		this.asked.add(this.asking);
		this.touch();
	}

	/** Forget the questions an environment's daemon no longer has open: nobody can answer them any more. */
	private async dropAnswered(env: Env): Promise<void> {
		const pending = await env.api.approvals().catch(() => undefined);
		if (!pending) return;
		const open = new Set(pending.map((p) => p.id));
		for (const tab of this.tabsOf(env.id)) {
			for (const [id, item] of tab.approvals) {
				if (open.has(id)) continue;
				item.state = "gone";
				item.v++;
				tab.approvals.delete(id);
				this.asked.delete(`${env.id}|${id}`);
				if (this.asking === `${env.id}|${id}`) this.asking = undefined;
				tab.touch();
			}
		}
		this.touch();
		this.badge();
	}

	// ---- commands: what a menu, a key or the palette asks for --------------------------------------

	/** Ask the parts of the page for something only they can do. */
	ask_(name: string): void {
		this.lastSignal = name;
		this.signal.touch();
	}

	async command(name: string): Promise<void> {
		const tab = this.active;
		const chat = tab?.kind === "chat" ? tab : undefined;
		// A folder of this computer, dropped on the app's icon: only this computer's pine has it.
		if (name.startsWith("folder:")) return this.env("local")?.ready ? this.openFolder(name.slice(7), undefined, (e) => e.id === "local") : this.flash("A folder of this computer is for the pine on this computer, and that environment is off. Turn This Mac on in Settings > Environments, or open a folder of the other machine with ⌘O.", "bad", 8000);
		if (name.startsWith("focus:")) return this.activate(this.tabs.find((t) => t.key === name.slice(6)));
		if (name.startsWith("tab-")) return this.activate(this.tabs[Number(name.slice(4)) - 1]);
		if (name.startsWith("code-")) {
			this.code = true;
			this.codeView = name.slice(5) as CodeView;
			if (chat) this.saveTabs(chat.env);
			return this.touch();
		}
		if (name.startsWith("settings:")) return this.openSettings(name.slice(9));
		switch (name) {
			case "settings":
				// The same key opens the settings and puts them away again.
				return tab?.kind === "settings" ? this.closeTab(tab) : this.openSettings();
			case "palette":
				this.palette = !this.palette;
				if (this.palette) for (const e of this.shown) void this.refreshSaid(e);
				return this.touch();
			case "sidebar":
				this.sidebar = !this.sidebar;
				localStorage.setItem("pine.sidebar", this.sidebar ? "shown" : "hidden");
				return this.touch();
			case "code":
				this.code = !this.code;
				if (chat) this.saveTabs(chat.env);
				return this.touch();
			case "events":
				return this.openEvents();
			case "updates":
				return this.lookForUpdate(true);
			case "new":
				return this.newConversation();
			case "agent": {
				for (const e of this.shown) if (e.ready) e.agents = await this.askAgents(e).catch(() => e.agents);
				const id = await this.pick({ title: "New conversation with", items: this.agentChoices(), current: chat ? `${chat.env}|${chat.agent}` : undefined });
				return id ? this.newConversation(refOf(id)) : undefined;
			}
			case "new-worktree":
				return this.newInWorktree();
			case "open-folder": {
				// Whose first: a folder is of the machine that agent's pine runs on.
				const who = await this.whichAgent("Open a folder for a conversation with");
				const dir = who ? await this.chooseFolder(who.env, `A folder for a conversation with ${who.agent}${this.on(who.env)}`) : undefined;
				return dir ? this.openFolder(dir, who) : undefined;
			}
			case "close":
				return tab ? this.closeTab(tab) : undefined;
			case "next-tab":
				return this.cycle(1);
			case "prev-tab":
				return this.cycle(-1);
			case "save":
			case "attach":
			case "find":
			case "help":
			case "voice":
			case "focus-input":
				return this.ask_(name);
		}
		if (!chat) return name === "stop" && tab?.kind === "task" ? this.stop(tab) : undefined;
		switch (name) {
			case "stop":
				return this.stop(chat);
			case "undo":
				return this.undo(chat, false);
			case "branch":
				return this.branch(chat.env, chat.agent, chat.session);
			case "branch-worktree":
				return this.branch(chat.env, chat.agent, chat.session, undefined, true);
			case "worktree":
				return this.worktreeMenu(chat);
			case "redo":
				return this.undo(chat, true);
			case "compact":
				return void (await this.attempt(() => this.apiOf(chat).compact(chat.agent, chat.session)));
			case "reset":
				return this.reset(chat);
			case "model":
				return this.pickModel(chat);
			case "reasoning":
				return this.pickReasoning(chat);
			case "mode":
				return this.pickMode(chat);
			case "goal":
				return this.askGoal(chat);
			case "folder":
				return this.pickFolder(chat);
			case "pin":
				return this.pin(chat, !this.isPinned(chat));
			case "rename":
				return this.askRename(chat);
			case "copy":
				return this.copyAnswer(chat);
			case "export":
				return this.exportConversation(chat, false);
			case "export-full":
				return this.exportConversation(chat, true);
			case "clear":
				chat.items = [];
				return chat.touch();
		}
	}

	// ---- the daemon's live events ------------------------------------------------------------------

	/** The tab of a conversation whose work this is (`root`), in the environment it came from: task numbers are each pine's own. */
	private tabFor(env: string, p: any): Tab | undefined {
		return p?.root !== undefined ? this.tabs.find((t) => t.env === env && t.kind === "chat" && t.roots.has(p.root)) : undefined;
	}

	private dirty = new Set<Model>();

	onEvents(env: string, batch: PineEvent[]): void {
		const e = this.env(env);
		if (!e?.enabled) return;
		for (const ev of batch) {
			try {
				this.onEvent(e, ev);
			} catch (err) {
				console.error("event", ev.topic, err);
			}
		}
		for (const m of this.dirty) m.touch();
		this.dirty.clear();
	}

	private onEvent(env: Env, e: PineEvent): void {
		const p = (e.payload ?? {}) as any;
		const [ns, , kind] = e.topic.split("/");
		// Only this pine's tabs: the other environments have their own agents and numbers.
		const tabs = this.tabsOf(env.id);
		const log = tabs.find((t) => t.kind === "events");
		if (log && !/\/(delta|thinking|message)$/.test(e.topic)) {
			log.log.push(e);
			if (log.log.length > 1000) log.log.splice(0, log.log.length - 1000);
			this.dirty.add(log);
		}

		if (ns === "approval") {
			if (e.topic === "approval/requested") {
				const tab = this.homeOf(env.id, p);
				// No tab of that pine to show it in: one is opened for it.
				if (!tab) return void this.pending(env);
				if (tab.approvals.has(p.id)) return;
				this.endWork(tab);
				tab.approvals.set(p.id, tab.add({ t: "approval", req: p, state: "open" }));
				if (tab !== this.active) tab.unread = true;
				this.attention("Pine", p.tool === "question" ? `${tab.agent}${this.on(env.id)} has a question for you` : `${tab.agent}${this.on(env.id)} needs your approval`, tab);
				this.dirty.add(tab).add(this);
				this.badge();
				if (tab === this.active && !this.asking && !this.picker) this.ask(env.id, p.id);
			} else if (e.topic === "approval/decided") {
				for (const tab of tabs) {
					const item = tab.approvals.get(p.id);
					if (!item) continue;
					item.state = p.allow ? "allowed" : "denied";
					item.by = p.by;
					item.always = p.always === true;
					item.v++;
					tab.approvals.delete(p.id);
					this.dirty.add(tab);
				}
				this.asked.delete(`${env.id}|${p.id}`);
				if (this.asking === `${env.id}|${p.id}`) this.closeAsking();
				this.dirty.add(this);
				this.badge();
			}
			return;
		}
		if (e.topic === "pine/conversation") return void this.followed(env, p);
		if (ns !== "agent") return;
		if (kind === "goal") return this.goalEvent(env.id, p);

		// Which conversations are at work, also those no tab shows: the side bar says so beside each agent.
		if ((p.depth ?? 0) === 0 && typeof p.agent === "string" && typeof p.session === "string" && typeof p.task === "number") {
			const key = `${p.agent}:${p.session}`;
			if (kind === "started") {
				if (!env.busy.has(key)) env.busy.set(key, new Set());
				env.busy.get(key)!.add(p.task);
				this.dirty.add(this);
			} else if (kind === "done" || kind === "failed") {
				env.busy.get(key)?.delete(p.task);
				this.dirty.add(this);
				// What an agent just did may have been making, changing or removing an agent.
				void this.refreshAgents(env);
				void this.refreshSaid(env);
			}
		}

		// A tab on one task follows that task and whatever it starts itself.
		for (const t of tabs) {
			if (t.kind !== "task") continue;
			if (kind === "started" && p.parent !== undefined && t.roots.has(p.parent)) t.roots.add(p.task);
			if (t.roots.has(p.task)) this.live(t, kind, p, (p.depth ?? 0) - t.baseDepth);
		}

		if (kind === "steered") {
			// A message that went into running work: ours is on screen already, somebody else's is shown.
			const tab = tabs.find((t) => t.kind === "chat" && t.agent === p.agent && t.session === p.session);
			if (!tab || tab.roots.has(p.by)) return;
			tab.roots.add(p.by);
			const i = tab.awaiting.findIndex((x) => String(p.prompt ?? "").startsWith(x));
			if (i >= 0) tab.awaiting.splice(i, 1);
			else {
				this.endWork(tab);
				tab.add({ t: "user", text: String(p.prompt ?? ""), from: p.kind === "prompt" ? "elsewhere" : p.kind });
			}
			this.dirty.add(tab);
			return;
		}

		if (kind === "started" && p.depth === 0) {
			// A top-level task: ours (sent from a tab) or someone else's in a conversation a tab shows.
			const tab = this.tabFor(env.id, p) ?? tabs.find((t) => t.kind === "chat" && t.agent === p.agent && t.session === p.session);
			if (!tab) {
				// An event woke the agent in a conversation nobody is looking at: say so where that agent is on screen.
				const home = p.kind === "event" ? tabs.find((t) => t.kind === "chat" && t.agent === p.agent) : undefined;
				if (home) {
					home.note(`An event woke ${p.agent} in the conversation ${p.session}.`, "warn", { action: { label: "Open", run: () => void this.openTab(env.id, p.agent, String(p.session)) } });
					this.dirty.add(home);
				}
				void this.refreshConversations(env, p.agent);
				return;
			}
			const i = tab.awaiting.findIndex((x) => String(p.prompt ?? "").startsWith(x));
			if (i >= 0) {
				tab.awaiting.splice(i, 1);
				// It waited behind work that was just stopped: the next stop is not meant for it.
				if (tab.stopped && tab.stopped.waiting > 0 && Date.now() - tab.stopped.at < STOP_GRACE) {
					tab.stopped.waiting--;
					tab.stopped.spared.add(p.task);
				}
			} else if (p.compact) tab.note("Shortening the conversation: its earlier part becomes a summary…");
			else if (p.requeued) {
				if (tab.stopped && Date.now() - tab.stopped.at < STOP_GRACE) tab.stopped.spared.add(p.task);
			} else if (!tab.roots.has(p.task)) {
				if (p.kind === "event" && p.label) tab.add({ t: "event", label: String(p.label), body: eventBody(String(p.prompt ?? "")) });
				// A round of a goal was announced by the goal's own line; its text is the same every round.
				else if (!isGoalRound(p.kind, p.label)) tab.add({ t: "user", text: String(p.prompt ?? ""), from: p.kind === "prompt" ? "elsewhere" : p.kind });
				// What came with it and was not typed here: a photo sent on Telegram, a picture a camera saved.
				for (let n = 0; n < Number(p.images ?? 0); n++) tab.add({ t: "media", kind: "image", name: `picture ${n + 1}`, url: media.task(env.id, p.task, n) });
			}
			tab.roots.add(p.task);
			tab.running.add(p.task);
			if (tab.running.size === 1) {
				tab.startedAt = Date.now();
				tab.toolCalls = 0;
				tab.tokens = { input: 0, output: 0, cached: 0 };
			}
			this.dirty.add(tab).add(this);
			return;
		}
		const tab = this.tabFor(env.id, p);
		if (tab) this.live(tab, kind, p, p.depth ?? 0);
	}

	/**
	 * A conversation was changed by another hand than this window's: the main agent opened or
	 * closed a tab, renamed a conversation, removed or pinned one. The tabs follow. A tab that is
	 * opened this way never takes the place of the one the owner is in.
	 */
	private async followed(env: Env, p: any): Promise<void> {
		const agent = String(p.agent ?? "");
		const session = String(p.session ?? "");
		const showing = this.tabsOf(env.id).filter((t) => t.kind === "chat" && t.agent === agent && t.session === session);
		if (p.change === "open") {
			if (!showing.length) await this.openTab(env.id, agent, session || "main", false);
		} else if (p.change === "close") {
			for (const t of showing) if (this.tabs.length > 1) this.closeTab(t);
		} else if (p.change === "rename" && typeof p.to === "string") {
			for (const t of showing) ((t.session = p.to), t.touch());
			if (showing.length) this.saveTabs(env.id);
		} else if (p.change === "remove") this.dropTabs(env.id, agent, session);
		void this.refreshConversations(env, agent);
		this.touch();
	}

	private goalEvent(env: string, p: any): void {
		for (const tab of this.tabsOf(env)) {
			if (tab.kind !== "chat" || tab.agent !== p.agent || tab.session !== p.session) continue;
			tab.goal = p.event === "cleared" ? undefined : (p as GoalInfo);
			tab.add({ t: "goal", goal: p as GoalInfo });
			if (tab !== this.active) tab.unread = true;
			this.dirty.add(tab).add(this);
		}
	}

	/** The work of the turn that is going on: one block for as long as nothing else comes in between. */
	private workOf(tab: Tab): Of<"work"> {
		if (tab.work && tab.items.at(-1) === tab.work) return tab.work;
		this.endWork(tab);
		tab.work = tab.add({ t: "work", parts: [], done: false, open: false, startedAt: Date.now() });
		return tab.work;
	}

	private endWork(tab: Tab): void {
		if (tab.work) {
			tab.work.done = true;
			tab.work.ms = Date.now() - tab.work.startedAt;
			tab.work.v++;
		}
		tab.work = tab.said = undefined;
	}

	/** Something an agent did on the way to its answer joins the turn's work. */
	private did(tab: Tab, part: Part): void {
		const work = this.workOf(tab);
		work.parts.push(part);
		work.v++;
	}

	/** A task goes on working after it wrote something: those words were not its answer, and join the work. */
	private foldWords(tab: Tab, task: number): void {
		const said = tab.said;
		if (tab.kind !== "chat" || said?.task !== task) return;
		tab.said = undefined;
		// Only where nothing came after them.
		if (tab.items.at(-1) !== said.item) return;
		tab.items.pop();
		tab.answers.delete(task);
		this.did(tab, { p: "words", text: said.item.text });
	}

	private endAnswer(tab: Tab, task: number): void {
		const item = tab.answers.get(task);
		if (item) {
			item.live = false;
			item.v++;
		}
		tab.answers.delete(task);
	}

	private endThought(tab: Tab, task: number, ms?: number): void {
		const part = tab.thoughts.get(task);
		if (!part) return;
		part.done = true;
		part.ms = ms ?? Date.now() - part.startedAt;
		tab.lastThought = { task, part };
		tab.thoughts.delete(task);
		if (tab.work) tab.work.v++;
	}

	private showSteps(tab: Tab, task: number, items: Todo[]): void {
		if (!items.length) return void (tab.steps = undefined);
		if (tab.steps?.task === task && tab.items.includes(tab.steps)) {
			tab.steps.items = items;
			tab.steps.v++;
		} else {
			this.endWork(tab);
			tab.steps = tab.add({ t: "steps", task, items });
		}
	}

	private takeStats(tab: Tab, stats: Stats | undefined): void {
		if (!stats) return;
		if (stats.context?.percent !== undefined) tab.context = stats.context.percent;
		const total = stats.input + (stats.cached ?? 0);
		// Shown once the server has reported cached input at least once; a permanent "0%" would say something that is not known.
		if (total > 0 && (stats.cached || tab.cacheShare !== undefined)) tab.cacheShare = Math.round((100 * (stats.cached ?? 0)) / total);
		const speed = speedOf(stats.timing);
		if (speed.read || speed.write) tab.speed = speed;
	}

	/** One live event of a task in a tab. `depth` is counted from what the tab shows: 0 is its own task. */
	private live(tab: Tab, kind: string, p: any, depth: number): void {
		this.dirty.add(tab);
		switch (kind) {
			case "started":
				if (depth <= 0) {
					tab.running.add(p.task);
					tab.startedAt = Date.now();
					break;
				}
				tab.children.set(p.task, { agent: p.agent, kind: p.kind, label: short(oneLine(String(p.label ?? p.prompt ?? "")), 60), running: true });
				this.did(tab, { p: "child", task: p.task, agent: p.agent, kind: p.kind, label: short(oneLine(String(p.label ?? p.prompt ?? "")), 120), status: "run", depth });
				break;
			case "thinking": {
				if (p.phase === "end") {
					tab.thinking = false;
					this.endThought(tab, p.task, p.ms);
					break;
				}
				tab.thinking = true;
				if (depth > 0 || !p.text) break; // a child's thoughts stay with the child, like its prose
				let thought = tab.thoughts.get(p.task);
				if (!thought) {
					this.foldWords(tab, p.task);
					thought = { p: "thought", text: "", done: false, startedAt: Date.now() };
					tab.thoughts.set(p.task, thought);
					this.did(tab, thought);
				}
				thought.text += p.text;
				if (tab.work) tab.work.v++;
				break;
			}
			case "todos":
				this.showSteps(tab, p.task, Array.isArray(p.items) ? p.items : []);
				break;
			case "delta": {
				tab.thinking = false;
				this.endThought(tab, p.task);
				if (depth > 0) break; // a child's prose stays with the child; its answer reaches the parent as a tool result
				let item = tab.answers.get(p.task);
				if (!item) {
					item = tab.add({ t: "answer", task: p.task, agent: p.agent ?? tab.agent, text: "", live: true });
					tab.answers.set(p.task, item);
					tab.said = { task: p.task, item };
				}
				item.text += p.text;
				item.v++;
				break;
			}
			case "message": {
				this.endThought(tab, p.task);
				const item = tab.answers.get(p.task);
				if (item) {
					if (depth === 0) tab.lastAnswer = item.text;
					tab.streamed.add(p.task);
				}
				this.endAnswer(tab, p.task);
				if (depth === 0) {
					tab.tokens = { input: p.input ?? 0, output: p.output ?? 0, cached: p.cached ?? 0 };
					if (p.context?.percent !== undefined) tab.context = p.context.percent;
					if (p.speed && (p.speed.read || p.speed.write)) tab.speed = p.speed;
				}
				const ended = tab.lastThought;
				if (ended && ended.task === p.task) {
					if (depth === 0) ended.part.speed = speedText(p.speed);
					tab.lastThought = undefined;
					if (tab.work) tab.work.v++;
				}
				this.dirty.add(this);
				break;
			}
			case "tool": {
				tab.thinking = false;
				this.endThought(tab, p.task);
				this.endAnswer(tab, p.task);
				tab.streamed.delete(p.task);
				const key = `${p.task}:${p.call}`;
				if (p.phase === "start") {
					// The agent wants its owner to see the browser: it is in the panel beside the conversation.
					if (/(^|_)browser_show$/.test(String(p.tool)) && tab === this.active && depth === 0) {
						this.code = true;
						this.codeView = "browser";
						this.saveTabs(tab.env);
					}
					tab.toolCalls++;
					if (depth === 0) this.foldWords(tab, p.task);
					const part: Extract<Part, { p: "tool" }> = { p: "tool", key, tool: p.tool, subject: p.subject ? short(oneLine(String(p.subject)), 200) : undefined, status: "run", depth };
					tab.tools.set(key, part);
					this.did(tab, part);
				} else {
					let part = tab.tools.get(key);
					// A call that began before this tab was opened has no line of its own yet.
					if (!part) {
						part = { p: "tool", key, tool: p.tool, subject: p.subject ? short(oneLine(String(p.subject)), 200) : undefined, status: "run", depth };
						this.did(tab, part);
					}
					part.status = p.ok ? "ok" : "fail";
					part.ms = p.ms;
					if (!p.ok) part.preview = short(oneLine(String(p.preview ?? "")), 240);
					tab.tools.delete(key);
					if (tab.work) tab.work.v++;
					const images = (p.images ?? []) as string[];
					if (images.length) {
						// A picture a tool returned is for the owner: it stands where it happened, not folded away.
						this.endWork(tab);
						for (const id of images) tab.add({ t: "media", kind: "image", name: `from ${p.tool}`, url: media.tool(tab.env, id) });
					}
					tab.codeTick++;
				}
				break;
			}
			case "done":
			case "failed": {
				const item = tab.answers.get(p.task);
				this.endAnswer(tab, p.task);
				this.endThought(tab, p.task);
				if (depth > 0) {
					const child = tab.children.get(p.task);
					if (child) child.running = false;
					const n = p.stats?.tools?.length ?? 0;
					const what = childKind(p.kind ?? child?.kind ?? "task");
					const how = p.status === "done" ? `answered (${took(p.stats?.ms ?? 0)}${n ? `, ${plural(n, "tool call")}` : ""})` : `${p.status}${p.error ? `: ${p.error}` : ""}`;
					const part = tab.work?.parts.find((x) => x.p === "child" && x.task === p.task) as Extract<Part, { p: "child" }> | undefined;
					if (part) {
						part.status = p.status;
						part.how = how;
						tab.work!.v++;
					} else this.did(tab, { p: "child", task: p.task, agent: p.agent, kind: what, label: child?.label ?? "", status: p.status, how, depth });
					break;
				}
				tab.running.delete(p.task);
				tab.thinking = false;
				if (!tab.busy) this.endWork(tab);
				this.takeStats(tab, p.stats);
				if (tab === this.active) void this.pollPrograms();
				if (p.status !== "cancelled" && !tab.busy) this.attention("Pine", `${tab.agent}${this.on(tab.env)} ${p.status === "done" ? "is done" : "stopped with an error"}`, tab);
				if (p.status === "done") {
					// Streaming normally showed the answer already; this covers a missed stream.
					if (p.text) tab.lastAnswer = p.text;
					if (!item && !tab.streamed.has(p.task) && p.text) tab.add({ t: "answer", task: p.task, agent: p.agent ?? tab.agent, text: p.text, live: false });
				} else if (p.status === "cancelled") tab.note("Stopped");
				else tab.note(`${p.status === "failed" ? "Failed" : p.status}${p.error && p.error !== p.status ? `: ${p.error}` : ""}`, "bad");
				tab.streamed.delete(p.task);
				if (tab.kind === "task") tab.add({ t: "divider", text: taskSummary(p.status, p.stats) });
				else void this.refreshTaints(this.env(tab.env));
				tab.codeTick++;
				this.dirty.add(this);
				void this.refreshConversations(this.env(tab.env), tab.agent);
				break;
			}
		}
		if (tab !== this.active) {
			if (!tab.unread) this.dirty.add(this);
			tab.unread = true;
		}
	}
}

export const store = new Store();

/**
 * Do something when it is asked for by name (a menu item that only one part of the page can
 * carry out). Each part hears every asking once, whatever the others do with it; what was asked
 * before the part was there is not replayed.
 */
export function useSignal(name: string, run: () => void): void {
	const signal = useModel(store.signal);
	const seen = useRef(signal.v);
	const live = useRef(run);
	live.current = run;
	useEffect(() => {
		if (signal.v !== seen.current && store.lastSignal === name) live.current();
		seen.current = signal.v;
	}, [signal.v, name]);
}
