/// 发不出去分两种：一种值得再试一次，一种再试也没用。
///
/// 网络没连上（fetch 直接抛 TypeError）、网关超时（502/503/504）都是“这一刻没送到”，
/// 语音还挂在草稿里，重试是对的；400 类是这条消息本身不合法，重试只会重复报错。
export function retryableSubmitFailure(error: unknown): boolean {
  if (typeof TypeError !== "undefined" && error instanceof TypeError) return true
  const status = (error as { status?: unknown } | null)?.status
  return status === 502 || status === 503 || status === 504
}

/// 三次机会，间隔拉长，别在断网时把手机当暖手宝用。
export function submitRetryDelay(attempt: number): number {
  return Math.min(15_000, 1500 * 2 ** attempt)
}
