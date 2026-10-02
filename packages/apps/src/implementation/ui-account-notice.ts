/** Host-rendered account notices; no authored app code or provider responses enter them. */
import type { UiAccountNotice, UiAccountProblem } from "../contracts/ui.ts";

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Missing, removed, incompatible, or rejected accounts stop the app; other failed checks are advisory. */
export const accountProblemBlocks = (problem: UiAccountProblem) =>
  problem.reason === "missing" ||
  problem.reason === "removed" ||
  problem.reason === "incompatible" ||
  problem.reason === "credentials_rejected";

export const accountProblemText = (problem: UiAccountProblem) => {
  switch (problem.reason) {
    case "missing":
      return `No ${problem.provider} account chosen`;
    case "removed":
      return `${problem.provider} account was removed or is no longer shared`;
    case "incompatible":
      return `Chosen account can't be used as the ${problem.provider} account`;
    case "credentials_rejected":
      return `${problem.account} (${problem.provider}): sign-in rejected at last check`;
    case "forbidden":
      return `${problem.account} (${problem.provider}): missing permission at last check`;
    case "upstream_unavailable":
      return `${problem.account} (${problem.provider}): service unavailable at last check`;
    case "check_failed":
      return `${problem.account} (${problem.provider}): last check failed`;
  }
};

/** Full page shown instead of the app while an account problem stops it from working. */
export const accountBlockedPage = (notice: UiAccountNotice) => {
  const title = `${escape(notice.app)} can't open`;
  const items = notice.problems
    .map(
      (problem) =>
        `<li class="${accountProblemBlocks(problem) ? "bad" : "warn"}">${escape(accountProblemText(problem))}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;color:#18181b;background:#fafafa}
@media (prefers-color-scheme:dark){:root{color:#f4f4f5;background:#18181b}main{background:#27272a!important;border-color:#3f3f46!important}a{color:inherit!important;border-color:#52525b!important}a.primary{background:#f4f4f5!important;color:#18181b!important}p{color:#a1a1aa!important}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:480px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px}
h1{margin:0 0 8px;font-size:20px}p{margin:0 0 16px;color:#52525b;line-height:1.5}
ul{margin:0 0 24px;padding:0;list-style:none;display:grid;gap:8px}
li{display:flex;gap:10px;align-items:baseline;line-height:1.4}li::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;transform:translateY(-1px)}
li.bad::before{background:#dc2626}li.warn::before{background:#f59e0b}
.actions{display:flex;flex-wrap:wrap;gap:8px}
a{padding:8px 14px;border-radius:8px;border:1px solid #d4d4d8;color:#18181b;text-decoration:none;font-weight:500}
a.primary{background:#18181b;border-color:#18181b;color:#fff}
</style></head><body><main><h1>${title}</h1><p>This profile's accounts need attention before the app can work.</p><ul>${items}</ul><div class="actions"><a class="primary" href="${escape(notice.fix)}">Fix accounts</a><a href="${escape(notice.choose)}">Open with another profile</a></div></main></body></html>`;
};

/** This bootstrap must not depend on authored modules or their framework. */
const installAccountNotice = () => {
  const data = document.getElementById("executor-account-notice")?.textContent;
  if (!data) return;
  const notice: unknown = JSON.parse(data);
  if (typeof notice !== "object" || notice === null || !("items" in notice) || !("fix" in notice))
    return;
  const items = notice.items;
  const fix = notice.fix;
  if (!Array.isArray(items) || typeof fix !== "string") return;
  const show = () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `aside{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;box-sizing:border-box;padding:14px 16px;border-radius:10px;border:1px solid #fcd34d;background:#fffbeb;color:#451a03;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgb(0 0 0/.12)}strong{display:block;margin-bottom:4px}ul{margin:0 0 10px;padding-left:18px}div{display:flex;gap:12px;align-items:center}a{color:inherit;font-weight:600}button{margin-left:auto;font:inherit;background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer}`;
    const card = document.createElement("aside");
    card.setAttribute("role", "status");
    card.setAttribute("aria-label", "Account warning");
    const title = document.createElement("strong");
    title.textContent = "Some things might not work";
    const list = document.createElement("ul");
    for (const item of items) {
      const entry = document.createElement("li");
      entry.textContent = String(item);
      list.append(entry);
    }
    const actions = document.createElement("div");
    const link = document.createElement("a");
    link.href = fix;
    link.target = "_top";
    link.textContent = "Review accounts";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => host.remove());
    actions.append(link, close);
    card.append(title, list, actions);
    root.append(style, card);
    document.documentElement.append(host);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show, { once: true });
  } else {
    show();
  }
};

/** Inline card for advisory problems; the app still loads underneath. */
export const accountNoticeBootstrap = (notice: UiAccountNotice) =>
  `<script type="application/json" id="executor-account-notice">${JSON.stringify({
    items: notice.problems.map(accountProblemText),
    fix: notice.fix,
  }).replaceAll("<", "\\u003c")}</script><script>(${installAccountNotice.toString()})()</script>`;
