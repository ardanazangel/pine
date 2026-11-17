// An answer, drawn. What an agent writes can repeat what a web page told it to write, so the
// text is treated as content from outside: it is parsed, cleaned of everything that could act
// (scripts, styles, forms, frames), and then three things are settled by this file and not by
// the text:
//
//   - a link opens in the owner's browser, only for http(s), and its address stands next to it
//     whenever its words are not the address itself: what is seen is what a click opens;
//   - a picture, video or sound at a path is shown from the agent's workspace, through the daemon;
//   - one at a web address is never fetched because an answer contains it. It is a line to
//     click, and then the daemon fetches it (the page's own policy allows no address on the web).
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { memo, useEffect, useRef } from "react";
import { apiFor, media } from "./api.ts";
import { bridge } from "./bridge.ts";
import { mediaKind } from "./model.ts";
import { errText, short } from "./text.ts";

marked.setOptions({ gfm: true, breaks: false });

const CLEAN = {
	RETURN_DOM_FRAGMENT: true as const,
	FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "object", "embed", "svg", "math", "video", "audio", "source", "track", "link", "meta", "base", "template", "slot", "dialog", "marquee"],
	FORBID_ATTR: ["style", "srcset", "class", "id", "name", "action", "formaction", "ping", "background", "poster", "loading", "usemap"],
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
};

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export interface Where {
	/** The environment whose pine the agent is of: its files and pictures are fetched there. */
	env: string;
	agent: string;
	session?: string;
}

/** A line to click instead of a picture: the address is shown, and nothing is fetched before the click. */
function remote(url: string, alt: string, env: string): HTMLElement {
	const kind = mediaKind(url.split(/[?#]/)[0]) ?? "image";
	const el = document.createElement("span");
	el.className = "md-remote";
	el.dataset.remote = url;
	// The pine that fetches it, on the click: the one whose agent wrote it.
	el.dataset.env = env;
	el.dataset.alt = alt;
	el.title = url;
	el.textContent = `Load ${kind === "image" ? "picture" : kind} · ${short(url, 90)}`;
	return el;
}

function player(kind: "image" | "video" | "audio", src: string, alt: string): HTMLElement {
	const fig = document.createElement("figure");
	fig.className = `md-media md-${kind}`;
	const el = document.createElement(kind === "image" ? "img" : kind);
	el.setAttribute("src", src);
	if (kind === "image") {
		el.setAttribute("alt", alt);
		el.setAttribute("draggable", "false");
		el.dataset.zoom = "1";
	} else {
		el.setAttribute("controls", "");
		el.setAttribute("preload", "metadata");
	}
	fig.append(el);
	if (alt) {
		const cap = document.createElement("figcaption");
		cap.textContent = alt;
		fig.append(cap);
	}
	return fig;
}

/** Code blocks keep the language the text named: the cleaning above takes class names away, so it is read before. */
export function draw(text: string, where?: Where): DocumentFragment {
	const langs: string[] = [];
	const renderer = new marked.Renderer();
	renderer.code = ({ text: body, lang }) => {
		langs.push((lang ?? "").trim().split(/\s+/)[0] ?? "");
		const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return `<pre><code>${escaped}</code></pre>\n`;
	};
	const html = marked.parse(text, { async: false, renderer }) as string;
	const frag = DOMPurify.sanitize(html, CLEAN) as unknown as DocumentFragment;
	decorate(frag, where);
	// Only the blocks this renderer wrote are numbered: a <pre> the text wrote as HTML has no language.
	let n = 0;
	for (const pre of frag.querySelectorAll("pre")) {
		const code = pre.querySelector(":scope > code");
		if (!code) continue;
		const lang = langs[n++] ?? "";
		const source = code.textContent ?? "";
		if (lang && hljs.getLanguage(lang)) {
			try {
				// The highlighter escapes what it is given; its output is markup of its own making.
				code.innerHTML = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
				refine(code);
			} catch {
				// shown without colours
			}
		}
		const box = document.createElement("div");
		box.className = "md-code";
		const head = document.createElement("div");
		head.className = "md-code-head";
		const name = document.createElement("span");
		name.textContent = lang || "text";
		const copy = document.createElement("span");
		copy.className = "md-copy";
		copy.dataset.copy = "1";
		copy.textContent = "Copy";
		head.append(name, copy);
		pre.replaceWith(box);
		box.append(head, pre);
	}
	for (const table of frag.querySelectorAll("table")) {
		const wrap = document.createElement("div");
		wrap.className = "md-table";
		table.replaceWith(wrap);
		wrap.append(table);
	}
	return frag;
}

// The highlighter has one class for every keyword and one for every constant. The theme of the dark look
// (poimandres) tells them apart, so the ones it colours differently get a second class. Light ignores it.
const KW_MOD = new Set(["import", "export", "from", "default", "as", "async", "static", "new", "this", "super", "self", "public", "private", "protected", "readonly", "abstract", "override", "declare", "extends", "implements", "pub", "mut", "use", "package"]);
const KW_FLOW = new Set(["return", "await", "yield", "break", "continue"]);
const KW_PLAIN = new Set(["if", "else", "elif", "for", "while", "do", "switch", "case", "match", "in", "of", "loop", "then", "fi", "done", "esac", "end", "with", "and", "or", "not", "is"]);
const KW_BAD = new Set(["try", "catch", "finally", "throw", "throws", "raise", "except", "delete", "del", "void", "panic", "unsafe"]);
const NIL = new Set(["false", "null", "undefined", "nil", "none", "nan"]);

function refine(code: Element): void {
	for (const el of code.querySelectorAll(".hljs-keyword, .hljs-literal")) {
		const word = (el.textContent ?? "").trim();
		// Some languages (JSON) mark true, false and null as keywords.
		if (NIL.has(word.toLowerCase())) el.classList.add("nil");
		else if (el.classList.contains("hljs-literal") || word === "true") el.classList.add("lit");
		else if (KW_MOD.has(word)) el.classList.add("kw-mod");
		else if (KW_FLOW.has(word)) el.classList.add("kw-flow");
		else if (KW_PLAIN.has(word)) el.classList.add("kw-plain");
		else if (KW_BAD.has(word)) el.classList.add("kw-bad");
	}
	code.classList.add("hl");
}

function decorate(frag: DocumentFragment, where?: Where): void {
	for (const a of frag.querySelectorAll("a")) {
		const href = a.getAttribute("href") ?? "";
		a.removeAttribute("href");
		a.removeAttribute("target");
		if (!isWeb(href)) {
			const span = document.createElement("span");
			span.textContent = href && a.textContent !== href ? `${a.textContent} (${href})` : (a.textContent ?? "");
			a.replaceWith(span);
			continue;
		}
		a.dataset.href = href;
		a.title = href;
		a.className = "md-link";
		const shown = (a.textContent ?? "").trim();
		if (shown !== href && shown !== href.replace(/^https?:\/\//, "").replace(/\/$/, "")) {
			const target = document.createElement("span");
			target.className = "md-target";
			target.textContent = short(href.replace(/^https?:\/\//, ""), 72);
			target.dataset.href = href;
			// Beside the link, not inside it: it is the address in plain letters, not more of the link's words.
			a.after(target);
		}
	}
	for (const img of frag.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? "";
		const alt = img.getAttribute("alt") ?? "";
		if (isWeb(src)) img.replaceWith(remote(src, alt, where?.env ?? "local"));
		else if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) img.replaceWith(player("image", src, alt));
		else if (where && src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
			const kind = mediaKind(src.split(/[?#]/)[0]);
			let file = src;
			try {
				file = decodeURIComponent(src);
			} catch {
				// as written
			}
			if (kind) img.replaceWith(player(kind, media.workspace(where.env, where.agent, file, where.session), alt));
			else img.replaceWith(document.createTextNode(alt || src));
		} else img.replaceWith(document.createTextNode(alt || src));
	}
}

/** What a click inside drawn text does: open a link, copy a block, fetch a picture, enlarge one. */
async function onClick(e: MouseEvent): Promise<void> {
	const el = e.target as HTMLElement;
	const link = el.closest<HTMLElement>("[data-href]");
	if (link) {
		e.preventDefault();
		return void bridge.open(link.dataset.href!);
	}
	const copy = el.closest<HTMLElement>("[data-copy]");
	if (copy) {
		await navigator.clipboard.writeText(copy.closest(".md-code")?.querySelector("pre")?.textContent ?? "");
		copy.textContent = "Copied";
		return void window.setTimeout(() => (copy.textContent = "Copy"), 1200);
	}
	const load = el.closest<HTMLElement>("[data-remote]");
	if (load && !load.dataset.loading) {
		load.dataset.loading = "1";
		const url = load.dataset.remote!;
		load.textContent = `Loading · ${short(url, 90)}`;
		try {
			const got = await apiFor(load.dataset.env ?? "local").fetchImage(url);
			const kind = got.mime.startsWith("video/") ? "video" : got.mime.startsWith("audio/") ? "audio" : "image";
			const blob = new Blob([Uint8Array.from(atob(got.base64), (c) => c.charCodeAt(0))], { type: got.mime });
			load.replaceWith(player(kind, URL.createObjectURL(blob), load.dataset.alt ?? ""));
		} catch (err) {
			delete load.dataset.loading;
			load.textContent = `Could not load ${short(url, 70)}: ${errText(err)}`;
		}
		return;
	}
	const img = el.closest<HTMLImageElement>("img[data-zoom]");
	if (img) window.dispatchEvent(new CustomEvent("pine:zoom", { detail: img.src }));
}

/** Markdown, drawn into the page. While `live`, the text grows and is drawn at most once a frame. */
export const Markdown = memo(function Markdown({ text, where, live }: { text: string; where?: Where; live?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const pending = useRef(0);
	useEffect(() => {
		const paint = () => {
			pending.current = 0;
			const el = ref.current;
			if (!el) return;
			// What the reader opened stays open while the text goes on growing.
			const open = [...el.querySelectorAll("details")].map((d) => d.open);
			el.replaceChildren(draw(text, where));
			[...el.querySelectorAll("details")].forEach((d, i) => open[i] !== undefined && (d.open = open[i]));
		};
		if (!live) return paint();
		if (!pending.current) pending.current = requestAnimationFrame(paint);
		return () => {
			if (pending.current) cancelAnimationFrame(pending.current);
			pending.current = 0;
		};
	}, [text, where?.env, where?.agent, where?.session, live]);
	return <div ref={ref} className={`md${live ? " md-live" : ""}`} onClick={(e) => void onClick(e.nativeEvent)} />;
});
