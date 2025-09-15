
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
  resolveModule= (n) => pathToFileURL(`./modules/${n}.js`).href
) => new class MLM extends withTypeCheckers({
  classPrefix: '[MLM]'
}) {

  #context = { import: importModule }

  #contextProxy = new Proxy({}, {
    get: (target, prop) => this.#context[prop]
  })

  get context() {
    return this.#contextProxy;
  }

  #createModuleContext = (name) => {
    const ctx = new ModuleContext(name);
    return new Proxy({}, {
      get: (target, prop) => ctx[prop] ?? this.#context[prop]
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
      value: value,
      writable: false,
      enumerable: true,
      configurable: false
    });
  }

  #install = async (name) => {
    if (this.modules[name]) return; // already installed/installing
    const ctx = this.#createModuleContext(name);
    const modulePath = await resolveModule(name); // resolve module path with the supplied resolver
    const moduleFactory = await importModule(modulePath); // import module with the supplied importer
    ctx.assert.is.function(moduleFactory, 'Module factory');

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

    ctx.assert.is.array(module.requires, '.requires');

    ctx.assert.is('array|undefined', module.implements);
    ctx.assert.is('function|undefined', module.onBeforeLoad, '.onBeforeLoad');
    ctx.assert.is('function|undefined', module.onPrepare, '.onPrepare');
    ctx.assert.is('function|undefined', module.onReady, '.onReady');
    ctx.assert.is('function|undefined', module.onStart, '.onStart');
    ctx.assert.is('function|undefined', module.onStop, '.onStop');
    ctx.assert.is('function|undefined', module.onTeardown, '.onTeardown');
    ctx.assert.is('plainObject|undefined', module.define, '.define');
    ctx.assert.is('plainObject|undefined', module.loaders, '.loaders');

  

    await module.onBeforeLoad?.(ctx);
    for (const dep of module.requires) await this.#install(dep);

    for (const imp of module.implements ?? []) {
      ctx.assert(imp.match(/^#[\w-]+$/), `Invalid implementation tag: ${imp}, must be #<tag-name>`);
      ctx.assert.is.undefined(this.modules[imp], `Implementation tag ${imp} already exists`);
      this.modules[imp] = module;
    }

    await module.onPrepare?.(ctx);

    for (const key in module.define ?? {}) {
      const spec = module.define[key];
      ctx.assert.is('function|plainObject', spec, `.context.${key}`);
      await this.#addContextProperty(key, spec);
      ctx.log(`Defined context property .${key}`);
    }
    for (const key in module.loaders ?? {}) {
      ctx.assert.is.function(module.loaders[key], `.loaders.${key}`);
      this.#loaders[key] = module.loaders[key];
    }
    for (const key in this.#loaders) {
      if (module[key]) {
        await this.#loaders[key](module[key], module);
      }
    }
    await module.onReady?.(ctx);
    module.onStart && this.#start.push(module.onStart.bind(ctx, ctx));
    module.onStop && this.#stop.push(module.onStop.bind(ctx, ctx));
    module.onTeardown && this.#teardown.unshift(module.onTeardown.bind(ctx, ctx));
  }

  static create(importer, resolver) {
    return new MLM(importer, resolver);
  }

  static async start(name) {
    const mlm = new MLM();
    mlm.start(name);
    return mlm;
  }
}
