// Drives a real conversation in the demo UI and saves docs/screenshot.png.
//   node scripts/screenshot.ts [url]   (default http://localhost:8787)
// Uses the locally installed Google Chrome through playwright-core.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:8787";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url);
await page.waitForSelector(".msg.agent");

async function send(text: string) {
  const before = await page.locator(".msg.agent:not(.typing)").count();
  await page.fill("#input", text);
  await page.click("#send");
  await page.waitForFunction((n) => document.querySelectorAll(".msg.agent:not(.typing)").length > n, before, { timeout: 120_000 });
}

await send("Hi, the zipper on my down jacket broke the first time I wore it. Order LP-1001, email maya.chen@example.com");
await page.evaluate(() => { document.querySelector(".accounts")?.removeAttribute("open"); });
await page.evaluate(() => document.querySelector(".ev.guardrail.require_approval")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(500);
await page.screenshot({ path: "docs/screenshot.png" });
await page.click('[data-tab="backend"]');
await page.screenshot({ path: "docs/screenshot-backend.png" });
await browser.close();
console.log("saved docs/screenshot.png and docs/screenshot-backend.png");
