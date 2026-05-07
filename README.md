# Joomla 3 MCP Server

MCP server for automating Joomla 3 administrator workflows through the same HTML forms the backend uses.

This project is designed for safe, repeatable site operations: content updates, menu/module management, Gantry layout automation, component inspection, snapshots, and site build planning.

## How It Works

- Uses Joomla admin pages and form submissions (not direct database writes).
- Maintains authenticated cookies/sessions after login.
- Extracts and submits CSRF tokens and preserves existing form fields.
- Supports dry-run/snapshot workflows on higher-risk operations.
- Returns structured JSON responses with success/message and operation data.

## Configuration

Create a `.env` file:

```env
JOOMLA_BASE_URL=https://your-site.example
JOOMLA_USERNAME=your-admin-username
JOOMLA_PASSWORD=your-admin-password
```

`JOOMLA_BASE_URL` can be either:

```env
JOOMLA_BASE_URL=https://your-site.example
JOOMLA_BASE_URL=https://your-site.example/administrator
```

## Build and Run

```sh
npm install
npm run build
```

Run server (stdio):

```sh
npm start
```

Smoke check:

```sh
npm run smoke
```

All-tools integration test:

```sh
npm run test:all-tools
```

For MCP clients, use:

```sh
node dist/index.js
```

## Tool Catalog

The server currently exposes the following tools.

### Session

- `joomla_login`: Authenticate to Joomla admin and initialize server session.

### Articles

- `joomla_list_articles`
- `joomla_get_article`
- `joomla_create_article`
- `joomla_update_article`
- `joomla_delete_article` (trash)
- `joomla_checkin_article`

### Categories

- `joomla_list_categories`
- `joomla_get_category`
- `joomla_create_category`
- `joomla_update_category`
- `joomla_delete_category` (trash)
- `joomla_checkin_category`

### Modules

- `joomla_list_modules`
- `joomla_list_module_types`
- `joomla_list_module_positions`
- `joomla_inspect_module_type`
- `joomla_get_module`
- `joomla_export_module_blueprint`
- `joomla_import_module_blueprint`
- `joomla_create_module`
- `joomla_update_module`
- `joomla_delete_module` (trash)
- `joomla_toggle_module` (publish/unpublish)
- `joomla_checkin_module`

### Gantry Particle Modules

- `joomla_list_gantry_particle_types`
- `joomla_inspect_gantry_particle`
- `joomla_get_gantry_particle_module`
- `joomla_create_gantry_particle_module`
- `joomla_update_gantry_particle_module`

### Menus and Menu Items

- `joomla_list_menus`
- `joomla_create_menu`
- `joomla_list_menu_items`
- `joomla_list_menu_item_types`
- `joomla_inspect_menu_item_type`
- `joomla_get_menu_item`
- `joomla_create_menu_item`
- `joomla_update_menu_item`
- `joomla_delete_menu_item` (trash)
- `joomla_toggle_menu_item` (publish/unpublish)
- `joomla_checkin_menu_item`

### Gantry 5 Layout and Outline Operations

- `joomla_gantry5_list_outlines`
- `joomla_gantry5_get_layout`
- `joomla_gantry5_get_page_settings`
- `joomla_gantry5_get_particle_defaults`
- `joomla_gantry5_inspect_particle_type`
- `joomla_gantry5_update_particle_instance`
- `joomla_gantry5_update_node_attributes`
- `joomla_gantry5_save_layout_raw`
- `joomla_gantry5_diff_layout`
- `joomla_gantry5_move_node`
- `joomla_gantry5_add_particle_instance`
- `joomla_gantry5_delete_node`

### Admin Introspection and Generic Form Automation

- `joomla_backend_inventory`
- `joomla_inspect_admin_form`
- `joomla_inspect_admin_list`
- `joomla_submit_admin_form`
- `joomla_page_content`

### Snapshot and Restore

- `joomla_snapshot_target`
- `joomla_restore_snapshot`

### Site Build Planning and Validation

- `joomla_plan_site_build`
- `joomla_apply_site_build`
- `joomla_validate_site_build`
- `joomla_launch_checklist`

### Component and Extension Coverage (Current)

- `joomla_component_inspect`
- `joomla_media_list`
- `joomla_media_create_folder`
- `joomla_sponsors_list`
- `joomla_sponsor_inspect`
- `joomla_docman_list_documents`
- `joomla_fileman_list_files`
- `joomla_redirects_list`
- `joomla_site_config_inspect`
- `joomla_subsites_list`

## Operational Notes

- Many destructive operations are implemented as trash-first actions.
- Gantry live-save workflows are guarded with snapshot/dry-run expectations in key flows.
- Recent write/check-in operations are returning standardized operation payload fields like:
  - `id`, `title`, `state`, `editUrl`, `viewUrl`, `warnings`, `verification`

## Roadmap

For phased capability expansion and priorities, see [docs/JOOMLA_MCP_ROADMAP.md](docs/JOOMLA_MCP_ROADMAP.md).

## Repository Structure

- `src/`: MCP server source code.
- `dist/`: compiled server output.
- `scripts/`: operational and development scripts grouped by purpose:
  - `scripts/tests/`
  - `scripts/build/`
  - `scripts/menu/`
  - `scripts/content/`
  - `scripts/debug/`
  - `scripts/manual/`
  - `scripts/probes/`
- `blueprints/`: Gantry and module blueprint YAML files.
- `blueprints/layouts/`: saved Gantry base layout JSON exports.
- `docs/`: process and roadmap documentation.
- `snapshots/`: captured Joomla/Gantry snapshots used for diff/restore workflows.
- `site-build-prompt-server/`: standalone MCP prompt/spec helper server.
