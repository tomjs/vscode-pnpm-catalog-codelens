'use strict';
// Test runner: executes every *.test.cjs suite against the built extension.
const suites = [
  'provider',
  'catalog',
  'workspace',
  'style',
];

async function main() {
  let failed = 0;
  for (const name of suites) {
    const { run } = require(`./${name}.test.cjs`);
    try {
      await run();
      console.log(`\u2714 ${name}`);
    }
    catch (error) {
      failed++;
      console.error(`\u2716 ${name}\n${error && error.stack ? error.stack : error}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} suite(s) failed`);
    process.exit(1);
  }
  console.log('\nAll tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
