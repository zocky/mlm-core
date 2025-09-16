import { undot } from "./src/undot.js";
import { withTypeCheckers } from "with-type-checkers";
import { pathToFileURL } from 'node:url';


const ModuleContext = withTypeCheckers(class ModuleContext {
  constructor(name) {
    this.moduleName = name;
  }
}, {
  classPrefix: '[MLM]',
  instancePrefix: (it) => '[' + it.moduleName + ']'
})


export default (
  importModule,
  resolveModule = (n) => pathToFileURL(`./modules/${n}.js`).href
) => new MLM({
  importModule,
  resolveModule
});


class MLM extends withTypeCheckers() {
  constructor({ importModule, resolveModule }) {
    super();
    this.importModule = importModule;
    this.resolveModule = resolveModule;
    Object.defineProperty(this.#context, 'import', {
      get: () => this.importModule,
      enumerable: true,
      configurable: false
    });
  }

  #context = {}
  get context() {
    return this.#context
  }

  #createModuleContext = (name) => {
    const ctx = new ModuleContext(name);
    return new Proxy({}, {
      get: (target, prop) => ctx[prop] ?? this.#context[prop],
      set: (target, prop, value) => {
        this.throw('Cannot set context property ' + prop);
      },
    });
  };

  #loaders = {}
  modules = {};
  #start = [];
  #stop = [];
  #teardown = [];
  #state = 'idle'

  start = async (...names) => {
    this.assert(this.#state == 'idle', 'Busy.');
    for (const name of names) await this.install(name);
    // sanity check
    this.assert(this.#state == 'idle', 'Unexpected state ' + this.#state);
    this.#state = 'starting';
    for (const fn of this.#start) await fn();
    this.#state = 'started';
  }

  install = async (name) => {
    this.assert(this.#state == 'idle', 'Busy.');
    this.#state = 'installing';
    await this.#install(name);
    this.#state = 'idle';
  }

  stop = async () => {
    this.assert(this.#state == 'started', 'Not started.');
    this.#state = 'stopping';
    for (const fn of this.#stop) await fn();
    this.#state = 'teardown';
    for (const fn of this.#teardown) await fn();
    this.#state = 'stopped';
    this.log('Stopped.');
  }

  #addContextProperty = async (name, value) => {
    this.assert(!Object.hasOwn(this.#context, name), `Context property '${name}' already exists in MLM context.`);
    if (this.is.function(value)) {
      value = await value();
    }
    Object.defineProperty(this.#context, name, {
      get: () => value,
      enumerable: true,
      configurable: false
    });
  }

  #install = async (name) => {
    if (this.modules[name]) return; // already installed/installing
    const ctx = this.#createModuleContext(name);
    try {

      const modulePath = await this.resolveModule(name) + '?t=' + Date.now(); // resolve module path with the supplied resolver
      const jsModule = await this.importModule(modulePath); // import module with the supplied importer
      const moduleFactory = jsModule.default;
      ctx.assert.is.function(moduleFactory, 'Module factory');

      ctx.log('Installing');
      const moduleConfig = await moduleFactory(ctx);
      ctx.assert.is.object(moduleConfig, 'Module factory return value');

      const module = undot(moduleConfig); // resolve dotted properties in the module object
      Object.defineProperty(module, 'name', {
        value: name,
        writable: false,
        enumerable: true,
        configurable: false
      })

      this.modules[name] = module; // register module config before loading dependencies

      ctx.assert.is({
        // used during install
        onBeforeLoad: 'function|none',
        requires: ['string'],
        implements: 'array|none',
        onPrepare: 'function|none',
        define: 'plainObject|none',
        loaders: 'plainObject|none',
        onReady: 'function|none',
        // used during start
        onStart: 'function|none',
        // used during stop
        onStop: 'function|none',
        onTeardown: 'function|none',
      }, module, 'Module config');


      await module.onBeforeLoad?.(ctx);
      for (const dep of module.requires) await this.#install(dep);

      for (const imp of module.implements ?? []) {
        ctx.assert(imp.match(/^#[\w-]+$/), `Invalid implementation tag: ${imp}, must be #<tag-name>`);
        ctx.assert.is.undefined(this.modules[imp], `Implementation tag ${imp} already exists`);
        this.modules[imp] = module;
      }

      await module.onPrepare?.(ctx);

      for (const key in module.define ?? {}) {
        ctx.log(`Define context property .${key}`);
        const spec = module.define[key];
        ctx.assert.is('function|plainObject', spec, `.context.${key}`);
        await this.#addContextProperty(key, spec);

      }
      for (const key in module.loaders ?? {}) {
        ctx.assert.is.function(module.loaders[key], `.loaders.${key}`);
        ctx.log(`${!this.#loaders[key] ? 'Registering new' : 'Extending existing'} loader .${key}`);
        this.#loaders[key] ??= [];
        this.#loaders[key].push(module.loaders[key]);
      }
      for (const key in this.#loaders) {
        if (module[key]) {
          for (const loader of this.#loaders[key]) {
            await loader(module[key], module);
          }
        }
      }
      if (module.onReady) {
        ctx.log('onReady');
        await module.onReady?.(ctx);
      }
      module.onStart && this.#start.push(module.onStart.bind(ctx, ctx));
      module.onStop && this.#stop.push(module.onStop.bind(ctx, ctx));
      module.onTeardown && this.#teardown.unshift(module.onTeardown.bind(ctx, ctx));
    } catch (err) {
      ctx.throw(err);
    }
  }

  static create(importer, resolver) {
    return new MLM(importer, resolver);
  }

  static async start(name) {
    const mlm = new MLM();
    mlm.start(name);
    return mlm;
  }

  repl(ctx = {}) {
    console.log('Welcome to MLM REPL');
    return new Promise((resolve) => {
      const r = repl.start({
        prompt: 'mlm> ',
        useColors: true,
        ignoreUndefined: true
      });

      Object.assign(r.context, ctx);
      // expose the public API
      r.context.mlmInstance = this;
      r.context.mlm = this.context;

      // wait until the repl truly closes
      r.on('exit', resolve);
    });
  }
}
