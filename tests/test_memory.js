const assert = require('assert');

// Simulate localStorage
const storage = {};
global.localStorage = {
  getItem: (k) => storage[k] || null,
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};

// Test memory logic
function getUserMemoryContent() {
  return (localStorage.getItem('du_user_memory') || '').trim();
}

function setUserMemoryContent(content) {
  const clean = String(content || '').trim();
  localStorage.setItem('du_user_memory', clean);
}

function getCustomInstructions() {
  return (localStorage.getItem('du_custom_instructions') || '').trim();
}

function setCustomInstructions(text) {
  const clean = String(text || '').trim();
  localStorage.setItem('du_custom_instructions', clean);
}

// 1. Initial empty states
assert.strictEqual(getUserMemoryContent(), '');
assert.strictEqual(getCustomInstructions(), '');
console.log('PASS: Initial empty state');

// 2. Setting custom instructions
setCustomInstructions('Меня зовут Иван. Пишу на Go.');
assert.strictEqual(getCustomInstructions(), 'Меня зовут Иван. Пишу на Go.');
console.log('PASS: Custom instructions set & get');

// 3. Memory tool save simulation
let currentMem = getUserMemoryContent();
const dateStr = new Date().toISOString().slice(0, 10);
const fact1 = 'Использует PostgreSQL и Docker';
const entry1 = `- [${dateStr}] ${fact1}`;
currentMem = currentMem ? `${currentMem}\n${entry1}` : `# User Profile & Preferences\n${entry1}`;
setUserMemoryContent(currentMem);

assert(getUserMemoryContent().includes('PostgreSQL и Docker'));
assert(getUserMemoryContent().includes('# User Profile & Preferences'));
console.log('PASS: Memory tool save');

// 4. Memory deduplication check
const factDuplicate = 'Использует PostgreSQL и Docker';
if (!getUserMemoryContent().includes(factDuplicate)) {
  setUserMemoryContent(`${getUserMemoryContent()}\n- [${dateStr}] ${factDuplicate}`);
}
assert.strictEqual(getUserMemoryContent().split('PostgreSQL и Docker').length - 1, 1);
console.log('PASS: Duplicate fact not added');

// 5. Appending another fact
const fact2 = 'Любит лаконичные ответы без лишнего кода';
const entry2 = `- [${dateStr}] ${fact2}`;
currentMem = `${getUserMemoryContent()}\n${entry2}`;
setUserMemoryContent(currentMem);

assert(getUserMemoryContent().includes(fact1));
assert(getUserMemoryContent().includes(fact2));
console.log('PASS: Multi-fact memory accumulation');

console.log('All memory unit tests passed successfully!');
