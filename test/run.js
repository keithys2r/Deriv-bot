// test/run.js
// Tiny zero-dependency test runner, matching the repo's philosophy of not
// adding packages for things Node already provides. Each *.test.js file
// exports an object of { 'test name': (assert) => void }; a thrown
// assertion counts as a failure, anything else is a pass.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testFiles = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let passed = 0;
let failed = 0;

for (const file of testFiles) {
  const tests = require(path.join(__dirname, file));
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn(assert);
      console.log(`  ok   ${file} > ${name}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL ${file} > ${name}`);
      console.log(`       ${err.message}`);
      failed++;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
