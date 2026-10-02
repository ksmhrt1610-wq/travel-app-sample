/**
 * デモシナリオのE2E確認（開発サーバーを起動した状態で実行）
 *   npm run dev            # 別ターミナルで
 *   npm run demo:e2e       # BASE_URL=http://localhost:3000
 *
 * シナリオ:
 *   「友人・普通の予算・グルメとカフェ・ゆったり・小雨OK」で日帰り旅程を作る
 *   → 当日モードで現在時刻を13:00にする → 雨を発生させる → すべての屋外予定を切り替える
 * あわせて 遅延 / 臨時休業 / 共有リンク / 並べ替え も確認する。
 * ブラウザは playwright-core + 既存の Chromium を使う（SCREENSHOT_DIR を指定するとスクリーンショットを保存）。
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
      const p = path.join(root, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  return undefined; // playwright 既定の場所
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const step = (t) => console.log(`\n■ ${t}`);

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ja-JP" });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
const q = (id) => `[data-testid="${id}"]`;
/** デモ操作パネルを（閉じていれば）開く。操作ボタンを押すとパネルは自動で閉じる */
const openSim = async () => {
  if (!(await page.locator(q("sim-body")).isVisible().catch(() => false))) await page.click(q("sim-toggle"));
};

/** 画面上のスポットブロックを読み取る */
const readBlocks = () =>
  page.$$eval('[data-testid="block-spot"]', (els) =>
    els.map((e) => ({
      id: e.dataset.blockId,
      name: e.querySelector("h3")?.textContent ?? "",
      setting: e.dataset.setting,
      start: Number(e.dataset.start),
      end: Number(e.dataset.end),
      switched: e.dataset.switched === "true",
    })),
  );

try {
  /* ---------- 1. 入力 → 旅程生成 ---------- */
  step("入力画面で条件を入れて日帰り旅程を作る");
  await page.goto(BASE);
  await page.waitForSelector(q("generate"));
  check("サンプルデータの注意書きが表示されている", (await page.textContent(q("sample-notice")))?.includes("サンプルデータ"));
  await page.click(q("duration-day"));
  await page.click(q("companions-friends"));
  await page.click(q("budget-normal"));
  for (const c of ["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"]) {
    const on = (await page.getAttribute(q(`interest-${c}`), "aria-pressed")) === "true";
    if (on !== ["gourmet", "cafe"].includes(c)) await page.click(q(`interest-${c}`));
  }
  await page.click(q("pace-relaxed"));
  await page.click(q("rain-light-rain-ok"));
  await shot("1-form");
  await page.click(q("generate"));
  await page.waitForURL("**/itinerary");
  await page.waitForSelector(q("timeline"));

  /* ---------- 2. 旅程画面 ---------- */
  step("旅程画面");
  const blocks = await readBlocks();
  check(`スポットブロックが並ぶ（${blocks.length}件）`, blocks.length >= 4);
  const bufferCount = await page.locator(q("block-buffer")).count();
  check(`余白ブロックがある（${bufferCount}件）`, bufferCount >= 1);
  const outdoor = blocks.filter((b) => b.setting !== "indoor");
  check(`屋外・半屋外の予定がある（${outdoor.length}件）`, outdoor.length >= 1);
  const noPlanB = await page.locator(q("no-planb-warning")).count();
  const planBTexts = await page.locator("text=Plan B：").count();
  check("屋外・半屋外の予定すべてに Plan B があるか警告が出ている", planBTexts + noPlanB >= outdoor.length, `planB=${planBTexts} warn=${noPlanB} outdoor=${outdoor.length}`);
  await shot("2-itinerary");

  step("ブロックをタップして詳細と Plan B を見る");
  const outdoorBlock = page.locator('[data-testid="block-spot"][data-setting="outdoor"]').first();
  await outdoorBlock.getByRole("button").first().click();
  await page.waitForSelector(q("detail-sheet"));
  check("詳細に Google Maps ボタンがある", (await page.getAttribute(q("open-maps"), "href"))?.startsWith("https://www.google.com/maps/search/"));
  check("詳細に Plan B が表示される", await page.locator(q("planb-section")).locator("text=屋内").first().isVisible());
  await shot("2b-detail");
  await page.keyboard.press("Escape");

  /* ---------- 3. 当日モード ---------- */
  step("当日モード: 現在時刻を13:00にする");
  await page.click(q("go-today"));
  await page.waitForURL("**/today");
  await page.waitForSelector(q("next-card"));
  check("「次にやること」カードが出ている", await page.locator(q("next-card")).isVisible());
  check("出発までの残り時間が出ている", /出発まで|到着まで|今すぐ/.test((await page.textContent(q("next-card"))) ?? ""));
  await openSim();
  await page.click(q("sim-now-13:00"));
  check("現在時刻が 13:00", (await page.textContent(q("sim-now-label")))?.includes("13:00"));
  // スライダー操作でも変えられる
  await page.locator(q("sim-now-slider")).evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "790");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check("スライダーで現在時刻を動かせる（13:10）", (await page.textContent(q("sim-now-label")))?.includes("13:10"));
  await page.click(q("sim-now-13:00"));

  const before = await readBlocks();
  const outdoorLeft = before.filter((b) => b.setting === "outdoor" && b.end > 13 * 60);
  check(`13時以降に屋外の予定が残っている（${outdoorLeft.map((b) => b.name).join("、")}）`, outdoorLeft.length >= 1);
  check("雨の前は通知バナーが出ていない", (await page.locator(q("rain-banner")).count()) === 0);

  step("雨が降り出す");
  check("降水確率の初期値は80%", (await page.textContent(q("sim-rain-prob-label")))?.includes("80%"));
  await page.click(q("sim-rain-button"));
  await page.waitForSelector(q("rain-banner"));
  check("「Plan Bに切り替えますか？」の通知が出る", (await page.textContent(q("rain-banner")))?.includes("Plan Bに切り替えますか"));
  const affected = await page.locator(`${q("rain-affected")} li`).count();
  check(`影響する屋外予定が列挙される（${affected}件）`, affected === outdoorLeft.length, `expected ${outdoorLeft.length}`);
  check("「1つだけ切り替える」「残りすべて切り替える」の2つが選べる", (await page.locator(q("rain-switch-one")).isVisible()) && (await page.locator(q("rain-switch-all")).isVisible()));
  await shot("3-rain-banner");

  step("今日の残りの屋外予定をすべて切り替える");
  await page.click(q("rain-switch-all"));
  await page.waitForSelector(q("diff-panel"));
  check("通知バナーが消える", (await page.locator(q("rain-banner")).count()) === 0);
  const after = await readBlocks();
  const outdoorAfter = after.filter((b) => b.setting === "outdoor" && b.end > 13 * 60);
  check("13時以降の屋外予定がなくなった", outdoorAfter.length === 0, outdoorAfter.map((b) => b.name).join("、"));
  const switched = after.filter((b) => b.switched);
  check(`切り替わったブロックは屋内（${switched.map((b) => b.name).join("、")}）`, switched.length === outdoorLeft.length && switched.every((b) => b.setting === "indoor"));
  check("13時より前の予定は変わっていない", before.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.name === b.name));
  check("差分表示に切替前後が出る", (await page.locator(q("diff-replaced")).count()) === outdoorLeft.length);
  check("時系列に矛盾がない（重なりなし）", after.every((b, i) => i === 0 || b.start >= after[i - 1].end));
  await shot("3-after-switch");

  step("遅延: 電車が30分遅延");
  await openSim();
  await page.selectOption(q("sim-delay-select"), "30");
  await page.click(q("sim-delay-button"));
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-title"]')?.textContent?.includes("遅延"));
  check("差分表示が「電車が30分遅延」に更新される", (await page.textContent(q("diff-title")))?.includes("電車が30分遅延"));
  const delayed = await readBlocks();
  const shifted = delayed.filter((b) => { const o = after.find((a) => a.id === b.id); return o && b.start > o.start; });
  const absorbed = (await page.locator(q("diff-buffer")).count()) > 0;
  check(`後ろの予定が再計算された（時刻変更 ${shifted.length}件${absorbed ? "／余白が吸収" : ""}）`, shifted.length > 0 || absorbed);
  check("開始済みの予定は動かない", delayed.filter((b) => b.start <= 13 * 60).every((b) => after.find((a) => a.id === b.id)?.start === b.start));
  await shot("3-delay");

  step("臨時休業: 次のスポットが臨時休業");
  await openSim();
  await page.click(q("sim-close-button"));
  await page.waitForSelector(q("closure-banner"));
  check("臨時休業の通知と代わりの候補が出る", (await page.locator(q("closure-replace")).count()) === 1);
  await page.click(q("closure-replace"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="closure-banner"]'));
  check("代わりの予定に切り替わり、通知が消える", true);

  step("デモをリセット");
  await openSim();
  await page.click(q("sim-reset"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diff-panel"]').length === 0);
  check("リセットで変更履歴が消え、元の旅程に戻る", (await readBlocks()).filter((b) => b.switched).length === 0);

  /* ---------- 4. 共有 ---------- */
  step("共有リンク");
  await page.click(q("today-share"));
  await page.waitForSelector(q("share-url"));
  const url = await page.inputValue(q("share-url"));
  check("共有URLは /share?s=... の形", /\/share\?s=[A-Za-z0-9_-]+$/.test(url), url.slice(0, 80));
  const shared = await context.newPage();
  await shared.goto(url);
  await shared.waitForSelector('[data-testid="share-banner"]');
  const sharedRows = await shared.locator('[data-testid="timeline-row"]').count();
  const myRows = await page.locator('[data-testid="timeline-row"]').count();
  check(`共有リンクを開くと同じ旅程が見られる（${sharedRows}行）`, sharedRows > 0 && sharedRows >= myRows - 1);
  const sharedNames = await shared.$$eval('[data-testid="block-spot"] h3', (els) => els.map((e) => e.textContent));
  const myNames = (await readBlocks()).map((b) => b.name);
  check("スポットの並びが一致する", JSON.stringify(sharedNames) === JSON.stringify(myNames));
  check("共有ページは閲覧専用（ドラッグハンドルなし）", (await shared.locator(q("drag-handle")).count()) === 0);
  await shared.screenshot({ path: SHOTS ? path.join(SHOTS, "4-shared.png") : undefined });
  const broken = await context.newPage();
  await broken.goto(`${BASE}/share?s=broken`);
  await broken.waitForSelector(q("share-error"));
  check("壊れたリンクはエラー表示（クラッシュしない）", true);

  /* ---------- 5. 並べ替え ---------- */
  step("旅程画面で並べ替え");
  await page.goto(`${BASE}/itinerary`);
  await page.waitForSelector(q("timeline"));
  const orderBefore = (await readBlocks()).map((b) => b.name);
  await page.locator(q("block-spot")).first().getByRole("button").first().click();
  await page.click(q("move-down"));
  await page.waitForFunction((first) => document.querySelector('[data-testid="block-spot"] h3')?.textContent !== first, orderBefore[0]);
  const orderAfter = (await readBlocks()).map((b) => b.name);
  check("↓ボタンで順番が入れ替わる", orderAfter[0] !== orderBefore[0]);
  await page.keyboard.press("Escape");
  const handle = page.locator(q("drag-handle")).nth(1);
  const box = await handle.boundingBox();
  const targetBox = await page.locator(q("drag-handle")).nth(3).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 4 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2 + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const orderDrag = (await readBlocks()).map((b) => b.name);
  check("ドラッグで並べ替えられる", JSON.stringify(orderDrag) !== JSON.stringify(orderAfter));
  const starts = (await readBlocks()).map((b) => b.start);
  check("並べ替え後も時刻は昇順に計算し直されている", starts.every((s, i) => i === 0 || s >= starts[i - 1]));
  await shot("5-reordered");
} catch (e) {
  failures++;
  console.error("\n✗ シナリオ中にエラー:", e.message);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => {});
}

check("ブラウザのコンソールエラーがない", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures ? `\n❌ ${failures} 件の確認に失敗しました` : "\n✅ デモシナリオはすべて通りました");
process.exit(failures ? 1 : 0);
