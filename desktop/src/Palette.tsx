import { useMemo, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { COMMANDS } from "./commands.ts";
import { useNamedLine } from "./lists.tsx";
import { store, useModel } from "./model.ts";
import { ago, fuzzy } from "./text.ts";

export function Palette() {
	const s = store;
	const [query, setQuery] = useState("");
	const line = useNamedLine(query);
	useModel(s);
	type Row = { id: string; group: string; label: string; about?: string; keys?: string; run: () => void; conv?: { env: string; agent: string; session: string } };
	const all = useMemo(() => {
		const chat = s.active?.kind === "chat";
		const rows: Row[] = [];
		const on = (env: string) => (s.shown.length > 1 ? ` · ${s.env(env)?.label ?? env}` : "");
		for (const t of s.tabs) rows.push({ id: `t:${t.id}`, group: "Open tabs", label: t.kind === "chat" ? `${t.agent} · ${s.titleOf(t.env, t.agent, t.session)}${on(t.env)}` : t.kind === "task" ? `${t.agent} task #${t.task}${on(t.env)}` : t.kind === "settings" ? "Settings" : `Events${on(t.env)}`, run: () => s.activate(t), conv: t.kind === "chat" ? { env: t.env, agent: t.agent, session: t.session } : undefined });
		for (const env of s.shown)
			for (const [agent, convs] of env.conversations)
				for (const c of convs) if (!s.tabs.some((t) => t.kind === "chat" && t.env === env.id && t.agent === agent && t.session === c.session)) rows.push({ id: `s:${env.id}|${agent}:${c.session}`, group: "Conversations", label: `${agent} · ${s.titleOf(env.id, agent, c.session)}${on(env.id)}`, about: `${ago(c.last)}${c.folder ? ` · ${c.folder}` : ""}`, run: () => void s.openTab(env.id, agent, c.session), conv: { env: env.id, agent, session: c.session } });
		for (const c of COMMANDS) if (!c.chat || chat) rows.push({ id: `c:${c.name}`, group: "Commands", label: c.title, about: c.about, keys: c.keys, run: () => void c.run("", s.active) });
		for (const env of s.shown) for (const a of env.agents) rows.push({ id: `a:${env.id}|${a.id}`, group: "Agents", label: `New conversation with ${a.id}${on(env.id)}`, about: a.description, run: () => void s.newConversation({ env: env.id, agent: a.id }) });
		for (const [id, label] of [["general", "General"], ["agents", "Agents"], ["models", "Models"], ["mcp", "MCP servers"], ["skills", "Skills"], ["events", "Events"], ["instructions", "Instructions"], ["environments", "Environments"], ["app", "App"]]) rows.push({ id: `p:${id}`, group: "Settings", label: `Settings: ${label}`, run: () => void s.command(`settings:${id}`) });
		return rows;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [s.envs.map((e) => e.titles)]);
	// What fits by its name comes first; then the conversations in which the words were said; then
	// what only fits by its description, and last what fits by letters in order.
	const shown = useMemo(() => {
		if (!query.trim()) return all;
		const q = query.trim().toLowerCase();
		const named: Row[] = [];
		const described: Row[] = [];
		const loose: Row[] = [];
		for (const r of all) {
			if (r.label.toLowerCase().includes(q)) named.push(r);
			else if ((r.about ?? "").toLowerCase().includes(q)) described.push(r);
			else if (fuzzy(q, r.label) >= 0) loose.push(r);
		}
		// A conversation is listed once. One that fits by its name and also holds the words opens at the words.
		const found = s.searchSaid(q);
		const holds = (r: Row) => (r.conv ? found.find((m) => m.env === r.conv!.env && m.agent === r.conv!.agent && m.session === r.conv!.session) : undefined);
		const keyOf = (c: { env: string; agent: string; session: string }) => `${c.env}|${c.agent}:${c.session}`;
		const listed = new Set<string>();
		const here = (r: Row): Row => {
			const m = holds(r);
			if (!m) return r;
			listed.add(keyOf(m));
			return { ...r, about: `${m.who}: ${m.snippet}`, keys: ago(m.ts), run: () => void s.openFound(m.env, m.agent, m.session, query.trim()) };
		};
		const byName = named.map(here);
		const said: Row[] = found.filter((m) => !listed.has(keyOf(m))).map((m) => ({ id: `m:${keyOf(m)}`, group: "Said in conversations", label: `${m.agent} · ${s.titleOf(m.env, m.agent, m.session)}${s.shown.length > 1 ? ` · ${s.env(m.env)?.label ?? m.env}` : ""}`, about: `${m.who}: ${m.snippet}`, keys: ago(m.ts), run: () => void s.openFound(m.env, m.agent, m.session, query.trim()) }));
		return [...byName, ...said, ...described.filter((r) => !holds(r) || !listed.has(keyOf(r.conv!))), ...loose.filter((r) => !r.conv || !listed.has(keyOf(r.conv)))].slice(0, 80);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query, all, s.envs.map((e) => e.said)]);
	// Rows that follow each other under the same heading are one group.
	const groups: Array<{ name: string; rows: Row[] }> = [];
	for (const r of shown) groups.at(-1)?.name === r.group ? groups.at(-1)!.rows.push(r) : groups.push({ name: r.group, rows: [r] });
	const close = () => ((s.palette = false), s.touch());
	const run = (r: Row) => (close(), r.run());
	return (
		<Dialog open onOpenChange={(open) => open || close()}>
			<DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-xl">
				<DialogTitle className="sr-only">Search everything</DialogTitle>
				<Command {...line} shouldFilter={false} loop>
					<CommandInput placeholder="Search conversations (by name or by what was said), commands, agents" value={query} onValueChange={setQuery} />
					<CommandList className="scroll-fade">
						{groups.map((g, n) => (
							<CommandGroup key={`${n}:${g.name}`} heading={g.name}>
								{g.rows.map((r) => (
									<CommandItem key={r.id} value={r.id} onSelect={() => run(r)}>
										<span className="max-w-3/5 flex-none truncate">{r.label}</span>
										{r.about ? <span className="min-w-0 truncate text-xs text-muted-foreground">{r.about}</span> : null}
										{r.keys ? <CommandShortcut>{r.keys}</CommandShortcut> : null}
									</CommandItem>
								))}
							</CommandGroup>
						))}
						<CommandEmpty>Nothing fits.</CommandEmpty>
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
