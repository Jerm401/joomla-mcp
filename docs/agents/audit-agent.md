# Joomla MCP — Site Audit Agent Guide

Use this guide when performing a site audit. Read `editing-rules` first for universal rules.

## Audit Scope

A standard site audit covers:
1. Content completeness and quality
2. SEO metadata
3. Navigation and menu structure
4. Module placement and status
5. Media and broken references
6. Site configuration

## Audit Checklist

### 1. Site Overview
- Call `joomla_backend_inventory` to get a broad picture of the site structure
- Note the number of articles, modules, menus, and categories
- Identify any obvious structural problems

### 2. Content Audit
- Call `joomla_list_articles` and review for:
  - Unpublished articles that should be live (state = 0)
  - Articles missing a category (uncategorized)
  - Articles with no intro text or very short content
  - Duplicate titles
- Flag each issue with: item title, ID, and recommended action

### 3. SEO Metadata
For articles flagged during content audit, call `joomla_get_article` and check:
- Meta description present and under 160 characters
- Title tag not duplicated
- Alias is URL-friendly (no uppercase, no spaces)

### 4. Menu Structure
- Call `joomla_list_menus` to identify all menus
- For each menu, call `joomla_list_menu_items` and check:
  - No unpublished items that should be visible
  - No orphaned items (parent deleted but children remain)
  - Home menu item is set correctly

### 5. Module Review
- Call `joomla_list_modules` and check:
  - No modules published to wrong positions
  - No duplicate modules doing the same job
  - Modules with no page assignments (assigned = none)

### 6. Site Configuration
- Call `joomla_site_config_inspect` and note:
  - Site name and metadata settings
  - Whether caching is configured appropriately
  - Debug mode is OFF (should be off on live sites)

## Reporting Format

Present findings as a prioritized list:

**Critical** — broken functionality or missing required content
**Warning** — content gaps or configuration issues that should be addressed
**Info** — suggestions for improvement

For each finding include: location (title + ID), issue description, and recommended action.

## After the Audit

Do not make changes during an audit unless the user explicitly asks. Present the full report first, then wait for instruction on which items to fix.
