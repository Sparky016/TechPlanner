# ADR-0015: Copilot SDK API Surface

Status: Accepted

Date: 2026-10-05

Source: SPEC_DOC.md §7.6 LLM-1–LLM-10, §12; task 12 spike

## Context

ADR-0002 selects the GitHub Copilot SDK driving the Copilot CLI over JSON-RPC. SPEC_DOC §12 asks for the exact SDK APIs to be confirmed before the facilitator (task 23) and evaluator (task 24) are built on them. This spike read the installed package's type declarations (`dist/*.d.ts`, `dist/generated/*.d.ts`), compiled JS and README.

## Decision

### Versions (pinned)

- `@github/copilot-sdk` **1.0.16**, pinned exactly in `package.json` (no caret).
- The CLI is not a separate dependency. The SDK bundles the runtime through the optional platform package `@github/copilot-sdk-<platform>` (for example `@github/copilot-sdk-linux-x64`). The bundled CLI version is **1.0.90** (`copilotCliVersion` in the SDK `package.json`, `COPILOT_CLI_VERSION` in `dist/cliVersion.d.ts`). Bumping the SDK bumps the CLI.
- Task 38 (Docker): `npm ci` on the target platform must install the matching platform package (`@github/copilot-sdk-linux-x64` / `-linux-arm64`, or `-linuxmusl-x64` / `-linuxmusl-arm64` on Alpine). Otherwise, set `COPILOT_CLI_PATH` to a CLI 1.0.90 binary. When `COPILOT_CLI_PATH` is set, `RuntimeConnection.forStdio({ path })` uses that binary instead of the bundled one.
- Node requirement: `^20.19.0 || >=22.12.0`.

### 1. Custom tool registration (LLM-5)

- `SessionConfigBase.tools: Tool[]`, where `Tool = { name; description?; parameters?: ZodSchema | Record<string, unknown>; handler?: ToolHandler; skipPermission?; overridesBuiltInTool?; isTerminal? }`. `defineTool(name, config)` is the typed helper.
- `ToolHandler = (args, invocation: ToolInvocation) => unknown`. The return value is a `string` or a `ToolResultObject { textResultForLlm; resultType: 'success' | 'failure' | 'rejected' | 'denied' | 'timeout' }`. A `failure` result keeps the agent loop running, so the model reads the message and can retry.
- Our use: raw JSON Schema `parameters`. Every call goes through `executeToolCall` (`src/server/llm/toolCall.ts`), which validates with ajv before the app handler runs. Invalid arguments return `{ textResultForLlm: 'Invalid arguments: …', resultType: 'failure' }`, and the handler is not called.

### 2. Disabling built-in tools and the permission handler (LLM-6)

Built-in tools can be disabled, so there are three layers:

- `CopilotClientOptions.mode: 'empty'` is the multi-tenant server mode. It disables the session store, skills, plugins, file hooks, host git operations, custom instruction discovery and memory, and strips `environment_context` from the prompt. It requires `baseDirectory` (or `sessionFs`), and every session must declare `availableTools`. The SDK always sends `toolFilterPrecedence: 'excluded'`.
- `SessionConfigBase.availableTools` / `excludedTools` (`string[] | ToolSet`) control the tool list. The `ToolSet` builder offers `addBuiltIn(name | '*')`, `addCustom(name)` and `addMcp(name)`, which emit `builtin:*`, `custom:<name>` and `mcp:*`. A bare `'*'` is rejected. `BuiltInTools.Isolated` lists the session-local built-ins, and we enable none of them. Our use: `availableTools = ToolSet.addCustom(<each app tool>)`, `excludedTools = ToolSet.addBuiltIn('*').addMcp('*')`.
- `SessionConfigBase.onPermissionRequest: PermissionHandler` receives `(request: PermissionRequest, { sessionId })`. `PermissionRequest` is a union discriminated on `kind`: `shell | write | read | mcp | url | memory | custom-tool | hook | extension-management | workflow | extension-permission-access | extension-env-access`. The handler returns a `PermissionRequestResult` such as `{ kind: 'approve-once' }` or `{ kind: 'reject', feedback? }`. Our use (`createPermissionHandler`): approve only `kind === 'custom-tool'` with a `toolName` in the run's allow-list, and reject everything else. `approveAll` is never used.
- Working directory: `CopilotClientOptions.workingDirectory` and `SessionConfigBase.workingDirectory` both point at `fs.mkdtemp(os.tmpdir()/'tp-llm-')`, created once per process. `baseDirectory` (`COPILOT_HOME`) is a separate `tp-llm-home-` temp directory. `CopilotClientOptions.env` passes only an allow-list of OS variables, so app secrets never reach the CLI process. `gitHubToken` comes from `COPILOT_GITHUB_TOKEN` with `useLoggedInUser: false`.

### 3. Streaming event types (LLM-7)

- Enable with `SessionConfigBase.streaming: true`. Subscribe with `session.on(handler)` or `session.on(type, handler)`. A per-session `onEvent` is also available.
- Event `type` names (`SessionEvent`, from `dist/generated/session-events.d.ts`):
  - `assistant.message_delta`: `data.deltaContent`, `data.messageId`. Maps to `text-delta`.
  - `assistant.message`: `data.content`, `data.messageId`. This is the full message. We use it only when no deltas were streamed for that `messageId`.
  - `assistant.usage`: `data.inputTokens`, `data.outputTokens`, `data.model`. Summed into `done.usage`.
  - `session.idle`: the turn is finished. Maps to `done`.
  - `session.error`: `data.errorType` (`rate_limit`, `quota`, `authentication`, `authorization`, `context_limit`, `query`, …), plus `data.errorCode`, `data.statusCode` and `data.message`. Maps to `error` after retry classification.
  - `model.call_failure` is intermediate, because the runtime reports terminal failures via `session.error`. `tool.execution_start` / `tool.execution_complete` exist. We derive `tool-call` events from our own handler wrapper instead, so `result` is the exact text the model received.
  - Events with `agentId` set come from sub-agents. They are ignored.
- `session.send(MessageOptions)` returns a message id. `session.sendAndWait` exists but has a 60 s default timeout and drops deltas, so we don't use it. `session.abort()` cancels the turn. `session.disconnect()` releases the session.

### 4. Session create/resume (LLM-4)

- `client.createSession(config: SessionConfig): Promise<CopilotSession>` (calls `client.start()` lazily).
- `client.resumeSession(sessionId, config: ResumeSessionConfig)` restores a session from `baseDirectory`. Tools, handlers and permission handler must be supplied again on every resume. `client.deleteSession(id)` deletes the on-disk state.
- **Decision: stateless runs.** Resume depends on CLI-local disk state that does not survive container replacement, and it duplicates the app DB, which is the source of truth. So each `run()` creates a fresh session, sends the full history in one prompt, then calls `disconnect()` + `deleteSession()`.

### 5. Model listing and health

- `client.listModels(): Promise<ModelInfo[]>`, where `ModelInfo = { id; name; capabilities: { supports: { vision; reasoningEffort }, limits }; policy? }`. The SDK caches the result per connection.
- `client.getAuthStatus(): { isAuthenticated; authType?; login? }`, `client.ping()` and `client.getStatus(): { version; protocolVersion }`.
- The `copilot` health check (`registerHealthCheck`) passes when the restart limit is not reached, `isAuthenticated` is true, and both `FACILITATOR_MODEL` and `EVALUATOR_MODEL` appear in `listModels()`. A cold CLI start can exceed the 2 s health timeout on the very first probe.

### 6. Image input (SR-2.4)

- Supported. `MessageOptions.attachments` accepts `{ type: 'blob', data: <base64>, mimeType, displayName? }`, so `CopilotLlmClient.supportsImages = true` and images from every message are attached as blobs.
- Whether a given model accepts images is `ModelInfo.capabilities.supports.vision` (limits in `capabilities.limits.vision`). Operators must pick a vision-capable `FACILITATOR_MODEL` for image ingestion.

### Process supervision and retries (LLM-9, NFR-8)

- The SDK exposes no public process-exit callback (`processExitPromise` and `onDisconnected` are private). A crash is detected when an SDK call throws and a follow-up `client.ping()` fails, or when the periodic `ping()` liveness probe (15 s) fails during a run. Runs also have a hard 10-minute timeout.
- On a crash the client calls `forceStop()` and a new `CopilotClient` starts lazily. This can happen at most 3 times in a sliding 5-minute window. A further crash marks the client unavailable: the health check fails and `run()` yields `{ type: 'error', code: 'ai_unavailable', retryable: false }`. The client recovers once the restarts age out of the window.
- Transient failures retry twice, after 1 s and then 4 s. Transient means `rate_limit`, `quota`, HTTP 429 / 5xx, or a crash. A retry happens only if the failed attempt has not yet streamed text or tool calls.

### System prompt

`systemMessage: { mode: 'replace', content: opts.system }`. The runtime's default prompt describes a coding agent with built-in tools. We disable those tools, and the facilitator and evaluator own their prompts (tasks 23/24). `customize` mode is the alternative if the runtime's safety section is ever needed.

## Rationale

The spike resolved every knowledge gap in task 12 against the installed 1.0.16 type definitions rather than documentation from memory. Layering empty mode, the tool filters and a deny-by-default permission handler means no single SDK behaviour change can grant host access.

## Revisit if

- The SDK adds a public process-exit/disconnect hook. Replace the ping-based crash detection.
- Upgrading the SDK (and therefore the CLI). Re-run the unit tests and re-check the event names and the `PermissionRequest.kind` values.
- Session resume becomes required for cost or latency. Persist `baseDirectory` and adopt `resumeSession`.
