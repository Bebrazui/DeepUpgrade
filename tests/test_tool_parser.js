// Tool-block parser regression test.
//
// DeepSeek streams the answer token by token. Two bugs caused fatal `write`
// truncation:
//   1. processToolCalls executed a block while it was still streaming, so the
//      content stopped at an arbitrary `{`.
//   2. extractJsonStringField stopped at the first inner quote, so code with
//      unescaped quotes (Python `print("hello")`, JS objects) was cut short.
// This test loads the real parser slice from content.js and checks both the
// extraction results and the streaming gate.

const fs = require('fs');
const path = require('path');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');
const SENTINEL = 'function processToolCalls()';

function loadParser() {
  const source = fs.readFileSync(CONTENT_PATH, 'utf8');
  const start = source.indexOf('const KNOWN_TOOL_NAMES');
  const end = source.indexOf(SENTINEL);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find the tool parser slice in content.js');
  }
  const code = source.slice(start, end);
  const module = { exports: {} };
  const fn = new Function(
    'module',
    'console',
    code +
      '\nmodule.exports = {' +
      ' extractToolCall, extractBalancedJsonObjects, extractJsonStringField,' +
      ' extractJsonStringFieldRobust, decodeJsonStringLike,' +
      ' isToolBlockStructurallyComplete, isToolBlockReady, validateToolObject' +
      '};'
  );
  fn(module, console);
  return module.exports;
}

const parser = loadParser();

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

function writeBlock(payload) {
  return JSON.stringify({ tool: 'write', path: '/a.txt', content: payload });
}

function expectContent(name, text, expected) {
  const result = parser.extractToolCall(text);
  const actual = result && result.content;
  check(
    name,
    actual === expected,
    actual === expected ? '' : `got ${JSON.stringify(actual)} (${actual ? actual.length : 0} chars), expected ${JSON.stringify(expected)} (${expected.length} chars)`
  );
}

console.log('write content extraction');
expectContent('plain text', writeBlock('hello fix'), 'hello fix');
expectContent('single quotes', writeBlock("alpha 'beta' gamma"), "alpha 'beta' gamma");
expectContent('braces in plain text', writeBlock('a {x} b {y} c'), 'a {x} b {y} c');
expectContent(
  'multiline python f-string',
  writeBlock('def greet(name):\n    return f"Hello {name}"\n\nprint(greet("Ann"))\n'),
  'def greet(name):\n    return f"Hello {name}"\n\nprint(greet("Ann"))\n'
);
expectContent(
  'raw newlines python f-string',
  '{ "tool": "write", "path": "/f.py", "content": "def greet(name):\n    return f\'Hello {name}\'" }',
  "def greet(name):\n    return f'Hello {name}'"
);
expectContent(
  'unescaped quotes in python',
  '{ "tool": "write", "path": "/f.py", "content": "print("hello")\nx = {"a": 1}" }',
  'print("hello")\nx = {"a": 1}'
);
expectContent(
  'python nested dict',
  writeBlock('d = {"a": 1, "b": {"c": 2}}\nprint(d)\n'),
  'd = {"a": 1, "b": {"c": 2}}\nprint(d)\n'
);
expectContent(
  'js object literal',
  writeBlock('const o = {a: 1, b: {c: 2}};\nconsole.log(o);'),
  'const o = {a: 1, b: {c: 2}};\nconsole.log(o);'
);
expectContent(
  'json file content',
  writeBlock('{\n  "a": 1,\n  "b": {"c": 2}\n}\n'),
  '{\n  "a": 1,\n  "b": {"c": 2}\n}\n'
);
expectContent(
  'fenced block with surrounding prose',
  'Here you go:\n```json:tool\n' + writeBlock('a {x} b {y} c') + '\n```\nDone.',
  'a {x} b {y} c'
);
expectContent(
  'content before path key',
  '{"tool":"write","content":"a {x} b {y} c","path":"/a.txt"}',
  'a {x} b {y} c'
);

console.log('edit extraction');
{
  const text = '{"tool":"edit","path":"/f.py","old_str":"x = 1","new_str":"print("hi")\nx = {"a": 1}"}';
  const result = parser.extractToolCall(text);
  check('edit keeps unescaped quotes', result && result.new_str === 'print("hi")\nx = {"a": 1}', JSON.stringify(result));
}

console.log('invalid payloads stay visible');
{
  const result = parser.extractToolCall('{"tool":"write","path":"/a.txt","content":""}');
  check('empty write is flagged', result && /^write: "content" is empty/.test(result.__parseError || ''), JSON.stringify(result));
}

console.log('streaming gate');
{
  const partial = `{ "tool": "write", "path": "/f.py", "content": "def f(name):\n    return f'Hello {name}`;
  check('partial block is not structurally complete', parser.isToolBlockStructurallyComplete(partial) === false);
  check('partial block is not strict JSON', parser.extractBalancedJsonObjects(partial).length === 0);

  const truncatedAtBrace = '{"tool":"write","path":"/a.txt","content":"a {x} b {y';
  check('truncated at a brace is not complete', parser.isToolBlockStructurallyComplete(truncatedAtBrace) === false);

  const complete = `{ "tool": "write", "path": "/f.py", "content": "def f(name):\n    return f'Hello {name}'" }`;
  check('full block is structurally complete', parser.isToolBlockStructurallyComplete(complete) === true);

  check(
    'block with unescaped quotes is structurally complete',
    parser.isToolBlockStructurallyComplete('{"tool":"write","path":"/f.py","content":"print("hi")\nx = {"a": 1}"}') === true
  );
  check(
    'content with stray closing brace is structurally complete',
    parser.isToolBlockStructurallyComplete('{"tool":"write","path":"/a.txt","content":"a } b"}') === true
  );
  check(
    'partial block ending inside content is not complete',
    parser.isToolBlockStructurallyComplete('{ "tool": "write", "path": "/a.txt", "content": "a {x}"') === false
  );

  const strict = '{"tool":"read","path":"/a.txt"}';
  check('strict JSON is structurally complete', parser.isToolBlockStructurallyComplete(strict) === true);
}

console.log('streaming gate debounces malformed blocks');
{
  const partial = '{"tool":"write","path":"/a.txt","content":"a {x} b {y';
  const block = { isConnected: true, __duLastText: undefined };
  const first = parser.isToolBlockReady(block, partial);
  check('first sight of a streaming block is not ready', first === false);
  if (block.__duRecheckTimer) clearTimeout(block.__duRecheckTimer);

  const complete = '{"tool":"write","path":"/a.txt","content":"a {x} b {y} c"}';
  const strictBlock = { isConnected: true };
  check('complete strict block is ready immediately', parser.isToolBlockReady(strictBlock, complete) === true);

  const stalled = '{"tool":"write","path":"/a.txt","content":"a {x} b {y';
  const pausedBlock = { isConnected: true, __duLastText: stalled, __duTextAt: Date.now() - 6000 };
  check('partial block is not executed after a 6s pause', parser.isToolBlockReady(pausedBlock, stalled) === false);
  if (pausedBlock.__duRecheckTimer) clearTimeout(pausedBlock.__duRecheckTimer);

  const deadBlock = { isConnected: true, __duLastText: stalled, __duTextAt: Date.now() - 21000 };
  check('long-stalled partial block is reported incomplete', parser.isToolBlockReady(deadBlock, stalled) === 'incomplete');
  if (deadBlock.__duRecheckTimer) clearTimeout(deadBlock.__duRecheckTimer);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll tool parser checks passed.');
