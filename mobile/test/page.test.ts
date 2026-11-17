// The phone's page, in WebKit at a phone's size, on a stand-in for the app's native side
// (ios/App/App/Pine.swift): the stand-in answers the plugin's calls as the native side does, with
// the token in this process and never in the page. A pine of its own runs on the scripted model.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { webkit, type Browser, type Page } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "..");
const shots = process.env.PINE_MOBILE_SHOTS;

let mock: any;
let home: string;
let pine: ChildProcess;
let service: { base: string; token: string };
let site: http.Server;
let browser: Browser;
let page: Page;
const errors: string[] = [];

const write = (file: string, content: string) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, content));

async function shot(name: string) {
	if (!shots) return;
	fs.mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function sees(selector: string, timeout = 20_000) {
	try {
		await page.waitForSelector(selector, { timeout });
	} catch {
		await shot(`failed-${selector.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);
		throw new Error(`"${selector}" did not appear. On screen: ${(await page.evaluate(() => document.body.innerText)).slice(0, 800)}${errors.length ? `\nErrors: ${errors.join("\n")}` : ""}`);
	}
}

/** What the native side keeps: nothing until the page pairs, then the address and the token. */
let paired: { base: string; token: string } | undefined;

/** The native side's answers, as Pine.swift gives them. */
async function native(method: string, o: any): Promise<unknown> {
	if (method === "paired") return paired ? { base: paired.base } : {};
	if (method === "pair") {
		const res = await fetch(`${o.base}/overview`, { headers: { authorization: `Bearer ${o.token}` } }).catch(() => undefined);
		if (!res) return { ok: false, error: `pine does not answer at ${o.base}.` };
		if (res.status === 401 || res.status === 403) return { ok: false, error: `pine answers, but does not take this token (${res.status}).` };
		paired = { base: o.base, token: o.token };
		return { ok: true };
	}
	if (method === "call") {
		if (!paired) return { ok: false, status: 503, data: { error: "This phone is not paired with a pine." } };
		const res = await fetch(paired.base + o.url, { method: o.method, headers: { authorization: `Bearer ${paired.token}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, redirect: "manual" });
		const type = res.headers.get("content-type") ?? "";
		return type.startsWith("application/json") ? { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) } : { ok: res.ok, status: res.status, data: { mime: type, base64: Buffer.from(await res.arrayBuffer()).toString("base64") } };
	}
	if (method === "follow") return void follow();
	return undefined;
}

let following = false;
async function follow() {
	if (following || !paired) return;
	following = true;
	const res = await fetch(`${paired.base}/events/stream?topic=%23`, { headers: { authorization: `Bearer ${paired.token}` } });
	await page.evaluate(() => (window as any).__native.emit("connection", { up: true }));
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of res.body as any) {
		buf += decoder.decode(chunk, { stream: true });
		const batch: unknown[] = [];
		for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			if (block.startsWith("data: ")) batch.push(JSON.parse(block.slice(6)));
		}
		if (batch.length) await page.evaluate((b) => (window as any).__native.emit("events", { batch: b }), batch).catch(() => {});
	}
}

before(async () => {
	if (!fs.existsSync(path.join(root, "dist", "index.html"))) execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit" });
	const { startMock } = await import(path.join(repo, "baseline", "tests", "mock.mjs"));
	mock = await startMock({ strip: /<pine-note>[\s\S]*?<\/pine-note>\s*/g });
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-mobile-")));
	write(path.join(home, "models.json"), JSON.stringify({ providers: { mock: { name: "Mock", baseUrl: mock.baseUrl, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "m", name: "Mock", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	write(path.join(home, "pine.json"), JSON.stringify({ http: { host: "127.0.0.1", port: 0 }, main: "main", defaults: { model: "mock/m", mode: "safe" }, security: { askAccess: false } }));
	write(path.join(home, "agents", "main", "agent.json"), JSON.stringify({ description: "The main agent: it administers pine" }));
	write(path.join(home, "agents", "main", "workspace", "AGENTS.md"), "You are the main agent.\n");
	write(path.join(home, "agents", "scout", "agent.json"), JSON.stringify({ description: "Looks things up on the web" }));
	write(path.join(home, "agents", "scout", "workspace", "AGENTS.md"), "You are scout.\n");
	pine = spawn(process.execPath, [path.join(repo, "src", "cli.ts"), "service", "--home", home], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PINE_SKIP_DOWNLOADS: "1" } });
	service = await new Promise((resolve, reject) => {
		let out = "";
		pine.stdout!.on("data", (d) => {
			out += d;
			const line = out.split("\n").find((l) => l.includes('"token"'));
			if (line) resolve(JSON.parse(line));
		});
		pine.on("exit", (code) => reject(new Error(`pine service ended (${code}): ${out}`)));
	});

	// The page as the app has it, from its own folder.
	const dist = path.join(root, "dist");
	site = http.createServer((req, res) => {
		const file = path.join(dist, decodeURIComponent(new URL(req.url!, "http://x").pathname === "/" ? "/index.html" : new URL(req.url!, "http://x").pathname));
		if (!file.startsWith(dist) || !fs.existsSync(file)) return void res.writeHead(404).end();
		const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] ?? "application/octet-stream";
		res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
	});
	await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

	browser = await webkit.launch();
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	page = await context.newPage();
	page.on("pageerror", (e) => errors.push(String(e.stack ?? e.message).slice(0, 600)));
	await page.exposeBinding("__pineNative", (_src, method: string, options: unknown) => native(method, options));
	// What Capacitor finds in a native app's page before its own code runs: a bridge to the native side.
	await page.addInitScript(() => {
		const listeners = new Map<string, Array<{ id: string; fn: (d: unknown) => void }>>();
		let n = 0;
		const methods = ["paired", "pair", "unpair", "call", "follow", "open"].map((name) => ({ name, rtype: "promise" }));
		(window as any).webkit = { messageHandlers: { bridge: { postMessage: () => {} } } };
		(window as any).__native = { emit: (event: string, data: unknown) => (listeners.get(event) ?? []).forEach((l) => l.fn(data)) };
		(window as any).Capacitor = {
			PluginHeaders: [{ name: "Pine", methods: [...methods, { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }] }],
			nativePromise: (_plugin: string, method: string, options: any) => (method === "removeListener" ? Promise.resolve(listeners.forEach((ls, k) => listeners.set(k, ls.filter((l) => l.id !== options.callbackId)))) : (window as any).__pineNative(method, options)),
			nativeCallback: (_plugin: string, _method: string, options: any, fn: (d: unknown) => void) => {
				const id = String(++n);
				listeners.set(options.eventName, [...(listeners.get(options.eventName) ?? []), { id, fn }]);
				return id;
			},
		};
	});
});

after(async () => {
	await browser?.close().catch(() => {});
	site?.close();
	pine?.kill("SIGTERM");
	await mock?.close?.().catch(() => {});
	if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("a phone pairs with a pine, and the page never holds the token", async () => {
	await page.goto(`http://127.0.0.1:${(site.address() as any).port}/`);
	await sees(".pair");
	await shot("01-pair");
	await page.fill(".pair input[inputmode=url]", service.base);
	await page.fill(".pair input[type=password]", "not-the-token");
	await page.click(".pair .btn");
	await sees(".pair .error >> text=does not take this token");
	await page.fill(".pair input[type=password]", service.token);
	await page.click(".pair .btn");
	await sees(".titlebar");
	// Nothing in the page knows the token: not its text, not its storage.
	const inPage = await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify({ ...localStorage }));
	assert.ok(!inPage.includes(service.token));
});

test("on a phone the side bar is a drawer, and a conversation has the whole screen", async () => {
	await sees(".composer textarea");
	assert.equal(await page.locator(".sidebar").count(), 0, "the side bar is closed at the start");
	const width = await page.evaluate(() => document.querySelector(".conv")!.getBoundingClientRect().width);
	assert.ok(width >= 380, `the conversation is ${width}px wide`);
	await shot("02-conversation");
	await page.click(".titlebar .btn[title^='Show the sidebar']");
	await sees(".sidebar .side-conv");
	await shot("03-drawer");
	await page.click(".sidebar .side-conv");
	await page.waitForSelector(".sidebar", { state: "detached" });
});

test("a message goes to the agent and its answer comes back through the stream", async () => {
	await page.fill(".composer textarea", "hello from the phone");
	await page.keyboard.press("Enter");
	await sees(".conv >> text=hello from the phone");
	// Without a directive the scripted model says back what it was told.
	await page.waitForFunction(() => document.querySelector(".conv")!.textContent!.split("hello from the phone").length > 2, null, { timeout: 20_000 });
	await shot("04-answer");
	assert.deepEqual(errors, []);
});
