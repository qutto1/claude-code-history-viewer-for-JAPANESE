export const getShortModelName = (model: string): string => {
  if (!model) return "";

  // Handle different Claude model name formats:
  // claude-opus-4-5-20251101 → opus-4.5
  // claude-sonnet-4-20250514 → sonnet-4
  // claude-3-5-sonnet-20241022 → sonnet-3.5

  // Format: claude-<variant>-<major>-<minor?>-<date>
  const newFormat = model.match(/^claude-(\w+)-(\d+)(?:-(\d+))?-\d{8}/);
  if (newFormat) {
    const [, variant, major, minor] = newFormat;
    return minor ? `${variant}-${major}.${minor}` : `${variant}-${major}`;
  }

  // Format: claude-<major>-<minor>-<variant>-<date> (older format)
  const oldFormat = model.match(/^claude-(\d+)-(\d+)-(\w+)-\d{8}/);
  if (oldFormat) {
    const [, major, minor, variant] = oldFormat;
    return `${variant}-${major}.${minor}`;
  }

  // Non-Claude models (OpenAI, Google, etc.) - already human-readable
  // e.g., "gpt-4.1", "o4-mini", "codex-mini", "gemini-2.5-pro"
  if (!model.startsWith("claude")) {
    return model;
  }

  // Format: claude-<variant>-<major>-<minor?> with no date at all. Recent
  // Claude Code releases stopped stamping the YYYYMMDD suffix, so most ids in
  // a modern log fall here: claude-opus-5, claude-sonnet-4-6, claude-fable-5.
  const datelessFormat = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (datelessFormat) {
    const [, variant, major, minor] = datelessFormat;
    return minor ? `${variant}-${major}.${minor}` : `${variant}-${major}`;
  }

  // Fallback: drop the date suffix and the vendor prefix. Callers want the
  // variant on its own — "claude-" is the same on every row and only costs
  // width in dense UI.
  return model.replace(/-\d{8}$/, "").replace(/^claude-/, "");
};
