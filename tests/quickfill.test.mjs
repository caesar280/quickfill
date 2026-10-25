import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = path.resolve(import.meta.dirname, "..");
const demoHtml = fs.readFileSync(path.join(root, "demo/test.html"), "utf8");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "quickfill-test-"));
const userscriptPath = path.join(outputDir, "quickfill.user.js");

execFileSync("python", [path.join(root, "build_v3.py")], {
  cwd: root,
  env: {
    ...process.env,
    QUICKFILL_PROFILE: path.join(root, "profile.example.json"),
    QUICKFILL_OUT: userscriptPath
  },
  stdio: "inherit"
});

const userscript = fs.readFileSync(userscriptPath, "utf8");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out waiting for condition");
}

function createPage({ enabled }) {
  const dom = new JSDOM(demoHtml, {
    url: "https://jobs.example.com/apply",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const storage = new Map();
  const menuCommands = [];

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24 };
  };
  window.Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.GM_getValue = (key, fallback) => storage.has(key) ? storage.get(key) : fallback;
  window.GM_setValue = (key, value) => { storage.set(key, value); return true; };
  window.GM_deleteValue = (key) => { storage.delete(key); };
  window.GM_registerMenuCommand = (label, callback) => menuCommands.push({ label, callback });

  if (enabled) {
    window.localStorage.setItem("jlj_enabled_sites", JSON.stringify({ "jobs.example.com": true }));
  }
  window.eval(userscript);

  return { dom, window, storage, menuCommands };
}

function panel(window) {
  const host = window.document.querySelector("#jlj-panel-host");
  return host && host.shadowRoot ? { host, root: host.shadowRoot } : null;
}

test("sites stay disabled until the user opts in", async () => {
  const page = createPage({ enabled: false });
  await delay(50);

  assert.equal(panel(page.window), null);
  assert.equal(page.menuCommands.length, 1);
  assert.match(page.menuCommands[0].label, /启用 quickfill/);
  page.dom.window.close();
});

test("sample profile is blocked before a fill starts", async () => {
  const page = createPage({ enabled: true });
  const view = await waitFor(() => panel(page.window));

  assert.match(view.root.querySelector("#go").textContent, /先替换示例资料/);
  view.root.querySelector("#go").click();
  assert.equal(page.window.document.querySelector('[name="name"]').value, "");
  assert.match(view.root.querySelector("#st").textContent, /当前是示例资料/);
  page.dom.window.close();
});

test("basic editor creates a safe profile and fills without submitting", async () => {
  const page = createPage({ enabled: true });
  let view = await waitFor(() => panel(page.window));

  const setValue = (id, value) => {
    view.root.querySelector(`#${id}`).value = value;
  };
  setValue("pfName", "聆阳");
  setValue("pfPhone", "13800138000");
  setValue("pfEmail", "lingyang@example.com");
  setValue("pfSchool", "示例大学");
  setValue("pfMajor", "化学工程与工艺");
  setValue("pfGraduation", "2027-06");
  setValue("pfJob", "产品运营");
  setValue("pfCity", "杭州");
  setValue("pfIndustry", "消费品");
  setValue("pfFunction", "市场营销");
  view.root.querySelector("#saveBasic").click();

  view = await waitFor(() => {
    const current = panel(page.window);
    return current && current.root.querySelector("#go").textContent.includes("一键填充") ? current : null;
  });

  const saved = JSON.parse(page.storage.get("jlj_form_filler_profile_v3"));
  assert.equal(saved._meta["示例数据"], false);
  assert.equal(saved.personal.姓名, "聆阳");
  assert.equal(Object.hasOwn(saved.personal, "身份证号"), false);

  const submit = page.window.document.querySelector(".submit-bar button");
  let submitClicks = 0;
  submit.addEventListener("click", () => { submitClicks += 1; });
  view.root.querySelector("#go").click();

  await waitFor(() => view.root.querySelector("#st").textContent.includes("填充完成"));
  assert.equal(page.window.document.querySelector('[name="name"]').value, "聆阳");
  assert.equal(page.window.document.querySelector('[name="email"]').value, "lingyang@example.com");
  assert.equal(page.window.document.querySelector('[name="school"]').value, "示例大学");
  assert.equal(page.window.document.querySelector('[name="major"]').value, "化学工程与工艺");
  assert.equal(submitClicks, 0);
  page.dom.window.close();
});
