import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../../config/paths';
import { runHealth } from './health';

const MONITOR_LABEL = 'com.feishu-codex-bridge.health';
const MONITOR_PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${MONITOR_LABEL}.plist`);
const MONITOR_LOG_PATH = join(paths.appDir, 'health-monitor.log');
const MONITOR_ERR_LOG_PATH = join(paths.appDir, 'health-monitor.err.log');
const DEFAULT_INTERVAL_SECONDS = 900;

export interface HealthMonitorOptions {
  interval?: string;
  follow?: boolean;
}

type HealthMonitorAction = 'install' | 'uninstall' | 'status' | 'logs' | 'run';

export async function runHealthMonitor(
  action: string | undefined,
  opts: HealthMonitorOptions = {},
): Promise<void> {
  const normalized = normalizeAction(action);
  if (!normalized) {
    printUsage();
    process.exit(1);
  }
  assertMacOS();
  switch (normalized) {
    case 'install':
      await installHealthMonitor(opts);
      return;
    case 'uninstall':
      await uninstallHealthMonitor();
      return;
    case 'status':
      await statusHealthMonitor();
      return;
    case 'logs':
      await logsHealthMonitor(opts.follow === true);
      return;
    case 'run':
      await runHealthMonitorOnce();
      return;
  }
}

export function normalizeHealthMonitorInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(86_400, Math.max(60, Math.floor(parsed)));
}

export function buildHealthMonitorPlist(opts: {
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  pathEnv: string;
  intervalSeconds: number;
}): string {
  const args = [opts.nodePath, opts.entryPath, 'health-monitor', 'run'];
  const environment = {
    PATH: opts.pathEnv,
    HOME: homedir(),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(MONITOR_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(MONITOR_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(MONITOR_ERR_LOG_PATH)}</string>
</dict>
</plist>
`;
}

function normalizeAction(action: string | undefined): HealthMonitorAction | undefined {
  if (
    action === 'install' ||
    action === 'uninstall' ||
    action === 'status' ||
    action === 'logs' ||
    action === 'run'
  ) {
    return action;
  }
  return undefined;
}

function printUsage(): void {
  console.error('用法: feishu-codex-bridge health-monitor <install|status|logs|uninstall|run>');
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    console.error('✗ health-monitor launchd 只支持 macOS。');
    process.exit(1);
  }
}

async function installHealthMonitor(opts: HealthMonitorOptions): Promise<void> {
  const nodePath = await realpath(process.execPath);
  const entryPath = await resolveEntryPath();
  const intervalSeconds = normalizeHealthMonitorInterval(opts.interval);

  await mkdir(paths.appDir, { recursive: true });
  await mkdir(dirname(MONITOR_PLIST_PATH), { recursive: true });

  const plist = buildHealthMonitorPlist({
    nodePath,
    entryPath,
    workingDirectory: process.cwd(),
    pathEnv: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    intervalSeconds,
  });
  await writeFile(MONITOR_PLIST_PATH, plist, 'utf8');
  await launchctl(['bootout', guiTarget(), MONITOR_PLIST_PATH], { allowFailure: true, capture: true });
  await launchctl(['bootstrap', guiTarget(), MONITOR_PLIST_PATH]);
  await launchctl(['kickstart', '-k', `${guiTarget()}/${MONITOR_LABEL}`]);

  console.log('✓ health monitor 已安装并启动');
  console.log(`  label: ${MONITOR_LABEL}`);
  console.log(`  interval: ${intervalSeconds}s`);
  console.log(`  plist: ${MONITOR_PLIST_PATH}`);
  console.log(`  logs:  ${MONITOR_LOG_PATH}`);
  console.log(`  errs:  ${MONITOR_ERR_LOG_PATH}`);
}

async function uninstallHealthMonitor(): Promise<void> {
  await launchctl(['bootout', guiTarget(), MONITOR_PLIST_PATH], { allowFailure: true, capture: true });
  await unlink(MONITOR_PLIST_PATH).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  console.log('✓ health monitor 已卸载');
}

async function statusHealthMonitor(): Promise<void> {
  const result = await launchctl(['print', `${guiTarget()}/${MONITOR_LABEL}`], {
    allowFailure: true,
    capture: true,
  });
  if (result.code === 0) {
    console.log(`✓ health monitor 已加载: ${MONITOR_LABEL}`);
    const state = findLine(result.stdout, /^\s*state = /);
    const lastExit = findLine(result.stdout, /^\s*last exit code = /);
    if (state) console.log(state.trim());
    if (lastExit) console.log(lastExit.trim());
  } else {
    console.log(`未加载: ${MONITOR_LABEL}`);
  }
  console.log(`plist: ${MONITOR_PLIST_PATH} ${await exists(MONITOR_PLIST_PATH) ? '(exists)' : '(missing)'}`);
  console.log(`logs:  ${MONITOR_LOG_PATH}`);
  console.log(`errs:  ${MONITOR_ERR_LOG_PATH}`);
}

async function logsHealthMonitor(follow: boolean): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  if (follow) {
    await runForeground('tail', ['-f', MONITOR_LOG_PATH, MONITOR_ERR_LOG_PATH]);
    return;
  }
  for (const p of [MONITOR_LOG_PATH, MONITOR_ERR_LOG_PATH]) {
    console.log(`\n==> ${p} <==`);
    if (!(await exists(p))) {
      console.log('(不存在)');
      continue;
    }
    await runForeground('tail', ['-80', p]);
  }
}

async function runHealthMonitorOnce(): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  const startedAt = new Date().toISOString();
  await appendFile(MONITOR_LOG_PATH, `\n== ${startedAt} health check ==\n`, 'utf8');
  await runHealth();
}

async function resolveEntryPath(): Promise<string> {
  const entry = process.argv[1];
  if (!entry) throw new Error('cannot resolve current CLI entry path');
  return realpath(entry);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function guiTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new Error('cannot resolve uid for launchctl gui target');
  return `gui/${uid}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function findLine(s: string, pattern: RegExp): string | undefined {
  return s.split('\n').find((line) => pattern.test(line));
}

async function launchctl(
  args: string[],
  opts: { allowFailure?: boolean; capture?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('launchctl', args, opts);
}

async function run(
  command: string,
  args: string[],
  opts: { allowFailure?: boolean; capture?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (!opts.capture) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (!opts.capture) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const finalCode = code ?? 0;
      if (finalCode !== 0 && !opts.allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${finalCode}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve({ code: finalCode, stdout, stderr });
    });
  });
}

async function runForeground(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code && code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
  });
}
