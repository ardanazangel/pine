import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "./Composer.tsx";
import { Env, store, Tab } from "./model.ts";

// This computer's pine, as the app knows it before it answers: the tabs here are its own.
const here = store.env("local") ?? new Env({ id: "local", label: "This Mac", enabled: true, state: { status: "starting" }, connected: false });
if (!store.envs.includes(here)) store.envs.push(here);

// The message box as a conversation shows it, without a daemon: what the agent runs on reads
// "model" and "auto" here, as for an agent the app does not know yet.
function Box({ draft = "", files = false, outside = false, paused = false, narrow = false }: { draft?: string; files?: boolean; outside?: boolean; paused?: boolean; narrow?: boolean }) {
	const tab = new Tab("chat", "local", "main", "main");
	tab.draft = draft;
	if (paused) tab.goal = { agent: "main", session: "main", objective: "File every invoice of March", status: "paused", round: 3, until: 10, note: "paused by you after round 3" };
	if (files) tab.attachments.push({ name: "invoice-2026-03.pdf", size: 182_400, data: "" }, { name: "notes.md", size: 2_100, data: "" });
	if (outside) here.taints.set("main:main", "a web page");
	else here.taints.delete("main:main");
	return (
		<div className={narrow ? "relative w-80" : "relative w-160"}>
			<Composer tab={tab} />
		</div>
	);
}

const meta = { component: Box, parameters: { layout: "padded" } } satisfies Meta<typeof Box>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: {} };

/** A message being written, with files attached, in a conversation that has read outside content. */
export const Written: Story = { args: { draft: "Sum up the invoice and say what is missing from @notes.md", files: true, outside: true } };

/** A goal that waits: its banner (an Alert) above the input, with Resume and Clear. */
export const GoalPaused: Story = { args: { paused: true } };

/** A narrow conversation (the side panel open in a small window): the buttons keep to one line inside the box, the send button
 * last; the names of the model and the folder are cut, and what has no room for its words stands as its sign alone. */
export const Narrow: Story = { args: { draft: "Sum up the invoice", files: true, outside: true, narrow: true } };
