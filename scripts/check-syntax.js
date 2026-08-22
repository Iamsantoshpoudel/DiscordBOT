'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const files = walk(path.join(__dirname, '..', 'src'));
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`Syntax OK (${files.length} files)`);
