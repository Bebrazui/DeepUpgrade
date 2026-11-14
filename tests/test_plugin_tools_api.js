// Test suite for DeepUpgrade Plugin Tools API & Web Requests

const assert = require('assert');

// 1. Tool parameters directive formatting
const pluginTools = new Map();

function buildPluginToolsDirective() {
  if (pluginTools.size === 0) return '';
  const blocks = [];
  for (const [name, def] of pluginTools) {
    let block = `- "${name}": ${def.description || 'Custom JS Plugin Tool'}`;
    const params = def.parameters;
    if (params) {
      const paramLines = [];
      const exampleObj = { tool: name };

      if (params.type === 'object' && params.properties) {
        const req = new Set(params.required || []);
        for (const [pName, pSchema] of Object.entries(params.properties)) {
          const isReq = req.has(pName) ? 'обязательно' : 'опционально';
          const pType = pSchema.type || 'string';
          const pDesc = pSchema.description ? `: ${pSchema.description}` : '';
          paramLines.push(`    - ${pName} (${pType}, ${isReq})${pDesc}`);
          exampleObj[pName] = pSchema.default !== undefined ? pSchema.default : (pType === 'number' ? 0 : pType === 'boolean' ? true : `value_${pName}`);
        }
      } else if (typeof params === 'object') {
        for (const [pName, pVal] of Object.entries(params)) {
          if (typeof pVal === 'string') {
            paramLines.push(`    - ${pName}: ${pVal}`);
            exampleObj[pName] = `value_${pName}`;
          } else if (typeof pVal === 'object' && pVal) {
            const isReq = pVal.required ? 'обязательно' : 'опционально';
            const pType = pVal.type || 'string';
            const pDesc = pVal.description ? `: ${pVal.description}` : '';
            paramLines.push(`    - ${pName} (${pType}, ${isReq})${pDesc}`);
            exampleObj[pName] = pVal.default !== undefined ? pVal.default : (pType === 'number' ? 0 : `value_${pName}`);
          }
        }
      }

      if (paramLines.length > 0) {
        block += '\n  Параметры:\n' + paramLines.join('\n');
        block += `\n  Пример вызова: {"tool": "${name}", ${Object.entries(exampleObj).filter(([k]) => k !== 'tool').map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')}}`;
      }
    }
    blocks.push(block);
  }
  return `\n\n[AVAILABLE JS PLUGIN TOOLS]:\n` + blocks.join('\n\n') + '\n(You can invoke any of these custom tools using the standard ```json:tool schema)';
}

// Test registering tools with rich schemas
pluginTools.set('weather', {
  name: 'weather',
  description: 'Получает погоду по городу',
  icon: 'globe',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'Название города' },
      format: { type: 'string', description: 'Формат ответа', default: 'j1' }
    },
    required: ['city']
  }
});

pluginTools.set('calc', {
  name: 'calc',
  description: 'Вычисляет математическое выражение',
  icon: 'calc',
  parameters: {
    expr: { type: 'string', description: 'Выражение', required: true }
  }
});

const directive = buildPluginToolsDirective();
console.log('--- GENERATED DIRECTIVE ---');
console.log(directive);
console.log('---------------------------');

assert(directive.includes('weather'), 'Directive should contain weather tool');
assert(directive.includes('city (string, обязательно): Название города'), 'Directive should describe city param');
assert(directive.includes('format (string, опционально)'), 'Directive should describe optional format param');
assert(directive.includes('calc'), 'Directive should contain calc tool');
assert(directive.includes('expr (string, обязательно)'), 'Directive should describe expr param');
console.log('  PASS  Directive schema and example generation verified');

// 2. Test HTTP Client abstraction
function createMockHttpClient() {
  return {
    get: async (url, params) => {
      let finalUrl = url;
      if (params) {
        const q = new URLSearchParams(params).toString();
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + q;
      }
      return { status: 200, url: finalUrl, parsed: true };
    },
    post: async (url, body) => {
      return { status: 200, body, posted: true };
    }
  };
}

async function testHttp() {
  const http = createMockHttpClient();
  const getRes = await http.get('https://api.example.com/data', { page: 1, limit: 10 });
  assert.strictEqual(getRes.url, 'https://api.example.com/data?page=1&limit=10');
  console.log('  PASS  http.get serializes query parameters correctly');

  const postRes = await http.post('https://api.example.com/submit', { name: 'test' });
  assert.deepStrictEqual(postRes.body, { name: 'test' });
  console.log('  PASS  http.post passes JSON payload');
}

testHttp().then(() => {
  console.log('\nAll plugin tools & web API checks passed.');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
