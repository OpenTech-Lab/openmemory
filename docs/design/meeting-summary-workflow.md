# Meeting Summary Workflow (Slice 1)

**Scope.** This is the minimal, provider-agnostic recipe: **transcript-in → summarize → save**,
built as one reusable `workflow` definition on top of existing primitives. It does **not**
capture audio, store media/blobs, stream or transcribe in real time, do speaker diarization,
touch a calendar, or run a background job queue. It does not pick a meeting tool or
transcription provider for you — none is decided. You configure the two provider-specific
pieces (where the transcript lives, and the credential to fetch it) for whatever tool you
already use (Zoom, Otter, Fireflies, Granola, a self-hosted recorder, etc.).

## Privacy — read this first

A meeting transcript is sensitive content. Running this workflow sends the transcript text to
whatever LLM provider is configured for **agent** workflow steps (i.e. the same model backing
your MCP host/agent). This is a deliberate exception to OpenMemory's "data stays local by
default" posture, and it only happens because you explicitly created and ran this workflow.
Don't wire this up for meetings that shouldn't leave your infrastructure without checking
with whoever owns that data.

## The pattern

A workflow definition (`workflows` table, `apps/server/src/workflows.rs`) is a `name` +
`input_schema` + an ordered array of `steps`, each either kind `http` (executes server-side,
credentials never reach the agent) or kind `agent` (the run pauses, returns a typed
`action_required` to the calling agent, and resumes via `workflow_continue`). See
`docs/design/primitives.md` ("Workflows" section) for the full primitive reference.

This recipe uses exactly two steps:

1. **`http` step — fetch the transcript.** A GET/POST to wherever your meeting tool exposes
   the transcript (a REST endpoint, a signed URL, etc.), authenticated with a credential you
   stored once via `env_set` (`is_secret: true`). The server resolves the secret and injects
   it — the agent, and this workflow's own JSON definition, never see the raw value
   (`execute_http_step`, `apps/server/src/workflows.rs:471-517`).

2. **`agent` step — summarize and save.** The run pauses and hands the calling agent an
   `action_required` containing the rendered instruction (with the fetched transcript already
   substituted in via `{{steps.<id>.body...}}` templating) and an `expected_output` contract.
   The agent reads the transcript, writes a summary, saves it with `project_task_note_create`
   and/or `memory_save`, and calls `workflow_continue` with the structured result to complete
   the run.

Agent steps only request one of three fixed capabilities — `image_generation`, `skill`, or
`command` (`validate_definition`, `apps/server/src/workflows.rs:214-227`; confirmed in
`docs/design/primitives.md:280`). Nothing about the transcript triggers a shell command or
touches an actual skill file — `capability: "skill"` here is just the closest of the three
fixed buckets for "the host agent performs a described task using its own reasoning and
tools," which is exactly what summarizing-and-saving needs. `skill` is a free-text label
(not validated against a real skill registry — confirmed by grep: `dispatch.rs` never reads
the `capability`/`skill` fields, it only forwards them in `AgentAction`), so it's there to
describe intent to whichever agent resumes the run, not to invoke a specific file.

## One-time setup

Store the meeting tool's credential (skip this if the transcript endpoint needs no auth, e.g.
a pre-authenticated signed URL your tool already gives you):

```
env_set(key="MEETING_TOOL_API_KEY", value="<token>", is_secret=true,
        description="Read access to <your tool>'s transcript export API")
```

## Workflow definition

Workflows are created via the REST API (`POST /workflows`, `apps/server/src/main.rs:1647`,
handler `create_workflow` at `apps/server/src/main.rs:404-414`) — there is currently no MCP
tool for authoring a workflow, only for listing/running one (`workflow_list`, `workflow_get`,
`workflow_run`, `workflow_continue`). The request body is `WorkflowPayload`
(`apps/server/src/main.rs:374-382`): `name`, `description`, `input_schema`, `steps`, `enabled`.

```bash
TOKEN=$(tr -d '[:space:]' < ~/.openmemory/api_token)
BASE="${OPENMEMORY_URL:-http://localhost:18080}"

curl -s -X POST "$BASE/workflows" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "summarize_meeting",
    "description": "Fetch a meeting transcript and save an AI-generated summary as a task note and/or memory.",
    "input_schema": {
      "transcript_url": {"type": "text", "required": true},
      "project_id": {"type": "text", "required": false},
      "task_id": {"type": "text", "required": false}
    },
    "steps": [
      {
        "id": "fetch_transcript",
        "kind": "http",
        "method": "GET",
        "url": "{{input.transcript_url}}",
        "auth_key": "MEETING_TOOL_API_KEY",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer "
      },
      {
        "id": "summarize",
        "kind": "agent",
        "capability": "skill",
        "skill": "meeting-summary",
        "required_inputs": ["project_id", "task_id"],
        "instruction": "Summarize this meeting transcript into key decisions, action items (with owners if named), and open questions. Transcript:\n\n{{steps.fetch_transcript.body}}\n\nSave the summary with project_task_note_create (project_id={{input.project_id}}, task_id={{input.task_id}}, note_type=message) and, if it contains anything worth recalling outside this task, also with memory_save.",
        "expected_output": "JSON object: {\"summary\": \"<the summary text>\", \"note_id\": \"<id returned by project_task_note_create>\", \"memory_id\": \"<id returned by memory_save, or null>\"}"
      }
    ],
    "enabled": true
  }' | jq .
```

Notes on the shape above, grounded against `apps/server/src/workflows.rs`:
- `input_schema` entries follow the typed shape validated in `validate_input`
  (`apps/server/src/workflows.rs:225-283`): `type` one of `any` / `text` / `string` / `json` /
  `object` / `number` / `boolean` / `image` / `pdf` / `file`, plus an optional `required` flag.
- `auth_key` names an `env_params` row set via `env_set` — the same secret store `env_set`
  writes to and `env_http_request` reads from; a workflow's `http` step auth is not a separate
  mechanism.
- If your transcript endpoint needs no auth, drop `auth_key`/`auth_header`/`auth_prefix`
  entirely — `execute_http_step` only injects a credential when `auth_key` is present and
  non-empty.
- Every `{{input.x}}` / `{{steps.id.path}}` token is resolved by `render_string`
  (`apps/server/src/workflows.rs:392-412`) before the HTTP request or agent instruction is
  built — this is real template syntax the engine executes, not documentation shorthand.
- `capability: "skill"` requires a non-empty `skill` field (`validate_definition`,
  `apps/server/src/workflows.rs:214-224`); it is otherwise free text.
- `required_inputs` paths are bare keys into the workflow's `input` object (e.g.
  `"project_id"`), *not* prefixed with `input.` — that prefix is only used inside `{{...}}`
  template tokens. `render_agent_action` looks them up directly against `input`
  (`apps/server/src/workflows.rs:519-523`).

## Running it

```
workflow_run(id_or_name="summarize_meeting",
             input={"transcript_url": "https://...", "project_id": "<uuid>", "task_id": "<uuid>"})
```

- If step 1 fails (bad URL, 4xx/5xx, non-2xx from the transcript API, or a response over the
  1&nbsp;MB cap), the run's `status` is `failed` and step 2 never runs
  (`apps/server/src/workflows.rs:598-607`).
- On success from step 1, the result comes back with `status: "action_required"` and an
  `action_required` block carrying the rendered `instruction` and `expected_output`. Perform
  exactly that action (read the transcript, summarize, save it), then call:

```
workflow_continue(run_id="<run_id from workflow_run>",
                   result={"summary": "...", "note_id": "...", "memory_id": null})
```

  which finishes the run (`status: "completed"`).

## Where results land

- `project_task_note_list(project_id, task_id)` — the saved summary note, if you saved one.
- `mem search "<meeting topic>"` or `memory_search` — the saved memory, if you saved one.
- `workflow_get`/the `workflow_runs` table keeps the full step history (transcript fetch
  status, the agent's structured result) for audit — runs are not deleted automatically.

## Extending later (explicitly out of scope for this slice)

Audio capture, blob storage, live/streaming transcription, diarization, calendar-triggered
runs, and a background job queue (so this can fire automatically after a meeting ends without
an agent invoking `workflow_run`) are all real, reasonable next steps — none of them are
built here. If you want automatic triggering on a schedule (e.g. "check for new transcripts
every 15 minutes"), see `routine_create`, not this workflow, for the recurring-task piece —
but note routines create tasks, they don't invoke workflows on their own; that gap is unsolved
today.
