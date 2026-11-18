# Workstreams

A Workstream is a persistent coordination scope with a lead, reusable member
sessions, messages, event listeners and optional isolated Git worktrees. It is
separate from a staged Mission. Open **Workstreams** in the desktop sidebar;
ask a lead session to propose a goal before starting members. The TUI also has
a Workstreams view; `/help` lists its commands.

## Proposal and file ownership

[Check the lead's profile and reasoning effort](user-manual.md#check-your-session-profile-and-effort) before requesting a proposal. Review the member profiles and worktree assignments before approval.

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

The roster shows member identity, state and usage. For **Next** handoffs to
agents, the timeline distinguishes **Queued**, **In session transcript**,
and **Submitted to native client**. Submission means the handoff body was
attached to a coordination response or sent in the native client's input.
Ask the member to acknowledge the contract to confirm it acted on the handoff.
Other message priorities retain their delivery and read indicators. **Waiting for your answer** displays member questions and
permissions independently of the lead's turn. Review the full operation before
answering. [Notifications](workstream-notifications.md) and Inbox help locate
attention, but do not approve anything on your behalf.

## Limits and recovery

When a replacement cap is still too low, the Resume dialog keeps your edits
and reports that the saved budget stayed the same and that the Workstream is paused. An accepted edit saves the
replacement budget and resumes the Workstream.

Starting with Windows 0.4.2, a signed-in client's next successful Rigwell coordination
tool response carries any waiting Next handoffs and listener reminders.
For example, a lead waiting in `WaitForEvents` receives the message body
with the event. If the client only uses its own tools, Rigwell hands off the
message after that native invocation returns. The first pending Next message can start the next invocation. Remaining Next messages can join its next Rigwell coordination response. The bridge cannot insert
messages between calls that the signed-in client makes internally.

### Known 0.4.1 message-delivery issue

A live Windows walkthrough reproduced a subscription-client handoff issue:
**Next** messages can wake a native session with listener metadata but without
the message body in its model context. A **Delivered** label does not establish
that the model received or acted on that body. Repeated acknowledgments can
consume the token budget without advancing the task. **Now** messages delivered
the bodies in the observed run, but interrupt the active turn and are only a
temporary recovery option. Upgrade Windows to [0.4.2](release-0.4.2.md) for the fix.

If members repeatedly request the same contract, pause the Workstream and
inspect its messages and transcripts. Preserve worktrees; do not start duplicate
members or treat the missing acknowledgment as approval.

Starting with Windows 0.4.3, if a direct model reaches its output limit without a
tool call, Rigwell gives it one recovery prompt to take the next concrete
action. A second cap before a tool call marks the member turn failed with
`model_output_limit`. Leads waiting for a review can listen for
`agent_failed` as well as incoming messages.

Token totals can include repeated cached input. Cost remains unpriced when the
profile has no price data; an absent or zero estimate is not a measured cash
charge. A reached budget pauses work. Only the user can change a budget or
resume after that pause; a still-reached limit must be raised or removed.

Since **0.4.1**, a pending proposal reappears after reconnecting the view to its
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
retaining their native coding tools. Since 0.4.1 their coordination receipts have been
included in subsequent native invocations. Claude's unresolved native approval
requests reach Rigwell's permission panel; native deny rules still apply. See
[authentication](auth.md) for execution boundaries and [0.4.2 release notes](release-0.4.2.md)
for installed verification and limits.
