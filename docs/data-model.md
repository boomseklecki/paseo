# Data Model

## Project identity

Projects are allocated for the exact root selected by the caller, normalized lexically with `path.resolve` (never `realpath`). New project IDs are opaque `prj_<16 hex>` values. Existing remote-shaped or path-shaped IDs are retained as readable compatibility records and are never rekeyed. An active exact root is idempotent; archived-only matches do not resurrect an old project. Workspace `projectId` is stable membership: reconciliation may update git-derived kind and branch metadata, but never rehomes a workspace or changes a project's root, ID, or default name.

`projectKey` is a persisted, opaque equivalence key used only to group the same logical project
across hosts. It is separate from the host-local `projectId`; today's producer prefers a normalized
Git remote and otherwise uses the local project root. Consumers never derive it from live Git.
Creation persists it with the project, and normal boot reconciliation fills it for
older records where the field is absent—there is no migration.

`kind` and `projectKey` are mutable metadata, not identity. Workspace reconciliation watches active project roots and
updates those fields and `updatedAt` when Git facts change, preserving the project's ID, root path,
names, and workspace foreign keys. Attached workspaces are independently refreshed
from their own cwd, so an explicit project root never implies a workspace checkout. Empty projects
are observed too.

The workspace registry model defines placement once: initial directory/worktree construction,
mutable reconciliation fields, and the persisted-to-wire checkout projection. Its update policy
preserves `displayName` and `baseBranch`. `WorkspaceProvisioningService` owns the corresponding
registry writes, so directory opens, agent imports, and worktree creation all enter through that
service instead of constructing records independently. The workspace record is then the durable
placement authority: `cwd` is the exact execution directory, while `worktreeRoot` is the backing
checkout root. They intentionally differ for an exact subproject inside a worktree. Archive,
restore, branch auto-name, and descriptor flows consume those persisted facts rather than
rediscovering ownership from a directory that may already be gone. Reconciliation may refresh
mutable placement facts, but never changes `projectId`, `cwd`, `displayName`, or `baseBranch`.
Workspace archive runs lifecycle teardown from the exact `cwd` but removes only the backing
`worktreeRoot` after its last active reference disappears. Worktree recovery recreates that backing
checkout from `mainRepoRoot`, then restores the relative path from `worktreeRoot` to `cwd`.

Paseo uses **file-based JSON persistence** instead of a traditional database. All data is validated at runtime with Zod schemas. Most stores write atomically (write to temp file, then rename); a few still use plain `writeFile` — see each section. There is no schema-versioning/migration framework — schemas rely on optional fields with defaults for forward compatibility, with a small amount of inline normalization in `persisted-config.ts` for legacy provider/speech entries.

All server-side stores live under `$PASEO_HOME` (defaults to `~/.paseo`).

## Store Surface Rules

Store APIs own persistence atomicity and should not make services coordinate raw reads and writes. A good store method maps cleanly to one SQL statement or one SQL transaction, even when the current implementation is JSON files. If a caller needs a queue, lock, read-merge-write loop, or uniqueness race workaround, that behavior belongs behind the store surface.

---

## Directory layout

```
$PASEO_HOME/
├── config.json                          # Daemon configuration
├── server-id                            # Stable daemon identifier (plain text, "srv_<base64url>")
├── daemon-keypair.json                  # E2EE keypair for relay (mode 0600)
├── paseo.pid                            # Daemon PID lock file
├── daemon.log                           # Default log file (path configurable)
├── agents/
│   └── {sanitized-cwd}/
│       └── {agentId}.json               # One file per agent
├── schedules/
│   └── {scheduleId}.json                # One file per schedule
├── rules/
│   ├── README.md                        # Seeded once; only *.json is read as a rule
│   └── {ruleId}.json                    # One file per rule; the filename is the id
├── projects/
│   ├── projects.json                    # Project registry
│   ├── workspaces.json                  # Workspace registry
│   └── icons/                           # Host-local custom project icon images
├── runtime/
│   └── managed-processes/
│       └── {recordId}.json              # Helper processes owned by Paseo; reconciled on daemon bootstrap
└── push-tokens.json                     # Expo push notification tokens
```

The `agents/{sanitized-cwd}/` directory name is derived from the agent's `cwd` by stripping the filesystem root and replacing path separators with `-` (Windows drive letters become a `C-` style prefix). Persistent server stores write atomically by writing a temp file in the target directory and then renaming it into place.

---

## 1. Agent Record

**Path:** `$PASEO_HOME/agents/{project-dir}/{agentId}.json`

Each agent is stored as a separate JSON file, grouped by project directory.

| Field                | Type                                     | Description                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`                                 | UUID, primary key                                                                                                                                                                                                                                                                                                                                                                   |
| `provider`           | `string`                                 | Agent provider (`"claude"`, `"codex"`, `"opencode"`, etc.)                                                                                                                                                                                                                                                                                                                          |
| `cwd`                | `string`                                 | Working directory the agent operates in                                                                                                                                                                                                                                                                                                                                             |
| `workspaceId`        | `string?`                                | Owning workspace id — the single source of ownership. Every agent is stamped with one at create time; legacy cwd-only records are backfilled once by `migrations/backfill-workspace-id.migration.ts` (the only place a cwd→id mapping exists). Runtime code never infers ownership or status from cwd: status is computed per `workspaceId`, and same-cwd siblings are independent. |
| `createdAt`          | `string` (ISO 8601)                      | Creation timestamp                                                                                                                                                                                                                                                                                                                                                                  |
| `updatedAt`          | `string` (ISO 8601)                      | Last update timestamp                                                                                                                                                                                                                                                                                                                                                               |
| `lastActivityAt`     | `string?` (ISO 8601)                     | Last activity timestamp                                                                                                                                                                                                                                                                                                                                                             |
| `lastUserMessageAt`  | `string?` (ISO 8601)                     | Last user message timestamp                                                                                                                                                                                                                                                                                                                                                         |
| `title`              | `string?`                                | User-visible title                                                                                                                                                                                                                                                                                                                                                                  |
| `labels`             | `Record<string, string>`                 | Key-value labels (default `{}`). Paseo uses `paseo.parent-agent-id` for parentage and client-scoped `paseo.open-agent-tab.*` labels while managed subagent tabs are open — see [agent-lifecycle.md](./agent-lifecycle.md)                                                                                                                                                           |
| `lastStatus`         | `AgentStatus`                            | One of: `"initializing"`, `"idle"`, `"running"`, `"error"`, `"closed"`. `closed` means the record is resumable but has no live provider runtime; archive remains represented separately by `archivedAt`.                                                                                                                                                                            |
| `lastModeId`         | `string?`                                | Last active mode ID                                                                                                                                                                                                                                                                                                                                                                 |
| `config`             | `SerializableConfig?`                    | Agent session configuration (see below)                                                                                                                                                                                                                                                                                                                                             |
| `runtimeInfo`        | `RuntimeInfo?`                           | Live runtime state (see below)                                                                                                                                                                                                                                                                                                                                                      |
| `features`           | `AgentFeature[]?`                        | Provider-reported features (toggles/selects)                                                                                                                                                                                                                                                                                                                                        |
| `persistence`        | `PersistenceHandle?`                     | Handle for resuming sessions                                                                                                                                                                                                                                                                                                                                                        |
| `lastError`          | `string?` (nullable)                     | Last error message, if any                                                                                                                                                                                                                                                                                                                                                          |
| `requiresAttention`  | `boolean?`                               | Whether the agent needs user attention                                                                                                                                                                                                                                                                                                                                              |
| `attentionReason`    | `"finished" \| "error" \| "permission"?` | Why attention is needed                                                                                                                                                                                                                                                                                                                                                             |
| `attentionTimestamp` | `string?` (ISO 8601)                     | When attention was flagged                                                                                                                                                                                                                                                                                                                                                          |
| `internal`           | `boolean?`                               | Whether this is a system-internal agent                                                                                                                                                                                                                                                                                                                                             |
| `archivedAt`         | `string?` (ISO 8601)                     | Soft-delete timestamp                                                                                                                                                                                                                                                                                                                                                               |

### Nested: SerializableConfig

| Field              | Type                       | Description                  |
| ------------------ | -------------------------- | ---------------------------- |
| `title`            | `string?`                  | Configured title             |
| `modeId`           | `string?`                  | Configured mode              |
| `model`            | `string?`                  | Configured model             |
| `thinkingOptionId` | `string?`                  | Thinking/reasoning level     |
| `featureValues`    | `Record<string, unknown>?` | Feature preference overrides |
| `extra`            | `Record<string, any>?`     | Provider-specific config     |
| `systemPrompt`     | `string?`                  | Custom system prompt         |
| `mcpServers`       | `Record<string, any>?`     | MCP server configurations    |

### Nested: RuntimeInfo

| Field              | Type                       | Description                    |
| ------------------ | -------------------------- | ------------------------------ |
| `provider`         | `string`                   | Active provider                |
| `sessionId`        | `string?`                  | Active session ID              |
| `model`            | `string?`                  | Active model                   |
| `thinkingOptionId` | `string?`                  | Active thinking option         |
| `modeId`           | `string?`                  | Active mode                    |
| `extra`            | `Record<string, unknown>?` | Provider-specific runtime data |

### Nested: PersistenceHandle

| Field          | Type                   | Description                                                           |
| -------------- | ---------------------- | --------------------------------------------------------------------- |
| `provider`     | `string`               | Provider that owns the session                                        |
| `sessionId`    | `string`               | Session ID for resumption                                             |
| `nativeHandle` | `any?`                 | Provider-specific handle (Codex thread ID, Claude resume token, etc.) |
| `metadata`     | `Record<string, any>?` | Extra metadata                                                        |

### Nested: AgentFeature (discriminated union on `type`)

**Toggle:**

| Field         | Type       |
| ------------- | ---------- |
| `type`        | `"toggle"` |
| `id`          | `string`   |
| `label`       | `string`   |
| `description` | `string?`  |
| `tooltip`     | `string?`  |
| `icon`        | `string?`  |
| `value`       | `boolean`  |

**Select:**

| Field         | Type                  |
| ------------- | --------------------- |
| `type`        | `"select"`            |
| `id`          | `string`              |
| `label`       | `string`              |
| `description` | `string?`             |
| `tooltip`     | `string?`             |
| `icon`        | `string?`             |
| `value`       | `string \| null`      |
| `options`     | `AgentSelectOption[]` |

---

## Runtime-only Terminal Sessions

Terminals are live daemon state, not persisted JSON records. A terminal carries a `workspaceId` while it is running; workspace-scoped terminal lists include only terminals with the matching `workspaceId`. Legacy live terminals without an owner remain visible to unscoped terminal reads but contribute to no workspace status.

Terminal activity contributes to the workspace status bucket **per `workspaceId`**: a working terminal drives `running` onto the workspace it carries only. Same-`cwd` siblings are untouched; terminal visibility is likewise `workspaceId`-scoped.

---

## 2. Daemon Configuration

**Path:** `$PASEO_HOME/config.json`

Single file, validated with `PersistedConfigSchema`.

```
{
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    hostnames: true | string[],   // legacy alias `allowedHosts` is migrated on load
    trustedProxies: true | string[], // defaults to ["loopback"]; Express proxy names/CIDRs
    mcp: { enabled: boolean, injectIntoAgents: boolean },
    git: { maxProcessesPerSecond: number, maxProcessConcurrency: number },
    appendSystemPrompt: string,    // appended to supported provider system/developer prompts
    terminalProfiles: TerminalProfile[],  // named shell commands; omitted means DEFAULT_TERMINAL_PROFILES
    agentProfiles: AgentProfile[],        // named agent launch bundles; omitted means none
    rulesEnabled: boolean,                // this host's rules, at all four seams; absent means on
    cors: { allowedOrigins: string[] },
    relay: { enabled: boolean, endpoint: string, publicEndpoint: string, useTls: boolean, publicUseTls: boolean }, // new homes materialize enabled: false
    auth: { password: string }    // bcrypt hash, optional
  },
  app: {
    baseUrl: string
  },
  worktrees?: {
    root?: string            // optional root for new worktrees; defaults to $PASEO_HOME/worktrees
    servicePorts?: {         // optional dynamic service port allocation policy
      range?: string         // inclusive range, e.g. "3000-4000"
      portScript?: string    // executable that receives service/workspace context and prints one TCP port
    }
  },
  providers: {
    openai: {
      apiKey?: string,
      baseUrl?: string,
      stt?: { apiKey?: string, baseUrl?: string },
      tts?: { apiKey?: string, baseUrl?: string }
    },
    local: { modelsDir: string }
  },
  agents: {
    // ProviderOverrideSchema; legacy entries with `command: { mode, ... }` are migrated to the
    // current shape on load via `migrateProviderSettings`. Custom provider IDs must declare
    // `extends` (one of the built-ins or `"acp"`) and `label`. See `provider-launch-config.ts`.
    providers: Record<providerId, ProviderOverride>,
    metadataGeneration: {
      providers: [{ provider, model?, thinkingOptionId? }]
    }
  },
  features: {
    dictation: { enabled, stt: { provider, model, language, confidenceThreshold } },
    voiceMode: { enabled, llm, stt: { provider, model, language }, turnDetection, tts: { provider, model, voice, speakerId, speed } }
  },
  log: {
    level, format,
    console: { level, format },
    file: { level, path, rotate: { maxSize, maxFiles } }
  }
}
```

All fields are optional with sensible defaults.

### Profile lists

`terminalProfiles` and `agentProfiles` are both whole-list fields: a config patch replaces the
array, never merges entries, so a client sends the complete next list on every add, edit, reorder
and remove. List order is the display order.

Absent and empty mean different things for terminal profiles — omitting the key falls back to
`DEFAULT_TERMINAL_PROFILES`, while `[]` means the user removed them all. Agent profiles have no
defaults, so both mean none.

`PersistedConfigSchema` parses strictly, so a daemon that predates a field drops it on write
rather than storing something it cannot describe. That is why the client gates the agent profiles
UI on `server_info.features.agentProfiles` instead of letting a save appear to succeed against an
older daemon.

### Git process limits

Git process limits are global to one daemon. The start-rate limit defaults to `64` processes per
second, and the concurrency limit defaults to `8`:

```json
{
  "daemon": {
    "git": {
      "maxProcessesPerSecond": 64,
      "maxProcessConcurrency": 8
    }
  }
}
```

`maxProcessesPerSecond` limits Git process starts in any one-second interval. The allowance can
start as a burst; it does not wait for earlier processes to exit. `maxProcessConcurrency` limits
the number of Git processes that have started but not exited. Every Git command uses both limits,
including initial workspace reads, filesystem-triggered refreshes, background checks, and explicit
requests.

Environment variables override `config.json`:

| Environment variable                 | Setting                  |
| ------------------------------------ | ------------------------ |
| `PASEO_GIT_MAX_PROCESSES_PER_SECOND` | `maxProcessesPerSecond`  |
| `PASEO_GIT_MAX_PROCESS_CONCURRENCY`  | `maxProcessConcurrency`  |
| `PASEO_GIT_CONCURRENCY`              | Legacy concurrency alias |

`PASEO_GIT_MAX_PROCESS_CONCURRENCY` wins when it and the legacy alias are both set. Restart the
daemon after changing the file or environment. Run `paseo daemon restart` for a standalone daemon.
For a desktop-managed daemon, fully quit and reopen Paseo Desktop.

`agents.metadataGeneration.providers` controls the preferred structured-generation fallback order for daemon-side metadata tasks such as commit messages, PR text, branch names, and generated agent titles. Entries are tried first in the configured order, then Paseo falls through to dynamically discovered defaults and finally the current selection when available.

Local speech model ids are intentionally narrow: STT uses `parakeet-tdt-0.6b-v2-int8`, TTS uses `kokoro-en-v0_19`, and turn detection uses the bundled Silero VAD model.

Set these to select OpenAI instead of local speech:

| Env var                        | Applies to                      |
| ------------------------------ | ------------------------------- |
| `PASEO_VOICE_STT_PROVIDER`     | Voice mode STT provider         |
| `PASEO_DICTATION_STT_PROVIDER` | Composer dictation STT provider |
| `PASEO_VOICE_TTS_PROVIDER`     | Voice mode TTS provider         |

OpenAI speech can be configured under `providers.openai`. STT and TTS resolve independently, so they can point at different endpoints:

```json
{
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "sk-...",
        "baseUrl": "https://stt.example.com/v1"
      },
      "tts": {
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` is used for both composer dictation and voice mode speech-to-text; `providers.openai.tts` is used for voice mode text-to-speech. The equivalent env vars are `OPENAI_STT_API_KEY`/`OPENAI_STT_BASE_URL` and `OPENAI_TTS_API_KEY`/`OPENAI_TTS_BASE_URL`. Each feature falls back to `providers.openai.apiKey`/`providers.openai.baseUrl`, then `OPENAI_API_KEY`/`OPENAI_BASE_URL`, when its own fields are unset. These settings apply only to Paseo OpenAI speech features, not to Codex or other OpenAI-backed tools.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

---

## 3. Schedule

**Path:** `$PASEO_HOME/schedules/{id}.json`

One file per schedule. ID is 8 hex characters.

| Field       | Type                                  | Description                      |
| ----------- | ------------------------------------- | -------------------------------- |
| `id`        | `string`                              | 8-char hex ID                    |
| `name`      | `string?`                             | Human-readable name              |
| `prompt`    | `string`                              | The prompt to send               |
| `cadence`   | `ScheduleCadence`                     | Timing (see below)               |
| `target`    | `ScheduleTarget`                      | What to run (see below)          |
| `status`    | `"active" \| "paused" \| "completed"` | Current state                    |
| `createdAt` | `string` (ISO 8601)                   |                                  |
| `updatedAt` | `string` (ISO 8601)                   |                                  |
| `nextRunAt` | `string?` (ISO 8601)                  | Next scheduled execution         |
| `lastRunAt` | `string?` (ISO 8601)                  | Last execution time              |
| `pausedAt`  | `string?` (ISO 8601)                  | When paused                      |
| `expiresAt` | `string?` (ISO 8601)                  | Auto-expire time                 |
| `maxRuns`   | `number?`                             | Max executions before completing |
| `runs`      | `ScheduleRun[]`                       | Execution history                |

### Nested: ScheduleCadence (discriminated union on `type`)

- `{ type: "cron", expression: string, timezone?: string }` — canonical cadence for new writes; absent `timezone` means UTC
- `{ type: "every", everyMs: number }` — legacy rolling interval, still readable and executable during the compatibility window

### Nested: ScheduleTarget (discriminated union on `type`)

- `{ type: "agent", agentId: string }` — send to existing agent
- `{ type: "new-agent", config: { provider, cwd, modeId?, model?, thinkingOptionId?, title?, providerOptions?, featureValues?, systemPrompt?, mcpServers? } }` — create a new agent

### Nested: ScheduleRun

| Field          | Type                                   | Description             |
| -------------- | -------------------------------------- | ----------------------- |
| `id`           | `string`                               | Run ID                  |
| `scheduledFor` | `string` (ISO 8601)                    | Intended execution time |
| `startedAt`    | `string` (ISO 8601)                    |                         |
| `endedAt`      | `string?` (ISO 8601)                   |                         |
| `status`       | `"running" \| "succeeded" \| "failed"` |                         |
| `agentId`      | `string?` (UUID)                       | Agent used for this run |
| `output`       | `string?`                              | Agent output text       |
| `error`        | `string?`                              | Error message if failed |

---

## 4. Project Registry

**Path:** `$PASEO_HOME/projects/projects.json`

Array of project records.

| Field                | Type                        | Description                                                                                                                                |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectId`          | `string`                    | Host-local primary key; new records use opaque `prj_<16 hex>` IDs                                                                          |
| `projectKey`         | `string \| null`            | Persisted opaque cross-host grouping key; reconciliation backfills absent values                                                           |
| `rootPath`           | `string`                    | Exact lexically normalized selected root; never realpathed                                                                                 |
| `kind`               | `"git" \| "non_git"`        | Mutable Git observation about `rootPath`, never a membership key                                                                           |
| `displayName`        | `string`                    | Selected-root basename, stable across remote and Git changes                                                                               |
| `customName`         | `string \| null`            | User-set override layered over `displayName`. Null means "use the derived name".                                                           |
| `customIconRevision` | `string \| null`            | Identifies the host-local custom icon stored under `projects/icons/`. Null means the icon is discovered by scanning the project directory. |
| `createdAt`          | `string` (ISO 8601)         |                                                                                                                                            |
| `updatedAt`          | `string` (ISO 8601)         |                                                                                                                                            |
| `archivedAt`         | `string \| null` (ISO 8601) | Soft-delete timestamp; required nullable                                                                                                   |

Uploading a file and pasting a website or image URL are two ways of _acquiring_ the same custom
icon. The client fetches URL imports and sends their bytes through the upload RPC. The daemon never
receives or fetches the URL; it validates the uploaded bytes, stores them, and records a new
`customIconRevision`. Going back to automatic deletes the stored image, as does removing the
project.

Active exact roots are idempotent using lexical platform-equivalence semantics. Existing legacy
remote-shaped and path-shaped IDs remain readable, including duplicate roots; reconciliation never
merges them, transfers names, archives them, or moves workspace foreign keys. An explicit
workspace `projectId` is authoritative when it names an active project, regardless of cwd
containment. Archived-only exact-root records are not resurrected by explicit add/open; a fresh
opaque project is allocated instead. Agent restore is separate and restores the agent's existing
workspace together with its owning project.

---

## 5. Workspace Registry

**Path:** `$PASEO_HOME/projects/workspaces.json`

Array of workspace records. A workspace is a specific working directory within a project.

| Field                          | Type                                            | Description                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`                  | `string`                                        | Opaque stable identifier (`wks_<hex>`), generated independently of the directory. MUST NOT be treated as a path; compare by exact equality. Use the `cwd` field for directory access.         |
| `projectId`                    | `string`                                        | FK to Project.projectId; the workspace's stable project membership                                                                                                                            |
| `cwd`                          | `string`                                        | Exact execution directory selected for agents, files, scripts, and setup                                                                                                                      |
| `kind`                         | `"local_checkout" \| "worktree" \| "directory"` | Mutable checkout classification                                                                                                                                                               |
| `displayName`                  | `string`                                        | The human name (the generated/derived title). Decoupled from `branch` by construction.                                                                                                        |
| `title`                        | `string \| null`                                | User-set name override layered over `displayName`. Null means "use `displayName`".                                                                                                            |
| `branch`                       | `string \| null`                                | The current Git branch for git-backed workspaces. Separate from `displayName`/`title`; a background branch refresh never rewrites the name.                                                   |
| `worktreeRoot`                 | `string \| null`                                | Backing checkout/worktree root. May differ from `cwd` for exact subprojects and remains persisted after the worktree is deleted so restore can reproduce the placement.                       |
| `baseBranch`                   | `string \| null`                                | Normalized branch the Paseo worktree was created from; null for directories, local checkouts, and checkout-branch worktrees                                                                   |
| `isPaseoOwnedWorktree`         | `boolean`                                       | Whether Paseo owns and may remove/recreate the backing `worktreeRoot`                                                                                                                         |
| `mainRepoRoot`                 | `string \| null`                                | Main repository root for worktree checkouts, independent of both exact `cwd` and backing `worktreeRoot`                                                                                       |
| `createdAt`                    | `string` (ISO 8601)                             |                                                                                                                                                                                               |
| `updatedAt`                    | `string` (ISO 8601)                             |                                                                                                                                                                                               |
| `archivedAt`                   | `string \| null` (ISO 8601)                     | Soft-delete; required nullable                                                                                                                                                                |
| `autoArchivedChangeRequestUrl` | `string \| null`                                | Change request whose merged state triggered auto-archive. Restore replaces it with the current merged change request, when present, so repeated snapshots cannot archive the workspace again. |
| `pinnedAt`                     | `string \| null` (ISO 8601)                     | Pinned-to-top-of-sidebar timestamp; null means "not pinned"                                                                                                                                   |

> **Opaque-ID invariant:** `workspaceId` is opaque identity, never a filesystem path. Filesystem and git operations take `cwd`/`workspaceDirectory` only — never the id. A compatibility-only first-materialization bootstrap still groups pre-registry agent records by path and Git remote so existing installs retain their legacy records. That grouping never runs against a live registry, and its keys are not runtime project or workspace identity.

`projectId` is still a real FK: workspace records should have a matching project record. Read-only
history surfaces tolerate transient orphaned workspaces by omitting those rows so one bad FK cannot
blank the whole History screen, but mutation paths should repair or remove the orphaned state rather
than treating it as valid.

---

## 6. Push Token Store

**Path:** `$PASEO_HOME/push-tokens.json`

```json
{
  "tokens": ["ExponentPushToken[...]", ...]
}
```

Simple set of Expo push notification tokens. Loaded with permissive parsing (filters non-string entries). Persisted with atomic temp-file rename.

---

## 7. Daemon meta files

These small files are not validated as full Zod schemas but are persisted under `$PASEO_HOME` for daemon identity and runtime coordination.

| Path                  | Format                                                         | Notes                                                                             |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `server-id`           | Plain text, e.g. `srv_<base64url>`                             | Stable per-`$PASEO_HOME` daemon ID. Overridable via `PASEO_SERVER_ID` env.        |
| `daemon-keypair.json` | `{ v: 2, publicKeyB64, secretKeyB64 }` (libsodium box keypair) | E2EE relay identity. Written with mode `0600`. Regenerated if file is unreadable. |
| `paseo.pid`           | JSON `{ pid, startedAt, ... }`                                 | PID lock; prevents two daemons sharing one `$PASEO_HOME`.                         |
| `daemon.log`          | Pino log output                                                | Default location; path/rotation configurable via `log.file` in `config.json`.     |

---

## 8. Rule

**Path:** `$PASEO_HOME/rules/{ruleId}.json`

One file per rule. The filename **is** the id — a rule file needs no `id` field, and one that carries a different value is read under its filename anyway, which is what keeps two files from claiming a single primary key. Ids are restricted to `[A-Za-z0-9._-]{1,120}` because they become filenames.

Unlike every other store here, ids are minted by the **client**, not the daemon. A rule can be assigned to several hosts and the app groups the copies back together by id, so each daemon has to be handed the same one; `rules/upsert` is the only write verb for that reason.

| Field      | Type                | Description                                                                                                                                                                   |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `string`            | Filename without `.json`; supplied by the store on read                                                                                                                       |
| `event`    | `string?`           | Which seam (see below). Absent means `message.send`, the only one that existed at first                                                                                       |
| `trigger`  | `string`            | What is looked at, e.g. `agent.idleSeconds`, `message`                                                                                                                        |
| `operator` | `string`            | `gt` \| `gte` \| `lt` \| `lte` for numbers, `startsWith` \| `contains` for text                                                                                               |
| `value`    | `string \| number?` | What the trigger is compared against; the type says which kind of trigger                                                                                                     |
| `outcomes` | `object[]`          | Each `{ kind, ... }`. `warn`, `block` and `notify` are plain and carry a `wording`; any other kind names something the daemon runs and carries a `prompt`. All of them happen |
| `message`  | `string?`           | Retiring. The rule-level sentence, now written as a projection of the first outcome's `wording`                                                                               |
| `order`    | `number?`           | Display position; unordered rules sort after ordered ones                                                                                                                     |
| `enabled`  | `boolean?`          | Absent means enabled                                                                                                                                                          |

### Seams, and what each accepts

A rule is evaluated at one seam, and what it may look at and ask for differs per
seam — a `block` needs a send to hold, `notify` needs nobody watching, and the
`message` trigger names text that was sent a turn ago. `packages/protocol/src/rules/events.ts`
is the table; a rule asking for something its seam does not accept is skipped
rather than half-performed.

| Event            | When                                 | Evaluated by | Outcomes                  |
| ---------------- | ------------------------------------ | ------------ | ------------------------- |
| `message.send`   | before a message leaves the composer | the app      | `warn`, `block`, a runner |
| `turn.completed` | a turn ended                         | the daemon   | `notify`, a runner        |
| `turn.failed`    | a turn failed                        | the daemon   | `notify`, a runner        |
| `agent.idle`     | an agent has been left sitting       | the daemon   | `notify`, a runner        |

The runners are `aside` (answer in a hidden agent), `fork` (carry this
conversation into a new one), `start` (open a fresh one carrying nothing) and
`schedule` (come back to this later). `packages/server/src/server/rules/outcomes/registry.ts`
is the lookup, and it declines a kind it does not have rather than ignoring it.

### The host switch

`daemon.rulesEnabled` in `config.json` turns off every rule on one host,
and the rules stay on disk while it is off. Absent means on, so a daemon that has
never seen the key still runs what it holds; only an explicit `false` stops
anything.

It is read on both sides of the `message.send` seam, because that seam is
evaluated in the app: the composer reads it out of the daemon config it already
holds, and `websocket-server.ts` reads it once where the three daemon seams meet.
Two readers, one switch — off means off at all four, pushes included. Both read it
live rather than capturing it at startup, so a toggle takes effect without a
restart, which is the property the rules themselves have.

The switch is per host, like everything else in this section. A fleet's rules are
turned off one machine at a time.

### Wording belongs to the outcome that says it

`warn`, `block` and `notify` each carry their own `wording`; the runnable kinds
carry a `prompt` instead. There is no rule-level text field, and its absence is
the point. One shared `message` was offered by the editor on every rule, but the
composer redirects before it renders one — so a rule whose only outcome was an
`aside` showed a box that nothing read, and whatever you typed in it did nothing.
A field exists where something consumes it.

The tokens differ by field, because what is available differs. A `prompt` may use
`{{message}}` — what a person typed — and therefore only at `message.send`;
nobody types anything at a daemon seam, where the token used to resolve to an
empty string and hand an agent a prompt with a hole in it. A `wording` never uses
`{{message}}` at any seam: it uses `{{value}}`, `{{threshold}}` and, for a
duration trigger, `{{duration}}`. The editor lists which are live rather than
describing them in prose.

Both sides substitute through `packages/protocol/src/rules/format.ts`.
The composer got this free from i18next, which interpolates as it translates; the
daemon has no translator and was sending `{{value}}` to a phone verbatim.

### A list, and what settles a disagreement inside it

`outcomes` is a list because one condition usually deserves more than one answer:
an `aside` that writes a handoff and a `notify` that says it is there describe a
single moment, and writing them as two rules means keeping two copies of the
threshold in step by hand.

Nothing new has to be decided to make that safe. Where two outcomes compete — a
`block` and an `aside` both wanting the message — it is settled the way two
_rules_ tripping at once has always been settled: by severity, then by the
arrangement someone chose. At a daemon seam nothing competes at all, because
nothing is being held back, so every outcome runs. The one thing the daemon
collapses is the announcement: a rule notifies once however many of its outcomes
ask it to, and after the work rather than before.

An outcome kind a seam refuses, or one this build cannot perform, is dropped and
the rest of the rule still runs. Dropping the whole rule would mean an app one
version ahead silently disarming a rule on every older host it is assigned to.
Examples are the deliberate exception: a daemon offers one only when it can carry
out _every_ outcome in it, because an example is a whole rule someone is agreeing
to by its description.

**A daemon-side rule fires on the crossing, not on the condition.** Once it has
fired for an agent it stays quiet until the condition clears and holds again —
otherwise "context is over 80%" is every turn to the end of the conversation.
That memory is per agent _and_ seam, in the daemon rather than the rule file, and
a restart arms everything afresh. `rule-events.ts` owns it.

The three daemon seams ride transitions the agent manager already detects;
`agent.idle` is the exception and gets a one-minute sweep, because nothing
happens when an agent goes on not being touched and that is the thing worth
being told about.

### How this lands in SQL

Written down while the feature is still JSON, because the shape has changed twice
this week and the migration should inherit a decision rather than an accident.
Conventions taken from `origin/sqlite-migration-pr2-db-foundation`.

```sql
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  sort_order INTEGER,
  payload TEXT NOT NULL
) STRICT;

CREATE INDEX rules_sort_order_idx ON rules(sort_order);
```

`id` is the natural text key the client mints, as it must be — the same rule lives
on several hosts under one id, which is why there is no `create` on the store.
`sort_order` is promoted because it is the sort key (`ORDER BY sort_order, id`,
with `NULL` sorting last exactly as unordered rules do today). Everything else
stays in `payload`.

**`outcomes` stays in the payload, and that is precedented rather than lazy.**
`StoredSchedule` already carries an ordered `runs: ScheduleRun[]` as JSON inside
its own payload, and the branch's rule is that a field earns a column only by
being the primary key, a sort key, or an indexed lookup. A rule's outcome list is
none of those: it is read whole, written whole, and never queried across rules. A
child table would be new ground for this repo and buys nothing here.

**`trigger`, `operator` and `outcomes[].kind` stay open TEXT inside the payload —
no `CHECK`, no lookup table.** The foundation declares none anywhere, and this
feature has a stronger reason than convention: a rule naming a trigger this build
does not know is _skipped_, not rejected, so that a rule written by a newer daemon
survives a read by an older one. A `CHECK` constraint would turn that into a write
that fails.

**Seeding, and the one thing the importer must get right.** Today "the directory
exists" is the seeded marker, and an empty directory means somebody deleted every
rule — re-seeding would silently undo them. Under SQL an empty table cannot say
which of those it is, so the `legacy_imports` marker carries that distinction:

- Rules directory absent — a genuinely fresh install. Seed the defaults, write the
  marker.
- Rules directory present, **including when it is empty** — import what is there,
  even if that is zero rows, and write the marker. Never seed.

The second case is the one a naive importer gets wrong, because zero imported rows
looks like nothing happened. It is not: it is a person who cleared their rules, and
the marker is what stops the next start handing them back.

**Hand-editability is not a goal, and the migration should not preserve it.**
The store reads fresh from disk on every access and polls every 30 seconds, both of
which exist only because a person could edit these files while the daemon runs. That
is not a property this feature is trying to have. So rules migrate exactly as
schedules and push tokens did — one-way import, marker, SQLite as sole authority,
no disk read afterwards — and the fresh-read and the poll go with it rather than
being carried across as a special case.

Two things follow that are easy to miss. The seeded `README.md` currently promises
that "an edit takes effect without a restart", which stops being true at the import
and should be rewritten then, not left to contradict the daemon. And the 30-second
poll with `lastBroadcast` diffing exists to notice changes the daemon did not make;
once nothing else writes, the service already broadcasts on its own writes and the
poll is dead weight.

**Six older field names are stored beside these.** `measurement`, `threshold`, `text`, `disposition`, `action` and a singular `outcome` are what `trigger`, `value`, `value` and `outcomes` were called before v0.3.2. WebSocket schemas are append-only, so the old names were not removed: they stay required and are written as projections of the new ones, and every reader prefers the new. A rule written by either version is therefore read correctly by both.

The three single-outcome fields take the **most severe** entry rather than the first, so a reader that can carry out only one of them carries out the one deciding what happens to the message — a client seeing `warn` where the rule also said `aside` would send what this build would have redirected. `packages/protocol/src/rules/vocabulary.ts` owns both directions and is the only place either name should be read or written; its `COMPAT(ruleVocabulary)` and `COMPAT(ruleOutcomeList)` tags carry the removal dates.

The schema is `.passthrough()`, so a rule written by a newer daemon survives a read by an older one rather than being dropped.

The directory is read fresh on every access and re-listed every 30 seconds, with a broadcast only when the content differs. Both properties exist so a person can hand-edit the files while the daemon runs — there is no in-memory copy to go stale, and no `fs.watch`, which establishes successfully and then never fires on a Docker bind mount from macOS. A malformed file costs that one rule and nothing else: rules gate sends, so failing the whole list would turn the gate off silently.

---

## Client-side stores (App)

These live in React Native `AsyncStorage` or browser `IndexedDB`, not on the daemon filesystem.

### Keying convention: directory-backed vs workspace-owned

Right-sidebar client state splits on whether it is determined by the directory or owned by the workspace (two workspaces can share one `cwd`). The split is enforced by the cache key, so changing a key changes the sharing semantics — see [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned) for the full table.

- **Directory-backed** (shared by same-`cwd` workspaces): keyed by `(serverId, cwd)`. Git status/diff, GitHub PR status, PR timeline, file preview content. These are TanStack Query caches, not persisted stores.
- **Workspace-owned** (independent per workspace): keyed by `workspaceId`, with `cwd` used only as a fallback when no `workspaceId` is present. Review draft comments (`@paseo:review-draft-store`), diff-mode overrides (in-memory), workspace composer attachments, and file-explorer nav/expand state. The `workspaceId` part of these keys is **opaque** — never parse it back into a path.

### Draft Store

**AsyncStorage key:** `paseo-drafts` (version 2)

```typescript
{
  drafts: Record<draftKey, {
    input: { text: string, images: AttachmentMetadata[] },
    lifecycle: "active" | "abandoned" | "sent",
    updatedAt: number,     // epoch ms
    version: number        // optimistic concurrency
  }>,
  createModalDraft: DraftRecord | null
}
```

### Attachment Store (Web)

**IndexedDB database:** `paseo-attachment-bytes`, object store: `attachments`

Stores binary attachment blobs keyed by attachment ID.

### AttachmentMetadata

| Field         | Type      | Description                    |
| ------------- | --------- | ------------------------------ |
| `id`          | `string`  | Unique attachment ID           |
| `mimeType`    | `string`  | MIME type                      |
| `storageType` | `string`  | Storage backend identifier     |
| `storageKey`  | `string`  | Key within the storage backend |
| `createdAt`   | `number`  | Epoch ms                       |
| `fileName`    | `string?` | Original filename              |
| `byteSize`    | `number?` | Size in bytes                  |
