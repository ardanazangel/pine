import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuestionDialog as Dialog } from "./QuestionDialog.tsx";

// No docs page: it would open every story's dialog at once, one over the other.
const meta = { component: Dialog, tags: ["!autodocs"], parameters: { layout: "fullscreen" } } satisfies Meta<typeof Dialog>;
export default meta;

type Story = StoryObj<typeof meta>;
const question: Story["args"] = { env: "local", req: { id: "q1", agent: "main", task: 12, tool: "question", summary: "Which database?", why: "", expires: 0, choices: ["the old one", "the new one"] } };

export const QuestionDialog: Story = { args: question };
