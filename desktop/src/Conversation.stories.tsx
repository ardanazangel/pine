import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Approval } from "./api.ts";
import { Row } from "./Conversation.tsx";
import { type Item, Tab } from "./model.ts";

// A conversation as the app draws it: each item is a Row, the way the transcript lists them.
// The items are made by hand, as the model would make them from what the daemon says.
type Made = Item extends infer I ? (I extends Item ? Omit<I, "id" | "v"> : never) : never;

function Items({ items }: { items: Made[] }) {
	const tab = new Tab("chat", "local", "main", "main");
	for (const item of items) tab.add(item as never);
	return (
		<div className="flex w-160 flex-col gap-3.5">
			{tab.items.map((item) => <Row key={item.id} item={item} v={item.v} tab={tab} />)}
		</div>
	);
}

const now = Date.now();
const conversation: Made[] = [
	{ t: "user", text: "What do the notes say?", files: ["notes.md"], task: 1 },
	{
		t: "work",
		done: true,
		open: true,
		startedAt: now,
		ms: 4200,
		parts: [
			{ p: "thought", text: "The owner wants the notes. I read the file first.", done: true, ms: 1200, startedAt: now },
			{ p: "tool", key: "1", tool: "read", subject: "notes.md", status: "ok", ms: 40, depth: 0 },
			{ p: "words", text: "Let me look at the notes first." },
			{ p: "tool", key: "2", tool: "bash", subject: "grep -n TODO notes.md", status: "fail", ms: 90, depth: 0, preview: "grep: notes.md: No such file or directory" },
			{ p: "child", task: 12, agent: "scout", kind: "subagent", label: "look it up", status: "done", depth: 1 },
		],
	},
	{ t: "steps", task: 1, items: [{ text: "Read the notes", status: "done" }, { text: "Sum them up", status: "in_progress" }, { text: "Say what is missing", status: "pending" }] },
	{ t: "answer", task: 1, agent: "main", live: false, text: "The notes say **first line**.\n\n```ts\nconst a = 1;\n```\n\n[the docs](https://example.com/docs)" },
];

const approval: Approval = { id: "a1", agent: "main", task: 1, tool: "bash", summary: "echo hello", why: "You listed bash under approve: it asks in every mode.", expires: 0, remember: "bash" };
const question: Approval = { id: "q1", agent: "main", task: 1, tool: "question", summary: "Which database?", why: "", expires: 0, choices: ["the old one", "the new one"] };
const asks: Made[] = [
	{ t: "approval", req: approval, state: "open" },
	{ t: "approval", req: question, state: "open" },
	{ t: "approval", req: { ...approval, id: "a2" }, state: "allowed", by: "you" },
	{ t: "approval", req: { ...question, id: "q2" }, state: "allowed", by: "you" },
	{ t: "approval", req: { ...approval, id: "a3", summary: "rm -rf build" }, state: "denied", by: "you" },
	{ t: "approval", req: { ...approval, id: "a4" }, state: "gone" },
];

const meta = { component: Items, parameters: { layout: "padded" } } satisfies Meta<typeof Items>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = { args: { items: conversation } };

/** What the agent asks: an approval and a question, open, then as they were answered. */
export const Ask: Story = { args: { items: asks } };

/** A turn at work: its last lines under the head, the call that runs and the thought that goes on. */
const working: Made[] = [
	{ t: "user", text: "Clean up the build folder." },
	{
		t: "work",
		done: false,
		open: false,
		startedAt: now,
		parts: [
			{ p: "tool", key: "1", tool: "ls", subject: "build", status: "ok", ms: 12, depth: 0 },
			{ p: "thought", text: "The folder holds old bundles. I remove them and keep the config.", done: false, startedAt: now },
			{ p: "tool", key: "2", tool: "bash", subject: "rm -rf build/assets", status: "run", depth: 0 },
			{ p: "child", task: 14, agent: "scout", kind: "delegate", label: "check the links", status: "run", depth: 1 },
		],
	},
];
export const Working: Story = { args: { items: working } };

/** What pine says between turns: notes in each tone, an event, the goal, a divider. */
const notes: Made[] = [
	{ t: "divider", text: "yesterday" },
	{ t: "note", tone: "muted", text: "The model changed to mock/m." },
	{ t: "note", tone: "warn", text: "The answer was cut: the model ran out of room." },
	{ t: "note", tone: "bad", text: "The model server did not answer.", action: { label: "Settings", run: () => {} } },
	{ t: "note", tone: "accent", text: "↶ Taken back: your last message", lines: [{ text: "2 files restored" }, { text: "notes.md was changed since", tone: "warn" }] },
	{ t: "event", label: "folder · changed", body: "~/notes/today.md was written" },
	{ t: "goal", goal: { agent: "main", session: "main", objective: "Every link in the notes works", status: "met", note: "met after 2 rounds", round: 2, until: 5, reason: "All twelve links answer." } },
];
export const Notes: Story = { args: { items: notes } };

// A picture of 480 by 320, drawn here: the page loads nothing from the web.
const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#5de4c7"/><circle cx="240" cy="160" r="90" fill="#1b1e28"/></svg>')}`;

/** A picture in the conversation: a click opens it larger over the page. */
const picture: Made[] = [{ t: "media", kind: "image", name: "okapi.svg", url: PICTURE }];
export const Picture: Story = { args: { items: picture } };

/** The same picture, clicked: larger over the page. No docs page: it would open over the other stories. */
export const PictureLarger: Story = {
	args: { items: picture },
	tags: ["!autodocs"],
	play: async ({ canvas, userEvent }) => await userEvent.click(canvas.getByRole("button", { name: "okapi.svg" })),
};
