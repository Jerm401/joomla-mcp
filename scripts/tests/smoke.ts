import "dotenv/config";
import { JoomlaClient } from "../../src/joomla-client.js";

const config = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

async function main() {
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required Joomla config: ${missing.join(", ")}`);
  }

  const joomla = new JoomlaClient(config);

  const login = await joomla.login();
  console.log("login:", login.success, login.message);
  if (!login.success) return;

  const [articles, categories, modules, menus] = await Promise.all([
    joomla.listArticles(),
    joomla.listCategories(),
    joomla.listModules("0"),
    joomla.listMenus(),
  ]);

  console.log("articles:", articles.message);
  console.log("categories:", categories.message);
  console.log("site modules:", modules.message);
  console.log("menus:", menus.message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
