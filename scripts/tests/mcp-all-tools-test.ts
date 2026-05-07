import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonObject = Record<string, unknown>;

const expectedTools = [
  "joomla_login",
  "joomla_list_articles",
  "joomla_get_article",
  "joomla_create_article",
  "joomla_update_article",
  "joomla_delete_article",
  "joomla_checkin_article",
  "joomla_list_categories",
  "joomla_get_category",
  "joomla_create_category",
  "joomla_update_category",
  "joomla_delete_category",
  "joomla_checkin_category",
  "joomla_list_modules",
  "joomla_list_module_types",
  "joomla_list_module_positions",
  "joomla_inspect_module_type",
  "joomla_list_gantry_particle_types",
  "joomla_inspect_gantry_particle",
  "joomla_get_gantry_particle_module",
  "joomla_create_gantry_particle_module",
  "joomla_update_gantry_particle_module",
  "joomla_get_module",
  "joomla_create_module",
  "joomla_update_module",
  "joomla_delete_module",
  "joomla_checkin_module",
  "joomla_toggle_module",
  "joomla_list_menus",
  "joomla_create_menu",
  "joomla_list_menu_items",
  "joomla_list_menu_item_types",
  "joomla_inspect_menu_item_type",
  "joomla_get_menu_item",
  "joomla_create_menu_item",
  "joomla_update_menu_item",
  "joomla_delete_menu_item",
  "joomla_toggle_menu_item",
  "joomla_checkin_menu_item",
  "joomla_page_content",
];

const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
const categoryTitle = `MCP Full Tool Test Category ${startedAt}`;
const updatedCategoryTitle = `${categoryTitle} Updated`;
const articleTitle = `MCP Full Tool Test Article ${startedAt}`;
const updatedArticleTitle = `${articleTitle} Updated`;

const client = new Client({ name: "joomla-mcp-all-tools-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const results: Array<{ tool: string; ok: boolean; message: string }> = [];
const suite = (process.env.TEST_SUITE || "all").toLowerCase();
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 180000);

function firstTextContent(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool returned no text content");
  return text;
}

function parseToolJson(result: unknown): JsonObject {
  return JSON.parse(firstTextContent(result)) as JsonObject;
}

function dataArray(value: unknown): Array<Record<string, string>> {
  return Array.isArray(value) ? (value as Array<Record<string, string>>) : [];
}

function assertOperationEnvelope(tool: string, parsed: JsonObject): void {
  const data = (parsed.data || {}) as Record<string, unknown>;
  const requiredKeys = ["id", "title", "state", "editUrl", "viewUrl", "warnings", "verification"];
  const missing = requiredKeys.filter((key) => !(key in data));
  if (missing.length > 0) {
    throw new Error(`${tool} missing response envelope keys: ${missing.join(", ")}`);
  }
}

async function callTool(name: string, args: JsonObject = {}): Promise<JsonObject> {
  console.log(`Running tool: ${name}`);
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
  const parsed = parseToolJson(result);
  const ok = parsed.success === true;
  results.push({ tool: name, ok, message: String(parsed.message ?? "") });
  if (!ok) {
    throw new Error(`${name} failed: ${parsed.message ?? firstTextContent(result)}`);
  }
  return parsed;
}

function findByTitle(items: Array<Record<string, string>>, title: string): Record<string, string> | undefined {
  return items.find((item) => item.title === title);
}

function runSuite(name: string): boolean {
  return suite === "all" || suite === name;
}

async function main() {
  console.log(`Starting MCP test harness. Suite=${suite}`);
  await Promise.race([
    client.connect(transport, { timeout: REQUEST_TIMEOUT_MS }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("client.connect timed out")), REQUEST_TIMEOUT_MS)),
  ]);

  try {
    console.log(`Connected. Suite=${suite}. Request timeout=${REQUEST_TIMEOUT_MS}ms`);
    const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    const actualTools = listed.tools.map((tool) => tool.name).sort();
    const missing = expectedTools.filter((name) => !actualTools.includes(name));
    if (missing.length > 0) {
      throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
    }
    results.push({ tool: "list_tools", ok: true, message: `${actualTools.length} tools registered` });

    await callTool("joomla_login");

    if (runSuite("content")) {
      const initialCategories = await callTool("joomla_list_categories");
      const existingCategories = dataArray(initialCategories.data);
      if (existingCategories.length === 0) {
        throw new Error("No existing categories found to fall back to for article tests");
      }

      const createCategoryResult = await callTool("joomla_create_category", {
        title: categoryTitle,
        alias: categoryTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        description: "<p>Created by the MCP full-tool test.</p>",
        published: "1",
      });
      assertOperationEnvelope("joomla_create_category", createCategoryResult);

      const categoriesAfterCreate = await callTool("joomla_list_categories");
      const createdCategory = findByTitle(dataArray(categoriesAfterCreate.data), categoryTitle);
      if (!createdCategory?.id) {
        throw new Error(`Created category was not found in joomla_list_categories: ${categoryTitle}`);
      }

      await callTool("joomla_get_category", { id: createdCategory.id });
      const updateCategoryResult = await callTool("joomla_update_category", {
        id: createdCategory.id,
        title: updatedCategoryTitle,
        description: "<p>Updated by the MCP full-tool test.</p>",
        published: "1",
      });
      assertOperationEnvelope("joomla_update_category", updateCategoryResult);
      await callTool("joomla_checkin_category", { id: createdCategory.id });

      const updatedCategories = await callTool("joomla_list_categories");
      const updatedCategory = findByTitle(dataArray(updatedCategories.data), updatedCategoryTitle);
      if (!updatedCategory?.id) {
        throw new Error(`Updated category was not found in joomla_list_categories: ${updatedCategoryTitle}`);
      }

      const createArticleResult = await callTool("joomla_create_article", {
        title: articleTitle,
        categoryId: updatedCategory.id,
        introtext: "<p>Created by the MCP full-tool test.</p>",
        fulltext: "<p>Full text created by the MCP full-tool test.</p>",
        state: "0",
        access: "1",
      });
      assertOperationEnvelope("joomla_create_article", createArticleResult);

      const articlesAfterCreate = await callTool("joomla_list_articles");
      const createdArticle = findByTitle(dataArray(articlesAfterCreate.data), articleTitle);
      if (!createdArticle?.id) {
        throw new Error(`Created article was not found in joomla_list_articles: ${articleTitle}`);
      }

      await callTool("joomla_get_article", { id: createdArticle.id });
      const updateArticleResult = await callTool("joomla_update_article", {
        id: createdArticle.id,
        title: updatedArticleTitle,
        introtext: "<p>Updated by the MCP full-tool test.</p>",
        fulltext: "<p>Updated full text from the MCP full-tool test.</p>",
        state: "1",
      });
      assertOperationEnvelope("joomla_update_article", updateArticleResult);
      await callTool("joomla_checkin_article", { id: createdArticle.id });

      const articlesAfterUpdate = await callTool("joomla_list_articles");
      const updatedArticle = findByTitle(dataArray(articlesAfterUpdate.data), updatedArticleTitle);
      if (!updatedArticle?.id) {
        throw new Error(`Updated article was not found in joomla_list_articles: ${updatedArticleTitle}`);
      }

      const deleteArticleResult = await callTool("joomla_delete_article", { id: updatedArticle.id });
      assertOperationEnvelope("joomla_delete_article", deleteArticleResult);
      const deleteCategoryResult = await callTool("joomla_delete_category", { id: updatedCategory.id });
      assertOperationEnvelope("joomla_delete_category", deleteCategoryResult);
    }

    if (runSuite("modules")) {
      const modules = dataArray((await callTool("joomla_list_modules", { client_id: "0" })).data);
      if (modules.length === 0) throw new Error("No site modules found for module tests");
      await callTool("joomla_list_module_types", { client_id: "0" });
      await callTool("joomla_list_module_positions", { client_id: "0" });
      await callTool("joomla_inspect_module_type", { moduleType: "Custom", client_id: "0" });
      await callTool("joomla_list_gantry_particle_types");
      await callTool("joomla_inspect_gantry_particle", { particleType: "Joomla Articles" });

      const moduleForUpdate = modules[0];
      const originalModule = await callTool("joomla_get_module", { id: moduleForUpdate.id });
      const originalModuleData = originalModule.data as Record<string, string>;
      const originalTitle = originalModuleData.title || moduleForUpdate.title;
      const originalPublished = originalModuleData.published || (moduleForUpdate.state === "Published" ? "1" : "0");

      await callTool("joomla_update_module", {
      id: moduleForUpdate.id,
      title: `${originalTitle} MCP Updated`,
      published: originalPublished,
    });
      await callTool("joomla_update_module", {
      id: moduleForUpdate.id,
      title: originalTitle,
      published: originalPublished,
    });

      const moduleTitle = `MCP Full Tool Test Module ${startedAt}`;
      await callTool("joomla_create_module", {
      title: moduleTitle,
      moduleType: "Custom",
      published: "0",
      assignment: "-",
      content: "<p>Created by the MCP full-tool test.</p>",
      params: { prepare_content: "0" },
    });

      const modulesAfterCreate = dataArray((await callTool("joomla_list_modules", { client_id: "0" })).data);
      const createdModule = findByTitle(modulesAfterCreate, moduleTitle);
      if (!createdModule?.id) {
        throw new Error(`Created module was not found in joomla_list_modules: ${moduleTitle}`);
      }

      await callTool("joomla_get_module", { id: createdModule.id });
      await callTool("joomla_update_module", {
      id: createdModule.id,
      title: `${moduleTitle} Updated`,
      assignment: "0",
      params: { prepare_content: "1" },
    });
      const moduleToggleOn = await callTool("joomla_toggle_module", { id: createdModule.id, state: "1" });
      assertOperationEnvelope("joomla_toggle_module", moduleToggleOn);
      const moduleCheckin = await callTool("joomla_checkin_module", { id: createdModule.id });
      assertOperationEnvelope("joomla_checkin_module", moduleCheckin);
      const moduleToggleOff = await callTool("joomla_toggle_module", { id: createdModule.id, state: "0" });
      assertOperationEnvelope("joomla_toggle_module", moduleToggleOff);
      await callTool("joomla_delete_module", { id: createdModule.id });
    }

    if (runSuite("gantry")) {
      const gantryModuleTitle = `MCP Full Tool Test Gantry Particle ${startedAt}`;
      await callTool("joomla_create_gantry_particle_module", {
      title: gantryModuleTitle,
      particleType: "Block Content",
      particleTitle: "Block Content",
      position: "content-bottom-a",
      published: "0",
      assignment: "-",
      options: {
        source: "particle",
        subcontents: [
          {
            accent: "none",
            icon: "fas fa-check",
            img: "",
            rokboximage: "",
            rokboxcaption: "",
            subtitle: "",
            description: "Created by the MCP full-tool test.",
            class: "",
            button: "Test",
            buttonlink: "/",
            buttonclass: "",
            buttontarget: "_self",
            name: "Test",
          },
        ],
      },
    });

      const modulesAfterGantryCreate = dataArray((await callTool("joomla_list_modules", { client_id: "0" })).data);
      const createdGantryModule = findByTitle(modulesAfterGantryCreate, gantryModuleTitle);
      if (!createdGantryModule?.id) {
        throw new Error(`Created Gantry particle module was not found in joomla_list_modules: ${gantryModuleTitle}`);
      }

      await callTool("joomla_get_gantry_particle_module", { id: createdGantryModule.id });
      await callTool("joomla_update_gantry_particle_module", {
      id: createdGantryModule.id,
      title: `${gantryModuleTitle} Updated`,
      options: { headline: "Updated by full MCP tool test" },
    });
      await callTool("joomla_delete_module", { id: createdGantryModule.id });
    }

    if (runSuite("menus")) {
      const menus = dataArray((await callTool("joomla_list_menus")).data);
      if (menus.length === 0) throw new Error("No menus found for menu item test");

      const firstMenuType = menus[0].menuType || menus[0].title;
      await callTool("joomla_list_menu_items", { menuId: firstMenuType });
      const menuTypes = dataArray((await callTool("joomla_list_menu_item_types")).data);
      if (menuTypes.length === 0) throw new Error("No menu item types found");
      await callTool("joomla_inspect_menu_item_type", { itemType: "com_content.article" });

      const currentArticles = dataArray((await callTool("joomla_list_articles")).data);
      const articleForMenu = currentArticles[0];
      if (!articleForMenu?.id) throw new Error("No article found for Single Article menu item test");

      const menuItemTitle = `MCP Full Tool Test Menu Item ${startedAt}`;
      await callTool("joomla_create_menu_item", {
      title: menuItemTitle,
      menuType: firstMenuType,
      itemType: "com_content.article",
      request: { id: articleForMenu.id },
      published: "0",
    });

      const menuItemsAfterCreate = dataArray((await callTool("joomla_list_menu_items", { menuId: firstMenuType })).data);
      const createdMenuItem = findByTitle(menuItemsAfterCreate, menuItemTitle);
      if (!createdMenuItem?.id) {
        throw new Error(`Created menu item was not found in joomla_list_menu_items: ${menuItemTitle}`);
      }

      await callTool("joomla_get_menu_item", { id: createdMenuItem.id });
      await callTool("joomla_update_menu_item", {
      id: createdMenuItem.id,
      title: `${menuItemTitle} Updated`,
      note: "Updated by full MCP tool test",
    });
      const menuToggleOn = await callTool("joomla_toggle_menu_item", { id: createdMenuItem.id, state: "1", menuType: firstMenuType });
      assertOperationEnvelope("joomla_toggle_menu_item", menuToggleOn);
      const menuCheckin = await callTool("joomla_checkin_menu_item", { id: createdMenuItem.id, menuType: firstMenuType });
      assertOperationEnvelope("joomla_checkin_menu_item", menuCheckin);
      const menuToggleOff = await callTool("joomla_toggle_menu_item", { id: createdMenuItem.id, state: "0", menuType: firstMenuType });
      assertOperationEnvelope("joomla_toggle_menu_item", menuToggleOff);
      await callTool("joomla_delete_menu_item", { id: createdMenuItem.id });
    }

    if (runSuite("admin")) {
      await callTool("joomla_page_content", { path: "index.php?option=com_content&view=articles" });
    }

    console.log("\nFull Joomla MCP tool test completed.\n");
    for (const result of results) {
      console.log(`${result.ok ? "PASS" : "FAIL"} ${result.tool}: ${result.message}`);
    }
  } finally {
    await client.close();
  }
}

main().catch(async (error) => {
  console.error("\nFull Joomla MCP tool test failed.\n");
  for (const result of results) {
    console.error(`${result.ok ? "PASS" : "FAIL"} ${result.tool}: ${result.message}`);
  }
  if (error instanceof Error) {
    console.error(error.message);
    if (error.stack) console.error(error.stack);
  } else {
    console.error(error);
  }
  await client.close();
  process.exit(1);
});
