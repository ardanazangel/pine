# The desktop app

pine has an app with a window of its own, for macOS: **Pine**. It does what the terminal UI
does (conversations in tabs, the work of a turn, approvals, the code panel) and adds an editor
for the files of a conversation's folder, a settings panel for everything that is otherwise a
`pine` command or a sentence to the main agent, pictures, video and sound shown and played as
they are, menus and system notifications.

It lies in `desktop/` of pine's repository and is built on Electron, so that the same app can
be made for Linux and Windows later. It is a client of the daemon and nothing more: everything
it shows and changes goes through the control API ([operations.md](operations.md)), as with
the terminal UI and the `pine` commands. A conversation you have in the app is the same one
the terminal UI or Telegram shows.

## Getting it

Every release of pine has the app attached, as a disk image for each kind of Mac:
<https://github.com/pmndre/pine/releases/latest>

| File | For |
|---|---|
| `Pine-<version>-arm64.dmg` | A Mac with Apple silicon (M1 and later) |
| `Pine-<version>-x64.dmg` | A Mac with an Intel processor |

Open the image and drag Pine into Applications. Nothing else has to be installed: no Node, no
`npm install`, no developer tools. The app is signed and notarised, and it carries

| | |
|---|---|
| pine | The same package that goes to npm, with what it depends on. The app and the pine inside it have one version |
| Node | The Node that pine runs on, as nodejs.org hands it out. The pine of the app runs on it, whatever Node the Mac has or lacks |
| pine's helpers | The small programs for dictating, app control and the `system` event source, built for both kinds of Mac. Elsewhere pine builds them on first use, which needs Apple's command line developer tools |
| `pine` for a terminal | See below |

### A newer version

The app does not update itself: it says when there is a newer one and where it is. To get it,
download the new image from the release's page, quit Pine and put the new app in place of the
old one. Your pine home (`~/.pine`: agents, conversations, settings) is not in the app and
stays as it is.

| | |
|---|---|
| At the start | The app asks GitHub once for pine's last release. When that is newer than the app, a line at the foot of the side bar says so (`Pine <version> is available`); a click opens the release's page on GitHub in your browser. Nothing is said when the app is the latest, or when nobody answers |
| `Check for Updates…` | In the **Pine** menu (and `updates` in the command palette): asks again now and says what it found, with the link to the release's page when there is a newer app |
| Settings > App | The app's version and whether it is the latest, **Check now**, and the switch **Look for a newer version at the start** for the question at the start. The menu asks whatever the switch says |

A release counts as a newer app once its disk image for your kind of Mac is attached to it,
which is some minutes after pine itself is published. A preview of pine is not a release, and
the app never points at one. The app fetches and installs nothing. `pine update` in a pine that
came with the app says the same in a terminal. An app started from a checkout is no release
and asks nobody.

### The first start

Two things the app does not carry: a sign-in to whoever does the thinking, and the browser the
web tools drive. It asks for each where it is missing.

| What the app finds | What it does |
|---|---|
| No pine home | It offers to set pine up (`pine init`): the example home is copied, and the browser is fetched (about 600 MB, once) |
| Nothing to answer with | A conversation in which nothing was said yet says why and has a button to Settings > Models; that page lists everyone it holds for. Two reasons are found without sending anything: nobody is signed in to the provider, or it is `dev/claude-haiku`, what the example home starts with (Claude through the `claude` command of Claude Code, on the subscription Claude Code is signed in to), on a Mac that has no such command |
| A sign-in in Settings > Models | A Claude, ChatGPT or Copilot subscription is signed in to through the browser (**Sign in**), any provider with an API key. Nothing switches by itself, so the dialog then offers **Choose the model your agents run on**, from what the sign-in brought. The page keeps that choice (`defaults.model`) with **Change** |
| The browser is not there in the build this pine drives | Each version of pine drives a browser build of its own. A home that an older pine set up, or a new app in place of an old one, has the old build or none. The app asks once for each version of pine whether to fetch it, and Settings > App shows whether it is there, with **Fetch it** (`pine browser-install`, run by the app's pine). Until then the browser tools do not work; web search and reading a page do |

### `pine` in a terminal

If you installed only the app, your shell has no `pine` command until the app puts one
there. With it, everything in [operations.md](operations.md) works in a terminal on that Mac:
the terminal UI, `pine status`, `pine agent add`. The command is a link in a folder of your
shell's PATH to a small launcher inside the app, which runs the app's pine on the app's Node.

| When | What happens |
|---|---|
| The first start of the app from Applications | The link is made by itself where that needs no password: in `~/.local/bin` or `~/bin` if your PATH has one of them, else in `/usr/local/bin` or `/opt/homebrew/bin` if you may write there |
| No such folder | Nothing is done by itself. **Pine > pine in a Terminal…** in the menu, or Settings > App, sets it up in `/usr/local/bin`; macOS asks for your password |
| Your shell already has a `pine` (from npm, from a checkout) | It is left alone, and the app says where it is. The app still runs its own |
| The app was opened from the disk image or from Downloads | Nothing is set up: macOS runs it from a place that changes. Move it into Applications first |
| The app was moved | The old link leads nowhere. Set it up again in Settings > App |

Settings > App shows where the link is and takes it away again (Remove). Only a link the app
made is ever removed or replaced.

## Starting it from a checkout

From a checkout of pine:

```bash
cd desktop
```

```bash
npm install
```

```bash
npm start
```

`npm run dev` is the same with the page reloading as you edit it. To make an app that can be
put into Applications:

```bash
npm run pack
```

That writes `desktop/release/mac-arm64/Pine.app` (on an Intel Mac `release/mac/Pine.app`;
`npm run dist` also makes a disk image). It is the app as it is handed out, signed for the Mac
it was built on. See "Packing and signing" for what it carries and how it is signed for others.

| Command (in `desktop/`) | What it does |
|---|---|
| `npm start` | Builds the app and opens it |
| `npm run dev` | Opens it with the page served by Vite, reloading on every change |
| `npm run check` | Type check |
| `npm test` | The app from end to end: the real app on a pine home of its own with a scripted model. Needs a screen. With `PINE_LIVE=1` on a Mac it also dictates with the real voice helper, from a recording |
| `npm run pack` | `release/mac-arm64/Pine.app`, with pine, Node and the helpers inside |
| `npm run dist` | The same, and a disk image |
| `node scripts/smoke.mjs` | Starts a packed app from a folder of its own, on a home of its own, and checks that it answers a message with the pine and the Node it carries, that `pine` works through a link, and that pine finds the helpers in the app |

pine itself runs on Node 24 or newer, also when the app starts it, and never on the app's own
Electron. The pine of a packed app runs on the Node the app carries. From a checkout the app
looks for `node` the way your shell finds it (it asks your login shell for its environment,
since an app started from the Finder has none of it); a packed app does the same for a pine
that is not its own, and falls back to its own Node where the Mac has none.

## The daemon: started or reused

When the app opens it asks `pine service` ([operations.md](operations.md), "A UI of its own")
for the daemon of your home:

| What it finds | What happens |
|---|---|
| A pine is running for this home (started in a terminal, at login, by the terminal UI) | The app attaches to it. The side bar says `attached`. Quitting the app leaves it running |
| Nothing runs | The app starts one, as the terminal UI does, logging to `data/pine.log`. The side bar says `started here`. Quitting the app stops it, cleanly |
| There is no pine home yet | A first screen offers to set pine up (`pine init`): the example home and the browser its web tools drive |
| No Node, or no pine | A screen that says what to install |

Which pine it runs, in this order: what `PINE_CLI` names; the checkout the app lies in; the
pine packed into the app; the `pine` of your shell.

| Setting (Settings > App) | What it does |
|---|---|
| Keep pine running after the app quits | A pine the app starts goes on in the background when the app is closed: schedules fire, sources report and Telegram answers. It then runs until it is stopped (`pine status` finds it; the next start of the app attaches to it) |
| Home folder | Another pine home than `~/.pine`. Another home is another pine |
| pine in a terminal | Whether your shell has the `pine` command and whose it is; Set up and Remove for the app's own. See "`pine` in a terminal". Only in an app that carries pine |
| Appearance | Light, dark, or what the system is set to |
| Notifications | A system notification when an agent is done, stops with an error, needs your approval or asks you something while the window is not in front. The words are pine's own ("main is done"), never the agent's |

Closing the window does not quit the app on a Mac: it, and a daemon it started, stay until
you quit (`⌘Q`). A daemon the app started that stops answering is started again.

## The window

```
 ● ● ●          ◧   M main   M main · notes ×   ⚙ Settings   +           ← tabs
 ⌕ Search and commands ╭──────────────────────────────╮ ╭───────────────────────╮
 Agents              + │ M main / notes   ▢ ~/dev/x  7% ◨ │ Changes Last turn Files … │
 ▾ M main            + │                              │ │                       │
     the main agent    │        what do the notes say?│ │  M index.ts  src +1 −1│
     ★ main conversation ▸ 1 tool call · read · 148 ms│ │                       │
     ○ notes           │ The notes say first line.    │ │                       │
 ▸ B books     ⠹     + │ ╭──────────────────────────╮ │ │                       │
 ▾ S scout           + │ │ Message main · / · @     │ │ │                       │
     ★ main conversation │ + ▣ m  ✳ off  ⛨ safe  ▢ x ↑│ │ │                       │
 ⌇ Events  ⚙ Settings  │ ╰──────────────────────────╯ │ │                       │
 ● pine 0.22 · started here ──────────────────────────╯ ╰───────────────────────╯
```

The panels lie as cards on the window: the conversation, and beside it the code panel.

**The side bar is your agents.** Each agent is a group: its name and what it is for, and under
it its conversations. Everything that starts something new stands on the agent's own line, so
it is never a question whom it is for.

| On an agent's line | What it does |
|---|---|
| A click on the agent | Folds its conversations away, or shows them again. The app remembers which groups are folded. A folded agent still shows that it is at work (a green dot that pulses), waits for you (`!`) or has something new (a dot) |
| `+` | A new conversation with that agent |
| The folder (when the pointer is on the line) | Opens a folder of yours for a new conversation with that agent |
| The gear (when the pointer is on the line) | That agent's page in the settings |
| A right click | A new conversation, a folder and the settings as a menu, and **Remove** for every agent but the main one, which administers pine and stays. Remove asks first, and how: with everything the agent has, or with its folder kept |
| `+` beside "Agents" | A new agent |

An agent that somebody else makes while the app is open (the main agent when you ask it to,
`pine agent add`, the terminal UI) appears in the side bar within a few seconds, and one that
is removed goes, with its tabs. A conversation in which an agent is at work has a green dot that pulses
whether or not a tab shows it.

Where no agent is named, the app goes by the tab in front, and asks when that is not an
agent's:

| You do | With whom |
|---|---|
| `⌘T`, or `+` at the end of the tabs | The agent of the tab in front (the button says which). From the settings or the event log you are asked with whom |
| `⌘O`, or a folder put on the app's icon | With one agent, that one. With several you are asked which agent works in the folder; the one in front is offered first |
| `⇧⌘T` | Always asks with whom |

| Part | What it is |
|---|---|
| Side bar | Search at the top, then your agents (see above). Drag its right edge to make it wider or narrower (a double click on the edge sets it back), `⌘B` hides it and shows it again, and it is after a restart as you left it; where nothing is to click, it moves the window. An agent's own conversation (`main conversation`) comes first, then pinned ones, then by when they were last used. A click on a conversation opens it in a tab; a right click offers Pin, Rename, Remove (or Start over for an agent's own). At the bottom: the event log, the settings, and whether pine answers |
| Tabs | One conversation each, with its agent's initial, as in the terminal UI: a green dot that pulses while the agent works (every such dot in the window pulses in step), a dot when something arrived while you were elsewhere, `!` when it waits for your approval, `★` for a conversation that is kept for good. Drag a tab to move it. They are the same tabs the terminal UI opens: the daemon keeps the list |
| Conversation | A conversation in which nothing was said yet shows who its agent is: what it is for, its model and mode, whom it hands work to, and how many skills, event sources, schedules and MCP servers it has. Then your messages, the agent's answers drawn as markdown, and the work of each turn (tool calls, thoughts, sub-tasks, what it said on the way) folded into one line that a click opens. A `↳ … open` line opens a sub-agent's or delegated task's work in a tab of its own |
| Input | `↩` sends; while the agent works the message is given to that work, and `⌥↩` makes it wait its turn. `⇧↩` is a new line, `↑` brings back earlier inputs, `esc` stops the agent. `/` offers the commands of the terminal UI, `@` the files of the conversation's folder |
| The line at the top of a conversation | Whose it is and which (`main / notes`), the folder it works in, how full its context is (tokens read and the share of the window; hover for the cache share and speed), and the code panel's button |
| The bar under the input | `+` attaches files; then the agent's model, how much it reasons and its mode, and where the conversation works (the agent's own workspace, or a folder of yours): each opens a list on a click. `outside content` appears when the conversation has read something from outside |
| Side panel | Beside a conversation (`⌥⌘B`): the agent, then its files, changes and output. See "The code panel and the editor" |
| Search | `⌘K`, or Search in the side bar: see "Finding a conversation" |

### Finding a conversation

`⌘K` (or Search at the top of the side bar) is one box for everything. Type a few words:

| It finds | By |
|---|---|
| A conversation | Its name, and what was said in it: your messages and the agent's answers. A conversation found by what was said opens with the words marked in it (`↩` goes to the one before, `⇧↩` to the next) |
| An open tab, an agent, a settings page | Its name |
| A command | Its name, or what it does |

What fits by its name comes first, then the conversations in which the words were said (each
with who said it and the place), then the rest. The search over what was said covers the last
thousand tasks of all agents, which is what the daemon hands out at once; an older message is
found by opening its conversation and using `⌘F` there.

A conversation you only started (`+`) has no name of its own. The app calls it by how it
began: the first thing you said in it, in the side bar, on its tab and in the search. Give it a
name with Rename (a right click, or `/rename`) and that name is used.

Beside each of your messages, while the pointer is on it, is a button that branches the
conversation from there: a new conversation with what was said up to the end of that
message's turn, opened in a tab, while the original stays as it was. A right click on the
message, or Branch in the menu of a conversation in the side bar (all of it), does the same.
A branch stands under the conversation it was made from in the side bar, with the branch
sign, and is called after it ("… · branch") until you rename it. What a branch takes along
and what it does not is in [agents.md](agents.md#branching-a-conversation).

A conversation can work in a worktree of its folder's repository: a checkout of its own, so
that conversations working on one project at once do not write over each other's files
([coding.md](coding.md#a-worktree-for-a-conversation)). File › New Conversation in a
Worktree… (⌥⌘T) starts one, from the folder of the conversation in front or one you pick;
Conversation › Worktree… moves the conversation in front into one, and "Branch from here into a
worktree" (a right click on a message of yours) or "Branch into a Worktree" (the menu of a
conversation in the side bar) branches into one. Its header shows the branch (`pine/<name>`)
instead of the folder, and the side bar the branch sign. A click on the branch, Conversation ›
Worktree… or "Worktree…" in the side bar's menu opens what can be done with it: merge or squash
it into what it was made from, update it from there, ask the agent to commit, discard it. The
Changes view of the panel says how many commits it is ahead, with a button to merge.

Everything in [tui.md](tui.md) about modes, goals, approvals, an agent's questions, its list
of steps, sub-agents, `/undo` and what a conversation is holds here unchanged: it is the
daemon's doing. What differs is how it is drawn and reached.

| In the terminal UI | In the app |
|---|---|
| `/model`, `/reasoning`, `/mode`, `/folder` | Also the bar under the input, and the Conversation menu |
| `/sessions`, the conversation list | The side bar |
| `/code` | The side panel (`⌥⌘B`), which begins with the agent and also edits |
| `/mcp`, `/sources`, `/subscribe` | Also Settings > MCP servers and Settings > Events |
| `/attach <path>`, `/paste` | Files from the Finder put on the input, a picture pasted into it, or the `+` in the bar under the input |
| `/export` | Asks where to save the file |
| `/voice`, `ctrl+r` | The microphone in the bar under the input, or `⌃R` |
| `/quit` | `⌘Q` |
| `shift+tab` (next mode) | The same, while the input is empty |
| `alt+1` … `alt+9` | `⌘1` … `⌘9`; `⌃⇥` is the next tab |

### What the app adds

| | |
|---|---|
| Pictures, video, sound | A picture an answer points at is shown as it is; a click enlarges it. A video and a sound file get the system's own player controls, with sound |
| Files from the Finder | Files put on the input with the mouse are attached to the next message (up to 10 files of 20 MB each); a folder put there is opened for the conversation, as with `/folder`. A folder put on the app's icon in the Dock opens a conversation that works in it, as `pine <folder>` does |
| Menus and keys | Everything is in the menu bar, with its key |
| Notifications | See the settings above. The app's icon carries the number of conversations that wait for you |
| Find | `⌘F` marks what you look for in the conversation |
| The poimandres theme | The dark look is poimandres: its colours for the window, and for code in an answer, in a diff and in the editor. The light look has colours of its own |
| Several views at once | A conversation, its changes and a file in the editor side by side |

## The code panel and the editor

The panel beside a conversation (`⌥⌘B`) begins with the agent and goes on to its work. The
work is that of the folder the conversation works in (the folder you opened for it, else the
agent's workspace):

| View | Shows |
|---|---|
| Agent | The agent of this conversation: what it is for, its model, reasoning and mode (a click changes each), whom it hands work to; what is at work right now (this conversation, the sub-agents and delegated tasks it started, the agent's other conversations), each to open; what it listens to (event sources, and whether this conversation, the agent or all agents are subscribed); its schedules, skills and MCP servers; and what it remembers (its `MEMORY.md`). Buttons lead to the settings pages where each is changed |
| Files | The folder as a tree, a search by name, and the editor |
| Changes | What differs from the last commit (git): each file with its counts, and its diff on a click |
| Last turn | What your last message changed, whatever git says, with "Take back" (`/undo`) |
| Browser | The browser the agent of this conversation works in, live, and yours to use too. See "The browser" below |
| Output | The tool calls of the last messages, each with all it printed |
| Running | What the conversation's commands left running (a dev server, a watcher): its ports as links, its last output, and Stop. A port's link opens that address in the Browser view of the conversation, where the agent sees the same page; only where the conversation has no browser does it open in your own |

While an agent keeps a list of steps, the open steps stand at the top of the panel.

**The editor.** A click on a file in Files (or "Edit" on a diff) opens it in an editor with
line numbers, colours for the common languages, search (`⌘F` in the editor) and undo.
`⌘S` saves. A file the agent changes while you look at it is shown anew; if you have typed
meanwhile, the app says that the file changed on disk and lets you take the new one. Files
over 2 MB and binary files are shown and not edited.

Saving goes through the daemon like everything else (`POST /agents/<id>/view/write`). The
daemon writes the file inside a sandbox that reaches only that folder, so that a link an agent
planted in its folder cannot make your save land somewhere else ([security.md](security.md)).
On a system without a sandbox the daemon does not write, and the app says so.

### The browser

The Browser view (`⇧⌘B`) shows the browser of the conversation: the same one the agent opens
pages in, with its logins. In the terminal UI that browser has no window until the agent puts
one on your screen (`browser_show`); in the app it is in the panel, and no other window opens.

| | |
|---|---|
| What you see | The page the agent is on, as it is right now, a few times a second. The page is laid out for the room the panel has, so it is shown at its real size; make the panel wider and the page gets wider. The browser's tabs are a row of tabs above the page, the agent's and yours alike |
| What you can do | Click, type, turn the wheel, drag, paste (`⌘V` types what is in your clipboard), go back and forward, load again, open a tab (`+`), choose one, close one (closing the last one leaves the browser without a page, with its logins kept), and type an address into the line above the page. Enough to log in, solve a captcha or confirm something yourself |
| An address of your own | Opened like any other, through pine's guard. One on this computer or your network (`localhost:3000`) is allowed for this conversation by your typing it, as a yes to the agent's question would. pine's own control port stays closed |
| When the agent wants you to look | It calls `browser_show`: the panel opens on the Browser view. While the app runs, that call opens no window on your screen |
| What the agent knows | What you do there, it sees when it next looks at the page. When you took the browser to another page, the agent is told so before it acts, and does not act on a page it has not seen ([mcp.md](mcp.md), "Seeing the browser, and logging in yourself") |
| No page | Until the agent opens one, or you open an address, there is nothing to show. The browser of a conversation closes when the conversation has been idle for a while (`idleMs`, 15 minutes) and when pine restarts. Opening an address starts it again, without a turn of the agent's; its logins are kept |
| Running in this conversation | While no page is open, the view lists the ports of the programs this conversation left running (a dev server the agent started), as under Running. A click opens `localhost:<port>` in this browser |
| Opened by the agent before | While no page is open, the view lists the last addresses the agent opened in this conversation, newest first, at most 12. A click opens one. Only a page that came is listed, and never an address the agent was refused. The list is the conversation's: it goes when the conversation is reset or removed |

A page the agent made for you to use (a board, switches, a form) is shown here like any other,
and what you press on it wakes the agent ([interfaces.md](interfaces.md)).

It is a picture of the page, and not the page: nothing of a web page is loaded into the app's
window. So what a browser does around a page is not there: no downloads to your disk, no file
to choose for an upload, no passkey or system dialog, no copying out of the page, and text is
typed without an input method. For those, close the app's Browser view and ask the agent in
the terminal UI to show the browser, or set `"headed": true` for the browser.

## Environments: pine on other machines

The app can use the pine of other machines besides the one on this computer: a server, a
desktop at home, anything you reach with `ssh`. Settings > Environments lists This Mac and the
machines you added, each with a switch. Every environment that is on is connected at the same
time: the side bar has a section for each, under its name, with its agents and their
conversations, and conversations of both can be open side by side in tabs. Each is a pine of its
own, so two agents of the same name (both have a `main`) are two agents: a tab of another
machine says which beside the agent's name, and so do notifications ("main on server is done").

| What | How |
|---|---|
| Add an environment | Type the host as you would after `ssh` (`server`, `user@server`, a name from `~/.ssh/config`) and choose Add and connect. The app connects to it at once and keeps it, on, when that pine answers; its agents appear in the side bar without a restart. What went wrong is said beside the field, and a host that does not answer is not kept |
| Turn one on or off | The switch on its line. Off: its tabs close and its section leaves the side bar; a pine this app started for it is stopped, and an SSH link is closed. One environment always stays on |
| Forget one | The bin beside a machine that is off |
| One that does not answer | Its section in the side bar says so (connecting, reconnecting, not reached) with Try again; the others go on as they are. At start every environment that is on is connected at once, and a slow or broken one holds up none of the others |
| Settings of which pine | The pages that are a pine's own (General, Agents, Models, MCP servers, Skills, Events, Instructions) show one environment's: with several on, a list at the top of the settings chooses which. The gear on an agent's line opens that agent's environment |
| The event log | Each environment has its own: Events shows the one of the tab in front |

What is chosen is kept in the app's `prefs.json` (`environments`: this computer and each
machine, with whether it is on).

How it connects: one ssh connection to the machine runs `pine service` there, with the PATH
of the owner's login shell (sh, bash, zsh, fish, csh or tcsh) and nvm's node when pine was
installed with it. It attaches to the daemon that runs there or starts one, held by that ssh
as the local one is held by the app. The same connection then forwards a port of this
computer to the daemon's port (`ssh -O forward` through its control socket, so there is one
sign-in): ssh binds that port itself, and when somebody else took it, ssh says so at once and
another is tried, so nothing is ever sent to a port that is not ssh's. The forward ends at the
other machine's loopback, and only there: a service line that names another address is
refused. So the control API stays closed to the network there: it takes requests for
`127.0.0.1` only. A link that breaks is made again.

| Needs | |
|---|---|
| A key, not a password | The app has no terminal to type a password in (`BatchMode=yes`): a key in `ssh-agent` (`ssh-add`), or an SSH service that signs you in by itself, such as Tailscale SSH |
| A machine ssh knows | The app cannot answer ssh's question whether a new machine's key is the right one: connect to it once from a terminal (`ssh user@server`) and accept the key, then add it |
| A pine with `pine service` | An older pine is not reached: update it there with `pine update` |
| A pine home there | `pine init` on that machine first |

Folders are the machine's whose pine the agent is of: for an agent of another machine,
choosing a folder asks for its path there instead of opening the Finder, and a folder dropped
from the Finder is refused. A folder dropped on the app's icon is for an agent of this computer.
The Browser view of such a conversation shows the browser on that machine, and an address you
type there (`localhost:3000`) is one of that machine.
Settings > App is about the pine on this computer (started here or attached, restart, home
folder).

## Settings

`⌘,` opens the settings panel in a tab of its own, beside the conversations (the same key puts
it away again; the event log is a tab in the same way). It is pine's configuration, changed by
clicking instead of by a command or by asking an agent. Each page asks the daemon what there is and tells it what to change.
The daemon checks a change as it checks the main agent's (the same code), writes it, reads the
configuration back, and undoes what does not load. You are not asked to confirm in a dialog
of pine's: the app is your own hand, like a `pine` command.

| Page | What you do there | The same by command or by asking the main agent |
|---|---|---|
| General | pine's settings, each by a name with its key in `pine.json` beside it and a sentence on what it does: the model, reasoning and mode agents start from, how long a command and a task may run, how many agents work at once, and what pine asks you about. What only tunes pine to a model server is not there: that is written into `pine.json` by hand ([setup.md](setup.md), "pine's settings"). And the notes `pine check` would print about this setup | `set_setting`; `pine check` |
| Agents | Every agent. On an agent's page: what it is for, its model, reasoning, mode, built-in tools, whom it may hand work to, network from its shell, folders outside its workspace, and the files it is told (`AGENTS.md`, `SOUL.md`, `TOOLS.md`; its `MEMORY.md` and your rules for it are shown). New agent; Remove, with or without its folder | `create_agent`, `update_agent`, `remove_agent`; `pine agent …` |
| Models | Model servers of your own (add by name and address, with its key when it wants one; remove). Providers: sign in through the browser or with an API key, sign out; after a sign-in, the choice of the model your agents run on. That model (`defaults.model`) with Change, and each agent whose model cannot answer with the reason. The models you can use now | `add_model_server`; `pine model …`, `pine login`, `pine logout`; `set_setting` |
| MCP servers | Every server with whom it is for and whether it connects. Add a remote one (its https address) or a program on this computer, for all agents or one. Sign in to a remote one through the browser. Remove | `add_mcp_server`; `pine mcp …` |
| Skills | Every skill with whom it is for. Read one, change it, add one for all agents or one agent, remove one. A skill that lies in a folder of yours that the configuration names is shown and not changed | `add_skill`, `remove_skill`; `pine skills` |
| Events | **Sources**: what runs, who is subscribed, the last event; add one by type (the type's options as a form, what it will do said before it is added, a password or token typed into a field of its own), subscribe an agent or all agents, end a subscription, remove. **Schedules**: add (at set times, every so often, once), remove. **Routes**: add, remove | `add_source`, `subscribe`, `add_schedule`, `add_route`; `pine sources`, `pine subscribe`, `pine schedules` |
| Instructions | The three files for all agents in pine's home: `AGENTS.md`, `TOOLS.md`, `USER.md` | Telling the main agent something that is for all agents |
| Environments | Which pines the app talks to, at the same time: this computer's and other machines' over SSH, each on or off (above) |  |
| App | The app's own settings (appearance, notifications, whether there is a newer app and whether that is asked at the start), and the pine on this computer: started here or attached, restart, home folder, the `pine` command for a terminal, and whether the browser of the web tools is on this Mac, with Fetch it when it is not | `pine browser-install` |

A secret you type on these pages (a model server's key, a source's token, a provider's API
key) goes from the field to the daemon and from there into pine's `.env` or `auth.json`. It is
not shown again, not kept by the app, and never reaches an agent or a model.

An app that is newer than the pine it attached to says so where a page needs something that
pine does not know yet ("this pine does not know that yet: it is older than the app"): update
pine and restart it.

## Dictating a message

On a Mac the microphone in the bar under the input (or `⌃R`, or `/voice [language]`) dictates
the message, with the helper the terminal UI uses: the words are recognised on the Mac itself,
and what is heard is text in the input until you send it. `↩` ends the listening, `esc` throws
away what was heard, and a key that types ends it too. Everything under "Dictating a message"
in [tui.md](tui.md) holds here, also what the first use asks for and what to do when it does
not work. On another system there is no microphone in the bar.

## What the app is careful about

The page in the window draws what agents write, and an answer can repeat what a web page told
the agent to write. So:

| | |
|---|---|
| The page has no token and no Node | The daemon's token stays in the app's main process, which makes each call for the page. The page runs in the browser's sandbox, without access to files or programs |
| An answer is content, not a page | It is drawn from markdown and cleaned of everything that could act: scripts, styles, forms, frames. The window's own policy lets it load nothing from the web |
| A link says where it leads | The address stands next to a link whose words are not the address, and only `http` and `https` addresses open, in your browser |
| Nothing is fetched because an answer contains it | A picture at a web address is a line to click (`Load picture · https://…`); the daemon then fetches it, with its guard against addresses in your network. A picture at a path in the agent's workspace is shown from there |
| What is drawn straight from the daemon | Only pictures, video and sound, by fixed addresses of the control API |
| Notifications and the window's title | pine's own words only |
| What is heard | Text for the input: never sent by itself |
| The window stays the app | It cannot be taken to another address, and opens no further windows |
| The agent's browser in the panel | A picture, drawn; its address and titles as text. The browser is the agent's own, another program behind pine's guard: the app hands the daemon what you did in the picture (places, keys, an address), and the browser's own server checks each piece before anything is done |
| What the app itself asks the web | One thing: GitHub, for pine's last release (see "A newer version"). The question carries nothing about this Mac, your pine or the app's version. Of the answer only the release's number is used, and the link you get is made by the app and leads to pine's releases on GitHub, whatever was answered |

The app does not reach into pine's home: it reads no configuration file and no token file
itself. What it knows, the daemon told it.

## Packing and signing

`node scripts/pack.mjs` (in `desktop/`; `npm run pack`) makes the app that is handed out.

| Flag | What it does |
|---|---|
| `--dmg` | Also a disk image, `release/Pine-<version>-<arch>.dmg` |
| `--arch` | `arm64` or `x64`: the kind of Mac the app is for. Without it, the kind it is packed on. The helpers are built for both either way |
| `--no-pine` | Without pine, Node and the helpers: the app then uses the `pine` of the owner's shell |
| `--out` | Into another folder than `release/`, for a build beside one that is open |

What goes into `Pine.app/Contents/Resources`:

| Folder | What it is |
|---|---|
| `pine/` | The package `npm run build` makes, with its dependencies installed, and the helpers built by `scripts/helpers.mjs` in `prebuilt/` folders beside their sources (pine looks there before it builds one: `src/prebuilt.ts`) |
| `node/` | `bin/node` and its licence from nodejs.org, in the version of the Node that runs the pack script, checked against the checksums nodejs.org publishes |
| `bin/pine` | The launcher for a terminal (`scripts/pine.sh`) |

The app is always signed with the hardened runtime, so that what is tried on the Mac it was
built on is what is shipped. Whom it is signed for is set in the environment:

| Variable | What it is |
|---|---|
| (none) | Signed for this Mac only ("ad hoc"). Another Mac refuses to open it |
| `CSC_NAME` | The name of a "Developer ID Application" identity in the keychain |
| `CSC_LINK` | The same certificate with its key as a `.p12` file: a path, or the file as base64. With `CSC_KEY_PASSWORD`, its password |
| `APPLE_API_KEY` | The path of an App Store Connect API key (`.p8`). With `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` the signed app is notarised by Apple, which a downloaded app needs to open |
| `PINE_VERSION` | The version of the app and of the pine inside it. Without it, the version in the checkout's `package.json` |

The Release workflow (`.github/workflows/release.yml`) does this for every release from
`main`, on a runner for each kind of Mac, and attaches the two disk images to the GitHub
release. It takes the five values from secrets of an environment named `release`. Without
them it builds no app and says so. To build the app of a release again (after a job that
failed), run the workflow by hand from `main` with that release's version:
`gh workflow run release.yml -f version=0.38.0`. Nothing is published; the disk images are
attached to that release. Building the helpers takes the macOS 26 SDK or a newer one.

## For changing the app

```
desktop/
  electron/
    main.ts        the main process: the window, menus, dialogs, notifications; the daemon's token
                   and every call of the control API; the two addresses the page may load from
    preload.ts     the bridge: the short list of things the page may ask the main process for
    service.ts     finds node and pine, runs `pine service`, keeps the daemon it started
    command.ts     `pine` for a terminal: the link into the shell's PATH, made and removed
    updates.ts     whether there is a newer app: GitHub asked for the last release, the link to its page
  src/             the page (React)
    model.ts       what the page knows: tabs, what each conversation shows, the daemon's live events
    api.ts         the control API, typed
    App.tsx        the window: side bar, tabs, palette, the dialogs for approvals and questions
    Conversation.tsx, Composer.tsx, markdown.tsx     a conversation, the input, an answer drawn
    CodePanel.tsx  changes, files and the editor, output, what is running
    Browser.tsx    the agent's browser in the panel: its page as a picture, and what is done in it handed back
    Settings.tsx   the settings pages
    commands.ts    the commands: one list for the palette, the menus and what is typed after a slash
  scripts/         build, dev, pack, the icon, the smoke test of a packed app, pine.sh (the
                   launcher that becomes Resources/bin/pine)
  test/            the app from end to end, driven through its real window; command.test.ts
                   and updates.test.ts need no window
```

- The page asks for something new through `preload.ts` and a handler in `main.ts`, never by
  getting more of the system. A handler checks that the call comes from the app's own page.
- What the daemon can do is added to the control API (`src/http.ts`, `src/owner.ts`) with a
  test there, then to `api.ts`. The app never does a daemon's work itself.
- Text an answer or a tool produced is drawn through `markdown.tsx` or as plain text, never
  set as HTML anywhere else.
- A new thing the owner can see or do gets a test in `desktop/test/`, which starts the real
  app on a home of its own.
