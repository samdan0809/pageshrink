/**
 * 测试用的浏览器可执行文件路径。
 *
 * 必须是 Chromium 或 Chrome for Testing —— 品牌版 Google Chrome 从 137 起
 * 出于反侧载（anti-sideload）考虑会直接忽略 --load-extension，
 * 扩展根本加载不进来，测试会静默地什么都测不到。
 */
const p = process.env.CHROME_PATH;

if (!p) {
  console.error([
    '',
    '找不到浏览器。请先设置 CHROME_PATH 指向 Chromium / Chrome for Testing 的可执行文件：',
    '',
    '  Windows  set CHROME_PATH=C:\\path\\to\\chrome.exe',
    '  macOS    export CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"',
    '  Linux    export CHROME_PATH=/usr/bin/chromium',
    '',
    '没有的话可以先下载一个：  npx @puppeteer/browsers install chrome@stable',
    '然后用其中 chrome-win64/chrome.exe 的完整路径。',
    '',
  ].join('\n'));
  process.exit(3);
}

module.exports = p;
