<script>
	import { onMount, onDestroy } from 'svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { copyTextToClipboard } from '$lib/reactorApi';
	import reactorApiTypes from '$lib/monaco/reactor-api.d.ts?raw';
	import './editor-modal.css';

	export let open = false;
	export let filePath = '';
	export let fileName = '';
	export let initialContent = '';
	export let language = 'typescript';
	export let onClose = () => {};
	export let onSave = () => {};

	let editorContainer;
	let editor;
	let currentContent = '';
	let dirty = false;
	let savePending = false;
	let loadedSignature = '';
	let mounted = true;
	let loadError = '';

	$: signature = `${filePath}::${initialContent}::${language}`;

	$: if (open && editor && signature !== loadedSignature) {
		loadedSignature = signature;
		currentContent = initialContent || '';
		dirty = false;
		editor.setValue(currentContent);
		const model = editor.getModel();
		if (model && monacoRef) {
			monacoRef.editor.setModelLanguage(model, resolveMonacoLanguage());
		}
	}

	let monacoRef = null;
	let reactorTypesDisposable = null;
	let reactorTypesJsDisposable = null;
	let sekryptHintDisposable = null;
	let sekryptHintJsDisposable = null;

	function setupTypeScriptIntelliSense(monaco) {
		const defaults = monaco.languages.typescript.typescriptDefaults;
		const jsDefaults = monaco.languages.typescript.javascriptDefaults;

		const compilerOptions = {
			target: monaco.languages.typescript.ScriptTarget.ES2020,
			module: monaco.languages.typescript.ModuleKind.ESNext,
			moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
			allowNonTsExtensions: true,
			allowSyntheticDefaultImports: true,
			esModuleInterop: true,
			strict: false,
			noEmit: true,
		};

		defaults.setCompilerOptions(compilerOptions);
		jsDefaults.setCompilerOptions(compilerOptions);
		defaults.setEagerModelSync(true);
		jsDefaults.setEagerModelSync(true);

		defaults.setDiagnosticsOptions({
			noSyntaxValidation: false,
			noSemanticValidation: false,
		});
		jsDefaults.setDiagnosticsOptions({
			noSyntaxValidation: false,
			noSemanticValidation: false,
		});

		if (reactorTypesDisposable) {
			reactorTypesDisposable.dispose();
		}
		if (reactorTypesJsDisposable) {
			reactorTypesJsDisposable.dispose();
		}
		if (sekryptHintDisposable) {
			sekryptHintDisposable.dispose();
		}
		if (sekryptHintJsDisposable) {
			sekryptHintJsDisposable.dispose();
		}

		reactorTypesDisposable = defaults.addExtraLib(
			reactorApiTypes,
			'file:///reactor/typings/reactor-api.d.ts',
		);
		reactorTypesJsDisposable = jsDefaults.addExtraLib(
			reactorApiTypes,
			'file:///reactor/typings/reactor-api.js.d.ts',
		);

		const sekryptHintTypes = `declare module 'core' {
	export interface SekryptApi {
		encryptFile(
			content: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			publicKey: string,
		): Promise<SekryptFileResult>;
		decryptFile(
			content: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			crypto: object,
			privateKey: string,
		): Promise<AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
	}
}`;

		sekryptHintDisposable = defaults.addExtraLib(
			sekryptHintTypes,
			'file:///reactor/typings/sekrypt-hint.d.ts',
		);
		sekryptHintJsDisposable = jsDefaults.addExtraLib(
			sekryptHintTypes,
			'file:///reactor/typings/sekrypt-hint.js.d.ts',
		);
	}

	function resolveMonacoLanguage() {
		return String(language || '').toLowerCase() === 'log' ? 'log' : 'typescript';
	}

	onMount(() => {
		(async () => {
			try {
				const [monacoModule, editorWorkerModule, tsWorkerModule] = await Promise.all([
					import('monaco-editor'),
					import('monaco-editor/esm/vs/editor/editor.worker?worker'),
					import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
				]);

				const monaco = monacoModule;
				const editorWorker = editorWorkerModule.default || editorWorkerModule;
				const tsWorker = tsWorkerModule.default || tsWorkerModule;
				monacoRef = monaco;

				if (!mounted || !editorContainer) {
					return;
				}

				setupTypeScriptIntelliSense(monaco);

				if (!monaco.languages.getLanguages().some((item) => item.id === 'log')) {
					monaco.languages.register({ id: 'log' });
					monaco.languages.setMonarchTokensProvider('log', {
						tokenizer: {
							root: [
								[/\b(ERROR|Error|FATAL|Fatal)\b/, 'invalid'],
								[/\b(WARN|Warning)\b/, 'keyword'],
								[/\b(INFO|Info|DEBUG|Debug|TRACE|Trace)\b/, 'type'],
							],
						},
					});
				}

				if (typeof self !== 'undefined') {
					self.MonacoEnvironment = {
						getWorker(_, label) {
							if (label === 'typescript' || label === 'javascript') {
								return new tsWorker();
							}
							return new editorWorker();
						},
					};
				}

				editor = monaco.editor.create(editorContainer, {
					value: initialContent || '',
					language: resolveMonacoLanguage(),
					theme: 'vs-dark',
					automaticLayout: true,
					minimap: { enabled: false },
					fontSize: 13,
					lineHeight: 21,
					scrollBeyondLastLine: false,
					roundedSelection: false,
					padding: { top: 10 },
				});

				loadedSignature = signature;
				currentContent = initialContent || '';
				loadError = '';

				editor.onDidChangeModelContent(() => {
					currentContent = editor.getValue();
					dirty = currentContent !== (initialContent || '');
				});

				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
					saveNow();
				});
			} catch (error) {
				loadError = error?.message || 'Unable to initialize code editor';
			}
		})();
	});

	onDestroy(() => {
		mounted = false;
		if (editor) {
			editor.dispose();
			editor = null;
		}
		if (reactorTypesDisposable) {
			reactorTypesDisposable.dispose();
			reactorTypesDisposable = null;
		}
		if (reactorTypesJsDisposable) {
			reactorTypesJsDisposable.dispose();
			reactorTypesJsDisposable = null;
		}
		if (sekryptHintDisposable) {
			sekryptHintDisposable.dispose();
			sekryptHintDisposable = null;
		}
		if (sekryptHintJsDisposable) {
			sekryptHintJsDisposable.dispose();
			sekryptHintJsDisposable = null;
		}
	});

	async function saveNow() {
		if (savePending) {
			return;
		}
		savePending = true;
		try {
			await onSave(currentContent);
			dirty = false;
			loadedSignature = `${filePath}::${currentContent}::${language}`;
		} finally {
			savePending = false;
		}
	}

	function closeNow() {
		if (dirty) {
			const ok = window.confirm('Discard unsaved changes?');
			if (!ok) {
				return;
			}
		}
		onClose();
	}

	async function copyNow() {
		const source = String((editor ? editor.getValue() : currentContent) || '');

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				await navigator.clipboard.writeText(source);
				return;
			}
		} catch {
			// Fallback below.
		}

		try {
			const result = await copyTextToClipboard(source);
			if (result?.ok) {
				return;
			}
		} catch {
			// Fallback below.
		}

		if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
			window.prompt('Copy code', source);
		}
	}
</script>

<Modal
	open={open}
	ariaLabel="Code editor"
	closeOnBackdrop={false}
	closeOnEscape={false}
	showActions={false}
	backdropClass="code-overlay"
	cardClass="code-shell"
	onClose={closeNow}
>
	<div class="code-header">
		<div class="code-title">
			<i class="fa-solid fa-laptop-code me-2"></i>
			<strong>{fileName || 'File'}</strong>
			<span class="code-path">{filePath}</span>
			<span class="code-lang">{resolveMonacoLanguage()}</span>
		</div>
		<div class="code-actions">
			{#if dirty}
				<span class="code-dirty">Unsaved</span>
			{/if}
			<button class="btn-secondary" on:click={copyNow}>Copy</button>
			<button class="btn-primary" on:click={saveNow} disabled={savePending}>Save</button>
		</div>
	</div>
	<div class="code-editor-wrap" bind:this={editorContainer}></div>
	{#if loadError}
		<div class="code-error">{loadError}</div>
	{/if}
</Modal>
