import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { load as cheerioLoad } from "cheerio";
import puppeteer, { type Browser } from 'puppeteer';

export interface JoomlaConfig {
  baseUrl: string;
  username: string;
  password: string;
  moduleTypeBlacklist?: Set<string>;
}

export interface JoomlaResponse {
  success: boolean;
  message: string;
  data?: unknown;
  html?: string;
}

interface MenuItemType {
  group: string;
  label: string;
  description: string;
  encoded: string;
  title: string;
  request: Record<string, string>;
}

interface ModuleType {
  id: string;
  title: string;
  href: string;
  module?: string;
}

type FormValue = string | string[];
type FormDataMap = Record<string, FormValue>;
interface GantryLayoutNode {
  id?: string;
  title?: string;
  type?: string;
  subtype?: string;
  attributes?: Record<string, unknown>;
  children?: GantryLayoutNode[];
  layout?: boolean;
}

interface GantryCategoryReference {
  id: string;
  title: string;
}

interface GantryArticleReference {
  id: string;
  title: string;
  alias: string;
  categoryId: string;
  categoryTitle: string;
  introtext: string;
  fulltext: string;
  state: string;
  access: string;
}

interface GantryParticleReference {
  particleId: string;
  particleTitle: string;
  particleType: string;
  filterPath: string;
  categories: GantryCategoryReference[];
  articles: GantryArticleReference[];
}

interface AdminFieldDetails {
  name: string;
  id: string;
  kind: string;
  inputType: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  options?: Array<{ value: string; label: string; selected: boolean }>;
}

type JoomlaEntity = "article" | "category" | "module" | "menuItem";

interface ModuleBlueprint {
  kind: "joomla-module-blueprint";
  version: 1;
  exportedAt: string;
  source: {
    id: string;
    title: string;
    moduleType: string;
  };
  module: {
    title: string;
    moduleType: string;
    clientId: string;
    position: string;
    published: string;
    access: string;
    showtitle: string;
    ordering: string;
    style: string;
    language: string;
    note: string;
    assignment: string;
    assigned: string[];
    content?: string;
    params: Record<string, string>;
    advanced: Record<string, string>;
    fieldOverrides: Record<string, string>;
  };
}

export class JoomlaClient {
  private config: JoomlaConfig;
  private cookies: Map<string, string> = new Map();
  private tokenName: string | null = null;
  private _browser: Browser | null = null;
  /**
   * Cached Gantry 5 configuration entry URL (including CSRF token).
   * Populated on first successful navigation to the Gantry theme configure page
   * and reused for all subsequent calls within the same process lifetime.
   * This avoids the "stale snapshot" error caused by re-navigating to the
   * themes page (which can refresh the token) between snapshot and save.
   */
  private gantryEntryUrl: string | null = null;
  /** Per-outline layout URL cache: outline id → absolute URL. Once discovered, reused directly. */
  private gantryOutlineLayoutUrls: Map<string, string> = new Map();
  /** Per-outline layout root+preset cache. Populated on fetch; used to skip re-fetch in liveBefore check. Cleared on login and after successful save. */
  private gantryLayoutRootCache: Map<string, { root: GantryLayoutNode[]; preset: unknown }> = new Map();

  constructor(config: JoomlaConfig) {
    this.config = config;
  }

  getConfig(): JoomlaConfig {
    return { ...this.config };
  }

  switchSite(url: string): void {
    this.config.baseUrl = url;
    this.cookies.clear();
    this.tokenName = null;
    this.gantryEntryUrl = null;
    this.gantryOutlineLayoutUrls.clear();
    this.gantryLayoutRootCache.clear();
  }

  private getAdminUrl(path = ""): string {
    const siteBase = this.config.baseUrl.replace(/\/+$/, "");
    const base = /\/administrator$/i.test(siteBase) ? siteBase : `${siteBase}/administrator`;
    return `${base}/${path.replace(/^\/+/, "")}`;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/administrator\/?$/i, "").replace(/\/+$/, "");
  }

  private resolveUrl(path: string): string {
    if (path.startsWith("http")) return path;
    if (path.startsWith("/")) return this.getBaseUrl() + path;
    return this.getAdminUrl(path);
  }

  private buildEntityUrls(entity: JoomlaEntity, id: string): { editUrl: string; viewUrl: string } {
    switch (entity) {
      case "article":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`),
          viewUrl: `${this.getBaseUrl()}/index.php?option=com_content&view=article&id=${id}`,
        };
      case "category":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`),
          viewUrl: `${this.getBaseUrl()}/index.php?option=com_content&view=category&id=${id}`,
        };
      case "module":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`),
          viewUrl: "",
        };
      case "menuItem":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`),
          viewUrl: `${this.getBaseUrl()}/index.php?Itemid=${id}`,
        };
      default:
        return { editUrl: "", viewUrl: "" };
    }
  }

  private buildOperationData(
    entity: JoomlaEntity,
    id: string,
    data: {
      title?: string;
      state?: string;
      warnings?: string[];
      verification?: Record<string, unknown>;
      [key: string]: unknown;
    }
  ): Record<string, unknown> {
    const { editUrl, viewUrl } = this.buildEntityUrls(entity, id);
    return {
      id,
      title: data.title || "",
      state: data.state || "",
      editUrl,
      viewUrl,
      warnings: data.warnings || [],
      verification: data.verification || { attempted: false },
      ...data,
    };
  }

  private findLatestByTitle(items: Array<Record<string, string>>, title: string): Record<string, string> | null {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].title === title) return items[i];
    }
    return null;
  }

  private getCookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private parseSetCookie(header: string): void {
    if (!header) return;
    // Handle multiple set-cookie headers (semicolon-separated in some cases)
    const cookies = header.split(", ").length > 1 ? header.split(", ") : [header];
    for (const cookie of cookies) {
      const parts = cookie.split(";")[0];
      const eqIdx = parts.indexOf("=");
      if (eqIdx > 0) {
        const name = parts.substring(0, eqIdx).trim();
        const value = parts.substring(eqIdx + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }

  private extractCsrfToken(html: string): { name: string; value: string } | null {
    // Method 1: Extract from JS options JSON
    const jsMatch = html.match(/"csrf\.token"\s*:\s*"([a-f0-9]+)"/);
    if (jsMatch) {
      return { name: jsMatch[1], value: "1" };
    }

    // Method 2: Extract from hidden input with CSRF_TOKEN markers
    const markerMatch = html.match(/CSRF_TOKEN_START[^>]*<input[^>]*name="([a-f0-9]+)"[^>]*value="([^"]*)"/);
    if (markerMatch) {
      return { name: markerMatch[1], value: markerMatch[2] };
    }

    // Method 3: Extract from any hidden input with hex name
    const $ = this.$c(html);
    const tokenInput = $("input[type='hidden']").filter((_, el) =>
      /^[a-f0-9]{32}$/.test($(el).attr("name") || "")
    ).first();
    if (tokenInput.length) {
      return { name: tokenInput.attr("name")!, value: tokenInput.attr("value") ?? "" };
    }

    return null;
  }

  private getFormUrlEncoded(data: FormDataMap): string {
    return Object.entries(data)
      .flatMap(([key, value]) => {
        const values = Array.isArray(value) ? value : [value];
        return values.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      })
      .join("&");
  }

  private $c(html: string) {
    return cheerioLoad(html);
  }

  private getSelectedValue(selectHtml: string): string {
    const $ = this.$c(selectHtml);
    const selected = $("option[selected]").first();
    return selected.length
      ? (selected.attr("value") ?? "")
      : ($("option").first().attr("value") ?? "");
  }

  private extractFormFields(html: string, formId = "adminForm"): Record<string, string> {
    const $ = this.$c(html);
    const form = $(`form[id="${formId}"]`);
    const find = (sel: string) => form.length ? form.find(sel) : $(sel);
    const fields: Record<string, string> = {};

    find("input").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const type = ($el.attr("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return;
      if ((type === "checkbox" || type === "radio") && !$el.is("[checked]")) return;
      fields[name] = $el.attr("value") ?? "";
    });

    find("textarea").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (name) fields[name] = $el.text();
    });

    find("select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const selected = $el.find("option[selected]").first();
      fields[name] = selected.length
        ? (selected.attr("value") ?? "")
        : ($el.find("option").first().attr("value") ?? "");
    });

    return fields;
  }

  private getJFormField(fields: Record<string, string>, key: string, fallback = ""): string {
    return fields[`jform[${key}]`] ?? fields[`jform_${key}`] ?? fallback;
  }

  private extractCheckedValues(html: string, name: string): string[] {
    const $ = this.$c(html);
    return $(`input[name="${name}"][checked]`).map((_, el) => $(el).attr("value") ?? "").get();
  }

  private extractSelectOptions(html: string, selectId: string): Array<{ value: string; label: string; selected: boolean }> {
    const $ = this.$c(html);
    const select = $(`select[id="${selectId}"]`);
    if (!select.length) return [];
    return select.find("option").map((_, el) => {
      const $el = $(el);
      return {
        value: $el.attr("value") ?? "",
        label: $el.text().trim(),
        selected: $el.is("[selected]"),
      };
    }).get();
  }

  private stripHtml(value: string): string {
    return this.$c(value).text().replace(/\s+/g, " ").trim();
  }

  private extractPublishedState(row: string): string {
    if (/listItemTask\('[^']+','[^']+\.unpublish'\)/.test(row)) return "Published";
    if (/listItemTask\('[^']+','[^']+\.publish'\)/.test(row)) return "Unpublished";
    if (/icon-unpublish/.test(row)) return "Published";
    if (/icon-publish/.test(row)) return "Unpublished";
    if (/listItemTask\('[^']+','[^']+\.trash'\)/.test(row) || /icon-trash/.test(row)) return "Trashed";
    return "Unknown";
  }

  private parseMenuItemTypePayload(encoded: string): { title: string; request: Record<string, string> } | null {
    try {
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        title?: unknown;
        request?: Record<string, unknown>;
      };
      const request: Record<string, string> = {};
      for (const [key, value] of Object.entries(decoded.request || {})) {
        request[key] = String(value);
      }
      return {
        title: String(decoded.title || ""),
        request,
      };
    } catch {
      return null;
    }
  }

  private buildLinkFromRequest(request: Record<string, string>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) {
      if (value !== "") params.set(key, value);
    }
    return `index.php?${params.toString()}`;
  }

  private buildArticleText(introtext = "", fulltext = ""): string {
    if (!fulltext) return introtext;
    return `${introtext}<hr id="system-readmore" />${fulltext}`;
  }

  private normalizeRichText(value: string): string {
    return this.decodeHtmlEntities(String(value || ""))
      .replace(/\r\n?/g, "\n")
      .replace(/<hr\b[^>]*\bid=["']system-readmore["'][^>]*\/?>/gi, '<hr id="system-readmore" />')
      .replace(/>\s+</g, "><")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isEquivalentRichText(actual: string, expected: string): boolean {
    return this.normalizeRichText(actual) === this.normalizeRichText(expected);
  }

  private verifyAlias(actual: string, requested?: string): boolean {
    if (requested && requested.trim()) {
      return actual === requested;
    }
    return actual.trim().length > 0;
  }

  private shouldVerifyAssignedMembers(assignment: string): boolean {
    return assignment === "1" || assignment === "-1";
  }

  private isDeletionVerified(stillListed: boolean, verify: JoomlaResponse, stateFieldNames: string[]): boolean {
    if (stillListed) return false;
    if (!verify.success) return true;
    const record = (verify.data || {}) as Record<string, unknown>;
    return stateFieldNames.some((fieldName) => String(record[fieldName] || "") === "-2");
  }

  private isCheckInVerified(successMsg: boolean, verify: JoomlaResponse, checkedOutCleared: boolean): boolean {
    return verify.success && (checkedOutCleared || successMsg);
  }

  private splitArticleText(articletext: string): { introtext: string; fulltext: string } {
    const readmore = /<hr\b[^>]*\bid=["']system-readmore["'][^>]*>/i;
    const parts = articletext.split(readmore);
    return {
      introtext: parts[0] || "",
      fulltext: parts.slice(1).join("") || "",
    };
  }

  private getMenuItemsListUrl(menuType?: string): string {
    const params = new URLSearchParams({
      option: "com_menus",
      view: "items",
      limit: "0",
    });
    if (menuType) params.set("menutype", menuType);
    return this.getAdminUrl(`index.php?${params.toString()}`);
  }

  private parseMenuItemTypes(html: string): MenuItemType[] {
    const $ = this.$c(html);
    const types: MenuItemType[] = [];
    $(".accordion-heading").each((_, headingEl) => {
      const group = $(headingEl).text().trim();
      const container = $(headingEl).closest(".accordion-group, .accordion-inner, .accordion");
      const links = container.length
        ? container.find("ul.nav-stacked a")
        : $(headingEl).nextAll("ul.nav-stacked").first().find("a");
      links.each((_, linkEl) => {
        const $link = $(linkEl);
        const onclick = $link.attr("onclick") || "";
        const encodedMatch = onclick.match(/setmenutype\('([^']+)'\)/);
        if (!encodedMatch) return;
        const encoded = encodedMatch[1];
        const payload = this.parseMenuItemTypePayload(encoded);
        if (!payload) return;
        types.push({
          group,
          label: $link.text().trim(),
          description: $link.attr("title") || "",
          encoded,
          title: payload.title,
          request: payload.request,
        });
      });
    });
    return types;
  }

  private findMenuItemType(types: MenuItemType[], itemType: string): MenuItemType | null {
    const lowered = itemType.toLowerCase();
    const decoded = this.parseMenuItemTypePayload(itemType);
    if (decoded) {
      return {
        group: "",
        label: decoded.title,
        description: "",
        encoded: itemType,
        title: decoded.title,
        request: decoded.request,
      };
    }

    return types.find((type) => {
      const requestKey = [type.request.option, type.request.view, type.request.layout].filter(Boolean).join(".");
      return (
        type.label.toLowerCase() === lowered ||
        type.title.toLowerCase() === lowered ||
        requestKey.toLowerCase() === lowered
      );
    }) || null;
  }

  private parseMenuItemForm(html: string): Record<string, unknown> {
    const adminForms = this.parseAdminForms(html, "item-form");
    const form = adminForms[0] as Record<string, unknown> | undefined;
    const fields = (form?.values || {}) as Record<string, string>;
    const fieldDetails = (form?.fields || []) as AdminFieldDetails[];

    const item: Record<string, unknown> = {};
    const request: Record<string, string> = {};
    const params: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      const requestMatch = key.match(/^jform\[request\]\[([^\]]+)\]$/);
      const paramsMatch = key.match(/^jform\[params\]\[([^\]]+)\]$/);
      if (requestMatch) request[requestMatch[1]] = value;
      if (paramsMatch) params[paramsMatch[1]] = value;
    }

    item.id = this.getJFormField(fields, "id");
    item.title = this.getJFormField(fields, "title");
    item.alias = this.getJFormField(fields, "alias");
    item.menuType = this.getJFormField(fields, "menutype");
    item.type = this.getJFormField(fields, "type");
    item.link = this.getJFormField(fields, "link");
    item.parentId = this.getJFormField(fields, "parent_id", "1");
    item.published = this.getJFormField(fields, "published", "1");
    item.access = this.getJFormField(fields, "access", "1");
    item.language = this.getJFormField(fields, "language", "*");
    item.browserNav = this.getJFormField(fields, "browserNav", "0");
    item.home = this.getJFormField(fields, "home", "0");
    item.note = this.getJFormField(fields, "note");
    item.templateStyleId = fields["jform[template_style_id]"] ?? "0";
    item.templateStyleOptions = fieldDetails.find((f) => f.name === "jform[template_style_id]")?.options ?? [];
    item.request = request;
    item.params = params;
    return item;
  }

  private looksLoggedIn(html: string): boolean {
    return !html.includes("mod-login-username") && (
      html.includes("option=com_login&amp;task=logout") ||
      html.includes("option=com_login&task=logout") ||
      html.includes("task=logout") ||
      html.includes("com_cpanel") ||
      html.includes("com_dashboard") ||
      html.includes("submenu") ||
      html.includes("navbar")
    );
  }

  private async request(
    url: string,
    options?: { method?: string; body?: string | FormData; contentType?: string }
  ): Promise<{ status: number; headers: Map<string, string>; body: string }> {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }

    // Don't set Content-Type for FormData — fetch sets it with the multipart boundary
    if (options?.contentType && !(options.body instanceof FormData)) {
      headers["Content-Type"] = options.contentType;
    }

    const fetchOptions: RequestInit = {
      method: options?.method || "GET",
      headers,
      body: options?.body as string | FormData | undefined,
      redirect: "manual",
    };

    const response = await fetch(url, fetchOptions);

    // Parse response headers
    const responseHeaders = new Map<string, string>();
    response.headers.forEach((value, key) => {
      responseHeaders.set(key.toLowerCase(), value);
    });

    // Update cookies
    const setCookie = responseHeaders.get("set-cookie");
    if (setCookie) {
      this.parseSetCookie(setCookie);
    }

    const body = await response.text();
    return { status: response.status, headers: responseHeaders, body };
  }

  private async getPage(url: string): Promise<{ html: string; token: { name: string; value: string } | null }> {
    const result = await this.request(url);

    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get("location") || url;
      const redirectUrl = this.resolveUrl(location);
      return this.getPage(redirectUrl);
    }

    const token = this.extractCsrfToken(result.body);
    if (token) {
      this.tokenName = token.name;
    }

    return { html: result.body, token };
  }

  private async postPage(
    url: string,
    formData: FormDataMap
  ): Promise<{ status: number; html: string; redirected: boolean }> {
    // First, get the page to ensure we have a fresh token
    const pageResult = await this.getPage(url);

    // Inject/refresh token
    const token = this.extractCsrfToken(pageResult.html);
    if (token) {
      formData[token.name] = token.value;
      this.tokenName = token.name;
    } else if (this.tokenName) {
      formData[this.tokenName] = "1";
    }

    const formBody = this.getFormUrlEncoded(formData);
    const result = await this.request(url, {
      method: "POST",
      body: formBody,
      contentType: "application/x-www-form-urlencoded",
    });

    // Follow redirect
    if (result.status === 302 || result.status === 303) {
      const location = result.headers.get("location") || url;
      const redirectUrl = this.resolveUrl(location);
      const redirectResult = await this.request(redirectUrl);
      return {
        status: redirectResult.status,
        html: redirectResult.body,
        redirected: true,
      };
    }

    return { status: result.status, html: result.body, redirected: false };
  }

  private getSnapshotDir(): string {
    return path.resolve(process.cwd(), "snapshots");
  }

  private getBlueprintDir(kind = ""): string {
    return path.resolve(process.cwd(), "blueprints", kind);
  }

  private getSnapshotPath(snapshotId: string): string {
    const safeId = snapshotId.replace(/[^a-zA-Z0-9_.-]/g, "");
    return path.join(this.getSnapshotDir(), `${safeId}.json`);
  }

  private writeSnapshot(data: Record<string, unknown>): Record<string, unknown> {
    mkdirSync(this.getSnapshotDir(), { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(data.kind || "snapshot")}-${randomUUID().slice(0, 8)}`;
    const snapshot = {
      ...data,
      id,
      snapshotId: id,
      createdAt: new Date().toISOString(),
    };
    const filePath = this.getSnapshotPath(id);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    return { ...snapshot, filePath };
  }

  private readSnapshot(snapshotId: string): Record<string, unknown> | null {
    const filePath = this.getSnapshotPath(snapshotId);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  }

  private normalizeAdminPath(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("/")) return pathOrUrl;
    return pathOrUrl || "index.php";
  }

  private adminPathToUrl(pathOrUrl: string): string {
    const normalized = this.normalizeAdminPath(pathOrUrl);
    return this.resolveUrl(normalized);
  }

  private formActionToUrl(action: string, fallbackUrl: string): string {
    if (!action) return fallbackUrl;
    return this.resolveUrl(action);
  }

  private getLabelFor(html: string, id: string): string {
    if (!id) return "";
    return this.$c(html)(`label[for="${id}"]`).first().text().trim();
  }

  private parseAdminFields(formHtml: string): AdminFieldDetails[] {
    const $ = this.$c(formHtml);
    const fields: AdminFieldDetails[] = [];

    $("input").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const inputType = ($el.attr("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(inputType)) return;
      const id = $el.attr("id") || "";
      fields.push({
        name,
        id,
        kind: "input",
        inputType,
        value: $el.attr("value") || "",
        checked: $el.is("[checked]"),
        disabled: $el.is("[disabled]"),
        label: this.getLabelFor(formHtml, id),
      });
    });

    $("textarea").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      fields.push({
        name,
        id,
        kind: "textarea",
        inputType: "textarea",
        value: $el.text(),
        disabled: $el.is("[disabled]"),
        label: this.getLabelFor(formHtml, id),
      });
    });

    $("select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      const options = $el.find("option").map((_, opt) => {
        const $opt = $(opt);
        return {
          value: $opt.attr("value") || "",
          label: $opt.text().trim(),
          selected: $opt.is("[selected]"),
        };
      }).get();
      const selected = $el.find("option[selected]").first();
      fields.push({
        name,
        id,
        kind: "select",
        inputType: $el.is("[multiple]") ? "select-multiple" : "select",
        value: selected.length ? (selected.attr("value") ?? "") : ($el.find("option").first().attr("value") ?? ""),
        disabled: $el.is("[disabled]"),
        label: this.getLabelFor(formHtml, id),
        options,
      });
    });

    return fields;
  }

  private formValuesFromDetails(fields: AdminFieldDetails[]): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of fields) {
      if (field.disabled) continue;
      if ((field.inputType === "checkbox" || field.inputType === "radio") && !field.checked) continue;
      values[field.name] = field.value;
    }
    return values;
  }

  private parseAdminForms(html: string, preferredFormId?: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const forms: Array<Record<string, unknown>> = [];
    $("form").each((_, el) => {
      const $form = $(el);
      const id = $form.attr("id") || "";
      if (preferredFormId && id !== preferredFormId) return;
      const formHtml = $.html($form) || "";
      const fields = this.parseAdminFields(formHtml);
      forms.push({
        id,
        name: $form.attr("name") || "",
        action: $form.attr("action") || "",
        method: ($form.attr("method") || "get").toLowerCase(),
        fieldCount: fields.length,
        fields,
        values: this.formValuesFromDetails(fields),
      });
    });
    return forms;
  }

  private extractAlertMessage(html: string): string | null {
    const text = this.$c(html)('[class*="alert-message"]').first().text().trim();
    return text || null;
  }

  private parseAdminLinks(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const links: Array<Record<string, string>> = [];
    $("a[href]").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      if (!href.includes("index.php")) return;
      const label = $el.text().trim();
      if (label) links.push({ label, href });
    });
    return links;
  }

  private parseToolbarTasks(html: string): string[] {
    const tasks = new Set<string>();
    for (const match of html.matchAll(/Joomla\.submitbutton\(['"]([^'"]+)['"]\)/gi)) tasks.add(match[1]);
    for (const match of html.matchAll(/submitbutton\(['"]([^'"]+)['"]\)/gi)) tasks.add(match[1]);
    for (const match of html.matchAll(/task=([a-z0-9_.-]+)/gi)) tasks.add(this.decodeHtml(match[1]));
    return Array.from(tasks).sort();
  }

  private parseAdminTableRows(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const rows: Array<Record<string, unknown>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const rowHtml = $.html($row) || "";
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const editLink = $row.find("a[href*='layout=edit'], a[href*='.edit']").first();
      const title = editLink.length
        ? editLink.text().trim()
        : $row.find("a").first().text().trim();
      rows.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml),
        rawText: $row.text().replace(/\s+/g, " ").trim().slice(0, 500),
      });
    });
    return rows;
  }

  private inferRestoreTask(kind: string, pathOrUrl?: string): string {
    const path = pathOrUrl || "";
    if (kind === "article" || /option=com_content/.test(path)) return "article.save";
    if (kind === "category" || /option=com_categories/.test(path)) return "category.save";
    if (kind === "menuItem" || /option=com_menus.*view=item|task=item/.test(path)) return "item.save";
    if (kind === "module" || /option=com_modules/.test(path)) return "module.save";
    if (kind === "menu" || /option=com_menus.*view=menu/.test(path)) return "menu.save";
    return "";
  }

  private getStableFormIdentity(values: Record<string, string>): Record<string, string> {
    const identityKeys = [
      "id",
      "jform[id]",
      "jform[module]",
      "jform[client_id]",
      "jform[menutype]",
      "jform[type]",
      "jform[extension]",
      "jform[catid]",
      "jform[parent_id]",
      "option",
      "view",
      "layout",
    ];
    const identity: Record<string, string> = {};
    for (const key of identityKeys) {
      if (typeof values[key] === "string" && values[key] !== "") {
        identity[key] = values[key];
      }
    }
    return identity;
  }

  private getRestorableVerificationFields(values: Record<string, string>): Record<string, string> {
    const allowedExactKeys = new Set([
      "jform[title]",
      "jform[alias]",
      "jform[note]",
      "jform[articletext]",
      "jform[description]",
      "jform[content]",
      "jform[catid]",
      "jform[parent_id]",
      "jform[state]",
      "jform[published]",
      "jform[access]",
      "jform[language]",
      "jform[module]",
      "jform[client_id]",
      "jform[position]",
      "jform[showtitle]",
      "jform[ordering]",
      "jform[style]",
      "jform[assignment]",
      "jform[menutype]",
      "jform[type]",
      "jform[link]",
      "jform[browserNav]",
      "jform[home]",
      "jform[publish_up]",
      "jform[publish_down]",
    ]);
    const allowedPrefixes = ["jform[request][", "jform[params][", "jform[advanced]["];
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!allowedExactKeys.has(key) && !allowedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
      result[key] = value;
    }
    return result;
  }

  private matchesVerificationField(key: string, actualValue: string, expectedValue: string): boolean {
    if (key === "jform[articletext]" || key === "jform[description]" || key === "jform[content]") {
      return this.isEquivalentRichText(actualValue, expectedValue);
    }
    return String(actualValue || "") === String(expectedValue || "");
  }

  // ==================== BACKEND DISCOVERY / SAFETY ====================

  async backendInventory(): Promise<JoomlaResponse> {
    const { html } = await this.getPage(this.getAdminUrl("index.php"));
    const adminLinks = this.parseAdminLinks(html)
      .filter((link) => !/logout|task=logout|https?:\/\//i.test(link.href))
      .filter((link, index, links) => links.findIndex((item) => item.href === link.href) === index);

    const components = Array.from(new Set(adminLinks.flatMap((link) =>
      Array.from(link.href.matchAll(/option=(com_[a-z0-9_]+)/gi)).map((match) => match[1])
    ))).sort();

    const moduleTypes = await this.listModuleTypes("0");
    const menuItemTypes = await this.listMenuItemTypes();
    const gantryOutlines = await this.listGantry5Outlines();
    const keyForms = [
      ["Article Add", "index.php?option=com_content&task=article.add", "item-form"],
      ["Category Add", "index.php?option=com_categories&task=category.add&extension=com_content", "item-form"],
      ["Menu Item Add", "index.php?option=com_menus&view=item&layout=edit&menutype=mainmenu", "item-form"],
      ["Module List", "index.php?option=com_modules&view=modules", "adminForm"],
      ["Media", "index.php?option=com_media", ""],
      ["Sponsors", "index.php?option=com_sponsors&view=sponsors", "adminForm"],
      ["DOCman Documents", "index.php?option=com_docman", ""],
      ["Redirects", "index.php?option=com_redir", "adminForm"],
      ["Site Config", "index.php?option=com_siteconfig", "application-form"],
    ].map(([label, path, formId]) => ({ label, path, formId }));

    return {
      success: true,
      message: `Found ${components.length} components, ${adminLinks.length} admin links`,
      data: {
        components,
        adminLinks,
        moduleTypes: moduleTypes.data,
        menuItemTypes: menuItemTypes.data,
        gantryOutlines: (gantryOutlines.data as Record<string, unknown> | undefined)?.outlines || [],
        keyForms,
      },
    };
  }

  async inspectAdminForm(pathOrUrl: string, formId?: string): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, formId);
    return {
      success: forms.length > 0,
      message: forms.length > 0 ? `Found ${forms.length} form(s)` : "No forms found",
      data: {
        path: pathOrUrl,
        url,
        csrfTokenName: token?.name || this.tokenName,
        toolbarTasks: this.parseToolbarTasks(html),
        forms,
      },
      html: html.substring(0, 50000),
    };
  }

  async inspectAdminList(pathOrUrl: string, formId = "adminForm"): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, formId);
    const $page = this.$c(html);
    const headers = $page("th").map((_, el) => $page(el).text().trim()).get().filter(Boolean);
    const rows = this.parseAdminTableRows(html);
    return {
      success: true,
      message: `Found ${rows.length} row(s)`,
      data: {
        path: pathOrUrl,
        url,
        csrfTokenName: token?.name || this.tokenName,
        toolbarTasks: this.parseToolbarTasks(html),
        headers: Array.from(new Set(headers)),
        filters: forms[0] || null,
        rows,
      },
    };
  }

  async submitAdminForm(pathOrUrl: string, data: {
    formId?: string;
    overrides?: Record<string, string>;
    task?: string;
    dryRun?: boolean;
    confirm?: boolean;
    expectedAction?: string;
    expectedIdentity?: Record<string, string>;
    verifyFields?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, data.formId);
    const form = forms[0] as Record<string, unknown> | undefined;
    if (!form) return { success: false, message: "No matching form found" };

    const fields = (form.values || {}) as Record<string, string>;
    const action = this.formActionToUrl(String(form.action || ""), url);
    const currentIdentity = this.getStableFormIdentity(fields);
    if (data.expectedAction && action !== this.resolveUrl(data.expectedAction)) {
      return {
        success: false,
        message: `Refusing to submit form because the current action no longer matches the snapshot target`,
        data: {
          path: pathOrUrl,
          expectedAction: this.resolveUrl(data.expectedAction),
          actualAction: action,
        },
      };
    }
    if (data.expectedIdentity) {
      for (const [key, expectedValue] of Object.entries(data.expectedIdentity)) {
        if (String(currentIdentity[key] || "") !== String(expectedValue || "")) {
          return {
            success: false,
            message: `Refusing to submit form because the current target no longer matches the snapshot identity`,
            data: {
              path: pathOrUrl,
              key,
              expectedValue,
              actualValue: String(currentIdentity[key] || ""),
            },
          };
        }
      }
    }

    const payload: Record<string, string> = {
      ...fields,
      ...(data.overrides || {}),
    };
    if (data.task) payload.task = data.task;
    if (token) payload[token.name] = token.value;
    else if (this.tokenName) payload[this.tokenName] = "1";
    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: form payload prepared" : "Form payload prepared; set confirm=true to submit",
        data: { path: pathOrUrl, action, method: form.method, payload, expectedIdentity: data.expectedIdentity || null },
      };
    }

    const result = await this.request(action, {
      method: "POST",
      body: this.getFormUrlEncoded(payload),
      contentType: "application/x-www-form-urlencoded",
    });
    const successMsg = /saved|success|updated|created|published|unpublished/i.test(result.body) && !/alert-error|alert-danger/i.test(result.body);
    const verify = await this.inspectAdminForm(pathOrUrl, data.formId);
    const verifyData = (verify.data || {}) as Record<string, unknown>;
    const verifyForms = (verifyData.forms || []) as Array<Record<string, unknown>>;
    const verifyForm = verifyForms[0];
    const verifyValues = ((verifyForm?.values || {}) as Record<string, string>);
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success && !!verifyForm,
      fieldsMatched: !!verifyForm && Object.entries(data.verifyFields || {}).every(([key, expectedValue]) => this.matchesVerificationField(key, String(verifyValues[key] || ""), String(expectedValue || ""))),
      successMsg,
    };
    const success = verification.readbackSucceeded && verification.fieldsMatched;
    return {
      success,
      message: success ? "Form submitted" : successMsg ? "Form submitted, but readback verification failed" : "Form submitted; verify result",
      data: {
        status: result.status,
        action,
        task: payload.task || "",
        verification,
      },
      html: result.body.substring(0, 50000),
    };
  }

  async snapshotTarget(data: {
    kind: string;
    id?: string;
    path?: string;
    formId?: string;
    outline?: string;
    theme?: string;
  }): Promise<JoomlaResponse> {
    const kind = data.kind;
    let snapshotData: Record<string, unknown>;
    if (kind === "gantryLayout") {
      const layout = await this.getGantry5Layout(data.outline || "default", { theme: data.theme, includeRaw: true });
      snapshotData = {
        kind,
        outline: data.outline || "default",
        theme: this.getGantryThemeKey(data.theme),
        payload: layout.data,
      };
    } else {
      const targetPath = data.path || (
        kind === "article" ? `index.php?option=com_content&task=article.edit&id=${data.id}` :
        kind === "category" ? `index.php?option=com_categories&task=category.edit&id=${data.id}` :
        kind === "menuItem" ? `index.php?option=com_menus&task=item.edit&id=${data.id}` :
        kind === "module" ? `index.php?option=com_modules&task=module.edit&id=${data.id}` :
        ""
      );
      if (!targetPath) return { success: false, message: "Snapshot requires path or supported kind/id" };
      const inspected = await this.inspectAdminForm(targetPath, data.formId);
      snapshotData = {
        kind,
        targetId: data.id || "",
        path: targetPath,
        formId: data.formId || "",
        restoreTask: this.inferRestoreTask(kind, targetPath),
        payload: inspected.data,
      };
    }

    const snapshot = this.writeSnapshot(snapshotData);
    return {
      success: true,
      message: "Snapshot saved",
      data: {
        ...snapshot,
        snapshotId: String(snapshot.id || ""),
      },
    };
  }

  async restoreSnapshot(snapshotId: string, options: { confirm?: boolean; task?: string } = {}): Promise<JoomlaResponse> {
    const snapshot = this.readSnapshot(snapshotId);
    if (!snapshot) return { success: false, message: `Snapshot not found: ${snapshotId}` };
    if (!options.confirm) {
      return {
        success: true,
        message: "Dry run: snapshot found; set confirm=true to restore",
        data: snapshot,
      };
    }

    if (snapshot.kind === "gantryLayout") {
      const payload = snapshot.payload as Record<string, unknown>;
      return this.saveGantry5LayoutRaw(String(snapshot.outline || "default"), {
        root: payload.root || (payload.layout as Record<string, unknown> | undefined)?.root,
        preset: payload.preset,
        snapshotId,
        theme: String(snapshot.theme || "rt_studius"),
      });
    }

    const payload = snapshot.payload as Record<string, unknown>;
    const forms = ((payload as Record<string, unknown>).forms || []) as Array<Record<string, unknown>>;
    const form = forms[0];
    if (!form) return { success: false, message: "Snapshot does not contain a restorable form" };
    const snapshotValues = (form.values || {}) as Record<string, string>;
    return this.submitAdminForm(String(snapshot.path || ""), {
      formId: String(snapshot.formId || form.id || ""),
      overrides: snapshotValues,
      task: options.task || String(snapshot.restoreTask || ""),
      confirm: true,
      expectedAction: String(form.action || ""),
      expectedIdentity: this.getStableFormIdentity(snapshotValues),
      verifyFields: this.getRestorableVerificationFields(snapshotValues),
    });
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private parseMenuTreeText(text: string): Array<Record<string, unknown>> {
    const roots: Array<Record<string, unknown>> = [];
    const stack: Array<{ indent: number; node: Record<string, unknown> }> = [];
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const indent = rawLine.match(/^\s*/)?.[0].replace(/\t/g, "    ").length || 0;
      const clean = rawLine.trim().replace(/^[-*]\s+/, "");
      const grid = /\[grid\]/i.test(clean);
      const unpublished = /\b(unpublish|unpublished|coming soon)\b/i.test(clean);
      const title = clean.replace(/\s*\[grid\]\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
      const note = clean.match(/\(([^)]*)\)/)?.[1] || "";
      const node: Record<string, unknown> = { title, note, grid, unpublished, children: [] };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) {
        ((stack[stack.length - 1].node.children as Array<Record<string, unknown>>) || []).push(node);
      } else {
        roots.push(node);
      }
      stack.push({ indent, node });
    }
    return roots;
  }

  private normalizeMenuTree(menuTree: unknown): Array<Record<string, unknown>> {
    if (typeof menuTree === "string") return this.parseMenuTreeText(menuTree);
    if (Array.isArray(menuTree)) return menuTree as Array<Record<string, unknown>>;
    return [];
  }

  private buildSiteBuildPlan(data: {
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
  }): Record<string, unknown> {
    const suffix = this.slugify(data.suffix || data.siteCode || "site");
    const menuTitle = data.menuTitle || `Main Menu ${suffix.toUpperCase()}`;
    const menuType = data.menuType || `main-menu-${suffix}`.slice(0, 24);
    const pageContentCategory = data.pageContentCategory || "Page Content (Menu Item Needed)";
    const homeCategory = data.homeCategory || "__ Catholic";
    const tree = this.normalizeMenuTree(data.menuTree);
    const operations: Array<Record<string, unknown>> = [
      { type: "ensureCategory", key: "pageContent", title: pageContentCategory, published: "1" },
      { type: "ensureCategory", key: "homeCategory", title: homeCategory, published: "1" },
      { type: "ensureMenu", title: menuTitle, menuType },
    ];

    const walk = (nodes: Array<Record<string, unknown>>, parentKey = "root", gridAncestorCategory = "", depth = 0) => {
      for (const node of nodes) {
        const title = String(node.title || "").trim();
        if (!title) continue;
        const alias = `${this.slugify(title)}-${suffix}`;
        const key = `${parentKey}/${alias}`;
        const isHome = depth === 0 && title.toLowerCase() === "home";
        const gridCategory = node.grid ? `${title} Items` : gridAncestorCategory;
        if (node.grid) operations.push({ type: "ensureCategory", key: `grid:${title}`, title: gridCategory, published: "1" });

        if (isHome) {
          operations.push({
            type: "ensureMenuItem",
            key,
            title,
            alias,
            menuType,
            parentKey,
            itemType: "COM_CONTENT_CATEGORY_VIEW_BLOG_TITLE",
            request: { id: "{homeCategoryId}" },
            published: "1",
            home: "1",
          });
        } else {
          const articleCategory = gridAncestorCategory || pageContentCategory;
          operations.push({
            type: "ensureArticle",
            key: `article:${key}`,
            title,
            alias,
            categoryTitle: articleCategory,
            state: node.unpublished ? "0" : "1",
            content: `<h1>${title}</h1>`,
          });
          operations.push({
            type: "ensureMenuItem",
            key,
            title,
            alias,
            menuType,
            parentKey,
            itemType: "COM_CONTENT_ARTICLE_VIEW_DEFAULT_TITLE",
            request: { id: `{article:${key}}` },
            published: node.unpublished ? "0" : "1",
          });
        }
        walk((node.children || []) as Array<Record<string, unknown>>, key, gridCategory, depth + 1);
      }
    };
    walk(tree);

    return {
      generatedAt: new Date().toISOString(),
      suffix,
      menuTitle,
      menuType,
      pageContentCategory,
      homeCategory,
      tree,
      operations,
    };
  }

  async planSiteBuild(data: {
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
  }): Promise<JoomlaResponse> {
    const plan = this.buildSiteBuildPlan(data);
    return {
      success: true,
      message: `Planned ${(plan.operations as unknown[]).length} site-build operation(s)`,
      data: plan,
    };
  }

  private async searchArticlesByTitle(title: string): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_content",
      "view": "articles",
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseArticleList(html);
  }

  private async searchCategoriesByTitle(title: string, extension = "com_content"): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_categories",
      "view": "categories",
      "extension": extension,
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseCategoryList(html);
  }

  private async searchModulesByTitle(title: string, clientId = "0"): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_modules",
      "view": "modules",
      "client_id": clientId,
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseModuleList(html);
  }

  private async searchMenuItemsByTitle(title: string, menuId?: string): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_menus",
      "view": "items",
      "filter[search]": title,
      "limit": "50",
    });
    if (menuId) params.set("menutype", menuId);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseMenuItemList(html);
  }

  private async findCategoryByTitle(title: string): Promise<Record<string, string> | null> {
    const categories = await this.searchCategoriesByTitle(title);
    return categories.find((category) => category.title === title) || null;
  }

  private async ensureCategoryByTitle(title: string): Promise<Record<string, string> | null> {
    if (!title) return null;
    const existing = await this.findCategoryByTitle(title);
    if (existing) return existing;
    const created = await this.createCategory({ title, published: "1" });
    if (!created.success) return null;
    return this.findCategoryByTitle(title);
  }

  private async findArticleByTitle(title: string, categoryTitle?: string): Promise<Record<string, string> | null> {
    const items = await this.searchArticlesByTitle(title);
    return items.find((article) => article.title === title && (!categoryTitle || article.category === categoryTitle)) || null;
  }

  private parseIdList(value: unknown): string[] {
    if (typeof value !== "string") return [];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  private stringifyIdList(values: string[]): string {
    return values.filter(Boolean).join(",");
  }

  private async collectGantryParticleReferences(root: GantryLayoutNode[]): Promise<GantryParticleReference[]> {
    const references: GantryParticleReference[] = [];
    const categoryCache = new Map<string, GantryCategoryReference | null>();
    const articleCache = new Map<string, GantryArticleReference | null>();

    const getCategoryRef = async (id: string): Promise<GantryCategoryReference | null> => {
      if (categoryCache.has(id)) return categoryCache.get(id) || null;
      const category = await this.getCategory(id);
      const data = (category.data || {}) as Record<string, string>;
      const ref = category.success ? { id, title: String(data.title || "") } : null;
      categoryCache.set(id, ref);
      return ref;
    };

    const getArticleRef = async (id: string): Promise<GantryArticleReference | null> => {
      if (articleCache.has(id)) return articleCache.get(id) || null;
      const article = await this.getArticle(id);
      const data = (article.data || {}) as Record<string, string>;
      const splitContent = this.splitArticleText(String(data.content || ""));
      const ref = article.success ? {
        id,
        title: String(data.title || ""),
        alias: String(data.alias || ""),
        categoryId: String(data.categoryId || ""),
        categoryTitle: String(data.categoryName || ""),
        introtext: splitContent.introtext,
        fulltext: splitContent.fulltext,
        state: String(data.state || "1"),
        access: String(data.access || "1"),
      } : null;
      articleCache.set(id, ref);
      return ref;
    };

    const visit = async (node: GantryLayoutNode, path: string[]): Promise<void> => {
      const nodePath = [...path, node.id || node.type || "node"];
      if (node.type === "particle") {
        const articleConfig = (node.attributes || {}).article as Record<string, unknown> | undefined;
        const filter = articleConfig?.filter as Record<string, unknown> | undefined;
        const categoryIds = this.parseIdList(filter?.categories);
        const articleIds = this.parseIdList(filter?.articles);
        if (categoryIds.length || articleIds.length) {
          const categories = (await Promise.all(categoryIds.map((id) => getCategoryRef(id)))).filter((item): item is GantryCategoryReference => !!item);
          const articles = (await Promise.all(articleIds.map((id) => getArticleRef(id)))).filter((item): item is GantryArticleReference => !!item);
          references.push({
            particleId: String(node.id || ""),
            particleTitle: String(node.title || ""),
            particleType: String(node.subtype || ""),
            filterPath: `${nodePath.join(" > ")}.attributes.article.filter`,
            categories,
            articles,
          });
        }
      }
      for (const child of node.children || []) await visit(child, nodePath);
    };

    for (const node of root) await visit(node, []);
    return references;
  }

  private async remapGantryParticleReferences(
    root: GantryLayoutNode[],
    references: GantryParticleReference[],
    options: { dryRun?: boolean } = {}
  ): Promise<{ root: GantryLayoutNode[]; actions: Array<Record<string, unknown>> }> {
    const actions: Array<Record<string, unknown>> = [];
    const categoryMap = new Map<string, string>();
    const articleMap = new Map<string, string>();

    for (const reference of references) {
      for (const category of reference.categories) {
        if (categoryMap.has(category.id)) continue;
        const existing = await this.findCategoryByTitle(category.title);
        const target = existing || (options.dryRun ? null : await this.ensureCategoryByTitle(category.title));
        if (target?.id) {
          categoryMap.set(category.id, target.id);
          actions.push({ type: "mapCategory", sourceId: category.id, sourceTitle: category.title, targetId: target.id });
        } else if (options.dryRun) {
          actions.push({ type: "mapCategory", sourceId: category.id, sourceTitle: category.title, wouldCreateCategory: true });
        }
      }
      for (const article of reference.articles) {
        if (articleMap.has(article.id)) continue;
        const existing = await this.findArticleByTitle(article.title, article.categoryTitle || "Homepage Articles");
        if (existing?.id) {
          articleMap.set(article.id, existing.id);
          actions.push({ type: "mapArticle", sourceId: article.id, sourceTitle: article.title, targetId: existing.id, created: false });
          continue;
        }

        if (options.dryRun) {
          actions.push({
            type: "mapArticle",
            sourceId: article.id,
            sourceTitle: article.title,
            wouldCreateArticle: true,
            category: "Homepage Articles",
          });
          continue;
        }

        const homepageCategory = await this.ensureCategoryByTitle("Homepage Articles");
        if (!homepageCategory?.id) continue;
        const created = await this.createArticle({
          title: article.title,
          alias: article.alias,
          categoryId: homepageCategory.id,
          content: this.buildArticleText(article.introtext, article.fulltext),
          state: article.state || "1",
          access: article.access || "1",
        });
        const createdId = String(((created.data || {}) as Record<string, unknown>).id || "");
        if (created.success && createdId) {
          articleMap.set(article.id, createdId);
          actions.push({ type: "mapArticle", sourceId: article.id, sourceTitle: article.title, targetId: createdId, created: true, category: "Homepage Articles" });
        }
      }
    }

    const visit = (node: GantryLayoutNode): void => {
      if (node.type === "particle") {
        const articleConfig = (node.attributes || {}).article as Record<string, unknown> | undefined;
        const filter = articleConfig?.filter as Record<string, unknown> | undefined;
        if (filter) {
          const categoryIds = this.parseIdList(filter.categories).map((id) => categoryMap.get(id) || id);
          const articleIds = this.parseIdList(filter.articles).map((id) => articleMap.get(id) || id);
          filter.categories = this.stringifyIdList(categoryIds);
          filter.articles = this.stringifyIdList(articleIds);
        }
      }
      for (const child of node.children || []) visit(child);
    };

    for (const node of root) visit(node);
    return { root, actions };
  }

  async applySiteBuild(data: {
    plan?: Record<string, unknown>;
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree?: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    const plan = data.plan || this.buildSiteBuildPlan({
      siteCode: data.siteCode,
      suffix: data.suffix,
      menuTitle: data.menuTitle,
      menuType: data.menuType,
      menuTree: data.menuTree || [],
      pageContentCategory: data.pageContentCategory,
      homeCategory: data.homeCategory,
    });
    if (!data.confirm) {
      return { success: true, message: "Dry run: site build plan prepared; set confirm=true to apply", data: plan };
    }

    const results: Array<Record<string, unknown>> = [];
    const categoryIds = new Map<string, string>();
    const articleIds = new Map<string, string>();
    const menuItemIds = new Map<string, string>([["root", "1"]]);
    let menuType = String(plan.menuType || "");

    for (const op of (plan.operations || []) as Array<Record<string, unknown>>) {
      if (op.type === "ensureCategory") {
        const existing = await this.findCategoryByTitle(String(op.title));
        if (existing) {
          categoryIds.set(String(op.key || op.title), existing.id);
          results.push({ op, success: true, skipped: true, id: existing.id });
        } else {
          const created = await this.createCategory({ title: String(op.title), published: String(op.published || "1") });
          const idMatch = String(created.html || "").match(/task=category\.edit&amp;id=(\d+)/);
          const found = await this.findCategoryByTitle(String(op.title));
          const id = found?.id || idMatch?.[1] || "";
          categoryIds.set(String(op.key || op.title), id);
          results.push({ op, success: created.success, id, message: created.message });
        }
      } else if (op.type === "ensureMenu") {
        const menus = await this.listMenus();
        const existing = ((menus.data || []) as Array<Record<string, string>>).find((menu) => menu.menuType === op.menuType || menu.title === op.title);
        if (existing) {
          menuType = existing.menuType || String(op.menuType);
          results.push({ op, success: true, skipped: true, menuType });
        } else {
          const created = await this.createMenu({ title: String(op.title), menuType: String(op.menuType) });
          menuType = String(op.menuType);
          results.push({ op, success: created.success, menuType, message: created.message });
        }
      } else if (op.type === "ensureArticle") {
        const category = await this.findCategoryByTitle(String(op.categoryTitle));
        const categoryId = category?.id || categoryIds.get(String(op.categoryTitle)) || "";
        if (!categoryId) {
          results.push({ op, success: false, message: `Missing category: ${op.categoryTitle}` });
          continue;
        }
        const created = await this.createArticle({
          title: String(op.title),
          alias: String(op.alias),
          categoryId,
          content: String(op.introtext || op.content || ""),
          state: String(op.state || "1"),
        });
        const list = await this.listArticles(categoryId);
        const article = ((list.data || []) as Array<Record<string, string>>).find((item) => item.title === op.title);
        if (article?.id) articleIds.set(String(op.key), article.id);
        results.push({ op, success: created.success, id: article?.id || "", message: created.message });
      } else if (op.type === "ensureMenuItem") {
        const parentId = menuItemIds.get(String(op.parentKey || "root")) || "1";
        const request: Record<string, string> = {};
        for (const [key, value] of Object.entries((op.request || {}) as Record<string, string>)) {
          if (value === "{homeCategoryId}") request[key] = categoryIds.get("homeCategory") || "";
          else if (/^\{article:/.test(value)) request[key] = articleIds.get(value.slice(1, -1)) || "";
          else request[key] = value;
        }
        const created = await this.createMenuItem({
          title: String(op.title),
          menuType,
          itemType: String(op.itemType),
          alias: String(op.alias),
          parentId,
          published: String(op.published || "1"),
          home: String(op.home || "0"),
          request,
        });
        const id = String((created.data as Record<string, unknown> | undefined)?.id || "");
        if (id) menuItemIds.set(String(op.key), id);
        results.push({ op, success: created.success, id, message: created.message });
      }
    }

    return {
      success: results.every((result) => result.success),
      message: `Applied ${results.length} site-build operation(s)`,
      data: { plan, results },
    };
  }

  async validateSiteBuild(data: { menuType?: string; plan?: Record<string, unknown> }): Promise<JoomlaResponse> {
    const warnings: Array<Record<string, unknown>> = [];
    const planOps = ((data.plan || {}).operations || []) as Array<Record<string, unknown>>;
    const aliases = new Map<string, number>();
    for (const op of planOps) {
      const alias = String(op.alias || "");
      if (!alias) continue;
      aliases.set(alias, (aliases.get(alias) || 0) + 1);
    }
    for (const [alias, count] of aliases) {
      if (count > 1) warnings.push({ type: "duplicatePlannedAlias", alias, count });
    }

    if (data.menuType) {
      const items = await this.listMenuItems(data.menuType);
      const seenTitles = new Map<string, number>();
      for (const item of (items.data || []) as Array<Record<string, string>>) {
        seenTitles.set(item.title, (seenTitles.get(item.title) || 0) + 1);
        if (item.state === "Unpublished" && !/coming soon|safety committee/i.test(item.title)) {
          warnings.push({ type: "unpublishedMenuItem", id: item.id, title: item.title });
        }
      }
      for (const [title, count] of seenTitles) {
        if (count > 1) warnings.push({ type: "duplicateMenuTitle", title, count });
      }
    }

    return {
      success: warnings.length === 0,
      message: warnings.length ? `Found ${warnings.length} validation warning(s)` : "Validation passed",
      data: { warnings },
    };
  }

  async launchChecklist(data: { menuType?: string; gantryOutline?: string; theme?: string } = {}): Promise<JoomlaResponse> {
    const checks: Array<Record<string, unknown>> = [];
    const categories = await this.listCategories("com_content");
    checks.push({ name: "contentCategories", success: categories.success, count: Array.isArray(categories.data) ? categories.data.length : 0 });
    const menus = await this.listMenus();
    checks.push({ name: "menus", success: menus.success, count: Array.isArray(menus.data) ? menus.data.length : 0 });
    if (data.menuType) {
      const items = await this.listMenuItems(data.menuType);
      checks.push({ name: "menuItems", success: items.success, menuType: data.menuType, count: Array.isArray(items.data) ? items.data.length : 0 });
    }
    const siteConfig = await this.inspectAdminForm("index.php?option=com_siteconfig", "application-form");
    checks.push({ name: "siteConfig", success: siteConfig.success });
    const gantry = await this.getGantry5Layout(data.gantryOutline || "default", { theme: data.theme });
    checks.push({ name: "gantryLayout", success: gantry.success, outline: data.gantryOutline || "default" });
    const redirects = await this.inspectAdminList("index.php?option=com_redir");
    checks.push({ name: "redirects", success: redirects.success, count: (((redirects.data as Record<string, unknown>).rows || []) as unknown[]).length });
    return {
      success: checks.every((check) => check.success),
      message: checks.every((check) => check.success) ? "Launch checklist passed" : "Launch checklist has warnings",
      data: { checks },
    };
  }

  async componentInspect(data: { path: string; mode?: "form" | "list"; formId?: string }): Promise<JoomlaResponse> {
    if (!data.path) return { success: false, message: "path is required" };
    if (data.mode === "form") return this.inspectAdminForm(data.path, data.formId);
    if (data.mode === "list") return this.inspectAdminList(data.path, data.formId || "adminForm");
    const list = await this.inspectAdminList(data.path, data.formId || "adminForm");
    if (list.success && (((list.data as Record<string, unknown>).rows || []) as unknown[]).length > 0) return list;
    return this.inspectAdminForm(data.path, data.formId);
  }

  async mediaList(pathOrFolder = "index.php?option=com_media"): Promise<JoomlaResponse> {
    const pathValue = pathOrFolder.includes("index.php")
      ? pathOrFolder
      : `index.php?option=com_media&folder=${encodeURIComponent(pathOrFolder)}`;

    // Extract the folder parameter so we can build the imagesList URL
    const folderMatch = pathValue.match(/[?&]folder=([^&]*)/);
    const folderParam = folderMatch ? folderMatch[1] : "";

    // Fetch main page (navigation + forms) and imagesList view (actual files in static HTML) in parallel
    const [{ html }, imagesListResult] = await Promise.all([
      this.getPage(this.adminPathToUrl(pathValue)),
      this.getPage(this.getAdminUrl(
        `index.php?option=com_media&view=imagesList&tmpl=component&folder=${folderParam}`
      )),
    ]);

    // Parse folder/nav links from the main page
    const links = this.parseAdminLinks(html)
      .filter((link) => /com_media|task=file|task=folder|download|images\//i.test(link.href + " " + link.text))
      .slice(0, 200);

    // Parse actual files from the imagesList component view (rendered as static img tags)
    const $list = this.$c(imagesListResult.html);
    const files = $list("img[src]").map((_, el) => {
      const $el = $list(el);
      const src = $el.attr("src") || "";
      const name = $el.attr("alt") || src.split("/").pop() || src;
      const $container = $el.closest("li, .imgOutline, div[class*='img']");
      const label = $container.find("a, .imgInfoBar, span").first().text().trim() || name;
      return { name, src, label };
    }).get()
      .filter((f) => f.src && !/media\/system|jui\/img|alpha\.png|administrator\/templates/i.test(f.src))
      .slice(0, 200);

    return {
      success: true,
      message: files.length > 0
        ? `Found ${files.length} file(s) in folder "${decodeURIComponent(folderParam) || "root"}"`
        : `No files found in folder "${decodeURIComponent(folderParam) || "root"}" (${links.length} subfolders available)`,
      data: {
        path: pathValue,
        folder: decodeURIComponent(folderParam) || "root",
        files,
        subfolders: links,
        forms: this.parseAdminForms(html).map((form) => ({
          id: form.id,
          action: form.action,
          method: form.method,
          fieldCount: Array.isArray(form.fields) ? form.fields.length : 0,
        })),
        toolbarTasks: this.parseToolbarTasks(html),
      },
      html: html.substring(0, 50000),
    };
  }

  async createMediaFolder(data: { folderName: string; folderBase?: string; path?: string; dryRun?: boolean; confirm?: boolean }): Promise<JoomlaResponse> {
    if (!data.folderName) return { success: false, message: "folderName is required" };
    const path = data.path || "index.php?option=com_media";
    if (data.dryRun || !data.confirm) {
      return this.submitAdminForm(path, {
        overrides: {
          foldername: data.folderName,
          folderbase: data.folderBase || "",
        },
        task: "folder.create",
        dryRun: data.dryRun ?? !data.confirm,
        confirm: data.confirm,
      });
    }

    const submitted = await this.submitAdminForm(path, {
      overrides: {
        foldername: data.folderName,
        folderbase: data.folderBase || "",
      },
      task: "folder.create",
      confirm: true,
    });
    if (!submitted.success) return submitted;

    const listing = await this.mediaList(data.folderBase || "index.php?option=com_media");
    const listingData = (listing.data || {}) as Record<string, unknown>;
    const links = ((listingData.links || []) as Array<Record<string, string>>);
    const folderMatch = links.some((link) =>
      String(link.label || "") === data.folderName
      || decodeURIComponent(String(link.href || "")).includes(`/${data.folderName}`)
      || decodeURIComponent(String(link.href || "")).includes(`folder=${data.folderName}`)
    ) || (listing.html || "").includes(data.folderName);

    return {
      success: folderMatch,
      message: folderMatch ? "Media folder created" : "Media folder create submitted, but the new folder was not verified in the media listing",
      data: {
        ...(submitted.data || {}),
        folderName: data.folderName,
        folderBase: data.folderBase || "",
        verification: {
          attempted: true,
          listedAfterCreate: folderMatch,
        },
      },
      html: submitted.html,
    };
  }

  async listSponsors(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_sponsors&view=sponsors");
  }

  async inspectSponsor(pathOrUrl = "index.php?option=com_sponsors&view=sponsor&layout=edit"): Promise<JoomlaResponse> {
    return this.inspectAdminForm(pathOrUrl);
  }

  async listDocmanDocuments(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_docman&view=documents");
  }

  async listFilemanFiles(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_fileman");
  }

  async listRedirects(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_redir");
  }

  async inspectSiteConfig(): Promise<JoomlaResponse> {
    return this.inspectAdminForm("index.php?option=com_siteconfig", "application-form");
  }

  async listSubsites(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_subsites");
  }

  // ==================== AUTH ====================

  async login(): Promise<JoomlaResponse> {
    // Clear any cached Gantry URLs so a fresh login always starts fresh
    this.gantryEntryUrl = null;
    this.gantryOutlineLayoutUrls.clear();
    this.gantryLayoutRootCache.clear();
    const loginUrl = this.getAdminUrl();
    const result = await this.getPage(loginUrl);
    const token = this.extractCsrfToken(result.html);

    if (!token) {
      if (this.looksLoggedIn(result.html)) {
        return {
          success: true,
          message: "Already logged in",
          html: result.html,
        };
      }

      return {
        success: false,
        message: "Failed to extract CSRF token from login page",
        html: result.html,
      };
    }

    const formData: Record<string, string> = {
      username: this.config.username,
      passwd: this.config.password,
      option: "com_login",
      task: "login",
      return: "aW5kZXgucGhw",
      [token.name]: token.value,
    };

    const postResult = await this.postPage(loginUrl, formData);

    // Check success
    if (postResult.html.includes("mod-login-username") || postResult.html.includes("Empty password")) {
      // Login failed - still on login page
      const errorMsg = this.extractAlertMessage(postResult.html);
      return {
        success: false,
        message: errorMsg ?? "Login failed",
        html: postResult.html,
      };
    }

    // Login successful
    this.tokenName = this.extractCsrfToken(postResult.html)?.name || this.tokenName;
    return {
      success: true,
      message: "Login successful",
      html: postResult.html,
    };
  }

  async logout(): Promise<JoomlaResponse> {
    return this.postPage(this.getAdminUrl(), {
      option: "com_login",
      task: "logout",
      [this.tokenName || ""] : "1",
    }).then((r) => ({
      success: r.status === 200,
      message: "Logged out",
      html: r.html,
    }));
  }

  async isLoggedIn(): Promise<boolean> {
    const { html } = await this.getPage(this.getAdminUrl("index.php"));
    return this.looksLoggedIn(html);
  }

  // ==================== ARTICLES ====================

  async listArticles(categoryId?: string, state?: string, limit?: number, page?: number, search?: string): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit ?? 200, 500);
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_content",
      "view": "articles",
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (categoryId) params.set("filter[category_id]", categoryId);
    if (state !== undefined && state !== "") params.set("filter[published]", state);
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const articles = this.parseArticleList(html);
    return {
      success: true,
      message: `Found ${articles.length} articles (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: articles,
      html,
    };
  }

  private parseArticleList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const articles: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const $titleLink = $row.find("a[href*='task=article.edit']").first();
      const title = $titleLink.text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      const $titleTd = $titleLink.closest("td");
      const $smallDiv = $titleTd.find("div.small").first();
      const $catLink = $smallDiv.find("a").first();
      let category = $catLink.text().trim();
      if (!category) {
        const smallText = $smallDiv.text().trim();
        const colonIdx = smallText.indexOf(": ");
        category = colonIdx >= 0 ? smallText.slice(colonIdx + 2).trim() : smallText;
      }
      const catHref = $catLink.attr("href") || "";
      const catIdMatch = catHref.match(/filter\[category_id\]=(\d+)/);
      const categoryId = catIdMatch ? catIdMatch[1] : "";
      articles.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        category: category || "Unknown",
        categoryId,
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return articles;
  }

  private async fetchArticleForm(id: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    const { html } = await this.getPage(url);
    const article = this.parseArticleForm(html);
    return {
      success: !!article.title,
      message: article.title ? "Article retrieved" : "Failed to parse article form",
      data: article,
      html,
    };
  }

  async getArticle(id?: string, title?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchArticlesByTitle(title);
      if (matches.length === 0) return { success: false, message: `No article found matching title '${title}'` };
      if (matches.length === 1) return this.getArticle(matches[0].id);
      return { success: true, message: `Multiple articles found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchArticleForm(id!);
    if (result.success) {
      const ci = await this.checkInArticle(id!);
      if (!ci.success) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    return result;
  }

  private parseArticleForm(html: string): Record<string, string> {
    const fields = this.extractFormFields(html);
    const article: Record<string, string> = {};

    article.title = this.getJFormField(fields, "title");
    article.alias = this.getJFormField(fields, "alias");
    article.categoryId = this.getJFormField(fields, "catid");

    article.categoryName = this.$c(html)("select[id='jform_catid'] option[selected]").first().text().trim();

    article.state = this.getJFormField(fields, "state");
    article.content = this.getJFormField(fields, "articletext");
    article.access = this.getJFormField(fields, "access", "1");
    article.note = this.getJFormField(fields, "note");

    article.introImage = fields["jform[images][image_intro]"] ?? "";
    article.introImageAlt = fields["jform[images][image_intro_alt]"] ?? "";
    article.featuredImage = fields["jform[images][image_fulltext]"] || fields["hidden-image"] || "";
    article.featuredImageAlt = fields["jform[images][image_fulltext_alt]"] ?? "";

    return article;
  }

  async createArticle(data: {
    title: string;
    alias?: string;
    categoryId: string;
    content?: string;
    state?: string;
    access?: string;
    introImage?: string;
    introImageAlt?: string;
    featuredImage?: string;
    featuredImageAlt?: string;
  }): Promise<JoomlaResponse> {
    const newArticleUrl = this.getAdminUrl("index.php?option=com_content&view=article&layout=edit");
    const { html } = await this.getPage(newArticleUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      ...this.extractFormFields(html),
      task: "article.save",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[catid]": data.categoryId,
      "jform[articletext]": data.content || "",
      "jform[state]": data.state ?? "1",
      "jform[access]": data.access ?? "1",
      [token.name]: token.value,
    };

    if (data.introImage !== undefined) formData["jform[images][image_intro]"] = data.introImage;
    if (data.introImageAlt !== undefined) formData["jform[images][image_intro_alt]"] = data.introImageAlt;
    if (data.featuredImage !== undefined) {
      formData["jform[images][image_fulltext]"] = data.featuredImage;
      formData["hidden-image"] = data.featuredImage;
    }
    if (data.featuredImageAlt !== undefined) formData["jform[images][image_fulltext_alt]"] = data.featuredImageAlt;

    const result = await this.postPage(newArticleUrl, formData);

    const successMsg = result.html.includes("Article saved") || result.html.includes("The article has been saved");
    const errorMsg = this.extractAlertMessage(result.html);

    let createdId = "";
    if (successMsg) {
      const listed = await this.listArticles();
      const found = this.findLatestByTitle((listed.data || []) as Array<Record<string, string>>, data.title);
      createdId = found?.id || "";
    }
    const verify = createdId ? await this.getArticle(createdId) : null;
    const article = ((verify?.data || {}) as Record<string, string>);
    const expectedArticleText = data.content || "";
    const verification = {
      attempted: true,
      foundInList: !!createdId,
      readbackSucceeded: !!verify?.success,
      titleMatches: !!verify?.success && article.title === data.title,
      aliasMatches: !!verify?.success && this.verifyAlias(String(article.alias || ""), data.alias),
      categoryMatches: !!verify?.success && article.categoryId === data.categoryId,
      stateMatches: !!verify?.success && article.state === String(data.state ?? "1"),
      accessMatches: !!verify?.success && article.access === String(data.access ?? "1"),
      articleTextMatches: !!verify?.success && this.isEquivalentRichText(String(article.content || ""), expectedArticleText),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Article saved" : (errorMsg ?? successMsg ? "Article save submitted, but creation was not verified" : "Unknown result"),
      data: this.buildOperationData("article", createdId || "", {
        title: article.title || data.title,
        state: article.state || String(data.state ?? "1"),
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async updateArticle(
    id: string,
    data: {
      title?: string;
      alias?: string;
      categoryId?: string;
      content?: string;
      state?: string;
      access?: string;
      ordering?: string;
      introImage?: string;
      introImageAlt?: string;
      featuredImage?: string;
      featuredImageAlt?: string;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const existingArticle = this.parseArticleForm(html);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const content = data.content ?? existingArticle.content;
    const formData: Record<string, string> = {
      ...this.extractFormFields(html),
      task: "article.save",
      "jform[title]": data.title ?? existingArticle.title,
      "jform[alias]": data.alias ?? existingArticle.alias,
      "jform[catid]": data.categoryId ?? existingArticle.categoryId,
      "jform[articletext]": content,
      "jform[state]": data.state ?? existingArticle.state,
      "jform[access]": data.access ?? existingArticle.access,
      "jform[images][image_intro]": data.introImage ?? existingArticle.introImage ?? "",
      "jform[images][image_intro_alt]": data.introImageAlt ?? existingArticle.introImageAlt ?? "",
      "jform[images][image_fulltext]": data.featuredImage ?? existingArticle.featuredImage ?? "",
      "hidden-image": data.featuredImage ?? existingArticle.featuredImage ?? "",
      "jform[images][image_fulltext_alt]": data.featuredImageAlt ?? existingArticle.featuredImageAlt ?? "",
      [token.name]: token.value,
    };

    if (data.ordering !== undefined) {
      formData["jform[ordering]"] = data.ordering;
    }

    const result = await this.postPage(editUrl, formData);
    const successMsg = result.html.includes("Article saved") || result.html.includes("The article has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    const verify = await this.getArticle(id);
    const article = (verify.data || {}) as Record<string, string>;
    const expectedTitle = String(formData["jform[title]"] || "");
    const expectedAlias = String(formData["jform[alias]"] || "");
    const expectedCategoryId = String(formData["jform[catid]"] || "");
    const expectedArticleText = String(formData["jform[articletext]"] || "");
    const expectedState = String(formData["jform[state]"] || "");
    const expectedAccess = String(formData["jform[access]"] || "");
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: verify.success && article.title === expectedTitle,
      aliasMatches: verify.success && article.alias === expectedAlias,
      categoryMatches: verify.success && article.categoryId === expectedCategoryId,
      articleTextMatches: verify.success && this.isEquivalentRichText(String(article.content || ""), expectedArticleText),
      stateMatches: verify.success && article.state === expectedState,
      accessMatches: verify.success && article.access === expectedAccess,
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Article saved" : (errorMsg ?? successMsg ? "Article save submitted, but updated values were not verified" : "Unknown result"),
      data: this.buildOperationData("article", id, {
        title: article.title || expectedTitle,
        state: article.state || expectedState,
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async deleteArticle(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getArticle(id);
    const articleBefore = (before.data || {}) as Record<string, string>;
    const title = articleBefore.title || "";
    if (!before.success) {
      return { success: false, message: `Refusing to delete article ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete article ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_content&view=articles");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      task: "articles.trash",
      "cid[]": id,
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const successMsg = /article[s]?\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = await this.listArticles();
    const articles = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const stillListed = articles.some((entry) => entry.id === id);
    const verify = await this.getArticle(id);
    const verified = !stillListed && (successMsg || this.isDeletionVerified(stillListed, verify, ["published", "state"]));

    return {
      success: verified,
      message: verified ? "Article trashed" : (errorMsg ?? successMsg ? "Article trash submitted, but deletion was not verified" : "Unknown result"),
      data: this.buildOperationData("article", id, {
        title,
        state: "-2",
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async checkInArticle(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchArticleForm(id);
    const articleBefore = (before.data || {}) as Record<string, string>;
    const title = articleBefore.title || "";
    if (!before.success) {
      return { success: false, message: `Refusing to check in article ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in article ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_content&view=articles");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const result = await this.postPage(listUrl, {
      task: "articles.checkin",
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    });
    const errorMsg = this.extractAlertMessage(result.html);

    const listed = await this.listArticles();
    const listedArticles = (listed.data || []) as Array<Record<string, string>>;
    const listedArticle = listedArticles.find((entry) => entry.id === id);
    const checkedOutCleared = !!listedArticle && listedArticle.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Article checked in" : (errorMsg ?? "Article check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("article", id, {
        title,
        state: String(listedArticle?.state || ""),
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedArticle,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== CATEGORIES ====================

  async listCategories(extension = "com_content", limit = 200, page = 1, search?: string): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit, 500);
    const effectivePage = Math.max(page, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_categories",
      "view": "categories",
      "extension": extension,
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const categories = this.parseCategoryList(html);
    return {
      success: true,
      message: `Found ${categories.length} categories (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: categories,
      html,
    };
  }

  private parseCategoryList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const categories: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const title = $row.find("a[href*='task=category.edit']").first().text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      categories.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        parent: "Root",
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return categories;
  }

  private async fetchCategoryForm(id: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`);
    const { html } = await this.getPage(url);

    const fields = this.extractFormFields(html);
    const category: Record<string, string> = {};
    category.title = this.getJFormField(fields, "title");
    category.alias = this.getJFormField(fields, "alias");
    category.parentId = this.getJFormField(fields, "parent_id", "1");
    category.description = this.getJFormField(fields, "description");
    category.published = this.getJFormField(fields, "published", "1");

    return {
      success: !!category.title,
      message: category.title ? "Category retrieved" : "Failed to parse category form",
      data: category,
      html,
    };
  }

  async getCategory(id?: string, title?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchCategoriesByTitle(title);
      if (matches.length === 0) return { success: false, message: `No category found matching title '${title}'` };
      if (matches.length === 1) return this.getCategory(matches[0].id);
      return { success: true, message: `Multiple categories found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchCategoryForm(id!);
    if (result.success) {
      const ci = await this.checkInCategory(id!);
      if (!ci.success) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    return result;
  }

  async createCategory(data: {
    title: string;
    alias?: string;
    parentId?: string;
    description?: string;
    published?: string;
    extension?: string;
  }): Promise<JoomlaResponse> {
    const ext = data.extension || "com_content";
    const newCatUrl = this.getAdminUrl(
      `index.php?option=com_categories&view=category&layout=edit&extension=${ext}`
    );
    const { html } = await this.getPage(newCatUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      ...this.extractFormFields(html),
      task: "category.save",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[parent_id]": data.parentId || "1",
      "jform[description]": data.description || "",
      "jform[published]": data.published ?? "1",
      "jform[access]": "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(newCatUrl, formData);
    const successMsg = result.html.includes("Category saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);

    let createdId = "";
    if (successMsg) {
      const listed = await this.listCategories(ext);
      const found = this.findLatestByTitle((listed.data || []) as Array<Record<string, string>>, data.title);
      createdId = found?.id || "";
    }
    const verify = createdId ? await this.getCategory(createdId) : null;
    const category = ((verify?.data || {}) as Record<string, string>);
    const verification = {
      attempted: true,
      foundInList: !!createdId,
      readbackSucceeded: !!verify?.success,
      titleMatches: !!verify?.success && category.title === data.title,
      aliasMatches: !!verify?.success && this.verifyAlias(String(category.alias || ""), data.alias),
      parentMatches: !!verify?.success && category.parentId === String(data.parentId || "1"),
      descriptionMatches: !!verify?.success && this.isEquivalentRichText(String(category.description || ""), String(data.description || "")),
      publishedMatches: !!verify?.success && category.published === String(data.published ?? "1"),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Category saved" : (errorMsg ?? successMsg ? "Category save submitted, but creation was not verified" : "Unknown result"),
      data: this.buildOperationData("category", createdId || "", {
        title: category.title || data.title,
        state: category.published || String(data.published ?? "1"),
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async updateCategory(
    id: string,
    data: {
      title?: string;
      alias?: string;
      parentId?: string;
      description?: string;
      published?: string;
      ordering?: string;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`);
    const { html } = await this.getPage(editUrl);
    const existingCategory = this.parseCategoryForm(html);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      ...this.extractFormFields(html),
      task: "category.save",
      "jform[title]": data.title ?? existingCategory.title,
      "jform[alias]": data.alias ?? existingCategory.alias,
      "jform[parent_id]": data.parentId ?? existingCategory.parentId,
      "jform[description]": data.description ?? existingCategory.description,
      "jform[published]": data.published ?? existingCategory.published,
      "jform[access]": existingCategory.access || "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(editUrl, formData);
    const successMsg = result.html.includes("Category saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    const verify = await this.getCategory(id);
    const category = (verify.data || {}) as Record<string, string>;
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: verify.success && category.title === String(formData["jform[title]"] || ""),
      aliasMatches: verify.success && category.alias === String(formData["jform[alias]"] || ""),
      parentMatches: verify.success && category.parentId === String(formData["jform[parent_id]"] || ""),
      descriptionMatches: verify.success && this.isEquivalentRichText(String(category.description || ""), String(formData["jform[description]"] || "")),
      publishedMatches: verify.success && category.published === String(formData["jform[published]"] || ""),
    };
    const verified = Object.values(verification).every((value) => value === true);

    let reorderResult: { success: boolean; message: string } | undefined;
    if (data.ordering !== undefined) {
      reorderResult = await this.reorderCategory(id, data.ordering);
    }

    const overallSuccess = verified && (reorderResult === undefined || reorderResult.success);

    return {
      success: overallSuccess,
      message: overallSuccess
        ? "Category saved"
        : reorderResult && !reorderResult.success
          ? `Category saved but reorder failed: ${reorderResult.message}`
          : (errorMsg ?? successMsg ? "Category save submitted, but updated values were not verified" : "Unknown result"),
      data: this.buildOperationData("category", id, {
        title: category.title || String(formData["jform[title]"] || ""),
        state: category.published || String(formData["jform[published]"] || ""),
        verification: {
          ...verification,
          verified,
          ...(reorderResult !== undefined ? { reorderSuccess: reorderResult.success } : {}),
        },
      }),
      html: result.html,
    };
  }

  private async reorderCategory(id: string, afterId: string): Promise<{ success: boolean; message: string }> {
    const listUrl = this.getAdminUrl(
      "index.php?option=com_categories&view=categories&extension=com_content&limit=500&filter_order=a.lft&filter_order_Dir=asc"
    );
    const { html } = await this.getPage(listUrl);

    const $ = this.$c(html);
    const ids: string[] = [];
    $("tr").each((_, el) => {
      const cid = $(el).find("input[name='cid[]']").attr("value");
      if (cid) ids.push(cid);
    });

    if (!ids.includes(id)) {
      return { success: false, message: `Category ${id} not found in list` };
    }

    const withoutTarget = ids.filter((cid) => cid !== id);

    let insertIndex: number;
    if (afterId === "-1") {
      insertIndex = 0;
    } else {
      const afterIndex = withoutTarget.indexOf(afterId);
      if (afterIndex === -1) {
        return { success: false, message: `Sibling category ${afterId} not found` };
      }
      insertIndex = afterIndex + 1;
    }

    const reordered = [...withoutTarget];
    reordered.splice(insertIndex, 0, id);

    const token = this.extractCsrfToken(html);
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const saveUrl = this.getAdminUrl("index.php?option=com_categories&extension=com_content");
    const formBody = this.getFormUrlEncoded({
      task: "categories.saveorder",
      [token.name]: token.value,
      "cid[]": reordered,
      "order[]": reordered.map((_, i) => String(i + 1)),
    });

    const result = await this.request(saveUrl, {
      method: "POST",
      body: formBody,
      contentType: "application/x-www-form-urlencoded",
    });

    if (result.status === 302 || result.status === 303) {
      return { success: true, message: "Category reordered" };
    }

    try {
      const json = JSON.parse(result.body) as Record<string, unknown>;
      return {
        success: json["success"] !== false,
        message: String(json["message"] || (json["success"] !== false ? "Category reordered" : "Saveorder failed")),
      };
    } catch {
      const errorMsg = this.extractAlertMessage(result.body);
      return {
        success: !errorMsg,
        message: errorMsg || "Category reordered",
      };
    }
  }

  private parseCategoryForm(html: string): Record<string, string> {
    const fields = this.extractFormFields(html);
    const category: Record<string, string> = {};

    category.title = this.getJFormField(fields, "title");
    category.alias = this.getJFormField(fields, "alias");
    category.parentId = this.getJFormField(fields, "parent_id", "1");
    category.description = this.getJFormField(fields, "description");
    category.published = this.getJFormField(fields, "published", "1");
    category.access = this.getJFormField(fields, "access", "1");

    return category;
  }

  async deleteCategory(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getCategory(id);
    const categoryBefore = (before.data || {}) as Record<string, string>;
    const title = categoryBefore.title || "";
    if (!before.success) {
      return { success: false, message: `Refusing to delete category ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete category ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_categories&view=categories&extension=com_content");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      task: "categories.trash",
      "cid[]": id,
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const successMsg = /categor(y|ies)\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = await this.listCategories();
    const categories = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const stillListed = categories.some((entry) => entry.id === id);
    const verify = await this.getCategory(id);
    const verified = this.isDeletionVerified(stillListed, verify, ["published", "state"]);

    return {
      success: verified,
      message: verified ? "Category trashed" : (errorMsg ?? successMsg ? "Category trash submitted, but deletion was not verified" : "Unknown result"),
      data: this.buildOperationData("category", id, {
        title,
        state: "-2",
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async checkInCategory(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchCategoryForm(id);
    const categoryBefore = (before.data || {}) as Record<string, string>;
    const title = categoryBefore.title || "";
    if (!before.success) {
      return { success: false, message: `Refusing to check in category ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in category ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_categories&view=categories&extension=com_content");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const result = await this.postPage(listUrl, {
      task: "categories.checkin",
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    });
    const errorMsg = this.extractAlertMessage(result.html);

    const listed = await this.listCategories();
    const listedCategories = (listed.data || []) as Array<Record<string, string>>;
    const listedCategory = listedCategories.find((entry) => entry.id === id);
    const checkedOutCleared = !!listedCategory && listedCategory.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Category checked in" : (errorMsg ?? "Category check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("category", id, {
        title,
        state: String(listedCategory?.state || ""),
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedCategory,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== MODULES ====================

  async listModules(clientId = "0", search?: string, limit?: number, page?: number): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit ?? 200, 500);
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_modules",
      "view": "modules",
      "client_id": clientId,
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const modules = this.parseModuleList(html);
    return {
      success: true,
      message: `Found ${modules.length} modules (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: modules,
      html,
    };
  }

  private parseModuleList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const modules: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const title = $row.find("a[href*='task=module.edit']").first().text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      const cells = $row.find("td").map((_, td) => $(td).text().trim()).get();
      const state = this.extractPublishedState(rowHtml);
      modules.push({
        id: cid,
        title,
        state,
        enabled: state,
        position: cells[4] || "",
        moduleType: cells[5] || "",
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return modules;
  }

  private parseModuleTypes(html: string): ModuleType[] {
    const $ = this.$c(html);
    const types: ModuleType[] = [];
    $("a[href*='option=com_modules'][href*='task=module.add']").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const idMatch = href.match(/eid=(\d+)/);
      if (idMatch) {
        types.push({
          id: idMatch[1],
          title: $el.text().trim(),
          href,
        });
      }
    });
    return types;
  }

  private findModuleType(types: ModuleType[], moduleType: string): ModuleType | null {
    const lowered = moduleType.toLowerCase();
    return types.find((type) =>
      type.id === moduleType ||
      type.title.toLowerCase() === lowered ||
      (type.module || "").toLowerCase() === lowered
    ) || null;
  }

  private async resolveModuleType(types: ModuleType[], moduleType: string, clientId = "0"): Promise<ModuleType | null> {
    const direct = this.findModuleType(types, moduleType);
    if (direct) return direct;

    const lowered = moduleType.toLowerCase();
    for (const type of types) {
      const addUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}&client_id=${clientId}`);
      const { html } = await this.getPage(addUrl);
      const parsed = this.parseModuleForm(html);
      const actualModule = String(parsed.moduleType || "").toLowerCase();
      if (actualModule === lowered) {
        return {
          ...type,
          module: String(parsed.moduleType || ""),
        };
      }
    }

    return null;
  }

  private parseModuleForm(html: string): Record<string, unknown> {
    const fields = this.extractFormFields(html, "module-form");
    const module: Record<string, unknown> = {};
    const params: Record<string, string> = {};
    const advanced: Record<string, string> = {};
    const fieldOverrides: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      const paramsMatch = key.match(/^jform\[params\]\[([^\]]+)\]$/);
      const advancedMatch = key.match(/^jform\[advanced\]\[([^\]]+)\]$/);
      if (paramsMatch) params[paramsMatch[1]] = value;
      if (advancedMatch) advanced[advancedMatch[1]] = value;
      if (!paramsMatch && !advancedMatch) fieldOverrides[key] = value;
    }

    module.id = this.getJFormField(fields, "id");
    module.title = this.getJFormField(fields, "title");
    module.clientId = this.getJFormField(fields, "client_id", "0");
    module.position = this.getJFormField(fields, "position");
    module.published = this.getJFormField(fields, "published", "1");
    module.access = this.getJFormField(fields, "access", "1");
    module.moduleType = this.getJFormField(fields, "module");
    module.showtitle = this.getJFormField(fields, "showtitle", "1");
    module.ordering = this.getJFormField(fields, "ordering", "0");
    module.style = this.getJFormField(fields, "style", "0");
    module.language = this.getJFormField(fields, "language", "*");
    module.note = this.getJFormField(fields, "note");
    module.assignment = this.getJFormField(fields, "assignment", "0");
    module.assigned = this.extractCheckedValues(html, "jform[assigned][]");
    module.content = this.getJFormField(fields, "content");
    module.params = params;
    module.advanced = advanced;
    module.fieldOverrides = fieldOverrides;
    module.positions = this.extractSelectOptions(html, "jform_position");
    module.assignmentOptions = this.extractSelectOptions(html, "jform_assignment");
    return module;
  }

  private sanitizeBlueprintFileName(fileName: string, fallback: string): string {
    return (fileName || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private omitModuleBlueprintFields(fields: Record<string, string>): Record<string, string> {
    const omitted = new Set([
      "task",
      "boxchecked",
      "return",
      "id",
      "jform[id]",
      "jform[title]",
      "jform[module]",
      "jform[client_id]",
      "jform[position]",
      "jform[published]",
      "jform[access]",
      "jform[showtitle]",
      "jform[ordering]",
      "jform[style]",
      "jform[language]",
      "jform[note]",
      "jform[assignment]",
      "jform[content]",
      "jform[assigned][]",
    ]);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (/^[a-f0-9]{32}$/i.test(key)) continue;
      if (omitted.has(key)) continue;
      result[key] = value;
    }
    return result;
  }

  private parseModuleFieldCatalog(html: string): Record<string, unknown> {
    const fields = this.extractFormFields(html, "module-form");
    const fieldNames = Object.keys(fields);
    const paramFields = fieldNames
      .map((name) => name.match(/^jform\[params\]\[([^\]]+)\]$/)?.[1])
      .filter((name): name is string => !!name);
    const advancedFields = fieldNames
      .map((name) => name.match(/^jform\[advanced\]\[([^\]]+)\]$/)?.[1])
      .filter((name): name is string => !!name);

    return {
      fieldNames,
      paramFields,
      advancedFields,
      positions: this.extractSelectOptions(html, "jform_position"),
      assignmentOptions: this.extractSelectOptions(html, "jform_assignment"),
      assignmentMenuItemIds: Array.from(new Set(Array.from(html.matchAll(/name=["']jform\[assigned\]\[\]["'][^>]*value=["']([^"']+)["']/g)).map((match) => match[1]))),
    };
  }

  async listModuleTypes(clientId = "0"): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_modules&view=select&client_id=${clientId}`);
    const { html } = await this.getPage(url);
    const blacklist = this.config.moduleTypeBlacklist;
    const types = this.parseModuleTypes(html).filter(
      (t) => !blacklist || !blacklist.has(t.title.toLowerCase())
    );

    return {
      success: true,
      message: `Found ${types.length} module types`,
      data: types,
      html,
    };
  }

  async listModulePositions(clientId = "0"): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(clientId);
    const custom = ((typesResult.data || []) as ModuleType[]).find((type) => type.title.toLowerCase() === "custom") ||
      ((typesResult.data || []) as ModuleType[])[0];

    if (!custom) {
      return { success: false, message: "No module types found to inspect positions" };
    }

    const { html } = await this.getPage(this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${custom.id}`));
    const positions = this.extractSelectOptions(html, "jform_position").filter((position) => position.value);

    return {
      success: true,
      message: `Found ${positions.length} module positions`,
      data: positions,
      html,
    };
  }

  async inspectModuleType(moduleType: string, clientId = "0"): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(clientId);
    const types = (typesResult.data || []) as ModuleType[];
    const type = this.findModuleType(types, moduleType);

    if (!type) {
      return {
        success: false,
        message: `Module type not found: ${moduleType}`,
        data: types,
      };
    }

    const { html } = await this.getPage(this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}`));
    return {
      success: true,
      message: "Module type retrieved",
      data: {
        ...type,
        ...this.parseModuleFieldCatalog(html),
        commonFields: [
          "title",
          "position",
          "published",
          "access",
          "showtitle",
          "ordering",
          "style",
          "language",
          "note",
          "assignment",
          "assigned",
        ],
      },
      html,
    };
  }

  private async fetchModuleForm(id: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`);
    const { html } = await this.getPage(url);
    const module = this.parseModuleForm(html);

    return {
      success: !!module.title,
      message: module.title ? "Module retrieved" : "Failed to parse module form",
      data: module,
      html,
    };
  }

  async getModule(id?: string, title?: string, clientId = "0"): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchModulesByTitle(title, clientId);
      if (matches.length === 0) return { success: false, message: `No module found matching title '${title}'` };
      if (matches.length === 1) return this.getModule(matches[0].id);
      return { success: true, message: `Multiple modules found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchModuleForm(id!);
    if (result.success) {
      const ci = await this.checkInModule(id!);
      if (!ci.success) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    return result;
  }

  async exportModuleBlueprint(
    id: string,
    options: {
      format?: "json" | "yaml";
      saveToFile?: boolean;
      fileName?: string;
    } = {}
  ): Promise<JoomlaResponse> {
    const result = await this.getModule(id);
    if (!result.success) return result;

    const module = (result.data || {}) as Record<string, unknown>;
    const format = (options.format || "yaml").toLowerCase() === "json" ? "json" : "yaml";
    const blueprint: ModuleBlueprint = {
      kind: "joomla-module-blueprint",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: {
        id,
        title: String(module.title || ""),
        moduleType: String(module.moduleType || ""),
      },
      module: {
        title: String(module.title || ""),
        moduleType: String(module.moduleType || ""),
        clientId: String(module.clientId || "0"),
        position: String(module.position || ""),
        published: String(module.published || "1"),
        access: String(module.access || "1"),
        showtitle: String(module.showtitle || "1"),
        ordering: String(module.ordering || "0"),
        style: String(module.style || "0"),
        language: String(module.language || "*"),
        note: String(module.note || ""),
        assignment: String(module.assignment || "0"),
        assigned: Array.isArray(module.assigned) ? (module.assigned as string[]) : [],
        content: typeof module.content === "string" ? module.content : undefined,
        params: (module.params || {}) as Record<string, string>,
        advanced: (module.advanced || {}) as Record<string, string>,
        fieldOverrides: this.omitModuleBlueprintFields((module.fieldOverrides || {}) as Record<string, string>),
      },
    };

    const serialized = format === "yaml"
      ? yaml.dump(blueprint, { noRefs: true, lineWidth: 120 })
      : JSON.stringify(blueprint, null, 2);

    let filePath = "";
    if (options.saveToFile) {
      mkdirSync(this.getBlueprintDir("modules"), { recursive: true });
      const safeTitle = String(module.title || `module-${id}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
      const ext = format === "yaml" ? "yaml" : "json";
      const fileName = this.sanitizeBlueprintFileName(options.fileName || `${safeTitle}.${ext}`, `${safeTitle}.${ext}`);
      filePath = path.join(this.getBlueprintDir("modules"), fileName);
      writeFileSync(filePath, serialized, "utf8");
    }

    return {
      success: true,
      message: "Module blueprint exported",
      data: {
        id,
        format,
        filePath,
        blueprint,
        serialized,
      },
    };
  }

  async importModuleBlueprint(data: {
    blueprint?: Record<string, unknown>;
    blueprintText?: string;
    format?: "json" | "yaml";
    filePath?: string;
    title?: string;
    clientId?: string;
    position?: string;
    published?: string;
    access?: string;
    showtitle?: string;
    ordering?: string;
    style?: string;
    language?: string;
    note?: string;
    assignment?: string;
    assigned?: string[];
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    let blueprint = data.blueprint;

    if (!blueprint && data.filePath) {
      const fileText = readFileSync(path.resolve(process.cwd(), data.filePath), "utf8");
      const fileFormat = (data.format || (data.filePath.toLowerCase().endsWith(".yaml") || data.filePath.toLowerCase().endsWith(".yml") ? "yaml" : "json")).toLowerCase();
      blueprint = (fileFormat === "yaml" ? yaml.load(fileText) : JSON.parse(fileText)) as Record<string, unknown>;
    }

    if (!blueprint && data.blueprintText) {
      const format = (data.format || "json").toLowerCase();
      blueprint = (format === "yaml" ? yaml.load(data.blueprintText) : JSON.parse(data.blueprintText)) as Record<string, unknown>;
    }

    if (!blueprint || typeof blueprint !== "object") {
      return { success: false, message: "blueprint, blueprintText, or filePath is required" };
    }

    const module = (blueprint.module || {}) as Record<string, unknown>;
    const payload = {
      title: data.title ?? String(module.title || ""),
      moduleType: String(module.moduleType || ""),
      clientId: data.clientId ?? String(module.clientId || "0"),
      position: data.position ?? String(module.position || ""),
      published: data.published ?? String(module.published || "1"),
      access: data.access ?? String(module.access || "1"),
      showtitle: data.showtitle ?? String(module.showtitle || "1"),
      ordering: data.ordering ?? String(module.ordering || "0"),
      style: data.style ?? String(module.style || "0"),
      language: data.language ?? String(module.language || "*"),
      note: data.note ?? String(module.note || ""),
      assignment: data.assignment ?? String(module.assignment || "0"),
      assigned: data.assigned ?? (Array.isArray(module.assigned) ? (module.assigned as string[]) : []),
      content: typeof module.content === "string" ? module.content : undefined,
      params: ((module.params || {}) as Record<string, string>),
      advanced: ((module.advanced || {}) as Record<string, string>),
      fieldOverrides: ((module.fieldOverrides || {}) as Record<string, string>),
    };

    if (!payload.title || !payload.moduleType) {
      return { success: false, message: "Blueprint module.title and module.moduleType are required" };
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: module blueprint parsed and ready" : "Blueprint parsed; set confirm=true to create the module",
        data: payload,
      };
    }

    const created = await this.createModule(payload);
    if (!created.success) return created;

    const modules = await this.listModules(payload.clientId || "0");
    const items = (modules.data || []) as Array<Record<string, string>>;
    const latest = this.findLatestByTitle(items, payload.title);

    return {
      success: true,
      message: "Module blueprint imported",
      data: {
        createdId: latest?.id || "",
        title: payload.title,
        moduleType: payload.moduleType,
        clientId: payload.clientId,
        source: (blueprint.source || {}) as Record<string, unknown>,
      },
    };
  }

  async updateModule(
    id: string,
    data: {
      title?: string;
      position?: string;
      published?: string;
      access?: string;
      showtitle?: string;
      ordering?: string;
      style?: string;
      language?: string;
      note?: string;
      assignment?: string;
      assigned?: string[];
      params?: Record<string, string>;
      advanced?: Record<string, string>;
      fieldOverrides?: Record<string, string>;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const existingModule = this.parseModuleForm(html);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      task: "module.save",
      "jform[title]": data.title ?? String(existingModule.title || ""),
      "jform[position]": data.position ?? String(existingModule.position || ""),
      "jform[published]": data.published ?? String(existingModule.published || "1"),
      "jform[access]": data.access ?? String(existingModule.access || "1"),
      "jform[showtitle]": data.showtitle ?? String(existingModule.showtitle || "1"),
      "jform[ordering]": data.ordering ?? String(existingModule.ordering || "0"),
      "jform[style]": data.style ?? String(existingModule.style || "0"),
      "jform[module]": String(existingModule.moduleType || "mod_custom"),
      "jform[language]": data.language ?? String(existingModule.language || "*"),
      "jform[note]": data.note ?? String(existingModule.note || ""),
      "jform[assignment]": data.assignment ?? String(existingModule.assignment || "0"),
      [token.name]: token.value,
    };

    if (data.assigned) {
      formData["jform[assigned][]"] = data.assigned;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.advanced || {})) {
      formData[`jform[advanced][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const result = await this.postPage(editUrl, formData);
    const successMsg = result.html.includes("Module saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    const verify = await this.getModule(id);
    const module = (verify.data || {}) as Record<string, unknown>;
    const expectedAssigned = data.assigned ?? (Array.isArray(existingModule.assigned) ? existingModule.assigned as string[] : []);
    const actualAssigned = Array.isArray(module.assigned) ? module.assigned as string[] : [];
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: !!verify.success && String(module.title || "") === String(formData["jform[title]"] || ""),
      positionMatches: !!verify.success && String(module.position || "") === String(formData["jform[position]"] || ""),
      publishedMatches: !!verify.success && String(module.published || "") === String(formData["jform[published]"] || ""),
      accessMatches: !!verify.success && String(module.access || "") === String(formData["jform[access]"] || ""),
      showtitleMatches: !!verify.success && String(module.showtitle || "") === String(formData["jform[showtitle]"] || ""),
      orderingMatches: !!verify.success && String(module.ordering || "") === String(formData["jform[ordering]"] || ""),
      styleMatches: !!verify.success && String(module.style || "") === String(formData["jform[style]"] || ""),
      languageMatches: !!verify.success && String(module.language || "") === String(formData["jform[language]"] || ""),
      noteMatches: !!verify.success && String(module.note || "") === String(formData["jform[note]"] || ""),
      assignmentMatches: !!verify.success && String(module.assignment || "") === String(formData["jform[assignment]"] || ""),
      assignedMatches: !this.shouldVerifyAssignedMembers(String(formData["jform[assignment]"] || "")) || (!!verify.success && JSON.stringify(actualAssigned) === JSON.stringify(expectedAssigned)),
    };
    const verified = Object.values(verification).every((value, index) => index < 2 || value === true) && verification.readbackSucceeded;

    return {
      success: verified,
      message: verified ? "Module saved" : (errorMsg ?? successMsg ? "Module save submitted, but updated values were not verified" : "Unknown result"),
      data: this.buildOperationData("module", id, {
        title: String(module.title || formData["jform[title]"] || ""),
        state: String(module.published || formData["jform[published]"] || ""),
        position: String(module.position || formData["jform[position]"] || ""),
        moduleType: String(module.moduleType || existingModule.moduleType || ""),
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async createModule(data: {
    title: string;
    moduleType: string;
    clientId?: string;
    position?: string;
    published?: string;
    access?: string;
    showtitle?: string;
    ordering?: string;
    style?: string;
    language?: string;
    note?: string;
    assignment?: string;
    assigned?: string[];
    params?: Record<string, string>;
    advanced?: Record<string, string>;
    content?: string;
    fieldOverrides?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(data.clientId || "0");
    const type = await this.resolveModuleType((typesResult.data || []) as ModuleType[], data.moduleType, data.clientId || "0");
    if (!type) {
      return { success: false, message: `Module type not found: ${data.moduleType}` };
    }

    const addUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}`);
    const { html } = await this.getPage(addUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const existingModule = this.parseModuleForm(html);
    const formData: FormDataMap = {
      ...this.extractFormFields(html, "module-form"),
      task: "module.save",
      "jform[title]": data.title,
      "jform[position]": data.position ?? String(existingModule.position || ""),
      "jform[published]": data.published ?? "1",
      "jform[access]": data.access ?? "1",
      "jform[showtitle]": data.showtitle ?? "1",
      "jform[ordering]": data.ordering ?? String(existingModule.ordering || "0"),
      "jform[style]": data.style ?? String(existingModule.style || "0"),
      "jform[module]": String(existingModule.moduleType || ""),
      "jform[language]": data.language ?? "*",
      "jform[note]": data.note ?? "",
      "jform[assignment]": data.assignment ?? "0",
      [token.name]: token.value,
    };

    if (data.content !== undefined) {
      formData["jform[content]"] = data.content;
    }

    if (data.assigned) {
      formData["jform[assigned][]"] = data.assigned;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.advanced || {})) {
      formData[`jform[advanced][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const result = await this.postPage(addUrl, formData);
    const successMsg = /module saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = await this.listModules(data.clientId || "0");
    const modules = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const savedEntry = this.findLatestByTitle(modules, data.title);
    const savedId = String(savedEntry?.id || "");
    const verify = savedId ? await this.getModule(savedId) : null;
    const module = ((verify?.data || {}) as Record<string, unknown>);
    const expectedModuleType = String(existingModule.moduleType || "").toLowerCase();
    const actualModuleType = String(module.moduleType || "").toLowerCase();
    const titleMatches = !!verify?.success && String(module.title || "") === data.title;
    const moduleTypeMatches = !!verify?.success && (!expectedModuleType || actualModuleType === expectedModuleType);
    const verified = !!savedId && titleMatches && moduleTypeMatches;

    return {
      success: verified,
      message: verified
        ? "Module saved"
        : (errorMsg ?? successMsg ? "Module save submitted, but creation was not verified" : "Unknown result"),
      data: this.buildOperationData("module", savedId, {
        title: String(module.title || data.title),
        state: String(module.published || data.published || "1"),
        position: String(module.position || data.position || ""),
        moduleType: String(module.moduleType || existingModule.moduleType || ""),
        verification: {
          attempted: true,
          foundInList: !!savedEntry,
          readbackSucceeded: !!verify?.success,
          titleMatches,
          moduleTypeMatches,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async deleteModule(id: string, options: { clientId?: string; expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getModule(id);
    const module = (before.data || {}) as Record<string, unknown>;
    const title = String(module.title || "");
    const moduleType = String(module.moduleType || "");
    const clientId = options.clientId || String(module.clientId || "0");
    if (!before.success) {
      return { success: false, message: `Refusing to delete module ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to delete module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_modules&view=modules");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      task: "modules.trash",
      "cid[]": id,
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const successMsg = /module[s]?\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = await this.listModules(clientId);
    const modules = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const stillListed = modules.some((entry) => entry.id === id);
    const verify = await this.getModule(id);
    const verified = !stillListed && (successMsg || this.isDeletionVerified(stillListed, verify, ["published", "state"]));

    return {
      success: verified,
      message: verified
        ? "Module trashed"
        : (errorMsg ?? successMsg ? "Module trash submitted, but deletion was not verified" : "Unknown result"),
      data: this.buildOperationData("module", id, {
        title,
        state: "-2",
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async checkInModule(id: string, options: { expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchModuleForm(id);
    const moduleBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(moduleBefore.title || "");
    const moduleType = String(moduleBefore.moduleType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to check in module ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to check in module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_modules&view=modules");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const result = await this.postPage(listUrl, {
      task: "modules.checkin",
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    });
    const errorMsg = this.extractAlertMessage(result.html);

    const listed = await this.listModules(String(moduleBefore.clientId || "0"));
    const listedModules = (listed.data || []) as Array<Record<string, string>>;
    const listedModule = listedModules.find((entry) => entry.id === id);
    const checkedOutCleared = !!listedModule && listedModule.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Module checked in" : (errorMsg ?? "Module check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("module", id, {
        title,
        state: String(listedModule?.state || ""),
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedModule,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== GANTRY 5 THEMES / OUTLINES ====================

  private getGantryThemeKey(theme?: string): string {
    const value = (theme || "rt_studius").trim();
    if (!value || value.toLowerCase() === "studius") return "rt_studius";
    return value;
  }

  private getGantryThemesUrl(): string {
    return this.getAdminUrl("index.php?option=com_gantry5&view=themes");
  }

  private getGantryOutlineTabUrl(outline = "default", tab = "layout", theme?: string): string {
    const safeOutline = encodeURIComponent(outline || "default");
    const safeTab = encodeURIComponent(tab || "layout");
    const safeTheme = encodeURIComponent(this.getGantryThemeKey(theme));
    return this.getAdminUrl(`index.php?option=com_gantry5&view=configurations/${safeOutline}/${safeTab}&theme=${safeTheme}`);
  }

  private parseGantryThemeConfigureUrl(html: string, theme?: string): string | null {
    const themeKey = this.getGantryThemeKey(theme);
    const $ = this.$c(html);
    let result: string | null = null;
    $("a[href*='option=com_gantry5'][href*='view=configurations/default/layout']").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes(`theme=${themeKey}`)) {
        result = this.resolveUrl(href);
        return false;
      }
    });
    return result;
  }

  private async getGantryOutlinePage(
    outline = "default",
    tab = "layout",
    theme?: string
  ): Promise<{ url: string; html: string; tabs: Record<string, string>; ajax: Record<string, string> }> {
    // Strategy: navigate to Gantry admin once (getting the session token), then derive
    // URLs for other outlines by replacing the outline segment in the entry URL.
    // This avoids re-visiting the themes page (which can burn the one-use token) and
    // avoids re-navigating at all for outlines we've already fetched.
    const cacheKey = `${this.getGantryThemeKey(theme)}::${outline}`;

    let layoutUrl = this.gantryOutlineLayoutUrls.get(cacheKey) || "";

    if (!layoutUrl) {
      // Navigate from themes page to get the "default" entry URL with its session token
      if (!this.gantryEntryUrl) {
        const themesPage = await this.getPage(this.getGantryThemesUrl());
        const configureUrl = this.parseGantryThemeConfigureUrl(themesPage.html, theme);
        this.gantryEntryUrl = configureUrl || this.getGantryOutlineTabUrl("default", "layout", theme);
      }

      if (outline === "default") {
        // Use the entry URL directly for the default outline
        layoutUrl = this.gantryEntryUrl;
      } else {
        // Derive the outline URL from the entry URL by replacing the outline name.
        // The Gantry URL format is: ...&view=configurations/default/layout&...
        // Replace the outline segment in that view param.
        const derived = this.gantryEntryUrl.replace(
          /configurations\/[^\/&?#]+\//,
          `configurations/${encodeURIComponent(outline)}/`
        );
        layoutUrl = derived !== this.gantryEntryUrl ? derived : this.gantryEntryUrl;
      }

      // Cache so subsequent calls (e.g. the liveBefore check in saveGantry5LayoutRaw)
      // reuse the same URL without re-deriving or re-navigating.
      this.gantryOutlineLayoutUrls.set(cacheKey, layoutUrl);
    }

    const layoutPage = await this.getPage(layoutUrl);

    if (tab === "layout") {
      return {
        url: layoutUrl,
        html: layoutPage.html,
        tabs: this.parseGantryTabs(layoutPage.html),
        ajax: this.parseGantryAjaxVars(layoutPage.html),
      };
    }

    const tabs = this.parseGantryTabs(layoutPage.html);
    const targetUrl = this.resolveUrl(tabs[tab] || this.getGantryOutlineTabUrl(outline, tab, theme));
    const targetPage = await this.getPage(targetUrl);
    return {
      url: targetUrl,
      html: targetPage.html,
      tabs: this.parseGantryTabs(targetPage.html),
      ajax: this.parseGantryAjaxVars(targetPage.html),
    };
  }

  private parseJsonAttribute(value: string | null): unknown {
    if (!value) return null;
    const decoded = this.decodeHtmlEntities(value);
    try {
      return JSON.parse(decoded);
    } catch {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  }

  private parseGantryAjaxVars(html: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const key of ["GANTRY_AJAX_SUFFIX", "GANTRY_AJAX_URL", "GANTRY_AJAX_CONF_URL", "GANTRY_PLATFORM"]) {
      const match = html.match(new RegExp(`var\\s+${key}\\s*=\\s*['"]([^'"]*)['"]`, "i"));
      if (match) vars[key] = this.decodeHtml(match[1]);
    }
    return vars;
  }

  private parseGantryOutlines(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const select = $("select[id='configuration-selector']");
    if (!select.length) return [];

    const outlines: Array<Record<string, unknown>> = [];
    const collectOption = ($opt: ReturnType<typeof $>, group: string) => {
      const value = $opt.attr("value") || "";
      if (!value) return;
      const data = this.parseJsonAttribute($opt.attr("data-data") ?? null) as Record<string, unknown> | null;
      outlines.push({
        id: value,
        title: $opt.text().trim(),
        group,
        selected: $opt.is("[selected]"),
        url: typeof data?.url === "string" ? data.url : "",
        params: data?.params || {},
      });
    };

    select.children("optgroup").each((_, group) => {
      const groupLabel = $(group).attr("label") || "Base Outline";
      $(group).children("option").each((_, opt) => collectOption($(opt), groupLabel));
    });

    select.children("option").each((_, opt) => collectOption($(opt), "Base Outline"));

    return outlines;
  }

  private parseGantryTabs(html: string): Record<string, string> {
    const $ = this.$c(html);
    const tabs: Record<string, string> = {};
    $("a[data-g5-nav]").each((_, el) => {
      const $el = $(el);
      const nav = $el.attr("data-g5-nav");
      const href = $el.attr("href");
      if (nav && href) tabs[nav] = href;
    });
    $("a:has(span)").each((_, el) => {
      const $el = $(el);
      if ($el.find("span").text().trim() === "Page Settings") {
        const href = $el.attr("href") || "";
        if (href.includes("view=configurations") && href.includes("/page")) {
          tabs.page = href;
        }
      }
    });
    return tabs;
  }

  private parseGantryParticleCatalog(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const catalog: Array<Record<string, unknown>> = [];
    $("li[data-lm-blocktype]").each((_, el) => {
      const $el = $(el);
      catalog.push({
        blockType: $el.attr("data-lm-blocktype") || "",
        subtype: $el.attr("data-lm-subtype") || "",
        icon: $el.attr("data-lm-icon") || "",
        title: $el.find(".particle-title").first().text().trim(),
        disabled: $el.is("[data-lm-disabled]"),
        noDrag: $el.is("[data-lm-nodrag]"),
        note: $el.attr("title") || "",
      });
    });
    return catalog;
  }

  private parseGantryLayoutRoot(html: string): { preset: unknown; root: GantryLayoutNode[] } {
    const $ = this.$c(html);
    const div = $("[class*='lm-blocks']").first();
    const preset = this.parseJsonAttribute(div.attr("data-lm-preset") ?? null);
    const root = this.parseJsonAttribute(div.attr("data-lm-root") ?? null);
    return {
      preset,
      root: Array.isArray(root) ? root as GantryLayoutNode[] : [],
    };
  }

  private validateGantrySnapshot(snapshotId: string, outline: string, theme?: string): JoomlaResponse | null {
    const snapshot = this.readSnapshot(snapshotId);
    if (!snapshot) return { success: false, message: `Snapshot not found: ${snapshotId}` };
    if (snapshot.kind !== "gantryLayout") {
      return { success: false, message: `Snapshot ${snapshotId} is ${String(snapshot.kind || "unknown")}, not gantryLayout` };
    }

    const snapshotOutline = String(snapshot.outline || "default");
    const snapshotTheme = String(snapshot.theme || "rt_studius");
    const requestedTheme = this.getGantryThemeKey(theme);
    if (snapshotOutline !== outline) {
      return { success: false, message: `Snapshot ${snapshotId} was created for outline ${snapshotOutline}, not ${outline}` };
    }
    if (snapshotTheme !== requestedTheme) {
      return { success: false, message: `Snapshot ${snapshotId} was created for theme ${snapshotTheme}, not ${requestedTheme}` };
    }

    return null;
  }

  private summarizeGantryLayout(root: GantryLayoutNode[]): Record<string, unknown> {
    const sections: Array<Record<string, unknown>> = [];
    const particles: Array<Record<string, unknown>> = [];
    const positions: Array<Record<string, unknown>> = [];
    const modules: Array<Record<string, unknown>> = [];
    const nodes: Array<Record<string, unknown>> = [];

    const visit = (node: GantryLayoutNode, path: string[], parent?: GantryLayoutNode) => {
      const id = node.id || "";
      const nodePath = [...path, id || node.type || "node"].filter(Boolean);
      const record = {
        id,
        title: node.title || "",
        type: node.type || "",
        subtype: node.subtype || "",
        path: nodePath.join(" > "),
        parentId: parent?.id || "",
        attributes: node.attributes || {},
        childCount: Array.isArray(node.children) ? node.children.length : 0,
      };
      nodes.push(record);
      if (node.type === "section" || node.type === "container" || node.type === "offcanvas") sections.push(record);
      if (node.type === "particle") particles.push(record);
      if (node.type === "position") {
        positions.push(record);
        if (node.subtype === "module") modules.push(record);
      }
      for (const child of node.children || []) visit(child, nodePath, node);
    };

    for (const node of root) visit(node, []);

    return {
      counts: {
        nodes: nodes.length,
        sections: sections.length,
        particles: particles.length,
        positions: positions.length,
        moduleInstances: modules.length,
      },
      sections,
      particles,
      positions,
      moduleInstances: modules,
      nodes,
    };
  }

  private findGantryLayoutNode(root: GantryLayoutNode[], id: string): { node: GantryLayoutNode; parent: GantryLayoutNode | null } | null {
    const visit = (node: GantryLayoutNode, parent: GantryLayoutNode | null): { node: GantryLayoutNode; parent: GantryLayoutNode | null } | null => {
      if (node.id === id) return { node, parent };
      for (const child of node.children || []) {
        const found = visit(child, node);
        if (found) return found;
      }
      return null;
    };
    for (const node of root) {
      const found = visit(node, null);
      if (found) return found;
    }
    return null;
  }

  private gantryNodeContains(node: GantryLayoutNode, id: string): boolean {
    if (node.id === id) return true;
    return (node.children || []).some((child) => this.gantryNodeContains(child, id));
  }

  private detachGantryLayoutNode(root: GantryLayoutNode[], id: string): { node: GantryLayoutNode; parentId: string } | null {
    const scan = (children: GantryLayoutNode[], parentId = ""): { node: GantryLayoutNode; parentId: string } | null => {
      const index = children.findIndex((child) => child.id === id);
      if (index >= 0) {
        const [node] = children.splice(index, 1);
        return { node, parentId };
      }
      for (const child of children) {
        const found = scan(child.children || [], child.id || "");
        if (found) return found;
      }
      return null;
    };
    return scan(root);
  }

  private async postGantryJson(url: string, data: FormDataMap): Promise<Record<string, unknown>> {
    const page = await this.getPage(url);
    const token = this.extractCsrfToken(page.html);
    if (token) {
      data[token.name] = token.value;
      this.tokenName = token.name;
    } else if (this.tokenName) {
      data[this.tokenName] = "1";
    }
    const separator = url.includes("?") ? "&" : "?";
    const result = await this.request(`${url}${separator}format=json`, {
      method: "POST",
      body: this.getFormUrlEncoded(data),
      contentType: "application/x-www-form-urlencoded",
    });
    try {
      return JSON.parse(result.body) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        status: result.status,
        message: "Gantry save did not return JSON",
        html: result.body.substring(0, 2000),
      };
    }
  }

  private parseGantrySettingsFields(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const fields: Array<Record<string, unknown>> = [];

    $("input, textarea, select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      const kind = el.tagName.toLowerCase() as "input" | "textarea" | "select";
      let value = "";
      let options: Array<Record<string, unknown>> | undefined;

      if (kind === "textarea") {
        value = $el.text();
      } else if (kind === "select") {
        const selected = $el.find("option[selected]").first();
        value = selected.length ? (selected.attr("value") ?? "") : ($el.find("option").first().attr("value") ?? "");
        options = $el.find("option").map((_, opt) => {
          const $opt = $(opt);
          return {
            value: $opt.attr("value") || "",
            label: $opt.text().trim(),
            selected: $opt.is("[selected]"),
          };
        }).get();
      } else {
        value = $el.attr("value") || "";
      }

      fields.push({
        name,
        id,
        label: this.getLabelFor(html, id),
        kind,
        inputType: kind === "input" ? ($el.attr("type") || "text") : kind,
        value,
        options,
      });
    });

    return fields;
  }

  async listGantry5Outlines(theme = "rt_studius"): Promise<JoomlaResponse> {
    const page = await this.getGantryOutlinePage("default", "layout", theme);
    const { html, url } = page;
    const outlines = this.parseGantryOutlines(html);
    return {
      success: outlines.length > 0,
      message: outlines.length > 0 ? `Found ${outlines.length} Gantry 5 Studius outlines` : "No Gantry 5 outlines found",
      data: {
        theme: this.getGantryThemeKey(theme),
        tabs: page.tabs,
        ajax: page.ajax,
        outlines,
      },
    };
  }

  async exportGantry5OutlineBlueprint(
    outline = "default",
    options: {
      theme?: string;
      format?: "json" | "yaml";
      saveToFile?: boolean;
      fileName?: string;
    } = {}
  ): Promise<JoomlaResponse> {
    const layout = await this.getGantry5Layout(outline, { theme: options.theme, includeRaw: true });
    if (!layout.success) return layout;
    const data = (layout.data || {}) as Record<string, unknown>;
    const root = (data.root || []) as GantryLayoutNode[];
    const preset = data.preset;
    const theme = this.getGantryThemeKey(options.theme);
    const references = await this.collectGantryParticleReferences(root);
    const blueprint = {
      kind: "gantry5-outline-blueprint",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: {
        theme,
        outline,
      },
      references: {
        particleFilters: references,
      },
      layout: {
        preset,
        root,
      },
      summary: this.summarizeGantryLayout(root),
    };

    const format = (options.format || "json").toLowerCase() === "yaml" ? "yaml" : "json";
    const serialized = format === "yaml"
      ? yaml.dump(blueprint, { noRefs: true, lineWidth: 120 })
      : JSON.stringify(blueprint, null, 2);

    let filePath = "";
    if (options.saveToFile) {
      mkdirSync(this.getBlueprintDir(), { recursive: true });
      const safeOutline = outline.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const ext = format === "yaml" ? "yaml" : "json";
      const fileName = (options.fileName || `gantry-outline-${safeOutline}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`)
        .replace(/[^a-zA-Z0-9_.-]/g, "_");
      filePath = path.join(this.getBlueprintDir(), fileName);
      writeFileSync(filePath, serialized, "utf8");
    }

    return {
      success: true,
      message: "Gantry outline blueprint exported",
      data: {
        format,
        theme,
        outline,
        filePath,
        blueprint,
        serialized,
      },
    };
  }

  async importGantry5OutlineBlueprint(data: {
    outline?: string;
    theme?: string;
    blueprint?: Record<string, unknown>;
    blueprintText?: string;
    format?: "json" | "yaml";
    filePath?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    let blueprint = data.blueprint as Record<string, unknown> | undefined;

    if (!blueprint && data.filePath) {
      const fileText = readFileSync(path.resolve(process.cwd(), data.filePath), "utf8");
      const fileFormat = (data.format || (data.filePath.toLowerCase().endsWith(".yaml") || data.filePath.toLowerCase().endsWith(".yml") ? "yaml" : "json")).toLowerCase();
      blueprint = (fileFormat === "yaml" ? yaml.load(fileText) : JSON.parse(fileText)) as Record<string, unknown>;
    }

    if (!blueprint && data.blueprintText) {
      const format = (data.format || "json").toLowerCase();
      blueprint = (format === "yaml" ? yaml.load(data.blueprintText) : JSON.parse(data.blueprintText)) as Record<string, unknown>;
    }

    if (!blueprint || typeof blueprint !== "object") {
      return { success: false, message: "blueprint, blueprintText, or filePath is required" };
    }

    const layout = (blueprint.layout || {}) as Record<string, unknown>;
    const root = layout.root as unknown;
    const preset = layout.preset;
    if (!Array.isArray(root)) {
      return { success: false, message: "Blueprint layout.root must be an array" };
    }

    const source = (blueprint.source || {}) as Record<string, unknown>;
    const outline = data.outline || String(source.outline || "default");
    const theme = data.theme || String(source.theme || "rt_studius");
    const references = ((((blueprint.references || {}) as Record<string, unknown>).particleFilters) || []) as GantryParticleReference[];

    let resolvedRoot = root as GantryLayoutNode[];
    let remapActions: Array<Record<string, unknown>> = [];
    if (references.length > 0) {
      const clonedRoot = JSON.parse(JSON.stringify(root)) as GantryLayoutNode[];
      const remapped = await this.remapGantryParticleReferences(clonedRoot, references, { dryRun: data.dryRun || !data.confirm });
      resolvedRoot = remapped.root;
      remapActions = remapped.actions;
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: Gantry outline blueprint parsed and ready" : "Blueprint parsed; set confirm=true to apply",
        data: {
          outline,
          theme: this.getGantryThemeKey(theme),
          summary: this.summarizeGantryLayout(resolvedRoot),
          preset,
          remapActions,
        },
      };
    }

    const save = await this.saveGantry5LayoutRaw(outline, {
      root: resolvedRoot,
      preset,
      theme,
    });

    return {
      success: save.success,
      message: save.success ? "Gantry outline blueprint applied" : save.message,
      data: {
        outline,
        theme: this.getGantryThemeKey(theme),
        remapActions,
        save: save.data,
      },
    };
  }

  async getGantry5Layout(outline = "default", options: { theme?: string; includeRaw?: boolean } = {}): Promise<JoomlaResponse> {
    const page = await this.getGantryOutlinePage(outline, "layout", options.theme);
    const { html, url } = page;
    const { preset, root } = this.parseGantryLayoutRoot(html);
    // Cache so liveBefore check in saveGantry5LayoutRaw can reuse without re-fetching.
    // Deep-clone to prevent in-place mutations from corrupting the cached pre-modification state.
    const rootCacheKey = `${this.getGantryThemeKey(options.theme)}::${outline}`;
    this.gantryLayoutRootCache.set(rootCacheKey, { root: JSON.parse(JSON.stringify(root)) as GantryLayoutNode[], preset });
    const summary = this.summarizeGantryLayout(root);
    return {
      success: true,
      message: root.length > 0 ? "Gantry 5 layout retrieved" : "Gantry 5 layout retrieved (empty root)",
      data: {
        theme: this.getGantryThemeKey(options.theme),
        outline,
        tab: "layout",
        url,
        tabs: page.tabs,
        preset,
        particleCatalog: this.parseGantryParticleCatalog(html),
        layout: summary,
        root: options.includeRaw ? root : undefined,
      },
      html: options.includeRaw ? html.substring(0, 50000) : undefined,
    };
  }

  async saveGantry5LayoutRaw(outline = "default", data: { root: unknown; preset?: unknown; snapshotId?: string; theme?: string }): Promise<JoomlaResponse> {
    if (!Array.isArray(data.root)) {
      return { success: false, message: "root must be the full Gantry layout array from joomla_gantry5_get_layout includeRaw=true" };
    }
    if (!data.snapshotId) {
      return { success: false, message: "snapshotId is required for live Gantry layout saves" };
    }

    const snapshotError = this.validateGantrySnapshot(data.snapshotId, outline, data.theme);
    if (snapshotError) return snapshotError;

    const snapshot = this.readSnapshot(data.snapshotId) as Record<string, unknown>;
    const snapshotPayload = (snapshot.payload || {}) as Record<string, unknown>;
    const snapshotLayout = (snapshotPayload.layout || {}) as Record<string, unknown>;
    const snapshotRoot = ((snapshotPayload.root || snapshotLayout.root) || []) as GantryLayoutNode[];
    const snapshotPreset = snapshotPayload.preset || "default";

    // Use cached layout root if available (avoids re-fetching which can return different HTML in Gantry)
    const rootCacheKey = `${this.getGantryThemeKey(data.theme)}::${outline}`;
    const cachedLayout = this.gantryLayoutRootCache.get(rootCacheKey);
    let liveBeforeRoot: GantryLayoutNode[];
    let liveBeforePreset: unknown;
    if (cachedLayout) {
      liveBeforeRoot = cachedLayout.root;
      liveBeforePreset = cachedLayout.preset;
    } else {
      const liveBefore = await this.getGantry5Layout(outline, { theme: data.theme, includeRaw: true });
      if (!liveBefore.success) {
        return {
          success: false,
          message: "Unable to verify current Gantry layout before saving",
          data: {
            theme: this.getGantryThemeKey(data.theme),
            outline,
            snapshotId: data.snapshotId,
          },
        };
      }
      const liveBeforeData = liveBefore.data as Record<string, unknown>;
      liveBeforeRoot = (liveBeforeData.root || []) as GantryLayoutNode[];
      liveBeforePreset = liveBeforeData.preset || "default";
    }
    const snapshotMatchesLive = JSON.stringify(snapshotRoot) === JSON.stringify(liveBeforeRoot)
      && JSON.stringify(snapshotPreset) === JSON.stringify(liveBeforePreset);
    if (!snapshotMatchesLive) {
      return {
        success: false,
        message: "Snapshot no longer matches the live Gantry layout; take a fresh snapshot before saving",
        data: {
          theme: this.getGantryThemeKey(data.theme),
          outline,
          snapshotId: data.snapshotId,
          verification: {
            attempted: true,
            snapshotMatchesLive: false,
          },
        },
      };
    }

    // Invalidate layout root cache so subsequent reads see the new layout
    this.gantryLayoutRootCache.delete(rootCacheKey);

    const page = await this.getGantryOutlinePage(outline, "layout", data.theme);
    const url = page.url;
    const response = await this.postGantryJson(url, {
      layout: JSON.stringify(data.root),
      preset: JSON.stringify(data.preset || "default"),
    });
    if (response.success !== true) {
      return {
        success: false,
        message: String(response.message || "Gantry 5 layout save failed"),
        data: {
          theme: this.getGantryThemeKey(data.theme),
          outline,
          snapshotId: data.snapshotId,
          response,
        },
      };
    }

    // Gantry normalizes the layout JSON on save (strips empty arrays, reorders keys, etc.)
    // so exact readback comparison is unreliable. Treat response.success=true as definitive.
    const live = await this.getGantry5Layout(outline, { theme: data.theme, includeRaw: true });
    const readbackSucceeded = live.success;
    let rootMatched: boolean | null = null;
    let presetMatched: boolean | null = null;
    if (readbackSucceeded) {
      const liveData = live.data as Record<string, unknown>;
      const actualRoot = (liveData.root || []) as GantryLayoutNode[];
      const actualPreset = liveData.preset;
      rootMatched = JSON.stringify(data.root) === JSON.stringify(actualRoot);
      presetMatched = JSON.stringify(data.preset || "default") === JSON.stringify(actualPreset || "default");
    }
    return {
      success: true,
      message: "Gantry 5 layout saved",
      data: {
        theme: this.getGantryThemeKey(data.theme),
        outline,
        snapshotId: data.snapshotId,
        response,
        verification: {
          attempted: true,
          readbackSucceeded,
          rootMatched,
          presetMatched,
        },
      },
    };
  }

  async toggleModule(id: string, state: string, options: { expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getModule(id);
    const moduleBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(moduleBefore.title || "");
    const moduleType = String(moduleBefore.moduleType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to change module ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to change module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to change module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_modules&view=modules");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const task = state === "1" ? "modules.publish" : "modules.unpublish";
    const formData: Record<string, string> = {
      task,
      "cid[]": id,
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const successMsg = /module[s]?\s+(published|unpublished)|has been/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);

    const verify = await this.getModule(id);
    const module = (verify.data || {}) as Record<string, unknown>;
    const actualState = String(module.published || "");
    const verified = verify.success && actualState === state;

    return {
      success: verified,
      message: verified
        ? `Module ${state === "1" ? "published" : "unpublished"}`
        : (errorMsg ?? successMsg ? "Module state was not verified after submit" : "Unknown result"),
      data: this.buildOperationData("module", id, {
        title: String(module.title || title),
        state: actualState,
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          requestedState: state,
          actualState,
          verified,
        },
      }),
      html: result.html,
    };
  }

  // ==================== MENUS ====================

  private parseMenuList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const menus: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const titleLink = $row.find("a[href*='view=items']").first();
      const title = titleLink.text().trim();
      if (!title) return;
      const menuTypeLink = $row.find("a[href*='task=menu.edit']").first();
      menus.push({
        id: cid,
        title,
        menuType: menuTypeLink.text().trim(),
      });
    });
    return menus;
  }

  async listMenus(): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_menus&view=menus");
    const { html } = await this.getPage(url);
    const menus = this.parseMenuList(html);
    return {
      success: true,
      message: `Found ${menus.length} menus`,
      data: menus,
      html,
    };
  }

  async createMenu(data: {
    title: string;
    menuType?: string;
    description?: string;
    cssClasses?: string;
  }): Promise<JoomlaResponse> {
    const menuType = data.menuType || data.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const url = this.getAdminUrl("index.php?option=com_menus&task=menu.add");
    const { html } = await this.getPage(url);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      ...this.extractFormFields(html, "item-form"),
      task: "menu.save",
      "jform[title]": data.title,
      "jform[menutype]": menuType,
      "jform[description]": data.description || "",
      "jform[css_classes]": data.cssClasses || "",
      [token.name]: token.value,
    };

    const result = await this.postPage(url, formData);
    const successMsg = /menu saved|has been saved|item saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = await this.listMenus();
    const menus = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const savedMenu = menus.find((menu) => menu.title === data.title && menu.menuType === menuType);
    const verified = !!savedMenu;

    return {
      success: verified,
      message: verified ? "Menu saved" : (errorMsg ?? successMsg ? "Menu save submitted, but creation was not verified" : "Unknown result"),
      data: {
        id: String(savedMenu?.id || ""),
        title: data.title,
        menuType,
        verification: {
          attempted: true,
          foundInList: verified,
          verified,
        },
      },
      html: result.html,
    };
  }

  private parseMenuItemList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const items: Array<Record<string, string>> = [];
    const ancestorStack: Array<{ id: string; title: string }> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const $titleLink = $row.find("a[href*='task=item.edit']").first();
      const title = $titleLink.text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      const type = $row.find("div[title] span.small").first().text().trim();
      // Joomla renders one '–' (en dash) before the title link per depth level
      const $td = $titleLink.closest("td");
      const tdHtml = $.html($td) || "";
      const aIdx = tdHtml.indexOf("<a");
      const beforeLink = aIdx >= 0 ? tdHtml.substring(0, aIdx) : "";
      const depth = (beforeLink.match(/–/g) || []).length;
      while (ancestorStack.length > depth) ancestorStack.pop();
      const parent = ancestorStack.length > 0 ? ancestorStack[ancestorStack.length - 1] : null;
      ancestorStack.push({ id: cid, title });
      items.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        type,
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
        parentId: parent?.id ?? "",
        parentTitle: parent ? parent.title : "Root",
      });
    });
    return items;
  }

  async listMenuItems(menuId: string, search?: string, limit?: number, page?: number): Promise<JoomlaResponse> {
    const effectiveLimit = limit != null ? Math.min(limit, 500) : 0;
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = effectiveLimit > 0 ? (effectivePage - 1) * effectiveLimit : 0;
    const params = new URLSearchParams({
      "option": "com_menus",
      "view": "items",
      "menutype": menuId,
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const items = this.parseMenuItemList(html);
    return {
      success: true,
      message: `Found ${items.length} menu items${search ? `, search="${search}"` : ""}`,
      data: items,
      html,
    };
  }

  async listMenuItemTypes(): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_menus&view=menutypes&tmpl=component&client_id=0&recordId=0");
    const { html } = await this.getPage(url);
    const types = this.parseMenuItemTypes(html);

    return {
      success: true,
      message: `Found ${types.length} menu item types`,
      data: types,
      html,
    };
  }

  private async fetchMenuItemForm(id: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`);
    const { html } = await this.getPage(url);
    const item = this.parseMenuItemForm(html);

    return {
      success: !!item.title,
      message: item.title ? "Menu item retrieved" : "Failed to parse menu item form",
      data: item,
      html,
    };
  }

  async getMenuItem(id?: string, title?: string, menuId?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchMenuItemsByTitle(title, menuId);
      if (matches.length === 0) return { success: false, message: `No menu item found matching title '${title}'` };
      if (matches.length === 1) return this.getMenuItem(matches[0].id);
      return { success: true, message: `Multiple menu items found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchMenuItemForm(id!);
    if (result.success) {
      const ci = await this.checkInMenuItem(id!);
      if (!ci.success) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    return result;
  }

  async inspectMenuItemType(itemType: string): Promise<JoomlaResponse> {
    const typesResult = await this.listMenuItemTypes();
    const types = (typesResult.data || []) as MenuItemType[];
    const type = this.findMenuItemType(types, itemType);

    if (!type) {
      return {
        success: false,
        message: `Menu item type not found: ${itemType}`,
        data: types.map(({ group, label, title, request }) => ({ group, label, title, request })),
      };
    }

    return {
      success: true,
      message: "Menu item type retrieved",
      data: {
        ...type,
        link: this.buildLinkFromRequest(type.request),
        requestFields: Object.keys(type.request),
        commonFields: [
          "title",
          "menuType",
          "alias",
          "parentId",
          "published",
          "access",
          "language",
          "browserNav",
          "home",
          "note",
        ],
        overrideExamples: [
          "request.id for Single Article or Category Blog/List",
          "params.menu-anchor_title for link title attributes",
          "params.menu_image for menu images",
          "fieldOverrides can set any raw Joomla field name such as jform[params][show_page_heading]",
        ],
      },
    };
  }

  async createMenuItem(data: {
    title: string;
    menuType: string;
    itemType: string;
    alias?: string;
    link?: string;
    parentId?: string;
    published?: string;
    access?: string;
    language?: string;
    browserNav?: string;
    home?: string;
    note?: string;
    templateStyleId?: string;
    request?: Record<string, string>;
    params?: Record<string, string>;
    fieldOverrides?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const typesResult = await this.listMenuItemTypes();
    const types = (typesResult.data || []) as MenuItemType[];
    const type = this.findMenuItemType(types, data.itemType);
    if (!type) {
      return { success: false, message: `Menu item type not found: ${data.itemType}` };
    }

    const newItemUrl = this.getAdminUrl("index.php?option=com_menus&task=item.add");
    const { html } = await this.getPage(newItemUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const setTypeFormData: Record<string, string> = {
      ...this.extractFormFields(html),
      task: "item.setType",
      fieldtype: "type",
      "jform[type]": type.encoded,
      "jform[menutype]": data.menuType,
      [token.name]: token.value,
    };
    const typedPage = await this.postPage(newItemUrl, setTypeFormData);
    const typedHtml = typedPage.html || html;
    const typedToken = this.extractCsrfToken(typedHtml) || token;
    const request = { ...type.request, ...(data.request || {}) };
    const formData: Record<string, string> = {
      ...this.extractFormFields(typedHtml),
      task: "item.save",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[menutype]": data.menuType,
      "jform[type]": type.encoded,
      "jform[link]": data.link || this.buildLinkFromRequest(request),
      "jform[parent_id]": data.parentId || "1",
      "jform[published]": data.published ?? "1",
      "jform[access]": data.access || "1",
      "jform[language]": data.language || "*",
      "jform[browserNav]": data.browserNav || "0",
      "jform[home]": data.home || "0",
      "jform[note]": data.note || "",
      "jform[template_style_id]": data.templateStyleId || "0",
      [typedToken.name]: typedToken.value,
    };

    for (const [key, value] of Object.entries(request)) {
      formData[`jform[request][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const result = await this.postPage(newItemUrl, formData);
    const successMsg = /menu item saved|item saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    let savedId = "";
    if (successMsg) {
      const itemsResult = await this.listMenuItems(data.menuType);
      const items = Array.isArray(itemsResult.data) ? itemsResult.data as Array<Record<string, string>> : [];
      const exactMatches = items.filter((item) => item.title === data.title);
      savedId = exactMatches[exactMatches.length - 1]?.id || "";
    }
    const verify = savedId ? await this.getMenuItem(savedId) : null;
    const item = ((verify?.data || {}) as Record<string, unknown>);
    const verification = {
      attempted: true,
      foundInList: !!savedId,
      readbackSucceeded: !!verify?.success,
      titleMatches: !!verify?.success && String(item.title || "") === data.title,
      aliasMatches: !!verify?.success && this.verifyAlias(String(item.alias || ""), data.alias),
      menuTypeMatches: !!verify?.success && String(item.menuType || "") === data.menuType,
      parentMatches: !!verify?.success && String(item.parentId || "") === String(data.parentId || "1"),
      publishedMatches: !!verify?.success && String(item.published || "") === String(data.published ?? "1"),
      accessMatches: !!verify?.success && String(item.access || "") === String(data.access || "1"),
      languageMatches: !!verify?.success && String(item.language || "") === String(data.language || "*"),
      browserNavMatches: !!verify?.success && String(item.browserNav || "") === String(data.browserNav || "0"),
      homeMatches: !!verify?.success && String(item.home || "") === String(data.home || "0"),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Menu item saved" : (errorMsg ?? successMsg ? "Menu item save submitted, but creation was not verified" : "Unknown result"),
      data: this.buildOperationData("menuItem", savedId, {
        title: String(item.title || data.title),
        state: String(item.published || data.published || "1"),
        alias: String(item.alias || data.alias || ""),
        menuType: String(item.menuType || data.menuType),
        parentId: String(item.parentId || data.parentId || "1"),
        itemType: type.title || data.itemType,
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async updateMenuItem(
    id: string,
    data: {
    title?: string;
    itemType?: string;
    alias?: string;
    menuType?: string;
    link?: string;
      parentId?: string;
      published?: string;
      access?: string;
      language?: string;
      browserNav?: string;
      home?: string;
      note?: string;
      templateStyleId?: string;
      ordering?: string;
      request?: Record<string, string>;
      params?: Record<string, string>;
      fieldOverrides?: Record<string, string>;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const existing = this.parseMenuItemForm(html);
    const token = this.extractCsrfToken(html);
    let type = null as MenuItemType | null;

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    if (data.itemType) {
      const typesResult = await this.listMenuItemTypes();
      const types = (typesResult.data || []) as MenuItemType[];
      type = this.findMenuItemType(types, data.itemType);
      if (!type) {
        return { success: false, message: `Menu item type not found: ${data.itemType}` };
      }
    }

    // When changing type, POST item.setType first so the server returns form HTML with
    // component_id (and other hidden fields) correctly set for the new type — same as
    // what the browser's JS does when a user picks a type from the dropdown.
    let formBaseHtml = html;
    let effectiveToken = token;
    if (type) {
      const setTypeFormData: Record<string, string> = {
        ...this.extractFormFields(html),
        task: "item.setType",
        fieldtype: "type",
        "jform[type]": type.encoded,
        "jform[menutype]": data.menuType ?? String(existing.menuType || ""),
        [token.name]: token.value,
      };
      const typedPage = await this.postPage(editUrl, setTypeFormData);
      formBaseHtml = typedPage.html || html;
      effectiveToken = this.extractCsrfToken(formBaseHtml) || token;
    }

    const request = { ...((type?.request || existing.request) as Record<string, string>), ...(data.request || {}) };
    const formData: Record<string, string> = {
      ...this.extractFormFields(formBaseHtml),
      task: "item.save",
      "jform[title]": data.title ?? String(existing.title || ""),
      "jform[alias]": data.alias ?? String(existing.alias || ""),
      "jform[menutype]": data.menuType ?? String(existing.menuType || ""),
      "jform[type]": type?.encoded ?? String(existing.type || ""),
      "jform[link]": data.link ?? (type ? this.buildLinkFromRequest(request) : String(existing.link || this.buildLinkFromRequest(request))),
      "jform[parent_id]": data.parentId ?? String(existing.parentId || "1"),
      "jform[published]": data.published ?? String(existing.published || "1"),
      "jform[access]": data.access ?? String(existing.access || "1"),
      "jform[language]": data.language ?? String(existing.language || "*"),
      "jform[browserNav]": data.browserNav ?? String(existing.browserNav || "0"),
      "jform[home]": data.home ?? String(existing.home || "0"),
      "jform[note]": data.note ?? String(existing.note || ""),
      "jform[template_style_id]": data.templateStyleId ?? String(existing.templateStyleId || "0"),
      [effectiveToken.name]: effectiveToken.value,
    };

    for (const [key, value] of Object.entries(request)) {
      formData[`jform[request][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    if (data.ordering !== undefined) {
      formData["jform[menuordering]"] = data.ordering;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const result = await this.postPage(editUrl, formData);
    const successMsg = /menu item saved|item saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const verify = await this.getMenuItem(id);
    const item = (verify.data || {}) as Record<string, unknown>;
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: !!verify.success && String(item.title || "") === String(formData["jform[title]"] || ""),
      aliasMatches: !!verify.success && String(item.alias || "") === String(formData["jform[alias]"] || ""),
      menuTypeMatches: !!verify.success && String(item.menuType || "") === String(formData["jform[menutype]"] || ""),
      parentMatches: !!verify.success && String(item.parentId || "") === String(formData["jform[parent_id]"] || ""),
      publishedMatches: !!verify.success && String(item.published || "") === String(formData["jform[published]"] || ""),
      accessMatches: !!verify.success && String(item.access || "") === String(formData["jform[access]"] || ""),
      languageMatches: !!verify.success && String(item.language || "") === String(formData["jform[language]"] || ""),
      browserNavMatches: !!verify.success && String(item.browserNav || "") === String(formData["jform[browserNav]"] || ""),
      homeMatches: !!verify.success && String(item.home || "") === String(formData["jform[home]"] || ""),
      noteMatches: !!verify.success && String(item.note || "") === String(formData["jform[note]"] || ""),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Menu item saved" : (errorMsg ?? successMsg ? "Menu item save submitted, but updated values were not verified" : "Unknown result"),
      data: this.buildOperationData("menuItem", id, {
        title: String(item.title || formData["jform[title]"] || ""),
        state: String(item.published || formData["jform[published]"] || ""),
        alias: String(item.alias || formData["jform[alias]"] || ""),
        menuType: String(item.menuType || formData["jform[menutype]"] || ""),
        parentId: String(item.parentId || formData["jform[parent_id]"] || ""),
        verification: {
          ...verification,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async deleteMenuItem(id: string, options: { expectedTitle?: string; expectedMenuType?: string; menuType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getMenuItem(id);
    const item = (before.data || {}) as Record<string, unknown>;
    const title = String(item.title || "");
    const menuType = options.menuType || String(item.menuType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to delete menu item ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete menu item ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedMenuType && menuType !== options.expectedMenuType) {
      return { success: false, message: `Refusing to delete menu item ${id}: expected menuType ${options.expectedMenuType}, found ${menuType}` };
    }

    const listUrl = this.getAdminUrl("index.php?option=com_menus&view=items");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: Record<string, string> = {
      task: "items.trash",
      "cid[]": id,
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const successMsg = /menu item[s]?\s+(trashed|deleted)|item[s]?\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const listResult = menuType ? await this.listMenuItems(menuType) : null;
    const items = Array.isArray(listResult?.data) ? listResult?.data as Array<Record<string, string>> : [];
    const stillListed = items.some((entry) => entry.id === id);
    const verify = await this.getMenuItem(id);
    const verified = this.isDeletionVerified(stillListed, verify, ["published", "state"]);

    return {
      success: verified,
      message: verified
        ? "Menu item trashed"
        : (errorMsg ?? successMsg ? "Menu item trash submitted, but deletion was not verified" : "Unknown result"),
      data: this.buildOperationData("menuItem", id, {
        title,
        state: "-2",
        menuType,
        verification: {
          attempted: true,
          preflightVerified: true,
          listCheckAttempted: !!menuType,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async toggleMenuItem(id: string, state: string, menuType?: string, options: { expectedTitle?: string; expectedMenuType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.getMenuItem(id);
    const itemBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(itemBefore.title || "");
    const actualMenuType = menuType || String(itemBefore.menuType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to change menu item ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to change menu item ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedMenuType && actualMenuType !== options.expectedMenuType) {
      return { success: false, message: `Refusing to change menu item ${id}: expected menuType ${options.expectedMenuType}, found ${actualMenuType}` };
    }

    const listUrl = this.getMenuItemsListUrl(actualMenuType);
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const task = state === "1" ? "items.publish" : "items.unpublish";
    const result = await this.postPage(listUrl, {
      task,
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    });
    const successMsg = /item[s]?\s+(published|unpublished)|has been (published|unpublished)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const verify = await this.getMenuItem(id);
    const item = (verify.data || {}) as Record<string, unknown>;
    const actualState = String(item.published || "");
    const verified = verify.success && actualState === state;

    return {
      success: verified,
      message: verified
        ? `Menu item ${state === "1" ? "published" : "unpublished"}`
        : (errorMsg ?? successMsg ? `Menu item state was not verified after ${task}` : "Unknown result"),
      data: this.buildOperationData("menuItem", id, {
        title: String(item.title || title),
        state: actualState,
        verification: {
          attempted: true,
          preflightVerified: true,
          requestedState: state,
          actualState,
          verified,
        },
        menuType: actualMenuType,
      }),
      html: result.html,
    };
  }

  async checkInMenuItem(id: string, menuType?: string, options: { expectedTitle?: string; expectedMenuType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchMenuItemForm(id);
    const itemBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(itemBefore.title || "");
    const actualMenuType = menuType || String(itemBefore.menuType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to check in menu item ${id} because the current target could not be verified` };
    }
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in menu item ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedMenuType && actualMenuType !== options.expectedMenuType) {
      return { success: false, message: `Refusing to check in menu item ${id}: expected menuType ${options.expectedMenuType}, found ${actualMenuType}` };
    }

    const listUrl = this.getMenuItemsListUrl(actualMenuType);
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const result = await this.postPage(listUrl, {
      task: "items.checkin",
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    });
    const errorMsg = this.extractAlertMessage(result.html);

    const listed = await this.listMenuItems(actualMenuType);
    const listedItems = (listed.data || []) as Array<Record<string, string>>;
    const listedItem = listedItems.find((entry) => entry.id === id);
    const checkedOutCleared = !!listedItem && listedItem.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Menu item checked in" : (errorMsg ?? "Menu item check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("menuItem", id, {
        title,
        state: String(listedItem?.state || ""),
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedItem,
          checkedOutCleared,
        },
        menuType: actualMenuType,
      }),
      html: result.html,
    };
  }

  // ==================== UTILITIES ====================

  async getPageContent(path: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(path);
    const { html } = await this.getPage(url);
    return {
      success: true,
      message: "Page retrieved",
      html: html.substring(0, 50000),
    };
  }

  private findMainContent($: ReturnType<typeof cheerioLoad>) {
    const selectors = [
      "#g-mainbar", "#g-content", "#g-container-main", // Gantry5 (before generic "main")
      "[role='main']",
      "#sp-main-body", "#sp-component",                // Protostar/Cassiopeia
      ".com-content-article", ".item-page", "article", ".blog",
      "#content", "main",
    ];
    for (const sel of selectors) {
      const el = $(sel);
      // require at least 150 chars of text so we skip empty wrappers
      if (el.length > 0 && el.first().text().trim().length > 150) return el.first();
    }
    return $("body");
  }

  async getFrontendPageInfo(path: string): Promise<JoomlaResponse> {
    const url = path.startsWith("http")
      ? path
      : path.startsWith("/")
        ? `${this.getBaseUrl()}${path}`
        : `${this.getBaseUrl()}/${path}`;

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36" },
      redirect: "follow",
    });
    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status} fetching ${url}` };
    }
    const html = await response.text();
    const $ = cheerioLoad(html);

    // --- existing fields ---
    const pageTitle = $("title").first().text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription = $("meta[name='description']").attr("content")?.trim() ?? "";
    const canonicalUrl = $("link[rel='canonical']").attr("href")?.trim() ?? url;
    const siteName = $("meta[property='og:site_name']").attr("content")?.trim() ?? "";
    const cleanTitle = siteName && pageTitle.endsWith(` - ${siteName}`)
      ? pageTitle.slice(0, -(` - ${siteName}`).length).trim()
      : pageTitle;

    // --- headings ---
    const headings: { level: number; text: string }[] = [];
    $("h1, h2, h3, h4").slice(0, 50).each((_, el) => {
      const level = parseInt(el.tagName.replace("h", ""), 10);
      const text = $(el).text().trim();
      if (text) headings.push({ level, text });
    });

    // --- main content area ---
    const mainContent = this.findMainContent($);
    const mainClone = mainContent.clone();
    mainClone.find("script, style, noscript, nav, header, footer, .nav, .navbar, .breadcrumb, .pagination, #sp-menu, #sp-top-bar, #sp-header, #sp-footer, #sp-bottom").remove();

    // --- bodyText ---
    const rawText = mainClone.text().replace(/\s+/g, " ").trim();
    const bodyText = rawText.length > 8000
      ? rawText.slice(0, 8000) + ` [truncated — ${rawText.length} chars total]`
      : rawText;

    // --- links ---
    const seenHrefs = new Set<string>();
    const links: { text: string; href: string; rel?: string }[] = [];
    mainContent.find("a[href]").each((_, el) => {
      if (links.length >= 100) return;
      const rawHref = $(el).attr("href") ?? "";
      if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) return;
      const text = $(el).text().trim();
      if (!text) return;
      let href = rawHref;
      try { href = new URL(rawHref, url).href; } catch { return; }
      if (seenHrefs.has(href)) return;
      seenHrefs.add(href);
      const rel = $(el).attr("rel");
      links.push(rel ? { text, href, rel } : { text, href });
    });

    // --- images ---
    const images: { src: string; alt: string }[] = [];
    mainContent.find("img[src]").each((_, el) => {
      if (images.length >= 20) return;
      const rawSrc = $(el).attr("src") ?? "";
      if (!rawSrc || rawSrc.startsWith("data:") || rawSrc.includes("/media/system/")) return;
      let src = rawSrc;
      try { src = new URL(rawSrc, url).href; } catch { return; }
      images.push({ src, alt: $(el).attr("alt") ?? "" });
    });

    // --- forms ---
    const forms: { action: string; method: string; fieldNames: string[] }[] = [];
    $("form").each((_, el) => {
      if (forms.length >= 10) return;
      const fieldNames = [...new Set(
        $(el).find("input[name], select[name], textarea[name]")
          .map((__, f) => $(f).attr("name") ?? "").get().filter(Boolean)
      )];
      if (fieldNames.length === 0) return;
      let action = $(el).attr("action") ?? url;
      try { action = new URL(action, url).href; } catch { /* keep as-is */ }
      const method = ($(el).attr("method") ?? "GET").toUpperCase();
      forms.push({ action, method, fieldNames });
    });

    // --- openGraph ---
    const ogTitle = $("meta[property='og:title']").attr("content")?.trim();
    const ogDescription = $("meta[property='og:description']").attr("content")?.trim();
    const ogImage = $("meta[property='og:image']").attr("content")?.trim();
    const ogType = $("meta[property='og:type']").attr("content")?.trim();
    const openGraph = (ogTitle || ogDescription || ogImage || ogType || siteName)
      ? { title: ogTitle, description: ogDescription, image: ogImage, type: ogType, siteName: siteName || undefined }
      : undefined;

    // --- structuredData ---
    const structuredData: unknown[] = [];
    $("script[type='application/ld+json']").each((_, el) => {
      if (structuredData.length >= 5) return;
      try { structuredData.push(JSON.parse($(el).html() ?? "")); } catch { /* skip invalid */ }
    });

    // --- joomlaTemplate ---
    let joomlaTemplate = "unknown";
    $("link[rel='stylesheet']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const match = href.match(/\/templates\/([^/]+)\//);
      if (match) { joomlaTemplate = match[1]; return false; }
    });
    const bodyClasses = $("body").attr("class") ?? "";
    const htmlClasses = $("html").attr("class") ?? "";
    const allClasses = bodyClasses + " " + htmlClasses;
    if (allClasses.match(/\bg-[a-z]/i) || $("[id='g-page-surround']").length > 0) {
      const cssHref = $("link[rel='stylesheet'][href*='gantry5']").attr("href") ?? "";
      const themeMatch = cssHref.match(/themes\/([^/]+)\//);
      joomlaTemplate = themeMatch ? `gantry5 (${themeMatch[1]})` : "gantry5";
    } else if (joomlaTemplate.includes("cassiopeia")) {
      joomlaTemplate = "cassiopeia";
    } else if (joomlaTemplate.includes("protostar")) {
      joomlaTemplate = "protostar";
    }

    // --- joomlaContext ---
    const bodyClassList = bodyClasses.split(/\s+/);
    const component = bodyClassList.find(c => c.startsWith("com-"))?.replace("com-", "com_").replace(/-/g, "_") ?? null;
    const view = bodyClassList.find(c => c.startsWith("view-"))?.replace("view-", "") ?? null;
    const layout = bodyClassList.find(c => c.startsWith("layout-"))?.replace("layout-", "") ?? null;
    const itemidRaw = bodyClassList.find(c => c.startsWith("itemid-"));
    const itemid = itemidRaw ? itemidRaw.replace("itemid-", "") : null;
    const language = $("html").attr("lang") ?? null;
    const joomlaContext = { component, view, layout, itemid, language };

    // --- articleTitles ---
    const articleTitleSet = new Set<string>();
    const articleSelectors = [
      "h2.article-title", "h3.article-title",
      "h2[itemprop='name']", "h3[itemprop='name']",
      "h2.contentheading", "h3.contentheading",
      "article header h2", "article header h3",
      "[itemtype*='schema.org/Article'] [itemprop='name']",
    ];
    for (const sel of articleSelectors) {
      $(sel).each((_, el) => {
        const t = $(el).text().trim();
        if (t) articleTitleSet.add(t);
      });
    }
    // Catch-all: h2/h3 directly wrapping a link (standard Joomla blog layout)
    $("h2 > a[href], h3 > a[href]").each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href") ?? "";
      if (text && href && !href.startsWith("javascript:")) articleTitleSet.add(text);
    });
    const articleTitles = [...articleTitleSet].slice(0, 20);

    // --- modulePositions ---
    const positionSet = new Set<string>();
    $("[id^='sp-']").each((_, el) => {
      const pos = ($(el).attr("id") ?? "").replace(/^sp-/, "");
      if (pos) positionSet.add(pos);
    });
    $("[id^='g-']").each((_, el) => {
      const pos = ($(el).attr("id") ?? "").replace(/^g-/, "");
      if (pos) positionSet.add(pos);
    });
    $("div[data-gantry-position]").each((_, el) => {
      const pos = $(el).attr("data-gantry-position");
      if (pos) positionSet.add(pos);
    });
    const modulePositions = [...positionSet];

    return {
      success: true,
      message: `Frontend page retrieved: ${url}`,
      data: {
        url, pageTitle, cleanTitle, h1, metaDescription, canonicalUrl,
        headings, bodyText, links, images, forms, openGraph, structuredData,
        joomlaTemplate, joomlaContext, articleTitles, modulePositions,
      },
    };
  }

  async getFrontendScreenshot(
    inputPath: string,
    viewport: 'mobile' | 'tablet' | 'desktop' = 'desktop'
  ): Promise<JoomlaResponse> {
    const url = inputPath.startsWith('http')
      ? inputPath
      : inputPath.startsWith('/')
        ? `${this.getBaseUrl()}${inputPath}`
        : `${this.getBaseUrl()}/${inputPath}`;

    const VIEWPORTS = {
      mobile:  { width: 390,  height: 844 },
      tablet:  { width: 768,  height: 1024 },
      desktop: { width: 1280, height: 800 },
    };
    const { width, height } = VIEWPORTS[viewport];

    if (!this._browser || !this._browser.connected) {
      this._browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }

    const page = await this._browser.newPage();
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');
      await page.setViewport({ width, height });

      const cookieDomain = new URL(this.getBaseUrl()).hostname;
      const urlDomain = new URL(url).hostname;
      const cookieEntries = Array.from(this.cookies.entries());
      if (cookieEntries.length > 0 && urlDomain === cookieDomain) {
        await page.setCookie(
          ...cookieEntries.map(([name, value]) => ({ name, value, domain: cookieDomain }))
        );
      }

      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      if (!response || !response.ok()) {
        return { success: false, message: `HTTP ${response?.status() ?? '?'} fetching ${url}` };
      }
      await new Promise(r => setTimeout(r, 2000));

      const pageTitle = await page.title();
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      const base64 = Buffer.from(screenshotBuffer).toString('base64');

      return {
        success: true,
        message: `Screenshot captured: ${url}`,
        data: { url, pageTitle, viewport, width, height, base64 },
      };
    } finally {
      await page.close();
    }
  }

  // ==================== MEDIA UPLOAD ====================

  async uploadMediaFile(data: {
    fileUrl?: string;
    base64Content?: string;
    fileName?: string;
    folder?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    if (!data.fileUrl && !(data.base64Content && data.fileName)) {
      return { success: false, message: "Either fileUrl or (base64Content + fileName) is required" };
    }

    let fileContent: Buffer;
    let fileName: string;

    if (data.fileUrl) {
      const response = await fetch(data.fileUrl);
      if (!response.ok) {
        return { success: false, message: `Failed to download file from ${data.fileUrl}: HTTP ${response.status}` };
      }
      fileContent = Buffer.from(await response.arrayBuffer());
      fileName = data.fileName || data.fileUrl.split("/").pop()?.split("?")[0] || "upload.bin";
    } else {
      fileContent = Buffer.from(data.base64Content!, "base64");
      fileName = data.fileName!;
    }

    const targetFolder = data.folder ?? "";

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Would upload "${fileName}" (${fileContent.length} bytes) to folder "${targetFolder}". Pass confirm=true to proceed.`,
        data: { fileName, fileSize: fileContent.length, targetFolder, dryRun: true },
      };
    }

    // Navigate to the media page with the target folder so we get the correct upload form action URL
    const folderParam = targetFolder ? `&folder=${encodeURIComponent(targetFolder)}` : "";
    const mediaPageUrl = this.getAdminUrl(`index.php?option=com_media${folderParam}`);
    const { html } = await this.getPage(mediaPageUrl);

    // Extract the real upload form action URL (contains CSRF token in query string)
    const $ = this.$c(html);
    const uploadFormAction = $("form#uploadForm").attr("action");
    if (!uploadFormAction) {
      return { success: false, message: "Failed to find upload form on media page" };
    }

    // Extract hidden fields from the upload form (folder, CSRF token if in body, etc.)
    const formData = new FormData();
    $("form#uploadForm input[type='hidden']").each((_: number, el: any) => {
      const name = $(el).attr("name");
      const value = $(el).attr("value") ?? "";
      if (name) formData.append(name, value);
    });

    // Ensure folder is set correctly (hidden field may already have it, but override to be sure)
    formData.set("folder", targetFolder);

    const blob = new Blob([new Uint8Array(fileContent)], { type: this.getMimeType(fileName) });
    formData.append("Filedata[]", blob, fileName);

    const uploadUrl = uploadFormAction.startsWith("http")
      ? uploadFormAction
      : this.getAdminUrl(uploadFormAction);

    const result = await this.request(uploadUrl, { method: "POST", body: formData });

    // Joomla redirects (303) after upload — follow the Location header to get the result page
    let resultHtml = result.body;
    if (result.status === 303 || result.status === 302) {
      const location = result.headers.get("location");
      if (location) {
        const redirectUrl = location.startsWith("http") ? location : this.getAdminUrl(location);
        const redirectResult = await this.request(redirectUrl);
        resultHtml = redirectResult.body;
      }
    }

    // Only treat the upload as failed if there is an error/warning alert (not a success alert)
    const $r = this.$c(resultHtml);
    const errorMsg = $r('.alert-error .alert-message, .alert-danger .alert-message, .alert-warning .alert-message').first().text().trim() || null;
    const isSuccess = result.status < 500 && !errorMsg;

    const uploadedPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    return {
      success: isSuccess,
      message: isSuccess ? `Uploaded: ${uploadedPath}` : (errorMsg || `Upload failed (HTTP ${result.status})`),
      data: { fileName, fileSize: fileContent.length, targetFolder, uploadedPath },
    };
  }

  private getMimeType(fileName: string): string {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
    };
    return map[ext] || "application/octet-stream";
  }

  // ==================== BULK CHECKIN ====================

  async bulkCheckin(data: { dryRun?: boolean; confirm?: boolean } = {}): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_checkin");
    const { html } = await this.getPage(url);
    const $ = this.$c(html);

    const items: Array<{ id: string; title: string; type: string; editor: string; time: string }> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const cells = $row.find("td");
      items.push({
        id: cid,
        title: $(cells[1]).text().trim(),
        type: $(cells[2]).text().trim(),
        editor: $(cells[3]).text().trim(),
        time: $(cells[4]).text().trim(),
      });
    });

    if (items.length === 0) {
      return { success: true, message: "No checked-out items found — nothing to check in", data: { items: [] } };
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Found ${items.length} checked-out item(s). Pass confirm=true to check them all in.`,
        data: { items, dryRun: true },
      };
    }

    const token = this.extractCsrfToken(html);
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token from checkin page" };
    }

    const formData: FormDataMap = {
      task: "checkin.checkin",
      [token.name]: token.value,
      boxchecked: String(items.length),
      "cid[]": items.map((i) => i.id),
    };

    await this.postPage(url, formData);

    // Verify by re-loading the checkin page
    const verify = await this.getPage(url);
    const remaining = this.$c(verify.html)("input[name='cid[]']").length;
    const success = remaining === 0;

    return {
      success,
      message: success
        ? `Checked in ${items.length} item(s)`
        : `Check-in submitted, but ${remaining} item(s) still appear checked out`,
      data: { checkedIn: items, remainingCount: remaining },
    };
  }

  private decodeHtml(html: string): string {
    return this.decodeHtmlEntities(html)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
  }

  private decodeHtmlEntities(html: string): string {
    return html
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&ndash;/g, "-");
  }
}
