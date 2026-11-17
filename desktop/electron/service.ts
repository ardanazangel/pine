// The app's way to a pine daemon: reuse the one that runs, or start one and stop it again.
//
// The app is a client of the control API and nothing else (rule 10 of pine's AGENTS.md), so it
// does not load pine's code into its own process. It asks the `pine service` command, which
// answers with one line of JSON: where the daemon listens and its token. When that command had to
// start the daemon it stays alive as the daemon, and this file keeps it as a child.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface Service {
	base: string;
	token: string;
	/** "attached", "embedded daemon", "embedded daemon + claude -p": the words the terminal UI uses. */
	mode: string;
	/** This app started the daemon, and stops it when it quits. */
	started: boolean;
	home: string;
	version?: string;
	/** The machine it runs on, when that is another one reached over SSH: the host name ssh is given, without the user. */
	remote?: string;
	stop(): Promise<void>;
}

export class ServiceError extends Error {
	/** "no-home": there is no pine home yet. "no-node", "no-pine": something to install. "ssh": the other machine is not reached. "failed": the daemon said why. */
	kind: "no-home" | "no-node" | "no-pine" | "ssh" | "failed";
	constructor(kind: ServiceError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

export interface Launch {
	/** The program and first arguments that run pine's command line. */
	argv: string[];
	env: NodeJS.ProcessEnv;
	/** Where it was found, in words for the settings page. */
	from: string;
}

const run = (file: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) =>
	new Promise<{ code: number; out: string }>((resolve) => {
		execFile(file, args, { timeout: opts.timeout ?? 8000, env: opts.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout) }));
	});

let shellEnv: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * The environment of the owner's login shell. An app started from the Finder has a PATH of four
 * system folders: no node from Homebrew or nvm, and none of the tools an agent's commands expect.
 * The daemon this app starts is to behave like one started in a terminal, so it gets the
 * environment a terminal would have.
 */
export function loginEnv(): Promise<NodeJS.ProcessEnv> {
	shellEnv ??= (async () => {
		if (process.platform === "win32") return { ...process.env };
		const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
		// Between two marks, so that whatever a profile prints does not get in the way.
		const { out } = await run(shell, ["-ilc", "printf '\\n__PINE_ENV__\\n'; env; printf '__PINE_END__\\n'"], { timeout: 6000 });
		const body = /__PINE_ENV__\n([\s\S]*?)__PINE_END__/.exec(out)?.[1];
		if (!body) return { ...process.env };
		const env: NodeJS.ProcessEnv = {};
		let last = "";
		for (const line of body.split("\n")) {
			const at = line.indexOf("=");
			if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, at))) env[(last = line.slice(0, at))] = line.slice(at + 1);
			else if (last) env[last] += `\n${line}`; // a value of several lines
		}
		return { ...process.env, ...env };
	})();
	return shellEnv;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const file = path.join(dir, name);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return file;
		} catch {
			// not here
		}
	}
	return undefined;
}

async function nodeVersion(file: string, env: NodeJS.ProcessEnv): Promise<number> {
	const { out } = await run(file, ["-p", "process.versions.node"], { env });
	return Number(out.trim().split(".")[0]) || 0;
}

/**
 * How to run pine's command line from here, in this order: what PINE_CLI names; the checkout this
 * app lies in (development); the copy that was packed into the app; the `pine` command of the
 * owner's shell. pine runs on Node, never on the app's own Electron: its children are started
 * with `process.execPath`, which has to be a plain Node. The pine the app carries runs on the
 * Node the app carries, so that it is the pair that was made and tried together; another pine
 * runs on the owner's Node, and on the app's only where there is no other.
 */
export async function findPine(appRoot: string, resources?: string): Promise<Launch> {
	const env = await loginEnv();
	const places = [
		...(process.env.PINE_CLI ? [{ file: process.env.PINE_CLI, from: "PINE_CLI" }] : []),
		{ file: path.join(appRoot, "..", "bin", "pine.js"), from: "this checkout" },
		...(resources ? [{ file: path.join(resources, "pine", "bin", "pine.js"), from: "the app" }] : []),
	];
	const script = places.find((p) => fs.existsSync(p.file) && (p.from !== "this checkout" || fs.existsSync(path.join(appRoot, "..", "src", "cli.ts"))));
	if (script) {
		const own = resources ? path.join(resources, "node", "bin", "node") : undefined;
		const theirs = [onPath("node", env), "/opt/homebrew/bin/node", "/usr/local/bin/node", path.join(os.homedir(), ".volta", "bin", "node")];
		const candidates = [process.env.PINE_NODE, ...(script.from === "the app" ? [own, ...theirs] : [...theirs, own])].filter((x): x is string => Boolean(x && fs.existsSync(x)));
		for (const node of candidates) if ((await nodeVersion(node, env)) >= 24) return { argv: [node, script.file], env, from: script.from };
		throw new ServiceError("no-node", candidates.length ? `pine needs Node 24 or newer, and the node found on this computer (${candidates[0]}) is older. Install a current one from https://nodejs.org, then try again.` : "pine runs on Node, and no node was found on this computer. Install Node 24 or newer from https://nodejs.org, then try again.");
	}
	const pine = onPath("pine", env);
	if (pine) return { argv: [pine], env, from: pine };
	throw new ServiceError("no-pine", "pine is not installed on this computer. Install it by typing this into a terminal: npm install -g @pmndre/pine");
}

/**
 * The folder pine itself lies in, for what a UI uses of it beside the control API (the source of
 * the voice helper). Undefined when it cannot be told.
 */
export function pineRoot(launch: Launch): string | undefined {
	try {
		const script = fs.realpathSync(launch.argv[1] ?? launch.argv[0]);
		const root = path.resolve(path.dirname(script), "..");
		return fs.existsSync(path.join(root, "package.json")) ? root : undefined;
	} catch {
		return undefined;
	}
}

/** Run a pine command to its end and hand on what it prints, line by line. For `pine init` on a first start. */
export function runPine(launch: Launch, args: string[], onLine: (line: string) => void, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(launch.argv[0], [...launch.argv.slice(1), ...args], { env: { ...launch.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		const take = (d: Buffer) => {
			buf += d.toString("utf8").replace(/\r/g, "\n");
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line.trim()) onLine(line);
			}
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("error", (e) => (onLine(e.message), resolve(1)));
		child.on("close", (code) => (buf.trim() && onLine(buf), resolve(code ?? 1)));
	});
}

type Answer = { said: any } | { failed: "timeout" | "garbage" | "spawn" | "exit"; detail: string; err: string };

/** The one line of JSON `pine service` prints, read from the child that runs it (here, or on another machine). */
function answer(child: ChildProcess, ms = 60_000): Promise<Answer> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let settled = false;
		const done = (a: Answer) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(a);
		};
		const timer = setTimeout(() => (child.kill("SIGTERM"), done({ failed: "timeout", detail: "", err })), ms);
		child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-4000)));
		child.stdout!.on("data", (d: Buffer) => {
			if (settled) return;
			out += d.toString("utf8");
			const end = out.indexOf("\n");
			if (end < 0) return;
			try {
				done({ said: JSON.parse(out.slice(0, end)) });
			} catch {
				done({ failed: "garbage", detail: out.slice(0, 200), err });
			}
		});
		child.on("error", (e) => done({ failed: "spawn", detail: e.message, err }));
		child.on("close", (code) => done({ failed: "exit", detail: String(code), err }));
	});
}

/**
 * Ask `pine service` for a daemon. It attaches to the one of this home if one runs; otherwise it
 * becomes one. `keep`: a daemon started here goes on when the app quits.
 */
export async function connect(launch: Launch, opts: { home?: string; keep?: boolean } = {}): Promise<Service> {
	const args = [...launch.argv.slice(1), "service", ...(opts.home ? ["--home", opts.home] : []), ...(opts.keep ? ["--keep"] : [])];
	// Its stdin is the leash: when this app dies without a word, the pipe closes and the daemon stops.
	// (One that is kept gets no pipe it could still be writing into when this app is gone, but for its one line.)
	const child: ChildProcess = spawn(launch.argv[0], args, { env: launch.env, stdio: opts.keep ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "pipe"], detached: Boolean(opts.keep) });
	const a = await answer(child);
	if ("failed" in a) {
		if (a.failed === "timeout") throw new ServiceError("failed", `pine did not come up within a minute.${a.err.trim() ? ` It said: ${a.err.trim().slice(-400)}` : ""}`);
		if (a.failed === "garbage") throw new ServiceError("failed", `pine answered with something that is not its service line: ${a.detail}`);
		if (a.failed === "spawn") throw new ServiceError("failed", `pine could not be started: ${a.detail}`);
		throw new ServiceError(/pine init|no pine home/i.test(a.err) ? "no-home" : "failed", a.err.trim().slice(-600) || `pine ended at once (exit ${a.detail}) without saying why. An older pine has no "service" command: update it with "pine update".`);
	}
	const said = a.said;
	if (said.error) throw new ServiceError(/pine init|no pine home/i.test(said.error) ? "no-home" : "failed", String(said.error));
	let gone = !said.started;
	const ended = new Promise<void>((done) => child.once("close", () => ((gone = true), done())));
	if (opts.keep) {
		// It goes on by itself from here: nothing of it is held any more.
		child.stdout?.destroy();
		child.unref();
	}
	return {
		base: String(said.base),
		token: String(said.token),
		mode: String(said.mode ?? "attached"),
		started: said.started === true,
		home: String(said.home ?? opts.home ?? ""),
		version: typeof said.version === "string" ? said.version : undefined,
		stop: async () => {
			if (gone || opts.keep) return;
			child.kill("SIGTERM");
			// It stops its agents and closes its database first; a daemon that hangs is ended.
			const hard = setTimeout(() => child.kill("SIGKILL"), 12_000);
			await ended;
			clearTimeout(hard);
		},
	};
}

// ---- a pine on another machine, over SSH ----------------------------------------------------------
//
// The control API takes requests for 127.0.0.1 only, so the other machine's daemon is reached
// through a local port forward: to this app it is a daemon on a port of this computer.

/** What may name the other machine: an ssh host or `user@host`, never an option for ssh. */
export function remoteHost(value: string | undefined): { host: string; label: string } | undefined {
	const host = value?.trim();
	if (!host) return undefined;
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host)) throw new ServiceError("ssh", `"${host.slice(0, 80)}" is not a host for ssh. Write it as host or user@host, as you would after "ssh".`);
	return { host, label: host.replace(/^.*@/, "").split(".")[0] || host };
}

/** No password prompt (there is no terminal to type it in), and a link that died is noticed in under a minute. */
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/**
 * What runs on the other machine, in its owner's environment. ssh hands the command to the login
 * shell there, which may be sh, bash, zsh, fish, csh or tcsh: so what that shell parses is only
 * `exec /bin/sh -c '...'`, with nothing inside the quotes that one of them reads differently (no
 * quote, backslash, "!" or line break; `remoteCommand` checks). The rest is sh. Its PATH is the
 * one the login shell sets (`printenv PATH` means the same in all of them; the last line, in
 * case a startup file prints),
 * and nvm's node when pine was installed with it (nvm sets its PATH in .bashrc, which a shell
 * without a terminal skips). `pine service` exits at once when it attaches to a daemon that
 * runs; `cat` then holds the session, so that the connection and its forward stay, and its
 * stdin stays the leash.
 */
export const REMOTE_SCRIPT = [
	`p=$("\${SHELL:-/bin/sh}" -l -c "printenv PATH" </dev/null 2>/dev/null | tail -n 1)`,
	// (tcsh takes -l only alone; it reads its startup files with -c as well.)
	`[ -n "$p" ] || p=$("\${SHELL:-/bin/sh}" -c "printenv PATH" </dev/null 2>/dev/null | tail -n 1)`,
	`[ -n "$p" ] && PATH="$p" && export PATH`,
	`[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1`,
	`command -v pine >/dev/null || { echo "pine is not installed there: no pine command on its PATH." >&2; exit 127; }`,
	`pine service && exec cat >/dev/null`,
].join("; ");

export const remoteCommand = () => {
	if (/['\\!\n]/.test(REMOTE_SCRIPT)) throw new Error("the remote script has a character that a login shell would read differently");
	return `exec /bin/sh -c '${REMOTE_SCRIPT}'`;
};

export const sshArgs = (host: string, more: string[], command?: string) => [...SSH_OPTIONS, ...more, host, ...(command ? [command] : [])];

/** The ssh program. PINE_DESKTOP_SSH names a stand-in, for tests only. */
const ssh = () => process.env.PINE_DESKTOP_SSH || "ssh";

/** What went wrong with ssh, in words that say what to do. */
function sshTrouble(host: string, a: Exclude<Answer, { said: any }>): string {
	const said = a.err.replace(/^#.*\n?/gm, "").trim().slice(-500);
	const check = /https:\/\/login\.tailscale\.com\/\S+/.exec(a.err)?.[0];
	if (a.failed === "spawn") return `ssh could not be started (${a.detail}). It comes with macOS; is /usr/bin/ssh there?`;
	if (a.failed === "timeout") return check ? `Tailscale SSH wants you to confirm it is you before ${host} lets this app in. Open ${check}, sign in, then try again.` : `${host} did not answer over SSH within a minute.${said ? ` ssh said: ${said}` : ""}`;
	if (a.failed === "garbage") return `${host} answered with something that is not pine's service line: ${a.detail}`;
	if (a.detail === "127") return `pine is not installed on ${host}, or not on the PATH of its login shell. ${said}`;
	// This app cannot answer ssh's question whether a new machine is the right one: a terminal can, once.
	if (/host key verification failed|no \S+ host key is known|remote host identification has changed/i.test(said)) return `${host} is not among the machines ssh knows yet. Connect to it once from a terminal (ssh ${host}) and accept its key, then try again. ssh said: ${said}`;
	if (a.detail === "255") return `Could not connect to ${host} over SSH. ${said || "ssh gave no reason."}${/permission denied|password|publickey/i.test(said) ? " This app cannot type a password: it needs a key in ssh-agent (ssh-add) or Tailscale SSH." : ""}`;
	return said || `ssh to ${host} ended (exit ${a.detail}) without saying why.`;
}

/** A port of this computer that nothing listens on now. */
const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port;
			server.close(() => resolve(port));
		});
	});

/**
 * Where the other machine's daemon answers, as the far end of the forward. A daemon always
 * listens on loopback, so a service line that names anything else is not taken: the forward
 * would carry the token to another host.
 */
export function loopbackEnd(base: string): string {
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new ServiceError("failed", `The other machine's pine named no address it answers at: ${base.slice(0, 80)}`);
	}
	const port = Number(url.port);
	const host = url.hostname === "[::1]" ? "[::1]" : /^127(\.\d{1,3}){3}$/.test(url.hostname) ? url.hostname : undefined;
	if (url.protocol !== "http:" || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw new ServiceError("failed", `The other machine's pine says it answers at ${base.slice(0, 80)}, which is not a port of its own loopback. This app connects only to that.`);
	return `${host}:${port}`;
}

/**
 * The daemon of another machine, over one ssh connection. It runs `pine service` there (which
 * attaches, or starts one that this ssh then holds by its stdin, as the local child does) and is
 * the master of a control socket. Through that socket a forward from a port of this computer to
 * the daemon's is added (`ssh -O forward`): ssh binds the port itself and says at once when it
 * cannot, so no request is sent to a port that somebody else took, and nobody signs in twice.
 */
export async function connectRemote(value: string, env: NodeJS.ProcessEnv): Promise<Service> {
	const { host, label } = remoteHost(value)!;
	// The control socket, in a folder only this user can open.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ssh-"));
	const control = ["-o", `ControlPath=${path.join(dir, "c")}`];
	const child: ChildProcess = spawn(ssh(), sshArgs(host, ["-o", "ControlMaster=yes", "-o", "ControlPersist=no", ...control], remoteCommand()), { env, stdio: ["pipe", "pipe", "pipe"] });
	let gone = false;
	const ended = new Promise<void>((done) => child.once("close", () => ((gone = true), fs.rmSync(dir, { recursive: true, force: true }), done())));
	const stop = async () => {
		if (gone) return;
		child.kill("SIGTERM");
		const hard = setTimeout(() => child.kill("SIGKILL"), 12_000);
		await ended;
		clearTimeout(hard);
	};
	try {
		const a = await answer(child);
		if ("failed" in a && /unknown command "service"/.test(a.err)) throw new ServiceError("ssh", `The pine on ${host} is too old to be reached from this app: it has no "service" command. Update it there with "pine update", then try again.`);
		if ("failed" in a) throw new ServiceError("ssh", sshTrouble(host, a));
		const said = a.said;
		if (said.error) throw new ServiceError("failed", `The pine on ${label} did not start: ${said.error}`);
		const far = loopbackEnd(String(said.base));
		// A port that was free a moment ago may be taken by now: then ssh says so, and another is tried.
		let port = 0;
		let err = "";
		for (let tries = 0; tries < 5 && !port; tries++) {
			const p = await freePort();
			const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
				const f = spawn(ssh(), sshArgs(host, [...control, "-O", "forward", "-L", `127.0.0.1:${p}:${far}`]), { env, stdio: ["ignore", "ignore", "pipe"] });
				let e = "";
				f.stderr!.on("data", (d: Buffer) => (e = (e + d.toString("utf8")).slice(-2000)));
				f.once("error", (x) => resolve({ code: -1, err: x.message }));
				f.once("close", (code) => resolve({ code, err: e }));
			});
			if (gone) break;
			if (r.code === 0) port = p;
			else err = r.err.trim();
		}
		if (!port) throw new ServiceError("ssh", gone ? `The SSH connection to ${host} ended before a port of this computer could be forwarded to its pine.` : `No port of this computer could be forwarded to the pine on ${host}.${err ? ` ssh said: ${err.slice(-400)}` : ""}`);
		return {
			base: `http://127.0.0.1:${port}`,
			token: String(said.token),
			mode: `remote: ${label}`,
			started: said.started === true,
			home: `${label}:${String(said.home ?? "~/.pine")}`,
			version: typeof said.version === "string" ? said.version : undefined,
			remote: label,
			stop,
		};
	} catch (e) {
		await stop();
		throw e;
	}
}

// ---- the environments the owner keeps -----------------------------------------------------------
//
// This computer ("local") and the machines added over SSH, each on or off. The id names an
// environment to the page, in its calls and in the addresses of its pictures (pine-media://<id>/),
// so it is a host name's letters and never changes once given.

export interface Environment {
	id: string;
	/** The ssh host; none for this computer. */
	host?: string;
	/** Connected and shown. */
	enabled: boolean;
}

export const LOCAL = "local";

/** An id for a new SSH environment that no other one has. */
export function environmentId(host: string, taken: Iterable<string>): string {
	const have = new Set(taken);
	const base = `ssh-${host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 50);
	let id = base;
	for (let n = 2; have.has(id) || id === LOCAL; n++) id = `${base}-${n}`;
	return id;
}

const hostOf = (value: unknown): string | undefined => {
	try {
		return typeof value === "string" ? remoteHost(value)?.host : undefined;
	} catch {
		return undefined;
	}
};

/** The environments as prefs.json keeps them: this computer always among them, and one always on. */
export function readEnvironments(raw: any): Environment[] {
	const out: Environment[] = [];
	if (Array.isArray(raw?.environments)) {
		for (const e of raw.environments) {
			if (!e || typeof e !== "object") continue;
			if (e.id === LOCAL && !e.host) {
				if (!out.some((x) => x.id === LOCAL)) out.push({ id: LOCAL, enabled: e.enabled !== false });
				continue;
			}
			const host = hostOf(e.host);
			if (!host || out.some((x) => x.host === host)) continue;
			const id = typeof e.id === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/.test(e.id) && e.id !== LOCAL && !out.some((x) => x.id === e.id) ? e.id : environmentId(host, out.map((x) => x.id));
			out.push({ id, host, enabled: e.enabled === true });
		}
	}
	if (!out.some((x) => x.id === LOCAL)) out.unshift({ id: LOCAL, enabled: true });
	// One is always on: with none there would be nothing to show.
	if (!out.some((x) => x.enabled)) out[0].enabled = true;
	return out.slice(0, 21);
}
