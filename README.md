# MLM Core

A modular loading manager for JavaScript applications that handles interdependent modules with dependency injection, lifecycle management, and implementation tags.

## One-liner
```js
import MLM from 'mlm-core';
const mlm = new MLM(p => import(p));  // importing from your app's directory and node_modules
await mlm.start('app');               // install module from ./modules/app.js including its deps, and start

await mlm.stop();                     // graceful shutdown
```

## Installation
```bash
npm install mlm-core
```

## Basic Usage
```javascript
import MLM from 'mlm-core';

const mlm = new MLM(
  path => import(path),                 // pass your import function
  (name) => `./my-modules/\${name}.js`  // resolve your module names to paths, defaults to `./modules/\${name}.js`
);

// single module
await mlm.install('cache');
mlm.start('cache');

// or start many at once
mlm.start('api', 'auth', 'worker');

// graceful stop (calls onStop → onTeardown in reverse order)
await mlm.stop();
```

## Module Contract
A module **must** export a factory function that receives a context proxy and returns a plain object:

```javascript
export default function(ctx) {
  return {
    // 1. dependencies
    requires: ['logger'],          // other modules or #tags

    // 2. implementation tags this module provides
    implements: ['#cache'],

    // 3. values published to the shared context (after deps load)
    define: {
      cache: () => new Map(),      // function → result is frozen
      'config.ttl': () => 300      // dotted keys are flattened
    },

    // 4. custom loaders (optional)
    loaders: { /* see below */ },

    // 5. lifecycle hooks (optional)
    onBeforeLoad, onPrepare, onReady, onStart, onStop, onTeardown
  };
}
```
## Context proxy
The factory receives one argument, `ctx`, which is a Proxy that:

* merges the shared MLM context (`ctx.logger`, `ctx.db` …)  
* adds module-scoped helpers:  
  - `ctx.assert.*` – runtime type checkers  
  - `ctx.log(...)` – prefixed logger (`[moduleName] ...`)  
  - `ctx.import(spec)` – **guaranteed to resolve from the application’s node_modules** (same function you passed as `importModule`)

`ctx` is already in the factory’s closure, so you do **not** need to pass it around inside the module:

```js
export default ctx => ({
  define: {
    api: () => new Api({ db: ctx.db, log: ctx.log }) // ctx just works
  }
});
```
Only forward ctx to outside helpers or split files when the factory becomes too large to keep readable.

### Field details
| Field        | Type       | Description |
|--------------|------------|-------------|
| **requires** | string[]   | Module names or `#tags` that must be installed first |
| **implements** | string[] | Tags (must start with `#`) this module satisfies |
| **define**   | object     | Keys become `ctx.key` for every later module. Value must be a function (called with ctx) whose return is frozen |
| **loaders**  | object     | Map `propertyName → async fn(value)` run on every installed module that owns that property |
| **lifecycle** | functions | Hooks run in dependency order (reverse for teardown). All may be async. |

## Implementation Tags
Tags let you swap implementations without touching consumers.

**Interface module** (optional, only documents the contract):
```javascript
export default () => ({
  implements: ['#storage'],
  define: {
    storage: () => ({
      get: () => { throw new Error('unimplemented') },
      set: () => { throw new Error('unimplemented') }
    })
  }
});
```

**Two implementations**:
```javascript
// memory-storage.js
export default () => ({
  implements: ['#storage'],
  define: { storage: () => new Map() }
});

// redis-storage.js
export default async (ctx) => {
  const client = createRedisClient(); await client.connect();
  return {
    implements: ['#storage'],
    define: { storage: () => client }
  };
};
```

**Consumer** (depends on **any** implementation):
```javascript
export default (ctx) => ({
  requires: ['#storage'],
  onReady() {
    ctx.storage.set('k', 'v'); // works with either impl
  }
});
```

Duplicate tags throw at install time – you can only register one provider per tag.

## Custom Loaders
Register processors that other modules can use declaratively:

**router-loader.js**
```javascript
export default (ctx) => ({
  requires: ['express'],
  loaders: {
    routes: async (routes) => {
      for (const [path, handler] of Object.entries(routes)) {
        ctx.express.app.get(path, handler);
      }
    }
  }
});
```

**api.js**
```javascript
export default () => ({
  requires: ['router-loader'],
  routes: {                 // will be processed by the loader above
    '/health': (req, res) => res.send('ok')
  }
});
```

Loaders run **after** `define` and **before** `onReady`.

## Lifecycle Hooks
Exact order per module:

1. factory called → config validated  
2. `onBeforeLoad(ctx)`  
3. dependencies installed recursively  
4. tag registered  
5. `onPrepare(ctx)`  
6. `define` properties created  
7. loaders executed  
8. `onReady(ctx)`  
9. module marked installed  

During **start** (in install order):  
`onStart(ctx)` for every module  

During **stop**:
1. `onStop(ctx)` in install order
2. `onTeardown(ctx)` in **reverse** order (may be async)

All hooks are optional; only the first argument (context proxy) is supplied.

## API Reference

### new MLM(importModule, resolveModule)
- **importModule**: `async (fullPath) => moduleDefault`
- **resolveModule**: `(name) => absoluteOrRelativePath`

### Instance methods
| Method           | Description |
|------------------|-------------|
| **install(name)** | Promise, idempotent, recursive. *You rarely need to call this directly.* |
| **start(...names)** | Installs if needed, then starts in dependency order |
| **stop()** | Promise, runs onStop → onTeardown(reverse) |

### Instance properties
| Property  | Type     | Description |
|-----------|----------|-------------|
| modules   | object   | Map `name → moduleConfig` (read-only) |

## Error Handling
Runtime type checks are performed via `with-type-checkers`.  
Duplicate modules, missing dependencies, bad tags, or wrong field types throw descriptive errors prefixed with `[MLM]` or `[moduleName]`.  
Fail-fast is intentional: an exception in any module factory or lifecycle hook terminates the process.

## Environment Composition Example
```javascript
// app-dev.js  (memory cache + sqlite)
export default () => ({
  requires: ['cache-memory', 'db-sqlite', 'app-core']
});

// app-prod.js (redis cache + postgres)
export default () => ({
  requires: ['cache-redis', 'db-postgres', 'app-core']
});
```
Start the flavour you need: `mlm.start('app-prod')`.

## TypeScript
No built-in definitions yet; add
```ts
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
```

## License
LGPL-3.0-or-later
