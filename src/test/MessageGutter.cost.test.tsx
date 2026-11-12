import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageGutter } from "@/components/MessageViewer/components/MessageGutter";
import type { ClaudeAssistantMessage } from "@/types";

// The shape of a real VS Code Copilot turn: Auto resolved to Haiku 4.5, with
// the last model call's usage (24,262 in / 370 out → $0.026112 at list price).
const copilotTurn = (
  overrides: Partial<ClaudeAssistantMessage> = {},
): ClaudeAssistantMessage => ({
  uuid: "resp-1",
  sessionId: "sess-1",
  timestamp: "2026-11-12T00:00:00.000Z",
  type: "assistant",
  role: "assistant",
  provider: "copilot",
  model: "copilot/claude-haiku-4.5",
  usage: { input_tokens: 24_262, output_tokens: 370 },
  content: [{ type: "text", text: "a" }],
  ...overrides,
});

describe("MessageGutter cost label", () => {
  it("shows a Copilot turn without tool calls as an estimate", () => {
    render(<MessageGutter message={copilotTurn()} />);
    expect(screen.getByText("~$0.0")).toBeInTheDocument();
  });

  it("shows a Copilot turn with a tool call as a lower bound", () => {
    render(
      <MessageGutter
        message={copilotTurn({
          toolUse: { type: "tool_use", id: "t1", name: "read_file", input: {} },
        })}
      />,
    );
    expect(screen.getByText("≥$0.0")).toBeInTheDocument();
  });

  it("detects tool calls from the content blocks as well", () => {
    render(
      <MessageGutter
        message={copilotTurn({
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", id: "t1", name: "read_file", input: {} },
          ],
        })}
      />,
    );
    expect(screen.getByText("≥$0.0")).toBeInTheDocument();
  });

  it("explains a lower bound in the details card", async () => {
    render(
      <MessageGutter
        message={copilotTurn({
          toolUse: { type: "tool_use", id: "t1", name: "read_file", input: {} },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /token usage/i }));
    expect(await screen.findByText(/≥~\$0\.026/)).toBeInTheDocument();
    expect(screen.getByText(/records only the last call's tokens/)).toBeInTheDocument();
    expect(screen.getByText(/with no cache discount/)).toBeInTheDocument();
  });

  it("omits the lower-bound note for a single-call turn", async () => {
    render(<MessageGutter message={copilotTurn()} />);
    fireEvent.click(screen.getByRole("button", { name: /token usage/i }));
    expect(await screen.findByText(/with no cache discount/)).toBeInTheDocument();
    expect(screen.queryByText(/records only the last call's tokens/)).toBeNull();
  });

  it("keeps the plain label for Claude turns, even with tool calls", () => {
    render(
      <MessageGutter
        message={copilotTurn({
          provider: "claude",
          model: "claude-haiku-4-5",
          toolUse: { type: "tool_use", id: "t1", name: "Read", input: {} },
        })}
      />,
    );
    expect(screen.getByText("$0.0")).toBeInTheDocument();
  });
});
