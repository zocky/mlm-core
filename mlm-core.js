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
    this.#addLoader('define', async (conf, unit) => {
      for (const key in conf) {
        const spec = conf[key];
        this.assert.is('function|plainObject', spec, `.define.${key}`);
        await this.#addContextProperty(key, spec);
      }
    });
  }

  #context = {}
  get context() {
    return this.#context
  }

  #createUnitContext = async (name, info) => {
    const ctx = new UnitContext(name);
    ctx.packages = {};
    for (const pkg in info.packages) {
      ctx.packages[pkg] = await this.#importModule(info.packages[pkg]);
    }
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
      const module = await this.#importModule(modulePath);
      const ret = {
        modulePath,
        module,
        unitFactory: module.default
      }
      this.assert(this.is.plainObject(module.info), 'No export info found for unit ' + name + ' at ' + modulePath);
      ret.info = this.#createInfo(module.info,name,modulePath);
      return ret;
    } catch (e) {
      this.throw(`Failed to import unit '${name}': ${modulePath} - ${e.message}`);
    }
  }

  #createInfo(info = {}, name, modulePath) {
    if (info.packages) {
      let packages = {}
      for (const dep of [].concat(info.packages)) {
        if (typeof dep === 'string') {
          packages[dep] = dep;
        } else {
          Object.assign(packages, dep);
        }
      }
      info.packages = packages
    }
    return {
      requires: info.requires ?? [],
      provides: info.provides ?? [],
      packages: info.packages ?? {},
      description: info.description ?? 'No description provided for ' + name + ' at  ' + modulePath,
      version: null,
      author: null
    }
  }

  #registeredInjectors = {}
  #registeredLoaders = {}

  #addLoader = (name, loader) => {
    this.#registeredLoaders[name] ??= [];
    this.#registeredLoaders[name].push(loader);
  }
  #installing = new Set();
  #install = async (name) => {
    if (this.units[name]) return; // already installed
    if (this.#installing.has(name)) {
      this.throw(`Cosmic ray: Concurrent install detected for unit '${name}'.`);
    }
    this.#installing.add(name);

    try {
      let {
        unitFactory,
        module,
        modulePath,
        info
      } = await this.#importUnitWithInfo(name);
      const ctx = await this.#createUnitContext(name, info);

      ctx.log(`Installing from ${modulePath}`);
      ctx.assert.is('function|none', unitFactory, 'Module factory');
      const unitConfig = unitFactory ? await unitFactory(ctx) : {};
      ctx.assert.is.object(unitConfig, 'Unit factory return value');

      const unit = this.units[name] = undot(unitConfig); // deepen dot notated object
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
        inject: 'plainObject|none',
        register: 'plainObject|none',
        onReady: 'function|none',
        // used during start
        onStart: 'function|none',
        // used during stop
        onStop: 'function|none',
        onShutdown: 'function|none',
      }, unit, 'Unit config');

      await unit.onBeforeLoad?.();



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

      await unit.onPrepare?.();

      const layers = [unit];

      for (const key in unit.inject) {
        ctx.assert(!(key in this.#registeredInjectors), 'Duplicate injector key ' + key);
        this.#registeredInjectors[key] = unit.inject[key];
      }
      for (const key in this.#registeredInjectors) {
        const conf = unit[key];
        if (conf) {
          const inject = await this.#registeredInjectors[key](conf, unit);
          inject && layers.push(undot(inject));
        }
      }

      for (const conf of layers) {
        for (const key in conf.register) {
          this.#addLoader(key, conf.register[key], unit);
        }
      }
      for (const key in this.#registeredLoaders) {
        for (const conf of layers) {
          if (conf[key]) {
            for (const loader of this.#registeredLoaders[key]) {
              ctx.log(`Processing loader [${unit.name}] ${key}: ${Object.keys(conf[key])}`);
              await loader(conf[key], unit);
            }
          }
        }
      }
      for (const layer of layers) {
        if (layer.onReady) {
          ctx.log('onReady');
          await layer.onReady?.();
        }
      }

      this.#onStart.push(...layers.map(layer=>layer.onStart).filter(Boolean));
      this.#onStop.push(...layers.map(layer=>layer.onStop).filter(Boolean));
      this.#onShutdown.unshift(...layers.map(layer=>layer.onShutdown).filter(Boolean));
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
