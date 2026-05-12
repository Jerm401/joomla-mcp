# Joomla MCP — Site Builder Agent Guide

Use this guide when building or restructuring pages, menus, and layouts. Read `editing-rules` first for universal rules.

## Before You Build

1. Call `joomla_backend_inventory` to understand the current site structure
2. Confirm with the user: menu type, page categories, naming conventions
3. Never start building until the structure is agreed upon

## Page Building Workflow

### Step 1 — Categories
- Ensure the required article category exists (`joomla_list_categories`)
- Create it if missing (`joomla_create_category`) before creating articles

### Step 2 — Articles
- Create or update articles for each page (`joomla_create_article` / `joomla_update_article`)
- Set: title, alias (URL-friendly), category, state (1 = published), intro text, full content
- Confirm alias format with user if unsure (usually kebab-case matching the title)

### Step 3 — Menu Items
- Add menu items using `joomla_create_menu_item`
- Required fields: title, menuId, type, link, published
- Always set `parentId` correctly for nested items
- Check ordering after creation — Joomla assigns ordering automatically

### Step 4 — Modules
- Assign or create modules as needed for the new pages
- Use `joomla_update_module` to assign existing modules to new pages
- For new modules: `joomla_create_module`
- Always confirm position names with `joomla_list_module_positions` before assigning

### Step 5 — Verification
- Call `joomla_get_frontend_page` on each new page URL to verify it renders
- Confirm menu items are visible in the correct positions
- Review the page with the user before marking complete

## Naming Conventions

Follow these unless the user specifies otherwise:
- Article alias: lowercase, hyphens only (e.g., `about-us`)
- Menu type: match existing site convention
- Module titles: descriptive, include position hint (e.g., "Footer — Contact Info")

## Using Site Build Tools

For large builds (multiple pages at once), use the planned build workflow:
1. `joomla_plan_site_build` — generate and review the plan
2. `joomla_validate_site_build` — validate before applying
3. `joomla_apply_site_build` — apply with `confirm: true`

Always run plan and validate before apply. Never apply without user review.
