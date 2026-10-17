import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const python = process.env.APP_PYTHON || 'backend/.venv/bin/python';
if (!existsSync(python)) {
  console.error('请先按 README.md 安装后端环境 / Set up the backend environment in README.md first.');
  process.exit(1);
}
const children = [
  spawn(python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', '8000'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) { if(stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
children.forEach(child => { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code || 0)); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
