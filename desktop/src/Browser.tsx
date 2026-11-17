// The browser of a conversation, in the panel beside it. It is the browser the agent works in:
// another process, behind pine's guard, without a window. What is shown here is a picture of its
// page that the daemon hands over again and again, and what is done in the picture (a click, the
// wheel, keys, an address) goes back to it through the daemon. Nothing of a web page is loaded
// into this window: the picture is drawn, and its address and title are text.
import { useEffect, useRef, useState } from "react";
import { apiFor, type BrowserState, media } from "./api.ts";
import { store, type Tab, useModel } from "./model.ts";
import { errText } from "./text.ts";
import { Button, Empty, Icon, Spinner } from "./ui.tsx";

type Op = Record<string, unknown> & { do: string };

/** A key as the browser's own keyboard names it, with what is held down with it; nothing for a key that only types its letter. */
function keyOf(e: React.KeyboardEvent): string | undefined {
	const held = `${e.metaKey ? "Meta+" : ""}${e.ctrlKey ? "Control+" : ""}${e.altKey ? "Alt+" : ""}`;
	const named = ["Enter", "Backspace", "Tab", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F5"].includes(e.key);
	if (named) return `${held}${e.shiftKey ? "Shift+" : ""}${e.key}`;
	// A letter or a digit with Cmd or Ctrl: select all, copy inside the page, undo.
	if ((e.metaKey || e.ctrlKey) && /^(Key[A-Z]|Digit[0-9])$/.test(e.code)) return `${held}${e.shiftKey ? "Shift+" : ""}${e.code}`;
	return undefined;
}

export function BrowserView({ tab }: { tab: Tab }) {
	useModel(tab);
	const canvas = useRef<HTMLCanvasElement>(null);
	const line = useRef<HTMLInputElement>(null);
	const [state, setState] = useState<BrowserState>();
	const [address, setAddress] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [drawn, setDrawn] = useState(false);
	/** What was done and is not sent yet: typing and the wheel come in bursts, and go as one. */
	const pending = useRef<{ ops: Op[]; timer?: number; sending: boolean }>({ ops: [], sending: false });
	const front = state?.tabs[state.current];

	const took = (next: BrowserState | undefined) => {
		if (!next) return;
		setState(next);
		if (next.error) store.flash(next.error, "warn", 6000);
	};

	// Where the browser is: asked while this view is open, and again after the agent used it.
	useEffect(() => {
		let over = false;
		const look = () => void apiFor(tab.env).browser(tab.agent, tab.session).then((s) => !over && setState(s), () => {});
		look();
		const timer = window.setInterval(look, 1500);
		return () => {
			over = true;
			window.clearInterval(timer);
		};
	}, [tab.env, tab.agent, tab.session, tab.codeTick]);

	// The picture: one after another while a page is open, each drawn when it is whole.
	const open = state?.open === true;
	useEffect(() => {
		if (!open) return void setDrawn(false);
		let over = false;
		let n = 0;
		let timer: number | undefined;
		const next = (after: number) => (timer = window.setTimeout(load, after));
		const load = () => {
			if (over) return;
			// A window that is not looked at asks for nothing.
			if (document.hidden) return next(1000);
			const picture = new Image();
			picture.onload = () => {
				if (over) return;
				const c = canvas.current;
				if (c) {
					if (c.width !== picture.naturalWidth || c.height !== picture.naturalHeight) [c.width, c.height] = [picture.naturalWidth, picture.naturalHeight];
					c.getContext("2d")?.drawImage(picture, 0, 0);
					setDrawn(true);
				}
				next(120);
			};
			// No picture this time (the page is busy, or it was closed): the last one stays, and it is asked again.
			picture.onerror = () => next(700);
			picture.src = media.browser(tab.env, tab.agent, tab.session, ++n);
		};
		load();
		return () => {
			over = true;
			window.clearTimeout(timer);
		};
	}, [open, tab.agent, tab.session]);

	// The page is laid out for the room it has here, so that it is shown point for point: said when the
	// view opens and when the panel is made wider or narrower.
	const room = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = room.current;
		if (!open || !el) return;
		const fit = () => {
			const box = el.getBoundingClientRect();
			const [w, h] = [Math.round(box.width), Math.round(box.height)];
			const c = canvas.current;
			if (w >= 320 && h >= 240 && (c?.width !== w || c?.height !== h)) act({ do: "size", w, h }, 250);
		};
		fit();
		const watch = new ResizeObserver(fit);
		watch.observe(el);
		return () => watch.disconnect();
	}, [open]);

	const flush = async () => {
		const p = pending.current;
		window.clearTimeout(p.timer);
		p.timer = undefined;
		if (p.sending || !p.ops.length) return;
		p.sending = true;
		const ops = p.ops.splice(0);
		try {
			took(await apiFor(tab.env).browserInput(tab.agent, tab.session, ops));
		} catch (e) {
			store.flash(errText(e), "bad");
		}
		p.sending = false;
		if (p.ops.length) void flush();
	};
	/** Queue something that was done. `wait`: how long more of the same may still join it. */
	const act = (op: Op, wait = 0) => {
		const p = pending.current;
		const last = p.ops.at(-1);
		// Letters join the letters before them, the wheel adds up, and of the pointer's way only the end counts.
		if (op.do === "text" && last?.do === "text") last.text = `${last.text}${op.text}`;
		else if (op.do === "wheel" && last?.do === "wheel") [last.dx, last.dy] = [Number(last.dx) + Number(op.dx), Number(last.dy) + Number(op.dy)];
		else if (op.do === "move" && last?.do === "move") [last.x, last.y] = [op.x, op.y];
		else if (op.do === "size" && last?.do === "size") [last.w, last.h] = [op.w, op.h];
		else p.ops.push(op);
		window.clearTimeout(p.timer);
		if (wait) p.timer = window.setTimeout(() => void flush(), wait);
		else void flush();
	};

	/** A place in the window as a place in the page: the picture is the page, point for point, drawn smaller or larger. */
	const at = (e: { clientX: number; clientY: number }) => {
		const c = canvas.current!;
		const box = c.getBoundingClientRect();
		return { x: Math.round(((e.clientX - box.left) * c.width) / box.width), y: Math.round(((e.clientY - box.top) * c.height) / box.height) };
	};
	const down = useRef<{ x: number; y: number }>(undefined);

	const go = async (url: string) => {
		if (!url.trim()) return;
		setBusy(true);
		try {
			took(await apiFor(tab.env).browserOpen(tab.agent, tab.session, url.trim()));
			setAddress(undefined);
			canvas.current?.focus();
		} catch (e) {
			store.flash(errText(e), "bad");
		}
		setBusy(false);
	};

	return (
		<div className="code-body browser">
			<div className="browser-bar">
				<Button small variant="ghost" icon="back" title="Back" disabled={!open} onClick={() => act({ do: "back" })} />
				<Button small variant="ghost" icon="right" title="Forward" disabled={!open} onClick={() => act({ do: "forward" })} />
				<Button small variant="ghost" icon="refresh" title="Load the page again" disabled={!open} onClick={() => act({ do: "reload" })} />
				<input
					className="input browser-address"
					spellCheck={false}
					placeholder="An address: example.com, or localhost:3000"
					ref={line}
					value={address ?? (front?.url === "about:blank" ? "" : (front?.url ?? ""))}
					onChange={(e) => setAddress(e.target.value)}
					onFocus={(e) => e.target.select()}
					onBlur={() => setAddress(undefined)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void go(e.currentTarget.value);
						if (e.key === "Escape") (setAddress(undefined), e.currentTarget.blur());
					}}
				/>
				{busy ? <Spinner size={12} /> : null}
			</div>
			{open && state.tabs.length ? (
				<div className="browser-tabs">
					{state.tabs.map((t, i) => (
						<div key={i} className={`browser-tab${i === state.current ? " on" : ""}`} title={t.url} onClick={() => i !== state.current && act({ do: "tab", index: i })}>
							<span className="cut grow">{t.title || (t.url === "about:blank" ? "New tab" : t.url)}</span>
							{/* (The last tab stays: a browser without one would open one again.) */}
							{state.tabs.length > 1 ? <button type="button" className="browser-tab-close" title="Close this tab" onClick={(e) => (e.stopPropagation(), act({ do: "closetab", index: i }))}><Icon name="x" size={10} /></button> : null}
						</div>
					))}
					<Button small variant="ghost" icon="plus" title="A new tab" onClick={() => (act({ do: "newtab" }), line.current?.focus())} />
				</div>
			) : null}
			{open ? (
				<div className="browser-page" ref={room}>
					<canvas
						ref={canvas}
						tabIndex={0}
						className={drawn ? "" : "blank"}
						title={front?.title}
						onMouseDown={(e) => {
							e.currentTarget.focus();
							down.current = at(e);
						}}
						onMouseUp={(e) => {
							const from = down.current;
							down.current = undefined;
							if (!from) return;
							const to = at(e);
							// The button held down over a way is a drag (a slider, a selection); let go where it went down, a click.
							if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 8) act({ do: "drag", ...from, x2: to.x, y2: to.y });
							else act({ do: "click", ...to, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", count: Math.min(3, Math.max(1, e.detail)) });
						}}
						onMouseMove={(e) => !down.current && act({ do: "move", ...at(e) }, 120)}
						onContextMenu={(e) => e.preventDefault()}
						onWheel={(e) => act({ do: "wheel", dx: e.deltaX, dy: e.deltaY }, 60)}
						onPaste={(e) => {
							e.preventDefault();
							const text = e.clipboardData.getData("text/plain");
							if (text) act({ do: "text", text });
						}}
						onKeyDown={(e) => {
							// Pasting is the window's own business: what is in the clipboard arrives as text (onPaste).
							if ((e.metaKey || e.ctrlKey) && e.code === "KeyV") return;
							const key = keyOf(e);
							if (key) (e.preventDefault(), act({ do: "key", key }));
							else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) (e.preventDefault(), act({ do: "text", text: e.key }, 90));
						}}
					/>
					{drawn ? null : <div className="browser-wait"><Spinner size={14} /></div>}
				</div>
			) : (
				<Empty icon="eye" title={state ? "No page is open" : "Looking for the browser…"}>
					{state ? "This is the browser the agent of this conversation works in. A page it opens is shown here as it is, and you can use it too: click, type, log in. Type an address above to open one yourself." : null}
				</Empty>
			)}
			{open ? <div className="browser-foot faint"><Icon name="shield" size={11} /><span className="cut">The agent's browser, behind pine's guard. What you do here, the agent sees when it next looks.</span></div> : null}
		</div>
	);
}
