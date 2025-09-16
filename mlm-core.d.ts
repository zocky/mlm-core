declare module 'mlm-core' {
  export default class MLM {
    constructor(
      importModule: (path: string) => Promise<any>,
      resolveModule: (name: string) => Promise<string>
    );
    install(name: string): Promise<void>;
    start(...names: string[]): Promise<void>;
    stop(): Promise<void>;
    readonly modules: Record<string, any>;
  }
}