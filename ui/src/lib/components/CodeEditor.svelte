<script>
	import { onMount, onDestroy } from 'svelte';
	import Modal from '$lib/components/Modal.svelte';
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
			<button class="btn-secondary" on:click={closeNow}>Close</button>
			<button class="btn-primary" on:click={saveNow} disabled={savePending}>Save</button>
		</div>
	</div>
	<div class="code-editor-wrap" bind:this={editorContainer}></div>
	{#if loadError}
		<div class="code-error">{loadError}</div>
	{/if}
</Modal>
