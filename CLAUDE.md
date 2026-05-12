# Joomla MCP — Claude Code Instructions

## Site Verification (Required)

At the start of every conversation, call `joomla_get_site` and announce the result to the user before doing anything else:

> "Active site: https://example.com (user: solutiobot)"

Do not perform any edits until the user acknowledges the active site.

## Switching Sites

1. Call `joomla_login` with the new `site_url`
2. Immediately call `joomla_get_site` to confirm the switch
3. Announce the new active site — never assume a switch succeeded

## Universal Editing Rules

Read the `editing-rules` MCP resource at the start of every session. It contains conventions all agents must follow. To read it, use `resources/read` with URI `joomla-docs://agents/editing-rules.md`.

## Specialized Workflow Guides

Additional workflow docs are available as MCP resources. Only read these when explicitly performing that workflow — do not load them by default:

- `joomla-docs://agents/audit-agent.md` — site audit checklist and approach
- `joomla-docs://agents/builder-agent.md` — page and menu building workflow
- `joomla-docs://agents/content-agent.md` — article and content editing workflow

To list all available guides: `resources/list`

## Credentials

Credentials come from the server's environment variables. Do not ask the user for them.

## Adding New Workflow Guides

Create a new `.md` file in `docs/agents/` — the MCP server discovers all `.md` files in that folder automatically. No server code changes needed.
