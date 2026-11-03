import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const TMP = path.resolve(__dirname, ".tmp");
const PR = "/local/fixture/pull/1";

function claudeCalls(): { args: string[]; prompt: string; cwd: string }[] {
  const f = path.join(TMP, "home", "claude-calls.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Fail the test on any console error or uncaught exception. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    // 4xx responses are expected answers (bad link, no access); anything else is a bug.
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const line = (page: Page, side: "new" | "old", n: number) =>
  page.locator(`[data-line="${side}-${n}"]`).getByRole("button", { name: String(n), exact: true });

const fileRow = (page: Page, p: string) => page.locator(`button[title="${p}"]`);

const composer = (page: Page) => page.getByPlaceholder("Ask about the whole change…");

async function ask(page: Page, text: string) {
  if (!(await composer(page).isVisible())) await page.getByRole("button", { name: "Questions about the whole change" }).click();
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

test.describe.configure({ mode: "serial" });

test("home lists PRs waiting on review and rejects bad links", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/reviews");
  await expect(page.getByText("Waiting on your review")).toBeVisible();
  await expect(page.getByText("local/fixture#1")).toBeVisible();
  await expect(page.getByText(/Suspiciously quiet/)).toBeVisible();

  await page.getByPlaceholder(/github.com/).fill("not a url");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText(/doesn't look like a GitHub URL/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("opening a PR lists every kind of change", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/reviews");
  await page.getByPlaceholder(/github.com/).fill("https://github.com/local/fixture/pull/1");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  // Links open as a tab in the current space.
  await expect(page).toHaveURL(/\/space\/[\w-]+\?pr=local%2Ffixture%2Fpull%2F1/);
  await expect(page.getByRole("tab", { name: "fixture #1" })).toBeVisible();
  await expect(page.getByText("Guard add against NaN").first()).toBeVisible();
  await expect(page.getByText("#1 · octo · feature → main", { exact: false })).toBeVisible();
  await expect(page.locator("span[data-pr-state=open]")).toHaveText("Open");

  // Changed files show as a folder tree: docs/ and src/ folders, then notes.txt at the root.
  const tree = page.getByRole("tree", { name: "Changed files" });
  await expect(tree.getByRole("treeitem")).toHaveText([/^docs/, /handbook\.md/, /^src/, /math\.ts/, /util\.py/, /notes\.txt/]);
  await expect(page.getByRole("button", { name: "Changed 4" })).toBeVisible();
  // Folders fold.
  await tree.getByRole("treeitem", { name: /^src/ }).click();
  await expect(fileRow(page, "src/math.ts")).toHaveCount(0);
  await tree.getByRole("treeitem", { name: /^src/ }).click();
  await expect(fileRow(page, "src/math.ts")).toBeVisible();

  // The whole repo starts folded except the way to changes; single-child folders merge.
  await page.getByRole("button", { name: "All files" }).click();
  const all = page.getByRole("tree", { name: "All files" });
  const deep = all.getByRole("treeitem", { name: "lib/bridge/clients" });
  await expect(deep).toHaveAttribute("aria-expanded", "false");
  await expect(all.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-expanded", "true");
  await deep.click();
  await expect(fileRow(page, "lib/bridge/clients/client.ex")).toBeVisible();
  await page.getByRole("button", { name: /^Changed/ }).click();

  // Renamed file shows where it came from.
  await fileRow(page, "docs/handbook.md").click();
  await expect(page.getByText("docs/guide.md →")).toBeVisible();
  await expect(page.getByText("renamed", { exact: true })).toBeVisible();

  // Deleted file shows only removals and no full-file toggle.
  await fileRow(page, "notes.txt").click();
  await expect(page.getByText("deleted", { exact: true })).toBeVisible();
  await expect(page.locator('[data-line="old-1"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Full file" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("diff and full-file views highlight the change", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/math.ts`);
  await expect(page.locator('[data-line="new-2"]')).toContainText("Guard against NaN");
  await expect(page.locator('[data-line="new-2"]')).toHaveClass(/bg-emerald/);
  // Syntax highlighting produced colored tokens.
  await expect(page.locator('[data-line="new-1"] .tok').first()).toBeVisible();

  await page.getByRole("button", { name: "Full file" }).click();
  await expect(page.locator('[data-line="new-7"]')).toContainText("ZERO");
  await expect(page.locator('[data-line="new-3"]')).toHaveClass(/bg-emerald/);
  await expect(page.locator('[data-line="new-1"]')).not.toHaveClass(/bg-emerald/);
  expect(errors).toEqual([]);
});

test("picking lines opens a composer right there, and the answer lands in a thread under them", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/math.ts`);
  await line(page, "new", 2).click();
  await line(page, "new", 3).click({ modifiers: ["Shift"] });
  const draft = page.getByPlaceholder("Ask about these lines…");
  await expect(draft).toBeFocused();
  await expect(page.getByText("Ask Claude about lines 2–3")).toBeVisible();
  await expect(page.locator('[data-line="new-2"]')).toHaveClass(/bg-amber/);

  await draft.fill("Why throw instead of returning NaN?");
  await draft.press("Enter");
  // The thread sits right under the last line it's about.
  const thread = page.locator('[data-line="new-3"] + div [data-thread]');
  await expect(thread).toContainText("Why throw instead of returning NaN?");
  await expect(thread.getByText("Looks fine.")).toBeVisible();
  await expect(thread.getByText("1 tool call")).toBeVisible();
  await expect(thread.getByText("$0.004")).toBeVisible();
  await expect(draft).toHaveCount(0);
  await expect(page.locator('[data-line="new-2"]')).toHaveClass(/color-sky-500/);
  // The diff gets the room; the whole-change panel stays shut until asked for, and links to the thread.
  await expect(composer(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Questions about the whole change" }).click();
  await expect(page.getByRole("button", { name: /src\/math\.ts:2-3/ })).toBeVisible();

  const call = claudeCalls().find((c) => c.cwd.includes("local_fixture_pull_1"))!;
  expect(call.prompt).toContain("About src/math.ts lines 2-3");
  expect(call.prompt).toContain("// Guard against NaN");
  expect(call.args).toContain("--allowedTools");
  expect(call.args[call.args.indexOf("--allowedTools") + 1].split(",")).toEqual(expect.arrayContaining(["Edit", "Write"]));
  expect(call.args).not.toContain("--resume");
  // Claude runs locked down: no settings files, no MCP servers, no prompts.
  expect(call.args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config", "--permission-mode", "dontAsk"]));
  expect(call.cwd).toContain(path.join("worktrees", "local_fixture_pull_1"));
  expect(errors).toEqual([]);
});

test("replies stay in their thread, resume the same session, and survive a reload", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/math.ts`);
  const thread = page.locator("[data-thread]").filter({ hasText: "Why throw instead" });
  await thread.getByPlaceholder("Reply…").fill("And for Infinity?");
  await thread.getByPlaceholder("Reply…").press("Enter");
  await expect(thread.getByText("Following up.")).toBeVisible();
  const last = claudeCalls().at(-1)!;
  expect(last.args).toEqual(expect.arrayContaining(["--resume", "sess-fixture"]));
  // A reply is about the thread's lines too.
  expect(last.prompt).toContain("About src/math.ts lines 2-3");
  // The CLI reports a running total; each answer shows only its own share.
  await expect(thread.getByText(/^\$\d/)).toHaveText(["$0.004", "$0.004"]);

  await page.reload();
  await expect(thread.getByText("And for Infinity?")).toBeVisible();
  await expect(thread.getByText("Following up.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("one file holds several threads, started from +, a drag, or selected code", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/math.ts`);
  await expect(page.locator("[data-thread]")).toHaveCount(1);

  // The + on a hovered line.
  await page.locator('[data-line="new-5"]').hover();
  await page.getByRole("button", { name: "Ask about line 5", exact: true }).click();
  await page.getByPlaceholder("Ask about this line…").fill("Is the closing brace fine?");
  await page.getByPlaceholder("Ask about this line…").press("Enter");
  const second = page.locator('[data-line="new-5"] + div [data-thread]');
  await expect(second.getByText("Looks fine.")).toBeVisible();
  await expect(page.locator("[data-thread]")).toHaveCount(2);

  // Dragging down the line numbers picks a range; Escape drops it.
  const from = await line(page, "new", 1).boundingBox();
  const to = await line(page, "new", 2).boundingBox();
  await page.mouse.move(from!.x + 5, from!.y + 5);
  await page.mouse.down();
  await page.mouse.move(to!.x + 5, to!.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText("Ask Claude about lines 1–2")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Ask about these lines…")).toHaveCount(0);

  // Selecting code text offers to ask about the lines it covers.
  const code1 = await page.locator('[data-line="new-1"] .tok').first().boundingBox();
  const code2 = await page.locator('[data-line="new-2"] .tok').last().boundingBox();
  await page.mouse.move(code1!.x + 2, code1!.y + 5);
  await page.mouse.down();
  await page.mouse.move(code2!.x + code2!.width - 1, code2!.y + 5, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Ask about lines 1–2" }).click();
  await expect(page.getByText("Ask Claude about lines 1–2")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Threads fold down to one line.
  const head = second.getByRole("button", { name: "Thread on Line 5" });
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(second.getByPlaceholder("Reply…")).toHaveCount(0);
  await expect(second).toContainText("Is the closing brace fine?");
  await head.click();
  await expect(second.getByPlaceholder("Reply…")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a question asked while another is answering waits its turn", async ({ page }) => {
  const errors = watchConsole(page);
  let localRequested = false;
  let releaseLocal!: () => void;
  const localReady = new Promise<void>((resolve) => { releaseLocal = resolve; });
  await page.route("**/api/local-changes?*", async (route) => {
    const response = await route.fetch();
    localRequested = true;
    await localReady;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.goto(`${PR}?file=src/math.ts`);
  const first = page.locator("[data-thread]").filter({ hasText: "Why throw instead" });
  const second = page.locator("[data-thread]").filter({ hasText: "closing brace" });
  await first.getByPlaceholder("Reply…").fill("SLOW one");
  await expect.poll(() => localRequested).toBe(true);
  releaseLocal();
  await expect(first.getByPlaceholder("Reply…")).toHaveValue("SLOW one");
  await first.getByPlaceholder("Reply…").press("Enter");
  await expect(first.getByText("Answering")).toBeVisible();
  await second.getByPlaceholder("Reply…").fill("Queued one");
  await second.getByPlaceholder("Reply…").press("Enter");
  await expect(second.getByText("Waiting for the answer in another thread to finish…")).toBeVisible();

  await first.getByRole("button", { name: "Stop" }).click();
  await expect(first.getByText("Stopped.")).toBeVisible();
  await expect(second.getByText("Queued one")).toBeVisible();
  await expect(second.getByText("Following up.").last()).toBeVisible();
  await expect(second.getByText("Waiting for the answer")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the side panel takes questions about the whole change and reports failures", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(PR);
  await ask(page, "FAIL please");
  await expect(page.getByText("API Error: overloaded")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await ask(page, "Overall thoughts?");
  await expect(page.getByText("Following up.").last()).toBeVisible();
  expect(errors).toEqual([]);
});

test("thread links and citations jump to the code", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/util.py`);
  await expect(page.locator('[data-line="new-1"]')).toContainText("def greet");
  await page.getByRole("button", { name: "Questions about the whole change" }).click();
  await page.getByRole("button", { name: /src\/math\.ts:2-3/ }).click();
  await expect(page).toHaveURL(/file=src%2Fmath\.ts/);
  const thread = page.locator("[data-thread]").filter({ hasText: "Why throw instead" });
  await expect(thread).toBeInViewport();

  await fileRow(page, "src/util.py").click();
  await page.getByRole("button", { name: "src/math.ts:3" }).first().click();
  await expect(page).toHaveURL(/file=src%2Fmath\.ts/);
  await expect(page.locator('[data-line="new-3"]')).toBeInViewport();
  expect(errors).toEqual([]);
});

test("deleting a reply or a whole thread", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/math.ts`);
  const first = page.locator("[data-thread]").filter({ hasText: "Why throw instead" });
  const q = first.locator("[data-msg]").filter({ hasText: "SLOW one" });
  await q.hover();
  await q.getByRole("button", { name: "Delete question and answer" }).click();
  await expect(page.getByText("SLOW one")).toHaveCount(0);
  await expect(page.getByText("Stopped.")).toHaveCount(0);
  await expect(first.getByText("And for Infinity?")).toBeVisible();

  const second = page.locator("[data-thread]").filter({ hasText: "closing brace" });
  await second.getByRole("button", { name: "Delete thread" }).click();
  await expect(page.locator("[data-thread]")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-thread]")).toHaveCount(1);
  await expect(page.getByText("Queued one")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("recent reviews show on the home page", async ({ page }) => {
  await page.goto("/reviews");
  const recent = page.getByRole("button", { name: /local\/fixture\/pull\/1/ });
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page).toHaveURL(/\/space\//);
  await expect(page.getByRole("tab", { name: "fixture #1" })).toHaveAttribute("aria-selected", "true");
});

test("branch, commit and compare links open", async ({ page, request }) => {
  const errors = watchConsole(page);
  await page.goto("/local/fixture/tree/main");
  await expect(page.getByRole("button", { name: "Changed 0" })).toHaveCount(0);
  await expect(page.locator('[data-line="new-1"]')).toContainText("# Fixture");
  await page.getByPlaceholder("Filter files").fill("math");
  await expect(fileRow(page, "src/math.ts")).toBeVisible();

  const sha = fs.readFileSync(path.join(TMP, "feature.sha"), "utf8").trim();
  const commit = await (await request.post("/api/resolve", { data: { url: `https://github.com/local/fixture/commit/${sha.slice(0, 8)}` } })).json();
  expect(commit.id).toBe(`local/fixture/commit/${sha}`);
  await page.goto(`/${commit.id}`);
  await expect(page.getByRole("button", { name: "Changed 4" })).toBeVisible();

  await page.goto("/local/fixture/compare/v1...feature");
  await expect(page.getByRole("button", { name: "Changed 4" })).toBeVisible();

  const blob = await (await request.post("/api/resolve", { data: { url: "https://github.com/local/fixture/blob/main/src/math.ts" } })).json();
  expect(blob).toEqual({ id: "local/fixture/tree/main", file: "src/math.ts" });
  expect(errors).toEqual([]);
});

test("bad requests get clear 4xx answers", async ({ request }) => {
  const foreign = await request.post("/api/resolve", { data: { url: "https://example.com/x" } });
  expect(foreign.status()).toBe(400);
  const missingFile = await request.get(`/api/file?id=local/fixture/pull/1&path=nope.txt&mode=full`);
  expect(missingFile.status()).toBe(404);
  expect((await missingFile.json()).error).toContain("nope.txt");
});

test("a repo you can't access explains why", async ({ page }) => {
  await page.goto("/local/missing/pull/3");
  await expect(page.getByText(/Can't access local\/missing/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test.describe("theme", () => {
  test("defaults to light even when the system is dark", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto(`${PR}?file=src/math.ts`);
    await expect(page.locator("html")).toHaveClass(/light/);
    await expect(page.locator('[data-line="new-2"]')).toBeVisible();
    await page.screenshot({ path: path.join(TMP, "default-light.png") });
    await ctx.close();
  });

  test("the toggle switches themes and remembers the choice", async ({ page }) => {
    const errors = watchConsole(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/reviews");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark/);
    const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(html).toHaveClass(/dark/);
    const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bgDark).not.toBe(bgLight);

    await page.goto(`${PR}?file=src/math.ts`);
    await expect(html).toHaveClass(/dark/);
    // Syntax colors switch to the dark palette.
    const tok = page.locator('[data-line="new-1"] .tok').first();
    const darkColor = await tok.evaluate((el) => getComputedStyle(el).color);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(html).not.toHaveClass(/dark/);
    const lightColor = await tok.evaluate((el) => getComputedStyle(el).color);
    expect(darkColor).not.toBe(lightColor);
    expect(errors).toEqual([]);
  });
});

test("reviewers' GitHub comments show inline, and the agent can be asked about them", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${PR}?file=src/util.py`);
  const gh = page.locator('[data-line="new-2"] + div [data-gh-thread]');
  await expect(gh).toContainText("hubot");
  await expect(gh.locator("strong", { hasText: "name" })).toBeVisible();
  await expect(gh).toContainText("Good point, will look.");
  // The lines it's about are marked.
  await expect(page.locator('[data-line="new-1"]')).toHaveClass(/color-sky-500/);

  await gh.getByRole("button", { name: "Ask Claude about this" }).click();
  const box = page.getByPlaceholder("What do you want to know about this comment?");
  await expect(box).toBeFocused();
  await box.fill("Is hubot right?");
  await box.press("Enter");
  const thread = page.locator("[data-thread]").filter({ hasText: "Is hubot right?" });
  await expect(thread.getByText("Looks fine.")).toBeVisible();
  await expect(thread).toContainText("@hubot");
  const call = claudeCalls().at(-1)!;
  expect(call.prompt).toContain("@hubot wrote:\n> Should this handle an empty **name**?");
  expect(call.prompt).toContain("@octo wrote:\n> Good point, will look.");
  expect(call.prompt).toContain("About src/util.py lines 1-2");

  // Comments on code that has changed since go at the end of the file.
  await fileRow(page, "src/math.ts").click();
  await expect(page.getByText("GitHub comments on code that has changed since")).toBeVisible();
  const old = page.locator("[data-gh-thread]").filter({ hasText: "Old note on the signature." });
  await expect(old).toContainText("outdated");
  // Asking about an outdated one opens the box in its card, and doesn't quote today's code as if it were what they meant.
  await old.getByRole("button", { name: "Ask Claude about this" }).click();
  const oldBox = old.getByPlaceholder("What do you want to know about this comment?");
  await expect(oldBox).toBeFocused();
  await oldBox.fill("What did hubot mean?");
  await oldBox.press("Enter");
  await expect(page.locator("[data-thread]").filter({ hasText: "What did hubot mean?" }).getByText("Looks fine.")).toBeVisible();
  const oldCall = claudeCalls().at(-1)!;
  expect(oldCall.prompt).toContain("@hubot wrote:\n> Old note on the signature.");
  expect(oldCall.prompt).toContain("About src/math.ts line 1 in an earlier version of the change");
  expect(oldCall.prompt).not.toContain("export function add");

  // Comments on the PR as a whole are in the side panel, and the box opens right under the one you ask about.
  await page.getByRole("button", { name: "Questions about the whole change" }).click();
  await page.getByText("1 comment on GitHub").click();
  await expect(page.getByText("Ready for review!")).toBeVisible();
  await page.getByRole("button", { name: "Ask about this" }).click();
  const genBox = page.getByPlaceholder("What do you want to know about this comment?");
  await expect(genBox).toBeFocused();
  await genBox.fill("Anything left to do?");
  await genBox.press("Enter");
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: /^Anything left to do\?$/ })).toBeVisible();
  await expect.poll(() => claudeCalls().at(-1)!.prompt).toContain("> Ready for review!");
  expect(errors).toEqual([]);
});

test("answers can draw diagrams", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(PR);
  await ask(page, "DIAGRAM please");
  const diagram = page.locator("[data-diagram] svg");
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toContainText("add called");
  await expect(diagram).toContainText("return sum");
  // It stays put across the review's 3s poll instead of being redrawn.
  await diagram.evaluate((el) => el.setAttribute("data-seen", ""));
  await page.waitForTimeout(4_000);
  await expect(page.locator("[data-diagram] svg[data-seen]")).toHaveCount(1);
  // The agent is told it can draw.
  expect(claudeCalls().at(-1)!.args.join(" ")).toContain("```mermaid");
  expect(errors).toEqual([]);
});

test("PR state shows the way GitHub shows it, and follows a merge", async ({ page }) => {
  const errors = watchConsole(page);
  const stateFile = path.join(TMP, "home", "pr-state");
  // Waiting on review: the open icon leads the row.
  await page.goto("/reviews");
  const review = page.locator("section", { has: page.getByRole("heading", { name: "Waiting on your review" }) });
  await expect(review.locator("div.group").first().getByRole("img", { name: "Open" })).toBeVisible();

  fs.writeFileSync(stateFile, "MERGED");
  try {
    await page.goto(PR);
    await page.getByRole("button", { name: "Fetch latest" }).click();
    const pill = page.locator("span[data-pr-state=merged]");
    await expect(pill).toHaveText("Merged");
    await expect(pill).toHaveCSS("background-color", "rgb(130, 80, 223)");
    // Recent remembers it was merged.
    await page.goto("/reviews");
    const recent = page.locator("section", { has: page.getByRole("heading", { name: /Recent/ }) });
    await expect(recent.locator("div.group", { hasText: "local/fixture/pull/1" }).getByRole("img", { name: "Merged" })).toBeVisible();
  } finally {
    fs.rmSync(stateFile, { force: true });
    await page.request.get(`/api/target?id=local/fixture/pull/1&refresh=1`);
  }
  expect(errors).toEqual([]);
});
