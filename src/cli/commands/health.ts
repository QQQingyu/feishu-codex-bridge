import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readRecentLogs } from '../../core/logger';

const SERVICE_LABEL = 'com.feishu-codex-bridge.default';

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthInput {
  service: {
    loaded: boolean;
    running: boolean;
    pid?: number;
    lastExitCode?: number;
  };
  distMarkers: {
    obsidianModeLogged: boolean;
    newChatAllowlisted: boolean;
  };
  recentLogLines: string[];
}

export interface HealthResult {
  ok: boolean;
  checks: HealthCheck[];
}

export async function runHealth(): Promise<void> {
  const input = await collectHealthInput();
  const result = evaluateHealth(input);
  console.log(formatHealthReport(result));
  if (!result.ok) process.exitCode = 1;
}

export function evaluateHealth(input: HealthInput): HealthResult {
  const checks: HealthCheck[] = [];
  checks.push(evaluateService(input.service));
  checks.push(evaluateDistMarkers(input.distMarkers));
  checks.push(evaluateWebsocket(input.recentLogLines));
  checks.push(evaluateAgentSpawn(input.recentLogLines));
  checks.push(evaluateRecentNoise(input.recentLogLines));
  return {
    ok: checks.every((check) => check.status === 'ok'),
    checks,
  };
}

export function formatHealthReport(result: HealthResult): string {
  const lines = [`health: ${result.ok ? 'ok' : 'attention'}`];
  for (const check of result.checks) {
    const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
    lines.push(`${mark} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}

async function collectHealthInput(): Promise<HealthInput> {
  const [service, distMarkers, recentLogs] = await Promise.all([
    collectServiceStatus(),
    collectDistMarkers(),
    readRecentLogs({ maxBytes: 80_000 }).catch(() => ''),
  ]);
  return {
    service,
    distMarkers,
    recentLogLines: recentLogs.split('\n').filter(Boolean),
  };
}

function evaluateService(service: HealthInput['service']): HealthCheck {
  if (!service.loaded) {
    return {
      name: 'launchd service',
      status: 'fail',
      detail: `${SERVICE_LABEL} is not loaded`,
    };
  }
  if (!service.running) {
    return {
      name: 'launchd service',
      status: 'fail',
      detail: `loaded but not running${service.lastExitCode !== undefined ? `, last exit ${service.lastExitCode}` : ''}`,
    };
  }
  return {
    name: 'launchd service',
    status: 'ok',
    detail: `running${service.pid ? `, pid ${service.pid}` : ''}`,
  };
}

function evaluateDistMarkers(markers: HealthInput['distMarkers']): HealthCheck {
  const missing: string[] = [];
  if (!markers.obsidianModeLogged) missing.push('obsidian MCP telemetry');
  if (!markers.newChatAllowlisted) missing.push('/new chat allowlist self-heal');
  if (missing.length > 0) {
    return {
      name: 'dist markers',
      status: 'fail',
      detail: `missing ${missing.join(', ')}`,
    };
  }
  return {
    name: 'dist markers',
    status: 'ok',
    detail: 'current bridge hardening markers present',
  };
}

function evaluateWebsocket(lines: string[]): HealthCheck {
  const connected = lines.some((line) => line.includes('"phase":"ws"') && line.includes('"event":"connected"'));
  if (connected) {
    return { name: 'websocket connection', status: 'ok', detail: 'recent ws connected event found' };
  }
  const activeInbound = lines.some((line) =>
    (line.includes('"phase":"intake"') && line.includes('"event":"enter"')) ||
    (line.includes('"phase":"cardAction"') && line.includes('"event":"cmd"')));
  return activeInbound
    ? { name: 'websocket connection', status: 'ok', detail: 'recent inbound event found' }
    : { name: 'websocket connection', status: 'warn', detail: 'no recent ws or inbound event in log tail' };
}

function evaluateAgentSpawn(lines: string[]): HealthCheck {
  const hasTelemetry = lines.some((line) =>
    line.includes('"event":"spawn"') && line.includes('"obsidianMcpEnabled":false'));
  return hasTelemetry
    ? { name: 'agent spawn telemetry', status: 'ok', detail: 'obsidianMcpEnabled=false observed' }
    : { name: 'agent spawn telemetry', status: 'warn', detail: 'no recent obsidianMcpEnabled=false spawn event' };
}

function evaluateRecentNoise(lines: string[]): HealthCheck {
  const hasRmcpNoise = lines.some((line) => line.includes('rmcp::transport::worker'));
  const errorCount = lines.filter((line) => line.includes('"level":"error"')).length;
  const warnCount = lines.filter((line) => line.includes('"level":"warn"')).length;
  if (hasRmcpNoise) {
    return {
      name: 'recent log noise',
      status: 'warn',
      detail: 'optional Obsidian MCP worker noise found',
    };
  }
  if (errorCount > 0) {
    return {
      name: 'recent log noise',
      status: 'warn',
      detail: `${errorCount} error log line(s), ${warnCount} warning log line(s)`,
    };
  }
  return {
    name: 'recent log noise',
    status: 'ok',
    detail: `${warnCount} warning log line(s), no rmcp worker noise`,
  };
}

async function collectServiceStatus(): Promise<HealthInput['service']> {
  const result = await run('launchctl', ['print', `${guiTarget()}/${SERVICE_LABEL}`], true);
  if (result.code !== 0) return { loaded: false, running: false };
  const pid = numberFromLine(result.stdout, /^\s*pid = (\d+)/m);
  const state = stringFromLine(result.stdout, /^\s*state = (\w+)/m);
  const lastExitCode = numberFromLine(result.stdout, /^\s*last exit code = (-?\d+)/m);
  return {
    loaded: true,
    running: state === 'running',
    ...(pid !== undefined ? { pid } : {}),
    ...(lastExitCode !== undefined ? { lastExitCode } : {}),
  };
}

async function collectDistMarkers(): Promise<HealthInput['distMarkers']> {
  const cli = await readFile(await resolveInstalledCliPath(), 'utf8').catch(() => '');
  return {
    obsidianModeLogged: cli.includes('obsidianMcpEnabled'),
    newChatAllowlisted: cli.includes('new-chat-allowlisted'),
  };
}

export async function resolveInstalledCliPath(entry: string = process.argv[1] ?? ''): Promise<string> {
  const resolved = await realpath(entry).catch(() => entry);
  if (resolved.endsWith('/bin/feishu-codex-bridge.mjs')) {
    return join(dirname(dirname(resolved)), 'dist', 'cli.js');
  }
  return resolved;
}

function guiTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new Error('cannot resolve uid for launchctl gui target');
  return `gui/${uid}`;
}

function numberFromLine(text: string, pattern: RegExp): number | undefined {
  const m = pattern.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function stringFromLine(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

async function run(
  command: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const finalCode = code ?? 0;
      if (finalCode !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${finalCode}`));
        return;
      }
      resolve({ code: finalCode, stdout, stderr });
    });
  });
}
