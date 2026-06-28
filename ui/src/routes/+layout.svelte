<script>
	import '../app.css';
	import 'bootstrap/dist/css/bootstrap.min.css';
	import '@fortawesome/fontawesome-free/css/all.min.css';
</script>

<slot />

<style>
	:global(:root) {
		--bg: #0d0f12;
		--bg-2: #12161c;
		--panel: #181d24;
		--panel-2: #1e242d;
		--panel-3: #232b35;
		--text: #eef2fb;
		--muted: #909db2;
		--accent: #1f6a4a;
		--accent-2: #2e8a61;
		--danger: #ff7c8f;
		--ok: #76c793;
		--border: #313a46;
	}

	:global(*) { box-sizing: border-box; }

	:global(html),
	:global(body) {
		width: 100%;
		min-height: 100%;
		margin: 0;
	}

	:global(body) {
		font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
		font-weight: 400;
		background:
			radial-gradient(1200px 480px at 85% -12%, rgba(67, 209, 143, 0.17), transparent 58%),
			radial-gradient(900px 420px at 0% 100%, rgba(111, 144, 255, 0.12), transparent 62%),
			linear-gradient(175deg, var(--bg-2) 0%, var(--bg) 58%);
		color: var(--text);
		padding: clamp(10px, 1.7vw, 22px);
	}

	/* Keep typography consistent with legacy UI even with Bootstrap loaded. */
	:global(body),
	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
	}

	:global(.header) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		padding: 18px 22px;
		border-bottom: 1px solid var(--border);
		background: linear-gradient(180deg, rgba(29, 37, 49, 0.96), rgba(24, 31, 42, 0.9));
		position: sticky;
		top: 0;
		z-index: 30;
		backdrop-filter: blur(6px);
	}

	:global(.title) { display: flex; align-items: center; gap: 11px; }
	:global(.title-copy) { display: flex; flex-direction: column; }
	:global(.title h1) { font-size: 20px; font-weight: 700; letter-spacing: 0.4px; margin: 0; }
	:global(.title p) { font-size: 12px; color: var(--muted); margin-top: 3px; letter-spacing: 0.2px; }
	:global(.logo) { height: 40px; border-radius: 8px; }

	:global(.actions) {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: flex-end;
		flex-wrap: wrap;
		max-width: min(70%, 980px);
	}

	:global(button) {
		border: 1px solid transparent;
		border-radius: 11px;
		padding: 9px 12px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.15px;
		cursor: pointer;
		transition: 0.2s ease;
	}

	:global(.icon-button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 42px;
		padding: 9px 12px;
	}

	:global(.btn-secondary) { background: linear-gradient(160deg, #2a3342, #262f3d); border-color: #435063; color: var(--text); }
	:global(.btn-secondary:hover) { background: linear-gradient(160deg, #344153, #2e3948); border-color: #57657a; }
	:global(.btn-primary) { background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: rgba(74, 153, 117, 0.62); color: #eaf9f1; }

	/* Bootstrap-like margin utilities. Scale: 0, .25, .5, 1, 1.5, 3rem */
	:global(.m-0) { margin: 0 !important; }
	:global(.m-1) { margin: 0.25rem !important; }
	:global(.m-2) { margin: 0.5rem !important; }
	:global(.m-3) { margin: 1rem !important; }
	:global(.m-4) { margin: 1.5rem !important; }
	:global(.m-5) { margin: 3rem !important; }

	:global(.mt-0) { margin-top: 0 !important; }
	:global(.mt-1) { margin-top: 0.25rem !important; }
	:global(.mt-2) { margin-top: 0.5rem !important; }
	:global(.mt-3) { margin-top: 1rem !important; }
	:global(.mt-4) { margin-top: 1.5rem !important; }
	:global(.mt-5) { margin-top: 3rem !important; }

	:global(.mb-0) { margin-bottom: 0 !important; }
	:global(.mb-1) { margin-bottom: 0.25rem !important; }
	:global(.mb-2) { margin-bottom: 0.5rem !important; }
	:global(.mb-3) { margin-bottom: 1rem !important; }
	:global(.mb-4) { margin-bottom: 1.5rem !important; }
	:global(.mb-5) { margin-bottom: 3rem !important; }

	:global(.ms-0) { margin-left: 0 !important; }
	:global(.ms-1) { margin-left: 0.25rem !important; }
	:global(.ms-2) { margin-left: 0.5rem !important; }
	:global(.ms-3) { margin-left: 1rem !important; }
	:global(.ms-4) { margin-left: 1.5rem !important; }
	:global(.ms-5) { margin-left: 3rem !important; }

	:global(.me-0) { margin-right: 0 !important; }
	:global(.me-1) { margin-right: 0.25rem !important; }
	:global(.me-2) { margin-right: 0.5rem !important; }
	:global(.me-3) { margin-right: 1rem !important; }
	:global(.me-4) { margin-right: 1.5rem !important; }
	:global(.me-5) { margin-right: 3rem !important; }

	:global(.mx-0) { margin-left: 0 !important; margin-right: 0 !important; }
	:global(.mx-1) { margin-left: 0.25rem !important; margin-right: 0.25rem !important; }
	:global(.mx-2) { margin-left: 0.5rem !important; margin-right: 0.5rem !important; }
	:global(.mx-3) { margin-left: 1rem !important; margin-right: 1rem !important; }
	:global(.mx-4) { margin-left: 1.5rem !important; margin-right: 1.5rem !important; }
	:global(.mx-5) { margin-left: 3rem !important; margin-right: 3rem !important; }

	:global(.my-0) { margin-top: 0 !important; margin-bottom: 0 !important; }
	:global(.my-1) { margin-top: 0.25rem !important; margin-bottom: 0.25rem !important; }
	:global(.my-2) { margin-top: 0.5rem !important; margin-bottom: 0.5rem !important; }
	:global(.my-3) { margin-top: 1rem !important; margin-bottom: 1rem !important; }
	:global(.my-4) { margin-top: 1.5rem !important; margin-bottom: 1.5rem !important; }
	:global(.my-5) { margin-top: 3rem !important; margin-bottom: 3rem !important; }

	:global(.template-picker) { position: relative; display: inline-flex; align-items: center; }
	:global(.log-picker) { position: relative; display: inline-flex; align-items: center; }
	:global(.template-menu) {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		min-width: 180px;
		padding: 8px;
		border: 1px solid #435063;
		border-radius: 12px;
		background: linear-gradient(180deg, rgba(30, 38, 50, 0.98), rgba(22, 28, 38, 0.98));
		box-shadow: 0 18px 28px rgba(0, 0, 0, 0.3);
		opacity: 0;
		pointer-events: none;
		transform: translateY(-6px) scale(0.98);
		transition: 0.16s ease;
		z-index: 40;
	}
	:global(.template-picker.open .template-menu) { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }
	:global(.template-menu-item) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 9px 10px;
		border-radius: 10px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text);
		text-align: left;
	}
	:global(.template-menu-item:hover) {
		background: rgba(255, 255, 255, 0.06);
		border-color: #4a5668;
	}
	:global(.template-menu-item i) {
		width: 14px;
		text-align: center;
		font-size: 13px;
		color: #c8d4e6;
		flex-shrink: 0;
	}

	:global(.log-menu) {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		min-width: 170px;
		padding: 8px;
		border: 1px solid #435063;
		border-radius: 12px;
		background: linear-gradient(180deg, rgba(30, 38, 50, 0.98), rgba(22, 28, 38, 0.98));
		box-shadow: 0 18px 28px rgba(0, 0, 0, 0.3);
		opacity: 0;
		pointer-events: none;
		transform: translateY(-6px) scale(0.98);
		transition: 0.16s ease;
		z-index: 40;
	}
	:global(.log-picker.open .log-menu) {
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0) scale(1);
	}
	:global(.log-menu-item) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 9px 10px;
		border-radius: 10px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text);
		font-size: 12px;
		font-weight: 700;
		text-align: left;
	}
	:global(.log-menu-item:hover) {
		background: rgba(255, 255, 255, 0.06);
		border-color: #4a5668;
	}
	:global(.log-menu-item i) {
		width: 14px;
		text-align: center;
		font-size: 13px;
		color: #c8d4e6;
		flex-shrink: 0;
	}
	:global(.log-menu-item.danger) {
		color: #ffdce3;
		border-color: #7a4c59;
		background: rgba(122, 76, 89, 0.16);
	}
	:global(.log-menu-item.danger:hover) {
		background: rgba(122, 76, 89, 0.28);
		border-color: #9b6071;
	}
	:global(.log-menu-item.danger i) {
		color: #ffb8c5;
	}

	:global(.content) {
		display: grid;
		grid-template-columns: minmax(420px, 1.35fr) minmax(320px, 0.9fr);
		min-height: calc(100vh - 150px);
	}
	:global(.list-pane) {
		border-right: 1px solid var(--border);
		padding: 18px;
		background: rgba(20, 27, 37, 0.42);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	:global(.path-box) {
		margin-bottom: 14px;
		padding: 11px 12px;
		background: #1d2530;
		border: 1px solid var(--border);
		border-radius: 11px;
		font-size: 12px;
		color: var(--muted);
		word-break: break-all;
	}

	:global(.file-list) { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
	:global(.file-item) {
		padding: 12px 13px;
		border-radius: 11px;
		background: linear-gradient(165deg, #243140 0%, #1e2936 54%, #1b2430 100%);
		border: 1px solid #384456;
		cursor: pointer;
		box-shadow: 0 8px 16px rgba(5, 10, 18, 0.22);
		transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
	}
	:global(.file-item:hover) {
		transform: translateY(-1px);
		border-color: #4f6077;
		background: linear-gradient(165deg, #2a3a4d 0%, #233243 56%, #1f2b3a 100%);
		box-shadow: 0 12px 20px rgba(6, 12, 22, 0.3);
	}
	:global(.file-item.selected) {
		background: linear-gradient(145deg, #2b3d52 0%, #234943 62%, #21433e 100%);
		border-color: var(--accent);
		box-shadow: 0 0 0 1px rgba(60, 170, 122, 0.26) inset, 0 14px 24px rgba(6, 15, 14, 0.35);
	}
	:global(.file-item.selected:hover) {
		background: linear-gradient(145deg, #334a64 0%, #2a5a52 62%, #275149 100%);
		border-color: #45a87a;
		box-shadow: 0 0 0 1px rgba(88, 194, 146, 0.34) inset, 0 16px 26px rgba(6, 15, 14, 0.42);
	}
	:global(.file-header) { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
	:global(.file-header-main) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
	:global(.file-name) { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
	:global(.file-tags) { display: flex; gap: 6px; flex-wrap: wrap; }
	:global(.tag) {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.55px;
		text-transform: uppercase;
		font-family: "SF Mono", "Fira Code", "Consolas", monospace;
		padding: 3px 7px;
		border-radius: 5px;
		background: #1f2a36;
		color: var(--muted);
		border: 1px solid #3a4859;
	}
	:global(.tag.ok) { color: #c8f5d9; background: #1a3d2b; border-color: #2a6045; }
	:global(.tag.warn) { color: #f5e1a4; background: #3a2e10; border-color: #7a6030; }
	:global(.tag.mutex) { color: #a8d8f0; background: #122035; border-color: #2a5070; }
	:global(.toggle-stack) { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
	:global(.switch-toggle) {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: 9px;
		min-width: 122px;
		padding: 4px 6px 4px 10px;
		border-radius: 999px;
		border: 1px solid #4d596b;
		background: linear-gradient(165deg, #2c3441, #28313f);
		color: #dce9fb;
		font-size: 10px;
		/*font-weight: 800;*/
		text-transform: uppercase;
		letter-spacing: 0.45px;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 2px 8px rgba(0, 0, 0, 0.2);
	}
	:global(.switch-toggle:hover) {
		border-color: #61738f;
		background: linear-gradient(165deg, #334051, #2d3a4b);
	}
	:global(.switch-label) {
		line-height: 1;
		white-space: nowrap;
	}
	:global(.switch-knob) {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		background: linear-gradient(180deg, #e8f0ff, #cdd9ea);
		border: 1px solid #9eb0c9;
		box-shadow: 0 2px 5px rgba(7, 11, 18, 0.35);
		transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
	}
	:global(.switch-toggle.state-on), :global(.switch-toggle.mutex-on) {
		background: linear-gradient(135deg, #1d573f, #267052);
		border-color: #359169;
		color: #e8fff0;
	}
	:global(.switch-toggle.state-on .switch-knob), :global(.switch-toggle.mutex-on .switch-knob) {
		transform: translateX(1px);
		background: linear-gradient(180deg, #f2fff7, #d8f0e2);
		border-color: #95c9ae;
	}
	:global(.switch-toggle.state-off), :global(.switch-toggle.mutex-off) {
		background: linear-gradient(165deg, #2b3442, #27303d);
		border-color: #4f5c70;
		color: #d6e1f3;
	}
	:global(.item-actions) { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #364151; flex-wrap: wrap; }
	:global(.item-action-btn) {
		height: 30px;
		padding: 0 8px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 8px;
		border: 1px solid #4a596e;
		background: #2d3745;
		color: #dfe7f5;
		transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
	}
	:global(.item-action-btn:hover) {
		transform: translateY(-1px);
		background: #344356;
		border-color: #5b6f8b;
	}
	:global(.item-action-btn.test) { background: #264433; border-color: #3a7b5b; color: #ddfbe8; }
	:global(.item-action-btn.delete) { background: #442a32; border-color: #7a4c59; color: #ffdce3; }
	:global(.item-action-btn.test:hover) { background: #2c5340; border-color: #4a8f6b; }
	:global(.item-action-btn.delete:hover) { background: #54333d; border-color: #926070; }
	:global(.item-action-label) { font-size: 10px; font-weight: 700; text-transform: uppercase; }

	:global(.detail-pane) {
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		background: rgba(19, 25, 34, 0.36);
	}
	:global(.detail-card) {
		background: linear-gradient(170deg, var(--panel-2), var(--panel-3));
		border: 1px solid var(--border);
		border-radius: 13px;
		padding: 14px 15px;
	}
	:global(.detail-card h3) { font-size: 13px; font-weight: 700; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
	:global(.detail-value) { font-size: 13px; line-height: 1.5; word-break: break-all; }
	:global(.detail-hint) {
		margin: 0 0 10px;
		font-size: 12px;
		line-height: 1.4;
		color: #a2aec2;
	}
	:global(.detail-label) {
		display: inline-block;
		margin-bottom: 6px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.4px;
		text-transform: uppercase;
		color: #a7b4c8;
	}
	:global(.http-server-card) {
		border-color: #3a556a;
		background: linear-gradient(170deg, #202a37, #1d2632);
	}
	:global(.http-port-group) {
		padding: 10px;
		margin-bottom: 10px;
		border: 1px solid #3a4657;
		border-radius: 10px;
		background: rgba(14, 20, 28, 0.55);
	}
	:global(.http-server-actions) {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	:global(.http-server-actions button) {
		width: 100%;
	}
	:global(.empty) {
		color: var(--muted);
		font-size: 13px;
		padding: 12px 13px;
		border: 1px dashed #4b596d;
		border-radius: 11px;
		background: rgba(26, 35, 48, 0.46);
	}

	:global(.modal-backdrop) {
		position: fixed;
		inset: 0;
		background: rgba(5, 9, 15, 0.6);
		display: grid;
		place-items: center;
		padding: 20px;
		z-index: 120;
	}
	:global(.modal-card) {
		width: min(460px, 100%);
		background: linear-gradient(175deg, #1f2733, #1a222d);
		border: 1px solid #3a4759;
		border-radius: 14px;
		box-shadow: 0 22px 40px rgba(0, 0, 0, 0.42);
		padding: 16px;
	}
	:global(.modal-card h3) {
		margin: 0 0 8px;
		font-size: 15px;
		letter-spacing: 0.2px;
	}
	:global(.modal-subtitle) {
		margin: 0 0 12px;
		font-size: 12px;
		color: var(--muted);
		word-break: break-all;
	}
	:global(.modal-input) {
		width: 100%;
		background: #12161c;
		color: #eef2fb;
		border: 1px solid #3b485b;
		border-radius: 10px;
		padding: 10px 11px;
		font-size: 13px;
		outline: none;
	}
	:global(.modal-input:focus) {
		border-color: #4f8b6f;
		box-shadow: 0 0 0 2px rgba(60, 170, 122, 0.24);
	}
	:global(.modal-actions) {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}

	@media (max-width: 1180px) {
		:global(.header) { flex-direction: column; align-items: stretch; }
		:global(.actions) { max-width: 100%; justify-content: flex-start; }
		:global(.content) { grid-template-columns: 1fr; min-height: auto; }
		:global(.list-pane) { border-right: 0; border-bottom: 1px solid var(--border); }
		:global(.http-server-actions) { grid-template-columns: 1fr; }
	}

	@media (max-width: 760px) {
		:global(body) {
			padding: 8px;
		}
		:global(.header) {
			padding: 12px;
			gap: 10px;
		}
		:global(.title h1) {
			font-size: 18px;
		}
		:global(.title p) {
			display: none;
		}
		:global(.actions) {
			flex-wrap: wrap;
			overflow: visible;
			gap: 6px;
		}
		:global(.actions button) {
			white-space: nowrap;
		}
		:global(.btn-secondary),
		:global(.btn-primary) {
			padding: 8px 10px;
		}
		:global(.template-menu) {
			position: fixed;
			top: 76px;
			left: 50%;
			right: auto;
			min-width: min(320px, calc(100vw - 24px));
			max-width: min(320px, calc(100vw - 24px));
			transform: translate(-50%, -6px) scale(0.98);
			z-index: 90;
		}
		:global(.template-picker.open .template-menu) {
			transform: translate(-50%, 0) scale(1);
		}
		:global(.log-menu) {
			left: 0;
			right: auto;
			min-width: 170px;
			max-width: min(260px, calc(100vw - 24px));
		}
		:global(.list-pane),
		:global(.detail-pane) {
			padding: 12px;
		}
		:global(.file-header) {
			flex-direction: column;
			align-items: stretch;
		}
		:global(.toggle-stack) {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: flex-start;
		}
		:global(.switch-toggle) {
			min-width: 108px;
		}
		:global(.item-actions) {
			gap: 5px;
		}
		:global(.item-action-btn) {
			height: 28px;
			padding: 0 7px;
		}
		:global(.item-action-label) {
			font-size: 9px;
		}
	}
</style>
