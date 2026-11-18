// An answer, drawn. What an agent writes can repeat what a web page told it to write, so the
// text is treated as content from outside. Streamdown parses it and draws it as it streams, and
// three things of pine's own replace its defaults, which are not safe here (a picture at any
// address loaded by itself, a button that downloads, links opened by the page):
//
//   - CLEAN, the rule set the text is cleaned with: no scripts, styles, forms, frames, svg, media
//     tags, no style, class or id attributes, and links only to http(s) and mailto. Pictures in
//     the text itself (`data:`) are kept, which GitHub's rules, Streamdown's default, drop;
//   - Link: it opens in the owner's browser, only for http(s), it has no href that the page could
//     follow, and its address stands next to it whenever its words are not the address itself;
//   - Picture: one at a web address is never fetched because an answer contains it. It is a line
//     to click, and then the daemon fetches it (the page's own policy allows no address on the
//     web). One at a path is shown from the agent's workspace, through the daemon; a `data:` png,
//     jpeg, gif or webp is shown as it is. Nothing else, and no download button.
//
// When Streamdown is upgraded, read its defaults again (`defaultRehypePlugins`, the components
// it draws, its controls) and run the desktop suite: its markdown test fails without each of the three.
import { createCodePlugin } from "@streamdown/code";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { Children, createContext, isValidElement, memo, useContext, useEffect, useState, type ReactNode } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { type Options as Schema } from "rehype-sanitize";
import { Streamdown, type Components, type ControlsConfig, type ExtraProps } from "streamdown";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { apiFor, media } from "./api.ts";
import { bridge } from "./bridge.ts";
import { mediaKind } from "./model.ts";
import { errText, short } from "./text.ts";

/** The tags and attributes an answer keeps. Everything else is taken away, its words kept; what is in `strip` goes with its words. */
export const CLEAN: Schema = {
	tagNames: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "del", "s", "ins", "mark", "sub", "sup", "small", "kbd", "samp", "var", "code", "pre", "blockquote", "q", "cite", "abbr", "dfn", "time", "ul", "ol", "li", "dl", "dt", "dd", "a", "img", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary", "div", "span", "section", "figure", "figcaption", "ruby", "rt", "rp", "wbr"],
	attributes: {
		a: ["href", "title"],
		img: ["src", "alt", "title"],
		// The language of a code block, which the highlighter reads; no other class survives.
		code: [["className", /^language-./]],
		th: ["align", "colSpan", "rowSpan", "scope"],
		td: ["align", "colSpan", "rowSpan"],
		ol: ["start", "reversed"],
		li: ["value"],
		details: ["open"],
		abbr: ["title"],
		time: ["dateTime"],
		"*": ["lang", "dir"],
	},
	protocols: { href: ["http", "https", "mailto"], src: ["http", "https", "data"] },
	ancestors: { tbody: ["table"], td: ["table"], th: ["table"], thead: ["table"], tfoot: ["table"], tr: ["table"], caption: ["table"] },
	strip: ["script", "style", "template", "textarea", "select", "noscript", "title", "iframe", "frame", "object", "embed", "svg", "math", "video", "audio"],
	clobber: [],
	clobberPrefix: "",
};

const REHYPE = [rehypeRaw, [rehypeSanitize, CLEAN]] as const;

const isWeb = (url: string) => /^https?:\/\//i.test(url);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/i;

export interface Where {
	/** The environment whose pine the agent is of: its files and pictures are fetched there. */
	env: string;
	agent: string;
	session?: string;
}

/** Whose workspace a path in the answer is in: a context, so that the components below stay the same for every answer. */
const WhereContext = createContext<Where | undefined>(undefined);

type Node = ExtraProps["node"];
const textOf = (node: Node | { type: string; value?: string; children?: unknown[] }): string => {
	if (!node) return "";
	if (node.type === "text") return (node as { value?: string }).value ?? "";
	return ((node as { children?: Node[] }).children ?? []).map(textOf).join("");
};

const open = (url: string) => (e: React.MouseEvent) => {
	e.preventDefault();
	void bridge.open(url);
};

function Link({ href, children, node }: React.ComponentProps<"a"> & ExtraProps) {
	const url = typeof href === "string" ? href : "";
	const shown = textOf(node).trim();
	if (!isWeb(url)) return <span>{url && shown !== url ? <>{children} ({url})</> : children}</span>;
	const plain = shown === url || shown === url.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return (
		<>
			<a data-href={url} title={url} className="cursor-pointer text-primary underline decoration-primary/40 underline-offset-2" onClick={open(url)}>
				{children}
			</a>
			{/* Beside the link, not inside it: it is the address in plain letters, not more of the link's words.
			    It flows with the sentence: a line of its own would cut the link off from where it leads. */}
			{plain ? null : (
				<span data-target="" className="ml-1 inline cursor-pointer font-mono text-xs text-faint wrap-anywhere" title={url} onClick={open(url)}>
					<ArrowRightIcon className="mr-1 inline size-3" aria-hidden />
					{short(url.replace(/^https?:\/\//, ""), 72)}
				</span>
			)}
		</>
	);
}

/** How a picture, a video or a sound is drawn, in an answer and in a conversation: never wider than its place. */
export const MEDIA = {
	box: { image: "block max-w-md", video: "block max-w-lg", audio: "block max-w-md" },
	image: "block max-h-80 max-w-full cursor-zoom-in rounded-md border",
	video: "block max-h-90 max-w-full rounded-md bg-black",
	audio: "block w-full",
	cap: "mt-1 block text-xs text-faint",
};

function Player({ kind, src, alt }: { kind: "image" | "video" | "audio"; src: string; alt: string }) {
	return (
		<span className={`my-2.5 ${MEDIA.box[kind]}`}>
			{kind === "image" ? (
				// Larger over the page with a click or, focused, with Enter; a click on it, beside it, or Escape closes it.
				<Dialog>
					<DialogTrigger nativeButton={false} render={<img className={MEDIA.image} src={src} alt={alt} draggable={false} />} />
					<DialogContent showCloseButton={false} className="flex max-h-11/12 w-auto max-w-11/12 flex-col items-center sm:max-w-11/12">
						<DialogTitle className="sr-only">The picture, larger</DialogTitle>
						<DialogClose nativeButton={false} aria-label="Close the picture" render={<img src={src} alt="" className="min-h-0 max-w-full rounded-md object-contain" />} />
					</DialogContent>
				</Dialog>
			) : kind === "video" ? <video className={MEDIA.video} src={src} controls preload="metadata" /> : <audio className={MEDIA.audio} src={src} controls preload="metadata" />}
			{alt ? <span className={MEDIA.cap}>{alt}</span> : null}
		</span>
	);
}

/** A line to click instead of a picture: the address is shown, and nothing is fetched before the click. */
function Remote({ url, alt, env }: { url: string; alt: string; env: string }) {
	const [state, setState] = useState<{ loading?: boolean; error?: string; got?: { kind: "image" | "video" | "audio"; src: string } }>({});
	useEffect(() => () => void (state.got && URL.revokeObjectURL(state.got.src)), [state.got]);
	if (state.got) return <Player kind={state.got.kind} src={state.got.src} alt={alt} />;
	const kind = mediaKind(url.split(/[?#]/)[0]) ?? "image";
	const load = async () => {
		if (state.loading) return;
		setState({ loading: true });
		try {
			const got = await apiFor(env).fetchImage(url);
			const kind = got.mime.startsWith("video/") ? "video" : got.mime.startsWith("audio/") ? "audio" : "image";
			const blob = new Blob([Uint8Array.from(atob(got.base64), (c) => c.charCodeAt(0))], { type: got.mime });
			setState({ got: { kind, src: URL.createObjectURL(blob) } });
		} catch (err) {
			setState({ error: errText(err) });
		}
	};
	const label = state.loading ? `Loading · ${short(url, 90)}` : state.error ? `Could not load ${short(url, 70)}: ${state.error}` : `Load ${kind === "image" ? "picture" : kind} · ${short(url, 90)}`;
	return (
		<Button variant="outline" size="xs" data-remote={url} title={state.error ? `${url}: ${state.error}` : url} className="max-w-full" onClick={() => void load()}>
			<span className="truncate">{label}</span>
		</Button>
	);
}

function Picture({ src, alt }: React.ComponentProps<"img"> & ExtraProps) {
	const where = useContext(WhereContext);
	const url = typeof src === "string" ? src : "";
	const words = alt ?? "";
	// The pine that fetches it, on the click: the one whose agent wrote it.
	if (isWeb(url)) return <Remote url={url} alt={words} env={where?.env ?? "local"} />;
	if (DATA_IMAGE.test(url)) return <Player kind="image" src={url} alt={words} />;
	if (where && url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		const kind = mediaKind(url.split(/[?#]/)[0]);
		let file = url;
		try {
			file = decodeURIComponent(url);
		} catch {
			// as written
		}
		if (kind) return <Player kind={kind} src={media.workspace(where.env, where.agent, file, where.session)} alt={words} />;
	}
	return <>{words || url}</>;
}

/** A folded part written as raw HTML (`<details>`), drawn as shadcn's Collapsible. `open` in the text is
 *  where it starts; from then on it is the reader's, and it stays as they left it while the text grows,
 *  since the component is the same on every render (COMPONENTS is a constant) and keeps its own state. */
function Details({ open, children }: React.ComponentProps<"details"> & ExtraProps) {
	const parts = Children.toArray(children);
	const isSummary = (part: ReactNode) => isValidElement<ExtraProps>(part) && part.props.node?.tagName === "summary";
	return (
		<Collapsible defaultOpen={open !== undefined && open !== false} data-details="" className="my-3 rounded-lg border px-3">
			{parts.filter(isSummary)}
			<CollapsibleContent className="pb-2.5">{parts.filter((part) => !isSummary(part))}</CollapsibleContent>
		</Collapsible>
	);
}

function Summary({ children }: React.ComponentProps<"summary"> & ExtraProps) {
	return (
		<CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 py-2 text-left font-medium text-muted-foreground select-none hover:text-foreground">
			<ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90" aria-hidden />
			{children}
		</CollapsibleTrigger>
	);
}

const COMPONENTS: Components = { a: Link, img: Picture, details: Details, summary: Summary };
const PLUGINS = { code: createCodePlugin({ themes: ["github-light", "poimandres"] }) };
const CONTROLS: ControlsConfig = { code: { copy: true, download: false }, table: false, mermaid: false, image: false };

// Streamdown draws every element with its own look, and a folded part written as raw HTML is
// Details above. `data-slot="markdown"` and `data-live` are what the tests look for.
const LOOK = "cursor-auto select-text wrap-anywhere";

/** Markdown, drawn into the page. While `live`, the text grows; what the reader opened stays open. */
export const Markdown = memo(function Markdown({ text, where, live }: { text: string; where?: Where; live?: boolean }): ReactNode {
	return (
		<WhereContext.Provider value={where}>
			<Streamdown data-slot="markdown" data-live={live || undefined} className={LOOK} caret="block" rehypePlugins={REHYPE as never} components={COMPONENTS} plugins={PLUGINS} controls={CONTROLS} linkSafety={{ enabled: false }} shikiTheme={["github-light", "poimandres"]} isAnimating={!!live} lineNumbers={false}>
				{text}
			</Streamdown>
		</WhereContext.Provider>
	);
});
