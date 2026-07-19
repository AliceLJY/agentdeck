export function resolveServerHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.CC_TERMINAL_HOST?.trim() || '127.0.0.1';
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}
