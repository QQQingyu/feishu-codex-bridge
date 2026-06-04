import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../../config/paths';

const SERVICE_LABEL = 'com.feishu-codex-bridge.default';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const SERVICE_LOG_PATH = join(paths.appDir, 'service.log');
const SERVICE_ERR_LOG_PATH = join(paths.appDir, 'service.err.log');
const LAUNCHD_ENV_ALLOWLIST = [
  'OBSIDIAN_LOCAL_REST_API_KEY',
  'FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP',
] as const;

export interface ServiceOptions {
  config?: string;
  follow?: boolean;
}

type ServiceAction = 'install' | 'uninstall' | 'restart' | 'status' | 'logs';

export async function runService(
  action: string | undefined,
  type: string | undefined,
  opts: ServiceOptions = {},
): Promise<void> {
  const normalized = normalizeAction(action);
  if (!normalized) {
    printUsage();
    process.exit(1);
  }
  if (type && type !== 'launchd') {
    console.error(`✗ 当前只支持 launchd，不支持: ${type}`);
    process.exit(1);
  }
  assertMacOS();

  switch (normalized) {
    case 'install':
      await installLaunchd(opts);
      return;
    case 'uninstall':
      await uninstallLaunchd();
      return;
    case 'restart':
      await restartLaunchd();
      return;
    case 'status':
      await statusLaunchd();
      return;
    case 'logs':
      await logsLaunchd(opts.follow === true);
      return;
  }
}

function normalizeAction(action: string | undefined): ServiceAction | undefined {
  if (
    action === 'install' ||
    action === 'uninstall' ||
    action === 'restart' ||
    action === 'status' ||
    action === 'logs'
  ) {
    return action;
  }
  return undefined;
}

function printUsage(): void {
  console.error('用法: feishu-codex-bridge service <install|status|logs|restart|uninstall> [launchd]');
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    console.error('✗ launchd 只支持 macOS。');
    process.exit(1);
  }
}

async function installLaunchd(opts: ServiceOptions): Promise<void> {
  const nodePath = await realpath(process.execPath);
  const entryPath = await resolveEntryPath();
  const workingDirectory = process.cwd();
  const configPath = opts.config ? await realpath(opts.config).catch(() => opts.config!) : undefined;

  await mkdir(paths.appDir, { recursive: true });
  await mkdir(dirname(PLIST_PATH), { recursive: true });

  const plist = buildPlist({
    nodePath,
    entryPath,
    workingDirectory,
    configPath,
    pathEnv: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    env: collectLaunchdEnv(process.env),
  });
  await writeFile(PLIST_PATH, plist, 'utf8');

  // If the label is already loaded, refresh it so changed paths/config take effect.
  await launchctl(['bootout', guiTarget(), PLIST_PATH], { allowFailure: true, capture: true });
  await launchctl(['bootstrap', guiTarget(), PLIST_PATH]);
  await launchctl(['kickstart', '-k', `${guiTarget()}/${SERVICE_LABEL}`]);

  console.log('✓ launchd service 已安装并启动');
  console.log(`  label: ${SERVICE_LABEL}`);
  console.log(`  plist: ${PLIST_PATH}`);
  console.log(`  logs:  ${SERVICE_LOG_PATH}`);
  console.log(`  errs:  ${SERVICE_ERR_LOG_PATH}`);
}

async function uninstallLaunchd(): Promise<void> {
  await launchctl(['bootout', guiTarget(), PLIST_PATH], { allowFailure: true, capture: true });
  await unlink(PLIST_PATH).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  console.log('✓ launchd service 已卸载');
}

async function restartLaunchd(): Promise<void> {
  if (!(await exists(PLIST_PATH))) {
    console.error(`✗ service 尚未安装: ${PLIST_PATH}`);
    console.error('  先运行: feishu-codex-bridge service install launchd');
    process.exit(1);
  }
  await launchctl(['bootout', guiTarget(), PLIST_PATH], { allowFailure: true, capture: true });
  await launchctl(['bootstrap', guiTarget(), PLIST_PATH]);
  await launchctl(['kickstart', '-k', `${guiTarget()}/${SERVICE_LABEL}`]);
  console.log('✓ launchd service 已重启');
}

async function statusLaunchd(): Promise<void> {
  const result = await launchctl(['print', `${guiTarget()}/${SERVICE_LABEL}`], {
    allowFailure: true,
    capture: true,
  });
  if (result.code === 0) {
    console.log(`✓ launchd service 已加载: ${SERVICE_LABEL}`);
    const pid = findLine(result.stdout, /^\s*pid = /);
    const state = findLine(result.stdout, /^\s*state = /);
    if (pid) console.log(pid.trim());
    if (state) console.log(state.trim());
  } else {
    console.log(`未加载: ${SERVICE_LABEL}`);
  }
  console.log(`plist: ${PLIST_PATH} ${await exists(PLIST_PATH) ? '(exists)' : '(missing)'}`);
  console.log(`logs:  ${SERVICE_LOG_PATH}`);
  console.log(`errs:  ${SERVICE_ERR_LOG_PATH}`);
}

async function logsLaunchd(follow: boolean): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  if (follow) {
    await runForeground('tail', ['-f', SERVICE_LOG_PATH, SERVICE_ERR_LOG_PATH]);
    return;
  }
  for (const p of [SERVICE_LOG_PATH, SERVICE_ERR_LOG_PATH]) {
    console.log(`\n==> ${p} <==`);
    if (!(await exists(p))) {
      console.log('(不存在)');
      continue;
    }
    await runForeground('tail', ['-80', p]);
  }
}

async function resolveEntryPath(): Promise<string> {
  const entry = process.argv[1];
  if (!entry) throw new Error('cannot resolve current CLI entry path');
  return realpath(entry);
}

export function collectLaunchdEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of LAUNCHD_ENV_ALLOWLIST) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

export function buildLaunchdPlist(opts: {
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  configPath?: string;
  pathEnv: string;
  env?: Record<string, string>;
}): string {
  const args = [opts.nodePath, opts.entryPath, 'start'];
  if (opts.configPath) args.push('-c', opts.configPath);
  const environment = {
    PATH: opts.pathEnv,
    HOME: homedir(),
    ...(opts.env ?? {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SERVICE_LABEL)}</string>
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
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(SERVICE_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(SERVICE_ERR_LOG_PATH)}</string>
</dict>
</plist>
`;
}

const buildPlist = buildLaunchdPlist;

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
  if (uid === undefined) {
    throw new Error('cannot resolve uid for launchctl gui target');
  }
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
