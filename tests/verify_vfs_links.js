const fs = require('fs');
const content = fs.readFileSync('C:/DeepUpgrade/extension/content.js', 'utf8');
const runner = fs.readFileSync('C:/DeepUpgrade/extension/sandbox/runner.html', 'utf8');
const css = fs.readFileSync('C:/DeepUpgrade/extension/ui/injected.css', 'utf8');

console.log('content has renderVfsArtifactLinks:', content.includes('renderVfsArtifactLinks'));
console.log('content has fetchFileFromSandbox:', content.includes('fetchFileFromSandbox'));
console.log('runner has DU_GET_FILE:', runner.includes('DU_GET_FILE'));
console.log('css has du-vfs-image-card:', css.includes('.du-vfs-image-card'));
console.log('css has du-vfs-file-card:', css.includes('.du-vfs-file-card'));
console.log('content directive has VFS ARTIFACT LINKING:', content.includes('VFS ARTIFACT LINKING'));
