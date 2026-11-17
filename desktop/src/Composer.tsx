// Where the owner writes: the message, the files that go with it, and under it what the
// conversation runs on (folder, model, reasoning, mode), each a click away.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFor } from "./api.ts";
import { bridge } from "./bridge.ts";
import { COMMANDS, runSlash } from "./commands.ts";
import { type Attachment, store, type Tab, useModel, useSignal } from "./model.ts";
import { baseName, size, tilde } from "./text.ts";
import { Icon } from "./ui.tsx";

const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 10;

const toBase64 = (buf: ArrayBuffer) => {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(out);
};

/** Files for the next message. A folder is not attached: it is opened for the conversation. */
export async function attach(tab: Tab, files: File[]): Promise<void> {
	for (const file of files) {
		if (tab.attachments.length >= MAX_FILES) return store.flash("At most 10 files per message.", "bad");
		if (file.size > MAX_FILE) {
			store.flash(`${file.name} is larger than 20 MB.`, "bad");
			continue;
		}
		const name = file.name || `pasted-${Date.now()}.png`;
		if (tab.attachments.some((a) => a.name === name && a.size === file.size)) continue;
		const item: Attachment = { name, size: file.size, data: toBase64(await file.arrayBuffer()) };
		if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) item.preview = URL.createObjectURL(file);
		tab.attachments.push(item);
	}
	tab.touch();
}

interface Suggestion {
	value: string;
	label: string;
	about?: string;
}

export function Composer({ tab }: { tab: Tab }) {
	useModel(tab);
	useModel(store);
	const area = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	const [items, setItems] = useState<Suggestion[]>([]);
	const [at, setAt] = useState(0);
	const [kind, setKind] = useState<"slash" | "file" | undefined>();
	const recall = useRef(-1);
	// Dictating: what is heard is put after what was typed, and is text in the input and nothing
	// more. It is never sent by itself.
	const [voice, setVoice] = useState<"off" | "starting" | "listening">("off");
	const [voiceNote, setVoiceNote] = useState("");
	const typed = useRef("");
	const hearing = useRef(false);
	const text = tab.draft;
	const info = store.agent(tab.env, tab.agent);

	const set = (value: string) => {
		tab.draft = value;
		tab.touch();
	};

	useLayoutEffect(() => {
		const el = area.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
	}, [text, tab.id]);

	useEffect(() => {
		area.current?.focus();
	}, [tab.id]);

	const heard = (said: string) => `${typed.current}${typed.current && !/\s$/.test(typed.current) && said ? " " : ""}${said}`;
	/** `cancel`: nothing more is put into the input. Otherwise "that was all": the last words still arrive. */
	const endVoice = (cancel: boolean) => {
		if (cancel) {
			hearing.current = false;
			setVoice("off");
			setVoiceNote("");
		}
		void bridge.voiceStop(cancel);
	};
	const dictate = async () => {
		if (voice !== "off") return endVoice(false);
		if (store.platform !== "darwin") return store.flash("Voice input needs a Mac: it uses the speech recognition macOS has on the device.");
		typed.current = tab.draft;
		hearing.current = true;
		setVoice("starting");
		try {
			await bridge.voiceStart(store.voiceLanguage);
		} catch (e) {
			hearing.current = false;
			setVoice("off");
			store.flash(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "bad", 9000);
		}
	};
	useEffect(
		() =>
			bridge.onVoice((m: { type: string; text?: string; state?: string; error?: string }) => {
				if (!hearing.current) return;
				if (m.type === "ready") setVoice("listening");
				else if (m.type === "model") setVoiceNote(m.state === "downloading" ? "the system is fetching its speech model for this language, once" : "");
				else if (m.type === "partial") set(heard(m.text ?? ""));
				else if (m.type === "done") {
					hearing.current = false;
					setVoice("off");
					setVoiceNote("");
					if (m.text) set(heard(m.text));
					if (m.error) store.flash(m.error, "bad", 8000);
					area.current?.focus();
				}
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[tab],
	);
	// Leaving the conversation ends the listening.
	useEffect(() => () => void (hearing.current && bridge.voiceStop(true)), []);

	// A menu asked for something only this part can do.
	useSignal("voice", () => void dictate());
	useSignal("attach", () => picker.current?.click());
	useSignal("focus-input", () => area.current?.focus());

	/** What is being typed right before the cursor: a command at the start of the input, or a file after an @. */
	const suggest = async (value: string, cursor: number) => {
		const before = value.slice(0, cursor);
		if (/^\/[a-z]*$/i.test(before)) {
			const word = before.slice(1).toLowerCase();
			setKind("slash");
			setAt(0);
			return setItems(COMMANDS.filter((c) => c.name.startsWith(word)).map((c) => ({ value: c.name, label: `/${c.name}${c.hint ? ` ${c.hint}` : ""}`, about: c.about })));
		}
		const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (mention) {
			const found = await apiFor(tab.env).find(tab.agent, tab.session, mention[1].split("#")[0]).catch(() => ({ files: [] as string[] }));
			// What was typed meanwhile decides whether the answer is still wanted.
			if (area.current && area.current.value.slice(0, area.current.selectionStart) !== before) return;
			for (const f of found.files) tab.files.add(f);
			setKind("file");
			setAt(0);
			return setItems(found.files.slice(0, 12).map((f) => ({ value: f, label: f })));
		}
		setKind(undefined);
		setItems([]);
	};

	const take = (s: Suggestion) => {
		const el = area.current!;
		const cursor = el.selectionStart;
		const before = text.slice(0, cursor);
		const next = kind === "slash" ? `/${s.value} ` : `${before.replace(/@([^\s@]*)$/, `@${s.value} `)}`;
		const whole = kind === "slash" ? next : next + text.slice(cursor);
		set(whole);
		setItems([]);
		setKind(undefined);
		requestAnimationFrame(() => {
			el.focus();
			const pos = kind === "slash" ? whole.length : next.length;
			el.setSelectionRange(pos, pos);
		});
	};

	const send = async (whenBusy: "steer" | "queue") => {
		const value = text.trim();
		if (!value) return;
		recall.current = -1;
		setItems([]);
		if (value.startsWith("/") && !value.startsWith("//")) {
			tab.inputs.push(value);
			set("");
			return runSlash(value.slice(1), tab);
		}
		await store.submit(tab, value, whenBusy);
	};

	const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		if (voice !== "off") {
			// Enter says "that was all" and sends nothing; escape throws away what was heard.
			if (e.key === "Enter") return (e.preventDefault(), endVoice(false));
			if (e.key === "Escape") return (e.preventDefault(), endVoice(true), set(typed.current));
		}
		if (items.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				return setAt((at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && (kind === "file" || items[at].value !== text.slice(1).trim()))) {
				e.preventDefault();
				return take(items[at]);
			}
			if (e.key === "Escape") {
				e.preventDefault();
				return setItems([]);
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			return void send(e.altKey ? "queue" : "steer");
		}
		if (e.key === "Escape" && tab.busy) {
			e.preventDefault();
			return void store.stop(tab);
		}
		// Next mode, as in the terminal UI: while the input is empty.
		if (e.key === "Tab" && e.shiftKey && !text) {
			e.preventDefault();
			const order = ["auto", "plan", "safe", "manual", "bypass"];
			return void store.setMode(tab, order[(order.indexOf(store.modeOf(tab)) + 1) % order.length]);
		}
		// Earlier inputs, while nothing was typed or one of them is shown.
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && tab.inputs.length && (!text || recall.current >= 0) && !text.includes("\n")) {
			const next = e.key === "ArrowUp" ? (recall.current < 0 ? tab.inputs.length - 1 : Math.max(0, recall.current - 1)) : recall.current + 1;
			if (e.key === "ArrowDown" && recall.current < 0) return;
			e.preventDefault();
			if (next >= tab.inputs.length) {
				recall.current = -1;
				return set("");
			}
			recall.current = next;
			return set(tab.inputs[next]);
		}
	};

	const onDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setOver(false);
		const list = [...e.dataTransfer.items].filter((i) => i.kind === "file");
		const files: File[] = [];
		for (const entry of list) {
			const file = entry.getAsFile();
			if (!file) continue;
			// A folder is opened for the conversation, as with /folder.
			if (entry.webkitGetAsEntry()?.isDirectory) {
				const remote = store.remoteOf(tab.env);
				if (remote) {
					store.flash(`A folder of this computer is not there for the pine on ${remote}. Give it one of ${remote} with the folder button.`, "bad", 7000);
					continue;
				}
				const dir = bridge.pathOf(file);
				if (dir) await store.setFolder(tab, dir);
			} else files.push(file);
		}
		if (files.length) await attach(tab, files);
		area.current?.focus();
	};

	const mode = store.modeOf(tab);
	const paused = store.bypassPaused(tab);
	const tainted = store.taintOf(tab);
	const modeTone = paused ? "warn" : mode === "bypass" ? "bad" : mode === "safe" ? "good" : mode === "plan" ? "plan" : "";
	const goal = tab.goal && tab.goal.status !== "met" ? tab.goal : undefined;

	return (
		<>
			{goal && goal.status !== "active" ? (
				<div className="banner warn">
					<Icon name="clock" size={14} />
					<span className="grow cut">Goal {goal.status === "paused" ? "paused" : goal.status === "blocked" ? "waits for you" : "at its limit"}: {goal.note}</span>
					<button type="button" className="open-link" onClick={() => void store.setGoal(tab, "resume")}>Resume</button>
					<button type="button" className="open-link" onClick={() => void store.setGoal(tab, "clear")}>Clear</button>
				</div>
			) : null}
			{items.length ? (
				<div className="suggest">
					{items.map((s, i) => (
						<div key={s.value} className={`pick-item${i === at ? " on" : ""}`} onMouseMove={() => at !== i && setAt(i)} onMouseDown={(e) => (e.preventDefault(), take(s))}>
							<span className="label mono">{s.label}</span>
							{s.about ? <span className="about">{s.about}</span> : null}
						</div>
					))}
				</div>
			) : null}
			{voice !== "off" ? (
				<div className="banner">
					<span className="dot bad" />
					<span className="grow">{voice === "starting" ? "getting ready to listen…" : "listening · speak · ↩ when you are done · esc to throw it away"}{voiceNote ? ` · ${voiceNote}` : ""}</span>
				</div>
			) : null}
			<div
				className={`composer${over ? " over" : ""}`}
				onDragOver={(e) => {
					if (![...e.dataTransfer.types].includes("Files")) return;
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => void onDrop(e)}
			>
				{tab.attachments.length ? (
					<div className="attachments">
						{tab.attachments.map((f, i) => (
							<span className="attachment" key={`${f.name}:${i}`}>
								{f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={13} />}
								<span className="cut" style={{ maxWidth: 180 }}>{f.name}</span>
								<span className="faint">{size(f.size)}</span>
								<button type="button" className="btn btn-ghost btn-small btn-icon" title="Remove" onClick={() => (tab.attachments.splice(i, 1), tab.touch())}><Icon name="x" size={12} /></button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					ref={area}
					rows={1}
					value={text}
					placeholder={tab.busy ? `Say something to ${tab.agent} while it works…` : `Message ${tab.agent} · / for commands · @ for files`}
					onChange={(e) => {
						// A key that types ends the listening: what was heard stays, and nothing more is put into the input.
						if (voice !== "off") endVoice(true);
						recall.current = -1;
						set(e.target.value);
						void suggest(e.target.value, e.target.selectionStart);
					}}
					onKeyDown={onKey}
					onPaste={(e) => {
						const files = [...e.clipboardData.files];
						if (!files.length) return;
						e.preventDefault();
						void attach(tab, files);
					}}
					onBlur={() => window.setTimeout(() => setItems([]), 120)}
				/>
				<div className="composer-bar">
					<button type="button" className="chip plus-btn" title="Attach files (or drop them here)" onClick={() => picker.current?.click()}><Icon name="plus" size={15} /></button>
					<button type="button" className="chip gives model" title={`Model: ${info?.model ?? "none"}`} onClick={() => void store.pickModel(tab)}>
						<Icon name="cpu" size={13} />
						<span className="cut">{info?.model?.split("/").pop() ?? "model"}</span>
					</button>
					<button type="button" className="chip thinks" title={`How much the model thinks before it answers: ${info?.thinking ?? "off"}`} onClick={() => void store.pickReasoning(tab)}>
						<Icon name="spark" size={13} />
						<span>{info?.thinking ?? "off"}</span>
					</button>
					<button type="button" className={`chip ${modeTone}`} title="How much this agent does without asking" onClick={() => void store.pickMode(tab)}>
						<Icon name="shield" size={13} />
						<span>{mode}{paused ? " (paused)" : ""}</span>
					</button>
					<button type="button" className="chip gives" title={tab.folder ? `Works in ${tab.folder}` : "Where this conversation works: the agent's own workspace, or a folder of yours"} onClick={() => void store.pickFolder(tab)}>
						<Icon name="folder" size={13} />
						<span className="cut">{tab.folder ? baseName(tab.folder) : "its workspace"}</span>
					</button>
					{tainted ? <span className="chip warn" title={`This conversation has read outside content (${tainted}): the agent asks before it sends something out.`}><Icon name="eye" size={13} /><span className="label">outside content</span></span> : null}
					<span className="grow" />
					{store.platform === "darwin" ? <button type="button" className={`chip${voice !== "off" ? " bad" : ""}`} title={voice === "off" ? "Dictate the message (⌃R)" : "End the listening"} onClick={() => void dictate()}><Icon name="mic" size={14} /></button> : null}
					{tab.busy && !text.trim() ? (
						<button type="button" className="send stop" title="Stop (esc)" onClick={() => void store.stop(tab)}><Icon name="stop" size={12} /></button>
					) : (
						<button type="button" className="send" title={tab.busy ? "Give it to the agent while it works (↩) · ⌥↩ waits its turn" : "Send (↩)"} disabled={!text.trim()} onClick={() => void send("steer")}><Icon name="up" size={15} /></button>
					)}
				</div>
				<input ref={picker} type="file" multiple hidden onChange={(e) => (void attach(tab, [...(e.target.files ?? [])]), (e.target.value = ""))} />
			</div>
			{tab.folder && !tab.items.length ? <div className="faint" style={{ fontSize: 11.5, padding: "6px 4px 0" }}>{tab.agent}'s tools start in {tilde(tab.folder)} and may read and change what is in it.</div> : null}
		</>
	);
}
