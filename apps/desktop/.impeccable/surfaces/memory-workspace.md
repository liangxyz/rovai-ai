---
version: 4
slug: "memory-workspace"
primary_target: "apps/desktop/src/renderer/src/MemoryLibrary.tsx"
related_targets:
  - "apps/desktop/src/renderer/src/memory-workspace.css"
  - "apps/desktop/src/renderer/src/MemoryChangeNotice.tsx"
---

# Memory workspace surface brief

## User goal and first view

Read and manage durable memories with minimal scanning effort. Preserve the shared App rail and typography.
The header has the title, “查看、搜索和管理长期记忆。” subtitle, review/history entry, and neutral primary Add action.
Three quiet inline counts show active memories, active agent-origin memories, and memories due for review.
Loading counts use a dash. A compact dismissible change notice remains visible on the Memory page and in the Thread.
No capacity meters or separate lifecycle/source filter row is shown.

Use the achromatic `--memory-*` family in both themes. Add and Revise use dark neutral primary actions in day and
inverse light actions at night. Amber means attention; red means error or permanent forgetting. Do not add blue
selection, badges, borders or decoration. The shared sidebar uses the Memory neutral rail variant while this route is active; its pending dot is vertically centered.

## Scope, search and workbench

Tabs are All / Shared / Member / Between members, defaulting to All. Tabs and search narrow the authoritative list;
legacy navigation filters must not invisibly narrow it. Active and retired records remain available; forgotten content
never returns. Search includes complete content, keys, owner, kind and source. Mobile starts with the list and preserves
explicit Back navigation rather than auto-selecting a row.

The desktop list/detail split shows one-line list previews, owner/type and only exceptional due/stopped badges.
The detail shows complete body and retrieval keys. Owner/type, Revise and the SVG overflow action are aligned in one
header. Retire, schedule and permanent Forget are in that menu. Source, update time, next review and version are folded
under “详情与版本”; revision history and each revision can expand independently. Full text remains available.

## Notices and Hearth review

Automatic notices distinguish creation from revision and count changed identities, not repeated events. Missing scope
must remain generic until the authoritative record resolves it; never default an unknown revision to Shared. Dismissal
survives a late lookup. View selects the actual changed memory. Pending review remains a distinct notice and persistent
header/rail entry; after resolution the header exposes Review history.

Candidate content is not active memory. The dedicated drawer shows content, source, requested action and target/base.
Fresh items support accept, edit then accept, or reject. Stale revise items support reject only and explain the changed
target. Dismissing changes no domain state. Accepted, rejected and invalidated items are body-free history; never
reconstruct cleared content or describe invalidation as a user rejection.

## Editing and concurrency

Creation chooses scope/type/participants; revision shows immutable identity as quiet context. Body and key chips are
editable, with byte limits and validation retained. Show counters near their limit and errors where the edit happens.
Cancel/reopen retains an unsubmitted draft for that identity; success clears only that draft. Commands keep expected
versions and exact base Revision. On conflict, retain draft, refresh authority and require explicit retry; never silently
merge. Review scheduling retains its authority-unknown and applied-but-refresh-failed recovery. Forget requires explicit
danger confirmation. Renderer success follows Core, not optimistic presentation.

## Inheritance and validation

Inherit [`DESIGN.md`](../../../../DESIGN.md), theme contracts and the
[accessibility baseline](../../../../docs/ui/qa/accessibility.md). This brief owns presentation only; Memory scope,
authority, review policy, capacities, persistence and concurrency remain in current Contracts and Core.
`pnpm test:memory-workspace-ui` exercises production components with an isolated transport fixture. Real SQLite,
restart, scheduling conflicts and permanent erasure remain covered by `pnpm accept:memory-ui` against an isolated App.
