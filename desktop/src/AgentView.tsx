// The agent, beside its conversation: who it is, what it runs on, what it is doing, and what it
// has been given (what it listens to, its schedules, skills and servers, what it remembers).
// A conversation in pine is a conversation with an agent; this is the agent.
import { apiFor } from "./api.ts";
import { store, type Tab, useModel } from "./model.ts";
import { childKind, MODES, oneLine, short } from "./text.ts";
import { Button, Icon, Pulse, useLoad } from "./ui.tsx";

function Section({ title, count, children, action }: { title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
	return (
		<section className="agent-sec">
			<h3>
				{title}
				{count !== undefined ? <span className="badge">{count}</span> : null}
				<span className="grow" />
				{action}
			</h3>
			{children}
		</section>
	);
}

const Line = ({ icon, name, about, tag, run }: { icon: string; name: string; about?: string; tag?: string; run?: () => void }) => (
	<div className={`agent-line${run ? " click" : ""}`} onClick={run} title={about}>
		<Icon name={icon} size={13} className="faint" />
		<span className="name">{name}</span>
		<span className="about cut">{about}</span>
		{tag ? <span className="tag">{tag}</span> : null}
	</div>
);

export function AgentView({ tab }: { tab: Tab }) {
	useModel(tab);
	const s = useModel(store);
	const info = s.agent(tab.env, tab.agent);
	const api = apiFor(tab.env);
	// Each is asked by itself: an older pine answers only some of them, and what it does not know is left out.
	const quiet = <T,>(ask: () => Promise<T>) => () => ask().catch(() => undefined);
	const detail = useLoad(quiet(() => api.agentDetail(tab.agent)), [tab.agent, tab.codeTick]);
	const sources = useLoad(quiet(() => api.agentSources(tab.agent, tab.session)), [tab.key, tab.codeTick]);
	const schedules = useLoad(quiet(() => api.schedules()), [tab.agent, tab.codeTick]);
	const skills = useLoad(quiet(() => api.skills()), [tab.agent, tab.codeTick]);
	const servers = useLoad(quiet(() => api.mcp()), [tab.agent, tab.codeTick]);
	if (!info) return null;
	const mode = MODES.find((m) => m.value === info.mode);
	const listens = (sources.data ?? []).filter((x) => x.local || x.agent || x.global);
	const could = (sources.data ?? []).length - listens.length;
	const timed = (schedules.data ?? []).filter((x) => x.scope === tab.agent || (x.scope === "global" && x.task));
	const knows = (skills.data ?? []).filter((x) => x.scope === "global" || (x.agent === tab.agent && (x.scope === "agent" || x.session === tab.session)));
	const tools = (servers.data ?? []).filter((x) => x.enabled && x.agents.includes(tab.agent) && (!x.session || x.session === tab.session));
	const helpers = [...tab.children].reverse().slice(0, 8);
	const elsewhere = [...(s.env(tab.env)?.busy ?? [])].filter(([key, tasks]) => tasks.size && key.startsWith(`${tab.agent}:`) && key !== tab.conv).map(([key]) => key.slice(tab.agent.length + 1));
	const memory = detail.data?.files.memory?.trim();
	return (
		<div className="code-body agent-view selectable">
			<div className="agent-card">
				<span className="avatar big">{tab.agent.slice(0, 1).toUpperCase()}</span>
				<div className="grow" style={{ minWidth: 0 }}>
					<div className="agent-name">{tab.agent}{info.main ? <span className="tag good">main</span> : null}</div>
					<div className="muted">{info.description || "no description"}</div>
				</div>
				<Button small icon="gear" onClick={() => s.openSettings("agents", tab.agent, tab.env)}>Settings</Button>
			</div>
			<div className="facts" style={{ padding: "0 14px" }}>
				<button type="button" className="fact click" title="The model it runs on" onClick={() => void s.pickModel(tab)}><Icon name="cpu" size={12} /><b>{info.model}</b></button>
				<button type="button" className="fact click" title="How much its model thinks before it answers" onClick={() => void s.pickReasoning(tab)}><Icon name="spark" size={12} />reasoning <b>{info.thinking}</b></button>
				<button type="button" className="fact click" title={mode?.about} onClick={() => void s.pickMode(tab)}><Icon name="shield" size={12} /><b>{info.mode}</b>{info.mode === "auto" || info.mode === "bypass" ? "your account" : "in its sandbox"}</button>
				{info.delegates.length ? <span className="fact" title="Agents it can hand work to">hands work to <b>{info.delegates.includes("*") ? "every agent" : info.delegates.join(", ")}</b></span> : null}
			</div>

			{tab.busy || helpers.length || elsewhere.length ? (
				<Section title="At work">
					{tab.busy ? <div className="agent-line"><Pulse size={11} /><span className="name">this conversation</span><span className="about cut">{tab.thinking ? "thinking" : "working"}{tab.toolCalls ? ` · ${tab.toolCalls} tool calls` : ""}</span></div> : null}
					{helpers.map(([id, c]) => (
						<div key={id} className="agent-line click" onClick={() => void s.openTask(tab.env, id)}>
							{c.running ? <Pulse size={11} /> : <Icon name="check" size={13} className="faint" />}
							<span className="name">{c.agent}</span>
							<span className="about cut">{childKind(c.kind)} #{id}: {c.label}</span>
							<span className="tag">open</span>
						</div>
					))}
					{elsewhere.map((session) => <div key={session} className="agent-line click" onClick={() => void s.openTab(tab.env, tab.agent, session)}><Pulse size={11} /><span className="name">{session}</span><span className="about cut">another conversation of {tab.agent}</span><span className="tag">open</span></div>)}
				</Section>
			) : null}

			{sources.data ? (
				<Section title="Listens to" count={listens.length} action={<Button small variant="ghost" onClick={() => s.openSettings("events", undefined, tab.env)}>Events</Button>}>
					{listens.length ? listens.map((x) => <Line key={x.name} icon="bolt" name={x.name} about={(x.local ?? x.agent ?? x.global)?.note || x.description || x.type} tag={x.local ? "this conversation" : x.agent ? "as an agent" : "all agents"} />) : <div className="agent-none">Nothing wakes it by itself.{could > 0 ? ` ${could} event source${could === 1 ? "" : "s"} could: ask it to watch one, or subscribe it under Events.` : " Ask it to watch something (“tell me when a file lands in ~/Scans”)."}</div>}
				</Section>
			) : null}
			{schedules.data ? (
				<Section title="Schedules" count={timed.length}>
					{timed.length ? timed.map((x) => <Line key={`${x.scope}:${x.name}`} icon="clock" name={x.name} about={`${x.when}${x.task ? ` · ${oneLine(x.task)}` : ""}`} tag={x.scope === "global" ? "all agents" : x.session && x.session !== "main" ? x.session : undefined} />) : <div className="agent-none">Nothing is scheduled. Ask it (“every morning at seven …”).</div>}
				</Section>
			) : null}
			{skills.data ? (
				<Section title="Skills" count={knows.length} action={<Button small variant="ghost" onClick={() => s.openSettings("skills", undefined, tab.env)}>Skills</Button>}>
					{knows.length ? knows.map((x) => <Line key={x.dir} icon="book" name={x.name} about={x.description} tag={x.scope === "global" ? "all agents" : x.scope === "local" ? "this conversation" : undefined} />) : <div className="agent-none">No skills yet. Ask it to “make a skill for this”.</div>}
				</Section>
			) : null}
			{servers.data ? (
				<Section title="MCP servers" count={tools.length} action={<Button small variant="ghost" onClick={() => s.openSettings("mcp", undefined, tab.env)}>Servers</Button>}>
					{tools.length ? tools.map((x) => <Line key={`${x.scope}:${x.name}`} icon="plug" name={x.name} about={x.target} tag={x.scope === "global" ? "all agents" : x.session ? "this conversation" : undefined} />) : <div className="agent-none">No MCP servers.</div>}
				</Section>
			) : null}
			{memory !== undefined ? (
				<Section title="What it remembers">
					{memory ? <pre className="log" style={{ margin: "0 14px", maxHeight: 220 }}>{short(memory, 6000)}</pre> : <div className="agent-none">Its MEMORY.md is empty.</div>}
				</Section>
			) : null}
			{detail.data ? <div className="agent-none" style={{ paddingBottom: 16 }}>Its workspace is {detail.data.workspace}; the Files view shows {tab.folder ? "the folder this conversation works in" : "it"}.</div> : null}
		</div>
	);
}
