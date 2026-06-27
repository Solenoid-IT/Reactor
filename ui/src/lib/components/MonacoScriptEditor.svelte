<script>
	import { onMount, onDestroy } from 'svelte';

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

{#if open}
	<div class="monaco-overlay" role="presentation">
		<div class="monaco-shell" role="dialog" aria-modal="true" aria-label="Script editor">
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
		</div>
	</div>
{/if}

<style>
	.monaco-overlay {
		position: fixed;
		inset: 0;
		z-index: 150;
		background: rgba(5, 9, 15, 0.72);
		backdrop-filter: blur(4px);
		padding: 14px;
	}
	.monaco-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		border: 1px solid #38475e;
		border-radius: 14px;
		overflow: hidden;
		background: linear-gradient(170deg, #161d28, #131a24);
	}
	.monaco-header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: center;
		padding: 10px 12px;
		border-bottom: 1px solid #334155;
		background: linear-gradient(180deg, rgba(38, 49, 66, 0.95), rgba(27, 35, 48, 0.93));
	}
	.monaco-title {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.monaco-path {
		font-size: 11px;
		color: #9caec8;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.monaco-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.monaco-dirty {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.4px;
		text-transform: uppercase;
		padding: 4px 8px;
		border: 1px solid #8a6a30;
		border-radius: 999px;
		background: rgba(122, 92, 24, 0.28);
		color: #ffd890;
	}
	.monaco-editor-wrap {
		flex: 1;
		min-height: 0;
	}
	.monaco-error {
		padding: 10px 12px;
		border-top: 1px solid #5b2431;
		background: rgba(122, 28, 43, 0.22);
		color: #ffd6dc;
		font-size: 12px;
	}
</style>
