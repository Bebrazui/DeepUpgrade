const assert = require('assert');

const DSML_TAG_HEAD_RE = /<\s*(\/?)\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+/gi;

function normalizeDsml(text) {
  return String(text || '').replace(DSML_TAG_HEAD_RE, (match, slash) => '<' + (slash || '') + '|DSML||');
}

function stripInvisibleChars(text) {
  return String(text || '').replace(/[\u200B-\u200F\u2060\uFEFF\u00AD\u180E\u202A-\u202E]/g, '');
}

function parseDsmlToolCall(rawText) {
  const src = normalizeDsml(stripInvisibleChars(rawText));
  const invokeRe = /(?:<\|DSML\|\|invoke|<invoke)\s+name="([^"]+)"([^>]*)>/i;
  const inv = invokeRe.exec(src);
  if (!inv) return null;

  const toolName = (inv[1] || '').trim();
  const bodyStart = inv.index + inv[0].length;
  const closeRe = /(?:<\/\|DSML\|\|invoke\s*>|<\/invoke\s*>)/i;
  const closeMatch = closeRe.exec(src.slice(bodyStart));
  const body = closeMatch ? src.slice(bodyStart, bodyStart + closeMatch.index) : src.slice(bodyStart);

  const params = {};
  const paramRe = /(?:<\|DSML\|\|parameter|<parameter)\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?:<\/\|DSML\|\|parameter\s*>|<\/parameter\s*>|$)/gi;
  let pm;
  while ((pm = paramRe.exec(body)) !== null) {
    let value = (pm[3] || '').trim();
    const attrs = pm[2] || '';
    if (!/string="true"/i.test(attrs)) {
      try { value = JSON.parse(value); } catch (e) { /* keep raw text */ }
    }
    params[pm[1]] = value;
    if (paramRe.lastIndex >= body.length) break;
  }

  return { toolName, params, complete: !!closeMatch };
}

// Case 1: The exact text from user screenshot 2 (spaced ASCII pipes)
const screenshotCase = `< | | DSML | | calls>
< | | DSML | | invoke name="bash">
< | | DSML | | parameter name="code" string="true">ls -la /added/file/ && wc -l /added/file/GWM_MEGA_DUMP_NEW.txt && head -50 /added/file/GWM_MEGA_DUMP_NEW.txt</ | | DSML | | parameter>
</ | | DSML | | invoke>
</ | | DSML | | calls>`;

const res1 = parseDsmlToolCall(screenshotCase);
assert(res1 !== null, 'res1 must not be null');
assert.strictEqual(res1.toolName, 'bash');
assert.strictEqual(res1.params.code, 'ls -la /added/file/ && wc -l /added/file/GWM_MEGA_DUMP_NEW.txt && head -50 /added/file/GWM_MEGA_DUMP_NEW.txt');
assert.strictEqual(res1.complete, true);
console.log('PASS Case 1: Spaced ASCII pipes from screenshot');

// Case 2: Fullwidth unicode bars (DeepSeek standard)
const unicodeCase = `<｜DSML｜calls>
<｜DSML｜invoke name="read">
<｜DSML｜parameter name="path">/test.py</｜DSML｜parameter>
<｜DSML｜parameter name="offset">1</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

const res2 = parseDsmlToolCall(unicodeCase);
assert(res2 !== null, 'res2 must not be null');
assert.strictEqual(res2.toolName, 'read');
assert.strictEqual(res2.params.path, '/test.py');
assert.strictEqual(res2.params.offset, 1);
assert.strictEqual(res2.complete, true);
console.log('PASS Case 2: Fullwidth unicode bars');

// Case 3: Double fullwidth unicode bars with extra spaces
const doubleUnicodeCase = `< ｜ ｜ DSML ｜ ｜ calls >
< ｜ ｜ DSML ｜ ｜ invoke name="write" >
< ｜ ｜ DSML ｜ ｜ parameter name="path" string="true" >foo.txt< / ｜ ｜ DSML ｜ ｜ parameter >
< ｜ ｜ DSML ｜ ｜ parameter name="content" string="true" >hello world< / ｜ ｜ DSML ｜ ｜ parameter >
< / ｜ ｜ DSML ｜ ｜ invoke >
< / ｜ ｜ DSML ｜ ｜ calls >`;

const res3 = parseDsmlToolCall(doubleUnicodeCase);
assert(res3 !== null, 'res3 must not be null');
assert.strictEqual(res3.toolName, 'write');
assert.strictEqual(res3.params.path, 'foo.txt');
assert.strictEqual(res3.params.content, 'hello world');
assert.strictEqual(res3.complete, true);
console.log('PASS Case 3: Double fullwidth unicode bars with spaces');

// Case 4: Streaming (incomplete invoke)
const streamingCase = `< | | DSML | | calls>
< | | DSML | | invoke name="bash">
< | | DSML | | parameter name="code" string="true">echo 123`;

const res4 = parseDsmlToolCall(streamingCase);
assert(res4 !== null, 'res4 must not be null');
assert.strictEqual(res4.toolName, 'bash');
assert.strictEqual(res4.complete, false);
console.log('PASS Case 4: Streaming incomplete call');

// Case 5: Parameter with code containing <, >, | and pipes
const complexCodeCase = `<|DSML||calls>
<|DSML||invoke name="bash">
<|DSML||parameter name="code" string="true">for x in a b; do diff <(echo $x) <(echo $x) > out.txt; done; cat out.txt | grep -v "foo"</|DSML||parameter>
</|DSML||invoke>
</|DSML||calls>`;

const res5 = parseDsmlToolCall(complexCodeCase);
assert(res5 !== null, 'res5 must not be null');
assert.strictEqual(res5.toolName, 'bash');
assert.strictEqual(res5.params.code, 'for x in a b; do diff <(echo $x) <(echo $x) > out.txt; done; cat out.txt | grep -v "foo"');
assert.strictEqual(res5.complete, true);
console.log('PASS Case 5: Parameter with complex shell code containing redirects');

console.log('All DSML tests passed successfully!');

