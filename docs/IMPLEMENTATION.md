# Implementation notes (SPEC conformance)

This is a TypeScript implementation of the [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md)
(Draft v1). It targets Windows first and also runs on macOS/Linux. The coding agent is the
**Claude Code CLI**; the tracker is **Linear**.

## Module map

| SPEC component | File |
|---|---|
| Workflow loader (5.1, 5.2) | `src/workflow.ts` |
| Config layer, defaults, `$VAR`/`~` (5.3, 6.1) | `src/config.ts` |
| Dynamic reload, last-known-good (6.2) | `src/workflowStore.ts` |
| Dispatch preflight validation (6.3) | `src/validation.ts` |
| Orchestrator: poll, dispatch, retry, reconcile (7, 8, 16) | `src/orchestrator.ts` |
| Workspace manager + safety invariants (9) | `src/workspace.ts`, `src/hooks.ts` |
| Agent runner (10.7, 16.5) | `src/runner.ts` |
| Agent client (10.1–10.6) | `src/agent/claude.ts` |
| Provider-native tools over MCP (10.5 extension) | `src/agent/toolServer.ts` |
| Tracker adapter (11) | `src/tracker/linear.ts` |
| Strict prompt rendering (5.4, 12) | `src/template.ts` (LiquidJS, `strictVariables` + `strictFilters`) |
| Logging (13.1, 13.2) | `src/log.ts` (`key=value` to stderr + `log/symphony.log`) |
| HTTP extension (13.7) | `src/http.ts` |
| CLI (17.7) | `src/cli.ts`, `src/doctor.ts` |

## Deviations from the Codex-oriented parts of the SPEC

The SPEC's agent section targets the Codex app-server. This implementation targets Claude Code's
equivalent long-lived stdio protocol and documents the mapping here:

- **Config section:** `claude` replaces `codex` (a `codex` section is still read as a fallback for
  the shared keys such as `stall_timeout_ms`). Keys: `command` (default `claude`), `args`,
  `permission_mode` (default `bypassPermissions`), `model`, `allowed_tools`, `disallowed_tools`,
  `append_system_prompt`, `strict_mcp_config` (default `true`), `turn_timeout_ms` (3600000),
  `read_timeout_ms` (5000), `stall_timeout_ms` (300000).
- **Launch:** instead of `bash -lc <codex.command>`, the executable named by `claude.command` is
  resolved on `PATH` (honouring `PATHEXT` on Windows, plus `~/.local/bin`, the native installer
  location) and spawned directly with an argument vector, cwd = per-issue workspace:
  `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode <mode> --disallowedTools AskUserQuestion[,…] [--mcp-config <file> --strict-mcp-config] [--model …] [args…]`.
  `.cmd`/`.bat` shims are started through `cmd.exe /d /s /c` with quoted arguments.
- **Transport:** newline-delimited JSON on stdout (10 MB max line); stderr is diagnostics only
  (last 8 KB kept for error messages).
- **Thread/turn identity:** `thread_id` = Claude `session_id` from the `system/init` message;
  `turn_id` = `turn-<n>` (Claude has no native turn id); `session_id` = `<thread_id>-<turn_id>`.
- **Turns:** each user message written to stdin starts a turn; the `result` message ends it.
  `subtype: success` and `is_error: false` → `turn_completed`; anything else → `turn_failed`.
  Continuation turns are written to the same live process, so the thread history is preserved.
- **Timeouts:** `read_timeout_ms` bounds the time from the first prompt to `system/init`;
  `turn_timeout_ms` is a silence timer reset by every stdout line; `stall_timeout_ms` is enforced
  by the orchestrator from the last event timestamp.
- **Token accounting:** `result.usage` is per turn; the client accumulates it into absolute
  thread totals (input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`)
  and the orchestrator converts absolute totals into deltas. `total_cost_usd` (cumulative per
  process) is tracked the same way and shown on the dashboard. `rate_limit_event.rate_limit_info`
  is stored as the latest rate-limit snapshot.
- **Hooks on Windows:** default shell is Windows PowerShell (`-EncodedCommand`, with
  `$ErrorActionPreference='Stop'` and a trailer that propagates `$LASTEXITCODE`). `hooks.shell`
  can be `bash` (Git Bash is located automatically on Windows), `sh`, `powershell` or `pwsh`.
  Hooks receive `SYMPHONY_ISSUE_ID`, `SYMPHONY_ISSUE_IDENTIFIER`, `SYMPHONY_WORKSPACE`.

## Trust, approval, sandbox and user-input posture (10.5, 15)

- **Intended environment:** a trusted developer workstation or a dedicated machine/VM.
- **Default approval posture:** high trust — `permission_mode: bypassPermissions`. Claude Code
  executes commands and edits files without prompts. For stricter runs, use `acceptEdits` (or
  `default`/`dontAsk`) plus `allowed_tools`; in those modes `--permission-prompts none` is passed,
  so any action that is not pre-approved is **denied automatically** and the run never waits.
- **Approval requests:** the CLI is not started with a permission-prompt tool; if a
  `control_request` arrives anyway it is answered with an error immediately
  (`unsupported_tool_call` event), so it cannot stall the run.
- **User input:** `AskUserQuestion` is always disallowed. The agent is told in the prompt that
  nobody will answer. A run therefore never waits for user input; if the model gives up, the
  turn ends and normal continuation/retry logic applies.
- **Filesystem:** the agent is launched only after validating that cwd is the per-issue
  workspace and that it is strictly inside `workspace.root` (lexically and via real paths, which
  defends against junctions/symlinks). Workspace keys are sanitized to `[A-Za-z0-9._-]`; when
  sanitization changes the identifier (or the result is `.`, `..`, a Windows reserved device name
  or ends in a dot) a 64-bit SHA-256 hex suffix is appended.
- **Secrets:** tracker credentials are read host-side only. Every env name declared by the
  adapter (`LINEAR_API_KEY` plus any `$VAR` referenced by `tracker.provider.api_key`) is removed
  from the agent's and the hooks' environment. Secrets are never logged.
- **Not a sandbox:** the agent runs as your OS user with your Git/GitHub credentials. Use branch
  protection on the target repository and run Symphony on a dedicated user/VM for stronger
  isolation.

## Linear adapter profile (11.2)

- **`tracker.kind`:** `linear`
- **`tracker.provider` keys**
  | key | default | notes |
  |---|---|---|
  | `api_key` | `$LINEAR_API_KEY` | **secret**. `$VAR` / `${VAR}` supported; empty → `missing_tracker_secret`. Keys starting with `lin_oauth_` are sent as `Bearer`. |
  | `project_slug` | — | Linear project `slugId`. Required unless `project_url` is given. |
  | `project_url` | — | Project URL; the slug is the text after the last `-` of the `/project/<segment>` part. |
  | `endpoint` | `https://api.linear.app/graphql` | must be http(s). |
  | `assignee` | none | `me` (API key owner) or a user id; other assignees → `dispatchable=false`. |
  | `blocker_gated_states` | `["Todo"]` | in these states an unresolved blocker makes the issue non-dispatchable. |
  | `page_size` | `50` | 1..250. |
  | `timeout_ms` | `30000` | per HTTP request. |
- **Default states:** active `["Todo", "In Progress"]`; terminal `["Done", "Canceled", "Cancelled", "Duplicate", "Closed"]`.
- **Scope:** every query filters `project.slugId == <slug>`; state lists add `state.name in [...]`,
  ID refresh adds `id in [...]`. Cursor pagination (`first`/`after`, ordered by `createdAt`);
  a page with `hasNextPage` but no new `endCursor` → `tracker_pagination`.
- **Mapping:** `id` = Linear issue UUID; `native_ref` = `{provider, issue_id, team_id, team_key,
  project_id, project_slug, state_type}`; `identifier` = `ABC-123`; `state` = state name (provider
  spelling); `priority` = Linear priority (0 = none, 1 urgent … 4 low; 0 sorts with null);
  `labels` trimmed, lowercased, de-duplicated; `blocked_by` from `inverseRelations` of type
  `blocks`; timestamps parsed from RFC 3339 or `null`.
- **Blockers:** a blocker is resolved when its state type is `completed`/`canceled` or its name is
  a configured terminal state; unknown → unresolved.
- **Malformed records:** missing `id`/`identifier`/`title`/`state.name` → omitted (and logged) in
  state lists; ID refresh fails with `tracker_response`.
- **Errors → categories:** thrown as `TrackerError` with `.category`/`.message`:
  fetch/network failure → `tracker_request`; HTTP non-2xx → `tracker_status` (401/403 hint the
  API key); HTTP 429 or GraphQL `RATELIMITED` → `tracker_rate_limited` (with `retry_after_ms`
  when the reset header exists); non-JSON / GraphQL errors / missing data → `tracker_response`;
  pagination problems → `tracker_pagination`; config problems → `invalid_tracker_config` /
  `missing_tracker_secret`.
- **Agent tool** (advertised over a per-session MCP HTTP endpoint on `127.0.0.1`, bound to one
  adapter snapshot and the live issue):
  - `linear_graphql` — input `{ query: string, variables?: object }`. Can **mutate** tracker state
    (comments, state changes, attachments). Runs with Symphony's API key; scope is whatever that
    key can access. Result: `{ data }` on success; on failure `isError: true` with
    `{ error: { category, message, details? } }` (`invalid_arguments`, `tracker_*`,
    `unsupported_tool`). No client-side idempotency; Linear's API rate limits apply.

## Other implementation-defined choices

- **Existing non-directory at a workspace path:** the attempt fails (`workspace_path_not_directory`); nothing is deleted.
- **`after_create` failure:** the brand-new directory is removed. Reused workspaces are never reset.
- **Reload:** a reload that fails parsing, coercion, template syntax or dispatch validation keeps the
  last known good config; the error is logged and shown on the dashboard (`health.workflow_error`).
  The file is watched (directory watch, debounced) and re-checked by content hash on every tick.
- **Logs:** `ts=… level=… msg="…" key=value`; issue logs carry `issue_id` and `issue_identifier`,
  session logs `session_id`. Raw agent streams are written to
  `log/sessions/<workspace_key>/<timestamp>.jsonl`. Extension key `logging.root` (default `./log`
  next to `WORKFLOW.md`) or CLI `--logs-root`.
- **HTTP extension:** enabled by `server.port` or `--port` (CLI wins); binds `127.0.0.1` unless
  `server.host` is set. `GET /`, `GET /api/v1/state`, `GET /api/v1/<identifier>`,
  `POST /api/v1/refresh`; other methods → 405; JSON error envelope.
- **Agent executable check:** dispatch validation also fails when `claude.command` cannot be found.

## Tests

`npm test` runs the core conformance matrix (SPEC 17.1–17.7) plus an end-to-end test that starts
the real CLI against a local fake Linear GraphQL server and a fake Claude CLI speaking
stream-json (dispatch → MCP tool call → handoff → continuation retry → dashboard API → clean shutdown).
The real-integration profile (17.8) is `npm run doctor` against your Linear workspace, followed by a
first real issue.
