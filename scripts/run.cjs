const { spawn } = require('node:child_process');
const path = require('node:path');
const testing = process.argv.includes('--test');
const evaluating = process.argv.includes('--evaluate');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (testing) env.ELECTRON_RUN_AS_NODE = '1';
const args = testing
  ? [path.join(__dirname, '../test/check.cjs')]
  : evaluating ? [path.join(__dirname, 'evaluate.cjs'), ...process.argv.slice(2).filter(arg=>arg!=='--evaluate')]
  : [path.join(__dirname, '..'), ...process.argv.slice(2)];
const child = spawn(require('electron'), args, { env, stdio: 'inherit', windowsHide: testing || evaluating || process.argv.includes('--smoke') });
child.on('error', () => { console.error('앱을 실행하지 못했어요. npm install을 먼저 실행해주세요.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
