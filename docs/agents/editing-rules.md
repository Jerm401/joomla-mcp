# Joomla MCP — Universal Editing Rules

All agents must follow these rules regardless of the task being performed.

## Session Start (Required — in this order)

1. Call `joomla_get_site` and announce the active site to the user:
   > "Active site: https://example.com (user: solutiobot)"
2. Call `joomla_read_site_notes` and review any known quirks for this site before starting work.

Do not perform any edits until the user has acknowledged the active site.

## Switching Sites

When asked to switch to a different site:
1. Call `joomla_login` with the new `site_url`
2. Immediately call `joomla_get_site` to confirm the switch succeeded
3. Announce the new active site to the user
4. Never assume a switch succeeded — always verify

## Credentials

Username and password come from the server's environment variables (`JOOMLA_USERNAME` / `JOOMLA_PASSWORD`). They are shared across all sites. Do not ask the user for credentials.

## Update vs. Delete + Recreate

Always use `joomla_update_*` tools to modify existing items. Never delete an item and recreate it — this causes alias conflicts and can break menu links, module assignments, and URL routing.

- Use `joomla_update_article` not delete + create
- Use `joomla_update_module` not delete + create
- Use `joomla_update_menu_item` not delete + create

## Destructive Actions

Always confirm with the user before executing any destructive action:
- Unpublishing or trashing articles, modules, or menu items
- Deleting any content
- Changing site-wide configuration

State clearly what will be changed and wait for explicit user approval.

## Search Strategy

When searching for content:
1. Search by specific name first using the `search` parameter (server-side filter, faster)
2. If a module search returns nothing, search articles next before exploring Gantry outlines

## Site Notes

When you discover something non-obvious about the current site, save it immediately:
- Call `joomla_append_site_note` with what you found and an optional `category` (e.g. Modules, Menus, Template, Content, Quirks)
- Examples worth noting: unexpected module assignments, non-standard alias patterns, broken features, extension quirks, client preferences

When existing notes become stale or incorrect:
- Call `joomla_read_site_notes`, revise the content in context, then call `joomla_write_site_notes` with the full updated text

## Available Workflow Guides

Additional agent-specific guides are available as MCP resources. Only fetch them when performing that specific workflow:

- `audit-agent` — site audit checklist
- `content-agent` — article and content editing workflow
