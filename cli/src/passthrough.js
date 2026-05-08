/**
 * Passthrough — forwards any unknown command to real git
 */

const { spawnSync } = require('child_process');

function passthrough(args) {
  const result = spawnSync('git', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    shell: true,
  });
  process.exit(result.status || 0);
}

module.exports = { passthrough };
