import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalDialog as Dialog } from "./ApprovalDialog.tsx";

// No docs page: it would open every story's dialog at once, one over the other.
const meta = { component: Dialog, tags: ["!autodocs"], parameters: { layout: "fullscreen" } } satisfies Meta<typeof Dialog>;
export default meta;

type Story = StoryObj<typeof meta>;
const approval: Story["args"] = { env: "local", req: { id: "a1", agent: "main", task: 12, tool: "bash", summary: "echo hello", why: "bash is on your approve list.", expires: 0, remember: "bash" } };

export const ApprovalDialog: Story = { args: approval };

/** Something only the owner has, typed here and sent to the daemon alone. */
export const ApprovalDialogWithSecret: Story = {
	args: { env: "local", req: { id: "a2", agent: "main", task: 13, tool: "add_source", summary: "telegram source: chat with you", why: "it needs a token.", expires: 0, inputs: [{ name: "TELEGRAM_TOKEN", label: "TELEGRAM_TOKEN: the bot's token from @BotFather" }] } },
};
