const fs = require('fs');
const content = fs.readFileSync('C:/DeepUpgrade/extension/content.js', 'utf8');
const runner = fs.readFileSync('C:/DeepUpgrade/extension/sandbox/runner.html', 'utf8');

console.log('runner has tool === read:', runner.includes("tool === 'read'"));
console.log('runner has tool === write:', runner.includes("tool === 'write'"));
console.log('content has toolName === read:', content.includes("toolName === 'read'"));
console.log('content has toolName === write:', content.includes("toolName === 'write'"));
console.log('content has Чтение/Запись widgets:', content.includes('Чтение:') && content.includes('Запись:'));
