import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  InitializeRequestSchema,
  JSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { JoomlaClient, JoomlaResponse } from "./joomla-client.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Load config from environment
const config = {
  baseUrl: process.env.JOOMLA_BASE_URL || "https://example.com/administrator",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
  moduleTypeBlacklist: new Set(
    (process.env.MODULE_TYPE_BLACKLIST || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
};

// Format response for LLM consumption
function formatResult(response: JoomlaResponse): string {
  const result: Record<string, unknown> = {
    success: response.success,
    message: response.message,
  };

  if (response.data !== undefined) {
    result.data = response.data;
    result.dataType = Array.isArray(response.data) ? "array" : typeof response.data;
    if (Array.isArray(response.data)) {
      result.itemCount = response.data.length;
    }
  }

  return JSON.stringify(result, null, 2);
}

function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/administrator\/?$/i, "").replace(/\/+$/, "");
  return u.startsWith("http") ? u : `https://${u}`;
}

function getSiteNotesPath(baseUrl: string): string {
  const hostname = new URL(normalizeUrl(baseUrl)).hostname;
  return path.join(process.cwd(), "docs", "sites", `${hostname}.md`);
}

function buildServer(joomla: JoomlaClient): Server {
  let isLoggedIn = false;

  async function ensureLoggedIn(): Promise<JoomlaResponse> {
    if (isLoggedIn) {
      const stillLoggedIn = await joomla.isLoggedIn();
      if (stillLoggedIn) return { success: true, message: "Already logged in" };
      isLoggedIn = false;
    }

    if (!config.username || !config.password) {
      return {
        success: false,
        message: "Joomla credentials not configured. Set JOOMLA_USERNAME and JOOMLA_PASSWORD in .env file.",
      };
    }

    const result = await joomla.login();
    if (result.success) {
      isLoggedIn = true;
    }
    return result;
  }

  // Create MCP server
  const server = new Server(
  {
    name: "joomla-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Tool definitions
const tools = [
  {
    name: "joomla_login",
    description:
      "Log in to the Joomla admin backend. Optionally provide site_url to target a specific client site — call this first when switching between sites. Server-side credentials (JOOMLA_USERNAME, JOOMLA_PASSWORD) are reused; only the site URL changes per session.",
    inputSchema: {
      type: "object",
      properties: {
        site_url: {
          type: "string",
          description: "Target Joomla site URL (e.g. https://client-site.com or https://client-site.com/administrator). Switches this session to the specified site. Uses JOOMLA_BASE_URL env var if omitted.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_site",
    description:
      "Return the currently active Joomla site URL and username. Call this at the very start of every conversation — before any other action — to confirm which site is being edited. No login required.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_read_site_notes",
    description:
      "Read the notes file for the currently active site. Call this right after joomla_get_site at the start of every session to load known quirks and conventions for this site. No login required.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_append_site_note",
    description:
      "Append a timestamped note to the active site's notes file. Use this during a session when you discover something non-obvious about the site that would be useful to know next time. No login required.",
    inputSchema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "The note to append. Be specific — include what you discovered, where, and why it matters.",
        },
        category: {
          type: "string",
          description: "Optional category heading for the note (e.g. Modules, Menus, Content, Quirks, Template). Helps keep notes organized.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "joomla_write_site_notes",
    description:
      "Overwrite the entire notes file for the active site. Use this to revise, reorganize, or prune stale notes. Read the current notes first, edit them, then write the full updated content back. No login required.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The full markdown content to write. This replaces the entire existing notes file.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "joomla_list_articles",
    description:
      "List articles in Joomla admin. If you know the article name, always provide the 'search' parameter — it sends a server-side filter and avoids fetching all articles. Optionally filter by category_id or state. Returns array of articles with id, title, state, category. Results are paginated — use 'page' to fetch additional pages (1-based). Default limit is 200 per page.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Filter articles whose title contains this text (server-side search). Use this whenever you know the article name to avoid fetching all articles.",
        },
        category_id: {
          type: "string",
          description: "Filter by category ID number",
        },
        state: {
          type: "string",
          description: "Filter by state: 1=published, 0=unpublished, -2=trashed, 2=archived",
          enum: ["0", "1", "-2", "2"],
        },
        limit: {
          type: "number",
          description: "Number of articles per page (default: 200, max: 500)",
        },
        page: {
          type: "number",
          description: "Page number to retrieve, 1-based (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_article",
    description:
      "Get a specific article by id, or search by title. If title matches multiple articles, returns a summary list — then call again with the correct id. Returns title, alias, categoryId, content (full article HTML), state, access, introImage, featuredImage, and other fields.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Article ID for a direct lookup.",
        },
        title: {
          type: "string",
          description: "Search by title instead of ID. Returns the article directly if title is unique, or a list of matches to disambiguate.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_create_article",
    description:
      "Create a new article. Requires: title (string), categoryId (string number). Optional: alias, content (full article HTML), state (0 or 1), access (1=Public, 2=Special, 3=Registered), introImage, introImageAlt, featuredImage, featuredImageAlt.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Article title",
        },
        alias: {
          type: "string",
          description: "URL alias (auto-generated if empty)",
        },
        categoryId: {
          type: "string",
          description: "Category ID number",
        },
        content: {
          type: "string",
          description: "Full article body as raw HTML",
        },
        state: {
          type: "string",
          description: "Publication state: 1=published, 0=unpublished",
        },
        access: {
          type: "string",
          description: "Access level: 1=Public, 2=Special, 3=Registered",
        },
        introImage: {
          type: "string",
          description: "Intro image path (e.g. images/my-photo.jpg)",
        },
        introImageAlt: {
          type: "string",
          description: "Intro image alt text",
        },
        featuredImage: {
          type: "string",
          description: "Featured image path (used for listing/blog views; hidden on the full article page)",
        },
        featuredImageAlt: {
          type: "string",
          description: "Featured image alt text",
        },
      },
      required: ["title", "categoryId"],
    },
  },
  {
    name: "joomla_update_article",
    description:
      "Update an existing article by ID. Only provided fields will be changed. Fields: title, alias, categoryId, content, state, access, ordering, introImage, introImageAlt, featuredImage, featuredImageAlt.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The article ID number",
        },
        title: {
          type: "string",
          description: "New title",
        },
        alias: {
          type: "string",
          description: "New URL alias",
        },
        categoryId: {
          type: "string",
          description: "New category ID",
        },
        content: {
          type: "string",
          description: "New full article body as raw HTML",
        },
        state: {
          type: "string",
          description: "Publication state: 1=published, 0=unpublished",
        },
        access: {
          type: "string",
          description: "Access level: 1=Public, 2=Special, 3=Registered",
        },
        ordering: {
          type: "string",
          description: "Place this article after the article with this ID (within the same category). Use -1 to move to first position. Use joomla_list_articles to find sibling IDs.",
        },
        introImage: {
          type: "string",
          description: "Intro image path (e.g. images/my-photo.jpg)",
        },
        introImageAlt: {
          type: "string",
          description: "Intro image alt text",
        },
        featuredImage: {
          type: "string",
          description: "Featured image path (used for listing/blog views; hidden on the full article page)",
        },
        featuredImageAlt: {
          type: "string",
          description: "Featured image alt text",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_delete_article",
    description: "Delete an article by ID. This moves it to trash.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The article ID number",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current article title matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_checkin_article",
    description: "Check in a Joomla article by ID if it is checked out in the administrator backend.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The article ID number",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse check-in unless the current article title matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_list_categories",
    description:
      "List content categories. If you know the category name, use the 'search' parameter for a targeted server-side filter. Returns array with id, title, state for each category. Optional extension parameter defaults to com_content. Results are paginated — use 'page' to fetch additional pages (1-based). Default limit is 200 per page.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Filter categories whose title contains this text (server-side search).",
        },
        extension: {
          type: "string",
          description: "Component extension (default: com_content)",
        },
        limit: {
          type: "number",
          description: "Number of categories per page (default: 200, max: 500)",
        },
        page: {
          type: "number",
          description: "Page number to retrieve, 1-based (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_category",
    description:
      "Get a specific category by id, or search by title. If title matches multiple categories, returns a summary list — then call again with the correct id. Returns title, alias, parentId, description, published state.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Category ID for a direct lookup.",
        },
        title: {
          type: "string",
          description: "Search by title instead of ID. Returns the category directly if title is unique, or a list of matches to disambiguate.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_create_category",
    description:
      "Create a new category. Requires: title. Optional: alias, parentId (default 1=root), description, published (0 or 1), extension (default com_content).",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Category name",
        },
        alias: {
          type: "string",
          description: "URL alias",
        },
        parentId: {
          type: "string",
          description: "Parent category ID (1 for root)",
        },
        description: {
          type: "string",
          description: "Category description (HTML)",
        },
        published: {
          type: "string",
          description: "Published state: 1=yes, 0=no",
        },
        extension: {
          type: "string",
          description: "Component extension (default: com_content)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_update_category",
    description:
      "Update an existing category by ID. Only provided fields will be changed. Fields: title, alias, parentId, description, published, ordering.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The category ID number",
        },
        title: {
          type: "string",
          description: "New category name",
        },
        alias: {
          type: "string",
          description: "New URL alias",
        },
        parentId: {
          type: "string",
          description: "New parent category ID",
        },
        description: {
          type: "string",
          description: "New description (HTML)",
        },
        published: {
          type: "string",
          description: "Published state: 1=yes, 0=no",
        },
        ordering: {
          type: "string",
          description: "Place this category after the category with this ID (within the same parent). Use -1 to move to first position. Use joomla_list_categories to find sibling IDs.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_delete_category",
    description: "Delete a category by ID. WARNING: Cannot delete categories that contain articles.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The category ID number",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current category title matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_checkin_category",
    description: "Check in a Joomla category by ID if it is checked out in the administrator backend.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The category ID number",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse check-in unless the current category title matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_list_modules",
    description:
      "List modules. If you know the module name, use the 'search' parameter for a targeted server-side filter. Optional client_id: '0'=site modules, '1'=admin modules. Supports pagination with 'limit' and 'page'. Returns array with id, title, state, position, enabled status.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Filter modules whose title contains this text (server-side search). Use whenever you know the module name.",
        },
        client_id: {
          type: "string",
          description: "Client ID: 0=site, 1=admin (default: 0)",
        },
        limit: {
          type: "number",
          description: "Number of modules per page (default: 200, max: 500)",
        },
        page: {
          type: "number",
          description: "Page number to retrieve, 1-based (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_list_module_types",
    description:
      "List available Joomla site/admin module types that can be created. Returns extension ID, title, and add URL for each type.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client ID: 0=site, 1=admin (default: 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_list_module_positions",
    description:
      "List module positions available in the current site/admin template selector.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client ID: 0=site, 1=admin (default: 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_inspect_module_type",
    description:
      "Inspect a module type before creating it. moduleType can be extension ID or visible type title, e.g. Custom, Menu, Search. Returns type-specific params/advanced field names, positions, and assignment options.",
    inputSchema: {
      type: "object",
      properties: {
        moduleType: {
          type: "string",
          description: "Module type extension ID or visible title",
        },
        client_id: {
          type: "string",
          description: "Client ID: 0=site, 1=admin (default: 0)",
        },
      },
      required: ["moduleType"],
    },
  },
  {
    name: "joomla_get_module",
    description:
      "Get a specific module by id, or search by title. If title matches multiple modules, returns a summary list — then call again with the correct id. Returns title, position, published, access, moduleType, showtitle, ordering, style.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Module ID for a direct lookup.",
        },
        title: {
          type: "string",
          description: "Search by title instead of ID. Returns the module directly if title is unique, or a list of matches to disambiguate.",
        },
        client_id: {
          type: "string",
          description: "Scope title search to site (0) or admin (1) modules (default: 0).",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_update_module",
    description:
      "Update an existing module by ID. Supports common fields plus params, advanced, page assignment fields, and raw fieldOverrides.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The module ID number",
        },
        title: {
          type: "string",
          description: "New module title",
        },
        position: {
          type: "string",
          description: "New module position name",
        },
        published: {
          type: "string",
          description: "Published: 1=yes, 0=no",
        },
        access: {
          type: "string",
          description: "Access level: 1=Public, 2=Special, 3=Registered",
        },
        showtitle: {
          type: "string",
          description: "Show title: 1=yes, 0=no",
        },
        ordering: {
          type: "string",
          description: "Module ordering number",
        },
        style: {
          type: "string",
          description: "Module style name",
        },
        language: {
          type: "string",
          description: "Language tag, defaults to *",
        },
        note: {
          type: "string",
          description: "Admin note",
        },
        assignment: {
          type: "string",
          description: "Page assignment mode: 0=all pages, -=no pages, 1=only selected, -1=all except selected",
        },
        assigned: {
          type: "array",
          items: { type: "string" },
          description: "Menu item IDs used when assignment is 1 or -1",
        },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Module type-specific params, such as custom settings exposed by joomla_inspect_module_type",
        },
        advanced: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Advanced module fields",
        },
        fieldOverrides: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Raw Joomla form field overrides, e.g. {\"jform[params][count]\":\"5\"}",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_create_module",
    description:
      "Create a Joomla module. Use joomla_list_module_types and joomla_inspect_module_type first. Supports common fields, params, advanced, page assignments, content for Custom modules, and raw fieldOverrides.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Module title" },
        moduleType: { type: "string", description: "Module type extension ID or visible title, e.g. Custom, Menu, Search" },
        client_id: { type: "string", description: "Client ID: 0=site, 1=admin (default: 0)" },
        position: { type: "string", description: "Template module position" },
        published: { type: "string", description: "Published: 1=yes, 0=no" },
        access: { type: "string", description: "Access level ID" },
        showtitle: { type: "string", description: "Show title: 1=yes, 0=no" },
        ordering: { type: "string", description: "Ordering value" },
        style: { type: "string", description: "Module style" },
        language: { type: "string", description: "Language tag" },
        note: { type: "string", description: "Admin note" },
        assignment: { type: "string", description: "Page assignment mode: 0=all pages, -=no pages, 1=only selected, -1=all except selected" },
        assigned: { type: "array", items: { type: "string" }, description: "Menu item IDs for selected/excluded page assignments" },
        content: { type: "string", description: "HTML content for Custom modules" },
        params: { type: "object", additionalProperties: { type: "string" } },
        advanced: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["title", "moduleType"],
    },
  },
  {
    name: "joomla_delete_module",
    description: "Delete a module by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The module ID number",
        },
        client_id: {
          type: "string",
          description: "Optional module client ID for verification: 0=site, 1=admin",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current module title matches this value",
        },
        expectedModuleType: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current module type matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_checkin_module",
    description: "Check in a Joomla module by ID if it is checked out in the administrator backend.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The module ID number",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse check-in unless the current module title matches this value",
        },
        expectedModuleType: {
          type: "string",
          description: "Optional safety check: refuse check-in unless the current module type matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_toggle_module",
    description: "Enable or disable a module. State '1' enables, '0' disables.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The module ID number",
        },
        state: {
          type: "string",
          description: "State: 1=enable, 0=disable",
          enum: ["0", "1"],
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse state change unless the current module title matches this value",
        },
        expectedModuleType: {
          type: "string",
          description: "Optional safety check: refuse state change unless the current module type matches this value",
        },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "joomla_list_menus",
    description: "List all menus in the site. Returns array of menus with id and title.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_create_menu",
    description:
      "Create a new Joomla menu container. Use the returned menuType when creating menu items.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Visible menu title, e.g. Main Menu CL" },
        menuType: { type: "string", description: "System menu type, max 24 chars, e.g. main-menu-cl. Defaults to a slug from title." },
        description: { type: "string", description: "Optional menu description" },
        cssClasses: { type: "string", description: "Optional body CSS classes" },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_list_menu_items",
    description:
      "List menu items for a specific menu. Requires menuId, which should be the menuType returned by joomla_list_menus (for example 'mainmenu'). If you know the item name, use the 'search' parameter for a targeted server-side filter. Returns array of menu items, each with parentId and parentTitle (parentTitle is 'Root' for top-level items with no parent).",
    inputSchema: {
      type: "object",
      properties: {
        menuId: {
          type: "string",
          description: "Menu ID or type identifier",
        },
        search: {
          type: "string",
          description: "Filter menu items whose title contains this text (server-side search).",
        },
        limit: {
          type: "number",
          description: "Items per page (default: 0 = all, max 500)",
        },
        page: {
          type: "number",
          description: "Page number, 1-based (default: 1)",
        },
      },
      required: ["menuId"],
    },
  },
  {
    name: "joomla_list_menu_item_types",
    description:
      "List all available Joomla menu item types. Returns group, label, description, encoded type value, language title key, and base request for each type.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_inspect_menu_item_type",
    description:
      "Inspect a Joomla menu item type before creating an item. itemType can be the encoded value, label, language title key, or request key like com_content.article.",
    inputSchema: {
      type: "object",
      properties: {
        itemType: {
          type: "string",
          description: "Encoded type value, label, title key, or request key such as com_content.article",
        },
      },
      required: ["itemType"],
    },
  },
  {
    name: "joomla_get_menu_item",
    description:
      "Get full editable details for a menu item. Provide id for a direct lookup, or title to search by name (optionally scoped to a menuId). If title matches multiple items, returns a summary list — then call again with the correct id. Returns request and params fields.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Menu item ID for a direct lookup.",
        },
        title: {
          type: "string",
          description: "Search by title instead of id. Returns full details if unique, or a list of matches to disambiguate.",
        },
        menuId: {
          type: "string",
          description: "Optional: scope title search to a specific menu (menuType, e.g. 'mainmenu'). Without this, searches across all menus.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_create_menu_item",
    description:
      "Create a Joomla menu item. Use joomla_list_menu_item_types first. Supports generic request, params, and raw fieldOverrides for type-specific settings.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Menu item title" },
        menuType: { type: "string", description: "Menu type from joomla_list_menus, e.g. mainmenu" },
        itemType: { type: "string", description: "Encoded type, label, title key, or request key like com_content.article" },
        alias: { type: "string", description: "URL alias" },
        link: { type: "string", description: "Optional explicit link, e.g. index.php?option=com_content&view=article&id=123" },
        parentId: { type: "string", description: "Parent menu item ID, defaults to 1/root" },
        published: { type: "string", description: "Published state: 1=published, 0=unpublished, -2=trashed" },
        access: { type: "string", description: "Access level ID, usually 1=Public" },
        language: { type: "string", description: "Language tag, defaults to *" },
        browserNav: { type: "string", description: "Browser target: 0=same window, 1=new window, 2=popup" },
        home: { type: "string", description: "Set as home/default menu item: 0=no, 1=yes" },
        note: { type: "string", description: "Admin note" },
        request: {
          type: "object",
          description: "Type-specific request values, e.g. {\"id\":\"123\"} for Single Article or Category Blog",
          additionalProperties: { type: "string" },
        },
        params: {
          type: "object",
          description: "Menu params, e.g. {\"show_page_heading\":\"1\"}",
          additionalProperties: { type: "string" },
        },
        templateStyleId: {
          type: "string",
          description: "Template style ID controlling which Gantry outline applies (0 = site default). Use joomla_get_menu_item to see available options in templateStyleOptions.",
        },
        fieldOverrides: {
          type: "object",
          description: "Raw Joomla form field overrides, e.g. {\"jform[params][menu-anchor_title]\":\"Title\"}",
          additionalProperties: { type: "string" },
        },
      },
      required: ["title", "menuType", "itemType"],
    },
  },
  {
    name: "joomla_update_menu_item",
    description:
      "Update an existing Joomla menu item by ID. Supports common fields plus request, params, and raw fieldOverrides for type-specific settings.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        title: { type: "string", description: "New menu item title" },
        itemType: { type: "string", description: "New menu item type, e.g. category blog or com_content.category.blog" },
        alias: { type: "string", description: "New alias" },
        menuType: { type: "string", description: "Move to another menu type" },
        link: { type: "string", description: "Explicit link" },
        parentId: { type: "string", description: "Parent menu item ID" },
        published: { type: "string", description: "Published state" },
        access: { type: "string", description: "Access level ID" },
        language: { type: "string", description: "Language tag" },
        browserNav: { type: "string", description: "Browser target" },
        home: { type: "string", description: "Home/default state" },
        note: { type: "string", description: "Admin note" },
        templateStyleId: {
          type: "string",
          description: "Template style ID controlling which Gantry outline applies (0 = site default). Use joomla_get_menu_item to see available options in templateStyleOptions.",
        },
        ordering: {
          type: "string",
          description: "Place this menu item after the sibling item with this ID. Use -1 to move to first position. Use joomla_list_menu_items to find sibling IDs.",
        },
        request: { type: "object", additionalProperties: { type: "string" } },
        params: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_delete_menu_item",
    description: "Trash a Joomla menu item by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Menu item ID",
        },
        menuType: {
          type: "string",
          description: "Optional menu type for post-delete verification, e.g. mainmenu",
        },
        expectedTitle: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current menu item title matches this value",
        },
        expectedMenuType: {
          type: "string",
          description: "Optional safety check: refuse deletion unless the current menu type matches this value",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_toggle_menu_item",
    description: "Publish or unpublish a menu item. State '1' publishes, '0' unpublishes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        state: { type: "string", description: "State: 1=publish, 0=unpublish", enum: ["0", "1"] },
        menuType: { type: "string", description: "Optional menu type/menutype to scope the publish action" },
        expectedTitle: { type: "string", description: "Optional safety check: refuse state change unless the current menu item title matches this value" },
        expectedMenuType: { type: "string", description: "Optional safety check: refuse state change unless the current menu type matches this value" },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "joomla_checkin_menu_item",
    description: "Check in a Joomla menu item by ID if it is checked out in the administrator backend.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        menuType: { type: "string", description: "Optional menu type/menutype to scope the check-in action" },
        expectedTitle: { type: "string", description: "Optional safety check: refuse check-in unless the current menu item title matches this value" },
        expectedMenuType: { type: "string", description: "Optional safety check: refuse check-in unless the current menu type matches this value" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_backend_inventory",
    description:
      "Discover the Joomla backend surface: admin links/components, module types, menu item types, Gantry outlines, and key build forms.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_inspect_admin_form",
    description:
      "Inspect any Joomla admin edit form by backend path. Returns action, method, fields, selected options, hidden fields, toolbar tasks, token, and a safe HTML preview.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path or URL, e.g. index.php?option=com_content&task=article.add." },
        formId: { type: "string", description: "Optional form ID to prefer, e.g. item-form." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_inspect_admin_list",
    description:
      "Inspect a Joomla admin list page. Returns filters, table headers, row IDs, publish/checked-out hints, and toolbar tasks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path or URL, e.g. index.php?option=com_content&view=articles." },
        formId: { type: "string", description: "Optional list form ID. Defaults to adminForm." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_submit_admin_form",
    description:
      "Generic safe form submit helper. Preserves existing fields, injects CSRF, applies overrides, and defaults to dryRun unless confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path or URL containing the form." },
        formId: { type: "string", description: "Optional form ID." },
        overrides: { type: "object", additionalProperties: true, description: "Raw field overrides by exact field name." },
        task: { type: "string", description: "Optional Joomla task to set." },
        dryRun: { type: "boolean", description: "Return exact payload without posting. Defaults true unless confirm=true." },
        confirm: { type: "boolean", description: "Required true for live submit." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_snapshot_target",
    description:
      "Snapshot article/category/menu/module/forms or Gantry layouts before risky work. Use kind=gantryLayout for Gantry outlines.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "article, category, menuItem, module, form, or gantryLayout." },
        id: { type: "string", description: "Target ID for known Joomla forms." },
        path: { type: "string", description: "Explicit admin path for generic form snapshots." },
        formId: { type: "string", description: "Optional form ID." },
        outline: { type: "string", description: "Gantry outline ID for gantryLayout." },
        theme: { type: "string", description: "Optional Gantry theme key. Defaults to rt_studius." },
      },
      required: ["kind"],
    },
  },
  {
    name: "joomla_export_module_blueprint",
    description: "Export a Joomla module by ID to a reusable JSON or YAML blueprint for cloning on other sites.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID to export." },
        format: { type: "string", enum: ["json", "yaml"], description: "Export format. Defaults to yaml." },
        saveToFile: { type: "boolean", description: "Save the exported blueprint under blueprints/modules in the workspace." },
        fileName: { type: "string", description: "Optional filename for the saved blueprint." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_import_module_blueprint",
    description: "Create a new Joomla module from a JSON or YAML blueprint. Supports dry-run parsing before live creation.",
    inputSchema: {
      type: "object",
      properties: {
        blueprint: { type: "object", additionalProperties: true, description: "Inline module blueprint object." },
        blueprintText: { type: "string", description: "Inline JSON or YAML module blueprint text." },
        format: { type: "string", enum: ["json", "yaml"], description: "Input format when using blueprintText." },
        filePath: { type: "string", description: "Workspace-relative or absolute path to a saved module blueprint." },
        title: { type: "string", description: "Optional override title for the created module." },
        clientId: { type: "string", description: "Optional override client ID: 0=site, 1=admin." },
        position: { type: "string", description: "Optional override position." },
        published: { type: "string", description: "Optional override publish state." },
        access: { type: "string", description: "Optional override access level." },
        showtitle: { type: "string", description: "Optional override show title state." },
        ordering: { type: "string", description: "Optional override ordering." },
        style: { type: "string", description: "Optional override module style." },
        language: { type: "string", description: "Optional override language." },
        note: { type: "string", description: "Optional override admin note." },
        assignment: { type: "string", description: "Optional override assignment mode." },
        assigned: { type: "array", items: { type: "string" }, description: "Optional override selected menu assignments." },
        dryRun: { type: "boolean", description: "Preview the parsed module payload without creating a module." },
        confirm: { type: "boolean", description: "Required true for live create." },
      },
      required: [],
    },
  },
  {
    name: "joomla_restore_snapshot",
    description:
      "Restore a supported snapshot. Defaults to dry-run; set confirm=true for live restore.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string" },
        confirm: { type: "boolean" },
        task: { type: "string", description: "Optional restore task override for form snapshots." },
      },
      required: ["snapshotId"],
    },
  },
  {
    name: "joomla_plan_site_build",
    description:
      "Create a deterministic dry-run site build plan from a site code/suffix, menu tree, category rules, home settings, and optional Gantry assignments.",
    inputSchema: {
      type: "object",
      properties: {
        siteCode: { type: "string", description: "Site code such as ST." },
        suffix: { type: "string", description: "Alias suffix such as st. Defaults from siteCode." },
        menuTitle: { type: "string", description: "Menu title, e.g. Main Menu ST." },
        menuType: { type: "string", description: "Optional Joomla menu type." },
        menuTree: { description: "Indented text tree or structured array. Supports [grid] and (notes)." },
        pageContentCategory: { type: "string", description: "Default article category." },
        homeCategory: { type: "string", description: "Home category title, e.g. ___ Catholic." },
      },
      required: ["menuTree"],
    },
  },
  {
    name: "joomla_apply_site_build",
    description:
      "Execute a site build plan. Defaults to dry-run; set confirm=true to create categories, menu, articles, and menu items.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "object", description: "Plan returned by joomla_plan_site_build." },
        siteCode: { type: "string" },
        suffix: { type: "string" },
        menuTitle: { type: "string" },
        menuType: { type: "string" },
        menuTree: { description: "Indented text tree or structured array if no plan is supplied." },
        pageContentCategory: { type: "string" },
        homeCategory: { type: "string" },
        confirm: { type: "boolean", description: "Required true for live writes." },
      },
    },
  },
  {
    name: "joomla_validate_site_build",
    description:
      "Validate a planned or existing site build for duplicate aliases, unpublished menu parents, missing categories, wrong home type, and broken references.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "object", description: "Optional plan returned by joomla_plan_site_build." },
        menuType: { type: "string", description: "Optional existing Joomla menu type to inspect." },
      },
    },
  },
  {
    name: "joomla_launch_checklist",
    description:
      "Run a read-only launch checklist for cache/config/menu/Gantry/redirect readiness.",
    inputSchema: {
      type: "object",
      properties: {
        menuType: { type: "string" },
        gantryOutline: { type: "string" },
        theme: { type: "string" },
      },
    },
  },
  {
    name: "joomla_component_inspect",
    description:
      "Generic component explorer for build-critical Joomla components. Use mode=list or mode=form with any admin component path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["form", "list"] },
        formId: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_media_list",
    description: "Inspect Media Manager folders/files/images and available forms/tasks.",
    inputSchema: { type: "object", properties: { folder: { type: "string" }, path: { type: "string" } } },
  },
  {
    name: "joomla_media_create_folder",
    description: "Create a Media Manager folder using the generic safe submit helper. Defaults to dry-run unless confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        folderName: { type: "string" },
        folderBase: { type: "string" },
        path: { type: "string" },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["folderName"],
    },
  },
  {
    name: "joomla_sponsors_list",
    description: "Inspect the Sponsors component list page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_sponsor_inspect",
    description: "Inspect a Sponsors edit/template form by path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "joomla_docman_list_documents",
    description: "Inspect DOCman documents list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_fileman_list_files",
    description: "Inspect FILEman file list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_redirects_list",
    description: "Inspect Redirects list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_site_config_inspect",
    description: "Inspect global/site configuration form fields.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_subsites_list",
    description: "Inspect Subsites list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_gantry5_export_outline_blueprint",
    description:
      "Export a Gantry outline into a portable JSON or YAML blueprint that can be reused on another site. Can optionally save under local blueprints/ folder.",
    inputSchema: {
      type: "object",
      properties: {
        outline: { type: "string", description: "Source outline ID. Defaults to default." },
        theme: { type: "string", description: "Optional Gantry theme key. Defaults to rt_studius." },
        format: { type: "string", enum: ["json", "yaml"], description: "Export format. Defaults to json." },
        saveToFile: { type: "boolean", description: "When true, writes the blueprint to blueprints/." },
        fileName: { type: "string", description: "Optional custom file name when saveToFile=true." },
      },
      required: [],
    },
  },
  {
    name: "joomla_gantry5_import_outline_blueprint",
    description:
      "Import/apply a Gantry outline blueprint from object, text, or file path. Supports dry-run preview before live apply.",
    inputSchema: {
      type: "object",
      properties: {
        outline: { type: "string", description: "Target outline ID override. Defaults to blueprint source outline." },
        theme: { type: "string", description: "Target Gantry theme override. Defaults to blueprint source theme." },
        blueprint: { type: "object", additionalProperties: true, description: "Blueprint object payload." },
        blueprintText: { type: "string", description: "Blueprint JSON/YAML text payload." },
        format: { type: "string", enum: ["json", "yaml"], description: "Format for blueprintText or ambiguous file extensions." },
        filePath: { type: "string", description: "Local blueprint file path (relative to workspace or absolute)." },
        dryRun: { type: "boolean", description: "Preview parsed/apply summary without saving." },
        confirm: { type: "boolean", description: "Set true to apply live." },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_frontend_page",
    description:
      "Fetch a public frontend page and extract structured info: pageTitle, cleanTitle (site name suffix stripped), h1, metaDescription, canonicalUrl. Use this when given a frontend URL or page title to identify the matching Joomla article — then pass cleanTitle to joomla_get_article or joomla_list_articles with the search parameter.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Frontend path (e.g. '/about-us') or full URL (e.g. 'https://example.com/contact')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_page_content",
    description:
      "Get raw HTML content of any admin page for debugging or exploration. Use the admin path like 'index.php?option=com_content&view=articles'.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Admin page path (e.g., 'index.php?option=com_content&view=articles')",
        },
      },
      required: ["path"],
    },
  },
];

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "joomla_login": {
        const siteUrl = args?.site_url as string | undefined;
        if (siteUrl) {
          joomla.switchSite(siteUrl);
          isLoggedIn = false;
        }
        const result = await ensureLoggedIn();
        const cfg = joomla.getConfig();
        if (result.success) {
          result.data = { ...((result.data as object) ?? {}), activeSite: cfg.baseUrl, username: cfg.username };
        }
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_site": {
        const cfg = joomla.getConfig();
        return {
          content: [{ type: "text", text: formatResult({ success: true, message: "Active site", data: { site: cfg.baseUrl, username: cfg.username } }) }],
        };
      }

      case "joomla_read_site_notes": {
        const notesPath = getSiteNotesPath(joomla.getConfig().baseUrl);
        if (!fs.existsSync(notesPath)) {
          return {
            content: [{ type: "text", text: formatResult({ success: true, message: "No notes yet for this site.", data: null }) }],
          };
        }
        const notes = fs.readFileSync(notesPath, "utf8");
        return {
          content: [{ type: "text", text: formatResult({ success: true, message: "Site notes loaded.", data: notes }) }],
        };
      }

      case "joomla_append_site_note": {
        const note = args?.note as string;
        if (!note) return { content: [{ type: "text", text: "Error: note is required" }], isError: true };
        const category = (args?.category as string) || "General";
        const notesPath = getSiteNotesPath(joomla.getConfig().baseUrl);
        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 16) + " UTC";
        const entry = `\n**[${timestamp}] ${category}** — ${note}\n`;
        if (!fs.existsSync(notesPath)) {
          const hostname = new URL(normalizeUrl(joomla.getConfig().baseUrl)).hostname;
          fs.mkdirSync(path.dirname(notesPath), { recursive: true });
          fs.writeFileSync(notesPath, `# Site Notes: ${hostname}\n\nNotes logged by AI agents as they discover site-specific quirks and conventions.\n`);
        }
        fs.appendFileSync(notesPath, entry);
        return {
          content: [{ type: "text", text: formatResult({ success: true, message: "Note appended.", data: entry.trim() }) }],
        };
      }

      case "joomla_write_site_notes": {
        const content = args?.content as string;
        if (!content) return { content: [{ type: "text", text: "Error: content is required" }], isError: true };
        const notesPath = getSiteNotesPath(joomla.getConfig().baseUrl);
        fs.mkdirSync(path.dirname(notesPath), { recursive: true });
        fs.writeFileSync(notesPath, content, "utf8");
        return {
          content: [{ type: "text", text: formatResult({ success: true, message: "Site notes updated." }) }],
        };
      }

      case "joomla_list_articles": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listArticles(
          (args?.category_id as string) || undefined,
          (args?.state as string) || undefined,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
          (args?.search as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getArticle(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        const categoryId = args?.categoryId as string;
        if (!title || !categoryId)
          return { content: [{ type: "text", text: "Error: title and categoryId are required" }], isError: true };

        const result = await joomla.createArticle({
          title,
          introImage: args?.introImage as string,
          introImageAlt: args?.introImageAlt as string,
          featuredImage: args?.featuredImage as string,
          featuredImageAlt: args?.featuredImageAlt as string,
          alias: args?.alias as string,
          categoryId,
          content: args?.content as string,
          state: args?.state as string,
          access: args?.access as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateArticle(id, {
          title: args?.title as string,
          alias: args?.alias as string,
          categoryId: args?.categoryId as string,
          content: args?.content as string,
          state: args?.state as string,
          access: args?.access as string,
          ordering: args?.ordering as string,
          introImage: args?.introImage as string,
          introImageAlt: args?.introImageAlt as string,
          featuredImage: args?.featuredImage as string,
          featuredImageAlt: args?.featuredImageAlt as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteArticle(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInArticle(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_categories": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listCategories(
          args?.extension as string,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
          (args?.search as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getCategory(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };

        const result = await joomla.createCategory({
          title,
          alias: args?.alias as string,
          parentId: args?.parentId as string,
          description: args?.description as string,
          published: args?.published as string,
          extension: args?.extension as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateCategory(id, {
          title: args?.title as string,
          alias: args?.alias as string,
          parentId: args?.parentId as string,
          description: args?.description as string,
          published: args?.published as string,
          ordering: args?.ordering as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteCategory(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInCategory(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_modules": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModules(
          args?.client_id as string,
          (args?.search as string) || undefined,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_module_types": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModuleTypes(args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_module_positions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModulePositions(args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_inspect_module_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const moduleType = args?.moduleType as string;
        if (!moduleType) return { content: [{ type: "text", text: "Error: moduleType is required" }], isError: true };

        const result = await joomla.inspectModuleType(moduleType, args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getModule(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
          (args?.client_id as string) || "0",
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_export_module_blueprint": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.exportModuleBlueprint(id, {
          format: args?.format as "json" | "yaml",
          saveToFile: args?.saveToFile as boolean,
          fileName: args?.fileName as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_import_module_blueprint": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.importModuleBlueprint({
          blueprint: args?.blueprint as Record<string, unknown>,
          blueprintText: args?.blueprintText as string,
          format: args?.format as "json" | "yaml",
          filePath: args?.filePath as string,
          title: args?.title as string,
          clientId: args?.clientId as string,
          position: args?.position as string,
          published: args?.published as string,
          access: args?.access as string,
          showtitle: args?.showtitle as string,
          ordering: args?.ordering as string,
          style: args?.style as string,
          language: args?.language as string,
          note: args?.note as string,
          assignment: args?.assignment as string,
          assigned: args?.assigned as string[],
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateModule(id, {
          title: args?.title as string,
          position: args?.position as string,
          published: args?.published as string,
          access: args?.access as string,
          showtitle: args?.showtitle as string,
          ordering: args?.ordering as string,
          style: args?.style as string,
          language: args?.language as string,
          note: args?.note as string,
          assignment: args?.assignment as string,
          assigned: args?.assigned as string[],
          params: args?.params as Record<string, string>,
          advanced: args?.advanced as Record<string, string>,
          fieldOverrides: args?.fieldOverrides as Record<string, string>,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        const moduleType = args?.moduleType as string;
        if (!title || !moduleType)
          return { content: [{ type: "text", text: "Error: title and moduleType are required" }], isError: true };

        const result = await joomla.createModule({
          title,
          moduleType,
          clientId: args?.client_id as string,
          position: args?.position as string,
          published: args?.published as string,
          access: args?.access as string,
          showtitle: args?.showtitle as string,
          ordering: args?.ordering as string,
          style: args?.style as string,
          language: args?.language as string,
          note: args?.note as string,
          assignment: args?.assignment as string,
          assigned: args?.assigned as string[],
          content: args?.content as string,
          params: args?.params as Record<string, string>,
          advanced: args?.advanced as Record<string, string>,
          fieldOverrides: args?.fieldOverrides as Record<string, string>,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteModule(id, {
          clientId: args?.client_id as string,
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInModule(id, {
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_toggle_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        const state = args?.state as string;
        if (!id || !state)
          return { content: [{ type: "text", text: "Error: id and state are required" }], isError: true };

        const result = await joomla.toggleModule(id, state, {
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menus": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listMenus();
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_menu": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };

        const result = await joomla.createMenu({
          title,
          menuType: args?.menuType as string,
          description: args?.description as string,
          cssClasses: args?.cssClasses as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menu_items": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const menuId = args?.menuId as string;
        if (!menuId) return { content: [{ type: "text", text: "Error: menuId is required" }], isError: true };

        const result = await joomla.listMenuItems(
          menuId,
          (args?.search as string) || undefined,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menu_item_types": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listMenuItemTypes();
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_inspect_menu_item_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const itemType = args?.itemType as string;
        if (!itemType) return { content: [{ type: "text", text: "Error: itemType is required" }], isError: true };

        const result = await joomla.inspectMenuItemType(itemType);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getMenuItem(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
          (args?.menuId as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        const menuType = args?.menuType as string;
        const itemType = args?.itemType as string;
        if (!title || !menuType || !itemType)
          return { content: [{ type: "text", text: "Error: title, menuType, and itemType are required" }], isError: true };

        const result = await joomla.createMenuItem({
          title,
          menuType,
          itemType,
          alias: args?.alias as string,
          link: args?.link as string,
          parentId: args?.parentId as string,
          published: args?.published as string,
          access: args?.access as string,
          language: args?.language as string,
          browserNav: args?.browserNav as string,
          home: args?.home as string,
          note: args?.note as string,
          templateStyleId: args?.templateStyleId as string,
          request: args?.request as Record<string, string>,
          params: args?.params as Record<string, string>,
          fieldOverrides: args?.fieldOverrides as Record<string, string>,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateMenuItem(id, {
          title: args?.title as string,
          itemType: args?.itemType as string,
          alias: args?.alias as string,
          menuType: args?.menuType as string,
          link: args?.link as string,
          parentId: args?.parentId as string,
          published: args?.published as string,
          access: args?.access as string,
          language: args?.language as string,
          browserNav: args?.browserNav as string,
          home: args?.home as string,
          note: args?.note as string,
          templateStyleId: args?.templateStyleId as string,
          ordering: args?.ordering as string,
          request: args?.request as Record<string, string>,
          params: args?.params as Record<string, string>,
          fieldOverrides: args?.fieldOverrides as Record<string, string>,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteMenuItem(id, {
          menuType: args?.menuType as string,
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_toggle_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        const state = args?.state as string;
        if (!id || !state) return { content: [{ type: "text", text: "Error: id and state are required" }], isError: true };

        const result = await joomla.toggleMenuItem(id, state, args?.menuType as string, {
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInMenuItem(id, args?.menuType as string, {
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_backend_inventory": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.backendInventory();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_inspect_admin_form": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.inspectAdminForm(path, args?.formId as string);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_inspect_admin_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.inspectAdminList(path, (args?.formId as string) || "adminForm");
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_submit_admin_form": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.submitAdminForm(path, {
          formId: args?.formId as string,
          overrides: args?.overrides as Record<string, string>,
          task: args?.task as string,
          dryRun: (args?.dryRun as boolean | undefined) ?? !(args?.confirm as boolean),
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_snapshot_target": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const kind = args?.kind as string;
        if (!kind) return { content: [{ type: "text", text: "Error: kind is required" }], isError: true };
        const result = await joomla.snapshotTarget({
          kind,
          id: args?.id as string,
          path: args?.path as string,
          formId: args?.formId as string,
          outline: args?.outline as string,
          theme: args?.theme as string,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_restore_snapshot": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const snapshotId = args?.snapshotId as string;
        if (!snapshotId) return { content: [{ type: "text", text: "Error: snapshotId is required" }], isError: true };
        const result = await joomla.restoreSnapshot(snapshotId, { confirm: args?.confirm as boolean, task: args?.task as string });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_plan_site_build": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.planSiteBuild({
          siteCode: args?.siteCode as string,
          suffix: args?.suffix as string,
          menuTitle: args?.menuTitle as string,
          menuType: args?.menuType as string,
          menuTree: args?.menuTree as string,
          pageContentCategory: args?.pageContentCategory as string,
          homeCategory: args?.homeCategory as string,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_apply_site_build": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.applySiteBuild({
          plan: args?.plan as Record<string, unknown>,
          siteCode: args?.siteCode as string,
          suffix: args?.suffix as string,
          menuTitle: args?.menuTitle as string,
          menuType: args?.menuType as string,
          menuTree: args?.menuTree as string,
          pageContentCategory: args?.pageContentCategory as string,
          homeCategory: args?.homeCategory as string,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_validate_site_build": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.validateSiteBuild({
          plan: args?.plan as Record<string, unknown>,
          menuType: args?.menuType as string,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_launch_checklist": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.launchChecklist({
          menuType: args?.menuType as string,
          gantryOutline: args?.gantryOutline as string,
          theme: args?.theme as string,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_component_inspect": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.componentInspect({ path, mode: args?.mode as "form" | "list", formId: args?.formId as string });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.mediaList((args?.path as string) || (args?.folder as string) || "index.php?option=com_media");
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_create_folder": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const folderName = args?.folderName as string;
        if (!folderName) return { content: [{ type: "text", text: "Error: folderName is required" }], isError: true };
        const result = await joomla.createMediaFolder({
          folderName,
          folderBase: args?.folderBase as string,
          path: args?.path as string,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_sponsors_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listSponsors();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_sponsor_inspect": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.inspectSponsor(args?.path as string);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_list_documents": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listDocmanDocuments();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_fileman_list_files": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listFilemanFiles();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_redirects_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listRedirects();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_site_config_inspect": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.inspectSiteConfig();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_subsites_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listSubsites();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_gantry5_export_outline_blueprint": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.exportGantry5OutlineBlueprint((args?.outline as string) || "default", {
          theme: args?.theme as string,
          format: args?.format as "json" | "yaml",
          saveToFile: args?.saveToFile as boolean,
          fileName: args?.fileName as string,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_gantry5_import_outline_blueprint": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.importGantry5OutlineBlueprint({
          outline: args?.outline as string,
          theme: args?.theme as string,
          blueprint: args?.blueprint as Record<string, unknown>,
          blueprintText: args?.blueprintText as string,
          format: args?.format as "json" | "yaml",
          filePath: args?.filePath as string,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_get_frontend_page": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };

        const result = await joomla.getFrontendPageInfo(path);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_page_content": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };

        const result = await joomla.getPageContent(path);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

  const DOCS_DIR = path.join(process.cwd(), "docs", "agents");

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const files = fs.existsSync(DOCS_DIR)
      ? fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))
      : [];
    return {
      resources: files.map((f) => ({
        uri: `joomla-docs://agents/${f}`,
        name: f.replace(".md", ""),
        mimeType: "text/markdown",
        description: `Joomla MCP workflow guide: ${f.replace(".md", "")}`,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri as string;
    const match = uri.match(/^joomla-docs:\/\/agents\/(.+\.md)$/);
    if (!match) throw new Error(`Unknown resource: ${uri}`);
    const filePath = path.join(DOCS_DIR, match[1]);
    if (!fs.existsSync(filePath)) throw new Error(`Resource not found: ${match[1]}`);
    return {
      contents: [{ uri, mimeType: "text/markdown", text: fs.readFileSync(filePath, "utf8") }],
    };
  });

  return server;
}

async function startHttp(port: number): Promise<void> {
  const validTokens = new Set(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith("MCP_TOKEN_"))
      .map(([, v]) => v as string)
      .filter(Boolean)
  );

  if (validTokens.size === 0) {
    console.error("WARNING: No MCP_TOKEN_* env vars found. All HTTP requests will be rejected.");
  } else {
    console.error(`Team access configured for ${validTokens.size} member(s).`);
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const auth = req.headers["authorization"] ?? "";
    const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const queryToken = reqUrl.searchParams.get("token") ?? "";
    const token = headerToken || queryToken;
    if (!token || !validTokens.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const urlPath = reqUrl.pathname;
    if (urlPath !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      const joomlaClient = new JoomlaClient(config);
      const mcpServer = buildServer(joomlaClient);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      await mcpServer.connect(transport);
    }

    let body: unknown;
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: Buffer) => (data += chunk.toString()));
        req.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(undefined); }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
    if (req.method === "DELETE" && sessionId) {
      sessions.delete(sessionId);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`Joomla MCP Server running on HTTP port ${port}`);
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const rawPort = process.env.HTTP_PORT || process.env.PORT;
  const httpPort = rawPort ? parseInt(rawPort, 10) : null;

  if (httpPort) {
    await startHttp(httpPort);
  } else {
    const joomlaClient = new JoomlaClient(config);
    const mcpServer = buildServer(joomlaClient);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("Joomla MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
