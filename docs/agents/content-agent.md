# Joomla MCP — Content Agent Guide

Use this guide when editing, writing, or reviewing article content. Read `editing-rules` first for universal rules.

## Content Editing Workflow

### Finding Content
- Use `joomla_list_articles` with the `search` parameter to find articles by name
- Use `joomla_get_article` to fetch full content before editing
- Always read the existing content before proposing changes

### Editing Articles
- Use `joomla_update_article` — never delete and recreate
- Required fields to preserve unless changing: `title`, `alias`, `categoryId`, `state`
- Only pass fields you intend to change; unset fields are left as-is

### Content Standards
Confirm with the user before writing if unsure about:
- Brand voice and tone
- Article length expectations
- Image and media requirements
- SEO keyword targets

### SEO Fields
When updating content, also check and update:
- Meta description (under 160 characters, summarizes the page)
- Title tag (if different from the article title)
- Alias (URL slug — only change if the article is new or not yet indexed)

**Do not change the alias of a published article without explicit user approval** — it will change the URL and break existing links.

### Publishing
- Set `state: "1"` to publish, `state: "0"` to unpublish
- Always confirm the intended publish state with the user before saving
- For drafts: save as unpublished (`state: "0"`) and notify the user

## Batch Content Work

When updating multiple articles:
1. List all targets with `joomla_list_articles` first
2. Present the list to the user for confirmation before making any changes
3. Update one at a time and report progress after each

## Content That Requires Care

Always flag to the user and wait for confirmation before:
- Changing an article's category
- Modifying the alias of a published article
- Unpublishing or trashing any content
- Deleting content of any kind
