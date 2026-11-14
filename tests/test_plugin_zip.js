const zlib = require('zlib');

// Self-contained regression test for DeepUpgrade ZIP Plugin Engine

function createTestZipBuffer(fileEntries) {
  const localHeaders = [];
  const cdEntries = [];
  let offset = 0;

  for (const [filename, content] of Object.entries(fileEntries)) {
    const isBuffer = Buffer.isBuffer(content);
    const uncompData = isBuffer ? content : Buffer.from(content, 'utf8');
    const compData = zlib.deflateRawSync(uncompData);
    const fnBuf = Buffer.from(filename, 'utf8');

    // Local Header (30 bytes + fn)
    const lh = Buffer.alloc(30 + fnBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // sig
    lh.writeUInt16LE(20, 4); // version
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // compression = deflate
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(0, 14); // crc32 placeholder
    lh.writeUInt32LE(compData.length, 18);
    lh.writeUInt32LE(uncompData.length, 24);
    lh.writeUInt16LE(fnBuf.length, 28);
    lh.writeUInt16LE(0, 30);
    fnBuf.copy(lh, 30);

    localHeaders.push(lh, compData);

    // Central Directory Entry (46 bytes + fn)
    const cd = Buffer.alloc(46 + fnBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); // sig
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(uncompData.length, 24);
    cd.writeUInt16LE(fnBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // local header offset
    fnBuf.copy(cd, 46);

    cdEntries.push(cd);
    offset += lh.length + compData.length;
  }

  const cdTotalSize = cdEntries.reduce((sum, b) => sum + b.length, 0);
  const cdOffset = offset;

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(fileEntries).length, 8);
  eocd.writeUInt16LE(Object.keys(fileEntries).length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...cdEntries, eocd]);
}

async function duInflateRaw(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  let res = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    res.set(c, offset);
    offset += c.length;
  }
  return res;
}

function duBytesToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 0x8000;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

async function duUnpackZip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;

  let eocdOffset = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP: End of Central Directory signature not found.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const files = {};
  let cur = cdOffset;
  const textDecoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries; i++) {
    const sig = view.getUint32(cur, true);
    if (sig !== 0x02014b50) {
      throw new Error(`Corrupted Central Directory at entry ${i}`);
    }
    const compression = view.getUint16(cur + 10, true);
    const compSize = view.getUint32(cur + 20, true);
    const uncompSize = view.getUint32(cur + 24, true);
    const fileNameLen = view.getUint16(cur + 28, true);
    const extraLen = view.getUint16(cur + 30, true);
    const commentLen = view.getUint16(cur + 32, true);
    const localHeaderOffset = view.getUint32(cur + 42, true);

    const fileNameBytes = bytes.subarray(cur + 46, cur + 46 + fileNameLen);
    let fileName = textDecoder.decode(fileNameBytes).replace(/\\/g, '/');
    cur += 46 + fileNameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;
    fileName = fileName.replace(/^\/+/, '');

    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Corrupted local header for ${fileName}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = bytes.subarray(dataStart, dataStart + compSize);

    let uncompressedBytes;
    if (compression === 0) {
      uncompressedBytes = compressedData;
    } else if (compression === 8) {
      uncompressedBytes = await duInflateRaw(compressedData);
    } else {
      throw new Error(`Unsupported compression method ${compression} for ${fileName}`);
    }

    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(uncompressedBytes);
    } catch (e) {
      text = null;
    }

    files[fileName] = {
      name: fileName,
      size: uncompSize,
      isBinary: text === null,
      text: text,
      base64: text === null ? duBytesToBase64(uncompressedBytes) : null
    };
  }

  return files;
}

function duNormalizeZipEntries(rawFiles) {
  const keys = Object.keys(rawFiles);
  if (keys.length === 0) return rawFiles;

  const firstSlash = keys[0].indexOf('/');
  if (firstSlash > 0) {
    const commonPrefix = keys[0].slice(0, firstSlash + 1);
    const allShare = keys.every(k => k.startsWith(commonPrefix));
    if (allShare) {
      const stripped = {};
      for (const [k, v] of Object.entries(rawFiles)) {
        const newKey = k.slice(commonPrefix.length);
        if (newKey) {
          v.name = newKey;
          stripped[newKey] = v;
        }
      }
      return stripped;
    }
  }
  return rawFiles;
}

async function run() {
  console.log('Testing ZIP unpack and plugin initialization...');

  // 1. Create in-memory zip
  const zipBuf = createTestZipBuffer({
    'my-plugin/plugin.json': JSON.stringify({
      name: 'super-zip-plugin',
      version: '2.1.0',
      description: 'Test plugin with multiple assets',
      main: 'index.js'
    }),
    'my-plugin/index.js': `
      const utils = DeepUpgrade.require('./utils.js');
      const css = DeepUpgrade.getAsset('assets/style.css');
      DeepUpgrade.registerTool({
        name: 'super_tool',
        description: 'Super tool with assets',
        execute: async (args) => {
          return utils.format(args.text) + ' | css: ' + (css ? 'loaded' : 'missing');
        }
      });
    `,
    'my-plugin/utils.js': `
      module.exports = {
        format: (s) => '[FORMATTED: ' + String(s).toUpperCase() + ']'
      };
    `,
    'my-plugin/assets/style.css': '.super-tool { color: #3b82f6; }',
    'my-plugin/assets/config.json': '{"mode": "fast", "retries": 3}'
  });

  const ab = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const raw = await duUnpackZip(ab);
  const files = duNormalizeZipEntries(raw);

  if (!files['plugin.json'] || !files['index.js'] || !files['utils.js'] || !files['assets/style.css']) {
    throw new Error('Missing expected unpacked files');
  }
  console.log('  PASS  unpackZip and directory normalization work');

  const manifest = JSON.parse(files['plugin.json'].text);
  if (manifest.name !== 'super-zip-plugin' || manifest.version !== '2.1.0') {
    throw new Error('Manifest values mismatch');
  }
  console.log('  PASS  manifest is correctly extracted');

  // Test Plugin API integration
  const registeredTools = new Map();
  const plugin = {
    id: 'test_super_plug',
    name: manifest.name,
    version: manifest.version,
    desc: manifest.description,
    files
  };

  const getAsset = (relPath, format = 'auto') => {
    const cleanPath = String(relPath || '').replace(/^[./\\]+/, '');
    const entry = plugin.files[cleanPath] || plugin.files[relPath];
    if (!entry) return null;
    if (format === 'text') return entry.text || '';
    if (format === 'base64') return entry.base64 || '';
    if (!entry.isBinary) return entry.text;
    return entry.base64;
  };

  const requireModule = (relPath) => {
    const cleanPath = String(relPath || '').replace(/^[./\\]+/, '');
    const targetPath = cleanPath.endsWith('.js') ? cleanPath : cleanPath + '.js';
    const entry = plugin.files[targetPath] || plugin.files[cleanPath];
    if (!entry) throw new Error(`Cannot find module '${relPath}'`);
    const module = { exports: {} };
    const fn = new Function('module', 'exports', 'require', 'DeepUpgrade', entry.text);
    fn(module, module.exports, requireModule, api);
    return module.exports;
  };

  const api = {
    plugin,
    files: plugin.files,
    getAsset,
    getFile: getAsset,
    require: requireModule,
    registerTool: (def) => {
      registeredTools.set(def.name, def);
    }
  };

  // Run plugin index.js
  const runner = new Function('DeepUpgrade', files['index.js'].text);
  runner(api);

  const tool = registeredTools.get('super_tool');
  if (!tool) throw new Error('Tool not registered by index.js');
  console.log('  PASS  plugin executes and registers tool via DeepUpgrade.registerTool');

  const output = await tool.execute({ text: 'hello world' });
  if (output !== '[FORMATTED: HELLO WORLD] | css: loaded') {
    throw new Error('Unexpected tool output: ' + output);
  }
  console.log('  PASS  tool executes with multi-file require() and getAsset()');

  console.log('\nAll ZIP plugin engine checks passed.');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
