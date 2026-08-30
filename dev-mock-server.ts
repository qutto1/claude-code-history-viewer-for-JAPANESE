/**
 * Vite dev server mock middleware for browser testing.
 *
 * Provides mock API responses so the app can render in a browser
 * without Tauri runtime. Used for UI development and testing only.
 *
 * Usage: set VITE_MOCK=1 environment variable, then `pnpm dev`
 */

import type { Plugin } from "vite";

function makeUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function makeMessage(
  type: "user" | "assistant",
  content: string,
  timestamp: string,
  parentUuid?: string,
) {
  const uuid = makeUuid();
  return {
    uuid,
    parentUuid: parentUuid ?? null,
    sessionId: "mock-session-001",
    timestamp,
    type,
    isSidechain: false,
    message: {
      role: type === "user" ? "user" : "assistant",
      content:
        type === "assistant"
          ? [{ type: "text", text: content }]
          : content,
      ...(type === "assistant"
        ? {
            id: `msg_${uuid.slice(0, 8)}`,
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 1200,
              output_tokens: 350,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }
        : {}),
    },
    content:
      type === "assistant"
        ? [{ type: "text", text: content }]
        : content,
    model: type === "assistant" ? "claude-sonnet-4-20250514" : undefined,
    usage:
      type === "assistant"
        ? {
            input_tokens: 1200,
            output_tokens: 350,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }
        : undefined,
  };
}

/** Generate mock messages spanning 3 days */
function generateMockMessages() {
  const messages = [];
  let prevUuid: string | undefined;

  // Day 1: March 7
  const day1Pairs = [
    ["프로젝트 구조를 분석해줘", "프로젝트 구조를 분석하겠습니다. src/ 디렉토리 아래에 components, hooks, store, utils가 있습니다."],
    ["컴포넌트 목록을 보여줘", "주요 컴포넌트는 MessageViewer, ProjectTree, SettingsManager 등이 있습니다."],
    ["테스트는 어떻게 되어있어?", "현재 Vitest를 사용하고 있으며, src/test/ 디렉토리에 테스트 파일이 있습니다."],
  ];

  for (let i = 0; i < day1Pairs.length; i++) {
    const [userMsg, assistantMsg] = day1Pairs[i]!;
    const hour = 10 + i;
    const userM = makeMessage("user", userMsg!, `2026-03-07T${String(hour).padStart(2, "0")}:${String(i * 15).padStart(2, "0")}:00.000Z`, prevUuid);
    messages.push(userM);
    const assistantM = makeMessage("assistant", assistantMsg!, `2026-03-07T${String(hour).padStart(2, "0")}:${String(i * 15 + 2).padStart(2, "0")}:00.000Z`, userM.uuid);
    messages.push(assistantM);
    prevUuid = assistantM.uuid;
  }

  // Day 2: March 8
  const day2Pairs = [
    ["i18n 설정 방법을 알려줘", "react-i18next를 사용하고 있습니다. src/i18n/locales/ 아래에 5개 언어가 있습니다."],
    ["새로운 키를 추가하려면?", "각 locale 폴더의 해당 namespace JSON 파일에 키를 추가하고, generate:i18n-types를 실행하세요."],
    ["빌드 명령어가 뭐야?", "just dev로 개발 모드, just tauri-build로 프로덕션 빌드를 할 수 있습니다."],
    ["ESLint 설정은?", "TypeScript ESLint를 사용하고 있으며, no-explicit-any가 활성화되어 있습니다."],
  ];

  for (let i = 0; i < day2Pairs.length; i++) {
    const [userMsg, assistantMsg] = day2Pairs[i]!;
    const hour = 9 + i * 2;
    const userM = makeMessage("user", userMsg!, `2026-03-08T${String(hour).padStart(2, "0")}:30:00.000Z`, prevUuid);
    messages.push(userM);
    const assistantM = makeMessage("assistant", assistantMsg!, `2026-03-08T${String(hour).padStart(2, "0")}:32:00.000Z`, userM.uuid);
    messages.push(assistantM);
    prevUuid = assistantM.uuid;
  }

  // Day 3: March 10 (today)
  const day3Pairs = [
    ["오늘 할 일 정리해줘", "Issue #170 날짜 표시 개선 작업을 진행합니다. 날짜 구분선과 floating overlay를 추가합니다."],
    ["구현 시작해줘", "Phase 1부터 시작하겠습니다. time.ts에 formatDateDivider 함수를 추가합니다."],
    ["잘 동작하는지 확인해봐", "TypeScript 빌드, ESLint, i18n 검증 모두 통과했습니다."],
  ];

  for (let i = 0; i < day3Pairs.length; i++) {
    const [userMsg, assistantMsg] = day3Pairs[i]!;
    const hour = 14 + i;
    const userM = makeMessage("user", userMsg!, `2026-03-10T${String(hour).padStart(2, "0")}:00:00.000Z`, prevUuid);
    messages.push(userM);
    const assistantM = makeMessage("assistant", assistantMsg!, `2026-03-10T${String(hour).padStart(2, "0")}:02:00.000Z`, userM.uuid);
    messages.push(assistantM);
    prevUuid = assistantM.uuid;
  }

  return messages;
}

const MOCK_MESSAGES = generateMockMessages();

const MOCK_SESSION = {
  session_id: "mock-session-001",
  actual_session_id: "mock-session-001",
  project_name: "mock-project",
  file_path: "/mock/.claude/projects/-Users-mock-projects-mock-project/mock-session.jsonl",
  message_count: MOCK_MESSAGES.length,
  first_message_time: "2026-03-07T10:00:00.000Z",
  last_message_time: "2026-03-10T16:02:00.000Z",
  last_modified: "2026-03-10T16:02:00.000Z",
  has_tool_use: false,
  has_errors: false,
  provider: "claude",
};

const MOCK_PROJECT = {
  name: "mock-project",
  path: "/mock/.claude/projects/-Users-mock-projects-mock-project",
  actual_path: "/Users/mock/projects/mock-project",
  session_count: 1,
  message_count: MOCK_MESSAGES.length,
  last_modified: "2026-03-10T16:02:00.000Z",
  provider: "claude",
};

// A second project so the tree can be exercised with more than one row
// expanded at a time.
const MOCK_PROJECT_B = {
  name: "mock-project-b",
  path: "/mock/.claude/projects/-Users-mock-projects-mock-project-b",
  actual_path: "/Users/mock/projects/mock-project-b",
  session_count: 1,
  message_count: 2,
  last_modified: "2026-03-09T12:00:00.000Z",
  provider: "claude",
};

const MOCK_SESSION_B = {
  ...MOCK_SESSION,
  session_id: "mock-session-002",
  actual_session_id: "mock-session-002",
  project_name: "mock-project-b",
  file_path: "/mock/.claude/projects/-Users-mock-projects-mock-project-b/mock-session-b.jsonl",
  message_count: 2,
  last_modified: "2026-03-09T12:00:00.000Z",
};

const COMPACT_SUMMARY_TEXT = [
  "This session is being continued from a previous conversation that ran out of context.",
  "",
  "Summary:",
  "1. Primary Request and Intent:",
  "   Tighten the viewer's spacing and make the compacted context readable.",
  "2. Key Technical Concepts:",
  "   - Virtualized message list with measured row heights",
  "   - Per-project session pages in the store",
  "3. Files and Code Sections:",
  "   - `ClaudeMessageNode.tsx` — one frame-padding constant for every branch",
  "   - `searchIndex.ts` — the index now honours the visibility toggles",
].join("\n");

// Extra rows used to eyeball the renderers: a compact boundary + its summary,
// plus an assistant turn carrying thinking and tool blocks.
const EXTRA_MESSAGES = [
  {
    uuid: "mock-compact-boundary",
    parentUuid: null,
    sessionId: "mock-session-001",
    timestamp: "2026-03-10T17:00:00.000Z",
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: 464879,
      postTokens: 20692,
      durationMs: 113263,
    },
  },
  {
    uuid: "mock-compact-summary",
    parentUuid: "mock-compact-boundary",
    sessionId: "mock-session-001",
    timestamp: "2026-03-10T17:00:01.000Z",
    type: "user",
    isCompactSummary: true,
    content: COMPACT_SUMMARY_TEXT,
    message: { role: "user", content: COMPACT_SUMMARY_TEXT },
  },
  {
    uuid: "mock-thinking-and-tools",
    parentUuid: "mock-compact-summary",
    sessionId: "mock-session-001",
    timestamp: "2026-03-10T17:01:00.000Z",
    type: "assistant",
    content: [
      { type: "text", text: "Checking the spacing tokens now." },
      { type: "thinking", thinking: "The frame padding is the searchable-thinking marker." },
      { type: "tool_use", id: "toolu_mock", name: "Grep", input: { pattern: "searchable-tool marker" } },
    ],
  },
];

// Mutable so settings written through the UI survive within a dev session.
const mockUserMetadata: {
  version: number;
  sessions: Record<string, unknown>;
  projects: Record<string, unknown>;
  settings: Record<string, unknown>;
} = { version: 1, sessions: {}, projects: {}, settings: {} };

/** Pick the session list matching the requested project path. */
function sessionsFor(args: Record<string, unknown>) {
  const path = typeof args.projectPath === "string" ? args.projectPath : "";
  return path === MOCK_PROJECT_B.path ? [MOCK_SESSION_B] : [MOCK_SESSION];
}

/** API route handlers */
const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_claude_folder_path: () => "/mock/.claude",
  validate_claude_folder: () => true,
  scan_projects: () => [MOCK_PROJECT, MOCK_PROJECT_B],
  scan_all_projects: () => [MOCK_PROJECT, MOCK_PROJECT_B],
  detect_providers: () => [{ id: "claude", name: "Claude Code", is_available: true, session_count: 1 }],
  load_project_sessions: (args) => sessionsFor(args),
  load_provider_sessions: (args) => sessionsFor(args),
  load_provider_sessions_page: (args) => {
    const sessions = sessionsFor(args);
    return { sessions, total: sessions.length, nextOffset: sessions.length, hasMore: false };
  },
  load_session_messages: () => [...MOCK_MESSAGES, ...EXTRA_MESSAGES],
  load_provider_messages: () => [...MOCK_MESSAGES, ...EXTRA_MESSAGES],
  load_provider_messages_paginated: () => {
    const messages = [...MOCK_MESSAGES, ...EXTRA_MESSAGES];
    return {
      messages,
      total_count: messages.length,
      has_more: false,
      next_offset: messages.length,
    };
  },
  search_messages: () => [],
  get_session_token_stats: () => ({
    total_input_tokens: 12000,
    total_output_tokens: 3500,
    total_cache_creation: 0,
    total_cache_read: 0,
    message_count: MOCK_MESSAGES.length,
    model_breakdown: {},
  }),
  get_project_token_stats: () => ({
    sessions: [],
    total_sessions: 0,
    page: 1,
    page_size: 20,
  }),
  get_project_stats_summary: () => ({
    total_sessions: 1,
    total_messages: MOCK_MESSAGES.length,
    total_input_tokens: 12000,
    total_output_tokens: 3500,
    date_range: { start: "2026-03-07", end: "2026-03-10" },
  }),
  get_global_stats_summary: () => ({
    total_projects: 1,
    total_sessions: 1,
    total_messages: MOCK_MESSAGES.length,
  }),
  get_session_comparison: () => [],
  get_recent_edits: () => [],
  load_mcp_presets: () => [],
  load_presets: () => [],
  get_all_mcp_servers: () => [],
  load_metadata: () => ({}),
  save_metadata: () => ({}),
  load_user_metadata: () => mockUserMetadata,
  save_user_metadata: () => ({}),
  // Kept in memory so settings toggles round-trip during browser testing.
  update_user_settings: (args) => {
    const update = (args.update ?? args.settings ?? {}) as Record<string, unknown>;
    mockUserMetadata.settings = { ...mockUserMetadata.settings, ...update };
    return mockUserMetadata;
  },
  load_unified_presets: () => [],
  get_all_settings: () => ({
    user: JSON.stringify({ cleanupPeriodDays: 30 }, null, 2),
    project: null,
    local: null,
    managed: null,
  }),
  load_settings: () => null,
  save_settings: () => ({}),
  load_session_metadata: () => ({}),
  save_session_metadata: () => ({}),
  rename_session_native: () => ({}),
  read_text_file: () => "",
};

export function mockApiPlugin(): Plugin {
  return {
    name: "mock-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          next();
          return;
        }

        const command = req.url.replace("/api/", "").split("?")[0]!;
        const handler = handlers[command];

        if (!handler) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown command: ${command}` }));
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const args = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            const result = handler(args);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });
    },
  };
}
