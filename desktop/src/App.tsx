// The window: the list of agents and conversations at the side, the tabs along the top, one
// conversation in the middle with its panel, and whatever lies over them for a moment (a list
// to pick from, a question, the palette).
import { ArrowUpIcon, AudioLinesIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CpuIcon, ExternalLinkIcon, FolderIcon, GitBranchIcon, ListIcon, MessageSquareIcon, PanelLeftIcon, PlusIcon, SearchIcon, SettingsIcon, StarIcon, TerminalIcon, Trash2Icon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { type Layout, usePanelRef } from "react-resizable-panels";
import { Field } from "@/components/ui/field";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type AgentInfo, apiFor, type Conversation as Conv } from "./api.ts";
import { bridge } from "./bridge.ts";
import { CODE_KEY, CodePanel } from "./CodePanel.tsx";
import { COMMANDS } from "./commands.ts";
import { Conversation } from "./Conversation.tsx";
import { Events } from "./Events.tsx";
import { type Env, store, type Tab, useModel, useSignal } from "./model.ts";
import { Settings } from "./Settings.tsx";
import { ApprovalDialog } from "./ApprovalDialog.tsx";
import { Palette } from "./Palette.tsx";
import { PickDialog } from "./PickDialog.tsx";
import { QuestionDialog } from "./QuestionDialog.tsx";
import { ago, until } from "./text.ts";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import { LISTBOX, onPick } from "./lists.tsx";
import { Logo } from "@/components/logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Sidebar as SidebarRoot, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Printed } from "@/components/printed";

// Pieces of the frame drawn the same in several places.
const DOT = "size-2 flex-none rounded-full";

// ---- before pine answers -----------------------------------------------------------------------------

/** Until one pine answers: each environment that is on, and how far it got. */
function Gate() {
	const s = useModel(store);
	const envs = s.shown;
	const state = envs.find((e) => e.id === "local")?.service;
	const init = async () => {
		s.initRunning = true;
		s.initLines = [];
		s.touch();
		const code = await bridge.init().catch(() => 1);
		s.initRunning = false;
		s.touch();
		if (code === 0) await bridge.retry("local");
		else s.flash("pine init did not finish. What it said is shown above.", "bad");
	};
	// Before pine answers there is nothing to show yet: stock Empty, in a frame that moves the window.
	return (
		<div className="m-1.5 flex flex-1 rounded-xl border bg-background app-drag">
			<Empty className="app-no-drag">
				{state?.status === "error" && state.kind === "no-home" ? (
					<>
						<EmptyHeader>
							<EmptyMedia>
								<Logo className="size-9" />
							</EmptyMedia>
							<EmptyTitle>Welcome to pine</EmptyTitle>
							<EmptyDescription className="select-text">{`pine keeps its agents, their workspaces and its settings in a home folder (${s.prefs.home ?? s.home ?? "~/.pine"}). There is none yet. Setting it up copies the example home and fetches the browser its web tools drive (about 600 MB, once).`}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							{s.initLines.length ? <Printed sm className="w-full text-start" text={s.initLines.slice(-40).join("\n")} /> : null}
							<div className="flex items-center gap-2">
								<Button disabled={s.initRunning} onClick={() => void init()}>{s.initRunning ? <><Spinner data-icon="inline-start" />Setting up…</> : "Set up pine"}</Button>
								<Button variant="outline" disabled={s.initRunning} onClick={() => void bridge.retry("local")}>Try again</Button>
							</div>
						</EmptyContent>
					</>
				) : (
					<>
						<EmptyMedia>
							<Logo className="size-9" />
						</EmptyMedia>
						{envs.map((e) => <GateLine key={e.id} e={e} />)}
					</>
				)}
			</Empty>
		</div>
	);
}

/** How far one environment's pine got: still on its way, or what went wrong and what to do. */
function GateLine({ e }: { e: Env }) {
	const s = store;
	const state = e.service;
	// Another machine that is not reached, and this computer is off: it can be the one instead.
	const instead = async () => {
		await bridge.enableEnvironment("local", true);
		await bridge.enableEnvironment(e.id, false);
	};
	const [title, about, actions]: [string, string, React.ReactNode] =
		state.status === "starting"
			? ["Starting pine", e.host ? `Connecting to the pine on ${e.label} over SSH…` : "Looking for a running pine, or starting one…", <Spinner key="s" />]
			: state.status === "ready"
				? [`Loading the agents${s.on(e.id)}…`, "", <Spinner key="s" />]
				: [
						state.kind === "no-node" ? "pine needs Node" : state.kind === "no-pine" ? "pine is not installed" : state.kind === "ssh" ? `pine on ${e.label} is not reached over SSH` : e.host ? `pine on ${e.label} did not start` : "pine did not start",
						state.message,
						<div key="b" className="flex items-center gap-2">
							<Button onClick={() => void bridge.retry(e.id)}>Try again</Button>
							{state.kind === "no-node" ? <Button variant="outline" onClick={() => void bridge.open("https://nodejs.org")}>nodejs.org</Button> : null}
							{e.host && !s.env("local")?.enabled ? <Button variant="outline" onClick={() => void instead()}>Use this Mac</Button> : null}
						</div>,
					];
	return (
		<div data-environment={e.id} className="flex flex-col items-center gap-4">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				{about ? <EmptyDescription className="select-text">{about}</EmptyDescription> : null}
			</EmptyHeader>
			<EmptyContent>{actions}</EmptyContent>
		</div>
	);
}

// ---- the side ----------------------------------------------------------------------------------------
// The side bar is the agents. Each is a group of its own: who it is, whether it is at work, and
// under it its conversations. What starts something new stands on the agent's own line, so it
// is never a question whom a new conversation or a folder is for.

/** How far a conversation's row stands in: a branch under the one it was made from, four steps at most. */
const INDENT = ["pl-10", "pl-14", "pl-18", "pl-22", "pl-26"];

function ConversationRow({ env, agent, c, depth = 0 }: { env: string; agent: string; c: Conv; depth?: number }) {
	const s = store;
	const tab = s.tabs.find((t) => t.kind === "chat" && t.env === env && t.agent === agent && t.session === c.session);
	const main = c.session === "main";
	const menu = async () => {
		const picked = await bridge.contextMenu([
			{ id: "open", label: "Open" },
			...(c.tasks ? [{ id: "branch", label: "Branch" }] : []),
			...(c.tasks && c.folder ? [{ id: "branch-worktree", label: "Branch into a Worktree" }] : []),
			...(c.worktree ? [{ id: "worktree", label: "Worktree…" }] : []),
			...(main ? [] : [{ id: "pin", label: c.pinned ? "Unpin" : "Pin" }, { id: "rename", label: "Rename…" }]),
			{ id: "sep", label: "", separator: true },
			main ? { id: "reset", label: "Start over…" } : { id: "remove", label: "Remove…" },
		]);
		if (picked === "open") await s.openTab(env, agent, c.session);
		if (picked === "branch" || picked === "branch-worktree") await s.branch(env, agent, c.session, undefined, picked === "branch-worktree");
		if (picked === "worktree") {
			await s.openTab(env, agent, c.session);
			if (s.active?.kind === "chat") await s.worktreeMenu(s.active);
		}
		if (picked === "pin") {
			await s.attempt(() => apiFor(env).pinSession(agent, c.session, !c.pinned));
			await s.refreshConversations(s.env(env), agent);
		}
		if (picked === "rename") {
			const to = await s.pick({ title: `Another name for ${c.session}`, items: [], free: true, placeholder: "The new name" });
			if (to?.trim()) await s.rename(env, agent, c.session, to.trim());
		}
		if (picked === "remove") {
			const sure = await s.pick({ title: `Remove the conversation ${c.session} of ${agent}${s.on(env)}?`, items: [{ value: "yes", label: "Remove it for good", about: "Its history, what it may do without asking, what it listens to and whatever was set up for it alone all go.", tone: "bad" }, { value: "no", label: "Cancel" }] });
			if (sure === "yes") await s.removeConversation(env, agent, c.session);
		}
		if (picked === "reset") {
			await s.openTab(env, agent, c.session);
			if (s.active) await s.reset(s.active);
		}
	};
	const kept = main ? "the agent's own, always kept" : c.pinned ? "pinned" : c.open ? "open in a tab" : c.expires ? `goes ${until(c.expires)}` : "kept";
	const working = tab?.busy || s.isBusy(env, agent, c.session);
	const on = Boolean(tab && tab === s.active);
	return (
		// The row is the stock menu button drawn as the list's option, so the list keeps its one tab stop and its arrows.
		<SidebarMenuItem role="none" className="app-no-drag" onContextMenu={(e) => (e.preventDefault(), void menu())}>
			<SidebarMenuButton isActive={on} className={cn(INDENT[Math.min(depth, INDENT.length - 1)], c.tasks && "pr-16 group-has-data-[sidebar=menu-action]/menu-item:pr-16")} render={<ListboxItem value={c.session} label={s.titleOf(env, agent, c.session)} title={`${agent}${s.on(env)} · ${c.session} · ${kept}${c.branch ? ` · a branch of ${c.branch.from}` : ""}${c.worktree ? ` · in the worktree ${c.worktree.branch} of ${c.worktree.repo}` : c.folder ? ` · works in ${c.folder}` : ""}`} />}>
				<span className="grid size-4 flex-none place-items-center">{tab?.approvals.size ? <Badge variant="destructive" className="size-4 p-0">!</Badge> : working ? <Spinner aria-label="Working" className="size-3" /> : tab?.unread ? <Badge className="size-2 p-0" /> : main || c.pinned ? <StarIcon className="text-faint" /> : depth || c.worktree ? <GitBranchIcon className="text-faint" /> : c.folder ? <FolderIcon className="text-faint" /> : <MessageSquareIcon className="text-faint" />}</span>
				<span className="min-w-0 flex-1">{s.titleOf(env, agent, c.session)}</span>
			</SidebarMenuButton>
			{/* The badge is drawn over the button, so the button keeps the room for the time (stock pr-8 fits an action alone; the same selector as stock, so it takes the place of its pr-8). */}
			{c.tasks ? <SidebarMenuBadge className={cn(!main && "group-hover/menu-item:hidden")}>{ago(c.last).replace(" ago", "")}</SidebarMenuBadge> : null}
			{main ? null : (
				// Shown under the pointer only, so that it is no tab stop of its own; its keys are not the list's.
				<AlertDialog>
					<Tooltip>
						<TooltipTrigger render={<AlertDialogTrigger render={<SidebarMenuAction className="hidden group-hover/menu-item:flex" onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} />} aria-label="Remove this conversation for good"><Trash2Icon /></AlertDialogTrigger>} />
						<TooltipContent>Remove this conversation for good</TooltipContent>
					</Tooltip>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove the conversation {s.titleOf(env, agent, c.session)} for good?</AlertDialogTitle>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogCancel variant="destructive" onClick={() => void s.removeConversation(env, agent, c.session)}>Remove</AlertDialogCancel>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</SidebarMenuItem>
	);
}

/** The conversations in their order, with each branch right under the one it was made from, newest first. */
function threaded(rows: Conv[]): Array<{ c: Conv; depth: number }> {
	const names = new Set(rows.map((c) => c.session));
	const kids = new Map<string, Conv[]>();
	for (const c of rows) if (c.branch && names.has(c.branch.from) && c.branch.from !== c.session) kids.set(c.branch.from, [...(kids.get(c.branch.from) ?? []), c]);
	const out: Array<{ c: Conv; depth: number }> = [];
	const seen = new Set<string>();
	const put = (c: Conv, depth: number) => {
		if (seen.has(c.session)) return;
		seen.add(c.session);
		out.push({ c, depth });
		for (const k of [...(kids.get(c.session) ?? [])].sort((x, y) => y.last - x.last)) put(k, depth + 1);
	};
	for (const c of rows) if (!(c.branch && names.has(c.branch.from))) put(c, 0);
	// What is left was part of a circle of names (renames can make one): shown as it comes.
	for (const c of rows) put(c, 0);
	return out;
}

function AgentGroup({ env, a }: { env: Env; a: AgentInfo }) {
	const s = store;
	const folded = s.isFolded(env.id, a.id);
	const list = env.conversations.get(a.id) ?? [];
	const who = { env: env.id, agent: a.id };
	// The agent's own conversation first, then what is pinned, then by when it was last used.
	const sorted = [...list].sort((x, y) => Number(y.session === "main") - Number(x.session === "main") || Number(y.pinned) - Number(x.pinned) || y.last - x.last);
	const rows = sorted.some((c) => c.session === "main") ? sorted : [{ session: "main", tasks: 0, last: 0, pinned: false, open: false }, ...sorted];
	// A conversation that is open in a tab and has not been said anything in yet is not in the daemon's list.
	const tabs = s.tabsOf(env.id).filter((t) => t.agent === a.id && t.kind === "chat");
	for (const t of tabs) if (!rows.some((c) => c.session === t.session)) rows.push({ session: t.session, tasks: 0, last: Date.now(), pinned: false, open: true });
	const waits = tabs.some((t) => t.approvals.size > 0);
	const working = s.isBusy(env.id, a.id) || tabs.some((t) => t.busy);
	const unread = tabs.some((t) => t.unread);
	const pickFolder = async () => {
		const dir = await s.chooseFolder(env.id, `A folder for a conversation with ${a.id}`);
		if (dir) await s.openFolder(dir, who);
	};
	const menu = async () => {
		const picked = await bridge.contextMenu([
			{ id: "new", label: `New conversation with ${a.id}` },
			{ id: "folder", label: `Open a folder with ${a.id}…` },
			{ id: "sep", label: "", separator: true },
			{ id: "settings", label: "Agent settings…" },
			// The main agent administers pine and stays.
			...(a.main ? [] : [{ id: "sep2", label: "", separator: true }, { id: "remove", label: `Remove ${a.id}…` }]),
		]);
		if (picked === "new") await s.newConversation(who);
		if (picked === "folder") await pickFolder();
		if (picked === "settings") s.openSettings("agents", a.id, env.id);
		if (picked === "remove") await s.removeAgent(env.id, a.id);
	};
	return (
		<Collapsible open={!folded} onOpenChange={() => s.toggleFold(env.id, a.id)}>
			<SidebarMenu>
				<SidebarMenuItem className="app-no-drag" title={`${a.id}${s.on(env.id)}: ${a.description || "no description"}\n${a.model} · ${a.mode}`} onContextMenu={(e) => (e.preventDefault(), void menu())}>
					{/* What folds the group is the agent's line but its buttons. Under the pointer the line makes room for all three. */}
					<CollapsibleTrigger render={<SidebarMenuButton className="group-hover/menu-item:pr-20" />}>
						{folded ? <ChevronRightIcon className="text-faint" /> : <ChevronDownIcon className="text-faint" />}
						<Avatar size="sm">
							<AvatarFallback>{a.id.slice(0, 1).toUpperCase()}</AvatarFallback>
						</Avatar>
						{/* An agent's name and, beside it on the same line, what it is for. The name is whole; what it is for takes the room that is left
						    and is cut off where that ends. With the pointer on the line, what was cut off slides through to its end and back. */}
						<span data-slot="agent-label" className="flex min-w-0 flex-1 items-baseline gap-2 font-semibold text-foreground">
							<span className="min-w-0 flex-initial truncate">{a.id}</span>
							<span className="@container min-w-0 flex-1 truncate text-xs font-normal text-faint group-hover/menu-item:text-clip"><span className="group-hover/menu-item:inline-block group-hover/menu-item:animate-slide-end motion-reduce:animate-none">{a.description || a.model}</span></span>
						</span>
						{waits ? <Badge variant="destructive" className="size-4 p-0">!</Badge> : working ? <Spinner aria-label="Working" className="size-3" /> : unread && folded ? <Badge className="size-2 p-0" /> : null}
					</CollapsibleTrigger>
					<Tooltip><TooltipTrigger render={<SidebarMenuAction className="right-13 hidden group-hover/menu-item:flex" onClick={() => s.openSettings("agents", a.id, env.id)} aria-label={`Settings of ${a.id}`} />}><SettingsIcon /></TooltipTrigger><TooltipContent>{`Settings of ${a.id}`}</TooltipContent></Tooltip>
					<Tooltip><TooltipTrigger render={<SidebarMenuAction className="right-7 hidden group-hover/menu-item:flex" onClick={() => void pickFolder()} aria-label={`Open a folder for a conversation with ${a.id}`} />}><FolderIcon /></TooltipTrigger><TooltipContent>{`Open a folder for a conversation with ${a.id}`}</TooltipContent></Tooltip>
					<Tooltip><TooltipTrigger render={<SidebarMenuAction onClick={() => void s.newConversation(who)} aria-label={`New conversation with ${a.id}`} />}><PlusIcon /></TooltipTrigger><TooltipContent>{`New conversation with ${a.id}`}</TooltipContent></Tooltip>
				</SidebarMenuItem>
			</SidebarMenu>
			<CollapsibleContent>
				<Listbox aria-label={`Conversations with ${a.id}`} className="outline-none" {...LISTBOX} value={s.active?.kind === "chat" && s.active.env === env.id && s.active.agent === a.id ? s.active.session : null} onValueChange={onPick((session) => void s.openTab(env.id, a.id, session))} render={<SidebarMenu />}>
					{threaded(rows).map(({ c, depth }) => <ConversationRow key={c.session} env={env.id} agent={a.id} c={c} depth={depth} />)}
				</Listbox>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** One environment in the side bar: its name and how its pine is, then its agents. */
function EnvSection({ env }: { env: Env }) {
	const s = store;
	const state = env.service;
	const status = state.status === "error" ? "error" : state.status === "starting" ? "connecting" : !env.connected ? "reconnecting" : "connected";
	const about = env.id === "local" ? "Agents of the pine on this computer" : `Agents of the pine on ${env.host}, over SSH`;
	const how = state.status === "ready" ? `pine${state.version ? ` ${state.version}` : ""} · ${state.remote ? state.mode : state.started ? "started here" : "attached"}` : "";
	// How its pine is, under its name, while it is not simply there.
	const note = (words: string, busy: boolean, bad = false) => (
		<div data-slot="environment-note" className={cn("flex min-h-7 items-center gap-2 px-2 text-xs app-no-drag", bad ? "text-destructive" : "text-muted-foreground")} title={state.status === "error" ? state.message : undefined}>
			{busy ? <Spinner className="size-3" /> : null}
			<span className="min-w-0 flex-1 truncate">{words}</span>
			{bad ? <Button variant="outline" size="xs" onClick={() => void bridge.retry(env.id)}>Try again</Button> : null}
		</div>
	);
	return (
		<SidebarGroup data-environment={env.id} data-status={status}>
			<SidebarGroupLabel title={`${about}${how ? `\n${how}` : ""} · ${status}`}>
				{env.id === "local" ? <CpuIcon /> : <TerminalIcon />}
				<span data-slot="environment-label" className="min-w-0 truncate">{env.label}</span>
				{status === "connected" ? null : <span className={cn(DOT, status === "error" ? "bg-destructive" : "bg-warn")} />}
			</SidebarGroupLabel>
			{env.ready ? <Tooltip><TooltipTrigger render={<SidebarGroupAction className="app-no-drag" onClick={() => s.openSettings("agents", "+", env.id)} aria-label={`New agent${s.on(env.id)}`} />}><PlusIcon /></TooltipTrigger><TooltipContent>{`New agent${s.on(env.id)}`}</TooltipContent></Tooltip> : null}
			<SidebarGroupContent className="flex flex-col gap-1">
				{state.status === "error" ? note(state.kind === "ssh" ? "Not reached over SSH" : state.kind === "no-home" ? "No pine home yet" : "Did not start", false, true) : status === "connecting" ? note(env.host ? "Connecting over SSH…" : "Starting pine…", true) : status === "reconnecting" ? note("Reconnecting…", true) : null}
				{env.agents.map((a) => <AgentGroup key={a.id} env={env} a={a} />)}
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function Sidebar() {
	const s = useModel(store);
	const front = s.active;
	const newer = s.update?.status === "newer" ? s.update : undefined;
	const envs = s.shown;
	const one = envs.length === 1 ? envs[0] : undefined;
	const state = one?.service;
	const up = envs.filter((e) => e.ready && e.connected).length;
	// shadcn's stock Sidebar, fixed in its place (the panel around it sets its width). Its background
	// is left to the window behind it, which is the system's material on a Mac.
	// Where nothing is to click, the side bar moves the window, like the bar along the top.
	return (
		<SidebarRoot collapsible="none" className="w-full min-w-0 bg-transparent app-drag">
			<SidebarHeader className={cn("h-11 flex-none flex-row items-center justify-end gap-0.5 py-0 pr-2 app-drag", s.platform === "darwin" && !s.fullscreen ? "pl-21" : "pl-2.5")}>
				<Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className="app-no-drag" onClick={() => void s.command("sidebar")} aria-label="Hide the sidebar" />}><PanelLeftIcon /></TooltipTrigger><TooltipContent>Hide the sidebar<Kbd>⌘B</Kbd></TooltipContent></Tooltip>
			</SidebarHeader>
			<SidebarContent>
				<ScrollArea className="flex min-h-0 flex-col *:data-[slot=scroll-area-viewport]:scroll-fade flex-1">
					<SidebarGroup className="pt-1 pb-0">
						<SidebarMenu>
							<SidebarMenuItem className="app-no-drag">
								<Tooltip><TooltipTrigger render={<SidebarMenuButton onClick={() => void s.command("palette")} />}><SearchIcon /><span className="grow min-w-0 flex-1">Search</span><Kbd>⌘K</Kbd></TooltipTrigger><TooltipContent>Find a conversation by its name or by what was said in it, or a command, an agent, a settings page</TooltipContent></Tooltip>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroup>
					{envs.map((env) => <EnvSection key={env.id} env={env} />)}
				</ScrollArea>
			</SidebarContent>
			<SidebarFooter className="gap-0">
				<SidebarMenu>
					{newer ? (
						<SidebarMenuItem className="app-no-drag">
							<Tooltip><TooltipTrigger render={<SidebarMenuButton className="text-primary hover:text-primary" onClick={() => void bridge.open(newer.url)} />}><ArrowUpIcon /><span className="grow min-w-0 flex-1 truncate">Pine {newer.version} is available</span><ExternalLinkIcon /></TooltipTrigger><TooltipContent>{`This is Pine ${newer.mine}. Opens the release's page on GitHub in your browser: download the disk image there and put the app in place of this one.`}</TooltipContent></Tooltip>
						</SidebarMenuItem>
					) : null}
					<SidebarMenuItem className="app-no-drag">
						<SidebarMenuButton isActive={front?.kind === "events"} onClick={() => void s.openEvents()}><AudioLinesIcon /><span className="grow min-w-0 flex-1">Events</span></SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem className="app-no-drag">
						<SidebarMenuButton isActive={front?.kind === "settings"} onClick={() => s.openSettings()}><SettingsIcon /><span className="grow min-w-0 flex-1">Settings</span><Kbd>⌘,</Kbd></SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
				{one ? (
					<div data-slot="service-status" className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-xs text-faint app-no-drag" title={state?.status === "ready" ? `${state.home} · ${state.remote ? `over SSH (${state.from})` : state.started ? "started by this app" : "a pine that was already running"}` : ""}>
						{/* The dot stands in the place of the icons in the rows above it: its middle under theirs, and what is written beside it under their names. */}
						<span className="grid size-4 flex-none place-items-center"><span className={cn(DOT, state?.status !== "ready" ? "bg-warn" : one.connected ? "bg-primary" : "bg-destructive")} /></span>
						<span className="truncate">{state?.status !== "ready" ? "starting" : !one.connected ? "pine does not answer" : `pine${state.version ? ` ${state.version}` : ""} · ${state.remote ? state.mode : state.started ? "started here" : "attached"}`}</span>
					</div>
				) : (
					// Each environment says beside its name when its pine does not answer.
					<button type="button" data-slot="service-status" className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-left text-xs text-faint app-no-drag hover:text-foreground" onClick={() => s.openSettings("environments")}>
						<span className="grid size-4 flex-none place-items-center"><span className={cn(DOT, up === envs.length ? "bg-primary" : up ? "bg-warn" : "bg-destructive")} /></span>
						<span className="truncate">{up} of {envs.length} environments connected</span>
					</button>
				)}
			</SidebarFooter>
		</SidebarRoot>
	);
}

// ---- the tabs ------------------------------------------------------------------------------------------

function TabButton({ tab, index }: { tab: Tab; index: number }) {
	useModel(tab);
	const s = store;
	const [drop, setDrop] = useState(false);
	const on = s.active === tab;
	const kept = tab.kind === "chat" && (tab.session === "main" || s.isPinned(tab));
	// Where several environments are shown, a tab of another machine says which: both can have a "main".
	const where = tab.env !== "local" && s.shown.length > 1 ? s.env(tab.env)?.label : undefined;
	// The tab brought to the front is scrolled into view when there are more tabs than the row shows.
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (on) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [on]);
	// The least width is what the tab holds besides its name (the avatar, the gaps, the close button) and a few letters of the
	// name: narrower, what does not shrink spills over the next tab. Past that, the row scrolls.
	return (
		<div
			ref={ref}
			data-slot="tab"
			data-active={on || undefined}
			className={cn("group/tab relative flex h-8 max-w-55 min-w-28 flex-initial items-center gap-2 rounded-md pr-1.5 pl-2.5 app-no-drag", on ? "bg-background text-foreground ring-1 ring-border" : "text-muted-foreground hover:bg-hover hover:text-foreground", drop && "before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-primary")}
			draggable
			onDragStart={(e) => (e.dataTransfer.setData("application/x-pine-tab", String(index)), (e.dataTransfer.effectAllowed = "move"))}
			onDragOver={(e) => e.dataTransfer.types.includes("application/x-pine-tab") && (e.preventDefault(), setDrop(true))}
			onDragLeave={() => setDrop(false)}
			onDrop={(e) => (setDrop(false), s.moveTab(Number(e.dataTransfer.getData("application/x-pine-tab")), index))}
			onClick={() => s.activate(tab)}
			onAuxClick={(e) => e.button === 1 && s.closeTab(tab)}
			title={tab.kind === "chat" ? `${tab.agent}${s.on(tab.env)} · ${tab.session}${tab.folder ? ` · ${tab.folder}` : ""}` : tab.kind === "task" ? `task #${tab.task}${s.on(tab.env)}` : tab.kind === "events" ? `events${s.on(tab.env)}` : tab.kind}
		>
			<span className="grid min-w-3.5 flex-none place-items-center">
				{tab.approvals.size ? <Badge variant="destructive" className="size-4 p-0">!</Badge> : tab.busy ? <Spinner aria-label="Working" className="size-3" /> : tab.unread ? <Badge className="size-2 p-0" /> : tab.kind === "events" ? <AudioLinesIcon size={12} /> : tab.kind === "settings" ? <SettingsIcon size={12} /> : tab.kind === "task" ? <ListIcon size={12} /> : <Avatar size="sm"><AvatarFallback>{tab.agent.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>}
			</span>
			<span data-slot="tab-name" className="truncate">
				{tab.kind === "events" ? "Events" : tab.kind === "settings" ? "Settings" : tab.kind === "task" ? <><b className="font-medium">{tab.agent}</b> #{tab.task}</> : tab.session === "main" ? <b className="font-medium">{tab.agent}</b> : <><b className="font-medium">{tab.agent}</b> · {s.titleOf(tab.env, tab.agent, tab.session)}</>}
				{where ? <span data-slot="tab-where" className="text-faint"> · {where}</span> : null}
			</span>
			{kept && tab.session !== "main" ? <StarIcon size={10} className="flex-none text-warn" /> : null}
			<Button variant="ghost" size="icon-xs" aria-label="Close this tab" className={cn(!on && "opacity-0 group-hover/tab:opacity-100")} onClick={(e) => (e.stopPropagation(), s.closeTab(tab))}><XIcon /></Button>
		</div>
	);
}

function TitleBar() {
	const s = useModel(store);
	const with_ = s.agentInFront();
	return (
		<header className={cn("flex h-11 flex-none items-center gap-1 pr-2 app-drag", s.sidebar ? "pl-0.5" : s.platform === "darwin" && !s.fullscreen ? "pl-21" : "pl-2")}>
			{s.sidebar ? null : <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className="app-no-drag" onClick={() => void s.command("sidebar")} aria-label="Show the sidebar" />}><PanelLeftIcon /></TooltipTrigger><TooltipContent>Show the sidebar<Kbd>⌘B</Kbd></TooltipContent></Tooltip>}
			{/* A row that scrolls cuts off what a tab draws outside itself (the line around the tab in front, the mark where a dragged tab
			    would land): the padding is the room for both, and the margin keeps the tabs where they were. It scrolls without a bar;
			    the fade at a cut end says there is more. */}
			<ScrollArea className="-mx-0.5 flex min-h-0 min-w-0 flex-col *:data-[slot=scroll-area-viewport]:scroll-fade-x">
				<div className="flex items-center gap-0.5 px-0.5 py-px">
					{s.tabs.map((t, i) => <TabButton key={t.id} tab={t} index={i} />)}
				</div>
			</ScrollArea>
			<Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className="app-no-drag" onClick={() => void s.newConversation()} aria-label={with_ ? `New conversation with ${with_.agent}${s.on(with_.env)}` : "New conversation: you are asked with which agent"} />}><PlusIcon /></TooltipTrigger><TooltipContent>{with_ ? `New conversation with ${with_.agent}${s.on(with_.env)}` : "New conversation: you are asked with which agent"}<Kbd>⌘T</Kbd></TooltipContent></Tooltip>
			<span className="min-w-0 flex-1" />
		</header>
	);
}

// ---- what lies over the window for a moment --------------------------------------------------------------

function Asking() {
	const s = useModel(store);
	const open = s.asked_;
	if (!open) return null;
	const { env, req } = open;
	return req.tool === "question" ? <QuestionDialog key={s.asking} env={env} req={req} /> : <ApprovalDialog key={s.asking} env={env} req={req} />;
}

function Help({ close }: { close: () => void }) {
	const keys: Array<[string, string]> = [
		["↩", "Send. While the agent works, the message is given to that work and read at its next step"],
		["⌥↩", "Send, but let the message wait its turn"],
		["⇧↩", "New line"],
		["↑ ↓", "Earlier inputs, while the input is empty"],
		["esc", "Stop what the agent is doing"],
		["⇧⇥", "Next mode for this agent, while the input is empty"],
		["@", "Point at a file of the conversation's folder"],
		["/", "Commands, as in the terminal UI"],
		["⌘K", "Everything by name"],
		["⌘1 … ⌘9", "Go to that tab"],
		["⌃⇥", "Next tab"],
	];
	return (
		<Dialog open onOpenChange={(open) => open || close()}>
			<DialogContent showCloseButton={false} className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Keys and commands</DialogTitle>
				</DialogHeader>
				<ScrollArea className="-mx-4 max-h-(--dialog-scroll) flex min-h-0 flex-col *:data-[slot=scroll-area-viewport]:scroll-fade">
				<div className="flex flex-col gap-1.5 px-4 text-xs select-text">
					{keys.map(([k, about]) => (
						<Field key={k} orientation="horizontal" className="items-baseline">
							<span className="w-24 flex-none"><Kbd>{k}</Kbd></span>
							<span className="text-muted-foreground">{about}</span>
						</Field>
					))}
					{COMMANDS.map((c) => (
						<Field key={c.name} orientation="horizontal" className="items-baseline">
							<span className="w-24 flex-none font-mono">/{c.name}</span>
							<span className="text-muted-foreground">{c.about}{c.keys ? <> <Kbd>{c.keys}</Kbd></> : null}</span>
						</Field>
					))}
				</div>
				</ScrollArea>
				<DialogFooter>
					<Button variant="outline" onClick={close}>Close</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** After "Check for Updates…" found a newer app: where it is. The app fetches and installs nothing itself. */
function UpdateAsk() {
	const s = useModel(store);
	const u = s.update;
	const close = () => ((s.updateAsk = false), s.touch());
	if (u?.status !== "newer") return null;
	return (
		<Dialog open onOpenChange={(open) => open || close()}>
			<DialogContent showCloseButton={false} className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Pine {u.version} is available</DialogTitle>
				</DialogHeader>
				<div className="select-text">
					<p className="text-muted-foreground">This is Pine {u.mine}. The new app is a disk image on the release's page on GitHub: download it, quit Pine and put the new app in place of this one. Your pine home, with your agents, conversations and settings, stays as it is.</p>
					<p className="mt-2.5 cursor-auto font-mono text-xs text-faint select-text">{u.url}</p>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={close}>Not now</Button>
					<Button onClick={() => (void bridge.open(u.url), close())}><ExternalLinkIcon data-icon="inline-start" />Open the release page</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The browser the web tools drive is not on this Mac in the build this pine needs: asked at the
 * start, once for a version of pine. Settings > App offers the same at any time. While it is
 * fetched, the dialog stays.
 */
function BrowserAsk() {
	const s = useModel(store);
	const later = () => void s.browserLater();
	return (
		<Dialog open onOpenChange={(open) => open || s.browserFetching || later()}>
			<DialogContent showCloseButton={false} className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>The browser for the web tools is not on this Mac</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3 select-text">
					<p className="text-muted-foreground">Your agents open pages that need a real browser with one that pine fetches for itself. Each version of pine drives a build of its own, and this one's is not here yet: it was never fetched, or it is the build of an older pine. It is about 600 MB and is fetched once. Until then the browser tools do not work; web search and reading a page do.</p>
					{s.initLines.length ? <Printed sm text={s.initLines.slice(-12).join("\n")} /> : null}
				</div>
				<DialogFooter>
					<Button variant="outline" disabled={s.browserFetching} onClick={later}>Not now</Button>
					<Button disabled={s.browserFetching} onClick={() => void s.fetchBrowser()}>{s.browserFetching ? <><Spinner data-icon="inline-start" />Fetching…</> : "Fetch it"}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const SIDE_KEY = "pine.sidebar.width";
const SIDE_WIDTH = 248;

/** Remembers how wide a panel is, in pixels, for the next start. Only what the owner did is kept: a narrow window squeezes a panel without changing what it is set to. */
const keepWidth = (layout: Layout, panel: string, key: string) => {
	// The layout is in shares of the room the panels have together, and is told before the panels are
	// drawn at their new widths (after a key): the room is the same before and after.
	const group = document.getElementById(panel)?.parentElement;
	const share = layout[panel];
	if (!group || share === undefined) return;
	const room = [...group.children].filter((el) => el.hasAttribute("data-panel")).reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
	localStorage.setItem(key, String(Math.round((share * room) / 100)));
};

export function App() {
	const s = useModel(store);
	const [help, setHelp] = useState(false);
	useEffect(() => void s.boot(), [s]);
	useSignal("help", () => setHelp(true));
	// A file dropped beside the input must not take the window to that file.
	useEffect(() => {
		const stop = (e: DragEvent) => e.preventDefault();
		window.addEventListener("dragover", stop);
		window.addEventListener("drop", stop);
		return () => (window.removeEventListener("dragover", stop), window.removeEventListener("drop", stop));
	}, []);
	const ready = s.ready && s.active;
	const tab = s.active;
	const side = usePanelRef();
	// The window itself: what shows between and around the panels. On a Mac the system's material lies behind it.
	return (
		<div className={cn("flex h-full", s.platform === "darwin" ? "bg-sidebar" : "bg-sunk")}>
			{!ready ? (
				<Gate />
			) : (
				// The stock provider follows the model: its own ⌘B, where the page gets the key before the menu, toggles the same setting.
				<SidebarProvider open={s.sidebar} onOpenChange={(open) => open !== s.sidebar && void s.command("sidebar")}>
					<ResizablePanelGroup orientation="horizontal" onLayoutChanged={(layout, meta) => meta.isUserInteraction && keepWidth(layout, "sidebar-panel", SIDE_KEY)}>
						{s.sidebar ? (
							<>
								<ResizablePanel id="sidebar-panel" className="flex" panelRef={side} defaultSize={Number(localStorage.getItem(SIDE_KEY)) || SIDE_WIDTH} minSize={190} maxSize={460} groupResizeBehavior="preserve-pixel-size">
									<Sidebar />
								</ResizablePanel>
								<ResizableHandle className="bg-transparent" disableDoubleClick onDoubleClick={() => (side.current?.resize(SIDE_WIDTH), localStorage.setItem(SIDE_KEY, String(SIDE_WIDTH)))} title="Drag to make the side bar wider or narrower" />
							</>
						) : null}
						<ResizablePanel id="main" className="flex">
							<div className="flex min-w-0 flex-1 flex-col">
								<TitleBar />
								<div className={cn("flex min-h-0 flex-1 pr-1.5 pb-1.5", !s.sidebar && "pl-1.5")}>
									<ResizablePanelGroup orientation="horizontal" onLayoutChanged={(layout, meta) => meta.isUserInteraction && keepWidth(layout, "code-panel", CODE_KEY)}>
										<ResizablePanel id="view" className="flex" minSize={420}>
											{tab!.kind === "settings" ? <Settings /> : tab!.kind === "events" ? <Events tab={tab!} /> : <Conversation key={tab!.id} tab={tab!} />}
										</ResizablePanel>
										{s.code && tab!.kind === "chat" ? <CodePanel key={`code:${tab!.id}`} tab={tab!} /> : null}
									</ResizablePanelGroup>
								</div>
							</div>
						</ResizablePanel>
					</ResizablePanelGroup>
				</SidebarProvider>
			)}
			{s.browserAsk ? <BrowserAsk /> : null}
			{s.updateAsk ? <UpdateAsk /> : null}
			{s.picker ? <PickDialog key={s.picker.title} p={s.picker} /> : null}
			{s.palette ? <Palette /> : null}
			<Asking />
			{help ? <Help close={() => setHelp(false)} /> : null}
		</div>
	);
}
