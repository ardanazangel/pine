// What the page has of the world outside itself: the bridge the preload script exposes.
import type { Bridge } from "../electron/preload.ts";

declare global {
	interface Window {
		pine: Bridge;
	}
}

export type ServiceState = { status: "starting" } | { status: "ready"; mode: string; started: boolean; home: string; version?: string; from: string; remote?: string } | { status: "error"; kind: "no-home" | "no-node" | "no-pine" | "ssh" | "failed"; message: string };

/** An environment as the main process tells of it: this computer, or a machine over SSH. */
export interface EnvironmentView {
	id: string;
	host?: string;
	label: string;
	enabled: boolean;
	state: ServiceState;
	connected: boolean;
}

export interface Prefs {
	home?: string;
	keepRunning: boolean;
	environments: Array<{ id: string; host?: string; enabled: boolean }>;
	theme: "system" | "light" | "dark";
	notify: boolean;
	updates: boolean;
}

export type { Update } from "../electron/updates.ts";

export const bridge = window.pine;
