'use strict';

const fs = require('fs');
const Module = require('module');
const ts = require('typescript');

const functions = [];

const scanned = new Set([
  process.mainModule,
]);
const scan = (ns, path) => {
  if (scanned.has(ns)) {
    return;
  }
  if (path === 'globalThis.Buffer') {
    return;
  }
  scanned.add(ns);
  if (typeof ns === 'function') {
    functions.push(path);
  }
  if (typeof ns !== 'function' && (typeof ns !== 'object' || ns === null)) {
    return;
  }

  Reflect.ownKeys(ns).forEach((name) => {
    if (typeof name === 'string' && name.startsWith('_')) {
      return;
    }
    try {
      ns[name];
    } catch {
      return;
    }
    if (typeof name === 'symbol') {
      if (name.description.startsWith('Symbol')) {
        scan(ns[name], `${path}[${name.description}]`);
      }
    } else {
      scan(ns[name], `${path}.${name}`);
    }
  });
};

scan(globalThis, 'globalThis');

const required = new Set();
const forbidden = new Set(['repl', 'domain', 'sys', 'module']);
Module.builtinModules.forEach((m) => {
  if (m.startsWith('_') || m.includes('/') || forbidden.has(m)) {
    return;
  }
  required.add(m);
  scan(require(m), m);
});

const compilerOptions = {
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
  types: ['node'],
  target: ts.ScriptTarget.Latest,
  strict: true,
};
const host = ts.createCompilerHost(compilerOptions);
const originalReadFile = host.readFile;
host.readFile = (name) => {
  if (name === 'index.ts') {
    return `
    ${[...required].map((r) => `import * as ${r} from '${r}';`).join('\n')}
    ${functions.join('\n')}
    `;
  }
  return originalReadFile.call(host, name);
};
host.writeFile = () => {
  throw new Error();
};
const program = ts.createProgram(['index.ts'], compilerOptions, host);
const checker = program.getTypeChecker();

function convertSignature(signature) {
  return signature.parameters.map((symbol) => {
    const param = symbol.valueDeclaration;
    if (param.questionToken) {
      return `?${symbol.name}`;
    }
    if (param.dotDotDotToken) {
      return `...${symbol.name}`;
    }
    return symbol.name;
  });
}

const out = [];

program.getSourceFile('index.ts').statements.forEach((stmt, i) => {
  const path = functions[i - required.size];
  if (!path) {
    return;
  }

  const type = checker.getTypeAtLocation(stmt.expression);
  if (checker.typeToString(type) === 'any') {
    console.error(path);
  }

  const data = {
    call: [],
    construct: [],
  };

  type.getCallSignatures()
    .filter((s) => s.parameters.length > 0)
    .forEach((signature) => {
      data.call.push(convertSignature(signature));
    });
  type.getConstructSignatures()
    .filter((s) => s.parameters.length > 0)
    .forEach((signature) => {
      data.construct.push(convertSignature(signature));
    });

  data.call.sort((a, b) => a.length - b.length);
  data.construct.sort((a, b) => a.length - b.length);

  out.push(`  [${path}, ${JSON.stringify(data)}]`);
});

fs.writeFileSync('./src/annotation_map.js', `'use strict';

/* eslint-disable */

// Generated by generate_annotations.js
// This file maps native methods to their signatures for completion
// in the repl. if a method isn't listed here, it is either unknown
// to the generator script, or it doesn't take any arguments.

${[...required].map((r) => `const ${r} = require('${r}');`).join('\n')}

module.exports = new WeakMap([
${out.join(',\n')},
].filter(([key]) => key !== undefined));
`);
