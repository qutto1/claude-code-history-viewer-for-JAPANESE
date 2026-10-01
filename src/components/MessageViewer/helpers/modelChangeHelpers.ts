/**
 * Which turns switched model or reasoning effort.
 *
 * The gutter's model line exists so the reader can scan a session and see
 * exactly where the model changed. That only reads as a signal if the *un*changed
 * runs recede, so the viewer needs to know, per message, whether this turn's
 * model differs from the one before it. A turn can also switch reasoning
 * effort (e.g. "medium" → "high") while keeping the same model — Claude
 * Code's own records and Codex's `turn_context.effort` both carry this — and
 * that is just as real a change in how the turn was produced, so it lights up
 * the same signal rather than needing a second one.
 *
 * "The one before it" cannot mean the literally preceding row: only assistant
 * turns carry a model, and a user turn almost always sits between two of them.
 * Comparing against the immediate neighbour would mark every assistant turn as
 * changed and nothing would ever recede. So the chain skips every message
 * without a model and compares against the nearest preceding message that has
 * one.
 *
 * The comparison is on the RAW model id, never on the shortened label:
 * `claude-sonnet-4-20250514` and `claude-sonnet-4` both render as "sonnet-4",
 * and collapsing them would hide a real switch.
 */

import type { ClaudeMessage } from "../../../types";

/** The model id a message was answered by, if it carries one at all. */
const getMessageModel = (message: ClaudeMessage): string | undefined =>
  message.type === "assistant" ? message.model : undefined;

/** The reasoning effort a message was answered at, if it carries one. */
const getMessageEffort = (message: ClaudeMessage): string | undefined =>
  message.type === "assistant" ? message.effort : undefined;

/**
 * UUIDs of the messages whose model or effort differs from the previous
 * modelled message.
 *
 * The first modelled message in the array counts as a change: there is nothing
 * before it to match. That also covers the pagination boundary — when the store
 * holds only a window of the session, the earliest loaded turn is emphasised
 * rather than being silently called "same as" a message that was never loaded.
 *
 * Messages with no model are absent from the result. They render no model line,
 * and they do not break a run: a user turn between two sonnet answers leaves
 * the second one still counting as unchanged. A message's missing `effort` is
 * compared as-is (`undefined !== "high"` still counts as a change) so a
 * provider that only sometimes reports effort still surfaces a real switch.
 */
export function collectModelChangeUuids(messages: ClaudeMessage[]): Set<string> {
  const changed = new Set<string>();
  let previousModel: string | undefined;
  let previousEffort: string | undefined;

  for (const message of messages) {
    const model = getMessageModel(message);
    if (!model) continue;
    const effort = getMessageEffort(message);
    if (model !== previousModel || effort !== previousEffort) {
      changed.add(message.uuid);
    }
    previousModel = model;
    previousEffort = effort;
  }

  return changed;
}
