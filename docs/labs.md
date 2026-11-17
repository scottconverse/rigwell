# Labs

Settings > Labs manages the current local profile's `features` map. Registered flags accept booleans only; unknown IDs or invalid values reject the entire settings write. Managed settings retain precedence. Repository settings cannot override this map. Saving or refreshing does not start an agent or call a model.

| ID | Behavior |
| --- | --- |
| `script_subagents` | Enables Task inside Script for new or resumed session engines. Existing Task permission, depth and budget limits remain. |
| `nested_workstreams` | Enables nested member controls for newly approved Workstreams. Existing member tool ceilings, approved stream settings, policy and depth limits remain. Disabling also blocks new nested controls in existing streams. |

Both default off. For compatibility, an explicit earlier `allowSubagentsInScripts` or `workstreams.allowNestedSpawn` opt-in applies only when its map entry is absent. An explicit false overrides those opt-ins, including saved session settings. Use default removes the map entry and restores that compatibility behavior. The page shows the effective global configuration and its source; a legacy repository or session opt-in can differ until explicitly overridden here.

Script settings are captured when an engine is built, so restart or resume that engine after changing the flag. Enabling nested controls does not broaden an existing Workstream approval. Disabling is checked when new nested controls are offered or called; it does not cancel work already running. Shipped core features and selected models/providers remain independent of Labs.

Checkboxes show the requested value while saving, then the effective configuration, including managed overrides. Failed saves display an error and restore the effective value. Fake-provider engine tests and a headless production page connected to a real local daemon cover execution gates, legacy precedence, policy, live nested revocation, save, reset and failure recovery. No live provider or installed visible-app acceptance is claimed.
