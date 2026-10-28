# Subagent Router — Agent guide

Give Cindy's subagents a model chain instead of one inherited model.

## What it changes

Two things, both decided by the model groups saved in the plugin:

1. **Default model fill.** When the main agent calls Cindy's built-in `subagent`
   tool without `model`, the extension fills in the first model of the default
   group (and its `provider`). The main session model is untouched.
2. **`delegate` tool (fallback chain).** Same idea as `subagent`, plus retry:
   it walks the default group's models in order and only moves to the next model
   when the **model/provider layer** fails (model unavailable, 429, 5xx, timeout).
   A task-level failure (tests red, wrong plan) never triggers a switch.

Roles `scout`, `reviewer` and `planner` walk the whole chain. `worker` uses only
the first model, because retrying a write-capable child can apply the same edit
twice.

## Groups

A group has `id`, `name`, `description` and an ordered `models` list. Order is the
fallback order. `defaultGroupId` selects the group used when nothing else is
specified. Group descriptions are meant to describe intent ("default, cheapest",
"complex multi-step work", "flagship, most expensive — only for the hardest
tasks"); picking a group by description is not exposed to the model yet.

## Tools

| Tool | What it does |
| --- | --- |
| `router_status` | Injected?, extension dir, saved groups. Read-only. |
| `router_install` | Write the bundled extension and register it in Cindy's Pi extension settings. Idempotent. |
| `router_uninstall` | Remove the settings entry and delete the extension directory. Idempotent, no residue. |
| `router_config_get` | Return the saved groups. Read-only. |
| `router_config_set` | Replace the whole group configuration. |

## Where files live

- Extension: `<Cindy home>/cindy-extensions/subagent-router/` (`index.js`, `package.json`, `config.json`)
- Registration: `<Cindy home>/pi-package-home/settings.json` → one local-path entry
- The worker finds `<Cindy home>` per platform (`APPDATA`, `~/Library/Application Support`,
  `XDG_CONFIG_HOME`, `~/.config`) and only writes when it finds a real `pi-package-home`.

## After install or save

Extension code is loaded when a **new** task starts. Already-running tasks keep
their current tool set, so a freshly installed chain applies from the next task.

## Failure modes

| Symptom | Cause / fix |
| --- | --- |
| `CINDY_HOME_NOT_FOUND` | Cindy data directory not found; open the settings page once so the plugin can see it. |
| Chain never used | `defaultGroupId` points at an empty or missing group, or the group has no models. |
| `delegate: no model configured` | Save at least one model in the default group. |
| Extension present but nothing changes | Task started before install; open a new task. |
