// The bridge between the page and the main process: a short list of things the page may ask
// for, each by name. The page has no Node, no token and no other way out.
import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = (channel: string) => (fn: (...args: any[]) => void) => {
	const listener = (_e: unknown, ...args: any[]) => fn(...args);
	ipcRenderer.on(channel, listener);
	return () => void ipcRenderer.removeListener(channel, listener);
};

const bridge = {
	state: () => ipcRenderer.invoke("pine:state"),
	ready: () => ipcRenderer.send("pine:ready"),
	/** One call of the control API of an environment's pine. */
	call: (env: string, method: "GET" | "POST", url: string, body?: unknown) => ipcRenderer.invoke("pine:call", env, method, url, body),
	retry: (env: string) => ipcRenderer.invoke("pine:retry", env),
	/** Whether there is a newer app: what the start found, or with `again` what GitHub says now. Nothing where nobody is asked. */
	update: (again?: boolean) => ipcRenderer.invoke("pine:update", again),
	restart: (env: string) => ipcRenderer.invoke("pine:restart", env),
	init: () => ipcRenderer.invoke("pine:init"),
	/** Fetch the browser build this pine drives (`pine browser-install`); what it prints comes as init lines. */
	browserInstall: () => ipcRenderer.invoke("pine:browser"),
	prefs: (change: Record<string, unknown>) => ipcRenderer.invoke("pine:prefs", change),
	addEnvironment: (host: string) => ipcRenderer.invoke("pine:env-add", host),
	enableEnvironment: (env: string, on: boolean) => ipcRenderer.invoke("pine:env-enable", env, on),
	forgetEnvironment: (env: string) => ipcRenderer.invoke("pine:env-forget", env),
	pickFolder: (title?: string) => ipcRenderer.invoke("pine:pick-folder", title),
	saveText: (name: string, text: string) => ipcRenderer.invoke("pine:save-text", name, text),
	open: (url: string) => ipcRenderer.invoke("pine:open", url),
	reveal: (file: string) => ipcRenderer.invoke("pine:reveal", file),
	notify: (title: string, body: string, tab?: string) => ipcRenderer.invoke("pine:notify", title, body, tab),
	badge: (count: number) => ipcRenderer.invoke("pine:badge", count),
	contextMenu: (items: unknown[]) => ipcRenderer.invoke("pine:context-menu", items),
	/** `pine` for a terminal: what the shell has; with "install" or "remove", after doing that. */
	command: (action?: "install" | "remove") => ipcRenderer.invoke("pine:command", action),
	voiceStart: (language?: string) => ipcRenderer.invoke("pine:voice-start", language),
	voiceStop: (cancel?: boolean) => ipcRenderer.invoke("pine:voice-stop", cancel),
	/** Where a file that was dropped on the window lies: a folder is opened by its path, not read. */
	pathOf: (file: File) => webUtils.getPathForFile(file),
	onService: on("pine:service"),
	onEnvironments: on("pine:environments"),
	onEvents: on("pine:events"),
	onConnection: on("pine:connection"),
	onMenu: on("pine:menu"),
	onFocus: on("pine:focus"),
	onFullscreen: on("pine:fullscreen"),
	onInitLine: on("pine:init-line"),
	onVoice: on("pine:voice"),
};

contextBridge.exposeInMainWorld("pine", bridge);

export type Bridge = typeof bridge;
