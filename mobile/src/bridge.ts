// The page's way out on a phone: the same names as the desktop's preload (desktop/electron/preload.ts),
// each handed to the app's native side (ios/App/App/PinePlugin.swift). As on the desktop, the page
// holds no token: the native side keeps it in the Keychain and makes every call to the daemon.
// What a phone cannot do (a folder, a terminal, the microphone helper) says so instead.
import { registerPlugin } from "@capacitor/core";
import type { Bridge } from "../../desktop/electron/preload.ts";

interface Answer {
	ok: boolean;
	status: number;
	data: any;
}

interface PinePlugin {
	/** Where the paired pine answers, never its token. Nothing when the phone is not paired. */
	paired(): Promise<{ base?: string }>;
	/** Checks the address and the token against the daemon, and keeps them only when it answers. */
	pair(o: { base: string; token: string }): Promise<{ ok: boolean; error?: string }>;
	unpair(): Promise<void>;
	call(o: { method: string; url: string; body?: unknown }): Promise<Answer>;
	follow(): Promise<void>;
	open(o: { url: string }): Promise<void>;
	addListener(event: "events", fn: (e: { batch: unknown[] }) => void): Promise<{ remove: () => Promise<void> }>;
	addListener(event: "connection", fn: (e: { up: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
	addListener(event: "focus", fn: (e: { focused: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const Pine = registerPlugin<PinePlugin>("Pine");

const listen = (event: "events" | "connection" | "focus", pick: (e: any) => unknown) => (fn: (...args: any[]) => void) => {
	const handle = Pine.addListener(event as any, (e: any) => fn(pick(e)));
	return () => void handle.then((h) => h.remove());
};
const never = () => () => {};
const notHere = (what: string) => () => Promise.reject(new Error(`${what} is not on a phone: do it in the Pine app on your computer.`));

const PREFS_KEY = "pine.mobile.prefs";
const readPrefs = () => {
	try {
		return { keepRunning: false, theme: "system", notify: false, updates: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
	} catch {
		return { keepRunning: false, theme: "system", notify: false, updates: false };
	}
};

let serviceFns: Array<(s: unknown) => void> = [];

/** What the page is told about the daemon: asked of the daemon itself, since no `pine service` runs here. */
async function serviceState(): Promise<unknown> {
	const { base } = await Pine.paired();
	if (!base) return { status: "error", kind: "no-pine", message: "This phone is not paired with a pine." };
	const r = await Pine.call({ method: "GET", url: "/overview" });
	if (!r.ok) return { status: "error", kind: "failed", message: r.data?.error ?? `pine at ${base} does not answer (${r.status}).` };
	return { status: "ready", mode: "attached", started: false, home: r.data.home, version: r.data.version, from: base, remote: base };
}

export const mobileBridge: Bridge = {
	state: async () => ({
		state: await serviceState(),
		home: undefined,
		prefs: readPrefs(),
		platform: "ios",
		fullscreen: false,
		focused: true,
		updates: false,
		versions: { app: "0.1.0", electron: "" },
	}),
	ready: () => void Pine.follow(),
	call: (method, url, body) => Pine.call({ method, url, body }),
	retry: async () => {
		const s = await serviceState();
		for (const fn of serviceFns) fn(s);
	},
	update: async () => undefined,
	restart: notHere("Restarting pine"),
	init: notHere("Setting up a pine home"),
	browserInstall: notHere("Fetching the browser"),
	prefs: async (change: Record<string, unknown>) => {
		const next = { ...readPrefs(), ...change };
		localStorage.setItem(PREFS_KEY, JSON.stringify(next));
		return next;
	},
	pickFolder: async () => undefined,
	saveText: notHere("Saving a file"),
	open: (url: string) => Pine.open({ url }),
	reveal: notHere("Showing a file"),
	notify: async () => undefined,
	badge: async () => undefined,
	contextMenu: async () => undefined,
	command: async () => ({ state: "unavailable", why: "pine for a terminal is on your computer.", text: "" }),
	voiceStart: notHere("Dictation"),
	voiceStop: async () => undefined,
	pathOf: () => "",
	onService: (fn: (s: unknown) => void) => {
		serviceFns.push(fn);
		return () => void (serviceFns = serviceFns.filter((f) => f !== fn));
	},
	onEvents: listen("events", (e) => e.batch),
	onConnection: listen("connection", (e) => e.up),
	onMenu: never,
	onFocus: listen("focus", (e) => e.focused),
	onFullscreen: never,
	onInitLine: never,
	onVoice: never,
} as unknown as Bridge;
