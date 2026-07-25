# Lessons

## Verify data-driven UI against realistic data, not empty state

**Context:** Built the `/projects/roadmap` Gantt. Typecheck passed, page returned 200,
screenshots looked "fine" — but every existing task had `due_date = NULL`, so the chart
only ever rendered its empty state. Shipped it as done. The user's first look: "I did not
see gantt chart."

**Rule:** For any chart, timeline, or aggregate view, seed a realistic fixture (nested,
dated, mixed statuses) and *look at the rendered result* before claiming completion. An
empty-state screenshot is not evidence the feature works. Delete the fixture afterward.

## A Gantt's label pane and chart pane must share one scroll container

**Context:** First version put the task tree in one `ResizablePanel` and the chart in
another. Each rendered its own independently-ordered list, so row N on the left did not
correspond to row N on the right — the core invariant of a Gantt was broken, and it would
have silently mis-associated bars with tasks.

**Rule:** Render one row per task in a single scrolling container; pin the label column
with `position: sticky; left: 0` and the date axis with `sticky top: 0`. Never
synchronize two independent scroll areas.

## Passing `className` to a shadcn component can delete its responsive defaults

**Context:** `<DialogContent className="max-w-lg">` — tailwind-merge saw `max-w-lg` as the
same utility family as the base component's `max-w-[calc(100%-2rem)]` and dropped it, so
the dialog stopped clamping to the viewport on narrow windows and its fields overflowed
off-screen ("the panel is out of order").

**Rule:** Before overriding a shadcn primitive's class, read its base `cn(...)` string.
Match the breakpoint prefix (`sm:max-w-lg`, not `max-w-lg`) so you extend the defaults
instead of replacing them. Separately: any flex/grid child holding unbounded text needs
`min-w-0` (CSS defaults to `min-width: auto`), or its intrinsic width pushes the whole
container wider than its parent.

## Don't restart the stdio MCP server mid-session to test a change

**Context:** `openmemory-mcp` is this session's own tool provider. Killing it to load a
rebuilt binary does not respawn it, and the task-tracking tools go away for the rest of
the session.

**Rule:** Compile-verify MCP-side changes, exercise the equivalent logic over the HTTP API
instead, and hand the restart back to the user.
