import { undot } from "./src/undot.js";
import { withTypeCheckers } from "with-type-checkers";
import { pathToFileURL } from 'node:url';
import repl from "node:repl";
import path from "node:path";


const UNIT = Symbol('UNIT');
class UnitContext extends withTypeCheckers({
  classPrefix: '[MLM]',
  instancePrefix: (it) => `[${it[UNIT]}]`,
}) {
  constructor(name) {
    super();
    this[UNIT] = name;
  }
}


export default ({
  import: importModule = (p) => import(p),
  resolveModule = (n) => pathToFileURL(`./units/${n}.js`).href
}) => new MLM({
  importModule,
  resolveModule
});

class MLM extends withTypeCheckers({
  classPrefix: '[MLM Core]'
}) {


  #importModule;
  #resolveModule;
  constructor({ importModule, resolveModule }) {
    super();
    this.#importModule = importModule;
    this.#resolveModule = resolveModule;
    Object.defineProperties(this.#context, {
      'import': {
        get: () => this.#importModule,
        enumerable: true,
        configurable: false
      }, register: {
        get: () => this.#register,
        enumerable: true,
        configurable: false
      }
    });
  }

  #context = {}
  get context() {
    return this.#context
  }

  #createUnitContext = (name) => {
    const ctx = new UnitContext(name);
    return new Proxy({}, {
      get: (target, prop) => ctx[prop] ?? this.#context[prop],
      set: (target, prop, value) => {
        this.throw('Cannot set context property ' + prop);
      },
    });
  };

  units = {};
  #onStart = [];
  #onStop = [];
  #onShutdown = [];
  #state = 'idle'

  start = async (config) => {
    this.log('Starting...');
    this.assert(this.#state == 'idle', 'Busy.');
    this.#state = 'starting';
    for (const fn of this.#onStart) await fn(config);
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
    for (const fn of this.#onStop) await fn();
    this.#state = 'shutdown';
    for (const fn of this.#onShutdown) await fn();
    this.#state = 'stopped';
    this.log('Stopped.');
  }

  #defineContextProperty = (name, descriptor) => {
    this.assert(!Object.hasOwn(this.#context, name), `Context property '${name}' already exists in MLM context.`);
    Object.defineProperty(this.#context, name, {
      enumerable: true,
      configurable: false,
      ...descriptor
    });
  }

  #addContextProperty = async (name, value) => {
    this.assert(!Object.hasOwn(this.#context, name), `Context property '${name}' already exists in MLM context.`);
    if (this.is.function(value)) {
      value = await value();
      this.#defineContextProperty(name, {
        get: () => value
      })
    } else if (this.is.object(value)) {
      this.#defineContextProperty(name, value)
    } else {
      this.throw(`Invalid value for context property '${name} - should be caught before reaching here'.`);
    }
  }

  #importUnitWithInfo = async (name) => {
    const modulePath = await this.#resolveModule(name);
    try {
      const module = await this.#importModule(modulePath); // + '?t=' + Date.now() do we need this?;
      const ret = {
        modulePath,
        module,
        unitFactory: module.default
      }
      this.assert(this.is.plainObject(module.info), 'No export info found for unit ' + name + ' at ' + modulePath);
      ret.info = this.#createInfo(module.info);
      return ret;
    } catch (e) {
      this.throw(`Failed to import unit '${name}': ${modulePath} - ${e.message}`);
    }
  }

  #createInfo(info = {}) {
    return {
      requires: info.requires ?? [],
      provides: info.provides ?? [],
      npm: info.npm ?? {},
      description: info.description ?? 'No description provided for ' + name + ' at  ' + modulePath,
      version: null,
      author: null
    }
  }

  #registerLoaders = {
    register: [(name, loader) => {
      this.#register[name] ??= [];
      this.#register[name].push(loader);
    }]
  }
  #register = {}

  #addProcess = (name, loader) => {
    this.#registerLoaders[name] ??= [];
    this.#registerLoaders[name].push(loader);
    this.#register[name] ??= async (conf, unit) => {
      for (const loader of this.#registerLoaders[name]) {
        await loader(conf, unit);
      }
    };
  }
  #installing = new Set();
  #install = async (name) => {
    if (this.units[name]) return; // already installed
    if (this.#installing.has(name)) {
      this.throw(`Cosmic ray: Concurrent install detected for unit '${name}'.`);
    }
    this.#installing.add(name);

    const ctx = this.#createUnitContext(name);
    try {
      let {
        unitFactory,
        module,
        modulePath,
        info
      } = await this.#importUnitWithInfo(name);

      ctx.log(`Installing from ${modulePath}`);
      ctx.assert.is('function|none', unitFactory, 'Module factory');
      const unitConfig = unitFactory ? await unitFactory(ctx) : {};
      ctx.assert.is.object(unitConfig, 'Unit factory return value');

      const unit = this.units[name] = undot(unitConfig);
      unit.info = info;
      unit.module = module;

      Object.defineProperty(unit, 'name', {
        value: name,
        writable: false,
        enumerable: true,
        configurable: false
      })

      ctx.assert.is({
        // used during install
        onBeforeLoad: 'function|none',
        onPrepare: 'function|none',
        define: 'plainObject|none',
        register: 'plainObject|none',
        onReady: 'function|none',
        // used during start
        onStart: 'function|none',
        // used during stop
        onStop: 'function|none',
        onShutdown: 'function|none',
      }, unit, 'Unit config');

      await unit.onBeforeLoad?.(ctx);

      for (const dep of unit.info.requires) {
        if (this.units[dep]) continue;
        if (dep.startsWith('#')) {
          ctx.assert(this.units[dep], `Feature tag ${dep} not found`);
        }
        await this.#install(dep);
      }

      for (const tag of unit.info.provides ?? []) {
        ctx.assert(tag.match(/^#[\w-]+$/), `Invalid feature tag: ${tag}, must be #<tag-name>`);
        ctx.assert.is.undefined(this.units[tag], `Feature tag ${tag} already included by unit ${this.units[tag]?.name}`);
        this.units[tag] = unit;
      }

      await unit.onPrepare?.(ctx);

      for (const key in unit.define ?? {}) {
        ctx.log(`Define context property .${key}`);
        const spec = unit.define[key];
        ctx.assert.is('function|plainObject', spec, `.context.${key}`);
        await this.#addContextProperty(key, spec);
      }
      for (const key in unit.register ?? {}) {
        ctx.assert.is.function(unit.register[key], `.register.${key}`);
        ctx.log(`${!this.#registerLoaders[key] ? 'Processing new' : 'Extending existing'} loader .${key}`);
        this.#addProcess(key, unit.register[key]);
      }
      for (const key in this.#register) {
        if (unit[key]) {
          await this.#register[key](unit[key], unit);
        }
      }
      if (unit.onReady) {
        ctx.log('onReady');
        await unit.onReady?.(ctx);
      }
      unit.onStart && this.#onStart.push(unit.onStart);
      unit.onStop && this.#onStop.push(unit.onStop);
      unit.onShutdown && this.#onShutdown.unshift(unit.onShutdown);
    } catch (err) {
      throw err;
    } finally {
      this.#installing.delete(name);
    }
  }

  analyze = async (name) => {
    const result = {
      units: [],
      tags: {},
      errors: [],
      order: [],
      success: true
    };

    const visited = new Set();
    const installing = new Set();

    const analyzeUnit = async (unitName) => {
      if (visited.has(unitName)) return;
      if (installing.has(unitName)) return;

      installing.add(unitName);
      try {
        const { modulePath, info } = await this.#importUnitWithInfo(unitName);

        for (const dep of info.requires) {
          if (dep.startsWith('#')) {
            if (!result.tags.hasOwnProperty(dep)) {
              result.errors.push(`Missing tag: ${dep} required by ${unitName}`);
              result.success = false;
            }
          } else if (!visited.has(dep)) {
            await analyzeUnit(dep);
          }
        }

        result.units.push({
          name: unitName,
          path: modulePath,
          requires: info.requires,
          provides: info.provides
        });
        result.order.push(unitName);

        for (const tag of info.provides ?? []) {
          result.tags[tag] = unitName;
        }

        visited.add(unitName);

      } catch (error) {
        result.errors.push(`Failed to analyze ${unitName}: ${error.message}`);
        result.success = false;
      } finally {
        installing.delete(unitName);
      }
    };

    await analyzeUnit(name);
    return result;
  }
  static create(importer, resolver) {
    return new MLM(importer, resolver);
  }

  static async start(name) {
    const mlm = new MLM();
    mlm.start(name);
    return mlm;
  }

  repl(ctx = {}, { screen = false } = {}) {
    this.log('Welcome to MLM REPL');
    return new Promise((resolve) => {
      if (screen) {
        process.stdout.write('\x1B[?1049h');
      }
      const r = repl.start({
        prompt: 'mlm > ',
        useGlobal: false,
        useColors: true,
        ignoreUndefined: true
      });
      //r.context = new VMCtx(r.context);
      r.setupHistory(path.join(process.cwd(), '.mlm-repl-history'), () => { });

      Object.assign(r.context, ctx, this.context, { process, global, console });
      r.context.mlmInstance = this;
      r.context.mlm = this.context;

      // wait until the repl truly closes
      r.on('exit', () => {
        if (screen) process.stdout.write('\x1B[?1049l')
        resolve();
      });
    });
  }
}
