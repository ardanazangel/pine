// The app from end to end: the real Electron app on a pine home of its own, with the scripted
// model server of pine's test suite behind it. It starts the daemon itself (`pine service`),
// which is half of what is tested here.
//
//   npm test                         in desktop/
//   PINE_DESKTOP_SHOTS=<folder>      also saves a picture of each screen there
//   PINE_DESKTOP_THEME=dark|light    in that appearance
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { _electron as electron } from "playwright-core";
import { mockMsg, startMock } from "../../baseline/tests/mock.mjs";
import { httpMcp } from "../../test/support/http-mcp.ts";

const root = path.resolve(import.meta.dirname, "..");
const shots = process.env.PINE_DESKTOP_SHOTS;

let app: any;
let page: any;
let mock: any;
let home: string;
/** The pine home of "another machine": reached through a stand-in for ssh. */
let far: string;
let folder: string;
/** Where the browser of the web tools would lie (Playwright's own variable for it): a folder of the test's, empty at the start. */
let browsers: string;
/** A stand-in for GitHub, which the app asks for pine's last release: what it answers, and how often it was asked. */
let github: http.Server;
const releases = { status: 200, tag: "v9.9.9", asked: 0 };
/** What went wrong in the page itself, said with a failure. */
const pageErrors: string[] = [];

const write = (file: string, content: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};

async function shot(name: string): Promise<void> {
	if (!shots) return;
	fs.mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Wait for something on screen; when it does not come, say what is there instead. */
async function sees(selector: string, timeout = 20_000): Promise<void> {
	try {
		await page.waitForSelector(selector, { timeout });
	} catch {
		await shot(`failed-${selector.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);
		const there = await page.evaluate(() => ({ text: (document.querySelector(".column, .set-in, .events-list, .gate") as HTMLElement | null)?.innerText?.slice(-1500), toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent), dialog: (document.querySelector(".dialog") as HTMLElement | null)?.innerText?.slice(0, 600) }));
		throw new Error(`"${selector}" did not appear. On screen: ${JSON.stringify(there, null, 1)}${pageErrors.length ? `\nErrors in the page:\n${pageErrors.join("\n")}` : ""}`);
	}
}

/** What a menu item does: the menus are the system's, and keys typed into the page do not reach them. */
const menu = (command: string) => app.evaluate(({ BrowserWindow }: any, c: string) => BrowserWindow.getAllWindows()[0].webContents.send("pine:menu", c), command);

const api = (method: string, url: string, body?: unknown) => page.evaluate(([m, u, b]: [string, string, unknown]) => (window as any).pine.call(m, u, b), [method, url, body]);

before(async () => {
	if (!fs.existsSync(path.join(root, "dist", "index.html")) || !fs.existsSync(path.join(root, "dist-electron", "main.js"))) execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" });
	mock = await startMock({ strip: /<pine-note>[\s\S]*?<\/pine-note>\s*/g });
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-desktop-")));
	write(path.join(home, "models.json"), JSON.stringify({ providers: { mock: { name: "Mock", baseUrl: mock.baseUrl, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "m", name: "Mock", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	// A port of its own (0: the system picks one), so that a pine the developer has running is left alone.
	write(path.join(home, "pine.json"), JSON.stringify({ http: { host: "127.0.0.1", port: 0 }, main: "main", defaults: { model: "mock/m", mode: "safe" }, security: { askAccess: false } }, null, 2));
	write(path.join(home, "agents", "main", "agent.json"), JSON.stringify({ description: "The main agent: it administers pine", delegates: ["scout"], approve: ["bash"] }));
	write(path.join(home, "agents", "main", "workspace", "AGENTS.md"), "You are the main agent.\n");
	write(path.join(home, "agents", "main", "workspace", "notes.md"), "# Notes\n\nfirst line\n");
	write(path.join(home, "agents", "scout", "agent.json"), JSON.stringify({ description: "Looks things up on the web" }));
	write(path.join(home, "agents", "scout", "workspace", "AGENTS.md"), "You are scout.\n");
	browsers = path.join(home, "browsers");
	fs.mkdirSync(browsers, { recursive: true });
	// A folder of the owner's, with a git history, to open for a conversation.
	folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-desktop-folder-")));
	write(path.join(folder, "README.md"), "# Okapi\n\nA small project.\n");
	write(path.join(folder, "src", "index.ts"), "export const answer = 41;\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	write(path.join(folder, "src", "index.ts"), "export const answer = 42;\n");

	// A stand-in for the voice helper: it "hears" two words, and a third when it is told that was all.
	const voice = path.join(home, "voice-stand-in.mjs");
	write(voice, `#!/usr/bin/env node
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
say({ type: "ready" });
setTimeout(() => say({ type: "partial", text: "about the scans" }), 50);
process.stdin.on("end", () => say({ type: "final", text: "about the scans please" }));
process.stdin.resume();
`);
	fs.chmodSync(voice, 0o755);

	github = http.createServer((_req, res) => {
		releases.asked++;
		const version = releases.tag.slice(1);
		res.writeHead(releases.status, { "content-type": "application/json" }).end(JSON.stringify({ tag_name: releases.tag, html_url: "https://example.invalid/elsewhere", assets: ["arm64", "x64"].map((arch) => ({ name: `Pine-${version}-${arch}.dmg` })) }));
	});
	await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));

	// Another machine, as the app reaches it: a stand-in for ssh that runs `pine service` on a home
	// of its own as the master of a control socket, and through that socket binds the port that
	// `-O forward -L` asks for, or says it cannot, as ssh does.
	far = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-desktop-far-")));
	write(path.join(far, "models.json"), fs.readFileSync(path.join(home, "models.json"), "utf8"));
	write(path.join(far, "pine.json"), JSON.stringify({ http: { host: "127.0.0.1", port: 0 }, main: "main", defaults: { model: "mock/m", mode: "safe" }, security: { askAccess: false } }, null, 2));
	write(path.join(far, "agents", "main", "agent.json"), JSON.stringify({ description: "The main agent of the other machine" }));
	write(path.join(far, "agents", "main", "workspace", "AGENTS.md"), "You are the main agent there.\n");
	write(path.join(far, "agents", "helper", "agent.json"), JSON.stringify({ description: "Helps on the other machine" }));
	write(path.join(far, "agents", "helper", "workspace", "AGENTS.md"), "You are helper.\n");
	const ssh = path.join(home, "ssh-stand-in.mjs");
	write(ssh, `#!${process.execPath}
import { spawn } from "node:child_process";
import net from "node:net";
const args = process.argv.slice(2);
const opt = (name) => args.map((a, i) => args[i - 1] === "-o" && a.startsWith(name + "=") ? a.slice(name.length + 1) : undefined).find(Boolean);
const control = opt("ControlPath");
if (args.includes("-O")) {
	const c = net.connect(control);
	let reply = "";
	c.on("data", (d) => (reply += d));
	c.on("end", () => { if (reply.startsWith("ok")) process.exit(0); console.error("mux_client_forward: forwarding request failed: " + reply.slice(5).trim()); process.exit(255); });
	c.on("error", (e) => { console.error("Control socket connect: " + e.message); process.exit(255); });
	c.end(args[args.indexOf("-L") + 1] + "\\n");
} else {
	if (!/exec \\/bin\\/sh -c '.*pine service && exec cat/.test(args.at(-1) ?? "")) { console.error("not the command the app runs"); process.exit(2); }
	if (opt("ControlMaster") === "yes") net.createServer((c) => c.once("data", (d) => {
		const [, port, toHost, toPort] = String(d).trim().split(":");
		const server = net.createServer((s) => { const to = net.connect(Number(toPort), toHost); s.pipe(to).pipe(s); s.on("error", () => to.destroy()); to.on("error", () => s.destroy()); });
		server.once("error", () => c.end("fail Port forwarding failed"));
		server.listen(Number(port), "127.0.0.1", () => c.end("ok"));
	})).listen(control);
	const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.resolve(root, "..", "bin", "pine.js"))}, "service", "--home", ${JSON.stringify(far)}], { stdio: "inherit", env: { ...process.env, PINE_SKIP_DOWNLOADS: "1" } });
	let running = true;
	let ending = false;
	process.on("SIGTERM", () => { ending = true; if (running) child.kill("SIGTERM"); else process.exit(0); });
	// As "pine service && exec cat": after a service that attached, the session lasts until stdin ends.
	child.on("exit", (code) => { running = false; if (code || ending) process.exit(code ?? 0); });
	process.stdin.on("end", () => (running ? child.on("exit", () => process.exit(0)) : process.exit(0)));
	process.stdin.resume();
}
`);
	fs.chmodSync(ssh, 0o755);

	// PINE_DESKTOP_THEME=dark|light: the pictures in that appearance, whatever the system is set to.
	if (process.env.PINE_DESKTOP_THEME) write(path.join(home, "desktop-data", "prefs.json"), JSON.stringify({ theme: process.env.PINE_DESKTOP_THEME }));

	app = await electron.launch({
		// (The driver shows every page in light unless it is told otherwise, whatever the app says.)
		colorScheme: process.env.PINE_DESKTOP_THEME === "dark" ? "dark" : "light",
		args: [root],
		env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers, PINE_HOME: home, PINE_DESKTOP_DATA: path.join(home, "desktop-data"), PINE_SKIP_DOWNLOADS: "1", PINE_DESKTOP_DEV_URL: "", PINE_DESKTOP_VOICE: voice, PINE_DESKTOP_RELEASES: `http://127.0.0.1:${(github.address() as any).port}/repos/pmndre/pine/releases/latest`, PINE_DESKTOP_SSH: ssh },
	});
	page = await app.firstWindow();
	page.on("pageerror", (e: Error) => pageErrors.push(String(e.stack ?? e.message).slice(0, 600)));
	page.on("console", (m: any) => m.type() === "error" && pageErrors.push(m.text().slice(0, 600)));
	await page.setViewportSize?.({ width: 1280, height: 820 }).catch(() => {});
});

after(async () => {
	await app?.close().catch(() => {});
	await mock?.close?.().catch(() => {});
	github?.close();
	for (const dir of [home, far, folder]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("starts a daemon of its own and shows the main agent", async () => {
	await sees(".welcome h1");
	assert.equal(await page.textContent(".welcome h1"), "main");
	// This home has no browser for the web tools in the build its pine drives (the folder for it
	// is empty): that is asked once, at the start, and "Not now" is remembered.
	await sees(".dialog-title >> text=The browser for the web tools is not on this Mac");
	await shot("00-browser");
	await page.click(".dialog-foot .btn >> text=Not now");
	await page.waitForSelector(".dialog", { state: "detached" });
	assert.match(await page.textContent(".side-status"), /started here/);
	const agents = await page.$$eval(".side-agent .who > :first-child", (els: Element[]) => els.map((e) => e.textContent?.trim()));
	assert.deepEqual(agents, ["main", "scout"]);
	// The daemon it started is the one of this home, on a port of its own.
	assert.ok(fs.existsSync(path.join(home, "data", "http-token")));
	// The line around the tab in front is drawn outside the tab, and the row of tabs scrolls: what
	// lies outside the row is cut off. So the row has to leave the line its pixel on every side.
	const room = await page.evaluate(() => {
		const row = document.querySelector(".tabs")!.getBoundingClientRect();
		const tab = document.querySelector(".tab.on")!.getBoundingClientRect();
		return { top: tab.top - row.top, bottom: row.bottom - tab.bottom, left: tab.left - row.left };
	});
	assert.ok(room.top >= 1 && room.bottom >= 1 && room.left >= 1, `the row cuts off the line around the tab in front: ${JSON.stringify(room)}`);
	// At the foot of the side bar the dot of the status stands under the icons of the rows above
	// it, and what is written beside it under their names.
	const foot = await page.evaluate(() => {
		const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
		const middle = (r: DOMRect) => r.left + r.width / 2;
		return { icon: middle(box(".side-foot .side-row .icon")), dot: middle(box(".side-status .dot")), name: box(".side-foot .side-row .grow").left, status: box(".side-status .cut").left };
	});
	assert.equal(foot.dot, foot.icon, `the dot of the status is not under the icons above it: ${JSON.stringify(foot)}`);
	assert.equal(foot.status, foot.name, `the status is not written under the names above it: ${JSON.stringify(foot)}`);
	await shot("01-welcome");
});

test("a newer app is said at the start and when asked, with a link to its page on GitHub and nothing fetched", async () => {
	const mine = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const link = "https://github.com/pmndre/pine/releases/tag/v9.9.9";
	// The start asked once, and the side bar says what it found.
	await sees(".side-update >> text=Pine 9.9.9 is available");
	assert.equal(releases.asked, 1);
	await shot("01-update");
	// What would open in the owner's browser is noted instead.
	await app.evaluate(({ shell }: any) => {
		(globalThis as any).opened = [];
		shell.openExternal = async (url: string) => void (globalThis as any).opened.push(url);
	});
	const opened = () => app.evaluate(() => (globalThis as any).opened);
	await page.click(".side-update");
	// "Check for Updates…" in the menu asks again and says where the new app is.
	const inMenu = await app.evaluate(({ Menu }: any) => {
		const found = Menu.getApplicationMenu().items.flatMap((m: any) => m.submenu?.items ?? []).filter((i: any) => i.label === "Check for Updates…");
		found[0]?.click();
		return found.length;
	});
	assert.equal(inMenu, 1);
	await sees(".dialog-title >> text=Pine 9.9.9 is available");
	assert.equal(releases.asked, 2);
	const body = await page.textContent(".dialog-body");
	assert.ok(body.includes(`This is Pine ${mine}.`) && body.includes(link), body);
	await shot("01-update-asked");
	await page.click(".dialog-foot .btn >> text=Open the release page");
	await page.waitForSelector(".dialog", { state: "detached" });
	// The link is GitHub's page of that release, not the address the answer named.
	assert.deepEqual(await opened(), [link, link]);
	// Nobody answers: that is said, and what was found before stays.
	releases.status = 503;
	await menu("updates");
	await sees(".toast >> text=Could not ask GitHub for the latest version");
	await sees(".side-update");
	// This app is the last release: said once, and the side bar's line is gone.
	Object.assign(releases, { status: 200, tag: `v${mine}` });
	await menu("updates");
	await sees(`.toast >> text=Pine ${mine} is the latest version.`);
	await page.waitForSelector(".side-update", { state: "detached" });
	// Settings > App has the same, and the switch for the question at the start.
	await menu("settings");
	await page.click(".set-nav .side-row >> text=App");
	await sees(".item.updates .tag.good >> text=the latest version");
	releases.tag = "v9.9.9";
	await page.click(".item.updates .btn >> text=Check now");
	await sees(".item.updates .tag.warn >> text=9.9.9 is available");
	await page.click(".dialog-foot .btn >> text=Not now");
	await page.click(".item.updates .btn >> text=Release page");
	assert.deepEqual(await opened(), [link, link, link]);
	const prefs = () => JSON.parse(fs.readFileSync(path.join(home, "desktop-data", "prefs.json"), "utf8"));
	await page.click(".item:has-text('Look for a newer version at the start') .switch");
	for (let i = 0; i < 50 && prefs().updates !== false; i++) await new Promise((r) => setTimeout(r, 40));
	assert.equal(prefs().updates, false);
	await page.click(".item:has-text('Look for a newer version at the start') .switch");
	// (The settings open where they were left: back to their first page for the tests that follow.)
	await page.click(".set-nav .side-row >> text=General");
	await menu("settings");
	await sees(".side-update >> text=Pine 9.9.9 is available");
});

test("the agent's browser is shown in the panel as a picture, and what is done in it goes back through the daemon", async () => {
	// A stand-in for the door of the browser of main's own conversation: it says where it is in pine's data,
	// as the real one does, hands out one picture and notes what it is asked.
	const picture = Buffer.from(await app.evaluate(({ nativeImage }: any) => nativeImage.createFromBitmap(Buffer.alloc(400 * 300 * 4, 180), { width: 400, height: 300 }).toJPEG(70).toString("base64")), "base64");
	const word = "cd".repeat(32);
	const asked: Array<{ at: string; body: any }> = [];
	const where = { open: true, tabs: [{ title: "<img src=x onerror=window.hacked=3>Okapi shop", url: "https://shop.example/" }, { title: "Second", url: "https://shop.example/two" }], current: 0, window: false };
	const door = http.createServer(async (req, res) => {
		if (req.headers.authorization !== `Bearer ${word}`) return void res.writeHead(401).end();
		let text = "";
		for await (const chunk of req) text += chunk;
		if (req.url === "/frame") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(picture);
		if (req.method === "POST") asked.push({ at: req.url!, body: JSON.parse(text || "{}") });
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/open" ? { ...where, error: "the browser was refused that address" } : where));
	});
	await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
	const file = path.join(home, "data", "browser-view", `${encodeURIComponent("main:main")}.json`);
	write(file, JSON.stringify({ port: (door.address() as any).port, token: word, pid: 1 }));
	const ops = () => asked.filter((a) => a.at === "/input").flatMap((a) => a.body.ops as any[]);
	const waitFor = async (what: string, test: () => boolean) => {
		for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(test(), `${what}. Asked: ${JSON.stringify(asked)}`);
	};
	await page.click(".tab >> nth=0");
	const had = Boolean(await page.$(".code"));
	try {
		await menu("code-browser");
		// The page is a picture, drawn when it is whole; its address is text in the line above it.
		await sees(".browser-page canvas:not(.blank)");
		assert.equal(await page.inputValue(".browser-address"), "https://shop.example/");
		assert.deepEqual(await page.$eval(".browser-page canvas", (c: HTMLCanvasElement) => [c.width, c.height]), [400, 300]);
		// The app said that it shows the browser itself, so the agent's browser opens no window.
		await waitFor("the door was told that the app shows the browser", () => asked.some((a) => a.at === "/input" && a.body.ops.some((o: any) => o.do === "size")));
		const size = ops().find((o) => o.do === "size");
		const room = await page.$eval(".browser-page", (el: Element) => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
		assert.deepEqual([size.w, size.h], [room.w, room.h], "the page is laid out for the room the panel has");
		// A page's title is text wherever it stands: nothing of it becomes part of this window.
		assert.match(await page.textContent(".browser-tab.on"), /<img src=x onerror=window\.hacked=3>Okapi shop/);
		assert.equal(await page.evaluate(() => (window as any).hacked), undefined);
		await shot("05-browser");

		// A click in the picture is a click at that place in the page, whatever size the picture is drawn at.
		const box = await page.$eval(".browser-page canvas", (c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().left, y: c.getBoundingClientRect().top, k: c.width / c.getBoundingClientRect().width }));
		await page.mouse.click(box.x + 100, box.y + 60);
		await waitFor("the click arrived", () => ops().some((o) => o.do === "click"));
		const click = ops().find((o) => o.do === "click");
		assert.ok(Math.abs(click.x - 100 * box.k) <= 1 && Math.abs(click.y - 60 * box.k) <= 1 && click.button === "left", JSON.stringify(click));
		// Letters typed in a row go as one text, a key by its name, and what is pasted as text too.
		await page.keyboard.type("okapi");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Meta+KeyA");
		await waitFor("what was typed arrived", () => ops().some((o) => o.do === "key" && o.key === "Meta+KeyA"));
		assert.equal(ops().filter((o) => o.do === "text").map((o) => o.text).join(""), "okapi");
		assert.ok(ops().filter((o) => o.do === "text").length < 5, "letters are not sent one by one");
		assert.deepEqual(ops().filter((o) => o.do === "key").map((o) => o.key), ["Enter", "Meta+KeyA"]);
		// The wheel adds up, a tab is chosen by a click, back is a button.
		await page.mouse.wheel(0, 120);
		await page.mouse.wheel(0, 120);
		await page.click(".browser-tab >> nth=1");
		// A tab of the owner's own, and one closed.
		await page.click(".browser-tabs .btn[title='A new tab']");
		await page.click(".browser-tab >> nth=1 >> .browser-tab-close", { force: true });
		await waitFor("a new tab and a closed one arrived", () => ops().some((o) => o.do === "newtab") && ops().some((o) => o.do === "closetab" && o.index === 1));
		await page.click(".browser-bar .btn[title='Back']");
		await waitFor("wheel, tab and back arrived", () => ["wheel", "tab", "back"].every((d) => ops().some((o) => o.do === d)));
		// (How far a turn of the wheel goes is the system's to say; that it went down, and all of it, is what counts.)
		assert.ok(ops().filter((o) => o.do === "wheel").reduce((sum, o) => sum + o.dy, 0) >= 240, JSON.stringify(ops().filter((o) => o.do === "wheel")));
		assert.equal(ops().find((o) => o.do === "tab").index, 1);
		// An address typed above the picture is opened by the daemon's hand, and a no is said.
		await page.fill(".browser-address", "localhost:5173");
		await page.press(".browser-address", "Enter");
		await waitFor("the address arrived", () => asked.some((a) => a.at === "/open"));
		assert.deepEqual(asked.find((a) => a.at === "/open")!.body, { url: "localhost:5173" });
		await sees(".toast >> text=the browser was refused that address");
		// The picture came through the app's own road for pictures, and the page asked the web for nothing.
		assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => /^https?:/.test(r.name)).length), 0);

		// Without a browser the view says so and draws nothing.
		fs.rmSync(file);
		await sees(".browser .empty >> text=No page is open");
	} finally {
		// (The panel as it was, for the tests that follow.)
		await menu("code-agent");
		if (!had) await menu("code");
		fs.rmSync(file, { force: true });
		door.close();
	}
});

test("a message is answered, with the turn's work folded into a line", async () => {
	const steps = [{ tools: [{ name: "read", args: { path: "notes.md" } }], text: "Let me look at the notes first." }, { text: "The notes say **first line**.\n\n```ts\nconst a = 1;\n```\n\n<details><summary>Full file</summary>\n\nfirst line\n\n</details>\n\n[the docs](https://example.com/docs)" }];
	await page.fill(".composer textarea", mockMsg(steps, "What do the notes say? "));
	await page.keyboard.press("Enter");
	await sees(".md strong");
	assert.match(await page.textContent(".md"), /first line/);
	// The work of the turn (what it said on the way, and the tool call) is one line, which a click opens.
	await page.waitForFunction(() => /1 tool call · read/.test(document.querySelector(".work-head")?.textContent ?? ""));
	assert.equal(await page.$(".work .part .tool"), null);
	await page.click(".work-head");
	await sees(".work .part .tool");
	assert.equal(await page.textContent(".work .part .tool"), "read");
	// A link says where it leads, and is not an address the page itself would follow.
	assert.equal(await page.textContent(".md-link"), "the docs");
	assert.match(await page.textContent(".md-link + .md-target"), /example\.com\/docs/);
	assert.equal(await page.getAttribute(".md-link", "href"), null);
	// A folded part is there and closed.
	assert.equal(await page.$eval(".md details", (d: HTMLDetailsElement) => d.open), false);
	assert.ok(await page.$(".md-code .hljs-keyword"));
	await shot("02-answer");
});

test("what an answer points at on the web is not fetched by itself", async () => {
	await page.fill(".composer textarea", mockMsg([{ text: 'Look: ![a cat](https://example.com/cat.png)\n\n<img src="https://example.com/dog.png">\n\n<script>window.hacked = 1</script><a href="javascript:window.hacked=2">x</a>' }], "pictures "));
	await page.keyboard.press("Enter");
	await sees(".md-remote");
	assert.equal(await page.$$eval(".md img", (els: Element[]) => els.length), 0);
	assert.equal(await page.$$eval(".md-remote", (els: Element[]) => els.length), 2);
	assert.equal(await page.evaluate(() => (window as any).hacked), undefined);
	assert.equal(await page.$$eval(".md script, .md a[href]", (els: Element[]) => els.length), 0);
});

test("an approval is asked in a dialog and answered from it, and so is a question", async () => {
	// The owner listed bash under "approve": it asks in every mode.
	await page.fill(".composer textarea", mockMsg([{ tools: [{ name: "bash", args: { command: "echo hello" } }] }, { tools: [{ name: "question", args: { question: "Which database?", choices: ["the old one", "the new one"] } }] }, { text: "done" }], "run it "));
	await page.keyboard.press("Enter");
	await sees(".dialog-warn");
	assert.match(await page.textContent(".dialog-warn"), /Approval needed[\s\S]*echo hello/);
	await shot("03-approval");
	await page.click(".dialog-warn .btn-primary");
	await sees(".it-approval.allowed");
	// Then the agent asks something: the answers it offers, the recommended one first.
	await sees(".dialog-accent");
	assert.match(await page.textContent(".dialog-accent"), /Which database\?[\s\S]*the old one[\s\S]*the new one/);
	await shot("03-question");
	await page.keyboard.press("2");
	await sees(".it-approval.allowed >> text=Answered");
	await page.waitForSelector(".dialog", { state: "detached" });
	await sees(".md >> text=done");
});

test("a folder is opened for a conversation: changes, and a file edited and saved", async () => {
	// As the system does it when a folder is dropped on the app's icon.
	await app.evaluate(({ BrowserWindow }: any, dir: string) => BrowserWindow.getAllWindows()[0].webContents.send("pine:menu", `folder:${dir}`), folder);
	// With several agents the app asks whose folder it is; the one in front is offered first.
	await sees(".pick-title >> text=Which agent works in");
	await page.keyboard.press("Enter");
	await sees(".tab.on .name >> text=pine-desktop-folder");
	await page.click(".conv-head .btn[title*='workspace']");
	// The panel begins with the agent: who it is and what it runs on.
	await sees(".agent-view .agent-name >> text=main");
	assert.match(await page.textContent(".agent-view"), /it administers pine[\s\S]*mock\/m[\s\S]*hands work to scout/);
	// However narrow the panel is, the names of its views stay whole on one line.
	assert.ok((await page.$eval(".code .segmented button >> text=Last turn", (b: Element) => b.getBoundingClientRect().height)) <= 26);
	await page.click(".code .segmented button >> text=Changes");
	await sees(".code .frow");
	assert.match(await page.textContent(".code .frow"), /index\.ts/);
	await page.click(".code .frow");
	await sees(".diff .add");
	assert.match(await page.textContent(".diff .add"), /answer = 42/);
	await shot("04-changes");
	// The editor: change the file and save it through the daemon.
	await page.click(".code-sub .btn >> text=Edit");
	await sees(".editor .cm-content");
	await page.click(".editor .cm-content");
	await page.keyboard.press("Meta+A");
	await page.keyboard.type("export const answer = 43;\n");
	await page.keyboard.press("Meta+S");
	for (let i = 0; i < 50 && !fs.readFileSync(path.join(folder, "src", "index.ts"), "utf8").includes("43"); i++) await new Promise((r) => setTimeout(r, 100));
	assert.equal(fs.readFileSync(path.join(folder, "src", "index.ts"), "utf8"), "export const answer = 43;\n");
	await shot("05-editor");
});

test("settings: a setting is changed, an agent made, a schedule added, a provider signed in to, a skill and a source added", async () => {
	await menu("settings");
	await sees(".set-in h1 >> text=General");
	// The settings are a tab like any other, beside the conversations.
	assert.equal(await page.textContent(".tab.on .name"), "Settings");
	assert.ok((await page.$$eval(".tab", (els: Element[]) => els.length)) >= 3);
	await sees(".item .mono >> text=limits.maxDownloadMb");
	// A setting is called by a few words; its key stands beside them. What only tunes pine is not on the page.
	assert.match(await page.locator(".item", { has: page.locator(".mono", { hasText: /^limits\.maxDownloadMb$/ }) }).locator(".name").textContent(), /^Largest download/);
	assert.doesNotMatch(await page.textContent(".set-page"), /warmSlots|slotPages|catalogue|maxDelegationDepth/);
	await shot("06-settings-general");
	// A setting of pine's: checked by the daemon, written into pine.json, in force at once.
	const limit = page.locator(".item", { has: page.locator(".mono", { hasText: /^limits\.maxDownloadMb$/ }) }).locator(".ctl input");
	await limit.fill("123");
	await limit.press("Enter");
	await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /limits\.maxDownloadMb is now 123/.test(t.textContent ?? "")));
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "pine.json"), "utf8")).limits.maxDownloadMb, 123);
	// One that cannot be is refused, and the file stays as it is.
	await limit.fill("0");
	await limit.press("Enter");
	await page.waitForFunction(() => [...document.querySelectorAll(".toast.bad")].some((t) => /whole number from 1/.test(t.textContent ?? "")));
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "pine.json"), "utf8")).limits.maxDownloadMb, 123);
	// Agents: make one.
	await page.click(".set-nav .side-row >> text=Agents");
	await page.click(".btn-primary >> text=New agent");
	await page.fill(".dialog input.mono", "books");
	await page.fill(".dialog .field:nth-of-type(2) input", "Keeps the books");
	await page.click(".dialog .btn-primary >> text=Create agent");
	await sees(".set-in h1 >> text=books");
	assert.ok(fs.existsSync(path.join(home, "agents", "books", "agent.json")));
	// It is in the side bar at once, with the others.
	assert.deepEqual(await page.$$eval(".side-agent .who > :first-child", (els: Element[]) => els.map((e) => e.textContent?.trim())), ["main", "scout", "books"]);
	await shot("07-settings-agent");
	// Events: a schedule.
	await page.click(".set-nav .side-row >> text=Events");
	await page.click(".segmented button >> text=Schedules");
	await page.fill("input[placeholder='morning']", "morning");
	await page.fill(".form .field:nth-of-type(4) input", "0 7 * * *");
	await page.fill(".form textarea", "Say good morning.");
	await page.click(".btn-primary >> text=Add schedule");
	await sees(".item .name >> text=morning");
	assert.match(fs.readFileSync(path.join(home, "pine.json"), "utf8"), /"morning"/);
	await shot("08-settings-schedules");
	// Models: sign in to a provider with a key. It is typed into a field of its own and not shown.
	await page.click(".set-nav .side-row >> text=Models");
	await page.click(".set-in h2 .btn >> text=/Show all/");
	const row = page.locator(".item", { has: page.locator(".tag.mono", { hasText: /^opencode$/ }) }).first();
	await row.locator(".btn >> text=API key").click();
	await sees(".dialog input[type=password]");
	await page.fill(".dialog input[type=password]", "sk-test-not-a-real-key-0123456789");
	await page.click(".dialog .btn-primary >> text=Continue");
	await sees(".dialog .notice.plain");
	assert.doesNotMatch(await page.textContent(".dialog"), /sk-test-not-a-real-key/);
	await shot("09-settings-sign-in");
	assert.match(fs.readFileSync(path.join(home, "auth.json"), "utf8"), /opencode/);
	// A sign-in changes no agent's model, so the dialog offers the new ones for all agents.
	await page.click(".dialog .btn-primary >> text=Choose the model your agents run on");
	await sees(".pick-title >> text=Model for every agent that has none of its own");
	const offered = await page.$$eval(".pick-item .label", (els: Element[]) => els.map((e) => e.textContent ?? ""));
	assert.ok(offered.length > 0 && offered.every((m) => m.startsWith("opencode/")), JSON.stringify(offered.slice(0, 5)));
	await page.click(".pick-item >> nth=0");
	await sees(`.toast >> text=Your agents now run on ${offered[0]}`);
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "pine.json"), "utf8")).defaults.model, offered[0]);
	await sees(`.item.fallback-model .name >> text=${offered[0]}`);
	// Signed out again, that model cannot answer: the page says so for each agent it leaves without
	// one, and so does the welcome of such an agent's conversation, with the way to this page.
	const signedIn = page.locator(".item", { has: page.locator(".tag.mono", { hasText: /^opencode$/ }) }).first();
	await signedIn.locator(".btn >> text=Sign out").click();
	await signedIn.locator(".btn >> text=Sign out?").click();
	await sees(".item .notice >> text=/main cannot answer: .* needs a sign-in to opencode/");
	await page.click(".tab:has-text('pine-desktop-folder')");
	await sees(".welcome .notice >> text=/needs a sign-in to opencode/");
	await shot("09-no-model");
	await page.click(".welcome .notice .btn >> text=Models");
	await sees(".set-in h1 >> text=Models");
	// "Change" offers every model that can be used now.
	await page.click(".item.fallback-model .btn >> text=Change");
	await sees(".pick-title >> text=Model for every agent that has none of its own");
	await page.click(".pick-item >> text=mock/m");
	await sees(".toast >> text=Your agents now run on mock/m");
	await page.waitForSelector(".item .notice", { state: "detached" });
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "pine.json"), "utf8")).defaults.model, "mock/m");
	// MCP servers: a remote one is added, pine says whether it connects, and "Sign in" runs pi's own
	// sign-in for it (which for a server that wants none says so; a browser opens only where one is needed).
	const remote = await httpMcp({});
	try {
		await page.click(".set-nav .side-row >> text=MCP servers");
		await page.fill("input[placeholder='home_link']", "notes");
		await page.fill("input[placeholder='https://mcp.example.com/mcp']", remote.url);
		await page.click(".btn-primary >> text=Add server");
		const server = page.locator(".item", { has: page.locator(".name", { hasText: /^notes/ }) });
		await server.waitFor({ timeout: 15_000 });
		await page.waitForFunction(() => /connected, 1 tool/.test(document.querySelector(".set-in .group")?.textContent ?? ""), undefined, { timeout: 30_000 });
		await server.locator(".btn >> text=Sign in").click();
		await sees("pre.log >> text=/signed in to MCP server .notes./i", 40_000);
		await shot("09-settings-mcp-sign-in");
		assert.match(fs.readFileSync(path.join(home, "pine.json"), "utf8"), /"notes"/);
		// And taken out again: the file is as it was.
		await server.locator(".btn >> text=Remove").click();
		await server.locator(".btn >> text=Remove it?").click();
		await server.waitFor({ state: "detached", timeout: 15_000 });
		assert.doesNotMatch(fs.readFileSync(path.join(home, "pine.json"), "utf8"), /"notes"/);
	} finally {
		await remote.close();
	}
	// Skills: one is written down for all agents.
	await page.click(".set-nav .side-row >> text=Skills");
	await page.click(".btn-primary >> text=New skill");
	await page.fill("input[placeholder='invoices']", "invoices");
	await page.fill(".form textarea", "File an invoice. Use when a bill arrives.");
	await page.click(".editor .cm-content");
	await page.keyboard.type("1. Read the bill.");
	await page.click(".btn-primary >> text=Save skill");
	await sees(".item .name >> text=invoices");
	assert.match(fs.readFileSync(path.join(home, "skills", "invoices", "SKILL.md"), "utf8"), /Read the bill/);
	// Events: a folder to watch, set up from the type's own options.
	await page.click(".set-nav .side-row >> text=Events");
	await page.click(".btn-primary >> text=New source");
	await page.fill(".dialog input[placeholder='scans']", "scans");
	await page.selectOption(".dialog select >> nth=1", "folder");
	const watched = path.join(folder, "scans");
	fs.mkdirSync(watched, { recursive: true });
	await page.locator(".dialog .field", { has: page.locator(".field-label", { hasText: /^dir/ }) }).locator("input").fill(watched);
	await shot("09-settings-new-source");
	await page.click(".dialog .btn-primary >> text=Continue");
	await sees(".dialog >> text=will:");
	await page.click(".dialog .btn-primary >> text=Add source");
	await sees(".item .name >> text=scans");
	assert.match(fs.readFileSync(path.join(home, "pine.json"), "utf8"), /"scans"/);
	await shot("09-settings-sources");
	for (const [nav, title] of [["Models", "Models"], ["MCP servers", "MCP servers"], ["Skills", "Skills"], ["Instructions", "Instructions"], ["App", "App"]]) {
		await page.click(`.set-nav .side-row >> text=${nav}`);
		await sees(`.set-in h1 >> text=${title}`);
		await page.waitForTimeout(400);
		await shot(`09-settings-${nav.toLowerCase().replace(/\s+/g, "-")}`);
	}
	// App: the browser of the web tools is still not there, and can be fetched from here. (The
	// test fetches nothing: PINE_SKIP_DOWNLOADS. What the command printed is shown.)
	await sees(".item.browser .tag.warn >> text=not on this Mac");
	await page.click(".item.browser .btn >> text=Fetch it");
	await sees(".item.browser pre.log >> text=Not fetched: PINE_SKIP_DOWNLOADS is set.");
	// Fetched some other way (a terminal): the page says so when it is opened again.
	const { browserPlaces } = await import("../../src/browser-build.ts");
	const places = (await browserPlaces()) ?? [];
	for (const place of places) write(path.join(browsers, path.basename(place), "INSTALLATION_COMPLETE"), "");
	await page.click(".set-nav .side-row >> text=Models");
	await page.click(".set-nav .side-row >> text=App");
	await sees(".item.browser .tag.good >> text=on this Mac");
	// Environments: this computer is on and connected; a machine that is not one for ssh is refused at once, and nothing changes.
	await page.click(".set-nav .side-row >> text=Environments");
	await sees(".set-in h1 >> text=Environments");
	await sees(".item .name >> text=This Mac");
	await sees(".item[data-environment=local] .tag.good >> text=connected");
	await page.fill(".set-in input.input.mono", "-oProxyCommand=x");
	await page.click(".set-in .btn >> text=Add and connect");
	await sees(".notice.bad >> text=is not a host for ssh");
	await sees(".side-env[data-environment=local] .side-label >> text=This Mac");
	assert.deepEqual((await page.evaluate(() => (window as any).pine.state())).prefs.environments, [{ id: "local", enabled: true }]);
	await page.fill(".set-in input.input.mono", "");
	await shot("09-settings-environments");
	await menu("settings");
});

test("the side bar is the agents: one made elsewhere appears, a group folds away, and what is new says for whom", async () => {
	// An agent that another hand makes (the main agent, a `pine agent add`): asked of the daemon directly, not through the app.
	const port = /http listening on 127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(path.join(home, "data", "pine.log"), "utf8"))![1];
	const token = fs.readFileSync(path.join(home, "data", "http-token"), "utf8").trim();
	const made = await fetch(`http://127.0.0.1:${port}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "test", description: "Made outside the app", instructions: "You are test." }) });
	assert.equal(made.status, 200);
	await sees(".side-agent .who >> text=test", 20_000);
	assert.match((await page.locator(".side-agent", { has: page.locator(".who > :first-child", { hasText: /^test$/ }) }).textContent()) ?? "", /Made outside the app/);
	// Beside a conversation, the panel's Agent view says what the agent has been given: here what was set up for all agents above.
	await page.click(".tab >> nth=0");
	if (!(await page.$(".code"))) await page.click(".conv-head .btn[title*='workspace']");
	await page.click(".code .segmented button >> text=Agent");
	await sees(".agent-view .agent-line .name >> text=invoices");
	await sees(".agent-view .agent-line .name >> text=morning");
	assert.match(await page.textContent(".agent-view"), /Nothing wakes it by itself\. 1 event source could/);
	await shot("14-agent-view");
	// On an agent's line, its initial stands beside its name, not half-way down to its description.
	const line = await page.$eval(".side-agent", (el: Element) => ({ avatar: el.querySelector(".avatar")!.getBoundingClientRect(), name: el.querySelector(".who > :first-child")!.getBoundingClientRect() }));
	assert.ok(Math.abs(line.avatar.y + line.avatar.height / 2 - (line.name.y + line.name.height / 2)) <= 2, JSON.stringify(line));
	// A conversation's name begins where its agent's name begins, whatever leads its row.
	const under = await page.$$eval(".side-group", (groups: Element[]) => groups.map((g) => ({ agent: g.querySelector(".side-agent .who > :first-child")!.getBoundingClientRect().left, names: [...g.querySelectorAll(".side-conv .cut")].map((c) => c.getBoundingClientRect().left) })));
	assert.ok(under.some((g: any) => g.names.length));
	for (const g of under) for (const left of g.names) assert.equal(left, g.agent, `a conversation's name is not under its agent's: ${JSON.stringify(under)}`);
	// What the agent is for stands on that line too, after the name and on the line its letters stand on.
	const one = await page.$eval(".side-agent", (el: Element) => {
		const stands = (node: Element) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			const box = range.getBoundingClientRect();
			const pen = document.createElement("canvas").getContext("2d")!;
			pen.font = getComputedStyle(node).font;
			return { left: box.left, right: box.right, baseline: box.top + pen.measureText("x").fontBoundingBoxAscent };
		};
		return { name: stands(el.querySelector(".who > :first-child")!), what: stands(el.querySelector(".what > span")!), row: el.getBoundingClientRect().height };
	});
	assert.ok(one.what.left > one.name.right && Math.abs(one.what.baseline - one.name.baseline) <= 0.75, `an agent's name and what it is for are not on one line: ${JSON.stringify(one)}`);
	assert.equal(one.row, 30, "an agent's line is as high as a conversation's");
	// The side bar is as wide as it is dragged.
	const before = await page.$eval(".sidebar", (el: Element) => el.getBoundingClientRect().width);
	const edge = await page.$eval(".splitter.side", (el: Element) => el.getBoundingClientRect());
	await page.mouse.move(edge.x + edge.width / 2, 300);
	await page.mouse.down();
	await page.mouse.move(edge.x + edge.width / 2 + 80, 300, { steps: 4 });
	await page.mouse.up();
	assert.equal(await page.$eval(".sidebar", (el: Element) => el.getBoundingClientRect().width), before + 80);
	// Hidden, the side bar is still hidden when the page is loaded again, and shown it is as wide as it was.
	const wide = await page.$eval(".sidebar", (el: Element) => el.getBoundingClientRect().width);
	await menu("sidebar");
	await page.waitForSelector(".sidebar", { state: "detached" });
	await page.reload();
	await sees(".tab.on");
	assert.equal(await page.locator(".sidebar").count(), 0);
	await menu("sidebar");
	await sees(".sidebar");
	assert.equal(await page.$eval(".sidebar", (el: Element) => el.getBoundingClientRect().width), wide);
	await page.reload();
	await sees(".sidebar .side-agent");
	// A group folds away on a click on its agent, and comes back.
	const group = page.locator(".side-group", { has: page.locator(".who > :first-child", { hasText: /^scout$/ }) });
	assert.equal(await group.locator(".side-conv").count(), 1);
	await group.locator(".side-agent .who").click();
	assert.equal(await group.locator(".side-conv").count(), 0);
	await group.locator(".side-agent .who").click();
	assert.equal(await group.locator(".side-conv").count(), 1);
	// The plus on an agent's own line starts a conversation with that agent.
	await group.locator(".side-agent .btn[title='New conversation with scout']").click();
	await sees(".tab.on .name >> text=scout");
	assert.equal(await page.textContent(".welcome h1"), "scout");
	assert.match(await page.textContent(".welcome"), /Looks things up on the web/);
	await shot("14-agents");
	// A conversation that was only started is called by how it began, in the side bar and on its tab.
	assert.match(await page.textContent(".tab.on .name"), /new conversation/);
	await page.fill(".composer textarea", "where is the okapi invoice");
	await page.keyboard.press("Enter");
	await sees(".md >> text=ECHO[where is the okapi invoice]");
	await sees(".tab.on .name >> text=where is the okapi invoice", 15_000);
	assert.equal(await group.locator(".side-conv >> text=where is the okapi invoice").count(), 1);
	await page.click(".tab.on .close");
	// Search finds a conversation by what was said in it, and opens it with the words marked.
	await menu("palette");
	await sees(".pick-input");
	// By words that are only in an answer of the agent's, never in a name:
	await page.keyboard.type("echo[where");
	await sees(".pick-group >> text=Said in conversations");
	assert.match(await page.textContent(".pick-list"), /scout · where is the okapi invoice[\s\S]*ECHO\[where is the okapi invoice\]/);
	await shot("15-search");
	// By words that are also its name, it is listed once, and still opens at the words.
	await page.fill(".pick-input", "okapi invoice");
	await page.waitForFunction(() => document.querySelectorAll(".pick-item").length > 0 && [...document.querySelectorAll(".pick-item .label")].filter((e) => /where is the okapi invoice/.test(e.textContent ?? "")).length === 1);
	await page.click(".pick-item:has-text('scout · where is the okapi invoice')");
	await sees(".tab.on .name >> text=where is the okapi invoice");
	await sees(".find >> text=/\\d+ of \\d+/");
	assert.equal(await page.inputValue(".find input"), "okapi invoice");
	await page.keyboard.press("Escape");
	await page.click(".tab.on .close");
	// Asked from where no agent is in front (the event log), a new conversation asks with whom.
	await menu("events");
	await sees(".tab.on .name >> text=Events");
	await menu("new");
	await sees(".pick-title >> text=New conversation with");
	assert.deepEqual(await page.$$eval(".pick-item .label", (els: Element[]) => els.map((e) => e.textContent)), ["main", "scout", "books", "test"]);
	await page.keyboard.press("Escape");
	await page.click(".tab.on .close");
});

test("a right click on an agent offers to remove it, and never the main agent", async () => {
	const port = /http listening on 127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(path.join(home, "data", "pine.log"), "utf8"))![1];
	const token = fs.readFileSync(path.join(home, "data", "http-token"), "utf8").trim();
	const made = await fetch(`http://127.0.0.1:${port}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "spare", description: "Not needed for long", instructions: "You are spare." }) });
	assert.equal(made.status, 200);
	await sees(".side-agent .who >> text=spare", 20_000);
	// The menu is the system's, which the driver cannot click in: what it would show is noted, and the test says what is picked.
	await app.evaluate(({ ipcMain }: any) => {
		const g = globalThis as any;
		g.menus = [];
		ipcMain.removeHandler("pine:context-menu");
		ipcMain.handle("pine:context-menu", (_e: unknown, items: Array<{ id: string; label: string; separator?: boolean }>) => {
			g.menus.push(items.filter((i) => !i.separator).map((i) => i.label));
			return g.pick;
		});
	});
	const shown = async (agent: string, pick?: string): Promise<string[]> => {
		const before = await app.evaluate((_e: unknown, p: string | undefined) => (((globalThis as any).pick = p), (globalThis as any).menus.length), pick);
		await page.locator(".side-agent", { has: page.locator(".who > :first-child", { hasText: new RegExp(`^${agent}$`) }) }).click({ button: "right" });
		for (let i = 0; i < 100; i++) {
			const menus = await app.evaluate(() => (globalThis as any).menus);
			if (menus.length > before) return menus.at(-1);
			await new Promise((r) => setTimeout(r, 30));
		}
		throw new Error(`no menu for ${agent}`);
	};
	// Folding is a click on the line and no menu item; the main agent has nothing to remove it with.
	assert.deepEqual(await shown("main"), ["New conversation with main", "Open a folder with main…", "Agent settings…"]);
	assert.deepEqual(await shown("spare", "remove"), ["New conversation with spare", "Open a folder with spare…", "Agent settings…", "Remove spare…"]);
	// It asks first, and how: nothing is removed by the menu alone.
	await sees(".pick-title >> text=Remove the agent spare?");
	assert.ok(fs.existsSync(path.join(home, "agents", "spare", "agent.json")));
	await page.click(".pick-item:has-text('Remove it with everything it has')");
	await sees(".toast >> text=Removed the agent spare.");
	await page.waitForFunction(() => ![...document.querySelectorAll(".side-agent .who > :first-child")].some((e) => e.textContent?.trim() === "spare"));
	assert.equal(fs.existsSync(path.join(home, "agents", "spare")), false);
	// Asked for the main agent all the same (the palette, another road), the app says no and asks the daemon for nothing.
	await page.evaluate(() => (window as any).pine.call("POST", "/agents/main/erase", { agent: "main", keepFiles: false })).then((r: any) => assert.equal(r.ok, false));
	assert.ok(fs.existsSync(path.join(home, "agents", "main", "agent.json")));
});

test("the palette finds things by name, and the event log follows", async () => {
	// The pointer rests where the list will open: the first line is still the one that enter takes.
	await page.mouse.move(640, 320);
	await menu("palette");
	await sees(".pick-input");
	await page.keyboard.type("event log");
	await shot("10-palette");
	await page.keyboard.press("Enter");
	await sees(".events-list .ev");
	assert.ok((await page.$$eval(".events-list .ev", (els: Element[]) => els.length)) > 3);
	await shot("11-events");
});

test("a sub-agent's work opens in a tab of its own", async () => {
	await page.click(".tab >> nth=0");
	mock.state.scripts.child = [{ text: "hi from the child" }];
	await page.fill(".composer textarea", mockMsg([{ tools: [{ name: "subagent", args: { tasks: ["@@REF:child@@ say hi"] } }] }, { text: "the sub-agent answered" }], "ask a helper "));
	await page.keyboard.press("Enter");
	await sees(".md >> text=the sub-agent answered");
	await page.click(".work-head >> nth=-1");
	await sees(".work .part .open-link");
	await page.click(".work .part .open-link >> nth=0");
	await sees(".tab.on .name >> text=#");
	await sees(".md >> text=hi from the child");
	assert.match(await page.textContent(".column"), /sub-agent of main/);
	await shot("12-task");
	await page.click(".tab.on .close");
});

test("the last message is taken back, and its text is in the input again", async () => {
	await page.click(".tab >> nth=0");
	const before = await page.$$eval(".it-user", (els: Element[]) => els.length);
	await menu("undo");
	await sees(".it-note.accent >> text=Taken back");
	assert.equal(await page.$$eval(".it-user", (els: Element[]) => els.length), before - 1);
	assert.match(await page.inputValue(".composer textarea"), /^ask a helper /);
	await page.fill(".composer textarea", "");
});

test("dictating puts what is heard into the input and sends nothing", async () => {
	const sent = await page.$$eval(".it-user", (els: Element[]) => els.length);
	await page.fill(".composer textarea", "Typed first:");
	await menu("voice");
	await sees(".banner >> text=listening");
	await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "Typed first: about the scans", undefined, { timeout: 8000 }).catch(async () => {
		throw new Error(`what was heard is not in the input, which holds: ${JSON.stringify(await page.inputValue(".composer textarea"))}; ${await page.evaluate(() => [...document.querySelectorAll(".banner, .toast")].map((e) => e.textContent).join(" | "))}`);
	});
	// Enter says "that was all": the rest arrives, and the message is still only text in the input.
	await page.focus(".composer textarea");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === "Typed first: about the scans please");
	await page.waitForSelector(".banner >> text=listening", { state: "detached" });
	assert.equal(await page.$$eval(".it-user", (els: Element[]) => els.length), sent);
	await page.fill(".composer textarea", "");
});

test("find marks what is looked for", async () => {
	await menu("find");
	await sees(".find input");
	await page.keyboard.type("first line");
	await sees(".find >> text=/\\d+ of \\d+/");
	assert.ok(await page.evaluate(() => ((CSS as any).highlights.get("pine-find")?.size ?? 0) > 0));
	await shot("13-find");
	await page.keyboard.press("Escape");
	await page.waitForSelector(".find", { state: "detached" });
});

test("another machine is added: its agents stand beside these, and a conversation of each is open at once", async () => {
	await menu("settings:environments");
	await sees(".set-in h1 >> text=Environments");
	await page.fill(".set-in input.input.mono", "you@elsewhere");
	await page.click(".set-in .btn >> text=Add and connect");
	// It connects at once, and its agents appear under its name, without a restart.
	const there = ".side-env[data-environment=ssh-you-elsewhere]";
	await sees(`${there} .side-agent .who >> text=helper`, 60_000);
	assert.deepEqual(await page.$$eval(".side-env .side-label .cut", (els: Element[]) => els.map((e) => e.textContent)), ["This Mac", "elsewhere"]);
	assert.deepEqual(await page.$$eval(`${there} .side-agent .who > :first-child`, (els: Element[]) => els.map((e) => e.textContent?.trim())), ["main", "helper"]);
	assert.deepEqual(await page.$$eval(".side-env[data-environment=local] .side-agent .who > :first-child", (els: Element[]) => els.map((e) => e.textContent?.trim())), ["main", "scout", "books", "test"]);
	await sees(".item[data-environment=ssh-you-elsewhere] .tag.good >> text=connected");
	await shot("16-environments");
	// Both have a "main": the other machine's opens in a tab of its own, which says where it is.
	await page.locator(`${there} .side-group`, { has: page.locator(".who > :first-child", { hasText: /^main$/ }) }).locator(".side-conv").first().click();
	await sees(".tab.on .where >> text=elsewhere");
	assert.equal(await page.textContent(".welcome h1"), "main");
	assert.match(await page.textContent(".welcome"), /main agent of the other machine/);
	await page.fill(".composer textarea", "hello from this side");
	await page.keyboard.press("Enter");
	await sees(".md >> text=ECHO[hello from this side]");
	// It went to the other machine's pine, and not to this one's.
	const daemon = (dir: string) => ({ port: /http listening on 127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(path.join(dir, "data", "pine.log"), "utf8"))![1], token: fs.readFileSync(path.join(dir, "data", "http-token"), "utf8").trim() });
	const said = async (dir: string) => {
		const d = daemon(dir);
		const tasks = (await (await fetch(`http://127.0.0.1:${d.port}/tasks?agent=main&limit=100`, { headers: { authorization: `Bearer ${d.token}` } })).json()) as Array<{ prompt: string }>;
		return tasks.some((t) => t.prompt === "hello from this side");
	};
	assert.equal(await said(far), true);
	assert.equal(await said(home), false);
	await shot("17-two-environments");
	// This computer's main is a tab beside it, and still its own conversation.
	await page.locator(".tab", { hasNot: page.locator(".where") }).filter({ has: page.locator(".name b", { hasText: /^main$/ }) }).first().click();
	await sees(".tab.on .name b >> text=main");
	assert.equal(await page.locator(".tab.on .where").count(), 0);
	assert.doesNotMatch(await page.textContent(".column"), /hello from this side/);
	// The settings pages are of the environment chosen at their top.
	await menu("settings:agents");
	await sees(".set-env select");
	await page.selectOption(".set-env select", "ssh-you-elsewhere");
	await sees(".set-in .item .name >> text=helper");
	assert.equal(await page.locator(".set-in .item .name >> text=scout").count(), 0);
	// Turned off: its agents and its tabs go, this computer's stay; it is kept in the list, off.
	const port = daemon(far).port;
	await page.click(".set-nav .side-row >> text=Environments");
	await page.click(".item[data-environment=ssh-you-elsewhere] .switch");
	await page.waitForSelector(there, { state: "detached" });
	await sees(".side-env[data-environment=local] .side-agent .who >> text=scout");
	assert.equal(await page.locator(".tab .where").count(), 0);
	assert.deepEqual((await page.evaluate(() => (window as any).pine.state())).prefs.environments, [{ id: "local", enabled: true }, { id: "ssh-you-elsewhere", host: "you@elsewhere", enabled: false }]);
	// The pine this app started there for it is stopped with it.
	let up = true;
	for (let i = 0; i < 100 && up; i++) {
		up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }).then((r) => r.ok, () => false);
		if (up) await new Promise((r) => setTimeout(r, 150));
	}
	assert.equal(up, false);
	// The last one that is on stays on.
	await page.click(".item[data-environment=local] .switch");
	await page.waitForFunction(() => [...document.querySelectorAll(".toast.bad")].some((t) => /One environment stays on/.test(t.textContent ?? "")));
	await menu("settings");
});

test("quitting stops the daemon it started", async () => {
	const log = path.join(home, "data", "pine.log");
	assert.ok(fs.existsSync(log));
	await app.close();
	app = undefined;
	// The daemon wrote its last line and is gone: its control port no longer answers.
	const said = fs.readFileSync(log, "utf8");
	assert.match(said, /pine is up/);
	const port = /http listening on 127\.0\.0\.1:(\d+)/.exec(said)?.[1];
	assert.ok(port);
	let up = true;
	for (let i = 0; i < 100 && up; i++) {
		up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }).then((r) => r.ok, () => false);
		if (up) await new Promise((r) => setTimeout(r, 150));
	}
	assert.equal(up, false);
});
