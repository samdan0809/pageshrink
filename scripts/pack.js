#!/usr/bin/env node
/**
 * 打包 Chrome Web Store 提交用的 zip。
 *
 * 关键：manifest.json 必须在 zip 的根目录。
 * 把整个文件夹压缩进去（pageshrink/manifest.json）是「加载已解压的扩展程序」
 * 的分享格式，商店上传会直接报错。
 *
 *   node scripts/pack.js
 *   -> dist/pageshrink-<version>.zip
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'tests', 'docs', 'scripts'].includes(name)) continue;
      out.push(...walk(full, rel));
    } else {
      if (SKIP.has(name)) continue;
      if (name.startsWith('.')) continue;                       // .gitignore 之类不进包
      if (/\.(zip|crx|pem|log|map|md)$/i.test(name)) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

/** 极简 zip writer：deflate 压缩 + CRC32，只用 Node 内置模块，不引第三方依赖 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = walk(ROOT, '');
  if (!files.some((f) => f.rel === 'manifest.json')) {
    console.error('manifest.json 不在仓库根目录，中止。');
    process.exit(1);
  }

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(f.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 个别文件（如已压缩的 png）deflate 后反而更大，这种退回 store
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);      // 0=store 8=deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x2821, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `pageshrink-${manifest.version}.zip`);
  fs.writeFileSync(out, Buffer.concat([...chunks, centralBuf, eocd]));

  const bytes = fs.statSync(out).size;
  console.log(`已生成 ${path.relative(ROOT, out)}  (${(bytes / 1024).toFixed(1)} KB, ${files.length} 个文件)`);
  console.log('manifest.json 位于 zip 根目录，可直接上传 Chrome Web Store 开发者控制台。');
  files.forEach((f) => console.log('   ', f.rel));
}

build();
