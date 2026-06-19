#!/usr/bin/env node
// 从 CHANGELOG.md 抽取指定版本的小节，作为 GitHub Release 的发布说明。
// 用法：node .github/scripts/changelog-section.js 9.4.0
const fs = require("fs");
const path = require("path");

const version = (process.argv[2] || "").replace(/^v/, "").trim();
const file = path.join(__dirname, "..", "..", "CHANGELOG.md");

let text = "";
try {
  text = fs.readFileSync(file, "utf8");
} catch {
  process.stdout.write("v" + version + "\n");
  process.exit(0);
}

// 匹配形如 "## [9.4.0] - 2026-06-18" 的标题，截到下一个 "## [" 之前。
const lines = text.split(/\r?\n/);
const headRe = /^##\s*\[?v?([0-9][0-9A-Za-z.\-]*)\]?/;
let start = -1;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(headRe);
  if (m && m[1] === version) { start = i; break; }
}
if (start === -1) {
  process.stdout.write("v" + version + "\n");
  process.exit(0);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (headRe.test(lines[i])) { end = i; break; }
}
const section = lines.slice(start, end).join("\n").trim();
process.stdout.write(section + "\n");
