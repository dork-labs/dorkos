# Design decisions

Visual companion session: `.dork/visual-companion/78105-1791986881/` in the integration checkout.

## Panel structure

Screen: `panel-directions.html`. A: relevant tabs and + menu. B: one view switcher. C: compact icon rail. Human selected A: “relevant tabs and a + menu, with one header row for concrete resources.”

## Refinement

Screen: `relevant-tabs-refined.html`. Profile/Files start the agent view; Computer joins for its bound agent. Resource names replace category rows. + contains eligible views and concrete resources, reaches overflow, and offers creation. Close hides a view; stopping stays explicit. Views restore per context. Human authorized refinement followed by implementation without another design gate.

## Computer PiP

PiP pins the original computer across chats. The panel offers Bring back. Transfer/close returns control, does not stop the guest/task, and never takes control automatically. Capture and ordered input live in one shared session. Phone uses the sheet/mini-bar and releases control when minimized. Disconnected/stopped/restarted states never label a stale image live.

## Source constraints

Personal installed app and guest remain untouched; no paid inference or broad process/guest operations. Doc and runtime/MVP owners are coordinated separately.

## Mobile and larger-system review

The human requested excellent mobile-browser behavior and explicit consideration of mini-apps and system edge cases. Panel/PiP sheets follow the visual viewport's height and offset while the keyboard opens or the browser pans focus, respect safe areas, and preserve pinch zoom. Header/menu controls reach 44px below desktop width. PiP peek has a scroll area matching its visible height. Returning from desktop to phone retains the existing minimized rotation behavior. Browser navigation has thumb-sized controls and a full-width address field on small screens.

Mini-app route, transport and declared/saved placement gates stay authoritative. + reopens local views without changing shared placement; placement options remain in the mini-app menu. Open full page dismisses the overlay panel. Resource identity cannot collide with a mini-app namespace. Closing the final view clears selection so reload keeps it closed. Unloading an active mini-app falls back to an available built-in view. Retained terminal errors stay isolated from the active document or computer presenter.

Late control/input replies are fenced to their original acquisition or lease. They cannot revoke a later takeover or mark its healthy frame disconnected. Review findings and regression tests cover these races.

Document view choices follow the owning conversation and directory. Temporary document IDs and draft conversation IDs can change while a view is closed; document identity and its local closure transfer atomically. A new conversation has its own choices, and explicitly opening a closed resource still brings it back.

Document save receipts keep their original conversation and directory until they settle, even after navigation. Offscreen settlement transfers the exact closed-tab identity without populating another conversation’s table. Canonical conversation changes and explicit directory resolution migrate that ownership. Each request cleans up only its own receipt; another write to the same pending document cannot erase it.
