const COMMANDS_ALLOWED_BEFORE_MENTION = new Set([
  '/agent',
  '/dispatch',
  '/help',
  '/status',
  '/stop',
  '/timeout',
]);

export function isCommandTextAllowedBeforeMention(content: string): boolean {
  const trimmed = String(content || '').trim();
  if (!trimmed.startsWith('/')) return false;
  const cmd = trimmed.split(/\s+/)[0] ?? '';
  return COMMANDS_ALLOWED_BEFORE_MENTION.has(cmd);
}
