
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
) => class MLM extends withTypeCheckers({
  classPrefix: '[MLM]'
}) {

  #context = { import: importModule }

  #createModuleContext = (name) => {
    const ctx = new ModuleContext(name);
    return new Proxy({}, {
      get: (target, prop) => ctx[prop] ?? this.#context[prop]
    });
  };

  #busy = false;
  #loaders = {}
  modules = {};
  #start = [];
  #stop = [];
  #teardown = [];

  start = async (...names) => {
    this.assert(!this.#busy, 'Cannot start while busy. Did you forget to await?');
    for (const name of names) await this.install(name);
    this.#busy = true;
    for (const fn of this.#start) await fn();
    this.log('Started.');
    this.#busy = false;
  }

  install = async (name) => {
    this.assert(!this.#busy, 'Cannot install while busy. Did you forget to await?');
    this.#busy = true;
    await this.#install(name);
    this.#busy = false;
  }

  stop = async () => {
    this.assert(!this.#busy, 'Cannot stop while busy. Did you forget to await?');
    this.#busy = true;
    for (const fn of this.#stop) await fn();
    for (const fn of this.#teardown) await fn();
    this.#busy = false;
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
    const modulePath = resolveModule(name); // modulePath is now [location, name.js]

    const moduleFactory = await importModule(modulePath);
    ctx.assert.is.function(moduleFactory, 'Module factory');

    const moduleConfig = await moduleFactory(ctx);
    ctx.assert.is.object(moduleConfig, 'Module factory return value');

    const module = undot(moduleConfig); // resolve dotted properties in the module object
    module.name = name;
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
        await this.#loaders[key](module[key]);
      }
    }
    await module.onReady?.(ctx);
    module.onStart && this.#start.push(module.onStart.bind(ctx, ctx));
    module.onStop && this.#stop.push(module.onStop.bind(ctx, ctx));
    module.onTeardown && this.#teardown.unshift(module.onTeardown.bind(ctx, ctx));
  }
}
