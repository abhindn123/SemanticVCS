/**
 * Terminal UI utilities — colors, boxes, spinners
 */

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

function box(title, lines, borderColor = c.cyan) {
  const maxLen = Math.max(title.length, ...lines.map(l => stripAnsi(l).length));
  const width = Math.max(maxLen + 4, 50);
  const hr = '─'.repeat(width);
  
  console.log(`${borderColor}┌${hr}┐${c.reset}`);
  console.log(`${borderColor}│${c.reset} ${c.bold}${title}${c.reset}${' '.repeat(width - stripAnsi(title).length - 1)}${borderColor}│${c.reset}`);
  console.log(`${borderColor}├${hr}┤${c.reset}`);
  for (const line of lines) {
    const pad = width - stripAnsi(line).length - 1;
    console.log(`${borderColor}│${c.reset} ${line}${' '.repeat(Math.max(pad, 0))}${borderColor}│${c.reset}`);
  }
  console.log(`${borderColor}└${hr}┘${c.reset}`);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[i % frames.length]}${c.reset} ${text}`);
    i++;
  }, 80);
  return {
    stop: (finalText) => {
      clearInterval(id);
      process.stdout.write(`\r${finalText}\n`);
    }
  };
}

module.exports = { c, box, spinner, stripAnsi };
