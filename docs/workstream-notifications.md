# Workstream notifications

The connected desktop and TUI report members needing input, members that failed and Workstream budget limits. These use the existing needs-input notification and awaiting-input sound settings. A duplicate status or matching prompt does not produce another alert. Returning to a normal member state resolves its alert; resuming or archiving clears budget attention so a later limit can alert again.

Desktop notifications route to the Workstream. Each member and the budget have their own replacement tag; resolution closes that same tag. The app badge counts distinct Workstreams with outstanding attention. Losing the last daemon connection clears stale Workstream badges and toasts, and a reconnected status can alert again. Closing one of several views retains the shared attention. Focus and cancellation suppression retain the existing notification policy.

The TUI writes a short transcript notice and requests the existing awaiting-input sound even when the Workstreams overlay is closed. An open overlay still refreshes. Prompt panels remain answerable and independent of the lead turn. Inbox history and optional email delivery use their existing category handling.

Automated checks cover pure category transitions, both prompt/status arrival orders, actual broker message routing and disconnects, settings/focus suppression and real-daemon Workstream/TUI behavior. These checks do not establish OS toast display or sound playback on real macOS or Windows hardware; those remain release acceptance.

For daily controls and proposal reattachment, see [Workstreams](workstreams.md). Historical Windows native notification/tray handling evidence and remaining real-Mac limits are recorded in [hardware acceptance](hardware-acceptance.md); the 0.4.1 Halo installation was verified headlessly.
