const path = require('path');
const { createRequire } = require('module');
const ts = require('typescript');

/**
 * Transpiles TypeScript to CommonJS and loads as a module
 * Returns module exports
 */
function loadScriptModule(tsFilePath, sourceCode, options = {}) {
	const transpiled = ts.transpileModule(sourceCode, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
			esModuleInterop: true,
			strict: false,
		},
		fileName: tsFilePath,
	});

	const moduleObject = { exports: {} };
	const scriptDir = path.dirname(tsFilePath);
	const nodeRequireFromScript = createRequire(tsFilePath);
	const virtualModules = options.virtualModules && typeof options.virtualModules === 'object' ? options.virtualModules : {};
	const scriptRequire = (specifier) => {
		if (Object.prototype.hasOwnProperty.call(virtualModules, specifier)) {
			return virtualModules[specifier];
		}
		return nodeRequireFromScript(specifier);
	};

	const executor = new Function(
		'exports',
		'require',
		'module',
		'__filename',
		'__dirname',
		transpiled.outputText,
	);

	executor(moduleObject.exports, scriptRequire, moduleObject, tsFilePath, scriptDir);
	return moduleObject.exports;
}

module.exports = { loadScriptModule };
