import { spawnSync } from 'node:child_process';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

const APPROVAL_BRIDGE_DIR =
  process.env.FEISHU_APPROVAL_BRIDGE_DIR ||
  '/Users/lihuarong/Documents/Codex/2026-05-30/new-chat/outputs/feishu-approval-bridge';
const APPROVAL_BRIDGE_ENV =
  process.env.FEISHU_APPROVAL_BRIDGE_ENV || `${APPROVAL_BRIDGE_DIR}/feishu-approval.env`;

interface ApprovalDecision {
  approvalId: string;
  decision: 'approve' | 'reject';
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeDecision(value: unknown): ApprovalDecision['decision'] | '' {
  const text = String(value || '').trim().toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted', 'acceptforsession', 'yes', 'y', '确认', '同意', '批准', '通过'].includes(text)) {
    return 'approve';
  }
  if (['reject', 'rejected', 'decline', 'declined', 'deny', 'denied', 'cancel', 'canceled', 'cancelled', 'no', 'n', '拒绝', '驳回', '取消', '不通过'].includes(text)) {
    return 'reject';
  }
  return '';
}

function resolvePayload(payload: Record<string, unknown>): ApprovalDecision | undefined {
  let approvalId = firstNonEmpty(payload.approval_id, payload.id);
  let decision = normalizeDecision(firstNonEmpty(payload.decision, payload.action, payload.cmd));
  if (!approvalId && String(payload.kind || '').trim() === 'request_respond') {
    approvalId = firstNonEmpty(payload.request_id);
  }
  if (!decision) {
    decision = normalizeDecision(firstNonEmpty(payload.request_option_id, payload.option_id));
  }
  if (!approvalId.startsWith('appr_') || !decision) return undefined;
  return { approvalId, decision };
}

export function parseApprovalTextMessage(text: string): ApprovalDecision | undefined {
  const raw = String(text || '').trim();
  const match =
    /^(确认|同意|批准|通过|approve|approved|accept|accepted|yes|y|拒绝|驳回|reject|rejected|decline|declined|deny|denied|no|n)\s*(appr_[A-Za-z0-9_-]+)\s*$/i.exec(raw);
  if (!match) return undefined;
  const decision = normalizeDecision(match[1]);
  const approvalId = match[2] || '';
  if (!approvalId || !decision) return undefined;
  return { approvalId, decision };
}

function runDecision(approvalId: string, decision: ApprovalDecision['decision'], source: string, actor: string): {
  ok: boolean;
  status: string;
  error: string;
} {
  const args = [
    'approval_bridge.py',
    '--env-file',
    APPROVAL_BRIDGE_ENV,
    '--decide',
    decision,
    '--approval-id',
    approvalId,
    '--source',
    source,
  ];
  if (actor) args.push('--actor', actor);
  const result = spawnSync('python3', args, {
    cwd: APPROVAL_BRIDGE_DIR,
    encoding: 'utf8',
    timeout: 20_000,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) as Record<string, unknown> : {};
  } catch {
    parsed = {};
  }
  return {
    ok: !result.error && result.status === 0,
    status: String(parsed.status || ''),
    error: String(parsed.error || result.stderr || result.error || '未知错误'),
  };
}

function replyText(result: { ok: boolean; status: string; error: string }, approvalId: string): string {
  if (result.ok) {
    if (result.status === 'approved') return `已确认：${approvalId}`;
    if (result.status === 'rejected') return `已拒绝：${approvalId}`;
    return `已处理：${approvalId}`;
  }
  return `授权未生效：${result.error.slice(0, 300)}`;
}

export async function tryHandleApprovalTextMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
): Promise<boolean> {
  const parsed = parseApprovalTextMessage(msg.content);
  if (!parsed) return false;
  const result = runDecision(parsed.approvalId, parsed.decision, 'feishu_private_chat', msg.senderId || '');
  log.info('intake', 'approval-text-decision', {
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    actor: msg.senderId ? msg.senderId.slice(-6) : '',
    ok: result.ok,
    status: result.status,
    error: result.ok ? '' : result.error.slice(0, 200),
  });
  try {
    await channel.send(msg.chatId, { markdown: replyText(result, parsed.approvalId) }, { replyTo: msg.messageId });
  } catch (err) {
    log.fail('intake', err, { step: 'approval-text-reply', approvalId: parsed.approvalId });
  }
  return true;
}

export async function tryHandleApprovalCardAction(
  payload: Record<string, unknown>,
  deps: { channel: LarkChannel; evt: CardActionEvent },
): Promise<boolean> {
  const parsed = resolvePayload(payload);
  if (!parsed) return false;
  const actor = deps.evt.operator?.openId || '';
  const result = runDecision(parsed.approvalId, parsed.decision, 'feishu_card_action', actor);
  log.info('cardAction', 'approval-decision', {
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    actor: actor ? actor.slice(-6) : '',
    ok: result.ok,
    status: result.status,
    error: result.ok ? '' : result.error.slice(0, 200),
  });
  try {
    await deps.channel.send(
      deps.evt.chatId,
      { markdown: replyText(result, parsed.approvalId) },
      { replyTo: deps.evt.messageId },
    );
  } catch (err) {
    log.fail('cardAction', err, { step: 'approval-card-reply', approvalId: parsed.approvalId });
  }
  return true;
}
