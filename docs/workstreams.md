# Workstreams

A Workstream is a persistent coordination scope with a lead, reusable member
sessions, messages, event listeners and optional isolated Git worktrees. It is
separate from a staged Mission. Open **Workstreams** in the desktop sidebar;
ask a lead session to propose a goal before starting members. The TUI also has
a Workstreams view; `/help` lists its commands.

## Proposal and file ownership

State the goal, acceptance checks, model profiles, roles, file ownership,
budget and integration checkpoint. Review **Accept workstream**, **Edit plan
and accept** or **Reject** in the proposal panel. Approval creates the scope;
it does not authorize every command, remote push or cleanup operation.

Give each member an explicit task and its own worktree when changes must stay
isolated. Separate persistent sessions can use the same profile. Use actual
messages to pass interface contracts and require acknowledgement before
implementation. Have a verifier run independent checks and route findings to
the responsible member. Review branches before copying or merging work.

## Desktop controls

| Control | Behavior |
| --- | --- |
| Open lead | Returns to the coordinating session |
| Open transcript | Opens that member's saved/live session |
| Message | Sends direction to the selected member |
| Now | Interrupts the current turn to deliver direction |
| Next | Offers direction at the next loop boundary |
| Later | Queues direction until idle |
| Interrupt | Stops the member's active turn; already edited files remain |
| Pause | Pauses the Workstream's execution |
| Resume | Reviews token, estimated-cost and wall-time limits before resuming |
| Archive member/workstream | Stops execution and retains history |
| Remove safe worktrees | Optional archive cleanup; dirty work, local commits and open PRs are retained |

The roster shows member identity, state and usage. Messages distinguish
**Queued**, **Delivered** and **Read**; a queued message is not proof a member
has acted on it. **Waiting for your answer** displays member questions and
permissions independently of the lead's turn. Review the full operation before
answering. [Notifications](workstream-notifications.md) and Inbox help locate
attention, but do not approve anything on your behalf.

## Limits and recovery

Token totals can include repeated cached input. Cost remains unpriced when the
profile has no price data; an absent or zero estimate is not a measured cash
charge. A reached budget pauses work. Only the user can change a budget or
resume after that pause; a still-reached limit must be raised or removed.

In **0.4.1**, a pending proposal reappears after reconnecting the view to its
still-live daemon Session. Open that same saved session and answer the restored
prompt. Cancellation or resolution invalidates late answers. Do not create a
duplicate Workstream just because a view disconnected.

A daemon restart is different: interrupted members are recovered and can
require an explicit user resume. Inspect states, transcripts and worktrees
before resuming. Workstream state, roster, messages and listener information
are stored under the selected Rigwell home; the Git worktrees remain ordinary
repositories. A profile backup does not include those repositories or external
credential stores automatically.

Both supported subscription clients use Rigwell's coordination bridge while
retaining their native coding tools. In 0.4.1 their coordination receipts are
included in subsequent native invocations. Claude's unresolved native approval
requests reach Rigwell's permission panel; native deny rules still apply. See
[authentication](auth.md) for execution boundaries and [0.4.1 release notes](release-0.4.1.md)
for installed verification and limits.
