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