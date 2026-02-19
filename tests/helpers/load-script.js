const fs = require('node:fs');
const vm = require('node:vm');

function loadScript(filePath, options = {}) {
  const exportNames = options.exportNames || [];
  const globals = options.globals || {};
  const source = fs.readFileSync(filePath, 'utf8');

  const exportsCode = `
;globalThis.__testExports = {
${exportNames.map((name) => `  ${JSON.stringify(name)}: (typeof ${name} !== 'undefined' ? ${name} : undefined)`).join(',\n')}
};
`;

  const context = vm.createContext({
    ...globals
  });
  context.globalThis = context;

  vm.runInContext(`${source}\n${exportsCode}`, context, { filename: filePath });

  return {
    context,
    exports: context.__testExports || {}
  };
}

module.exports = {
  loadScript
};
