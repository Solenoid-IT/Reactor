<script>
	import { onMount, onDestroy } from 'svelte';
	import Modal from '$lib/components/Modal.svelte';
	import './editor-modal.css';

	export let open = false;
	export let filePath = '';
	export let fileName = '';
	export let initialContent = '';
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

	$: signature = `${filePath}::${initialContent}`;

	$: if (open && editor && signature !== loadedSignature) {
		loadedSignature = signature;
		currentContent = initialContent || '';
		dirty = false;
		editor.setValue(currentContent);
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

				if (!mounted || !editorContainer) {
					return;
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
					language: 'typescript',
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
			} catch (error) {
				loadError = error?.message || 'Unable to initialize Monaco editor';
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
		if (!dirty || savePending) {
			return;
		}
		savePending = true;
		try {
			await onSave(currentContent);
			dirty = false;
			loadedSignature = `${filePath}::${currentContent}`;
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
	ariaLabel="Script editor"
	closeOnBackdrop={false}
	closeOnEscape={false}
	showActions={false}
	backdropClass="monaco-overlay"
	cardClass="monaco-shell"
	onClose={closeNow}
>
	<div class="monaco-header">
		<div class="monaco-title">
			<i class="fa-solid fa-laptop-code me-2"></i>
			<strong>{fileName || 'Script'}</strong>
			<span class="monaco-path">{filePath}</span>
		</div>
		<div class="monaco-actions">
			{#if dirty}
				<span class="monaco-dirty">Unsaved</span>
			{/if}
			<button class="btn-secondary" on:click={closeNow}>Close</button>
			<button class="btn-primary" on:click={saveNow} disabled={!dirty || savePending}>Save</button>
		</div>
	</div>
	<div class="monaco-editor-wrap" bind:this={editorContainer}></div>
	{#if loadError}
		<div class="monaco-error">{loadError}</div>
	{/if}
</Modal>
