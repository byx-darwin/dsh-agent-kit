/**
 * 让 `promise` 与 `signal` 竞争：signal 先中止时以 `onAbort()` 的错误 reject。
 * 任一方结束后移除监听，不留下悬挂的 rejection。
 */
export function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal, onAbort: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(onAbort())
      return
    }
    const listener = () => reject(onAbort())
    signal.addEventListener('abort', listener, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', listener)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', listener)
        reject(err)
      },
    )
  })
}
