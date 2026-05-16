/**
 * 全局单队列：LabVIEW COM 自动化串行化门卫
 *
 * ## 设计背景
 *
 * LabVIEW Application COM 对象运行在 **COM STA（单线程公寓）** 模型下，
 * 不支持多线程并发访问。若同时有两个 VI 编辑会话向同一 LabVIEW 实例发起
 * COM 调用（例如同时读取属性或导出面板图），后者必须等待前者完成后才能执行，
 * 否则会引发访问冲突或返回错误结果。
 *
 * `LabVIEWAutomationGate` 通过 Promise 链将所有 COM 调用串行化：
 * 新提交的操作始终追加在上一个操作之后，无论上一个操作成功还是失败，
 * 后续操作都会继续执行（`chain.then(run, run)` 保证了这一点）。
 *
 * ## 典型延迟特征（供参考，因机器性能而异）
 *
 * | 操作类型        | 估算耗时   |
 * |----------------|-----------|
 * | 读取静态属性    | ~2–5 s    |
 * | 导出面板图像    | ~3–8 s    |
 * | 写入属性        | ~3–10 s   |
 *
 * ## 未来改进方向
 *
 * - **per-App 会话池**：若未来 LabVIEW 版本支持多实例并发，可考虑按
 *   `ApplicationDirectory` 分组，为每个实例维护独立队列，不同版本间并发执行。
 * - **读写分离**：只读操作理论上可并发，写操作需独占锁，可引入读写锁优化吞吐量。
 */
export interface LabVIEWAutomationGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createLabVIEWAutomationGate(): LabVIEWAutomationGate {
  let chain: Promise<void> = Promise.resolve();

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => operation();
      const result = chain.then(run, run);
      chain = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}