// The panel beside a conversation: the agent itself (AgentView.tsx), then its work: the files
// with an editor, what changed in the folder (git), what the last message changed, what the
// agent's tool calls printed, and what its commands left running. Everything is read through the control API; a file is written through it too, by
// the daemon, inside a sandbox that reaches only this folder.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";
import { apiFor, type Change, media, type TranscriptEntry } from "./api.ts";
import { AgentView } from "./AgentView.tsx";
import { bridge } from "./bridge.ts";
import { BrowserView } from "./Browser.tsx";
import { Steps } from "./Conversation.tsx";
import { type CodeView, mediaKind, store, type Tab, useModel, useSignal } from "./model.ts";
import { clock, errText, oneLine, plural, short, size, tilde, took } from "./text.ts";
import { Button, Confirm, Empty, Icon, Segmented, Pulse, useLoad } from "./ui.tsx";

// ---- the editor ------------------------------------------------------------------------------------

// The editor says what a token is, and styles.css what it looks like: the colours differ between light and
// dark (dark is poimandres, which tells more kinds of keyword apart than light does).
const colours = HighlightStyle.define([
	{ tag: [t.comment], class: "t-comment" },
	{ tag: [t.meta], class: "t-meta" },
	{ tag: [t.keyword], class: "t-kw" },
	{ tag: [t.definitionKeyword], class: "t-kw-def" },
	{ tag: [t.controlKeyword], class: "t-kw-flow" },
	{ tag: [t.moduleKeyword, t.modifier, t.operatorKeyword, t.self], class: "t-kw-mod" },
	{ tag: [t.string, t.special(t.string)], class: "t-str" },
	{ tag: [t.regexp, t.escape], class: "t-re" },
	{ tag: [t.number, t.atom, t.url], class: "t-num" },
	{ tag: [t.bool], class: "t-bool" },
	{ tag: [t.null], class: "t-nil" },
	{ tag: [t.variableName], class: "t-var" },
	{ tag: [t.propertyName], class: "t-prop" },
	{ tag: [t.attributeName], class: "t-attr" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], class: "t-call" },
	{ tag: [t.function(t.definition(t.variableName)), t.definition(t.function(t.propertyName))], class: "t-fn" },
	{ tag: [t.className, t.definition(t.className)], class: "t-cls" },
	{ tag: [t.typeName], class: "t-type" },
	{ tag: [t.namespace], class: "t-ns" },
	{ tag: [t.tagName], class: "t-tag" },
	{ tag: [t.heading], class: "t-head" },
	{ tag: [t.emphasis], class: "t-em" },
	{ tag: [t.strong], class: "t-strong" },
	{ tag: [t.link], class: "t-link" },
	{ tag: [t.inserted], class: "t-ins" },
	{ tag: [t.deleted, t.invalid], class: "t-del" },
	{ tag: [t.punctuation, t.bracket], class: "t-punct" },
	{ tag: [t.operator], class: "t-op" },
]);

function language(file: string): Extension {
	const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
	if (ext === "tsx") return javascript({ typescript: true, jsx: true });
	if (["js", "mjs", "cjs", "jsx"].includes(ext)) return javascript({ jsx: true });
	if (["json", "jsonc"].includes(ext)) return json();
	if (["md", "markdown", "mdx"].includes(ext)) return markdown();
	if (["css", "scss"].includes(ext)) return css();
	if (["html", "htm", "vue", "svelte", "xml", "svg"].includes(ext)) return html();
	if (ext === "py") return python();
	if (ext === "rs") return rust();
	if (["yml", "yaml"].includes(ext)) return yaml();
	return [];
}

/** A text editor. `text` is what is on disk; what is typed is told with `onChange`, and ⌘S asks to save. */
export function Editor({ file, text, readOnly, onChange, onSave }: { file: string; text: string; readOnly?: boolean; onChange?: (text: string) => void; onSave?: () => void }) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView>(undefined);
	const lock = useRef(new Compartment());
	const live = useRef({ onChange, onSave });
	live.current = { onChange, onSave };
	useEffect(() => {
		const v = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: text,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightActiveLine(),
					history(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightSelectionMatches(),
					search({ top: true }),
					syntaxHighlighting(colours),
					language(file),
					EditorView.lineWrapping,
					keymap.of([{ key: "Mod-s", run: () => (live.current.onSave?.(), true) }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
					lock.current.of([EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)]),
					EditorView.updateListener.of((u) => u.docChanged && live.current.onChange?.(u.state.doc.toString())),
				],
			}),
		});
		view.current = v;
		return () => v.destroy();
		// A new file is a new editor; what it shows of the old one is replaced below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [file]);
	useEffect(() => {
		const v = view.current;
		if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
	}, [text]);
	useEffect(() => {
		view.current?.dispatch({ effects: lock.current.reconfigure([EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)]) });
	}, [readOnly]);
	return <div className="editor" ref={host} />;
}

/** A unified diff, coloured line by line. */
export function Diff({ text }: { text: string }) {
	const lines = text.split("\n");
	return (
		<div className="diff">
			{lines.map((l, i) => {
				const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("new file") || l.startsWith("deleted file") || l.startsWith("similarity") || l.startsWith("rename ") ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
				return <div key={i} className={cls}>{l || " "}</div>;
			})}
		</div>
	);
}

// ---- its views -------------------------------------------------------------------------------------

function ChangeRow({ c, on, pick }: { c: Change; on: boolean; pick: () => void }) {
	const at = c.path.lastIndexOf("/");
	return (
		<div className={`frow${on ? " on" : ""}`} onClick={pick} title={c.path}>
			<span className={`st ${c.status === "?" ? "Q" : c.status}`}>{c.status === "?" ? "U" : c.status}</span>
			<span className="cut">{c.path.slice(at + 1)}</span>
			<span className="faint cut grow">{at > 0 ? c.path.slice(0, at) : ""}</span>
			{c.added ? <span className="plus">+{c.added}</span> : null}
			{c.removed ? <span className="minus">−{c.removed}</span> : null}
		</div>
	);
}

/** What differs from the last commit, or from before the owner's last message. */
function Changes({ tab, turn, openFile }: { tab: Tab; turn: boolean; openFile: (file: string) => void }) {
	const list = useLoad(async () => (turn ? { ...(await apiFor(tab.env).turn(tab.agent, tab.session)), repo: true, branch: undefined as string | undefined, worktree: undefined } : { ...(await apiFor(tab.env).changes(tab.agent, tab.session)), note: undefined as string | undefined, prompt: undefined as string | undefined }), [tab.key, tab.codeTick, turn]);
	const [file, setFile] = useState<string>();
	const diff = useLoad(async () => (file ? (turn ? apiFor(tab.env).turnDiff(tab.agent, tab.session, file) : apiFor(tab.env).diff(tab.agent, tab.session, file)) : undefined), [tab.key, file, tab.codeTick, turn]);
	useEffect(() => setFile(undefined), [tab.key, turn]);
	const data = list.data;
	// A change is named from the top of its repository; a file is opened by its path in the folder.
	const inFolder = (p: string) => {
		const top = (data as { top?: string } | undefined)?.top;
		const root = data?.root;
		const prefix = top && root && root !== top && root.startsWith(`${top}/`) ? `${root.slice(top.length + 1)}/` : "";
		return prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
	};
	if (list.error) return <Empty icon={turn ? "undo" : "branch"} title={turn ? "Nothing to show" : "No changes to show"}>{turn ? "No message of yours in this conversation changed a file that pine records." : list.error}</Empty>;
	if (!data) return <Empty title=""><Pulse /></Empty>;
	if (!turn && !data.repo) return <Empty icon="branch" title="Not a git repository">The folder this conversation works in has no git history, so there are no changes to show. The files are in the Files view.</Empty>;
	if (file)
		return (
			<>
				<div className="code-sub">
					<Button small variant="ghost" icon="back" onClick={() => setFile(undefined)} title="Back to the list" />
					<span className="cut grow mono" title={file}>{file}</span>
					<Button small variant="ghost" icon="edit" onClick={() => openFile(inFolder(file))}>Edit</Button>
				</div>
				<div className="code-body">{diff.data ? <><Diff text={diff.data.diff || "No difference."} />{diff.data.truncated ? <div className="out">… the rest of this diff is too long to show.</div> : null}</> : <Empty title="">{diff.error ?? <Pulse />}</Empty>}</div>
			</>
		);
	return (
		<>
			<div className="code-sub">
				{turn ? <><Icon name="undo" size={13} /><span className="cut grow">{data.prompt ? `Since “${short(oneLine(data.prompt), 60)}”` : "Since your last message"}</span>{data.files.length ? <Button small onClick={() => void store.undo(tab, false)}>Take back</Button> : null}</> : <><Icon name="branch" size={13} /><span className="cut grow">{data.branch || "no branch"}{data.worktree ? ` · ${data.worktree.ahead} ahead of ${data.worktree.base}${data.worktree.behind ? `, ${data.worktree.behind} behind` : ""}` : ""} · {data.files.length ? plural(data.files.length, "changed file") : "clean"}</span>{data.worktree ? <Button small onClick={() => void store.worktreeMenu(tab)}>{data.worktree.ahead && !data.worktree.dirty ? "Merge…" : "Worktree…"}</Button> : null}</>}
				<Button small variant="ghost" icon="refresh" onClick={list.reload} title="Read again" />
			</div>
			<div className="code-body">
				{data.note ? <div className="out">{data.note}</div> : null}
				{data.files.length ? data.files.map((c) => <ChangeRow key={c.path} c={c} on={false} pick={() => setFile(c.path)} />) : <Empty icon="check" title={turn ? "The last message changed no files" : "Nothing changed since the last commit"} />}
				{data.more ? <div className="out">… and more.</div> : null}
			</div>
		</>
	);
}

interface TreeState {
	open: Set<string>;
	dirs: Map<string, Array<{ name: string; dir: boolean; size: number }>>;
	file?: string;
}
const trees = new Map<string, TreeState>();
const treeOf = (key: string): TreeState => trees.get(key) ?? (trees.set(key, { open: new Set(), dirs: new Map() }), trees.get(key)!);

function Tree({ tab, dir, depth, pick, tick }: { tab: Tab; dir: string; depth: number; pick: (file: string) => void; tick: number }) {
	const state = treeOf(tab.key);
	const [, redraw] = useState(0);
	useEffect(() => {
		let live = true;
		apiFor(tab.env).tree(tab.agent, tab.session, dir).then(
			(r) => live && (state.dirs.set(dir, r.entries), redraw((n) => n + 1)),
			() => live && (state.dirs.set(dir, []), redraw((n) => n + 1)),
		);
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tab.key, dir, tick]);
	const entries = state.dirs.get(dir);
	if (!entries) return depth ? null : <Empty title=""><Pulse /></Empty>;
	if (!entries.length && !depth) return <Empty icon="folder" title="This folder is empty" />;
	return (
		<>
			{entries.map((e) => {
				const full = dir ? `${dir}/${e.name}` : e.name;
				const open = state.open.has(full);
				return (
					<div key={full}>
						<div
							className={`frow${state.file === full ? " on" : ""}`}
							style={{ paddingLeft: 10 + depth * 14 }}
							onClick={() => {
								if (!e.dir) return pick(full);
								if (open) state.open.delete(full);
								else state.open.add(full);
								redraw((n) => n + 1);
							}}
						>
							{e.dir ? <Icon name={open ? "down" : "right"} size={11} className="faint" /> : <span style={{ width: 11 }} />}
							<Icon name={e.dir ? "folder" : "file"} size={13} className="faint" />
							<span className="cut grow">{e.name}</span>
							{!e.dir ? <span className="faint" style={{ fontSize: 11 }}>{size(e.size)}</span> : null}
						</div>
						{e.dir && open ? <Tree tab={tab} dir={full} depth={depth + 1} pick={pick} tick={tick} /> : null}
					</div>
				);
			})}
		</>
	);
}

/** One file, to read and to change. What the agent changes meanwhile is shown unless the owner has typed. */
function FileView({ tab, file, close }: { tab: Tab; file: string; close: () => void }) {
	const disk = useLoad(() => apiFor(tab.env).file(tab.agent, tab.session, file), [tab.key, file, tab.codeTick]);
	const [draft, setDraft] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [base, setBase] = useState<string>();
	const kind = mediaKind(file);
	const text = disk.data?.text;
	const dirty = draft !== undefined && draft !== base;
	// What is on disk becomes what the editor shows, as long as nothing was typed.
	useEffect(() => {
		if (text !== undefined && !dirty) (setBase(text), setDraft(undefined));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text]);
	useEffect(() => (setDraft(undefined), setBase(undefined)), [file]);
	const save = async () => {
		if (!dirty || saving) return;
		setSaving(true);
		try {
			await apiFor(tab.env).writeFile(tab.agent, tab.session, file, draft!);
			setBase(draft);
			tab.codeTick++;
			tab.touch();
			store.flash(`Saved ${file}.`, "good", 1800);
		} catch (e) {
			store.flash(`Not saved: ${errText(e)}`, "bad");
		}
		setSaving(false);
	};
	useSignal("save", () => void save());
	const changedOnDisk = dirty && text !== undefined && text !== base;
	const root = tab.folder ?? tab.workspace;
	return (
		<>
			<div className="code-sub">
				<Button small variant="ghost" icon="back" onClick={() => (dirty && !window.confirm(`Leave ${file} without saving what you typed?`) ? undefined : close())} title="Back to the files" />
				<span className="cut grow mono" title={file}>{file}{dirty ? <span style={{ color: "var(--warn)" }}> ●</span> : null}</span>
				{disk.data?.truncated ? <span className="tag warn">too large to edit</span> : null}
				{root ? <Button small variant="ghost" icon="external" title="Show in the Finder" onClick={() => void bridge.reveal(`${root}/${file}`)} /> : null}
				{kind || disk.data?.binary ? null : <Button small variant={dirty ? "primary" : "ghost"} icon="save" disabled={!dirty || saving} onClick={() => void save()}>Save</Button>}
			</div>
			{changedOnDisk ? (
				<div className="banner warn" style={{ margin: 8 }}>
					<span className="grow">This file changed on disk while you were typing.</span>
					<button type="button" className="open-link" onClick={() => (setBase(text), setDraft(undefined))}>Take the new one</button>
				</div>
			) : null}
			<div className="code-body">
				{kind ? (
					<div className="it-media" style={{ padding: 14 }}>{kind === "image" ? <img src={media.workspace(tab.env, tab.agent, file, tab.session)} alt={file} /> : kind === "video" ? <video src={media.workspace(tab.env, tab.agent, file, tab.session)} controls /> : <audio src={media.workspace(tab.env, tab.agent, file, tab.session)} controls />}</div>
				) : disk.error ? (
					<Empty icon="file" title="This file cannot be shown">{disk.error}</Empty>
				) : !disk.data ? (
					<Empty title=""><Pulse /></Empty>
				) : disk.data.binary ? (
					<Empty icon="file" title="A binary file">{size(disk.data.size)}. It is not shown as text.</Empty>
				) : (
					<Editor file={file} text={dirty ? draft! : (base ?? text ?? "")} readOnly={disk.data.truncated} onChange={setDraft} onSave={() => void save()} />
				)}
			</div>
		</>
	);
}

function Files({ tab, file, setFile }: { tab: Tab; file?: string; setFile: (file?: string) => void }) {
	const [tick, setTick] = useState(0);
	const [query, setQuery] = useState("");
	const found = useLoad(async () => (query.trim() ? (await apiFor(tab.env).find(tab.agent, tab.session, query.trim())).files : undefined), [tab.key, query]);
	useEffect(() => setTick((n) => n + 1), [tab.codeTick]);
	if (file) return <FileView tab={tab} file={file} close={() => setFile(undefined)} />;
	const root = tab.folder ?? tab.workspace;
	return (
		<>
			<div className="code-sub">
				<Icon name="search" size={13} />
				<input className="grow" style={{ border: "none", outline: "none", background: "transparent", userSelect: "text" }} placeholder={root ? `Find a file in ${tilde(root)}` : "Find a file"} value={query} onChange={(e) => setQuery(e.target.value)} />
				<Button small variant="ghost" icon="refresh" onClick={() => setTick((n) => n + 1)} title="Read again" />
			</div>
			<div className="code-body">
				{query.trim() ? (
					found.data?.length ? found.data.map((f) => <div key={f} className="frow" onClick={() => setFile(f)}><Icon name="file" size={13} className="faint" /><span className="cut">{f}</span></div>) : <Empty title={found.loading ? "" : "No file fits"}>{found.loading ? <Pulse /> : null}</Empty>
				) : (
					<Tree tab={tab} dir="" depth={0} pick={setFile} tick={tick} />
				)}
			</div>
		</>
	);
}

/** The tool calls of the last messages, each with what it printed. */
function Output({ tab }: { tab: Tab }) {
	const calls = useLoad(async () => {
		const tasks = (await apiFor(tab.env).history(tab.agent, tab.session, 8)).filter((x) => x.depth === 0 && !x.meta?.compact);
		const out: Array<{ task: number; n: number; entry: TranscriptEntry }> = [];
		for (const task of tasks) {
			const entries = (await apiFor(tab.env).transcript(task.id, true).catch(() => undefined))?.entries ?? [];
			entries.filter((e) => e.kind === "tool").forEach((entry, n) => out.push({ task: task.id, n, entry }));
		}
		return out;
	}, [tab.key, tab.codeTick]);
	const [open, setOpen] = useState<string>();
	if (!calls.data) return <Empty title="">{calls.error ?? <Pulse />}</Empty>;
	if (!calls.data.length) return <Empty icon="terminal" title="No tool calls yet">What the agent's commands and tools print appears here.</Empty>;
	const shown = calls.data.find((c) => `${c.task}:${c.n}` === open);
	if (shown)
		return (
			<>
				<div className="code-sub">
					<Button small variant="ghost" icon="back" onClick={() => setOpen(undefined)} />
					<span className="mono">{shown.entry.tool}</span>
					<span className="cut grow mono faint">{shown.entry.subject}</span>
					<Button small variant="ghost" icon="copy" title="Copy the output" onClick={() => void navigator.clipboard.writeText(shown.entry.result ?? "")} />
				</div>
				<div className="code-body">
					<div className="out" style={shown.entry.ok === false ? { color: "var(--bad)" } : undefined}>{shown.entry.result || "(it printed nothing)"}</div>
					{(shown.entry.images ?? []).map((id) => <div className="it-media" key={id} style={{ padding: 12 }}><img src={media.tool(tab.env, id)} alt="" /></div>)}
				</div>
			</>
		);
	return (
		<div className="code-body">
			{calls.data.map((c) => (
				<div key={`${c.task}:${c.n}`} className="frow" onClick={() => setOpen(`${c.task}:${c.n}`)}>
					<span className="st" style={{ color: c.entry.ok === false ? "var(--bad)" : c.entry.ok ? "var(--accent)" : "var(--warn)" }}>{c.entry.ok === false ? "✗" : c.entry.ok ? "✓" : "●"}</span>
					<span className="mono">{c.entry.tool}</span>
					<span className="cut grow mono faint">{c.entry.subject ? oneLine(c.entry.subject) : ""}</span>
					{c.entry.ms !== undefined ? <span className="faint" style={{ fontSize: 11 }}>{took(c.entry.ms)}</span> : null}
				</div>
			))}
		</div>
	);
}

/** What the conversation's commands left running, and the way to stop each. */
function Running({ tab }: { tab: Tab }) {
	if (!tab.programs.length) return <Empty icon="play" title="Nothing is running">A dev server or a watcher the agent starts keeps running after its turn. It is listed here, and stopped from here.</Empty>;
	return (
		<div className="code-body">
			{tab.programs.map((p) => (
				<div className="prog" key={p.id}>
					<div className="row">
						<span className="dot good" />
						<span className="mono cut grow" title={p.command}>{p.command}</span>
						<Confirm label="Stop" sure="Stop it?" onConfirm={() => void store.attempt(() => apiFor(tab.env).stopProgram(tab.agent, tab.session, p.id)).then(() => store.flash("Stopping…"))} />
					</div>
					<div className="row faint" style={{ fontSize: 12 }}>
						<span>running for {clock(p.seconds)}</span>
						<span>· {plural(p.processes, "process", "processes")}</span>
						{p.background ? <span>· in the background</span> : null}
						{p.ports.map((port) => (
							<button key={port} type="button" className="open-link" title="Opens in the browser beside this conversation" onClick={() => void store.showInBrowser(tab, `http://localhost:${port}`)}>localhost:{port}</button>
						))}
					</div>
					{p.output ? <div className="entry-result" style={{ marginLeft: 0 }}>{p.output}</div> : null}
				</div>
			))}
		</div>
	);
}

const WIDTH_KEY = "pine.code.width";

export function CodePanel({ tab }: { tab: Tab }) {
	useModel(tab);
	useModel(store);
	const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 520);
	const [drag, setDrag] = useState(false);
	const state = treeOf(tab.key);
	const [, redraw] = useState(0);
	const view = store.codeView;
	const setView = (v: CodeView) => ((store.codeView = v), store.touch());
	const setFile = (file?: string) => ((state.file = file), redraw((n) => n + 1));
	const steps = tab.steps?.items.some((s) => s.status !== "done") ? tab.steps.items : undefined;
	return (
		<>
			<div
				className={`splitter${drag ? " drag" : ""}`}
				onMouseDown={(e) => {
					e.preventDefault();
					setDrag(true);
					const from = e.clientX;
					const was = width;
					let now = was;
					const move = (m: MouseEvent) => setWidth((now = Math.max(320, Math.min(window.innerWidth - 420, was + from - m.clientX))));
					const up = () => {
						setDrag(false);
						localStorage.setItem(WIDTH_KEY, String(now));
						window.removeEventListener("mousemove", move);
						window.removeEventListener("mouseup", up);
					};
					window.addEventListener("mousemove", move);
					window.addEventListener("mouseup", up);
				}}
			/>
			<div className="code" style={{ width }}>
				<div className="code-head">
					<Segmented
						value={view}
						onChange={setView}
						options={[
							{ value: "agent", label: "Agent" },
							{ value: "files", label: "Files" },
							{ value: "changes", label: "Changes" },
							{ value: "turn", label: "Last turn" },
							{ value: "browser", label: "Browser" },
							{ value: "output", label: "Output" },
							{ value: "running", label: "Running", badge: tab.programs.length || undefined },
						]}
					/>
					<span className="grow" />
					<Button small variant="ghost" icon="x" title="Close the panel" onClick={() => void store.command("code")} />
				</div>
				{steps ? <div className="code-steps"><Steps items={steps} /></div> : null}
				{view === "agent" ? (
					<AgentView tab={tab} />
				) : view === "changes" || view === "turn" ? (
					<Changes tab={tab} turn={view === "turn"} openFile={(f) => (setFile(f), setView("files"))} />
				) : view === "files" ? (
					<Files tab={tab} file={state.file} setFile={setFile} />
				) : view === "browser" ? (
					<BrowserView tab={tab} />
				) : view === "output" ? (
					<Output tab={tab} />
				) : (
					<Running tab={tab} />
				)}
			</div>
		</>
	);
}
