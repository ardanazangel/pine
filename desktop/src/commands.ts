// What can be asked for by name: in the palette, from a menu, or typed with a slash in front, as
// in the terminal UI. One list, so that the three never differ.
import { apiFor } from "./api.ts";
import { store, type Tab } from "./model.ts";
import { ago, errText, MODES, oneLine, plural, REASONING, short } from "./text.ts";

export interface Command {
	name: string;
	/** What the palette calls it. */
	title: string;
	about: string;
	hint?: string;
	keys?: string;
	/** Needs a conversation in front. */
	chat?: boolean;
	run(args: string, tab: Tab | undefined): void | Promise<void>;
}

const chat = (tab: Tab | undefined): Tab | undefined => (tab?.kind === "chat" ? tab : (store.flash("Switch to a conversation first."), undefined));
const menu = (name: string) => () => store.command(name);
/** The environment a command is for: the one of the tab in front. */
const envOf = (tab: Tab | undefined): string => (tab && tab.kind !== "settings" ? tab.env : (store.envInFront() ?? "local"));

export const COMMANDS: Command[] = [
	{ name: "new", title: "New conversation", about: "A new conversation with this agent, in a new tab", hint: "[name]", keys: "⌘T", run: (args, tab) => (args.trim() && tab?.kind === "chat" ? store.openTab(tab.env, tab.agent, args.trim()) : store.newConversation()) },
	{
		name: "agent", title: "New conversation with another agent", about: "Open a tab with another agent", hint: "<id> [session]", keys: "⇧⌘T",
		run: (args, tab) => {
			const [id, session] = args.trim().split(/\s+/);
			if (!id) return store.command("agent");
			// The environment in front first: another one may have an agent of the same name.
			const env = [envOf(tab), ...store.shown.map((e) => e.id)].find((e) => store.agent(e, id));
			if (!env) return store.flash(`There is no agent "${id}".`, "bad");
			return store.openTab(env, id, session || "main");
		},
	},
	{
		name: "sessions", title: "Open a conversation", about: "This agent's conversations", hint: "[name]", chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			if (args.trim()) return store.openTab(t.env, t.agent, args.trim());
			const list = await apiFor(t.env).sessions(t.agent).catch(() => []);
			const session = await store.pick({ title: `Conversations of ${t.agent}`, items: list.map((s) => ({ value: s.session, label: `${s.pinned || s.session === "main" ? "★ " : ""}${s.session}`, about: `${plural(s.tasks, "message")} · ${ago(s.last)}${s.folder ? ` · ${s.folder}` : ""}` })), current: t.session, placeholder: "Search conversations" });
			if (session) await store.openTab(t.env, t.agent, session);
		},
	},
	{ name: "close", title: "Close tab", about: "Close this tab; the conversation stays in the list", keys: "⌘W", run: menu("close") },
	{ name: "rename", title: "Rename conversation", about: "Another name for this conversation and its tab", hint: "<name>", chat: true, run: (args, tab) => (chat(tab) ? (args.trim() ? store.rename(tab!.env, tab!.agent, tab!.session, args.trim()) : store.askRename(tab!)) : undefined) },
	{ name: "pin", title: "Pin conversation", about: "Keep this conversation however long it is not used", chat: true, run: (_a, tab) => (chat(tab) ? store.pin(tab!, true) : undefined) },
	{ name: "unpin", title: "Unpin conversation", about: "Let this conversation go when it has not been used for a while", chat: true, run: (_a, tab) => (chat(tab) ? store.pin(tab!, false) : undefined) },
	{ name: "reset", title: "Start over", about: "Forget this conversation and start fresh", chat: true, run: menu("reset") },
	{ name: "undo", title: "Take back last message", about: "Its files are restored, the conversation forgets it, its text returns to the input", keys: "⇧⌘Z", chat: true, run: menu("undo") },
	{ name: "branch", title: "Branch conversation", about: "Go on in a new conversation that has all of this one; this one stays as it is. A message of yours branches from there. --worktree: the new one works in a worktree of its own", hint: "[--worktree]", chat: true, run: (args) => store.command(/(^|\s)(--worktree|-w)(\s|$)/.test(args) ? "branch-worktree" : "branch") },
	{ name: "worktree", title: "Worktree", about: "Work in a checkout of the folder's repository of its own, apart from other conversations; in one: merge it, update it or discard it", chat: true, run: menu("worktree") },
	{ name: "redo", title: "Bring back what was taken back", about: "Until you send a new message", keys: "⇧⌘Y", chat: true, run: menu("redo") },
	{ name: "compact", title: "Shorten the conversation", about: "Its earlier part becomes a summary, which frees the model's context", chat: true, run: menu("compact") },
	{
		name: "folder", title: "Folder of this conversation", about: "Open a folder of yours for it, or none", hint: "[path|none]", chat: true,
		run: (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const wanted = args.trim();
			return wanted ? store.setFolder(t, /^(none|off|-)$/i.test(wanted) ? null : wanted) : store.pickFolder(t);
		},
	},
	{
		name: "code", title: "Side panel", about: "The agent, its files, changes, tool output and what is running, beside the conversation", hint: "[agent|files|changes|turn|output|running|off]", keys: "⌥⌘B",
		run: (args) => {
			const word = args.trim().toLowerCase();
			if (!word) return store.command("code");
			if (word === "off") return void ((store.code = false), store.touch());
			if (!["agent", "changes", "turn", "files", "browser", "output", "running"].includes(word)) return store.flash("The panel shows: agent, files, changes, turn, browser, output, running.");
			return store.command(`code-${word}`);
		},
	},
	{ name: "goal", title: "Goal", about: "Keep the agent working until something is reached", hint: "[objective|pause|resume|clear]", chat: true, run: (args, tab) => (chat(tab) ? (args.trim() ? store.setGoal(tab!, args) : store.askGoal(tab!)) : undefined) },
	{ name: "stop", title: "Stop", about: "Stop what the agent is doing", keys: "⌘.", run: (_a, tab) => (tab?.busy ? store.stop(tab) : store.flash("Nothing is running.")) },
	{
		name: "model", title: "Model", about: "Show or switch this agent's model", hint: "[provider/id]", keys: "⇧⌘M", chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const wanted = args.trim();
			if (!wanted) return store.pickModel(t);
			const models = await apiFor(envOf(tab)).models().catch(() => [] as string[]);
			const hit = models.find((m) => m === wanted) ?? (models.filter((m) => m.includes(wanted)).length === 1 ? models.find((m) => m.includes(wanted)) : undefined);
			if (!hit) return store.flash(`No single model fits "${wanted}".`, "bad");
			if (await store.attempt(() => apiFor(t.env).setModel(t.agent, hit))) {
				const info = store.agent(t.env, t.agent);
				if (info) info.model = hit;
				t.note(`${t.agent} now uses ${hit}.`);
				t.touch();
				store.touch();
			}
		},
	},
	{
		name: "reasoning", title: "Reasoning", about: "How much this agent's model thinks before it answers", hint: `[${REASONING.join("|")}]`, chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const level = args.trim().toLowerCase();
			if (!level) return store.pickReasoning(t);
			if (!REASONING.includes(level)) return store.flash(`Reasoning is one of ${REASONING.join(", ")}.`, "bad");
			if (await store.attempt(() => apiFor(t.env).setThinking(t.agent, level))) {
				const info = store.agent(t.env, t.agent);
				if (info) info.thinking = level;
				store.touch();
			}
		},
	},
	{
		name: "mode", title: "Mode", about: "How much this agent may do without asking", hint: "[auto|safe|manual|bypass|plan]", keys: "⇧⌘P", chat: true,
		run: (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const mode = args.trim().toLowerCase();
			if (!mode) return store.pickMode(t);
			if (!MODES.some((m) => m.value === mode)) return store.flash("Modes: auto, safe, plan, manual, bypass.", "bad");
			return store.setMode(t, mode);
		},
	},
	{
		name: "voice", title: "Dictate the message", about: "Say the message instead of typing it; the words are recognised on this Mac", hint: "[language, for example de-DE]", keys: "⌃R", chat: true,
		run: (args) => {
			if (args.trim()) store.voiceLanguage = args.trim();
			return store.command("voice");
		},
	},
	{ name: "attach", title: "Attach files", about: "Attach files to your next message", keys: "⇧⌘A", chat: true, run: menu("attach") },
	{ name: "detach", title: "Remove attached files", about: "Remove the files attached to the next message", hint: "[n]", chat: true, run: (args, tab) => {
		if (!tab) return;
		const n = Number(args.trim());
		if (n >= 1) tab.attachments.splice(n - 1, 1);
		else tab.attachments = [];
		tab.touch();
	} },
	{
		name: "status", title: "Status", about: "Running tasks and live sessions",
		run: async (_a, tab) => {
			const s = await store.attempt(() => apiFor(envOf(tab)).status());
			if (!s || !tab) return;
			tab.note(`${plural(s.running.length, "task")} running, ${plural(s.sessions.length, "live session")}, ${plural(s.approvals, "open question")}`, "muted", {
				lines: [...s.running.map((r) => ({ text: `#${r.task} ${r.agent}/${r.session} (${r.kind})` })), ...s.sessions.map((x) => ({ text: `${x.agent}/${x.session} · ${x.busy ? "busy" : "idle"} · ${x.mode}${x.tainted ? ` · outside content: ${x.tainted}` : ""}` }))],
			});
			tab.touch();
		},
	},
	{ name: "sources", title: "Event sources", about: "What can wake an agent, whether it runs, who is subscribed", run: menu("settings:events") },
	{
		name: "subscribe", title: "Subscribe to an event source", about: "Wake on a source's events: this conversation (local), the agent, or all agents (global)", hint: "[local|agent|global] <source> [what to do]", chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const words = args.trim().split(/\s+/).filter(Boolean);
			const scope = ["local", "agent", "global"].includes(words[0]) ? words.shift()! : "local";
			const source = words.shift();
			if (!source) return store.command("settings:events");
			const note = words.join(" ") || undefined;
			try {
				if (scope === "global") await apiFor(envOf(tab)).subscribeAll(source, { note });
				else await apiFor(t.env).subscribe(t.agent, source, { note, session: scope === "agent" ? "main" : t.session });
				t.note(scope === "global" ? `All agents are subscribed to ${source}.` : `${scope === "agent" || t.session === "main" ? `${t.agent} is` : "This conversation is"} subscribed to ${source}${scope === "local" && t.session !== "main" ? "; the subscription ends when this tab is closed" : ""}.`);
			} catch (e) {
				t.note(`Not subscribed: ${errText(e)}`, "bad");
			}
			t.touch();
		},
	},
	{
		name: "unsubscribe", title: "End a subscription", about: "End a subscription of this conversation, the agent, or all agents", hint: "[local|agent|global] <source>", chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const words = args.trim().split(/\s+/).filter(Boolean);
			const scope = ["local", "agent", "global"].includes(words[0]) ? words.shift()! : "local";
			const source = words.shift();
			if (!source) return store.flash("Name the source: /unsubscribe [local|agent|global] <source>");
			try {
				const done = scope === "global" ? (await apiFor(envOf(tab)).unsubscribeAll(source)).unsubscribed : (await apiFor(t.env).unsubscribe(t.agent, source, scope === "agent" ? "main" : t.session)).unsubscribed;
				t.note(done ? `No longer subscribed to ${source}.` : `There was no such subscription to ${source}.`);
			} catch (e) {
				t.note(`Not changed: ${errText(e)}`, "bad");
			}
			t.touch();
		},
	},
	{ name: "mcp", title: "MCP servers", about: "List them, add one, or sign in to one", run: menu("settings:mcp") },
	{ name: "events", title: "Event log", about: "Watch everything that happens, live", keys: "⇧⌘L", run: menu("events") },
	{
		name: "tasks", title: "Recent tasks", about: "Recent tasks of this agent", chat: true,
		run: async (_a, tab) => {
			const t = chat(tab);
			if (!t) return;
			const list = await store.attempt(() => apiFor(t.env).tasks(t.agent, 15));
			if (!list) return;
			const id = await store.pick({ title: `Recent tasks of ${t.agent}`, items: list.map((x) => ({ value: String(x.id), label: `#${x.id} ${x.status}`, about: `${x.kind} · ${x.session} · ${short(oneLine(x.meta?.label ?? x.prompt), 80)}` })), placeholder: "Search tasks" });
			if (id) await store.openTask(t.env, Number(id));
		},
	},
	{ name: "task", title: "Show one task", about: "What one task did, step by step (a sub-agent, for example)", hint: "<id>", run: (args, tab) => (Number(args) > 0 ? store.openTask(envOf(tab), Number(args)) : store.flash("Give the task's number: /task 12")) },
	{
		name: "approve", title: "Allow what waits", about: "Allow the action that waits for approval", hint: "[id] [always]",
		run: async (args, tab) => answer(args, true, tab),
	},
	{ name: "deny", title: "Refuse what waits", about: "Refuse the action that waits for approval", hint: "[id]", run: async (args, tab) => answer(args, false, tab) },
	{
		name: "state", title: "Shared state", about: "The small facts agents and routes share", hint: "[key pattern]",
		run: async (args, tab) => {
			const list = await store.attempt(() => apiFor(envOf(tab)).state(args.trim() || "#"));
			if (!list || !tab) return;
			tab.note(list.length ? `Shared state (${list.length})` : "No shared state matches.", "muted", { lines: list.slice(0, 60).map((s) => ({ text: `${s.key} = ${short(JSON.stringify(s.value), 160)}` })) });
			tab.touch();
		},
	},
	{
		name: "emit", title: "Publish an event", about: "Publish an event as yourself", hint: "<topic> [json]",
		run: async (args, tab) => {
			const at = args.trim().indexOf(" ");
			const topic = at < 0 ? args.trim() : args.trim().slice(0, at);
			if (!topic) return store.flash("Name the topic: /emit <topic> [json]");
			let payload: unknown = null;
			if (at >= 0) {
				try {
					payload = JSON.parse(args.trim().slice(at + 1));
				} catch {
					return store.flash("The payload is not JSON.", "bad");
				}
			}
			const done = await store.attempt(() => apiFor(envOf(tab)).emit(topic, payload));
			if (done) store.flash(`Published event #${done.id} on ${topic}.`);
		},
	},
	{ name: "copy", title: "Copy last answer", about: "Copy the agent's last answer, as it wrote it (Markdown)", keys: "⇧⌘C", chat: true, run: menu("copy") },
	{
		name: "export", title: "Export conversation", about: "Save this conversation as Markdown, or copy it", hint: "[copy] [full]", keys: "⇧⌘E", chat: true,
		run: async (args, tab) => {
			const t = chat(tab);
			if (!t) return;
			const full = /\bfull\b/.test(args);
			if (!/\bcopy\b/.test(args)) return store.exportConversation(t, full);
			const text = await store.attempt(() => store.markdownOf(t, full));
			if (text) (await navigator.clipboard.writeText(text), store.flash("Copied the conversation as Markdown."));
		},
	},
	{
		name: "notify", title: "Notifications", about: "A notification when the agent is done or needs you while the window is not in front", hint: "[on|off]",
		run: async (args) => {
			const word = args.trim().toLowerCase();
			const on = word === "on" ? true : word === "off" ? false : !store.prefs.notify;
			store.prefs = await window.pine.prefs({ notify: on });
			store.touch();
			store.flash(on ? "Notifications are on." : "Notifications are off.");
		},
	},
	{ name: "clear", title: "Clear the view", about: "Clear this tab's view; the conversation is kept", chat: true, run: menu("clear") },
	{ name: "settings", title: "Settings", about: "Agents, models, MCP servers, skills, events and pine's own settings", keys: "⌘,", run: menu("settings") },
	{ name: "sidebar", title: "Toggle sidebar", about: "Show or hide the list of agents and conversations", keys: "⌘B", run: menu("sidebar") },
	{ name: "open", title: "Open a folder", about: "A conversation that works in a folder of yours", keys: "⌘O", run: menu("open-folder") },
	{ name: "updates", title: "Check for updates", about: "Ask GitHub whether there is a newer Pine app", run: menu("updates") },
	{ name: "help", title: "Keys and commands", about: "What can be typed and pressed", run: menu("help") },
];

async function answer(args: string, allow: boolean, tab: Tab | undefined): Promise<void> {
	const env = envOf(tab);
	const words = args.split(/\s+/).filter(Boolean);
	const always = allow && words.includes("always");
	const id = words.find((w) => w !== "always") ?? "";
	const pending = await apiFor(env).approvals().catch(() => []);
	const target = id || (pending.length === 1 ? pending[0].id : "");
	if (!target) return store.flash(pending.length ? `Several requests wait: ${pending.map((p) => p.id).join(", ")}` : "Nothing waits for approval.");
	const req = pending.find((p) => p.id === target);
	// One that needs a value, or is a question, is answered in its dialog.
	if (allow && (req?.inputs?.length || req?.tool === "question")) return store.ask(env, target);
	await store.decide(env, target, allow, always);
}

/** Run what was typed after a slash. */
export async function runSlash(text: string, tab: Tab | undefined): Promise<void> {
	const [name, ...rest] = text.trim().split(/\s+/);
	const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
	if (!cmd) return store.flash(`There is no command /${name}. Type / to see them.`, "bad");
	try {
		await cmd.run(text.trim().slice(name.length).trim() || rest.join(" "), tab);
	} catch (e) {
		store.flash(errText(e), "bad");
	}
}
