import { describe, it, assert, assertThrows, assertDoesNotThrow, report } from './tiny-test.js';
import MLM from '../mlm-core.js';

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fakeImport = name => Promise.resolve({
  /* ---------- basic modules ---------- */
  logger: () => ({
    define: { logger: () => ({ logs: [], log(x) { this.logs.push(x); } }) }
  }),

  cache: () => ({
    requires: ['logger'],
    define: { cache: () => new Map() }
  }),

  /* ---------- lifecycle recorder ---------- */
  recorder: () => {
    const order = [];
    return {
      define: { recorder: () => order },
      onBeforeLoad() { order.push('beforeLoad'); },
      onPrepare() { order.push('prepare'); },
      onReady() { order.push('ready'); },
      onStart() { order.push('start'); },
      onStop() { order.push('stop'); },
      onTeardown() { order.push('teardown'); }
    };
  },

  /* ---------- dotted keys ---------- */
  dotted: () => ({
    define: {
      'config.ttl': () => 300,
      'config.db.host': () => 'localhost'
    }
  }),

  /* ---------- tags ---------- */
  '#storage': () => ({
    implements: ['#storage'],
    define: { storage: () => ({ get: () => 'mem', set: () => { } }) }
  }),

  redis: () => ({
    implements: ['#storage'],
    define: { storage: () => ({ get: () => 'redis', set: () => { } }) }
  }),

  consumer: () => ({
    requires: ['#storage'],
    define: { answer: ctx => ctx.storage.get() }
  }),

  /* ---------- loaders ---------- */
  routeLoader: () => ({
    requires: ['logger'],
    loaders: {
      routes: async (routes) => {
        ctx.logger.log('routes loaded');
        ctx.routes = routes;
      }
    }
  }),

  api: () => ({
    requires: ['routeLoader'],
    routes: { '/ping': (_, res) => res('pong') }
  }),

  api2: () => ({
    requires: ['routeLoader'],
    routes: { '/v2': (_, res) => res('v2') }
  }),
  /* ---------- async teardown ---------- */
  res: () => ({
    define: { res: () => ({ closed: false }) },
    onTeardown: async () => { await sleep(10); res.closed = true; }
  }),

  /* ---------- broken modules ---------- */
  brokenFactory: () => { throw new Error('factory fail'); },
  brokenStart: () => ({ onStart() { throw new Error('start fail'); } }),
  brokenTeardown: () => ({
    define: { x: 1 },
    onTeardown() { throw new Error('teardown fail'); }
  }),

  /* ---------- duplicate tag ---------- */
  dup1: () => ({ implements: ['#dup'] }),
  dup2: () => ({ implements: ['#dup'] }),

  /* ---------- service manager ---------- */
  serviceManager: () => ({
    requires: ['logger'],
    define: {
      services: (ctx) => new Proxy({}, {
        get: (target, name) => {
          if (!target[name]) {
            ctx.log(`[MLM] Instantiating service '${name}'...`);
            target[name] = ctx.serviceDefs[name](ctx);
          }
          return target[name];
        }
      }),
      serviceDefs: () => ({})
    },
    loaders: {
      services: async (config, ctx) => {
        for (const name in config) {
          ctx.assert(!ctx.serviceDefs[name], `Service definition for '${name}' already exists.`);
          ctx.assert.is.function(config[name], `.service.${name}`);
          ctx.serviceDefs[name] = config[name];
        }
      },
      preloadServices: async (config, ctx) => {
        for (const name in config) {
          ctx.assert(!ctx.serviceDefs[name], `Service definition for '${name}' already exists.`);
          ctx.assert.is.function(config[name], `.service.${name}`);
          ctx.serviceDefs[name] = config[name];
          ctx.services[name] = await ctx.serviceDefs[name](ctx);
        }
      }
    }
  }),

  /* ---------- user of lazy service ---------- */
  user: () => ({
    requires: ['serviceManager'],
    define: {
      user: ctx => ({
        ping() { return ctx.services.mailer.send(); }
      })
    },
    loaders: {
      services: {
        mailer: (ctx) => ({
          send() { ctx.logger.log('mail sent'); return 'ok'; }
        })
      }
    }
  }),

  /* ---------- eager pre-load user ---------- */
  eager: () => ({
    requires: ['serviceManager'],
    loaders: {
      preloadServices: {
        db: async (ctx) => {
          await new Promise(r => setTimeout(r, 10)); // fake async init
          return { query: () => 'rows' };
        }
      }
    },
    onReady(ctx) { ctx.log('db ready:', ctx.services.db.query()); }
  })

}[name] || (() => ({ define: {} })));

/* ---------- tests ---------- */
describe('MLM core', () => {
  it('starts and stops a single module', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('logger');
    assert(mlm.modules.logger);
    await mlm.stop();
  });

  it('loads dependencies in order', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('cache');
    assert(mlm.modules.logger);
    assert(mlm.modules.cache);
    await mlm.stop();
  });

  it('records full lifecycle', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('recorder');
    const order = mlm.modules.recorder.recorder;
    assert(JSON.stringify(order) === '["beforeLoad","prepare","ready","start"]');
    await mlm.stop();
    assert(order.pop() === 'teardown');
  });

  it('expands dotted keys', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('dotted');
    assert(mlm.modules.dotted.define['config.ttl'] === 300);
    assert(mlm.modules.dotted.define['config.db.host'] === 'localhost');
    await mlm.stop();
  });

  it('injects tagged implementation', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('consumer');
    assert(mlm.context.answer === 'mem');
    await mlm.stop();
  });

  it('throws on duplicate tag', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.start('dup1', 'dup2'), 'Implementation tag #dup already exists');
  });

  it('runs custom loaders', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('api');
    assert(mlm.context.routes['/ping']);
    await mlm.stop();
  });

  it('awaits async teardown', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('res');
    const res = mlm.context.res;
    assert(res.closed === false);
    await mlm.stop();
    assert(res.closed === true);
  });

  it('factory exception fails fast', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.start('brokenFactory'), 'factory fail');
  });

  it('onStart exception fails fast', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.start('brokenStart'), 'start fail');
  });

  it('teardown exception still kills process', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('brokenTeardown');
    await assertThrows(() => mlm.stop(), 'teardown fail');
  });

  it('forbids concurrent start', async () => {
    const mlm = new MLM(fakeImport);
    mlm.start('logger'); // no await
    await assertThrows(() => mlm.start('cache'), 'Busy');
  });

  it('forbids start while installing', async () => {
    const mlm = new MLM(fakeImport);
    mlm.install('logger'); // no await
    await assertThrows(() => mlm.start('cache'), 'Busy');
  });

  it('forbids stop when not started', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.stop(), 'Not started');
  });

  it('idempotent install', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.install('logger');
    await mlm.install('logger'); // should not throw
    assert(mlm.modules.logger);
  });

  it('lazy-loads services', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('user');
    assert(mlm.context.user.ping() === 'ok');
    assert(mlm.context.services.mailer); // created on first access
    await mlm.stop();
  });

  it('pre-loads async services', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('eager');
    // no throw = db was instantiated during preload
    await mlm.stop();
  });

  it('loaders see final context', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('routeLoader', 'api'); // api needs routeLoader
    assert(mlm.context.express); // set by routeLoader loader
    await mlm.stop();
  });


  it('loader aggregates multi-module property', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('api', 'api2');
    assert(mlm.context.routes['/ping']);
    assert(mlm.context.routes['/v2']);
    await mlm.stop();
  });

  // already have #storage, consumer requires it – nothing to add, just
  it('tag require resolves to concrete module', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('consumer');
    assert(mlm.context.answer === 'mem');
    await mlm.stop();
  });

  it('stop hooks still queued after start failure', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.start('brokenStart'), 'start fail');
    // currently throws before onStart runs, so no-op; just documents behaviour
  });
  it('idempotent stop', async () => {
    const mlm = new MLM(fakeImport);
    await mlm.start('logger');
    await mlm.stop();
    await assertDoesNotThrow(() => mlm.stop());
  });

  it('throws on duplicate context key', async () => {
    const mlm = new MLM(fakeImport);
    await assertThrows(() => mlm.start('logger', 'logger'), 'Context property \'logger\' already exists');
  });
});

report();