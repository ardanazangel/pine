// The event log: everything pine publishes, as it happens. A line opens to its whole payload.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFor, type PineEvent } from "./api.ts";
import { store, type Tab, useModel } from "./model.ts";
import { short } from "./text.ts";
import { Button, Empty, Icon } from "./ui.tsx";

/** "agent/#" fits every topic under agent; "+" fits one level; a word without either is looked for anywhere. */
function fits(pattern: string, e: PineEvent): boolean {
	const p = pattern.trim();
	if (!p) return true;
	if (!/[#+/]/.test(p)) return e.topic.includes(p) || e.source.includes(p) || JSON.stringify(e.payload ?? "").includes(p);
	const want = p.split("/");
	const have = e.topic.split("/");
	for (let i = 0; i < want.length; i++) {
		if (want[i] === "#") return true;
		if (have[i] === undefined || (want[i] !== "+" && want[i] !== have[i])) return false;
	}
	return want.length === have.length;
}

export function Events({ tab }: { tab: Tab }) {
	useModel(tab);
	const [filter, setFilter] = useState(tab.logFilter);
	const [open, setOpen] = useState<number>();
	const [paused, setPaused] = useState(false);
	const [frozen, setFrozen] = useState<PineEvent[]>([]);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const source = paused ? frozen : tab.log;
	const shown = source.filter((e) => fits(filter, e)).slice(-600);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current && open === undefined) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		tab.logFilter = filter;
	}, [filter, tab]);
	const emit = async () => {
		const topic = await store.pick({ title: "Publish an event as yourself", items: [], free: true, placeholder: "topic, then optionally JSON: house/mode {\"value\":\"away\"}" });
		if (!topic) return;
		const at = topic.indexOf(" ");
		let payload: unknown = null;
		if (at > 0) {
			try {
				payload = JSON.parse(topic.slice(at + 1));
			} catch {
				return store.flash("The payload is not JSON.", "bad");
			}
		}
		const done = await store.attempt(() => apiFor(tab.env).emit(at > 0 ? topic.slice(0, at) : topic, payload));
		if (done) store.flash(`Published event #${done.id}.`);
	};
	return (
		<div className="events">
			<div className="events-bar">
				<Icon name="search" size={14} className="faint" />
				<input className="input" style={{ maxWidth: 360 }} placeholder="Filter: a word, or a topic pattern such as agent/# or source/+/message" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
				<span className="faint">{shown.length} shown · text deltas are left out</span>
				<span className="grow" />
				<Button small icon={paused ? "play" : "stop"} onClick={() => (setFrozen([...tab.log]), setPaused(!paused))}>{paused ? "Follow" : "Pause"}</Button>
				<Button small icon="bolt" onClick={() => void emit()}>Publish…</Button>
				<Button small variant="ghost" icon="trash" title="Clear the view" onClick={() => ((tab.log = []), tab.touch())} />
			</div>
			<div
				className="events-list selectable"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
				}}
			>
				{shown.length ? (
					shown.map((e, i) => (
						<div key={`${e.id}:${e.ts}:${i}`}>
							<div className={`ev${open === i ? " open" : ""}`} onClick={() => setOpen(open === i ? undefined : i)}>
								<span className="t">{new Date(e.ts).toLocaleTimeString("sv-SE")}</span>
								<span className={`who ${e.trust === "owner" ? "owner" : ""}`}>{e.trust === "owner" ? "owner" : "other"}</span>
								<span className="topic">{e.topic}</span>
								<span className="pl">{short(JSON.stringify(e.payload ?? null), 220)}</span>
							</div>
							{open === i ? <div className="ev-detail">{`#${e.id} · from ${e.source}\n${JSON.stringify(e.payload ?? null, null, 2)}`}</div> : null}
						</div>
					))
				) : (
					<Empty icon="wave" title={tab.log.length ? "No event fits the filter" : "No events yet"}>Messages, tool calls, sources, schedules and approvals all pass through here.</Empty>
				)}
			</div>
		</div>
	);
}
