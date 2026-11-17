// Settings: everything about pine that is otherwise a command in a shell or a sentence to the
// main agent. Each page asks the daemon what there is and tells it what to change; the daemon
// checks every change as it checks the main agent's, and nothing here writes a file itself.
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type AgentDetail, type AgentInfo, type Api, apiFor, type LoginState, type Setting, type SourceType } from "./api.ts";
import { bridge } from "./bridge.ts";
import { Editor } from "./CodePanel.tsx";
import { type Env, store, useModel } from "./model.ts";
import { ago, errText, MODES, plural, REASONING, short, tilde } from "./text.ts";
import { AutoText, Button, Confirm, Dialog, Empty, Field, Icon, Segmented, Spinner, Switch, useLoad } from "./ui.tsx";

/**
 * The pine whose settings a page shows. It is bound when the page is drawn, never looked up when
 * a call is made: the environment chosen at the top changes by itself when one goes off, and a
 * change that is on its way must still go to the pine it was made for. (The page is drawn anew
 * for another environment: `key` in `Settings`.)
 */
const PineOfPage = createContext("local");

function usePine(): { id: string; env: Env | undefined; api: Api; agents: AgentInfo[] } {
	const id = useContext(PineOfPage);
	const env = store.env(id);
	return { id, env, api: apiFor(id), agents: env?.agents ?? [] };
}

const SECTIONS: Array<{ id: string; label: string; icon: string }> = [
	{ id: "general", label: "General", icon: "sliders" },
	{ id: "agents", label: "Agents", icon: "users" },
	{ id: "models", label: "Models", icon: "cpu" },
	{ id: "mcp", label: "MCP servers", icon: "plug" },
	{ id: "skills", label: "Skills", icon: "book" },
	{ id: "events", label: "Events", icon: "bolt" },
	{ id: "instructions", label: "Instructions", icon: "edit" },
	{ id: "environments", label: "Environments", icon: "terminal" },
	{ id: "app", label: "App", icon: "gear" },
];

function Page({ title, lead, children, actions }: { title: string; lead?: ReactNode; children: ReactNode; actions?: ReactNode }) {
	return (
		<div className="set-in">
			<div className="row" style={{ alignItems: "flex-start" }}>
				<div className="grow">
					<h1>{title}</h1>
					{lead ? <p className="lead">{lead}</p> : null}
				</div>
				{actions}
			</div>
			{children}
		</div>
	);
}

function Loading({ state }: { state: { error?: string; loading: boolean } }) {
	return state.error ? <div className="notice bad"><Icon name="alert" />{state.error}</div> : <div className="empty"><Spinner /></div>;
}

/** Who something is for: all agents, or one. */
function Whom({ value, onChange, all = "all agents" }: { value: string; onChange: (v: string) => void; all?: string }) {
	useModel(store);
	const { agents } = usePine();
	return (
		<select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="">{all}</option>
			{agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
		</select>
	);
}

const scopeText = (scope: string, session?: string) => (scope === "global" ? "all agents" : session && session !== "main" ? `${scope} · ${session}` : scope);

// ---- general ----------------------------------------------------------------------------------------

function SettingRow({ s, models, reload }: { s: Setting; models: string[]; reload: () => void }) {
	const { api, env } = usePine();
	const [draft, setDraft] = useState<string>();
	const set = async (value: unknown) => {
		const done = await store.attempt(() => api.setSetting(s.key, value));
		if (!done) return;
		setDraft(undefined);
		store.flash(done.live ? `${s.key} is now ${done.now}.` : `${s.key} is saved; it holds from the next start of pine.`, "good", 3000);
		reload();
		void store.refreshTaints(env);
		await store.refreshAgents(env);
		store.touch();
	};
	const k = s.kind;
	const saved = (s as Setting & { saved?: string }).saved;
	const unset = /^not set/.test(s.now) || s.now === "none";
	let control: ReactNode;
	if (k === "boolean") control = <Switch on={s.now === "true"} onChange={(on) => void set(on)} />;
	else if (k === "model")
		control = (
			<select className="input" value={unset ? "" : s.now} onChange={(e) => void set(e.target.value || "default")}>
				<option value="">{unset ? s.now : "pine's default"}</option>
				{!unset && !models.includes(s.now) ? <option value={s.now}>{s.now}</option> : null}
				{models.map((m) => <option key={m} value={m}>{m}</option>)}
			</select>
		);
	else if (typeof k === "object" && "one" in k)
		control = (
			<select className="input" value={k.one.includes(s.now) ? s.now : ""} onChange={(e) => void set(e.target.value || "default")}>
				{k.one.includes(s.now) ? null : <option value="">{s.now}</option>}
				{k.one.map((v) => <option key={v} value={v}>{v}</option>)}
			</select>
		);
	else
		control = (
			<>
				<input className="input mono" style={{ width: 110 }} value={draft ?? s.now} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft !== undefined && void set(draft)} title={typeof k === "object" ? `a whole number from ${k.from} to ${k.to}` : "a time such as 90s or 5m"} />
				{draft !== undefined && draft !== s.now ? <Button small variant="primary" onClick={() => void set(draft)}>Save</Button> : null}
			</>
		);
	return (
		<div className="item">
			<div className="info">
				<div className="name">
					<span>{s.title ?? s.key}</span>
					{s.title ? <span className="mono faint setting-key" title="Its name in pine.json, and for the main agent">{s.key}</span> : null}
					{s.live ? null : <span className="tag">from the next start</span>}
					{saved ? <span className="tag warn">saved: {saved}</span> : null}
				</div>
				<div className="about lines">{s.about}</div>
			</div>
			<div className="ctl">{control}</div>
		</div>
	);
}

function General() {
	const { api } = usePine();
	const overview = useLoad(() => api.overview());
	const settings = useLoad(() => api.settings());
	const models = useLoad(() => api.models());
	const groups: Array<[string, string]> = [["defaults.", "What agents start from"], ["limits.", "Limits"], ["security.", "Security"]];
	return (
		<Page title="General" lead="pine's own settings. A change is checked by pine before it is written; one that would not load is not kept.">
			{overview.data ? (
				<>
					<div className="group">
						<div className="item">
							<div className="info"><div className="name">pine {overview.data.version}</div><div className="about">Home: {tilde(overview.data.home)} · main agent: {overview.data.main} · {overview.data.sandbox ? "sandbox available" : "no sandbox on this system"}</div></div>
							<div className="ctl"><Button small icon="external" onClick={() => void bridge.reveal(overview.data!.log)}>Show log</Button></div>
						</div>
					</div>
					{overview.data.warnings.length || overview.data.modelNotes.length ? (
						<>
							<h2>Notes on this setup</h2>
							{[...overview.data.warnings, ...overview.data.modelNotes].map((w, i) => <div key={i} className="notice"><Icon name="alert" /><span>{w}</span></div>)}
						</>
					) : null}
				</>
			) : (
				<Loading state={overview} />
			)}
			{settings.data ? (
				groups.map(([prefix, title]) => (
					<div key={prefix} style={{ display: "contents" }}>
						<h2>{title}</h2>
						<div className="group">{settings.data!.filter((s) => s.key.startsWith(prefix)).map((s) => <SettingRow key={s.key} s={s} models={models.data ?? []} reload={settings.reload} />)}</div>
					</div>
				))
			) : (
				<Loading state={settings} />
			)}
		</Page>
	);
}

// ---- agents -----------------------------------------------------------------------------------------

function Checks({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
	return (
		<div className="checks">
			{all.map((x) => {
				const on = value.includes(x);
				return <button type="button" key={x} className={`check${on ? " on" : ""}`} onClick={() => onChange(on ? value.filter((v) => v !== x) : [...value, x])}>{on ? <Icon name="check" size={11} /> : null}{x}</button>;
			})}
		</div>
	);
}

const FILES: Array<{ key: "instructions" | "soul" | "tooling" | "memory" | "rules"; label: string; name: string; about: string; edit: boolean }> = [
	{ key: "instructions", label: "AGENTS.md", name: "AGENTS.md", about: "Its purpose and how it works. The agent keeps this file itself, and you can shape it here.", edit: true },
	{ key: "soul", label: "SOUL.md", name: "SOUL.md", about: "Who it is: character and tone.", edit: true },
	{ key: "tooling", label: "TOOLS.md", name: "TOOLS.md", about: "Its own defaults and preferences for its tools, on top of those for all agents. May be empty.", edit: true },
	{ key: "memory", label: "MEMORY.md", name: "MEMORY.md", about: "What it wrote down to outlive a conversation. The agent's own; shown, not changed here.", edit: false },
	{ key: "rules", label: "Your rules", name: "agents/<id>/AGENTS.md", about: "Rules of yours that the agent reads and cannot change. Kept in pine's home; edit the file there.", edit: false },
];

function AgentPage({ id, back }: { id: string; back: () => void }) {
	const { api, env: pine, id: envId, agents } = usePine();
	const detail = useLoad(() => api.agentDetail(id), [id]);
	const models = useLoad(() => api.models());
	const [change, setChange] = useState<Record<string, unknown>>({});
	const [file, setFile] = useState<(typeof FILES)[number]["key"]>("instructions");
	const [texts, setTexts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const d = detail.data;
	useEffect(() => (setChange({}), setTexts({})), [id, d]);
	if (!d) return <Page title={id}><Button className="back" small variant="ghost" icon="back" onClick={back}>Agents</Button><Loading state={detail} /></Page>;
	const now = <K extends keyof AgentDetail>(key: K): AgentDetail[K] => (key in change ? (change[key as string] as AgentDetail[K]) : d[key]);
	const put = (key: string, value: unknown) => setChange({ ...change, [key]: value });
	const dirtyFiles = FILES.filter((f) => f.edit && texts[f.key] !== undefined && texts[f.key] !== (d.files[f.key] ?? ""));
	const dirty = Object.keys(change).length > 0 || dirtyFiles.length > 0;
	const save = async () => {
		setBusy(true);
		const body = { ...change, ...Object.fromEntries(dirtyFiles.map((f) => [f.key, texts[f.key]])) };
		const done = await store.attempt(() => api.updateAgent(id, body));
		setBusy(false);
		if (!done) return;
		store.flash(`Updated ${id}; it holds from its next message on.${done.warnings.length ? ` Note: ${done.warnings.join("; ")}` : ""}`, done.warnings.length ? "warn" : "good", done.warnings.length ? 9000 : 3500);
		detail.reload();
		await store.refreshAgents(pine);
		store.touch();
	};
	const remove = async () => {
		if (await store.removeAgent(envId, id)) back();
	};
	const addFolder = async (kind: "read" | "write") => {
		const dir = await store.chooseFolder(envId, kind === "write" ? `A folder ${id} may read and change` : `A folder ${id} may read`);
		if (dir) put(kind, [...((change[kind] as string[]) ?? []), dir]);
	};
	const others = agents.filter((a) => a.id !== id).map((a) => a.id);
	const meta = FILES.find((f) => f.key === file)!;
	const text = texts[file] ?? d.files[file] ?? "";
	const mode = now("mode");
	return (
		<Page
			title={d.id}
			lead={d.main ? "The main agent: it administers pine, and may hand work to every other agent." : `An agent with its own workspace at ${tilde(d.workspace)}.`}
			actions={<><Button onClick={() => void store.openTab(envId, id, "main")} icon="chat">Open</Button><Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button></>}
		>
			<Button className="back" small variant="ghost" icon="back" onClick={back}>Agents</Button>
			<div className="group">
				<div className="form">
					<Field label="What it is for" hint="One line. Other agents read it when they decide whom to hand work to." wide>
						<input className="input" value={now("description")} onChange={(e) => put("description", e.target.value)} />
					</Field>
					<Field label="Model">
						<select className="input" value={(change.model as string) ?? d.model ?? ""} onChange={(e) => put("model", e.target.value || "default")}>
							<option value="">{d.defaultModel ? `${d.defaultModel} (the default)` : "the default"}</option>
							{d.model && !(models.data ?? []).includes(d.model) ? <option value={d.model}>{d.model}</option> : null}
							{(models.data ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
					</Field>
					<Field label="Reasoning" hint="How much its model thinks before it answers.">
						<select className="input" value={now("thinking")} onChange={(e) => put("thinking", e.target.value)}>{REASONING.map((r) => <option key={r} value={r}>{r}</option>)}</select>
					</Field>
					<Field label="Mode" hint={MODES.find((m) => m.value === mode)?.about} wide>
						<Segmented value={mode} options={MODES.map((m) => ({ value: m.value as AgentDetail["mode"], label: m.label }))} onChange={(v) => put("mode", v)} />
					</Field>
					<Field label="Built-in tools" hint="Without bash, edit and write an agent only reads." wide>
						<Checks all={d.allTools} value={now("tools")} onChange={(v) => put("tools", v)} />
					</Field>
					<Field label="May hand work to" hint={d.main ? "The main agent may delegate to everyone." : "Agents it can give a task to with its delegate tool."} wide>
						{others.length ? <Checks all={["*", ...others]} value={now("delegates")} onChange={(v) => put("delegates", v)} /> : <span className="faint">There is no other agent yet.</span>}
					</Field>
					<Field label="Network from its shell" hint="In its sandbox (safe and manual mode) its commands have no network unless this is on. With it, a command can send what the agent reads anywhere.">
						<Switch on={now("network")} onChange={(on) => put("network", on)} />
					</Field>
					<Field label="Folders outside its workspace" wide hint="What it may reach in its sandbox besides its own folders.">
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{[...d.read.map((p) => ({ p, kind: "read" })), ...d.write.map((p) => ({ p, kind: "read and change" }))].map(({ p, kind }) => {
								const dropped = ((change.forget as string[]) ?? []).includes(p);
								return (
									<div className="row" key={`${kind}:${p}`}>
										<Icon name="folder" size={13} className="faint" />
										<span className="mono cut grow" style={dropped ? { textDecoration: "line-through", opacity: 0.5 } : undefined}>{tilde(p)}</span>
										<span className="tag">{kind}</span>
										<Button small variant="ghost" icon={dropped ? "undo" : "x"} title={dropped ? "Keep it" : "Take it away"} onClick={() => put("forget", dropped ? ((change.forget as string[]) ?? []).filter((x) => x !== p) : [...((change.forget as string[]) ?? []), p])} />
									</div>
								);
							})}
							{(["read", "write"] as const).flatMap((kind) => ((change[kind] as string[]) ?? []).map((p) => (
								<div className="row" key={`new:${kind}:${p}`}>
									<Icon name="plus" size={13} className="faint" />
									<span className="mono cut grow">{tilde(p)}</span>
									<span className="tag good">{kind === "write" ? "read and change" : "read"} · new</span>
									<Button small variant="ghost" icon="x" onClick={() => put(kind, ((change[kind] as string[]) ?? []).filter((x) => x !== p))} />
								</div>
							)))}
							<div className="row"><Button small icon="plus" onClick={() => void addFolder("read")}>May read…</Button><Button small icon="plus" onClick={() => void addFolder("write")}>May read and change…</Button></div>
						</div>
					</Field>
				</div>
			</div>

			<h2>What it is told</h2>
			<div className="group">
				<div className="item" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8 }}>
					<Segmented value={file} options={FILES.filter((f) => f.edit || d.files[f.key] !== undefined).map((f) => ({ value: f.key, label: f.label }))} onChange={setFile} />
					<div className="about" style={{ color: "var(--muted)", fontSize: 12.5 }}>{meta.about}</div>
				</div>
				<div style={{ height: 380, display: "flex" }}>
					<Editor key={`${id}:${file}`} file={`${file}.md`} text={text} readOnly={!meta.edit} onChange={(v) => setTexts((was) => ({ ...was, [file]: v }))} onSave={() => void save()} />
				</div>
			</div>

			<h2>What it has</h2>
			<div className="group">
				{(
					[
						["Conversations", d.holdings.conversations],
						["Event sources", d.holdings.sources],
						["MCP servers", d.holdings.servers],
						["Schedules", d.holdings.schedules],
						["Skills", d.holdings.skills],
						["Routes that wake it", d.holdings.routes],
					] as Array<[string, string[]]>
				).map(([label, list]) => (
					<div className="item" key={label}><div className="info"><div className="name">{label}</div></div><div className="ctl muted" style={{ maxWidth: "70%" }}><span className="cut">{list?.length ? list.join(", ") : "none"}</span></div></div>
				))}
				<div className="item"><div className="info"><div className="name">Workspace</div><div className="about mono">{tilde(d.workspace)} · {plural(d.holdings.files, "file")}</div></div><div className="ctl"><Button small icon="external" onClick={() => void bridge.reveal(d.workspace)}>Show</Button></div></div>
			</div>
			{d.main ? null : (
				<div className="group">
					<div className="item"><div className="info"><div className="name">Remove this agent</div><div className="about">With its conversations, sources, schedules, servers, skills, the routes that wake it, its folder and its private home.{d.holdings.outside ? " Its workspace lies outside pine's home and is left as it is." : ""}</div></div><div className="ctl"><Button variant="danger" icon="trash" onClick={() => void remove()}>Remove…</Button></div></div>
				</div>
			)}
		</Page>
	);
}

function NewAgent({ close, made }: { close: () => void; made: (id: string) => void }) {
	const { api, env: pine } = usePine();
	const models = useLoad(() => api.models());
	const [f, setF] = useState({ id: "", description: "", instructions: "", model: "" });
	const create = async () => {
		const instructions = f.instructions.trim() || `You are ${f.id}. ${f.description.trim().replace(/\.?$/, ".")}`;
		const done = await store.attempt(() => api.createAgent({ id: f.id.trim(), description: f.description.trim(), instructions, model: f.model || undefined }));
		if (!done) return;
		await store.refreshAgents(pine);
		store.flash(`Created the agent ${done.id}.`, "good");
		made(done.id);
	};
	return (
		<Dialog title="A new agent" width={600} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!f.id.trim() || !f.description.trim()} onClick={() => void create()}>Create agent</Button></>}>
			<Field label="Name" hint="Lowercase letters, digits, - and _ (for example research, home, books)."><input autoFocus className="input mono" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} /></Field>
			<Field label="What it is for" hint="One line. Other agents read it when they decide whom to hand work to."><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
			<Field label="Instructions" hint="Who it is and how it works, written to the agent itself. Left empty, it starts from what it is for and keeps the file itself from then on."><AutoText value={f.instructions} onChange={(v) => setF({ ...f, instructions: v })} minRows={4} maxRows={12} placeholder="You are …" /></Field>
			<Field label="Model">
				<select className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
					<option value="">pine's default</option>
					{(models.data ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
			</Field>
		</Dialog>
	);
}

function Agents() {
	const s = useModel(store);
	const { agents } = usePine();
	// Which agent's page is open is the app's to say: the side bar opens one too. "+" is the new agent's dialog.
	const open = s.settingsAgent !== "+" ? s.settingsAgent : undefined;
	const adding = s.settingsAgent === "+";
	const setOpen = (id?: string) => ((s.settingsAgent = id), s.touch());
	const setAdding = (on: boolean) => setOpen(on ? "+" : undefined);
	if (open && agents.some((a) => a.id === open)) return <AgentPage id={open} back={() => setOpen(undefined)} />;
	return (
		<Page title="Agents" lead="An agent is a folder with a workspace, instructions and a model. Each has its own conversations and reach." actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New agent</Button>}>
			<div className="group">
				{agents.map((a) => (
					<div className="item click" key={a.id} onClick={() => setOpen(a.id)}>
						<div className="info">
							<div className="name">{a.id}{a.main ? <span className="tag good">main</span> : null}<span className={`tag${a.mode === "bypass" ? " bad" : a.mode === "safe" ? " good" : ""}`}>{a.mode}</span></div>
							<div className="about">{a.description || "no description"}</div>
							<div className="about faint mono" style={{ fontSize: 11.5 }}>{a.model} · reasoning {a.thinking} · {tilde(a.workspace)}</div>
						</div>
						<Icon name="right" size={14} className="faint" />
					</div>
				))}
			</div>
			{adding ? <NewAgent close={() => setAdding(false)} made={(id) => setOpen(id)} /> : null}
		</Page>
	);
}

// ---- models -----------------------------------------------------------------------------------------

/** pi's sign-in, shown step by step: a page to open, a code to type there, or a key to paste here. */
function SignIn({ provider, type, close }: { provider: string; type?: "api_key" | "oauth"; close: (done: boolean, choose?: string[]) => void }) {
	const { api } = usePine();
	const [id, setId] = useState<string>();
	const [state, setState] = useState<LoginState>();
	const [answer, setAnswer] = useState("");
	const [error, setError] = useState<string>();
	const opened = useRef<string>(undefined);
	useEffect(() => {
		let live = true;
		api.login(provider, type).then((r) => live && setId(r.id), (e) => live && setError(errText(e)));
		return () => {
			live = false;
		};
	}, [provider, type]);
	useEffect(() => {
		if (!id) return;
		let live = true;
		const look = async () => {
			try {
				const next = await api.loginState(id);
				if (!live) return;
				setState(next);
				// The page is opened here, where the owner sits; once.
				if (next.url && opened.current !== next.url) (opened.current = next.url), void bridge.open(next.url);
				if (!next.done) timer = window.setTimeout(look, 700);
			} catch (e) {
				if (live) setError(errText(e));
			}
		};
		let timer = window.setTimeout(look, 150);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [id]);
	const cancel = () => {
		if (id && !state?.done) void api.loginAnswer(id, { cancel: true }).catch(() => {});
		close(Boolean(state?.done && !state.error));
	};
	const send = async (text: string) => {
		if (!id) return;
		setAnswer("");
		await api.loginAnswer(id, { answer: text }).catch((e) => setError(errText(e)));
	};
	const q = state?.question;
	return (
		<Dialog title={`Sign in to ${provider}`} width={560} onClose={cancel} footer={<Button variant={state?.done ? "primary" : "plain"} onClick={cancel}>{state?.done ? "Done" : "Cancel"}</Button>}>
			{error || state?.error ? <div className="notice bad"><Icon name="alert" />{error ?? state?.error}</div> : null}
			{state?.lines.length ? <pre className="log">{state.lines.join("\n")}</pre> : null}
			{state?.url && !state.done ? <div className="row"><Button icon="external" onClick={() => void bridge.open(state.url!)}>Open the sign-in page again</Button>{state.code ? <span>Code: <b className="mono selectable">{state.code}</b></span> : null}</div> : null}
			{q && !state?.done ? (
				q.options?.length ? (
					<div className="pick-list" style={{ padding: 0 }}>
						<div className="muted" style={{ marginBottom: 4 }}>{q.message}</div>
						{q.options.map((o) => <div key={o.id} className="pick-item" onClick={() => void send(o.id)}><span className="label">{o.label}</span><span className="about">{o.description}</span></div>)}
					</div>
				) : (
					<Field label={q.message} hint={q.secret ? "It is not shown, and is stored in auth.json in pine's home, where agents cannot read it." : undefined}>
						<div className="row">
							<input autoFocus className="input mono" type={q.secret ? "password" : "text"} autoComplete="off" spellCheck={false} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && answer.trim() && void send(answer.trim())} />
							<Button variant="primary" disabled={!answer.trim()} onClick={() => void send(answer.trim())}>Continue</Button>
						</div>
					</Field>
				)
			) : !state?.done && !error ? (
				<div className="row muted"><Spinner /> {state?.url ? "Waiting for you to sign in in the browser…" : "Starting…"}</div>
			) : null}
			{state?.done && !state.error ? <div className="notice plain"><Icon name="check" />{state.models?.length ? `${plural(state.models.length, "model")} available, for example ${state.models.slice(0, 4).join(", ")}.` : "Signed in."}</div> : null}
			{/* A sign-in changes no agent's model: which of the new ones the agents run on is asked here, where they were just made available. */}
			{state?.done && !state.error && state.models?.length ? <div className="row"><Button variant="primary" onClick={() => close(true, state.models)}>Choose the model your agents run on…</Button><span className="muted">Or later: Change, on the Models page.</span></div> : null}
		</Dialog>
	);
}

function Models() {
	const { api, env, agents } = usePine();
	const providers = useLoad(() => api.providers());
	const servers = useLoad(() => api.modelServers());
	const models = useLoad(() => api.models());
	const [signIn, setSignIn] = useState<{ provider: string; type?: "api_key" | "oauth" }>();
	const [f, setF] = useState({ name: "", url: "", key: "", context: "" });
	const [locked, setLocked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [all, setAll] = useState(false);
	useModel(store);
	// The model of every agent that has none of its own, and the agents whose model cannot answer.
	const fallback = useLoad(() => api.settings().then((all) => all.find((x) => x.key === "defaults.model")?.now ?? "none"));
	const details = useLoad(() => Promise.all(agents.map((a) => api.agentDetail(a.id))));
	const own = (details.data ?? []).filter((d) => d.model).map((d) => `${d.id} (${d.model})`);
	const stuck = agents.filter((a) => a.modelProblem);
	const reload = () => (providers.reload(), servers.reload(), models.reload(), fallback.reload(), details.reload(), void store.refreshAgents(env));
	const add = async () => {
		setBusy(true);
		try {
			const done = await api.addModelServer({ name: f.name.trim(), url: f.url.trim(), key: f.key.trim() || undefined, context: Number(f.context) > 0 ? Number(f.context) : undefined });
			store.flash(`Added ${f.name} with ${done.models.join(", ")}.`, "good");
			setF({ name: "", url: "", key: "", context: "" });
			setLocked(false);
			reload();
		} catch (e: any) {
			if (e?.data?.locked) setLocked(true);
			store.flash(errText(e), "bad");
		}
		setBusy(false);
	};
	const mine = new Set((servers.data ?? []).map((s) => s.name));
	const hosted = (providers.data ?? []).filter((p) => !mine.has(p.id));
	const shown = all ? hosted : hosted.filter((p) => p.signedIn);
	return (
		<Page title="Models" lead="Which models your agents can run on: providers you sign in to, and model servers of your own. An agent's model is chosen on its page, or in the bar under a conversation.">
			<h2>Model servers of your own</h2>
			<div className="group">
				{servers.data?.length ? (
					servers.data.map((s) => (
						<div className="item" key={s.name}>
							<div className="info">
								<div className="name">{s.name}<span className="tag mono">{s.baseUrl}</span><span className="tag">key: {s.key}</span></div>
								<div className="about mono">{s.models.map((m) => `${s.name}/${m.id}${m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k${m.images ? ", sees pictures" : ""}${m.reasoning ? ", thinks" : ""})` : ""}`).join(" · ") || "no models"}</div>
							</div>
							<div className="ctl"><Confirm label="Remove" sure="Remove it?" onConfirm={() => void store.attempt(() => api.removeModelServer(s.name)).then((r) => r && (store.flash(`Removed ${s.name}.`), reload()))} /></div>
						</div>
					))
				) : servers.data ? (
					<div className="item"><div className="info"><div className="about">None yet. Anything that speaks OpenAI's chat API works: llama.cpp, vLLM, LM Studio.</div></div></div>
				) : (
					<Loading state={servers} />
				)}
				<div className="form">
					<Field label="Name" hint="Its models are then called name/model."><input className="input mono" placeholder="studio" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} /></Field>
					<Field label="Address" hint="pine asks the server which models it has."><input className="input mono" placeholder="http://127.0.0.1:8080" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
					{locked || f.key ? <Field label="API key" hint="The server wants a key. It goes into pine's .env file."><input className="input mono" type="password" autoComplete="off" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field> : null}
					<Field label="Context (tokens)" hint="Only when the server does not say."><input className="input mono" placeholder="from the server" value={f.context} onChange={(e) => setF({ ...f, context: e.target.value.replace(/\D/g, "") })} /></Field>
				</div>
				<div className="form-foot">
					<span className="muted grow" style={{ fontSize: 12 }}>An agent that is given one of its models sends its whole conversations there.</span>
					<Button variant="primary" disabled={!f.name.trim() || !f.url.trim() || busy} onClick={() => void add()}>{busy ? "Asking the server…" : "Add server"}</Button>
				</div>
			</div>

			<h2>Providers <Button small variant="ghost" onClick={() => setAll(!all)}>{all ? "Only those signed in" : `Show all ${hosted.length}`}</Button></h2>
			<div className="group">
				{providers.data ? (
					shown.length ? (
						shown.map((p) => (
							<div className="item" key={p.id}>
								<div className="info"><div className="name">{p.name ?? p.id}{p.name && p.name !== p.id ? <span className="tag mono">{p.id}</span> : null}{p.signedIn ? <span className="tag good">signed in</span> : null}</div><div className="about">{plural(p.models, "model")}</div></div>
								<div className="ctl">
									{p.signedIn ? <Confirm label="Sign out" sure="Sign out?" onConfirm={() => void store.attempt(() => api.logout(p.id)).then((r) => r && reload())} /> : null}
									{p.oauth ? <Button small onClick={() => setSignIn({ provider: p.id, type: "oauth" })}>Sign in</Button> : null}
									<Button small onClick={() => setSignIn({ provider: p.id, type: "api_key" })}>{p.signedIn ? "New key" : "API key"}</Button>
								</div>
							</div>
						))
					) : (
						<div className="item"><div className="info"><div className="about">You are signed in to no provider. Show all to pick one (OpenCode, Claude, ChatGPT, …), or add a model server of your own above.</div></div></div>
					)
				) : (
					<Loading state={providers} />
				)}
			</div>

			<h2>The model your agents run on</h2>
			<div className="group">
				<div className="item fallback-model">
					<div className="info"><div className="name mono">{fallback.data ?? "…"}</div><div className="about">Every agent that has no model of its own runs on it{own.length ? `. With a model of their own: ${own.join(", ")}` : ""}.</div></div>
					<Button small onClick={() => void (env && store.chooseDefaultModel(env).then(reload))}>Change…</Button>
				</div>
				{stuck.map((a) => <div className="item" key={a.id}><div className="notice grow"><Icon name="alert" /><div><b>{a.id}</b> cannot answer: {a.modelProblem}</div></div></div>)}
			</div>

			<h2>Models you can use now</h2>
			<div className="group"><div className="item"><div className="about mono selectable" style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.7 }}>{models.data ? models.data.join("   ") || "none: sign in to a provider or add a server" : "…"}</div></div></div>
			{signIn ? <SignIn provider={signIn.provider} type={signIn.type} close={(_done, choose) => (setSignIn(undefined), reload(), choose && env ? void store.chooseDefaultModel(env, choose).then(reload) : undefined)} /> : null}
		</Page>
	);
}

// ---- MCP servers ------------------------------------------------------------------------------------

/** A command line cut into its words, with quotes kept together. */
function words(line: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
	return out;
}

function Mcp() {
	const { api } = usePine();
	const servers = useLoad(() => api.mcp());
	const states = useLoad(() => api.mcpStates());
	const [f, setF] = useState({ name: "", kind: "remote" as "remote" | "local", target: "", agent: "", description: "", taints: false });
	const [busy, setBusy] = useState<string>();
	const [out, setOut] = useState<string>();
	const reload = () => (servers.reload(), states.reload());
	const add = async () => {
		const argv = words(f.target);
		const server = f.kind === "remote" ? { url: f.target.trim() } : { command: argv[0], args: argv.slice(1) };
		const done = await store.attempt(() => api.addMcp(f.name.trim(), { ...server, ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.taints ? { taints: true } : {}) }, f.agent || undefined));
		if (!done) return;
		store.flash(`Added ${f.name} for ${f.agent || "all agents"}.${f.kind === "remote" ? " If it requires a sign-in, use Sign in on its row." : ""}`, "good", 6000);
		setF({ ...f, name: "", target: "", description: "" });
		reload();
	};
	const login = async (name: string, agent?: string) => {
		setBusy(name);
		setOut(undefined);
		const r = await store.attempt(() => api.mcpLogin(name, agent));
		setBusy(undefined);
		if (r) (setOut(r.out.trim() || (r.code === 0 ? "Signed in." : `It ended with exit ${r.code}.`)), reload());
	};
	return (
		<Page title="MCP servers" lead="Servers that offer tools to your agents: a remote one by its address, or a program on this computer, which runs where the commands of the agent that uses it run.">
			<div className="group">
				{servers.data ? (
					servers.data.length ? (
						servers.data.map((s) => {
							const state = !s.enabled ? "disabled" : (states.data?.[s.name] ?? (states.loading ? "…" : s.remote ? "unknown" : "local"));
							const agent = s.scope === "global" ? undefined : s.scope;
							return (
								<div className="item" key={`${s.scope}:${s.name}`}>
									<div className="info">
										<div className="name">{s.name}<span className={`tag${/connected|ok|local|authenticated/i.test(state) ? " good" : /needs|error|fail|unauth/i.test(state) ? " warn" : ""}`}>{state}</span><span className="tag">{s.scope === "global" ? `all: ${s.agents.join(", ") || "nobody"}` : s.session ? `only the conversation ${s.session} of ${s.scope}` : `only ${s.scope}`}</span>{s.taints ? <span className="tag warn">outside content</span> : null}{s.approve !== "never" ? <span className="tag">asks: {s.approve}</span> : null}</div>
										<div className="about mono">{s.target}</div>
									</div>
									<div className="ctl">
										{s.remote ? <Button small disabled={busy === s.name} onClick={() => void login(s.name, agent)}>{busy === s.name ? <><Spinner size={11} /> In your browser…</> : "Sign in"}</Button> : null}
										{s.target.startsWith("bundled:") ? null : <Confirm label="Remove" sure="Remove it?" onConfirm={() => void store.attempt(() => api.removeMcp(s.name, agent)).then((r) => r && (store.flash(`Removed ${s.name}.`), reload()))} />}
									</div>
								</div>
							);
						})
					) : (
						<div className="item"><div className="about muted">No MCP servers yet.</div></div>
					)
				) : (
					<Loading state={servers} />
				)}
			</div>
			{out ? <pre className="log">{out}</pre> : null}
			<h2>Add a server</h2>
			<div className="group">
				<div className="form">
					<Field label="Name" hint="Lowercase letters, digits and _. Its tools appear as mcp__name__tool."><input className="input mono" placeholder="home_link" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
					<Field label="For"><Whom value={f.agent} onChange={(agent) => setF({ ...f, agent })} /></Field>
					<Field label="Kind" wide><Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind, target: "" })} options={[{ value: "remote", label: "Remote (https address)" }, { value: "local", label: "A program on this computer" }]} /></Field>
					<Field label={f.kind === "remote" ? "Address" : "Command"} wide hint={f.kind === "remote" ? "Its https URL." : "The program and its arguments, as its documentation gives them. One program, no shell operators."}><input className="input mono" placeholder={f.kind === "remote" ? "https://mcp.example.com/mcp" : "npx -y @example/mcp@latest"} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
					<Field label="What it offers" hint="One sentence, for the agents."><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
					<Field label="Returns outside content" hint="Its results mark a conversation as having read outside content (a server that reads the web, mail or other people's words)."><Switch on={f.taints} onChange={(taints) => setF({ ...f, taints })} /></Field>
				</div>
				<div className="form-foot"><Button variant="primary" disabled={!f.name.trim() || !f.target.trim()} onClick={() => void add()}>Add server</Button></div>
			</div>
		</Page>
	);
}

// ---- skills -----------------------------------------------------------------------------------------

function Skills() {
	const { api } = usePine();
	const skills = useLoad(() => api.skills());
	const [edit, setEdit] = useState<{ name: string; description: string; instructions: string; agent: string; isNew: boolean; managed: boolean }>();
	const save = async () => {
		if (!edit) return;
		const done = await store.attempt(() => api.addSkill({ name: edit.name.trim(), description: edit.description.trim(), instructions: edit.instructions, agent: edit.agent || undefined }));
		if (!done) return;
		store.flash(`${done.replaced ? "Replaced" : "Added"} the skill ${done.name}.`, "good");
		setEdit(undefined);
		skills.reload();
	};
	if (edit)
		return (
			<Page title={edit.isNew ? "A new skill" : edit.name} lead="A skill is how something is done, written down so that an agent can do it again: a name, one or two sentences on when to use it, and the steps." actions={edit.managed ? <Button variant="primary" disabled={!edit.name.trim() || !edit.description.trim() || !edit.instructions.trim()} onClick={() => void save()}>Save skill</Button> : undefined}>
				<Button className="back" small variant="ghost" icon="back" onClick={() => setEdit(undefined)}>Skills</Button>
				{edit.managed ? null : <div className="notice plain"><Icon name="info" />This skill lies in a folder of yours that the configuration names. pine shows it and does not change it.</div>}
				<div className="group">
					<div className="form">
						<Field label="Name" hint="Lowercase letters, digits and single hyphens."><input className="input mono" disabled={!edit.isNew} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value.toLowerCase() })} placeholder="invoices" /></Field>
						<Field label="For">{edit.isNew ? <Whom value={edit.agent} onChange={(agent) => setEdit({ ...edit, agent })} /> : <input className="input" disabled value={edit.agent || "all agents"} />}</Field>
						<Field label="When to use it" wide hint="This line is always in front of the agent; it decides by it whether to read the rest."><AutoText value={edit.description} onChange={(description) => setEdit({ ...edit, description })} minRows={2} maxRows={5} readOnly={!edit.managed} /></Field>
					</div>
					<div style={{ height: 420, display: "flex", borderTop: "1px solid var(--line-soft)" }}>
						<Editor file="SKILL.md" text={edit.instructions} readOnly={!edit.managed} onChange={(instructions) => setEdit((was) => (was ? { ...was, instructions } : was))} onSave={() => void save()} />
					</div>
				</div>
			</Page>
		);
	return (
		<Page title="Skills" lead="What your agents know how to do. An agent writes one when you ask it to (“make a skill for this”); here you can read them, change them and add your own." actions={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: "", description: "", instructions: "", agent: "", isNew: true, managed: true })}>New skill</Button>}>
			<div className="group">
				{skills.data ? (
					skills.data.length ? (
						skills.data.map((s) => (
							<div className="item click" key={s.dir} onClick={() => setEdit({ name: s.name, description: s.description, instructions: s.instructions ?? "", agent: s.agent ?? "", isNew: false, managed: s.managed && s.scope !== "local" })}>
								<div className="info">
									<div className="name">{s.name}<span className="tag">{s.scope === "global" ? "all agents" : s.scope === "agent" ? s.agent : `${s.agent} · ${s.session}`}</span>{s.managed ? null : <span className="tag">yours, from the configuration</span>}</div>
									<div className="about">{short(s.description, 220)}</div>
								</div>
								<div className="ctl" onClick={(e) => e.stopPropagation()}>{s.managed ? <Confirm icon="trash" label="Remove this skill" sure="Remove?" onConfirm={() => void store.attempt(() => api.removeSkill(s.name, s.agent, s.session)).then((r) => r && (store.flash(`Removed the skill ${s.name}.`), skills.reload()))} /> : null}</div>
							</div>
						))
					) : (
						<Empty icon="book" title="No skills yet">An agent writes one when you ask it to, or add one here.</Empty>
					)
				) : (
					<Loading state={skills} />
				)}
			</div>
		</Page>
	);
}

// ---- events: sources, schedules, routes -----------------------------------------------------------------

/** One option of a source type, drawn by what its schema says it is. */
function OptionField({ name, schema, required, value, onChange }: { name: string; schema: any; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
	const type = schema?.type ?? (schema?.anyOf ? "any" : "string");
	const label = `${name}${required ? " *" : ""}`;
	const hint = schema?.description;
	if (type === "boolean") return <Field label={label} hint={hint}><Switch on={value === true} onChange={onChange} /></Field>;
	if (Array.isArray(schema?.enum)) return <Field label={label} hint={hint}><select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)}><option value="">not set</option>{schema.enum.map((v: string) => <option key={v} value={v}>{v}</option>)}</select></Field>;
	if (type === "number" || type === "integer") return <Field label={label} hint={hint}><input className="input mono" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} inputMode="decimal" /></Field>;
	if (type === "array") return <Field label={label} hint={<>{hint} <span className="faint">Several: separate them with commas.</span></>} wide><input className="input mono" value={Array.isArray(value) ? value.join(", ") : ""} onChange={(e) => onChange(e.target.value.trim() ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : undefined)} /></Field>;
	if (type === "object" || type === "any") return <Field label={label} hint={<>{hint} <span className="faint">As JSON.</span></>} wide><input className="input mono" value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} /></Field>;
	return <Field label={label} hint={hint} wide={String(hint ?? "").length > 90}><input className="input mono" value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} /></Field>;
}

function NewSource({ types, close, made }: { types: SourceType[]; close: () => void; made: () => void }) {
	const { api } = usePine();
	const [f, setF] = useState({ name: "", type: "", description: "", agent: "", own: false, note: "" });
	const [options, setOptions] = useState<Record<string, unknown>>({});
	const [plan, setPlan] = useState<Awaited<ReturnType<Api["proposeSource"]>>>();
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const type = types.find((t) => t.name === f.type);
	const props = Object.entries<any>(type?.options?.properties ?? {}).filter(([, schema]) => schema?.secret !== true);
	const required = new Set(type?.options?.required ?? []);
	// What was typed as JSON is handed on as what it says.
	const clean = () => Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => {
		const kind = type?.options?.properties?.[k]?.type;
		if (typeof v === "string" && (kind === "object" || kind === undefined && type?.options?.properties?.[k]?.anyOf)) {
			try {
				return [k, JSON.parse(v)];
			} catch {
				return [k, v];
			}
		}
		return [k, v];
	}));
	const check = async () => {
		setBusy(true);
		const p = await store.attempt(() => api.proposeSource({ name: f.name.trim(), type: f.type, options: clean(), agent: f.agent || undefined }));
		setBusy(false);
		if (p) (setPlan(p), setValues({}));
	};
	const add = async () => {
		setBusy(true);
		const done = await store.attempt(() => api.addSource({ name: f.name.trim(), type: f.type, description: f.description.trim() || type?.summary || f.type, options: clean(), agent: f.agent || undefined, own: f.own || undefined, values: plan?.needs.length ? values : undefined }));
		if (done && f.note.trim()) {
			const note = f.note.trim();
			await store.attempt(() => (f.agent ? api.subscribe(f.agent, done.name, { note }) : api.subscribeAll(done.name, { note })));
		}
		setBusy(false);
		if (!done) return;
		store.flash(`Added the event source ${done.name}.${done.tell ? ` ${done.tell}` : ""}`, "good", done.tell ? 12_000 : 4000);
		made();
	};
	return (
		<Dialog title="A new event source" width={680} onClose={close} footer={plan ? <><Button onClick={() => setPlan(undefined)}>Back</Button><Button variant="primary" disabled={busy || plan.needs.some((n) => !values[n.name]?.trim())} onClick={() => void add()}>Add source</Button></> : <><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || !f.name.trim() || !f.type} onClick={() => void check()}>Continue</Button></>}>
			{plan ? (
				<>
					<div><b>{f.name}</b> ({f.type}) for {f.agent || "all agents"} will:</div>
					<ul style={{ margin: 0, paddingLeft: 20 }}>{plan.does.map((d, i) => <li key={i}>{d}</li>)}</ul>
					{plan.owner ? <div className="notice"><Icon name="alert" />What it reports is treated as your own words: the agent it wakes gets its full tools.</div> : null}
					{plan.needs.map((n) => {
						const at = n.label.indexOf(": ");
						return <Field key={n.name} label={at > 0 ? n.label.slice(0, at) : n.name} hint={<>{at > 0 ? n.label.slice(at + 2) : ""} It is not shown, goes into pine's .env file, and never reaches an agent.</>}><input className="input mono" type="password" autoComplete="off" value={values[n.name] ?? ""} onChange={(e) => setValues({ ...values, [n.name]: e.target.value })} /></Field>;
					})}
					<Field label="Subscribe right away" hint={`What is to be done when it reports something. With a note, ${f.agent || "every agent"} is woken by its events; without one, nobody is subscribed yet.`}><input className="input" placeholder="for example: file the scan and tell me what it is" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
				</>
			) : (
				<>
					<div className="form" style={{ padding: 0 }}>
						<Field label="Name" hint="Lowercase letters, digits, - and _."><input autoFocus className="input mono" placeholder="scans" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} /></Field>
						<Field label="For"><Whom value={f.agent} onChange={(agent) => setF({ ...f, agent })} /></Field>
						<Field label="Type" wide hint={type?.summary}>
							<select className="input" value={f.type} onChange={(e) => (setF({ ...f, type: e.target.value }), setOptions({}))}>
								<option value="">Choose what it watches…</option>
								{types.map((t) => <option key={t.name} value={t.name}>{t.name}: {short(t.summary, 80)}</option>)}
							</select>
						</Field>
						{type ? <Field label="What it reports" wide><input className="input" placeholder={type.summary} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field> : null}
						{props.map(([name, schema]) => <OptionField key={name} name={name} schema={schema} required={required.has(name)} value={options[name]} onChange={(v) => setOptions({ ...options, [name]: v })} />)}
						{type ? <Field label="It is my own" hint="Only for a device or folder nobody else can put content into: what it reports is then trusted like your own messages."><Switch on={f.own} onChange={(own) => setF({ ...f, own })} /></Field> : null}
					</div>
					{type ? <div className="faint" style={{ fontSize: 12 }}>A password or token it needs is asked for in the next step.</div> : null}
				</>
			)}
		</Dialog>
	);
}

function Sources() {
	useModel(store);
	const { api, agents } = usePine();
	const sources = useLoad(() => api.sources());
	const types = useLoad(() => api.sourceTypes());
	const [adding, setAdding] = useState(false);
	const subscribe = async (name: string) => {
		const agent = await store.pick({ title: `Who wakes on ${name}?`, items: [{ value: "*", label: "All agents", about: "each in its main conversation" }, ...agents.map((a) => ({ value: a.id, label: a.id, about: "in its main conversation" }))] });
		if (!agent) return;
		const note = await store.pick({ title: "What is to be done when it reports something?", items: [{ value: "-", label: "Nothing in particular", about: "the agent decides by the event" }], free: true, placeholder: "A note that is shown with every event" });
		if (note === undefined) return;
		const details = note === "-" ? {} : { note };
		const done = await store.attempt(() => (agent === "*" ? api.subscribeAll(name, details) : api.subscribe(agent, name, details)));
		if (done) (store.flash(`${agent === "*" ? "All agents are" : `${agent} is`} subscribed to ${name}.`, "good"), sources.reload());
	};
	const unsubscribe = async (name: string, who: string) => {
		const [agent, session] = who.split("/");
		const done = await store.attempt(() => (who === "*" || who === "all agents" ? api.unsubscribeAll(name) : api.unsubscribe(agent, name, session ?? "main")));
		if (done) sources.reload();
	};
	return (
		<>
			<div className="row"><span className="muted grow">What can wake an agent: a folder, a web address, a chat, a device. A source costs nothing until somebody is subscribed to it.</span><Button variant="primary" icon="plus" disabled={!types.data} onClick={() => setAdding(true)}>New source</Button></div>
			<div className="group">
				{sources.data ? (
					sources.data.length ? (
						sources.data.map((x) => (
							<div className="item" key={`${x.scope}:${x.name}`} style={{ alignItems: "flex-start" }}>
								<span className={`dot ${x.error ? "bad" : x.running ? "good" : ""}`} style={{ marginTop: 7 }} />
								<div className="info">
									<div className="name">{x.name}<span className="tag">{x.type}</span><span className="tag">{scopeText(x.scope)}</span>{x.trust === "owner" ? <span className="tag good">yours</span> : null}</div>
									{x.description ? <div className="about">{x.description}</div> : null}
									<div className="about faint">{x.error ? `not running: ${x.error}` : x.running ? (x.status ?? "running") : "idle, nobody is subscribed"} · {x.last ? `last event ${ago(x.last.ts)}, ${x.events} since start` : "no events since start"}</div>
									<div className="row" style={{ flexWrap: "wrap", marginTop: 5, gap: 5 }}>
										{x.subscribers.map((who) => <span className="tag" key={who}>{who}<span style={{ cursor: "pointer" }} title="End this subscription" onClick={() => void unsubscribe(x.name, who)}><Icon name="x" size={10} /></span></span>)}
										<Button small variant="ghost" icon="plus" onClick={() => void subscribe(x.name)}>Subscribe</Button>
									</div>
								</div>
								<div className="ctl"><Confirm icon="trash" label="Remove this source" sure="Remove?" onConfirm={() => void store.attempt(() => api.removeSource(x.name, x.scope === "global" ? undefined : x.scope)).then((r) => r && (store.flash(`Removed the event source ${x.name}.`), sources.reload()))} /></div>
							</div>
						))
					) : (
						<Empty icon="bolt" title="No event sources yet">Add one, or ask an agent: “watch ~/Scans”, “tell me when the price drops”.</Empty>
					)
				) : (
					<Loading state={sources} />
				)}
			</div>
			{adding && types.data ? <NewSource types={types.data} close={() => setAdding(false)} made={() => (setAdding(false), sources.reload())} /> : null}
		</>
	);
}

function Schedules() {
	const { api } = usePine();
	const list = useLoad(() => api.schedules());
	const [f, setF] = useState({ name: "", kind: "cron" as "cron" | "every" | "at" | "in", when: "", task: "", agent: "" });
	const hint = { cron: "minute hour day month weekday, for example 0 7 * * 1-5 (weekdays at seven)", every: "an interval, for example 30m or 6h", at: "a moment, for example 2026-12-24T17:00", in: "from now, for example 20m" }[f.kind];
	const add = async () => {
		const done = await store.attempt(() => api.addSchedule({ name: f.name.trim(), task: f.task.trim(), [f.kind]: f.when.trim(), agent: f.agent || undefined } as any));
		if (!done) return;
		store.flash(`Scheduled ${done.name}: ${done.when}.`, "good");
		setF({ ...f, name: "", when: "", task: "" });
		list.reload();
	};
	return (
		<>
			<div className="muted">What happens because of the time. A schedule wakes an agent with a task, in your name.</div>
			<div className="group">
				{list.data ? (
					list.data.length ? (
						list.data.map((x) => (
							<div className="item" key={`${x.scope}:${x.name}`}>
								<Icon name="clock" className="faint" />
								<div className="info">
									<div className="name">{x.name}<span className="tag">{scopeText(x.scope, x.session)}</span><span className="tag">{x.when}</span>{x.next ? <span className="tag good">next {new Date(x.next).toLocaleString("sv-SE").slice(0, 16)}</span> : null}</div>
									<div className="about">{x.task ?? `publishes ${x.topic}`}</div>
								</div>
								<div className="ctl"><Confirm icon="trash" label="Remove this schedule" sure="Remove?" onConfirm={() => void store.attempt(() => api.removeSchedule(x.name, x.scope === "global" ? undefined : x.scope)).then((r) => r && list.reload())} /></div>
							</div>
						))
					) : (
						<div className="item"><div className="about muted">Nothing is scheduled. An agent schedules something when you ask it to (“every morning at seven …”, “remind me at five”).</div></div>
					)
				) : (
					<Loading state={list} />
				)}
				<div className="form">
					<Field label="Name"><input className="input mono" placeholder="morning" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} /></Field>
					<Field label="For"><Whom value={f.agent} onChange={(agent) => setF({ ...f, agent })} /></Field>
					<Field label="When"><Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind, when: "" })} options={[{ value: "cron", label: "At set times" }, { value: "every", label: "Every" }, { value: "at", label: "Once, at" }, { value: "in", label: "Once, in" }]} /></Field>
					<Field label=" " hint={hint}><input className="input mono" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></Field>
					<Field label="Task" wide hint="What the agent is to do when it is time, written so that it is enough on its own."><AutoText value={f.task} onChange={(task) => setF({ ...f, task })} minRows={2} maxRows={8} /></Field>
				</div>
				<div className="form-foot"><Button variant="primary" disabled={!f.name.trim() || !f.when.trim() || !f.task.trim()} onClick={() => void add()}>Add schedule</Button></div>
			</div>
		</>
	);
}

function Routes() {
	const { api, agents } = usePine();
	const list = useLoad(() => api.routes());
	const s = useModel(store);
	const empty = { name: "", on: "", when: "", agent: "", prompt: "", session: "", throttle: "", set: "", publish_topic: "", publish_payload: "" };
	const [f, setF] = useState(empty);
	const add = async () => {
		const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || undefined]));
		const done = await store.attempt(() => api.addRoute(body));
		if (!done) return;
		store.flash(`Added the route ${done.name}: ${done.lines.join("; ")}.${done.wider ? ` Note: ${done.wider}` : ""}`, done.wider ? "warn" : "good", 8000);
		setF(empty);
		list.reload();
	};
	const does = (r: NonNullable<typeof list.data>[number]) => [r.set ? `sets ${JSON.stringify(r.set)}` : "", r.call ? `asks a model: ${short(r.call.prompt, 80)}` : "", r.publish ? `publishes ${r.publish.topic}` : "", r.agent ? `wakes ${r.agent}${r.session ? ` (${r.session})` : ""}${r.prompt ? ` with: ${short(r.prompt, 100)}` : ""}` : ""].filter(Boolean).join("; ");
	return (
		<>
			<div className="muted">Rules that turn an event into something: wake an agent, write shared state, publish another event. A subscription is the simple case and needs no route.</div>
			<div className="group">
				{list.data ? (
					list.data.length ? (
						list.data.map((r) => (
							<div className="item" key={r.name}>
								<div className="info">
									<div className="name">{r.name}<span className="tag mono">on {r.on.join(", ")}</span>{r.when ? <span className="tag mono">when {short(JSON.stringify(r.when), 60)}</span> : null}{r.trust === "owner" ? <span className="tag warn">counts as your words</span> : null}</div>
									<div className="about">{does(r)}</div>
								</div>
								<div className="ctl"><Confirm icon="trash" label="Remove this route" sure="Remove?" onConfirm={() => void store.attempt(() => api.removeRoute(r.name)).then((x) => x && list.reload())} /></div>
							</div>
						))
					) : (
						<div className="item"><div className="about muted">No routes.</div></div>
					)
				) : (
					<Loading state={list} />
				)}
				<div className="form">
					<Field label="Name"><input className="input mono" placeholder="door" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} /></Field>
					<Field label="On" hint="Topic patterns, separated by commas."><input className="input mono" placeholder="source/house/message" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></Field>
					<Field label="Only when" hint="Optional, as JSON."><input className="input mono" placeholder={'{"payload.open": true}'} value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></Field>
					<Field label="At most one per" hint="Optional, a time such as 5m."><input className="input mono" value={f.throttle} onChange={(e) => setF({ ...f, throttle: e.target.value })} /></Field>
					<Field label="Wake the agent">
						<select className="input" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}><option value="">nobody</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}</select>
					</Field>
					<Field label="In the conversation" hint="Empty: its main one. “new”: a fresh one for every event."><input className="input mono" disabled={!f.agent} value={f.session} onChange={(e) => setF({ ...f, session: e.target.value })} /></Field>
					<Field label="With" wide hint="What it is told. {{payload.field}} stands for a value of the event."><input className="input" disabled={!f.agent} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} /></Field>
					<Field label="Set shared state" hint="Optional, as JSON."><input className="input mono" placeholder={'{"house/mode": "{{payload.value}}"}'} value={f.set} onChange={(e) => setF({ ...f, set: e.target.value })} /></Field>
					<Field label="Publish the event" hint="Optional: a topic of your own."><input className="input mono" value={f.publish_topic} onChange={(e) => setF({ ...f, publish_topic: e.target.value })} /></Field>
				</div>
				<div className="form-foot"><Button variant="primary" disabled={!f.name.trim() || !f.on.trim()} onClick={() => void add()}>Add route</Button></div>
			</div>
		</>
	);
}

function EventsPage() {
	const [tab, setTab] = useState<"sources" | "schedules" | "routes">("sources");
	return (
		<Page title="Events" lead="What reaches your agents without you typing: sources that report, schedules that fire, and routes between them." actions={<Button icon="wave" onClick={() => void store.openEvents()}>Open the event log</Button>}>
			<Segmented value={tab} onChange={setTab} options={[{ value: "sources", label: "Sources", icon: "bolt" }, { value: "schedules", label: "Schedules", icon: "clock" }, { value: "routes", label: "Routes", icon: "branch" }]} />
			{tab === "sources" ? <Sources /> : tab === "schedules" ? <Schedules /> : <Routes />}
		</Page>
	);
}

// ---- instructions for all agents -------------------------------------------------------------------------

function Instructions() {
	const { api } = usePine();
	const files = useLoad(() => api.shared());
	const [name, setName] = useState("AGENTS.md");
	const [texts, setTexts] = useState<Record<string, string>>({});
	const file = files.data?.find((f) => f.name === name);
	const text = texts[name] ?? file?.text ?? "";
	const dirty = file !== undefined && text !== file.text;
	const save = async () => {
		if (!dirty) return;
		const done = await store.attempt(() => api.setShared(name, text));
		if (!done) return;
		store.flash(`Saved ${name}. It reaches every agent with its next message.`, "good");
		setTexts((was) => Object.fromEntries(Object.entries(was).filter(([k]) => k !== name)));
		files.reload();
	};
	return (
		<Page title="Instructions" lead="What holds for all agents: three files in pine's home that are put into every agent's prompt. The main agent keeps them when you tell it something that is for everybody; here you can read and change them yourself." actions={<Button variant="primary" disabled={!dirty} onClick={() => void save()}>Save {name}</Button>}>
			{files.data ? (
				<div className="group">
					<div className="item" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
						<Segmented value={name} onChange={setName} options={files.data.map((f) => ({ value: f.name, label: f.name }))} />
						<div style={{ color: "var(--muted)", fontSize: 12.5 }}>{file?.about}</div>
					</div>
					<div style={{ height: 460, display: "flex" }}><Editor key={name} file={name} text={text} onChange={(v) => setTexts((was) => ({ ...was, [name]: v }))} onSave={() => void save()} /></div>
				</div>
			) : (
				<Loading state={files} />
			)}
			<div className="notice plain"><Icon name="info" />What only one agent should know or do goes into that agent's own files, on its page under Agents.</div>
		</Page>
	);
}

// ---- the app itself ----------------------------------------------------------------------------------------

function AppPage() {
	const s = useModel(store);
	const set = async (change: Record<string, unknown>) => {
		s.prefs = await bridge.prefs(change);
		s.touch();
	};
	// The pine on this computer: the one this app can start, restart and give another home.
	const local = s.env("local");
	const service = local?.enabled && local.service.status === "ready" ? local.service : undefined;
	const newer = s.update?.status === "newer" ? s.update : undefined;
	// `pine` for a terminal: what the shell has, as the app's main process sees it.
	const [command, setCommand] = useState<{ state: "none" | "here" | "other" | "unavailable"; why?: string; text: string }>();
	useEffect(() => void bridge.command().then(setCommand), []);
	// (Looked at again whenever this page is opened: the browser may have been fetched in a terminal.)
	useEffect(() => void store.checkBrowser(), []);
	return (
		<Page title="App" lead="How this window behaves, and the pine on this computer.">
			<h2>This app</h2>
			<div className="group">
				<div className="item"><div className="info"><div className="name">Appearance</div><div className="about">Light, dark, or what the system is set to.</div></div><div className="ctl"><Segmented value={s.prefs.theme} onChange={(theme) => void set({ theme })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></div></div>
				{s.updates ? (
					<div className="item updates">
						<div className="info">
							<div className="name">Pine {s.versions.app}{newer ? <span className="tag warn">{newer.version} is available</span> : s.update?.status === "latest" ? <span className="tag good">the latest version</span> : null}</div>
							<div className="about">{newer ? "The new app is a disk image on the release's page on GitHub: download it and put the app in place of this one. Your pine home stays as it is." : "The app does not update itself. It asks GitHub for pine's last release, and says so when that is newer."}</div>
						</div>
						<div className="ctl">
							{newer ? <Button small icon="external" onClick={() => void bridge.open(newer.url)}>Release page</Button> : null}
							<Button small icon="refresh" disabled={s.updateLooking} onClick={() => void s.lookForUpdate(true)}>Check now</Button>
						</div>
					</div>
				) : null}
				{s.updates ? <div className="item"><div className="info"><div className="name">Look for a newer version at the start</div><div className="about">One question to GitHub each time the app starts. It says nothing about this Mac or your pine.</div></div><div className="ctl"><Switch on={s.prefs.updates} onChange={(updates) => void set({ updates })} /></div></div> : null}
				<div className="item"><div className="info"><div className="name">Notifications</div><div className="about">When an agent is done, stops with an error, needs your approval or asks you something while the window is not in front. The text is pine's own, never the agent's.</div></div><div className="ctl"><Switch on={s.prefs.notify} onChange={(notify) => void set({ notify })} /></div></div>
			</div>
			<h2>pine on this Mac</h2>
			<div className="group">
				<div className="item"><div className="info"><div className="name">{service ? `pine ${service.version ?? ""}` : "pine"}<span className={`tag ${service && local?.connected ? "good" : "warn"}`}>{!local?.enabled ? "off" : service && local.connected ? "connected" : "not connected"}</span></div><div className="about">{!local?.enabled ? "This environment is off: turn it on under Environments." : service ? (service.started ? `Started by this app (${service.mode}), from ${service.from}. It stops when the app quits unless the switch below is on.` : "Attached to a pine that was already running. It goes on when this app quits.") : "Not running."}</div></div><div className="ctl">{service?.started ? <Button small icon="refresh" onClick={() => void s.attempt(() => bridge.restart("local"))}>Restart</Button> : null}</div></div>
				<div className="item"><div className="info"><div className="name">Keep pine running after the app quits</div><div className="about">A pine this app starts then goes on in the background: schedules fire, sources report and Telegram answers while the window is closed. Holds from the next time the app starts pine.</div></div><div className="ctl"><Switch on={s.prefs.keepRunning} onChange={(keepRunning) => void set({ keepRunning })} /></div></div>
				{command && (command.state !== "unavailable" || command.why) ? (
					<div className="item command"><div className="info"><div className="name">pine in a terminal{command.state === "here" ? <span className="tag good">set up</span> : null}</div><div className="about">{command.text}</div></div><div className="ctl">{command.state === "none" ? <Button small onClick={() => void bridge.command("install").then(setCommand)}>Set up</Button> : command.state === "here" ? <Button small onClick={() => void bridge.command("remove").then(setCommand)}>Remove</Button> : null}</div></div>
				) : null}
				{s.browser !== undefined || s.browserFetching ? (
					<div className="item browser">
						<div className="info">
							<div className="name">Browser for the web tools<span className={`tag ${s.browser ? "good" : "warn"}`}>{s.browser ? "on this Mac" : "not on this Mac"}</span></div>
							<div className="about">{s.browser ? "The browser your agents open pages with, in the build this pine drives." : "Each version of pine drives a browser build of its own, and this one's is not here: it was never fetched, or it is the build of an older pine. About 600 MB, once. Until then the browser tools do not work; web search and reading a page do."}</div>
							{!s.browser && s.initLines.length ? <pre className="log">{s.initLines.slice(-12).join("\n")}</pre> : null}
						</div>
						{s.browser ? null : <div className="ctl"><Button small disabled={s.browserFetching} onClick={() => void s.fetchBrowser()}>{s.browserFetching ? <><Spinner size={11} /> Fetching…</> : "Fetch it"}</Button></div>}
					</div>
				) : null}
				<div className="item">
					<div className="info"><div className="name">Home folder</div><div className="about mono">{tilde(service?.home ?? s.prefs.home ?? "~/.pine")}</div><div className="about">Where pine keeps its agents and settings. Another one is another pine. Changing it restarts a pine this app started.</div></div>
					<div className="ctl">
						{s.prefs.home ? <Button small onClick={() => void set({ home: "" }).then(() => bridge.retry("local"))}>Use ~/.pine</Button> : null}
						<Button small icon="folder" onClick={() => void bridge.pickFolder("A pine home folder").then((dir: string | undefined) => dir && set({ home: dir }).then(() => (service?.started ? bridge.restart("local") : bridge.retry("local"))))}>Choose…</Button>
					</div>
				</div>
			</div>
			<div className="faint" style={{ fontSize: 12 }}>Pine {s.versions.app} · Electron {s.versions.electron}</div>
		</Page>
	);
}

/**
 * Where pine runs: this computer, and other machines reached over SSH. Each that is on is
 * connected and shown at the same time; one that fails holds up none of the others.
 */
function Environments() {
	const s = useModel(store);
	const [host, setHost] = useState("");
	const [trying, setTrying] = useState<string>();
	const [failed, setFailed] = useState<{ host: string; error: string }>();
	/** Another machine: connected to first, and kept only when its pine answers. */
	const add = async () => {
		const h = host.trim();
		if (!h) return;
		setTrying(h);
		setFailed(undefined);
		const r = await bridge.addEnvironment(h).finally(() => setTrying(undefined));
		if (r.error) return setFailed({ host: h, error: r.error });
		setHost("");
	};
	const said = (r: { error?: string }) => r.error && s.flash(r.error, "bad");
	const tag = (e: Env) => (!e.enabled ? <span className="tag">off</span> : e.service.status === "error" ? <span className="tag warn">not reached</span> : e.service.status === "starting" ? <span className="tag warn">connecting</span> : e.connected ? <span className="tag good">connected</span> : <span className="tag warn">reconnecting</span>);
	const about = (e: Env) => {
		const st = e.service;
		if (!e.enabled) return e.host ? "A pine on that machine, over SSH. Off: not connected and not shown." : "The pine on this computer. Off: not used and not shown.";
		if (st.status === "ready") return e.host ? `pine ${st.version ?? ""} · ${st.home} · over SSH, through a port of this computer` : `pine ${st.version ?? ""} · ${tilde(st.home)} · ${st.started ? "started by this app" : "attached to a pine that was already running"}`;
		if (st.status === "error") return <span style={{ color: "var(--bad)" }}>{st.message}</span>;
		return e.host ? "Connecting over SSH…" : "Looking for a running pine, or starting one…";
	};
	return (
		<Page title="Environments" lead="Where the pines this app talks to run: this computer, and other machines you reach with ssh. Each one that is on is connected and stands in the side bar with its agents, all at the same time. Its conversations, folders and settings are that machine's.">
			<div className="group">
				{s.envs.map((e) => (
					<div className="item" key={e.id} data-environment={e.id}>
						<div className="info"><div className={`name${e.host ? " mono" : ""}`}>{e.host ?? "This Mac"}{tag(e)}</div><div className="about">{about(e)}</div></div>
						<div className="ctl">
							{e.enabled && e.service.status === "error" ? <Button small icon="refresh" onClick={() => void bridge.retry(e.id)}>Try again</Button> : null}
							{e.host && !e.enabled ? <Button small variant="ghost" icon="trash" title={`Forget ${e.host}`} onClick={() => void bridge.forgetEnvironment(e.id).then(said)} /> : null}
							<Switch on={e.enabled} onChange={(on) => void bridge.enableEnvironment(e.id, on).then(said)} />
						</div>
					</div>
				))}
			</div>
			<h2>Add an SSH environment</h2>
			<div className="group">
				<div className="item">
					<div className="info"><div className="name">Host</div><div className="about">As you would write it after ssh: host or user@host, or a name from ~/.ssh/config. The app connects to it at once and keeps it when its pine answers. It cannot type a password, so it needs a key in ssh-agent or Tailscale SSH.</div></div>
					<div className="ctl">
						<input className="input mono" style={{ width: 220 }} placeholder="user@host" value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
						<Button small disabled={!host.trim() || Boolean(trying)} onClick={() => void add()}>{trying ? <><Spinner size={11} /> Connecting…</> : "Add and connect"}</Button>
					</div>
				</div>
				{failed ? <div className="notice bad"><Icon name="alert" />Could not add {failed.host}: {failed.error}</div> : null}
			</div>
		</Page>
	);
}

/** Of which environment's pine the pages are, where several are on: their agents, models and files are each its own. */
const PER_PINE = new Set(["general", "agents", "models", "mcp", "skills", "events", "instructions"]);

export function Settings() {
	const s = useModel(store);
	const several = s.shown.filter((e) => e.ready);
	return (
		<div className="settings">
			<nav className="set-nav">
				{several.length > 1 && PER_PINE.has(s.section) ? (
					<label className="set-env" title="The environment whose pine these pages show and change">
						<span className="faint">Settings of</span>
						<select className="input" value={s.settingsEnv} onChange={(e) => ((s.settingsEnv = e.target.value), (s.settingsAgent = undefined), s.touch())}>
							{several.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
						</select>
					</label>
				) : null}
				{SECTIONS.map((x) => (
					<div key={x.id} className={`side-row${s.section === x.id ? " on" : ""}`} onClick={() => ((s.section = x.id), (s.settingsAgent = undefined), s.touch())}><Icon name={x.icon} size={14} /><span>{x.label}</span></div>
				))}
			</nav>
			<div className="set-page" key={`${s.settingsEnv}:${s.section}`}>
				<PineOfPage.Provider value={s.settingsEnv}>
					{s.section === "agents" ? <Agents /> : s.section === "models" ? <Models /> : s.section === "mcp" ? <Mcp /> : s.section === "skills" ? <Skills /> : s.section === "events" ? <EventsPage /> : s.section === "instructions" ? <Instructions /> : s.section === "environments" ? <Environments /> : s.section === "app" ? <AppPage /> : <General />}
				</PineOfPage.Provider>
			</div>
		</div>
	);
}
