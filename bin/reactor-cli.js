#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

function run(command, args = []) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: 'inherit',
			shell: process.platform === 'win32',
			cwd: path.resolve(__dirname, '..'),
		});

		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
		});
	});
}

function printHelp() {
	console.log('reactor-cli');
	console.log('');
	console.log('Usage:');
	console.log('  reactor-cli build desktop');
	console.log('  reactor-cli build mobile');
	console.log('  reactor-cli build all');
	console.log('  reactor-cli plugin build <pluginDir>');
	console.log('  reactor-cli exchange get');
	console.log('  reactor-cli exchange set exchange [port] [--tls] [--token <token>]');
	console.log('  reactor-cli exchange set node <host> [port] [--tls] [--token <token>]');
	console.log('  reactor-cli exchange token get');
	console.log('  reactor-cli exchange token generate');
	console.log('  reactor-cli script id <script-name>');
}

async function build(target) {
	if (target === 'desktop') {
		await run('npm', ['run', 'build:desktop']);
		return;
	}

	if (target === 'mobile') {
		await run('npm', ['run', 'build:mobile']);
		return;
	}

	if (target === 'all') {
		await run('npm', ['run', 'build:desktop']);
		await run('npm', ['run', 'build:mobile']);
		return;
	}

	throw new Error(`Unknown build target: ${target}`);
}

async function buildPlugin(pluginDir) {
	if (!pluginDir) {
		throw new Error('pluginDir is required for plugin build');
	}

	await run('npm', ['pack', pluginDir]);
}

async function runDaemonCtl(args = []) {
	await run(process.execPath, ['daemonctl.js', ...args]);
}

async function main() {
	const [, , command, subcommand, arg, ...rest] = process.argv;

	if (!command) {
		printHelp();
		process.exit(0);
	}

	if (command === 'build') {
		await build(subcommand || 'desktop');
		return;
	}

	if (command === 'plugin' && subcommand === 'build') {
		await buildPlugin(arg);
		return;
	}

	if (command === 'exchange' && subcommand === 'get') {
		await runDaemonCtl(['get-exchange']);
		return;
	}

	if (command === 'exchange' && subcommand === 'set') {
		await runDaemonCtl(['set-exchange', arg, ...rest]);
		return;
	}

	if (command === 'exchange' && subcommand === 'token' && arg === 'get') {
		await runDaemonCtl(['get-exchange-token']);
		return;
	}

	if (command === 'exchange' && subcommand === 'token' && arg === 'generate') {
		await runDaemonCtl(['generate-exchange-token']);
		return;
	}

	if (command === 'script' && subcommand === 'id') {
		const scriptName = [arg, ...rest].filter(Boolean).join(' ').trim();
		if (!scriptName) {
			printHelp();
			throw new Error('script name is required');
		}

		await runDaemonCtl(['script-id', scriptName]);
		return;
	}

	printHelp();
	throw new Error('Unsupported command');
}

main().catch((error) => {
	console.error(`[reactor-cli] ${error.message}`);
	process.exit(1);
});
