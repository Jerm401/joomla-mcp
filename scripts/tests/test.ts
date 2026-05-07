import "dotenv/config";
import { JoomlaClient } from "../../src/joomla-client.js";

const config = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

const joomla = new JoomlaClient(config);

async function test() {
  console.log("=== JOOMLA MCP TEST SUITE ===\n");
  console.log("Config:", { ...config, password: "***" });
  console.log("");

  // 1. Login
  console.log("--- TEST 1: LOGIN ---");
  const login = await joomla.login();
  console.log("Success:", login.success);
  console.log("Message:", login.message);
  if (login.html) console.log("HTML length:", login.html?.length);
  console.log("");

  if (!login.success) {
    console.log("LOGIN FAILED - cannot continue. Showing HTML preview:");
    console.log(login.html?.substring(0, 3000));
    return;
  }

  // 2. List Articles
  console.log("--- TEST 2: LIST ARTICLES ---");
  const articles = await joomla.listArticles();
  console.log("Success:", articles.success);
  console.log("Message:", articles.message);
  if (Array.isArray(articles.data)) {
    console.log("Count:", (articles.data as Array<unknown>).length);
    console.log("First 5:", JSON.stringify(articles.data, null, 2)?.substring(0, 2000));
  }
  console.log("");

  // 3. List Categories
  console.log("--- TEST 3: LIST CATEGORIES ---");
  const categories = await joomla.listCategories();
  console.log("Success:", categories.success);
  console.log("Message:", categories.message);
  if (Array.isArray(categories.data)) {
    console.log("Count:", (categories.data as Array<unknown>).length);
    console.log("Data:", JSON.stringify(categories.data, null, 2)?.substring(0, 2000));
  }
  console.log("");

  // 4. List Modules (site)
  console.log("--- TEST 4: LIST MODULES (site) ---");
  const modules = await joomla.listModules("0");
  console.log("Success:", modules.success);
  console.log("Message:", modules.message);
  if (Array.isArray(modules.data)) {
    console.log("Count:", (modules.data as Array<unknown>).length);
    console.log("Data:", JSON.stringify(modules.data, null, 2)?.substring(0, 3000));
  }
  console.log("");

  // 5. Get an article if we have any
  console.log("--- TEST 5: GET ARTICLE ---");
  const articleList = articles.data as Array<Record<string, string>> | undefined;
  if (articleList && articleList.length > 0 && articleList[0].id) {
    const article = await joomla.getArticle(articleList[0].id);
    console.log("Success:", article.success);
    console.log("Message:", article.message);
    console.log("Data:", JSON.stringify(article.data, null, 2)?.substring(0, 2000));
  } else {
    console.log("Skipped - no articles found");
  }
  console.log("");

  // 6. Get a category if we have any
  console.log("--- TEST 6: GET CATEGORY ---");
  const catList = categories.data as Array<Record<string, string>> | undefined;
  if (catList && catList.length > 0 && catList[0].id) {
    const cat = await joomla.getCategory(catList[0].id);
    console.log("Success:", cat.success);
    console.log("Message:", cat.message);
    console.log("Data:", JSON.stringify(cat.data, null, 2)?.substring(0, 2000));
  } else {
    console.log("Skipped - no categories found");
  }
  console.log("");

  // 7. Get a module if we have any
  console.log("--- TEST 7: GET MODULE ---");
  const modList = modules.data as Array<Record<string, string>> | undefined;
  if (modList && modList.length > 0 && modList[0].id) {
    const mod = await joomla.getModule(modList[0].id);
    console.log("Success:", mod.success);
    console.log("Message:", mod.message);
    console.log("Data:", JSON.stringify(mod.data, null, 2)?.substring(0, 2000));
  } else {
    console.log("Skipped - no modules found");
  }
  console.log("");

  // 8. List menus
  console.log("--- TEST 8: LIST MENUS ---");
  const menus = await joomla.listMenus();
  console.log("Success:", menus.success);
  console.log("Message:", menus.message);
  if (Array.isArray(menus.data)) {
    console.log("Count:", (menus.data as Array<unknown>).length);
    console.log("Data:", JSON.stringify(menus.data, null, 2)?.substring(0, 2000));
  }
  console.log("");

  // 9. Create a test article
  console.log("--- TEST 9: CREATE ARTICLE ---");
  if (catList && catList.length > 0 && catList[0].id) {
    const created = await joomla.createArticle({
      title: "MCP Test Article",
      categoryId: catList[0].id,
      introtext: "<p>This is a test article created via MCP.</p>",
      fulltext: "<p>Full content here.</p>",
      state: "0",
    });
    console.log("Success:", created.success);
    console.log("Message:", created.message);
    // Show snippet of HTML to see what happened
    if (created.html) {
      const htmlSnippet = created.html.substring(0, 3000);
      console.log("HTML preview:", htmlSnippet);
    }
  } else {
    console.log("Skipped - no categories found");
  }
  console.log("");

  console.log("=== TEST SUITE COMPLETE ===");
}

test().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
