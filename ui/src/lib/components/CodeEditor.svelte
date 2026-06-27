<script>
	import { onMount, onDestroy } from 'svelte';

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

{#if open}
	<div class="code-overlay" role="presentation">
		<div class="code-shell" role="dialog" aria-modal="true" aria-label="Code editor">
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
		</div>
	</div>
{/if}

<style>
	.code-overlay {
		position: fixed;
		inset: 0;
		z-index: 150;
		background: rgba(5, 9, 15, 0.72);
		backdrop-filter: blur(4px);
		padding: 14px;
	}
	.code-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		border: 1px solid #38475e;
		border-radius: 14px;
		overflow: hidden;
		background: linear-gradient(170deg, #161d28, #131a24);
	}
	.code-header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: center;
		padding: 10px 12px;
		border-bottom: 1px solid #334155;
		background: linear-gradient(180deg, rgba(38, 49, 66, 0.95), rgba(27, 35, 48, 0.93));
	}
	.code-title {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.code-path {
		font-size: 11px;
		color: #9caec8;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.code-lang {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		padding: 2px 7px;
		border-radius: 999px;
		border: 1px solid #446082;
		color: #abd2ff;
		background: rgba(25, 57, 96, 0.28);
	}
	.code-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.code-dirty {
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
	.code-editor-wrap {
		flex: 1;
		min-height: 0;
	}
	.code-error {
		padding: 10px 12px;
		border-top: 1px solid #5b2431;
		background: rgba(122, 28, 43, 0.22);
		color: #ffd6dc;
		font-size: 12px;
	}
</style>
