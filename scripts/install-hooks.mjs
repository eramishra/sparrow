/**
 * Installs the Sparrow pre-commit hook.
 * Run once after cloning: node scripts/install-hooks.mjs
 */

import { writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';

const hookPath = join('.git', 'hooks', 'pre-commit');

if (!existsSync('.git')) {
  console.error('✗ Not in a git repository root. Run from project root.');
  process.exit(1);
}

writeFileSync(hookPath, `#!/bin/sh
# Sparrow pre-commit hook — runs functional tests before every commit.
# Bypass (not recommended): git commit --no-verify
printf "\\nRunning Sparrow tests...\\n"
node scripts/test-suite.mjs
if [ $? -ne 0 ]; then
  printf "\\n\\033[31m✗ Tests failed. Commit blocked.\\033[0m\\n"
  printf "  Fix the failures above, then commit again.\\n\\n"
  exit 1
fi
`);

chmodSync(hookPath, 0o755);
console.log('✓ pre-commit hook installed at .git/hooks/pre-commit');
console.log('  Runs: node scripts/test-suite.mjs (smoke + onboarding + commands)');
console.log('  Bypass: git commit --no-verify  (not recommended)');
