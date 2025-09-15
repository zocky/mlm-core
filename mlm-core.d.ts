declare module 'mlm-core' {
  export default class MLM {
    constructor(
      importModule: (path: string) => Promise<any>,
      resolveModule: (name: string) => string
    );
    import(name: string): Promise<void>;
    install(name: string): Promise<void>;
    start(...names: string[]): void;
    stop(): Promise<void>;
    readonly modules: Record<string, any>;
  }
}