# MLM Core

A lightweight, modular microkernel for building extensible JavaScript applications through dynamic unit loading and dependency injection.

## Overview

MLM Core provides a plugin architecture that allows applications to be composed from independent, reusable units. Each unit can declare dependencies, provide services, and participate in a shared application lifecycle.

## Installation

```bash
npm install mlm-core
```

## Quick Start

```javascript
import mlm from 'mlm-core';

// Create MLM instance
const app = mlm();

// Install and start units
await app.install('database');
await app.install('web-server');
await app.start();
```

## Core Concepts

### Units

Units are modular components that export a factory function and metadata:

```javascript
// units/logger.js
export const info = {
  provides: ['#logging'],
  description: 'Application logging service'
};

export default mlm => ({
  'define.logger': () => ({
    info: (msg) => console.log(`[INFO] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`)
  }),
  onStart: () => mlm.log('Logger started')
});
```

### Dependencies

Units declare what they require and provide:

```javascript
export const info = {
  requires: ['database', '#logging'],  // Install these first
  provides: ['#users'],               // This unit provides user functionality
  description: 'User management service'
};
```

### Context System

The context provides dependency injection between units:

```javascript
export default mlm => ({
  'define.userService': () => ({
    createUser: async (data) => {
      mlm.logger.info('Creating user');
      return mlm.database.users.create(data);
    }
  })
});
```

## API Reference

### MLM Instance

#### `mlm(options?)`

Creates a new MLM instance.

**Options:**
- `import`: Custom module importer function
- `resolveModule`: Custom module path resolver

```javascript
const app = mlm({
  resolveModule: (name) => `./plugins/${name}/index.js`
});
```

#### `install(unitName)`

Installs a unit and its dependencies.

```javascript
await app.install('web-server');
```

#### `start(config?)`

Starts all installed units.

```javascript
await app.start({ port: 3000 });
```

#### `stop()`

Gracefully stops the application.

```javascript
await app.stop();
```

#### `repl(context?, options?)`

Starts an interactive REPL with access to the application context.

```javascript
await app.repl({ customVar: 'value' }, { screen: true });
```

### Unit Configuration

Units export a factory function that returns a configuration object:

```javascript
export default function(mlm) {
  return {
    // Lifecycle hooks
    onBeforeLoad: async (mlm) => { /* ... */ },
    onPrepare: async (mlm) => { /* ... */ },
    onReady: async (mlm) => { /* ... */ },
    onStart: async (config) => { /* ... */ },
    onStop: async () => { /* ... */ },
    onShutdown: async () => { /* ... */ },
    
    // Context definitions
    define: {
      serviceName: () => serviceInstance,
      configValue: { value: 'data' }
    },
    
    // Custom loaders
    register: {
      customLoader: async (config, unit) => { /* ... */ }
    }
  };
}
```

### Unit Metadata

The `info` export describes the unit:

```javascript
export const info = {
  requires: ['dependency1', '#feature-tag'],
  provides: ['#my-feature'],
  description: 'Unit description',
  npm: { /* npm dependencies */ },
  version: '1.0.0',
  author: 'Author Name'
};
```

## Lifecycle

1. **Install Phase**
   - `onBeforeLoad`: Prepare for installation
   - Dependency resolution and installation
   - Feature tag registration
   - `onPrepare`: Setup internal state
   - Context property definition
   - Custom loader registration
   - `onReady`: Finalize installation

2. **Start Phase**
   - `onStart`: Initialize runtime services
   - System marked as started

3. **Stop Phase**
   - `onStop`: Graceful shutdown of services
   - `onShutdown`: Final cleanup (reverse order)

## Advanced Features

### Custom Module Resolution

```javascript
import { pathToFileURL } from 'node:url';

const app = mlm({
  resolveModule: (name) => {
    if (name.startsWith('@')) {
      return pathToFileURL(`./scoped/${name.slice(1)}.js`).href;
    }
    return pathToFileURL(`./units/${name}.js`).href;
  }
});
```

### Feature Tags

Units can provide feature tags that other units can depend on:

```javascript
// Provider
export const info = {
  provides: ['#database']
};

// Consumer  
export const info = {
  requires: ['#database']  // Any unit providing #database
};
```

### Custom Loaders

Units can register custom processing steps. There are two equivalent syntaxes:

```javascript
// Canonical arrow function syntax
export default mlm => ({
  'register.middleware': async (middlewareConfig, unit) => {
    mlm.app.use(middlewareConfig);
  }
});

// Traditional function syntax (useful when you need local variables)
export default function(mlm) {
  const localConfig = computeConfig();
  
  return {
    register: {
      middleware: async (middlewareConfig, unit) => {
        mlm.app.use(middlewareConfig);
      }
    }
  };
}

// Use the loader
export default mlm => ({
  middleware: {
    path: '/api',
    handler: (req, res) => res.json({ status: 'ok' })
  }
});
```

### Dotted Key Notation

MLM Core supports dotted key notation as a convenience syntax. Dotted keys are processed before unit installation, so `'define.serviceName'` is exactly equivalent to `define: { serviceName: ... }`. This allows for cleaner, flatter configuration objects:

```javascript
// These are equivalent:
export default mlm => ({
  'define.logger': () => loggerService,
  'register.middleware': middlewareLoader
});

export default mlm => ({
  define: {
    logger: () => loggerService
  },
  register: {
    middleware: middlewareLoader
  }
});
```

## Error Handling

MLM Core includes comprehensive error handling:

- **State validation**: Operations are validated against current lifecycle state
- **Type checking**: Runtime validation of unit configurations
- **Dependency cycles**: Automatic detection of circular dependencies
- **Concurrent installs**: Prevention of race conditions during unit loading

## Development

### REPL

Access the application state interactively:

```javascript
await app.repl();
// mlm > mlm.logger.info('Hello from REPL')
// mlm > mlmInstance.units
```

### Debugging

Enable detailed logging by accessing unit contexts:

```javascript
// Each unit gets a context with logging
export default function(mlm) {
  mlm.log('Unit initialized');
  mlm.assert(condition, 'Assertion message');
  return { /* ... */ };
}
```

## License

LGPL-3.0-or-later